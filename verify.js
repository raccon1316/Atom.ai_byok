// verify.js — Phase 3: planning & goal verification for the Auto Task agent.
//
// Pure + storage-injected (Node-testable), same convention as multitab.js /
// recovery.js. The Auto Task runner (autotask.js) consumes this to:
//   - parse the planner's numbered plan into steps with success criteria
//   - check each criterion against the latest observation (no vibes)
//   - run the DONE-validator so a run can never claim unearned completion
//   - persist task runs (last 20), trajectories (last 50), per-site
//     instructions, and the destructive-action audit log (last 200)

// ---- plan parsing + criteria ----------------------------------------------

// Planner output format (lenient): numbered lines, optionally with a
// success criterion after "done when:" or a "|" separator, e.g.
//   1. Navigate to flights.google.com | done when: url contains flights.google.com
//   2. Enter origin BLR — done when: text contains "Where from"
export function parsePlan(text) {
  const steps = [];
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    const m = line.match(/^(\d{1,2})[.)]\s*(.+)$/);
    if (!m) continue;
    const body = m[2];
    let action = body, criterion = '';
    const whenM = body.match(/done when:\s*(.+)$/i) || body.match(/\|\s*(.+)$/);
    if (whenM) {
      criterion = whenM[1].trim();
      action = body.slice(0, whenM.index).replace(/[—–-]\s*$/, '').replace(/\|\s*$/, '').trim();
    }
    steps.push({ n: steps.length + 1, action, criterion: normalizeCriterion(criterion) });
  }
  return { steps };
}

function normalizeCriterion(c) {
  return String(c || '').trim();
}

// Criterion DSL evaluated against a state object the runner assembles from
// observations: { url, title, text, elementCount, added, counts: {sel: n} }.
// Supported:
//   url contains X          url matches /re/
//   title contains X
//   text contains X         (quotes optional)
//   elements >= N | elements > N
//   new elements >= N       (elements added by the last action)
//   count(SELECTOR) >= N    (runner fills state.counts[selector])
export function checkCriterion(criterion, state = {}) {
  const c = String(criterion || '').trim().toLowerCase();
  if (!c || c === 'none') return true; // no criterion = trust the step action
  const url = String(state.url || '').toLowerCase();
  const title = String(state.title || '').toLowerCase();
  const text = String(state.text || '').toLowerCase();

  let m;
  if ((m = c.match(/^url\s+contains\s+(.+)$/))) return url.includes(unquote(m[1]));
  if ((m = c.match(/^url\s+matches\s+(.+)$/))) {
    const re = extractRegex(m[1]);
    return re ? re.test(String(state.url || '')) : false;
  }
  if ((m = c.match(/^title\s+contains\s+(.+)$/))) return title.includes(unquote(m[1]));
  if ((m = c.match(/^text\s+contains\s+(.+)$/))) return text.includes(unquote(m[1]));
  if ((m = c.match(/^new\s+elements?\s*(>=|>)\s*(\d+)$/))) {
    const added = Number(state.added || 0);
    return m[1] === '>' ? added > Number(m[2]) : added >= Number(m[2]);
  }
  if ((m = c.match(/^elements?\s*(>=|>|==)\s*(\d+)$/))) {
    const n = Number(state.elementCount || 0), k = Number(m[2]);
    if (m[1] === '>') return n > k;
    if (m[1] === '==') return n === k;
    return n >= k;
  }
  if ((m = c.match(/^count\((.+)\)\s*(>=|>|==)\s*(\d+)$/))) {
    const got = Number((state.counts || {})[unquote(m[1])] ?? -1), k = Number(m[3]);
    if (m[2] === '>') return got > k;
    if (m[2] === '==') return got === k;
    return got >= k;
  }
  // Unrecognized criterion — default to met so an over-specific planner
  // phrase never wedges the run; the DONE-validator is the real gate.
  return true;
}

