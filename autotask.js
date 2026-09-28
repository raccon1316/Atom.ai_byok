// autotask.js — Phase 4: the Auto Task runner. Lives in the service worker
// so a run survives the popup closing (keepalive via liveness.js storage
// writes; state persisted to chrome.storage.local after every step).
//
// Loop shape per step:
//   snapshot → planner LLM (goal + plan + criteria + observations + site
//   prefs + grounded element snapshot) → JSON decision → safety classifier
//   → safe: executeWithRecovery / confirm: suspend for popup approval /
//   blocked: stop and hand to user → observation → criterion check →
//   next/recover/replan → … → DONE → validateGoal (evidence-only) →
//   result or honest PARTIAL.
//
// Every LLM call goes through the background ai instance (managed metering
// path). Vision fallback is wired but degrades to honest failure until a
// vision-capable model is configured (see VISION_MODEL).

import { AgentTools, formatObservation } from './agent-tools.js';
import {
  classifyAction, preflight, createApproval, isApprovalTimedOut, resolveApproval,
  RISK, MAX_STEPS, MAX_DURATION_MS, APPROVAL_TIMEOUT_MS, DEFAULT_BLOCKED_DOMAINS,
  describeApproval, isDomainBlocked, resolveNavigateUrl, AUTO_TASK_CALL_MULTIPLIER
} from './safety.js';
import {
  parsePlan, checkCriterion, stepDecision, validateGoal, labelPartial,
  saveTaskRun, appendTrajectory, appendAudit, getSiteInstructions,
  listSiteInstructions, buildSiteInstructionBlock, snapshotFingerprint
} from './verify.js';
import { detectBlockers } from './recovery.js';
import {
  saveRecipe, listRecipes, getRecipe, replayRecipe, stepToDescriptor
} from './recipes.js';

export const RUN_KEY = 'autoTaskRun';
// Metering: one Auto Task run reserves AUTO_TASK_CALL_MULTIPLIER AI-call
// equivalents in the REAL quota counter (deps.meter → background.js
// chargeAutoTaskQuota → quotaState.count / userSettings.dailyCallsUsed), so the
// number the UI displays is the number that actually enforces quota. Defined
// once, in safety.js alongside the other run caps.
export { AUTO_TASK_CALL_MULTIPLIER } from './safety.js';
// Set to a vision-capable model id (e.g. 'meta-llama/llama-4-scout-17b-16e-instruct')
// to enable the Set-of-Mark escalation tier; null = vision degrades to an
// honest VISION_UNAVAILABLE failure (never a blind retry).
export const VISION_MODEL = null;
export const APPROVAL_ALARM = 'atom-autotask-approval';

const TOOLS_LIST = [
  'navigate {"url"} — go to a URL (or a name like "google")',
  'clickRef {"ref"} — click the element with that [ref]',
  'typeRef {"ref", "text", "submit": bool} — fill a field (submit=true presses Enter)',
  'selectRef {"ref", "option"} — pick a dropdown option',
  'pressKey {"key"} — Enter/Escape/Tab/arrows on the focused element',
  'scroll {"pixels", "dir"} — scroll the page',
  'switchTab {"titleOrUrl"} — switch to another open tab',
  'extractData {"instruction"} — read the current page and extract what it says',
  'waitForText {"text"} — wait until the page shows this text',
  'remember {"key", "value"} / recall {"key"} — task scratchpad',
  'askUserForHelp {"message"} — pause and ask the user',
  'DONE {"result"} — finish and return the result'
].join('\n');

const RULES = [
  'Rules:',
  '- Use ONLY [ref=eN] refs from the CURRENT page snapshot; never guess refs.',
  '- One action per step. After each action, read the observation.',
  '- If a click fails or nothing changed, try a different ref or approach — do not repeat the exact same action.',
  '- Never invent data: extractData returns what the page actually shows.',
  '- If the task needs credentials, payment, or a CAPTCHA, use askUserForHelp.',
  '- When the goal is fully achieved from the evidence, emit DONE with the result.',
  'OUTPUT EXACTLY ONE JSON OBJECT, no prose: {"action":"<name>","params":{...}}'
].join('\n');

function parseDecision(text) {
  const raw = String(text || '');
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (!j || typeof j.action !== 'string') return null;
    return { action: j.action, params: j.params && typeof j.params === 'object' ? j.params : {} };
  } catch (e) {
    return null;
  }
}