function unquote(s) {
  s = String(s || '').trim();
  return s.replace(/^["']|["']$/g, '');
}

function extractRegex(s) {
  s = String(s || '').trim();
  const m = s.match(/^\/(.*)\/[a-z]*$/s);
  const body = m ? m[1] : s;
  try { return new RegExp(body, 'i'); } catch (e) { return null; }
}

// Step policy after an observation: met → next step; not met → recovery;
// recovery exhausted → replan (max 2) → fail honestly.
export function stepDecision({ criterionMet, recovered, replans, maxReplans = 2 } = {}) {
  if (criterionMet) return 'next';
  if (!recovered) return 'recover';
  if ((replans || 0) < maxReplans) return 'replan';
  return 'fail';
}

// ---- DONE-validator --------------------------------------------------------

export function buildValidateGoalPrompt({ goal, observations, result, maxChars = 6000 }) {
  const obs = (observations || [])
    .slice(-3)
    .map((o, i) => `[obs -${(observations || []).slice(-3).length - i + 3}] ${String(o).slice(0, 800)}`)
    .join('\n');
  return [
    'You verify whether an autonomous browser task actually achieved its goal.',
    `GOAL: ${goal}`,
    `LAST OBSERVATIONS:\n${obs || '(none)'}`,
    `EXTRACTED RESULT:\n${String(result || '').slice(0, maxChars)}`,
    'Judge ONLY from the evidence above. If the evidence does not show completion, the task is not complete.',
    'Respond with EXACTLY this JSON and nothing else:',
    '{"complete": true|false, "evidence": "what in the evidence shows it", "missing": "what is missing, empty if complete"}'
  ].join('\n');
}

export function parseValidateGoalAnswer(text) {
  const raw = String(text || '');
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { complete: false, evidence: '', missing: 'validator returned no parsable judgment' };
  try {
    const j = JSON.parse(m[0]);
    return {
      complete: j.complete === true,
      evidence: String(j.evidence || '').slice(0, 400),
      missing: String(j.missing || '').slice(0, 400)
    };
  } catch (e) {
    return { complete: false, evidence: '', missing: 'validator JSON parse failed' };
  }
}

// deps: { chat: async (prompt) => text }
export async function validateGoal(deps, { goal, observations, result }) {
  if (!deps || typeof deps.chat !== 'function') {
    return { complete: false, evidence: '', missing: 'no validator available' };
  }
  try {
    const answer = await deps.chat(buildValidateGoalPrompt({ goal, observations, result }));
    return parseValidateGoalAnswer(answer);
  } catch (e) {
    return { complete: false, evidence: '', missing: `validator error: ${String(e && e.message || e).slice(0, 200)}` };
  }
}

// Honest labeling for partial results (never fabricate completion).
export function labelPartial(result, missing, { reason } = {}) {
  const why = missing || reason || 'steps or evidence ran out';
  return `PARTIAL RESULT — could not complete the task (${why}):\n\n${String(result || '').slice(0, 4000)}`;
}

// ---- storage-backed memory (all store-injected: {get, set}) ----------------

export const TASK_RUNS_KEY = 'autoTaskRuns';
export const TRAJECTORIES_KEY = 'autoTaskTrajectories';
export const SITE_PREFS_KEY = 'autoTaskSitePrefs';
export const AUDIT_LOG_KEY = 'autoTaskAuditLog';
export const TASK_RUNS_CAP = 20;
export const TRAJECTORIES_CAP = 50;
export const AUDIT_LOG_CAP = 200;

async function readList(store, key) {
  const data = await store.get(key);
  const list = data && data[key];
  return Array.isArray(list) ? list : [];
}

async function writeBounded(store, key, list, cap) {
  const trimmed = list.length > cap ? list.slice(list.length - cap) : list;
  await store.set({ [key]: trimmed });
  return trimmed;
}

export async function saveTaskRun(store, run) {
  const list = await readList(store, TASK_RUNS_KEY);
  const entry = {
    taskId: run.taskId || `t${Date.now().toString(36)}`,
    goal: String(run.goal || '').slice(0, 500),
    status: run.status || 'done',           // done | partial | failed | canceled
    result: String(run.result || '').slice(0, 8000),
    recipeSaved: !!run.recipeSaved,
    tokensUsed: Number(run.tokensUsed || 0),
    aiCalls: Number(run.aiCalls || 0),
    durationMs: Number(run.durationMs || 0),
    steps: Number(run.steps || 0),
    createdAt: Date.now()
  };
  list.push(entry);
  await writeBounded(store, TASK_RUNS_KEY, list, TASK_RUNS_CAP);
  return entry;
}

export async function getTaskRuns(store, { limit = TASK_RUNS_CAP } = {}) {
  const list = await readList(store, TASK_RUNS_KEY);
  return list.slice(-limit).reverse();
}

// ---- per-site instructions --------------------------------------------------

export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch (e) {
    return '';
  }
}

export async function getSiteInstructions(store, url) {
  const prefs = await readPrefs(store);
  const domain = domainOf(url);
  if (!domain) return [];
  const hits = [];
  for (const [d, text] of Object.entries(prefs)) {
    if (domain === d || domain.endsWith(`.${d}`)) hits.push({ domain: d, text });
  }
  return hits;
}

export function buildSiteInstructionBlock(hits) {
  if (!hits || !hits.length) return '';
  return 'SITE PREFERENCES (user instructions for this domain — obey them):\n' +
    hits.map(h => `- ${h.domain}: ${h.text}`).join('\n');
}

export async function setSiteInstruction(store, domain, text) {
  const prefs = await readPrefs(store);
  const d = String(domain || '').trim().toLowerCase().replace(/^www\./, '');
  if (!d) throw new Error('domain required');
  if (!text || !String(text).trim()) delete prefs[d];
  else prefs[d] = String(text).trim().slice(0, 500);
  await store.set({ [SITE_PREFS_KEY]: prefs });
  return prefs;
}

export async function listSiteInstructions(store) {
  return readPrefs(store);
}

export async function deleteSiteInstruction(store, domain) {
  return setSiteInstruction(store, domain, '');
}

async function readPrefs(store) {
  const data = await store.get(SITE_PREFS_KEY);
  const prefs = data && data[SITE_PREFS_KEY];
  return (prefs && typeof prefs === 'object' && !Array.isArray(prefs)) ? prefs : {};
}

// ---- trajectory logger ------------------------------------------------------

export function hashString(s) {
  const str = String(s || '');
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function snapshotFingerprint(snapshot) {
  if (!snapshot || !snapshot.byRef) return '';
  const ids = Object.values(snapshot.byRef)
    .map(r => `${r.role}::${String(r.name || '').toLowerCase()}`)
    .sort()
    .join('|');
  return hashString(ids);
}

export async function appendTrajectory(store, run) {
  const list = await readList(store, TRAJECTORIES_KEY);
  const entry = {
    goal: String(run.goal || '').slice(0, 500),
    startedAt: run.startedAt || Date.now(),
    durationMs: Number(run.durationMs || 0),
    status: run.status || 'unknown',
    steps: (run.steps || []).slice(0, 60).map(s => ({
      t: Number(s.t || 0),
      action: String(s.action || '').slice(0, 200),
      observation: String(s.observation || '').slice(0, 300),
      snapshotHash: s.snapshotHash || '',
      tokens: Number(s.tokens || 0),
      approval: s.approval || null,      // {risk, decision} for confirm-level
      recovered: !!s.recovered
    })),
    outcome: String(run.outcome || '').slice(0, 500)
  };
  list.push(entry);
  await writeBounded(store, TRAJECTORIES_KEY, list, TRAJECTORIES_CAP);
  return entry;
}

export async function getTrajectories(store, { limit = 10 } = {}) {
  const list = await readList(store, TRAJECTORIES_KEY);
  return list.slice(-limit).reverse();
}

// ---- destructive-action audit log -------------------------------------------

export async function appendAudit(store, { action, risk, decision, detail, url }) {
  const list = await readList(store, AUDIT_LOG_KEY);
  list.push({
    action: String(action || '').slice(0, 200),
    risk: risk || 'confirm',
    decision: decision || 'pending',     // approved | denied | timeout
    url: String(url || '').slice(0, 200),
    detail: String(detail || '').slice(0, 300),
    ts: Date.now()
  });
  await writeBounded(store, AUDIT_LOG_KEY, list, AUDIT_LOG_CAP);
}

export async function getAuditLog(store, { limit = 50 } = {}) {
  const list = await readList(store, AUDIT_LOG_KEY);
  return list.slice(-limit).reverse();
}