export function createAutoTaskRunner(deps) {
  // deps: { ai, storage, tabs, scripting, capture?, keepalive?, alarms?,
  //         onProgress?(run), getBlockedDomains?: async () => string[] }
  const tools = new AgentTools({
    scripting: deps.scripting || (typeof chrome !== 'undefined' ? chrome.scripting : null),
    tabs: deps.tabs || (typeof chrome !== 'undefined' ? chrome.tabs : null),
    capture: deps.capture || (typeof chrome !== 'undefined' && chrome.action ? (tabId, opts) => chrome.tabs.captureVisibleTab(tabId, opts) : null)
  });
  let run = null;
  let looping = false;
  let sitePrefsCache = {};

  async function ensureRun() {
    if (run) return run;
    const data = await deps.storage.get(RUN_KEY);
    run = (data && data[RUN_KEY]) || null;
    return run;
  }

  async function persist() {
    if (!run) return;
    await deps.storage.set({ [RUN_KEY]: JSON.parse(JSON.stringify(run)) });
    if (typeof deps.onProgress === 'function') {
      try { deps.onProgress(JSON.parse(JSON.stringify(run))); } catch (e) {}
    }
  }

  async function blockedDomains() {
    if (typeof deps.getBlockedDomains === 'function') {
      try { return await deps.getBlockedDomains(); } catch (e) { /* fall through */ }
    }
    return DEFAULT_BLOCKED_DOMAINS;
  }

  async function chat(prompt, maxTokens = 350) {
    run.aiCalls++;
    const text = await deps.ai.chat(prompt, maxTokens);
    return text;
  }

  // ---- lifecycle ---------------------------------------------------------

  async function start({ goal, tabId }) {
    await ensureRun();
    if (run && (run.status === 'running' || run.status === 'waiting_approval' || run.status === 'paused')) {
      return { ok: false, reason: 'A task is already running. Cancel it first.' };
    }
    goal = String(goal || '').trim();
    if (!goal) return { ok: false, reason: 'Empty task.' };
    if (goal.length > 500) return { ok: false, reason: 'Task too long (max 500 characters).' };

    const domains = await blockedDomains();
    let currentUrl = '';
    try {
      const tab = await deps.tabs.get(tabId);
      currentUrl = tab && tab.url || '';
    } catch (e) { /* tab gone; preflight on goal only */ }

    const pf = preflight({ url: currentUrl, blocklist: domains });
    if (!pf.allowed) {
      run = { taskId: `t${Date.now().toString(36)}`, goal, status: 'failed', result: pf.message, steps: [], observations: [], approvals: [], aiCalls: 0, startedAt: Date.now(), endedAt: Date.now() };
      await persist();
      return { ok: false, reason: pf.message };
    }

    run = {
      taskId: `t${Date.now().toString(36)}`,
      goal,
      tabId,
      status: 'running',            // running | waiting_approval | paused | done | partial | failed | canceled | blocked_user
      planText: '',
      planSteps: [],
      stepIndex: 0,
      replans: 0,
      step: 0,
      steps: [],                    // [{action, params, observation, ts, risk, recovered}]
      observations: [],
      approvals: [],
      memory: {},
      result: '',
      aiCalls: 0,
      quota: null,                  // {used, charged} from deps.meter — the number the UI shows
      quotaError: null,
      startedAt: Date.now(),
      endedAt: null
    };

    // Real metering: reserve this run's cost in the SAME counter that gates
    // quota. Best-effort — a metering failure must not silently over-serve, but
    // it must not wedge the run either, so it is recorded honestly on the run.
    if (typeof deps.meter === 'function') {
      try {
        const metered = await deps.meter(AUTO_TASK_CALL_MULTIPLIER);
        run.quota = (metered && typeof metered === 'object') ? { ...metered, at: Date.now() } : { used: null, charged: AUTO_TASK_CALL_MULTIPLIER, at: Date.now() };
      } catch (e) {
        run.quotaError = String(e && e.message || e).slice(0, 200);
      }
    }

    await persist();
    if (deps.keepalive) { try { deps.keepalive.start(run.taskId); } catch (e) {} }
    scheduleApprovalAlarm();
    kickLoop();
    return { ok: true, taskId: run.taskId };
  }

  function kickLoop() {
    if (looping) return;
    looping = true;
    loop().catch(async (e) => {
      looping = false;
      if (run) {
        run.status = 'failed';
        run.result = `Task failed: ${String(e && e.message || e).slice(0, 300)}`;
        run.endedAt = Date.now();
        await finish();
      }
    });
  }

  async function finish() {
    if (deps.keepalive) { try { deps.keepalive.stop(); } catch (e) {} }
    if (deps.alarms) { try { await deps.alarms.clear(APPROVAL_ALARM); } catch (e) {} }
    try {
      await saveTaskRun(deps.storage, {
        taskId: run.taskId,
        goal: run.goal,
        status: run.status,
        result: run.result,
        tokensUsed: run.aiCalls,
        aiCalls: run.aiCalls,
        recipeSaved: !!run.recipeSaved,
        durationMs: (run.endedAt || Date.now()) - run.startedAt,
        steps: run.steps.length
      });
      await appendTrajectory(deps.storage, {
        goal: run.goal,
        startedAt: run.startedAt,
        durationMs: (run.endedAt || Date.now()) - run.startedAt,
        status: run.status,
        steps: run.steps.map(s => ({
          t: s.ts - run.startedAt,
          action: `${s.action} ${JSON.stringify(s.params || {}).slice(0, 120)}`,
          observation: String(s.observation || '').slice(0, 300),
          snapshotHash: s.snapshotHash || '',
          approval: s.approval || null,
          recovered: !!s.recovered
        })),
        outcome: run.result
      });
    } catch (e) { /* history is best-effort */ }
    await persist();
  }

  async function cancel() {
    await ensureRun();
    if (!run) return { ok: false, reason: 'No task.' };
    if (['done', 'failed', 'canceled'].includes(run.status)) return { ok: false, reason: 'Task already finished.' };
    run.status = 'canceled';
    run.result = run.result || `Canceled after ${run.steps.length} step(s). Partial progress kept.`;
    run.endedAt = Date.now();
    looping = false;
    await finish();
    return { ok: true };
  }

  async function pause() {
    await ensureRun();
    if (!run || run.status !== 'running') return { ok: false, reason: 'Not running.' };
    run.status = 'paused';
    await persist();
    return { ok: true };
  }

  async function resume() {
    await ensureRun();
    if (!run) return { ok: false, reason: 'No task.' };
    if (run.status !== 'paused') return { ok: false, reason: `Task is ${run.status}.` };
    run.status = 'running';
    await persist();
    if (deps.keepalive) { try { deps.keepalive.start(run.taskId); } catch (e) {} }
    kickLoop();
    return { ok: true };
  }

  // SW-restart recovery: the in-memory loop is gone but storage says a run was
  // in flight. Re-kick it (running) or re-evaluate a stale approval (waiting).
  async function rehydrate() {
    await ensureRun();
    if (!run) return { ok: false, reason: 'No task.' };
    if (run.status === 'running') {
      if (deps.keepalive) { try { deps.keepalive.start(run.taskId); } catch (e) {} }
      kickLoop();
      return { ok: true, resumed: 'running' };
    }
    if (run.status === 'waiting_approval') {
      await checkApprovals();
      return { ok: true, resumed: 'waiting_approval' };
    }
    return { ok: false, reason: `Task is ${run.status}.` };
  }

  // ---- approvals -----------------------------------------------------------

  function scheduleApprovalAlarm() {
    if (!deps.alarms) return;
    try { deps.alarms.create(APPROVAL_ALARM, { delayInMinutes: Math.ceil(APPROVAL_TIMEOUT_MS / 60000) }); } catch (e) {}
  }

  async function checkApprovals() {
    await ensureRun();
    if (!run || run.status !== 'waiting_approval') return { ok: false };
    const pending = run.approvals.filter(a => a.status === 'pending');
    let changed = false;
    for (const a of pending) {
      if (isApprovalTimedOut(a)) {
        resolveApproval(a, 'approved'); // converts to 'timeout' (= deny)
        await appendAudit(deps.storage, { action: a.description, risk: a.risk, decision: 'timeout', url: a.url });
        run.observations.push(`USER DID NOT RESPOND to "${a.description}" within 60s — treat as DENIED. Choose another approach.`);
        changed = true;
      }
    }
    if (!changed) return { ok: false };
    run.status = 'running';
    await persist();
    kickLoop();
    return { ok: true };
  }

  async function decide({ decision }) {
    await ensureRun();
    if (!run || run.status !== 'waiting_approval') return { ok: false, reason: 'No pending approval.' };
    const pending = run.approvals.find(a => a.status === 'pending');
    if (!pending) return { ok: false, reason: 'No pending approval.' };
    resolveApproval(pending, decision === 'approved' ? 'approved' : 'denied');
    await appendAudit(deps.storage, { action: pending.description, risk: pending.risk, decision: pending.status, url: pending.url });
    if (pending.status === 'approved') {
      run.observations.push(`USER APPROVED: ${pending.description}. It will be executed now.`);
    } else {
      run.observations.push(`USER DENIED: ${pending.description}. Do NOT try the same action again — choose another approach.`);
    }
    run.status = 'running';
    await persist();
    if (deps.keepalive) { try { deps.keepalive.start(run.taskId); } catch (e) {} }
    kickLoop();
    return { ok: true, decision: pending.status };
  }

  // ---- the loop --------------------------------------------------------------

  async function loop() {
    await ensureRun();
    if (!run) { looping = false; return; }
    const domains = await blockedDomains();

    try {
      while (run && run.status === 'running') {
        const elapsed = Date.now() - run.startedAt;
        if (run.step >= MAX_STEPS) {
          run.status = 'partial';
          run.result = labelPartial(run.result || collectExtracted(), `step cap (${MAX_STEPS}) reached`, { reason: 'max steps' });
          run.endedAt = Date.now();
          break;
        }
        if (elapsed > MAX_DURATION_MS) {
          run.status = 'partial';
          run.result = labelPartial(run.result || collectExtracted(), 'time cap (5 min) reached', { reason: 'time cap' });
          run.endedAt = Date.now();
          break;
        }

        // Perception: grounded snapshot of the active tab.
        try { sitePrefsCache = await listSiteInstructions(deps.storage); } catch (e) {}
        const snap = await tools.snapshot(run.tabId);
        if (!snap || !snap.byRef) {
          throw new Error('Cannot read the page (no host permission or page unavailable). Grant site access and retry.');
        }
        run.lastFingerprint = snapshotFingerprint(snap);

        // Hostile-environment check before acting.
        const state = await tools.readState(run.tabId);
        const blocker = detectBlockers({
          url: snap.url, title: snap.title, text: snap.pageText,
          hasPasswordField: !!(state && state.hasPasswordField)
        });
        if (blocker.blocked && blocker.kind !== 'no_results') {
          run.status = 'blocked_user';
          run.result = `${blocker.message} ${blocker.userHint}`;
          run.endedAt = Date.now();
          break;
        }

        // Plan once, then execute step by step.
        if (!run.planSteps.length) {
          run.planText = await planFor(goalText(), snap);
          run.planSteps = parsePlan(run.planText).steps;
          await persist();
        }

        // Ask the planner for the next action.
        const prompt = buildPrompt(snap);
        let decision;
        try {
          decision = parseDecision(await chat(prompt, 350));
        } catch (e) {
          throw new Error(`Planner error: ${String(e && e.message || e).slice(0, 200)}`);
        }
        if (!decision) {
          run.observations.push('Planner returned unparseable output; retrying with a reminder.');
          await persist();
          continue;
        }

        if (decision.action === 'DONE') {
          run.result = String(decision.params && decision.params.result || collectExtracted() || 'Task finished.');
          const verdict = await validateGoal({ chat: (p) => chat(p, 300) }, {
            goal: run.goal,
            observations: run.observations.slice(-3),
            result: run.result
          });
          if (verdict.complete) {
            run.status = 'done';
            run.endedAt = Date.now();
            // Offer save-as-recipe when the run has replayable grounded steps.
            const offerable = savableSteps(run);
            if (offerable.length) {
              run.recipeOffer = { name: recipeNameFor(run), stepCount: offerable.length };
            }
            break;
          }
          if (run.step >= MAX_STEPS - 1) {
            run.status = 'partial';
            run.result = labelPartial(run.result, verdict.missing, { reason: 'steps exhausted' });
            run.endedAt = Date.now();
            break;
          }
          run.observations.push(`DONE-validator: NOT complete — ${verdict.missing || 'evidence missing'}. Continue working toward the goal.`);
          run.step++;
          await persist();
          continue;
        }

        if (decision.action === 'askUserForHelp') {
          run.status = 'paused';
          run.result = String(decision.params && decision.params.message || 'The task needs your input.');
          run.endedAt = null;
          await persist();
          looping = false;
          return; // resume() restarts the loop
        }

        // Safety gate.
        const riskInfo = classifyDecision(decision, snap, domains);
        if (isDomainBlocked(snap.url, domains) && !['switchTab', 'recall', 'remember', 'DONE'].includes(decision.action)) {
          run.status = 'blocked_user';
          run.result = `Blocked: ${snap.url} is on the Auto Task blocklist.`;
          run.endedAt = Date.now();
          break;
        }
        if (riskInfo.risk === RISK.BLOCKED) {
          run.status = 'blocked_user';
          run.result = riskInfo.message;
          run.endedAt = Date.now();
          await appendAudit(deps.storage, { action: riskInfo.reason, risk: RISK.BLOCKED, decision: 'blocked', url: snap.url, detail: JSON.stringify(decision.params || {}).slice(0, 200) });
          break;
        }
        if (riskInfo.risk === RISK.CONFIRM) {
          const approval = createApproval({
            id: `a${run.step}-${run.approvals.length}`,
            action: decision,
            description: describeApproval({
              kind: actionKind(decision.action),
              name: actionName(decision, snap),
              url: snap.url,
              value: decision.params && decision.params.text
            }),
            risk: RISK.CONFIRM
          });
          approval.url = snap.url;
          run.approvals.push(approval);
          run.status = 'waiting_approval';
          scheduleApprovalAlarm();
          await persist();
          looping = false;
          return; // decide() restarts the loop
        }

        // Execute (safe).
        const stepStart = Date.now();
        const execRes = await executeDecision(decision, snap, domains);
        run.step++;
        const obsText = formatObservation(execRes);
        const obsDetail = execRes && execRes.observation ? execRes.observation : null;
        run.steps.push({
          action: decision.action,
          params: decision.params,
          observation: obsText,
          ts: stepStart,
          risk: RISK.SAFE,
          recovered: !!(execRes && execRes.recovered),
          snapshotHash: run.lastFingerprint,
          url: snap.url
        });
        run.observations.push(`${decision.action} ${JSON.stringify(decision.params || {})} → ${obsText}`);

        // Criterion gate (plan-then-execute): check the current step's
        // criterion against the real observation and apply stepDecision
        // (next → recover → replan×2 → fail honestly as PARTIAL).
        const cur = run.planSteps[run.stepIndex];
        if (cur) {
          const met = cur.criterion
            ? checkCriterion(cur.criterion, {
                url: (obsDetail && obsDetail.url) || snap.url,
                title: (obsDetail && obsDetail.title) || snap.title,
                // Prefer the post-action page text; keyText (added element names)
                // is only a fallback so a text criterion is never silently empty.
                text: (obsDetail && (obsDetail.text || obsDetail.keyText)) || snap.pageText || '',
                elementCount: obsDetail && obsDetail.elementCount,
                added: obsDetail && obsDetail.added,
                counts: {}
              })
            : true;
          const gate = stepDecision({
            criterionMet: met,
            recovered: !!(execRes && execRes.recovered) || !!run.stepRecovered,
            replans: run.replans
          });
          if (gate === 'next') {
            run.stepIndex++;
            run.stepRecovered = false;
            run.observations.push(`Step ${run.stepIndex} done (${cur.criterion || cur.action}).`);
          } else if (gate === 'recover') {
            run.stepRecovered = true;
            run.observations.push(`Step ${run.stepIndex + 1} criterion not met yet (${cur.criterion || cur.action}); retrying with a different approach.`);
          } else if (gate === 'replan') {
            run.replans += 1;
            run.planSteps = [];
            run.stepIndex = 0;
            run.stepRecovered = false;
            run.observations.push(`Replanning (${run.replans}/2): step "${cur.action}" was not achieved.`);
          } else {
            run.status = 'partial';
            run.result = labelPartial(run.result || collectExtracted(), `could not achieve step "${cur.action}"${cur.criterion ? ` (${cur.criterion})` : ''}`, { reason: 'criterion failed after replans' });
            run.endedAt = Date.now();
            break;
          }
        }
        await persist();
        if (deps.keepalive) { try { deps.keepalive.poke(); } catch (e) {} }
      }

      if (run && run.endedAt && ['done', 'partial', 'failed', 'canceled', 'blocked_user'].includes(run.status)) {
        await finish();
      } else if (run) {
        await persist();
      }
      looping = false;
    } catch (e) {
      looping = false;
      run.status = 'failed';
      run.result = `Task failed: ${String(e && e.message || e).slice(0, 300)}`;
      run.endedAt = Date.now();
      await finish();
    }
  }

  function goalText() {
    return run.goal;
  }

  function collectExtracted() {
    // Prefer remembered task results; fall back to the last successful extract.
    for (let i = run.observations.length - 1; i >= 0; i--) {
      const o = run.observations[i];
      if (/^extractData/.test(o)) return o.slice(0, 1200);
    }
    return '';
  }

  async function planFor(goal, snap) {
    const progress = run.observations.slice(-3).map(o => `- ${String(o).slice(0, 160)}`).join('\n');
    const sitePrefs = buildSiteInstructionBlock(await getSiteInstructions(deps.storage, snap.url));
    const prompt = [
      'You are a browser automation planner. Write a SHORT numbered plan (max 6 steps).',
      `GOAL: ${goal}`,
      `PAGE: ${snap.title} — ${snap.url}`,
      sitePrefs,
      progress ? `PROGRESS SO FAR:\n${progress}` : '',
      'Each step: "N. <action> | done when: <checkable criterion>" using criteria like: url contains X / title contains X / text contains "X" / new elements >= N / elements >= N.',
      'OUTPUT ONLY the numbered plan.'
    ].filter(Boolean).join('\n\n');
    return await chat(prompt, 300);
  }

  function buildPrompt(snap) {
    const planLines = run.planSteps.map(s => `${s.n}. ${s.action}${s.criterion ? ` (done when: ${s.criterion})` : ''}`);
    const doneIdx = run.stepIndex || 0;
    const recent = run.observations.slice(-6).map(o => `- ${String(o).slice(0, 260)}`).join('\n');
    const sitePrefs = buildSiteInstructionBlock(getSiteInstructionsFromCache(sitePrefsCache, snap.url));
    return [
      `GOAL: ${run.goal}`,
      `STEP ${run.step + 1}/${MAX_STEPS} | page ${snap.title} — ${snap.url}`,
      sitePrefs,
      planLines.length ? `PLAN (step ${doneIdx + 1} is current):\n${planLines.join('\n')}` : '',
      run.observations.length ? `RECENT OBSERVATIONS:\n${recent}` : 'No observations yet.',
      Object.keys(run.memory || {}).length ? `MEMORY: ${JSON.stringify(run.memory).slice(0, 400)}` : '',
      `PAGE ELEMENTS (use these refs):\n${snap.text}`,
      snap.pageText ? `PAGE TEXT (first 1200 chars):\n${String(snap.pageText).slice(0, 1200)}` : '',
      `AVAILABLE ACTIONS:\n${TOOLS_LIST}`,
      RULES
    ].filter(Boolean).join('\n\n');
  }

  // ---- decision execution -----------------------------------------------------

  function actionKind(actionName) {
    switch (actionName) {
      case 'clickRef': return 'click';
      case 'typeRef': return 'type';
      case 'selectRef': return 'select';
      case 'pressKey': return 'pressKey';
      case 'downloadFile': return 'download';
      case 'closeTab': return 'closeTab';
      default: return actionName;
    }
  }

  function actionName(decision, snap) {
    const p = decision.params || {};
    const refRec = p.ref && snap.byRef ? snap.byRef[p.ref] : null;
    return (refRec && refRec.name) || p.text || p.option || '';
  }

  function classifyDecision(decision, snap, domains) {
    const p = decision.params || {};
    const refRec = p.ref && snap.byRef ? snap.byRef[p.ref] : null;
    return classifyAction({
      kind: actionKind(decision.action),
      name: actionName(decision, snap),
      url: snap.url,
      // For navigate, the risk lives in the DESTINATION, not the current page.
      targetUrl: decision.action === 'navigate' ? String(p.url || '') : '',
      blocklist: domains,
      value: p.text,
      key: p.key,
      isPassword: !!(refRec && /password/i.test(String(refRec.name || '')) )
    });
  }

  async function executeDecision(decision, snap, domains) {
    const p = decision.params || {};
    switch (decision.action) {
      case 'navigate': {
        const url = resolveNavigateUrl(p.url);
        // Belt & suspenders: classifyAction already refuses a blocklisted
        // destination (run is marked blocked_user); this keeps the tool layer
        // safe on its own.
        if (isDomainBlocked(url, domains)) {
          return { ok: false, reason: 'BLOCKED_DOMAIN', error: 'That domain is blocklisted for Auto Task.' };
        }
        return await tools.navigate(run.tabId, url);
      }
      case 'clickRef': return await tools.executeWithRecovery(run.tabId, { kind: 'click', ref: String(p.ref || ''), targetDescription: p.description || '' }, visionDeps());
      case 'typeRef': return await tools.executeWithRecovery(run.tabId, { kind: 'type', ref: String(p.ref || ''), text: String(p.text == null ? '' : p.text), clear: p.clear !== false, submit: !!p.submit, targetDescription: p.description || '' }, visionDeps());
      case 'selectRef': return await tools.executeWithRecovery(run.tabId, { kind: 'select', ref: String(p.ref || ''), option: String(p.option || '') }, visionDeps());
      case 'pressKey': return await tools.pressKey(run.tabId, String(p.key || 'Enter'));
      case 'scroll': return await tools.scroll(run.tabId, p.dir === 'up' ? 'up' : 'down', Number(p.pixels || 600));
      case 'hoverRef': return await tools.executeWithRecovery(run.tabId, { kind: 'hover', ref: String(p.ref || '') }, visionDeps());
      case 'switchTab': return await switchTab(String(p.titleOrUrl || ''));
      case 'waitForText': return await tools.waitForText(run.tabId, String(p.text || ''), Math.min(15000, Number(p.timeoutMs || 8000)));
      case 'remember': {
        run.memory = run.memory || {};
        run.memory[String(p.key || 'note').slice(0, 40)] = String(p.value == null ? '' : p.value).slice(0, 800);
        return { ok: true, remembered: String(p.key || 'note') };
      }
      case 'recall': return { ok: true, value: (run.memory || {})[String(p.key || '')] != null ? String((run.memory || {})[String(p.key || '')]) : 'NOT_FOUND' };
      case 'extractData': return await extractData(String(p.instruction || run.goal));
      default:
        return { ok: false, reason: 'UNKNOWN_ACTION', error: `Unknown action "${decision.action}". Use the listed actions.` };
    }
  }

  async function switchTab(titleOrUrl) {
    try {
      const q = await deps.tabs.query({});
      const needle = titleOrUrl.toLowerCase();
      const hit = q.find(t => (t.url || '').toLowerCase().includes(needle) || (t.title || '').toLowerCase().includes(needle));
      if (!hit) return { ok: false, reason: 'TAB_NOT_FOUND', error: `No open tab matches "${titleOrUrl}".` };
      await deps.tabs.update(hit.id, { active: true });
      run.tabId = hit.id;
      await tools.waitForLoad(hit.id, 10000);
      return { ok: true, switchedTo: (hit.title || hit.url || '').slice(0, 60), observation: await tools.observe(hit.id) };
    } catch (e) {
      return { ok: false, reason: 'SWITCH_FAILED', error: String(e && e.message || e).slice(0, 120) };
    }
  }

  async function extractData(instruction) {
    const snap = await tools.snapshot(run.tabId);
    if (!snap || !snap.byRef) return { ok: false, reason: 'SNAPSHOT_FAILED' };
    const prompt = [
      `Extract from this page. INSTRUCTION: ${instruction}`,
      `PAGE: ${snap.title} — ${snap.url}`,
      `TEXT:\n${String(snap.pageText || '').slice(0, 3500)}`,
      snap.elementCount ? `INTERACTIVE ELEMENTS:\n${snap.text.slice(0, 1500)}` : '',
      'Answer with ONLY the extracted data (table/CSV/list as appropriate). If the page does not contain it, answer NOT_FOUND.'
    ].filter(Boolean).join('\n\n');
    const answer = await chat(prompt, 800);
    return { ok: true, extracted: answer.slice(0, 2000), observation: { ok: true, url: snap.url, title: snap.title, added: 0, removed: 0, urlChanged: false, elementCount: snap.elementCount } };
  }

  // Vision tier wiring: Set-of-Mark via a vision-capable model when
  // VISION_MODEL is configured; otherwise an honest unavailable marker (the
  // retry ladder treats it as a terminal vision failure).
  function visionDeps() {
    return {
      vision: async ({ badges, prompt }) => {
        if (!VISION_MODEL || !tools.capture) return null;
        const som = await tools.captureSoM(run.tabId, badges);
        if (!som || !som.ok) return null;
        run.aiCalls += 1; // vision call (billed at 3× in managed metering)
        try {
          const { buildVisionPrompt } = await import('./recovery.js');
          const messages = [{
            role: 'user',
            content: [
              { type: 'text', text: prompt || buildVisionPrompt(badges, 'the target element') },
              { type: 'image_url', image_url: { url: som.dataUrl } }
            ]
          }];
          return await deps.ai.chatWithMessages(messages, 60, 0, 1);
        } catch (e) {
          return null;
        }
      }
    };
  }

  // ---- recipes (Phase 6, wired into the live loop) --------------------------
  // A run that finished with grounded steps can be saved as a replayable recipe.
  // Replay re-grounds each ref against a fresh snapshot (recipes.js) and self-heals
  // by handing the recipe's goal back to the agent loop when a step cannot replay.

  function recipeNameFor(r) {
    const g = String((r && r.goal) || 'Auto Task').trim();
    return g.length > 60 ? `${g.slice(0, 57)}…` : g;
  }

  // Only grounded action types survive stepToDescriptor — a run made purely of
  // navigate/extract steps is not replayable and must not be offered as a recipe.
  function savableSteps(r) {
    return ((r && r.steps) || []).filter(s => stepToDescriptor(s));
  }

  async function saveRecipeFromRun({ name } = {}) {
    await ensureRun();
    if (!run) return { ok: false, reason: 'No task.' };
    const steps = savableSteps(run);
    if (!steps.length) return { ok: false, reason: 'This run has no replayable grounded steps to save.' };
    const entry = await saveRecipe(deps.storage, {
      name: name || (run.recipeOffer && run.recipeOffer.name) || recipeNameFor(run),
      goal: run.goal,
      steps
    });
    run.recipeSaved = true;
    run.recipeId = entry.recipeId;
    run.recipeOffer = null;
    await persist();
    return { ok: true, recipeId: entry.recipeId, stepCount: entry.steps.length, name: entry.name };
  }

  async function listRecipeSummaries() {
    return await listRecipes(deps.storage);
  }

  async function startRecipe({ recipeId, tabId } = {}) {
    await ensureRun();
    if (run && ['running', 'waiting_approval', 'paused'].includes(run.status)) {
      return { ok: false, reason: 'A task is already running. Cancel it first.' };
    }
    const recipe = await getRecipe(deps.storage, recipeId);
    if (!recipe) return { ok: false, reason: 'Recipe not found.' };
    if (!recipe.steps || !recipe.steps.length) return { ok: false, reason: 'That recipe has no replayable steps.' };

    const domains = await blockedDomains();
    let currentUrl = '';
    try {
      const tab = await deps.tabs.get(tabId);
      currentUrl = tab && tab.url || '';
    } catch (e) { /* tab gone */ }
    const pf = preflight({ url: currentUrl, blocklist: domains });
    if (!pf.allowed) return { ok: false, reason: pf.message };

    run = {
      taskId: `t${Date.now().toString(36)}`,
      goal: recipe.goal || recipe.name,
      tabId,
      mode: 'recipe',
      recipeId: recipe.recipeId,
      recipeName: recipe.name,
      status: 'running',
      planText: '', planSteps: [], stepIndex: 0, replans: 0, step: 0,
      steps: [], observations: [`Replaying recipe "${recipe.name}" (${recipe.steps.length} step(s)).`],
      approvals: [], memory: {}, result: '', aiCalls: 0, quota: null, quotaError: null,
      startedAt: Date.now(), endedAt: null
    };
    await persist();

    let replay = { ok: false, results: [], reason: 'REPLAY_FAILED' };
    try {
      replay = await replayRecipe(tools, tabId, recipe, {
        onFailure: async ({ failedStep, reason }) => {
          run.observations.push(`Recipe step ${failedStep + 1} failed (${reason || 'unknown'}) — handing off to the agent loop.`);
          return { ok: false };
        }
      });
    } catch (e) {
      run.observations.push(`Recipe replay error: ${String(e && e.message || e).slice(0, 200)}`);
    }

    for (const r of replay.results || []) {
      run.step++;
      run.steps.push({
        action: r.action,
        params: r.params,
        observation: r.observation,
        ts: Date.now(),
        risk: RISK.SAFE,
        recovered: !!r.healed,
        url: currentUrl
      });
      run.observations.push(`${r.action} ${JSON.stringify(r.params || {})} → ${r.observation}`);
    }

    if (replay.ok) {
      run.status = 'done';
      run.result = `Recipe "${recipe.name}" replayed ${(replay.results || []).length} step(s)${replay.healed ? ' (self-healed a stale ref)' : ''}.`;
      run.endedAt = Date.now();
      await persist();
      await finish();
      return { ok: true, healed: !!replay.healed, steps: (replay.results || []).length };
    }

    // The recipe could not be replayed. Say so, then self-heal for real: continue
    // toward the recipe's goal through the agent loop instead of reporting success.
    run.status = 'running';
    run.mode = 'agent';
    run.planSteps = [];
    run.stepIndex = 0;
    run.observations.push('Recipe could not be replayed — continuing as a task toward the same goal.');
    await persist();
    kickLoop();
    return { ok: true, healed: false, fellBackToAgent: true, steps: (replay.results || []).length };
  }

  async function getState() {
    await ensureRun();
    // Lazy-timeout stale pending approvals even if the alarm never fired.
    if (run && run.status === 'waiting_approval') {
      const pending = run.approvals.find(a => a.status === 'pending');
      if (pending && isApprovalTimedOut(pending)) await checkApprovals();
    }
    return run ? JSON.parse(JSON.stringify(run)) : null;
  }

  // Test/diagnostic hook: expose pure pieces for the e2e suite.
  return {
    start, cancel, pause, resume, rehydrate, decide, checkApprovals, getState,
    saveRecipeFromRun, listRecipeSummaries, startRecipe,
    get tools() { return tools; },
    get internal() { return { buildPrompt, planFor, parseDecision, classifyDecision, executeDecision }; }
  };
}

// Helper shared with getSiteInstructionsSync above.
function getSiteInstructionsFromCache(prefs, url) {
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return []; }
  const hits = [];
  for (const [d, text] of Object.entries(prefs || {})) {
    if (host === d || host.endsWith(`.${d}`)) hits.push({ domain: d, text });
  }
  return hits;
}
