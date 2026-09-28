import { AI } from './ai.js';
// MESSAGE TYPES handled in THIS file's chrome.runtime.onMessage router (below;
// automate.js/popup.js have their own listeners):
// AI_CHAT AUTOFILL_START AUTOFILL_STATUS AUTO_TASK_APPROVAL AUTO_TASK_GET_STATE
// AUTO_TASK_LIST_RECIPES AUTO_TASK_PAUSE AUTO_TASK_RESUME AUTO_TASK_RUN_RECIPE
// AUTO_TASK_SAVE_RECIPE AUTO_TASK_START AUTO_TASK_STOP BATTLECARD_START
// CANCEL_JOB CLEAR_DEBUG_LOG DEALROOM_START GET_API_KEY GET_DEBUG_LOG GET_JOB
// GET_JOBS GET_LAUNCH_REPORT GET_USER_SETTINGS INCREMENT_CALL_COUNT JOB_CANCEL
// JOB_CREATE JOB_GET JOB_LIST JOB_RETRY JOB_UPDATE_OBJECTIONS LINKEDIN_CONTEXT
// LOG_DEBUG MULTITAB_START OBJECTION_REFRESH RETRY_JOB REVERIFY_CARD
// RUN_WEEKLY_REFRESH SAVE_REPORT SAVE_USER_SETTINGS SET_API_KEY SHARE_SLACK
// START_MONITOR_ALARM STOP_MONITOR_ALARM TRACK_EVENT TRIAGE_SUMMARY
// TRIGGER_CHECK TRIGGER_DISMISS TRIGGER_OPEN_CARD VERIFY_LICENSE
// WIN_LOSS_SUBMIT WORKFLOW_CLEAR WORKFLOW_GET_STATE WORKFLOW_SAVE_STEPS
// WORKFLOW_SET_RECORDING WORKFLOW_SYNC_STEPS
import {
  createJob,
  getJobs,
  saveJobs,
  getJob,
  updateJob,
  requestCancel,
  estimateTokens,
  JOBS_KEY,
  MAX_JOBS,
  HEARTBEAT_ALARM,
  JobStatus,
  JobType
} from './jobs.js';
import { LIVENESS_MS, createLiveness, badgeForStatus } from './liveness.js';
import { decideBanner as triggerDecideBanner } from './trigger-core.js';
import { Analytics } from './events.js';
import { Triage } from './triage.js';
import { classifyTabs } from './multitab.js';
import {
  mineTechHints,
  buildProspectPrompt,
  buildDealRoomPrompt,
  parseDealRoomJson,
  validateBrief,
  renderDealRoomMarkdown,
} from './dealroom.js';
import { getProfile } from './profile.js';
import {
  discoverDocsUrls,
  candidateDocUrls,
  buildObjectionPrompt,
  parseObjections,
  markVerified,
  crossReference,
  renderObjectionsMarkdown,
  splitObjectionsBlock,
  MAX_DOC_PAGES,
} from './objection-lib.js';
import { getWinLoss, addWinLoss, getStats, buildWinLossPromptLine } from './winloss.js';
import {
  buildSlackBlocks,
  buildSlackMrkdwn,
  buildCrmNote,
  normalizeShareInput,
} from './share.js';
import { extractFacts } from './data-provider.js';
import {
  MONITOR_STATE_KEY,
  WEEKLY_REFRESH_ALARM,
  WEEKLY_PERIOD_MIN,
  BATCH_SIZE,
  getMonitorState,
  saveMonitorState,
  pickBatch,
  diffFacts,
  changeBadgeText,
  defaultMonitorState,
} from './monitor-v0.js';
import {
  createAutoTaskRunner,
  APPROVAL_ALARM as AUTO_TASK_APPROVAL_ALARM,
} from './autotask.js';
import { initSidePanel } from './side-panel.js';
import {
  CONTEXT_KEY, DISMISSED_KEY, sanitizeLinkedInContext,
} from './linkedin.js';
import { DEFAULT_BLOCKED_DOMAINS, AUTO_TASK_CALL_MULTIPLIER, mergeBlocklist } from './safety.js';

// Phase 8-closer: funnel analytics (storage-backed, no network).
// chrome.storage.local satisfies the {get,set} interface directly.
const analytics = new Analytics({ storage: chrome.storage.local });
// Phase 9: failure triage — capture {feature, signature, error, urls, tokensUsed}.
const triage = new Triage({ storage: chrome.storage.local });

const DEFAULT_USER_SETTINGS = {
  isPro: false,
  apiKey: '',
  model: 'openai/gpt-oss-20b',
  dailyCallsUsed: 0,
  lastResetDate: '',
  webhookUrl: '',
  slackWebhookUrl: '',
  ownProductUrl: ''
};

const DEFAULT_WORKFLOW_STATE = {
  recording: false,
  recordedSteps: [],
  status: 'No workflow recorded.',
  tabId: null
};

const DEFAULT_QUOTA_STATE = {
  day: '',
  count: 0,
  minuteWindowStart: 0,
  minuteCount: 0
};

const MAX_CALLS_PER_MINUTE = 25;
const AUTOFILL_MAX_WAIT_MS = 30000;
const DEBUG_LOG_LIMIT = 200;

let userSettings = { ...DEFAULT_USER_SETTINGS };
let quotaState = { ...DEFAULT_QUOTA_STATE };
let sessionApiKey = '';
const autofillJobs = new Map();

// ---------- port + heartbeat (Phase 5 orchestration) ----------
const uiPorts = new Set();
let heartbeatActive = false;

function broadcast(msg) {
  for (const p of uiPorts) {
    try { p.postMessage(msg); } catch (e) {}
  }
}

async function updateJobAndBroadcast(jobId, patch) {
  const updated = await updateJob(jobId, patch);
  if (updated) broadcast({ type: 'JOB_UPDATE', job: updated });
  // Phase 7: badge alerts need no `notifications` permission (see PERMISSIONS.md).
  if (patch.status === JobStatus.DONE || patch.status === JobStatus.FAILED) {
    setJobBadge(patch.status);
    // Phase 8-closer: funnel — first/second-week card conversion per feature.
    try {
      if (patch.status === JobStatus.DONE) await analytics.trackCardDone(updated?.type);
      else await analytics.trackCardFailed(updated?.type);
    } catch (e) {}
    // Phase 9: triage — capture every failure with a signature.
    if (patch.status === JobStatus.FAILED) {
      try {
        await triage.capture({
          feature: updated?.type || 'unknown',
          error: patch.error || updated?.error || 'unknown',
          urls: updated?.failedUrls || updated?.payload?.urls || [],
          tokensUsed: updated?.tokensUsed,
        });
      } catch (e) {}
    }
  } else if (patch.status === JobStatus.CANCELED) {
    setJobBadge(null);
  }
  return updated;
}

// Phase 7 notifications audit: no code calls chrome.notifications.*
// (monitor.js renders into #monitorResult in-popup). Job completion surfaces
// via toolbar badge instead — chrome.action needs no permission.
// Monitoring v0: a persistent pricing-change alert (⚡) outranks transient
// done/clear badges; a fresh FAILED still wins (most urgent).
async function setJobBadge(status) {
  try {
    if (!chrome.action?.setBadgeText) return;
    const key = status === JobStatus.DONE ? 'done' : status === JobStatus.FAILED ? 'failed' : 'clear';
    if (key !== 'failed') {
      try {
        const ms = await getMonitorState(chrome.storage.local);
        const pending = Object.values(ms.competitors || {}).filter((s) => (s?.changesDetected || 0) > 0).length;
        if (pending > 0) {
          if (chrome.action.setBadgeBackgroundColor) {
            await chrome.action.setBadgeBackgroundColor({ color: '#ffc164' });
          }
          await chrome.action.setBadgeText({ text: '⚡' });
          return;
        }
      } catch (e) {}
    }
    // Map JobStatus -> badge via shared helper (tested in qa/test-liveness.mjs).
    const { text, color } = badgeForStatus(key);
    if (color && chrome.action.setBadgeBackgroundColor) {
      await chrome.action.setBadgeBackgroundColor({ color });
    }
    await chrome.action.setBadgeText({ text });
  } catch (e) {}
}

async function setJobProgressAndBroadcast(jobId, step, percent, extra = {}) {
  const patch = { progress: { step: String(step || ''), percent: Math.max(0, Math.min(100, Number(percent) || 0)) } };
  if (extra.tokensUsed != null) patch.tokensUsed = extra.tokensUsed;
  if (extra.partialResult !== undefined) patch.partialResult = extra.partialResult;
  if (extra.successSummary !== undefined) patch.successSummary = extra.successSummary;
  return updateJobAndBroadcast(jobId, patch);
}

function startHeartbeat(jobId = null) {
  if (jobId) startLiveness(jobId);
  if (heartbeatActive) return;
  heartbeatActive = true;
  try {
    // Requested 25s; Chrome clamps alarms to >=30s (dev) and longer in
    // release builds — see Phase 7 storage-liveness fallback below, which
    // is the primary keepalive. The alarm remains as backup.
    chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 25 / 60 });
  } catch (e) {
    // fallback to 1 minute if Chrome clamps
    try { chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 }); } catch (e2) {}
  }
}

function stopHeartbeat() {
  if (!heartbeatActive) return;
  heartbeatActive = false;
  try { chrome.alarms.clear(HEARTBEAT_ALARM); } catch (e) {}
  stopLiveness();
}

async function refreshHeartbeat() {
  try {
    const jobs = await getJobs();
    const running = jobs.filter(j => j.status === JobStatus.RUNNING);
    if (running.length) startHeartbeat(running[0].id);
    else stopHeartbeat();
  } catch (e) {}
}

// ---------- Phase 7: storage-write liveness fallback (see ./liveness.js) ----------
// Chrome clamps chrome.alarms (25s request may fire at 60s+), risking SW
// death mid-job with the popup closed. While a job runs we write alternating
// liveness keys every ~20s — each chrome.storage.local.set() is API activity
// that resets the SW idle timer (the writes themselves are the keepalive).
// Alternating keys keep every write a value change, observable by other
// contexts (popup). The alarm remains as backup.
const __liveness = createLiveness({
  storage: {
    set: (obj) => chrome.storage.local.set(obj),
    remove: (keys) => chrome.storage.local.remove(keys),
  },
  intervalMs: LIVENESS_MS,
});

function startLiveness(jobId) {
  __liveness.start(jobId);
}

function stopLiveness() {
  __liveness.stop();
}

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    // No-op observer: Chrome does not fire onChanged in the writing context,
    // so this never sees our own liveness writes — the set() calls themselves
    // are the keepalive. Kept so the popup (other context) and future
    // cross-context signals share one listener. Intentionally no-op.
    if (changes.jobLivenessA || changes.jobLivenessB) { /* keepalive */ }
  });
} catch (e) {}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'atom.ui') return;
  uiPorts.add(port);
  // User opened the popup — alerts seen, clear badge.
  setJobBadge(null);
  // push snapshot on connect
  getJobs().then(jobs => {
    try { port.postMessage({ type: 'JOBS_SNAPSHOT', jobs }); } catch (e) {}
  }).catch(() => {});
  port.onDisconnect.addListener(() => {
    uiPorts.delete(port);
  });
  port.onMessage.addListener(async (msg) => {
    // optional: handle popup ping
    if (msg?.type === 'PING') {
      try { port.postMessage({ type: 'PONG' }); } catch (e) {}
    }
    if (msg?.type === 'GET_JOBS') {
      const jobs = await getJobs();
      try { port.postMessage({ type: 'JOBS_SNAPSHOT', jobs }); } catch (e) {}
    }
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) {
    // Backup keepalive (primary is storage liveness). One alternating write
    // so each alarm extends SW lifetime even when clamped to 60s+.
    try { __liveness.poke().catch(() => {}); } catch (e) {}
  }
  if (alarm.name === WEEKLY_REFRESH_ALARM) {
    // Monitoring v0: batched weekly refresh (BYOK quota, max 3 per run).
    runWeeklyRefresh().catch(() => {});
  }
  if (alarm.name === AUTO_TASK_APPROVAL_ALARM) {
    // Auto Task: a pending confirm-action approval hit its 60s timeout → deny.
    autoTask.checkApprovals().catch(() => {});
  }
  // existing monitor alarms pass through - handled below
});

// ---------- helpers ----------
async function hydrateState() {
  try {
    const data = await chrome.storage.local.get(['userSettings', 'quotaState']);
    if (data.userSettings) userSettings = { ...DEFAULT_USER_SETTINGS, ...data.userSettings };
    if (data.quotaState) quotaState = { ...DEFAULT_QUOTA_STATE, ...data.quotaState };
    sessionApiKey = userSettings.apiKey || '';
  } catch (e) {}
}

async function persistUserSettings() {
  await chrome.storage.local.set({ userSettings });
}

async function persistQuotaState() {
  await chrome.storage.local.set({ quotaState });
}

function normalizeDateKey() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
}

function isProActive() {
  const rawFlag = !!userSettings.isPro;
  const licenseStatus = String(userSettings.licenseStatus || '').toLowerCase();
  const expiresAt = Number(userSettings.licenseExpiresAt || 0);
  const notExpired = !expiresAt || Date.now() < expiresAt;
  if (licenseStatus === 'active' && notExpired) return true;
  if (rawFlag && notExpired && !userSettings.licenseKey) return true;
  return false;
}

async function appendDebugLog(entry = {}) {
  try {
    const data = await chrome.storage.local.get(['debugLog']);
    const list = Array.isArray(data.debugLog) ? data.debugLog : [];
    list.unshift({
      ts: new Date().toISOString(),
      scope: entry.scope || 'general',
      level: entry.level || 'error',
      message: String(entry.message || ''),
      detail: entry.detail || null
    });
    if (list.length > DEBUG_LOG_LIMIT) list.length = DEBUG_LOG_LIMIT;
    await chrome.storage.local.set({ debugLog: list });
  } catch (e) {}
}

async function enforceQuotaAndIncrement() {
  const now = Date.now();
  const today = normalizeDateKey();

  if (quotaState.day !== today) {
    quotaState.day = today;
    quotaState.count = 0;
    quotaState.minuteWindowStart = now;
    quotaState.minuteCount = 0;
  }

  if (!quotaState.minuteWindowStart || now - quotaState.minuteWindowStart > 60000) {
    quotaState.minuteWindowStart = now;
    quotaState.minuteCount = 0;
  }

  if (quotaState.minuteCount >= MAX_CALLS_PER_MINUTE) {
    return {
      allowed: false,
      reason: 'Too many requests in a short time. Please wait a minute and try again.'
    };
  }

  quotaState.minuteCount += 1;
  quotaState.count += 1;
  userSettings.dailyCallsUsed = quotaState.count;
  userSettings.lastResetDate = new Date().toDateString();

  await Promise.all([persistQuotaState(), persistUserSettings()]);
  return { allowed: true };
}

const ai = new AI({
  getApiKey: () => userSettings.apiKey,
  getModel: () => userSettings.model,
  onCall: async () => await enforceQuotaAndIncrement()
});

// Auto Task metering: one run reserves AUTO_TASK_CALL_MULTIPLIER AI-call
// equivalents in the SAME counter that enforces quota (quotaState.count, mirrored
// to userSettings.dailyCallsUsed) — so the number the popup displays is the number
// that actually gates usage, not a separate display-only key.
// The per-minute rate window is deliberately NOT charged: a 25-unit reservation
// would otherwise trip MAX_CALLS_PER_MINUTE and lock the run out of its own calls.
async function chargeAutoTaskQuota(units = AUTO_TASK_CALL_MULTIPLIER) {
  const today = normalizeDateKey();
  if (quotaState.day !== today) {
    quotaState.day = today;
    quotaState.count = 0;
    quotaState.minuteWindowStart = Date.now();
    quotaState.minuteCount = 0;
  }
  const amount = Math.max(0, Math.floor(Number(units) || 0));
  quotaState.count += amount;
  userSettings.dailyCallsUsed = quotaState.count;
  userSettings.lastResetDate = new Date().toDateString();
  await Promise.all([persistQuotaState(), persistUserSettings()]);
  return { used: quotaState.count, charged: amount };
}

// Auto Task runner (Phase 4 repair): the agent loop lives HERE in the service
// worker, not the popup, so a run survives the popup closing. Progress + state
// are persisted to chrome.storage.local under AUTO_TASK_RUN_KEY after every
// step; the popup renders them via storage.onChanged.
async function getAutoTaskBlockedDomains() {
  try {
    const data = await chrome.storage.local.get(['autoTaskBlockedDomains']);
    return mergeBlocklist(data.autoTaskBlockedDomains, DEFAULT_BLOCKED_DOMAINS);
  } catch (e) {
    return mergeBlocklist([], DEFAULT_BLOCKED_DOMAINS);
  }
}

const autoTask = createAutoTaskRunner({
  ai,
  storage: chrome.storage.local,
  tabs: chrome.tabs,
  scripting: chrome.scripting,
  capture: (tabId, opts) => chrome.tabs.captureVisibleTab(undefined, opts),
  keepalive: {
    start: (id) => startLiveness(id),
    stop: () => stopLiveness(),
    poke: () => { try { __liveness.poke().catch(() => {}); } catch (e) {} },
  },
  alarms: chrome.alarms,
  getBlockedDomains: getAutoTaskBlockedDomains,
  meter: chargeAutoTaskQuota,
});

function sanitizeUserSettings(input = {}) {
  const next = { ...userSettings };
  if (typeof input.isPro === 'boolean') next.isPro = input.isPro;
  if (typeof input.licenseStatus === 'string') next.licenseStatus = input.licenseStatus;
  if (typeof input.licenseKey === 'string') next.licenseKey = input.licenseKey;
  if (typeof input.licenseExpiresAt === 'number') next.licenseExpiresAt = input.licenseExpiresAt;
  if (typeof input.apiKey === 'string') next.apiKey = input.apiKey.trim();
  if (typeof input.model === 'string') {
        const supportedModels = ["openai/gpt-oss-20b", "openai/gpt-oss-120b"];
        const defaultModel = "openai/gpt-oss-20b";
        if (!input.model || typeof input.model !== "string") {
            next.model = defaultModel;
        } else if (supportedModels.includes(input.model)) {
            next.model = input.model;
        } else if (input.model === "llama3-8b-8192") {
            next.model = defaultModel;
        } else {
            next.model = defaultModel;
        }
    }
  if (typeof input.webhookUrl === 'string') next.webhookUrl = input.webhookUrl;
  if (typeof input.slackWebhookUrl === 'string') next.slackWebhookUrl = input.slackWebhookUrl.trim();
  if (typeof input.ownProductUrl === 'string') next.ownProductUrl = input.ownProductUrl.trim();
  return next;
}

function isTrustedSender(sender) {
  return !sender || sender.id === chrome.runtime.id;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeInTab(tabId, func, args = []) {
  const out = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args
  });
  return out?.[0]?.result;
}

async function waitForTabComplete(tabId, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.status === "complete") return true;
    } catch (e) {
      return false;
    }
    await sleep(200);
  }
  return false;
}

// worker-side utils (duplicated from utils.js but SW-compatible)
function workerNormalizeDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./i, ''); } catch { return 'unknown'; }
}
function workerSafeTabLabel(tab) {
  if (!tab) return 'Unknown tab';
  return (tab.title || workerNormalizeDomain(tab.url) || 'Untitled tab').trim();
}
function workerIsInjectableTab(tab) {
  if (!tab?.url) return false;
  const bad = ['chrome://', 'chrome-extension://', 'about:', 'edge://', 'brave://', 'devtools://', 'view-source:'];
  return !bad.some(prefix => tab.url.startsWith(prefix));
}
function workerIsReadableHttpUrl(url) {
  return /^https?:\/\//i.test(url || '');
}
async function workerWait(ms) { return sleep(ms); }
async function workerWaitForTab(tabId, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return true;
    } catch { return false; }
    await sleep(500);
  }
  return false;
}
async function workerGetPageText(tabId, maxLength = 6000) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: (maxLen) => {
        const cleanClone = document.body?.cloneNode(true);
        if (cleanClone) cleanClone.querySelectorAll('script,style,noscript,template').forEach(el => el.remove());
        const candidates = [
          document.querySelector('article'),
          document.querySelector('main'),
          document.querySelector('[role="main"]'),
          document.querySelector('.main'),
          cleanClone,
          document.body
        ].filter(Boolean);
        const best = candidates.sort((a,b)=>(b.innerText||'').length-(a.innerText||'').length)[0] || document.body;
        const text = [document.title||'', best?.innerText||document.body?.innerText||''].join('\n\n');
        return String(text||'').replace(/\s+/g,' ').trim().substring(0,maxLen);
      },
      args: [maxLength]
    });
    return res?.[0]?.result || '';
  } catch (e) { return ''; }
}
// Harvest same-page anchor hrefs from an open tab. The `__LINKS__` marker lets
// Node tests distinguish this call from page-text extraction in the mock.
async function workerHarvestLinks(tabId, maxLinks = 60) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // __LINKS__
        const out = [];
        const seen = new Set();
        document.querySelectorAll('a[href]').forEach((a) => {
          try {
            const href = new URL(a.getAttribute('href'), location.href).href.split('#')[0];
            if (!/^https?:\/\//i.test(href)) return;
            const key = href.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            out.push(href);
          } catch {}
        });
        return out.slice(0, 60);
      },
      args: []
    });
    const links = res?.[0]?.result;
    return Array.isArray(links) ? links.slice(0, maxLinks) : [];
  } catch (e) { return []; }
}

// Open a URL in a hidden tab, harvest its links AND read its text, then close.
// Returns {text, links} — one tab open per URL instead of two.
async function workerOpenHarvestAndRead(url, options = {}) {
  const { maxLength = 5000, waitMs = 9000 } = options;
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url, active: false });
    await workerWaitForTab(tab.id, waitMs);
    await sleep(700);
    const [source, links] = await Promise.all([
      workerReadTabSource(tab, { maxLength, waitMs: 2000 }),
      workerHarvestLinks(tab.id),
    ]);
    source.url = url;
    source.domain = workerNormalizeDomain(url);
    return { source, links };
  } catch (error) {
    return {
      source: {
        tabId: tab?.id || null,
        title: workerSafeTabLabel(tab),
        url,
        domain: workerNormalizeDomain(url),
        text: '',
        ok: false,
        error: error?.message || 'Failed to open URL.'
      },
      links: [],
    };
  } finally {
    if (tab?.id) { try { await chrome.tabs.remove(tab.id); } catch (e) {} }
  }
}

// Objection extraction for one competitor domain: homepage → discover
// /docs /faq /compare pages → fetch (cap) + news → one strict-schema call
// (2000 tokens) → verify + cross-reference against YOUR proof points.
// Never throws for content reasons (returns {items: [], pagesRead} instead);
// throws only on cancel so the caller can abort the parent job.
async function runObjectionExtraction(domain, { jobId, tokensRef, maxPages = MAX_DOC_PAGES } = {}) {
  const d = String(domain || '').replace(/^www\./i, '').toLowerCase();
  if (!d) return { items: [], pagesRead: [] };
  const pagesRead = [];
  const readOne = async (url) => {
    if (jobId && await isJobCanceled(jobId)) {
      const err = new Error('Task canceled.');
      err.canceled = true;
      throw err;
    }
    const { source } = await workerOpenAndReadUrl(url, { active: false, maxLength: 5000, waitMs: 9000 });
    if (source.ok && source.text) {
      pagesRead.push(url);
      return { url, text: source.text };
    }
    return null;
  };

  // 1. homepage: text + harvested links → discover doc pages
  const home = await workerOpenHarvestAndRead(`https://${d}/`, { maxLength: 5000, waitMs: 9000 });
  let discovered = discoverDocsUrls(d, home.links || []);
  if (!discovered.length) {
    // fall back to canonical guesses, keep only the reachable ones later
    discovered = candidateDocUrls(d);
  }
  const pages = [];
  if (home.source.ok && home.source.text) {
    pages.push({ url: `https://${d}/`, text: home.source.text });
    pagesRead.push(`https://${d}/`);
  }
  // 2. fetch doc pages (cap), skipping the homepage itself
  for (const url of discovered.slice(0, maxPages)) {
    if (String(url).replace(/\/$/, '') === `https://${d}`) continue;
    if (pages.length - 1 >= maxPages) break;
    const page = await readOne(url).catch((e) => { if (e?.canceled) throw e; return null; });
    if (page) pages.push(page);
  }
  if (!pages.length) return { items: [], pagesRead };

  // 3. news context (best-effort, never fatal)
  let news = '';
  try { news = await workerGoogleResearch(`${d} vs competitors objections complaints 2026`); } catch {}

  // 4. one strict-schema extraction call (2000 tokens)
  const profile = getProfile(userSettings);
  const pagesText = pages.map((p) => `SOURCE URL: ${p.url}\n${p.text.substring(0, 3000)}`).join('\n\n---\n\n')
    + (news ? `\n\n---\n\nNEWS:\n${news.substring(0, 1500)}` : '');
  const prompt = buildObjectionPrompt({ domain: d, pagesText, profile });
  let raw = '';
  try {
    raw = await ai.chat(prompt, 2000);
    if (tokensRef) tokensRef.value += estimateTokens(prompt) + estimateTokens(raw);
  } catch (e) {
    if (tokensRef) tokensRef.value += estimateTokens(prompt);
    return { items: [], pagesRead };
  }

  // 5. parse → verify (docs vs inferred) → cross-reference proof points
  let parsed;
  try {
    parsed = parseObjections(raw);
  } catch {
    return { items: [], pagesRead };
  }
  const items = crossReference(markVerified(parsed, d), profile)
    .filter((o) => o && typeof o.objection === 'string' && o.objection.trim() && typeof o.counterArgument === 'string' && o.counterArgument.trim())
    .map((o) => ({
      objection: String(o.objection).trim().substring(0, 220),
      theirClaim: String(o.theirClaim || '').trim().substring(0, 220),
      counterArgument: String(o.counterArgument).trim().substring(0, 220),
      sourceUrl: String(o.sourceUrl || ''),
      quote: String(o.quote || '').trim().substring(0, 200),
      confidence: ['high', 'medium', 'low'].includes(o.confidence) ? o.confidence : 'medium',
      verification: o.verification === 'verified' ? 'verified' : 'inferred',
      proofRef: o.proofRef || null,
      needsInput: !!o.needsInput,
    }));
  return { items, pagesRead };
}

async function workerGetReadableTabs(options = {}) {
  const { currentWindow=true, maxTabs=5, excludeTabId=null, includeActive=true } = options;
  const tabs = await chrome.tabs.query(currentWindow ? { currentWindow:true } : {});
  const seenUrls = new Set();
  const filtered = tabs.filter(tab => {
    if (!tab?.id || tab.id === excludeTabId) return false;
    if (!includeActive && tab.active) return false;
    if (!workerIsInjectableTab(tab) || !workerIsReadableHttpUrl(tab.url)) return false;
    const normalized = (tab.url||'').split('#')[0];
    if (seenUrls.has(normalized)) return false;
    seenUrls.add(normalized);
    return true;
  });
  filtered.sort((a,b)=> Number(Boolean(b.active))-Number(Boolean(a.active)));
  return filtered.slice(0, maxTabs);
}
async function workerReadTabSource(tab, options = {}) {
  const { maxLength=1800, waitMs=8000 } = options;
  const source = {
    tabId: tab?.id || null,
    title: workerSafeTabLabel(tab),
    url: tab?.url || '',
    domain: workerNormalizeDomain(tab?.url),
    text: '',
    ok: false,
    error: ''
  };
  if (!tab?.id || !workerIsInjectableTab(tab) || !workerIsReadableHttpUrl(tab.url)) {
    source.error = 'Tab is not readable.';
    return source;
  }
  try {
    await workerWaitForTab(tab.id, waitMs);
    await sleep(500);
    const text = await workerGetPageText(tab.id, maxLength);
    if (!text || text.length < 80) {
      source.error = 'Not enough readable text on the page.';
      return source;
    }
    source.text = text;
    source.ok = true;
    return source;
  } catch (error) {
    source.error = error?.message || 'Failed to read tab.';
    return source;
  }
}
async function workerOpenAndReadUrl(url, options = {}) {
  const { active=false, maxLength=3000, waitMs=9000 } = options;
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url, active });
    await workerWaitForTab(tab.id, waitMs);
    await sleep(700);
    const source = await workerReadTabSource(tab, { maxLength, waitMs: 2000 });
    source.url = url;
    source.domain = workerNormalizeDomain(url);
    return source;
  } catch (error) {
    return {
      tabId: tab?.id || null,
      title: workerSafeTabLabel(tab),
      url,
      domain: workerNormalizeDomain(url),
      text: '',
      ok: false,
      error: error?.message || 'Failed to open URL.'
    };
  } finally {
    if (tab?.id) { try { await chrome.tabs.remove(tab.id); } catch (e) {} }
  }
}
async function workerGoogleResearch(query) {
  try {
    const url = 'https://www.google.com/search?q=' + encodeURIComponent(query);
    const source = await workerOpenAndReadUrl(url, { active:false, maxLength:5000, waitMs:7000 });
    return source.text || '';
  } catch { return ''; }
}
async function isJobCanceled(jobId) {
  try {
    const j = await getJob(jobId);
    return !!j?.cancelRequested;
  } catch { return false; }
}
async function hasHostPermissionSW() {
  try { return await chrome.permissions.contains({ origins: ["https://*/*", "http://*/*"] }); } catch { return true; }
}
function buildFallbackBattleTable(structuredData) {
  const header = '| Company | Pricing | Key Features | Target Audience | Recent News |';
  const sep = '|---|---|---|---|---|';
  const rows = structuredData.map(d => {
    const company = d.domain || (()=>{try{return new URL(d.url).hostname;}catch{return d.url;}})();
    const esc = (s)=> String(s||'N/A').replace(/\|/g,'/').replace(/\n/g,' ').slice(0,180);
    return `| ${esc(company)} | ${esc(d.pricing)} | ${esc(d.features)} | ${esc(d.targetAudience)} | ${esc(d.recentNews)} |`;
  });
  return [header, sep, ...rows].join('\n');
}
async function workerCollectStructuredPageData(url, jobTokensRef) {
  // returns structured object and increments tokens via jobTokensRef {value: number}
  try {
    const source = await workerOpenAndReadUrl(url, { active:false, maxLength:5000, waitMs:9000 });
    if (!source.ok || !source.text) {
      return {
        url,
        domain: workerNormalizeDomain(url),
        pricing: 'N/A',
        features: 'N/A',
        targetAudience: 'N/A',
        recentNews: 'N/A',
        error: source.error || 'Failed to extract data'
      };
    }
    const domain = source.domain;
    const news = await workerGoogleResearch(`${domain} recent news 2026`);
    const combinedData = `PAGE CONTENT:\n${source.text}\n\nRECENT NEWS:\n${news.substring(0,1500)}`;
    const prompt = `Extract the following structured information from the data below. Return ONLY a JSON object with these exact keys:\n- pricing: pricing information (plans, tiers, costs)\n- features: key features and capabilities\n- targetAudience: who this product/service is for\n- recentNews: recent news or updates\n\nDATA:\n${combinedData.substring(0,8000)}`;
    let aiResponse = '';
    try {
      aiResponse = await ai.chat(prompt, 800);
      if (jobTokensRef) jobTokensRef.value += estimateTokens(prompt) + estimateTokens(aiResponse);
    } catch (e) {
      // still return N/A but propagate token if possible
      if (jobTokensRef && prompt) jobTokensRef.value += estimateTokens(prompt);
      throw e;
    }
    let structured;
    try {
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) structured = JSON.parse(jsonMatch[0]);
      else structured = {
        pricing: aiResponse.substring(0,200)||'N/A',
        features: aiResponse.substring(200,600)||'N/A',
        targetAudience: aiResponse.substring(600,800)||'N/A',
        recentNews: news.substring(0,300)||'N/A'
      };
    } catch {
      structured = {
        pricing: 'Could not extract',
        features: 'Could not extract',
        targetAudience: 'Could not extract',
        recentNews: news.substring(0,300)||'N/A'
      };
    }
    return {
      url,
      domain: source.domain,
      pricing: structured.pricing || 'N/A',
      features: structured.features || 'N/A',
      targetAudience: structured.targetAudience || 'N/A',
      recentNews: structured.recentNews || news.substring(0,300)||'N/A'
    };
  } catch (error) {
    return {
      url,
      domain: workerNormalizeDomain(url),
      pricing: 'N/A',
      features: 'N/A',
      targetAudience: 'N/A',
      recentNews: 'N/A',
      error: error?.message || 'Failed to collect data'
    };
  }
}
async function saveToHistoryWorker(topic, report, type, tokensUsed=0) {
  try {
    const data = await chrome.storage.local.get(['researchHistory']);
    const history = Array.isArray(data.researchHistory) ? data.researchHistory : [];
    const entryId = Date.now() + Math.floor(Math.random()*1000);
    history.unshift({
      id: entryId,
      topic: String(topic || 'Research'),
      report: String(report || ''),
      type: String(type || 'compare'),
      savedAt: new Date().toLocaleString(),
      url: '',
      preview: String(report||'').replace(/[=\n]/g,' ').substring(0,120),
      date: Date.now(),
      tokensUsed: tokensUsed || 0
    });
    if (history.length > 100) history.length = 100;
    // bounded storage (reuse existing logic simpler: just set, if quota error trim)
    try {
      await chrome.storage.local.set({ researchHistory: history });
    } catch (e) {
      // quota fallback: trim to 50 and retry
      const trimmed = history.slice(0,50);
      await chrome.storage.local.set({ researchHistory: trimmed });
    }
    // webhook sync if configured
    if (userSettings.webhookUrl && String(userSettings.webhookUrl).startsWith('http')) {
      try {
        await fetch(userSettings.webhookUrl, {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ topic, report, type, source:'atom.ai', timestamp:new Date().toISOString() })
        });
      } catch (e) {}
    }
    return entryId;
  } catch (e) {}
  return null;
}

// Update an existing history entry in place (refresh/edit flows). Falls back
// to appending a fresh entry when the id is unknown (returns new id or null).
async function updateHistoryEntry(historyId, report) {
  try {
    const data = await chrome.storage.local.get(['researchHistory']);
    const history = Array.isArray(data.researchHistory) ? data.researchHistory : [];
    const idx = history.findIndex(h => h && h.id === historyId);
    if (idx === -1) return null;
    history[idx] = {
      ...history[idx],
      report: String(report || ''),
      preview: String(report || '').replace(/[=\n]/g, ' ').substring(0, 120),
      savedAt: new Date().toLocaleString(),
    };
    await chrome.storage.local.set({ researchHistory: history });
    return historyId;
  } catch (e) {
    return null;
  }
}

// ---------- Phase 3/4 pipelines moved into worker ----------

async function runBattleCardJob(jobId) {
  let job = await getJob(jobId);
  if (!job) return;
  // Phase 6: optional host permissions — fail fast with actionable message if not granted
  if (!await hasHostPermissionSW()) {
    await updateJobAndBroadcast(jobId, {
      status: JobStatus.FAILED,
      error: 'Host permission not granted. Open the popup and click “Grant host access” to allow crawling competitor sites.',
      progress:{step:'Failed — host permission required', percent:100},
      successSummary: 'No pages crawled — host permission was not granted. Grant access and retry.',
      failedUrls: Array.isArray(job.payload?.urls) ? job.payload.urls : []
    });
    await refreshHeartbeat();
    return;
  }
  const urls = Array.isArray(job.payload?.urls) ? job.payload.urls.filter(Boolean).slice(0,5) : [];
  if (!urls.length) {
    await updateJobAndBroadcast(jobId, { status: JobStatus.FAILED, error: 'No competitor URLs provided.', progress:{step:'Failed', percent:100} });
    await refreshHeartbeat();
    return;
  }
  const jobTokensRef = { value: Number(job.tokensUsed || 0) };
  const structuredData = [];
  const succeeded = [];
  const failed = [];
  try {
    await setJobProgressAndBroadcast(jobId, `Preparing battle card for ${urls.length} competitor(s)…`, 5, { tokensUsed: jobTokensRef.value });
    for (let i=0;i<urls.length;i++) {
      if (await isJobCanceled(jobId)) {
        await updateJobAndBroadcast(jobId, { status: JobStatus.CANCELED, progress:{step:'Canceled', percent:100} });
        broadcast({ type:'JOB_CANCELED', jobId });
        await refreshHeartbeat();
        return;
      }
      const url = urls[i];
      const domain = (()=>{ try{return new URL(url).hostname.replace(/^www\./i,'');}catch{return `tab ${i+1}`;}})();
      const pct = Math.round(((i)/urls.length)*80) + 5;
      await setJobProgressAndBroadcast(jobId, `Processing ${i+1}/${urls.length}: ${domain} — extracting data…`, pct, { tokensUsed: jobTokensRef.value });
      let data = null;
      try {
        data = await workerCollectStructuredPageData(url, jobTokensRef);
      } catch (e) {
        data = { url, domain: workerNormalizeDomain(url), pricing:'N/A', features:'N/A', targetAudience:'N/A', recentNews:'N/A', error: e.message||'extraction failed' };
      }
      // consider failed if error and all N/A
      const isFailed = !!(data.error && data.pricing==='N/A' && data.features==='N/A');
      if (isFailed) failed.push(url);
      else succeeded.push(url);
      structuredData.push(data);
      await updateJobAndBroadcast(jobId, { tokensUsed: jobTokensRef.value });
      // push intermediate progress so popup shows live
      await setJobProgressAndBroadcast(jobId, `Processed ${i+1}/${urls.length}: ${domain}`, Math.round(((i+1)/urls.length)*80), { tokensUsed: jobTokensRef.value });
    }
    if (await isJobCanceled(jobId)) {
      await updateJobAndBroadcast(jobId, { status: JobStatus.CANCELED, progress:{step:'Canceled', percent:100} });
      await refreshHeartbeat();
      return;
    }
    // Add win/loss history to each competitor's data for the prompt
    const allWinLoss = await getWinLoss(chrome.storage.local);
    const teamHistoryLines = [];
    for (const data of structuredData) {
      const domain = data.domain || (()=>{try{return new URL(data.url).hostname.replace(/^www\./i,'');}catch{return '';}})();
      if (domain) {
        const wl = allWinLoss.filter((r) => r.competitor === domain.toLowerCase());
        const stats = getStats(wl);
        data.winLoss = { won: stats.won, lost: stats.lost, total: stats.total, recent: wl.slice(0, 3).map(r => ({ outcome: r.outcome, why: r.why, date: r.date })) };
        const line = buildWinLossPromptLine(domain, allWinLoss);
        if (line) teamHistoryLines.push(line);
      }
    }

    await setJobProgressAndBroadcast(jobId, 'Generating comparison table…', 92, { tokensUsed: jobTokensRef.value });
    const teamHistorySection = teamHistoryLines.length
      ? `\nTEAM HISTORY (your past deals — this makes the card personal):\n${teamHistoryLines.join('\n')}\n`
      : '';
    const prompt = `Create a markdown comparison table for these competitors using the structured data below.\nColumns: Company | Pricing | Key Features | Target Audience | Recent News | Win/Loss Record\n- Use the company/domain name for Company\n- Keep each cell concise and decision-useful\n- Return ONLY the markdown table, no extra text\n- Win/Loss Record column: show "W-L" record and key reasons from history\n${teamHistorySection}\nDATA:\n${JSON.stringify(structuredData, null, 2)}`;
    let table = '';
    try {
      table = await ai.chat(prompt, 1400);
      jobTokensRef.value += estimateTokens(prompt) + estimateTokens(table);
    } catch (e) {
      // failure UX: keep partial results + what succeeded summary
      const fallback = buildFallbackBattleTable(structuredData);
      const summary = `What succeeded: ${succeeded.length}/${urls.length} competitors extracted. Failed: ${failed.length? failed.join(', '): 'AI synthesis failed'} — partial table preserved. Error: ${e.message}`;
      await saveToHistoryWorker('Competitor Battle Card (partial)', fallback, 'compare', jobTokensRef.value);
      await updateJobAndBroadcast(jobId, {
        status: JobStatus.FAILED,
        error: e.message || 'AI synthesis failed',
        progress:{step:'Failed - partial saved', percent:100},
        tokensUsed: jobTokensRef.value,
        resultRef: fallback,
        partialResult: fallback,
        successSummary: summary,
        failedUrls: failed.length? failed : urls
      });
      await refreshHeartbeat();
      return;
    }
    // success: even if some competitors failed, we have a table
    let successSummary = null;
    let partialResult = null;
    if (failed.length) {
      successSummary = `What succeeded: ${succeeded.length}/${urls.length} competitors. Failed URLs: ${failed.join(', ')} — table includes N/A for failures.`;
      partialResult = table; // table still usable but mark partial
    }
    // Objection library: deep extraction for the first succeeded competitor.
    // Non-fatal by design — the card completes without the block when unavailable.
    let objections = [];
    if (succeeded.length && !(await isJobCanceled(jobId))) {
      try {
        const firstDomain = (()=>{ try{return new URL(succeeded[0]).hostname.replace(/^www\./i,'');}catch{return '';}})();
        if (firstDomain) {
          await setJobProgressAndBroadcast(jobId, `Extracting objections from ${firstDomain} docs…`, 95, { tokensUsed: jobTokensRef.value });
          const ob = await runObjectionExtraction(firstDomain, { jobId, tokensRef: jobTokensRef });
          objections = ob.items;
          await updateJobAndBroadcast(jobId, { tokensUsed: jobTokensRef.value });
        }
      } catch (e) {
        if (e?.canceled) {
          await updateJobAndBroadcast(jobId, { status: JobStatus.CANCELED, progress:{step:'Canceled', percent:100} });
          await refreshHeartbeat();
          return;
        }
        objections = []; // extraction failed — card still completes
      }
    }
    const resultRef = objections.length ? table + '\n' + renderObjectionsMarkdown(objections) : table;
    if (objections.length) {
      const extra = ` · ${objections.length} objection(s) from their docs`;
      successSummary = (successSummary ? successSummary + extra : `Battle card ready${extra}.`);
    }
    const historyId = await saveToHistoryWorker('Competitor Battle Card', resultRef, 'compare', jobTokensRef.value);
    // also if there were failures, save fallback note? but main result is sufficient
    await updateJobAndBroadcast(jobId, {
      status: JobStatus.DONE,
      progress:{step:'Complete', percent:100},
      tokensUsed: jobTokensRef.value,
      resultRef,
      tableMarkdown: table,
      objections,
      competitorFacts: structuredData,
      verifiedAt: Date.now(),
      historyId: historyId || undefined,
      partialResult,
      successSummary,
      failedUrls: failed
    });
    broadcast({ type:'JOB_DONE', jobId });
  } catch (e) {
    const fallback = structuredData.length ? buildFallbackBattleTable(structuredData) : null;
    const summary = succeeded.length
      ? `What succeeded: ${succeeded.length}/${urls.length} competitors before failure. Failed: ${failed.join(', ')||''} Error: ${e.message}`
      : `No competitors succeeded. Error: ${e.message}`;
    if (fallback) {
      try { await saveToHistoryWorker('Competitor Battle Card (partial)', fallback, 'compare', jobTokensRef.value); } catch {}
    }
    await updateJobAndBroadcast(jobId, {
      status: JobStatus.FAILED,
      error: e.message || 'Battle card failed',
      progress:{step:'Failed', percent:100},
      tokensUsed: jobTokensRef.value,
      resultRef: fallback,
      partialResult: fallback,
      successSummary: summary,
      failedUrls: failed.length? failed : urls
    });
  } finally {
    await refreshHeartbeat();
  }
}

async function runMultitabJob(jobId) {
  let job = await getJob(jobId);
  if (!job) return;
  if (!await hasHostPermissionSW()) {
    await updateJobAndBroadcast(jobId, {
      status: JobStatus.FAILED,
      error: 'Host permission not granted. Open the popup and click “Grant host access” to allow reading tabs.',
      progress:{step:'Failed — host permission required', percent:100},
      successSummary: 'No tabs read — host permission was not granted.'
    });
    await refreshHeartbeat();
    return;
  }
  const jobTokensRef = { value: Number(job.tokensUsed||0) };
  // payload can be {topic, urls} or {mode:'tabs'} ; for multitab we support reading open tabs
  const topic = String(job.payload?.topic||'').trim();
  const maxTabs = Math.min(5, Math.max(2, Number(job.payload?.maxTabs||4)));
  try {
    await setJobProgressAndBroadcast(jobId, 'Opening sources…', 10, { tokensUsed: jobTokensRef.value });
    // determine urls vs tabs
    let sources = [];
    let skipped = [];
    if (Array.isArray(job.payload?.urls) && job.payload.urls.length) {
      // use provided urls (for consistency with battlecard, but multitab uses tabs)
      const urls = job.payload.urls.slice(0, maxTabs);
      for (let i=0;i<urls.length;i++) {
        if (await isJobCanceled(jobId)) {
          await updateJobAndBroadcast(jobId, { status: JobStatus.CANCELED, progress:{step:'Canceled', percent:100}});
          await refreshHeartbeat(); return;
        }
        const url = urls[i];
        const domain = (()=>{try{return new URL(url).hostname;}catch{return url;}})();
        await setJobProgressAndBroadcast(jobId, `Reading source ${i+1}/${urls.length}: ${domain}`, Math.round(((i+1)/urls.length)*70), {tokensUsed: jobTokensRef.value});
        const source = await workerOpenAndReadUrl(url, { active:false, maxLength:2800, waitMs:9000 });
        if (source.ok) sources.push(source);
        else skipped.push({ title: source.title||source.domain, url, reason: source.error||'Unreadable source'});
      }
    } else {
      // default multitab: read open tabs
      const tabs = await workerGetReadableTabs({ currentWindow:true, maxTabs });
      for (let i=0;i<tabs.length;i++) {
        if (await isJobCanceled(jobId)) {
          await updateJobAndBroadcast(jobId, { status: JobStatus.CANCELED, progress:{step:'Canceled', percent:100}});
          await refreshHeartbeat(); return;
        }
        const tab = tabs[i];
        const domain = workerNormalizeDomain(tab.url);
        await setJobProgressAndBroadcast(jobId, `Reading tab ${i+1}/${tabs.length}: ${domain}`, Math.round(((i+1)/tabs.length)*70), {tokensUsed: jobTokensRef.value});
        const source = await workerReadTabSource(tab, { maxLength:2800, waitMs:8000 });
        if (source.ok) sources.push(source);
        else skipped.push({ title: source.title||source.domain, url: tab.url, reason: source.error||'Unreadable source'});
      }
    }
    if (!sources.length) {
      await updateJobAndBroadcast(jobId, { status: JobStatus.FAILED, error:'Could not read research sources.', progress:{step:'Failed', percent:100}, tokensUsed: jobTokensRef.value, failedUrls: [], successSummary:'No sources readable' });
      await refreshHeartbeat(); return;
    }
    if (await isJobCanceled(jobId)) {
      await updateJobAndBroadcast(jobId, { status: JobStatus.CANCELED, progress:{step:'Canceled', percent:100}});
      await refreshHeartbeat(); return;
    }
    const combined = sources.map((s,idx)=> `[SOURCE ${idx+1}] ${s.title}\nDomain: ${s.domain}\nURL: ${s.url}\n${s.text}`).join('\n\n---\n\n');
    await setJobProgressAndBroadcast(jobId, 'Analyzing source data…', 85, {tokensUsed: jobTokensRef.value});
    const appendixLines = [];
    appendixLines.push('SOURCES USED');
    appendixLines.push(...sources.map((s,idx)=> `${idx+1}. ${s.domain} - ${s.title}`));
    if (skipped.length) {
      appendixLines.push('');
      appendixLines.push('SKIPPED SOURCES');
      appendixLines.push(...skipped.map((item,idx)=> `${idx+1}. ${item.url} - ${item.reason}`));
    }
    const effectiveTopic = topic || sources.map(s=>s.domain).join(', ');
    const prompt = `Multi-source research on: "${effectiveTopic}"\n\nRequirements:\n- Cite important claims with [Source: domain]\n- Separate confirmed facts from inferred insights\n- Flag gaps or conflicting evidence\n- Keep the report specific and decision-useful\n\nResearch material:\n${combined.substring(0,10000)}\n\nWrite sections:\n1. Overview\n2. Key Facts\n3. Latest News\n4. Insights and Implications\n5. Risks or Gaps\n6. Source Quality`;
    let report = '';
    try {
      report = await ai.chat(prompt, 1600);
      jobTokensRef.value += estimateTokens(prompt) + estimateTokens(report);
    } catch (e) {
      // keep partial sources but fail synthesis
      const partial = `Sources collected (${sources.length}) but AI synthesis failed: ${e.message}\n\n${appendixLines.join('\n')}`;
      await saveToHistoryWorker(`Research: ${effectiveTopic} (partial)`, partial, 'deep', jobTokensRef.value);
      await updateJobAndBroadcast(jobId, {
        status: JobStatus.FAILED,
        error: e.message || 'AI synthesis failed',
        progress:{step:'Failed - partial saved', percent:100},
        tokensUsed: jobTokensRef.value,
        resultRef: partial,
        partialResult: partial,
        successSummary: `What succeeded: ${sources.length} source(s) read, ${skipped.length} skipped. AI synthesis failed.`,
        failedUrls: skipped.map(s=>s.url)
      });
      await refreshHeartbeat(); return;
    }
    const finalReport = report + '\n\n' + appendixLines.join('\n');
    await saveToHistoryWorker(effectiveTopic, finalReport, 'deep', jobTokensRef.value);
    await updateJobAndBroadcast(jobId, {
      status: JobStatus.DONE,
      progress:{step:'Complete', percent:100},
      tokensUsed: jobTokensRef.value,
      resultRef: finalReport,
      successSummary: skipped.length? `Succeeded: ${sources.length} sources, Skipped: ${skipped.length}` : null,
      failedUrls: skipped.map(s=>s.url)
    });
  } catch (e) {
    await updateJobAndBroadcast(jobId, {
      status: JobStatus.FAILED,
      error: e.message||'Multitab research failed',
      progress:{step:'Failed', percent:100},
      tokensUsed: jobTokensRef.value
    });
  } finally {
    await refreshHeartbeat();
  }
}

// ---------- Monitoring v0: weekly refresh (no backend) ----------
// Toolbar badge for pricing changes (chrome.action — no notifications permission).
async function setMonitorBadge(changedCount) {
  try {
    if (!chrome.action?.setBadgeText) return;
    const text = changeBadgeText(changedCount);
    if (text) {
      if (chrome.action.setBadgeBackgroundColor) {
        await chrome.action.setBadgeBackgroundColor({ color: '#ffc164' });
      }
      await chrome.action.setBadgeText({ text });
    } else {
      await chrome.action.setBadgeText({ text: '' });
    }
  } catch (e) {}
}

// Weekly refresh: for saved battle-card competitors (batch of 3, rest next
// cycle): light fetch (homepage + pricing only, skip blog/news) → extractFacts
// (pricing + positioning) → similarity compare vs stored facts → on change:
// monitorState update + toolbar badge. BYOK: uses the user's key + quota
// (ai.onCall enforces the 25/min limit). No API key → skip silently.
async function runWeeklyRefresh() {
  // Read the key fresh from storage (in-memory copy can lag direct writes);
  // an explicitly-cleared key must win over memory.
  let apiKey = String(userSettings.apiKey || '').trim();
  try {
    const stored = await chrome.storage.local.get(['userSettings']);
    if (stored && typeof stored.userSettings === 'object' && 'apiKey' in stored.userSettings) {
      apiKey = String(stored.userSettings.apiKey || '').trim();
    }
  } catch (e) {}
  if (!apiKey) return { skipped: 'no-api-key' };
  if (!await hasHostPermissionSW()) return { skipped: 'no-host-permission' };
  const jobs = await getJobs();
  const domains = [];
  const seen = new Set();
  for (const j of jobs) {
    if (j?.type !== JobType.BATTLECARD || j?.status !== JobStatus.DONE) continue;
    for (const u of (j.payload?.urls || [])) {
      let d = '';
      try { d = new URL(u).hostname.replace(/^www\./i, '').toLowerCase(); } catch { continue; }
      if (d && !seen.has(d)) { seen.add(d); domains.push(d); }
    }
  }
  if (!domains.length) return { checked: [], changed: [] };
  const now = Date.now();
  const state = await getMonitorState(chrome.storage.local);
  const batch = pickBatch(domains, state, now);
  const checked = [];
  const changed = [];
  for (const domain of batch) {
    const prev = state.competitors[domain] || { lastCheck: 0, changesDetected: 0, lastFacts: null, lastChangeTs: 0 };
    // light mode: homepage + pricing page only (skip blog/news)
    let pageText = '';
    for (const path of ['', '/pricing']) {
      try {
        const src = await workerOpenAndReadUrl(`https://${domain}${path}`, { active: false, maxLength: 4000, waitMs: 8000 });
        if (src.ok && src.text) pageText += `\nSOURCE URL: https://${domain}${path || '/'}\n${src.text.substring(0, 3000)}`;
      } catch (e) {}
    }
    let facts = null;
    if (pageText.trim()) {
      try {
        const out = await extractFacts(
          { domain, url: `https://${domain}/`, sourceUrl: `https://${domain}/`, title: domain, pageText, newsText: '' },
          { pageBudget: 6000, model: userSettings.model }
        );
        facts = { pricing: out.pricing || null, positioning: out.positioning || null };
      } catch (e) {}
    }
    const entry = { lastCheck: now, changesDetected: prev.changesDetected || 0, lastFacts: facts || prev.lastFacts || null, lastChangeTs: prev.lastChangeTs || 0 };
    if (facts && prev.lastFacts) {
      const diffs = diffFacts(prev.lastFacts, facts);
      if (diffs.length) {
        entry.changesDetected = (prev.changesDetected || 0) + 1;
        entry.lastChangeTs = now;
        changed.push({ domain, fields: diffs });
      }
    } else if (facts && !prev.lastFacts) {
      entry.lastFacts = facts; // first baseline, no change signal
    }
    state.competitors[domain] = entry;
    checked.push(domain);
  }
  state.cursor = (Number(state.cursor || 0) + batch.length);
  await saveMonitorState(chrome.storage.local, state);
  // toolbar badge reflects total competitors with a detected change
  const totalChanged = Object.values(state.competitors).filter((s) => (s?.changesDetected || 0) > 0).length;
  await setMonitorBadge(totalChanged);
  return { checked, changed };
}

async function createAndRunJob(type, payload) {
  const job = createJob({ type, payload });
  const jobs = await getJobs();
  jobs.unshift(job);
  await saveJobs(jobs);
  broadcast({ type:'JOB_CREATED', job });
  startHeartbeat(job.id);
  // Phase 8-closer: funnel — card started per feature.
  try { await analytics.trackCardStarted(type); } catch (e) {}
  // fire and forget pipeline
  if (type === JobType.BATTLECARD) runBattleCardJob(job.id).catch(e=>console.error(e));
  else if (type === JobType.MULTITAB) runMultitabJob(job.id).catch(e=>console.error(e));
  else if (type === JobType.DEALROOM) runDealRoomJob(job.id).catch(e=>console.error(e));
  else {
    // unknown type fallback
    await updateJobAndBroadcast(job.id, { status: JobStatus.FAILED, error:'Unknown job type', progress:{step:'Failed', percent:100}});
    await refreshHeartbeat();
  }
  return job;
}

// ---------- Deal Room: pre-call brief from open tabs (SW pipeline) ----------

async function runDealRoomJob(jobId) {
  let job = await getJob(jobId);
  if (!job) return;
  if (!await hasHostPermissionSW()) {
    await updateJobAndBroadcast(jobId, {
      status: JobStatus.FAILED,
      error: 'Host permission not granted. Open the popup and click “Grant host access” to allow reading tabs.',
      progress:{step:'Failed — host permission required', percent:100},
      successSummary: 'No tabs read — host permission was not granted.'
    });
    await refreshHeartbeat();
    return;
  }
  const prospectUrl = String(job.payload?.prospectUrl || '').trim();
  if (!prospectUrl) {
    await updateJobAndBroadcast(jobId, {
      status: JobStatus.FAILED,
      error: 'Prospect URL is required. Enter the company you are calling, then build the Deal Room.',
      progress:{step:'Failed — prospect URL missing', percent:100},
      successSummary: 'No prospect URL provided.'
    });
    await refreshHeartbeat();
    return;
  }
  const maxTabs = Math.min(10, Math.max(2, Number(job.payload?.maxTabs || 10)));
  const profile = (job.payload?.profile && typeof job.payload.profile === 'object')
    ? { ...job.payload.profile }
    : {};
  if (!profile.seller && userSettings.ownProductUrl) profile.seller = userSettings.ownProductUrl;
  const prospectDomain = (()=>{ try{return new URL(prospectUrl).hostname.replace(/^www\./i,'');}catch{return prospectUrl;}})();
  const jobTokensRef = { value: Number(job.tokensUsed || 0) };
  const knownUrls = [prospectUrl];

  const checkCanceled = async () => {
    if (await isJobCanceled(jobId)) {
      await updateJobAndBroadcast(jobId, { status: JobStatus.CANCELED, progress:{step:'Canceled', percent:100}});
      await refreshHeartbeat();
      return true;
    }
    return false;
  };

  try {
    // 1. read open tabs + classify prospect vs competitors
    await setJobProgressAndBroadcast(jobId, 'Reading open tabs…', 5, { tokensUsed: jobTokensRef.value });
    const tabs = await workerGetReadableTabs({ currentWindow:true, maxTabs });
    const cls = classifyTabs({ tabs, prospectUrl, maxTotal: maxTabs });
    if (await checkCanceled()) return;

    // 2. prospect page (hidden tab, consistent with battle-card extraction)
    await setJobProgressAndBroadcast(jobId, `Reading ${prospectDomain}…`, 12, { tokensUsed: jobTokensRef.value });
    const prospectSource = await workerOpenAndReadUrl(prospectUrl, { active:false, maxLength:5000, waitMs:9000 });
    if (!prospectSource.ok || !prospectSource.text) {
      await updateJobAndBroadcast(jobId, {
        status: JobStatus.FAILED,
        error: `Could not read the prospect page (${prospectDomain}): ${prospectSource.error || 'empty page'}. Check the URL and try again.`,
        progress:{step:'Failed — prospect unreadable', percent:100},
        tokensUsed: jobTokensRef.value,
        failedUrls: [prospectUrl],
        successSummary: 'Prospect page could not be read.'
      });
      await refreshHeartbeat();
      return;
    }
    if (await checkCanceled()) return;

    // 3. prospect facts: news + one strict-JSON extraction + tech mining
    await setJobProgressAndBroadcast(jobId, `Extracting ${prospectDomain} facts…`, 22, { tokensUsed: jobTokensRef.value });
    const prospectNews = await workerGoogleResearch(`${prospectDomain} recent news 2026`);
    let pf = {};
    try {
      const raw = await ai.chat(buildProspectPrompt(prospectSource.text, prospectNews), 800);
      jobTokensRef.value += estimateTokens(buildProspectPrompt(prospectSource.text, prospectNews)) + estimateTokens(raw);
      const m = String(raw).match(/\{[\s\S]*\}/);
      pf = m ? JSON.parse(m[0]) : {};
    } catch (e) {
      pf = {};
    }
    const minedTech = mineTechHints(prospectSource.text);
    const factTech = Array.isArray(pf.techHints) ? pf.techHints.map(String) : [];
    const prospectFacts = {
      name: prospectSource.title || prospectDomain,
      pageUrl: prospectUrl,
      sourceUrl: prospectUrl,
      whatTheyDo: typeof pf.whatTheyDo === 'string' && pf.whatTheyDo.trim() ? pf.whatTheyDo.trim().substring(0, 280) : null,
      sizeSignals: Array.isArray(pf.sizeSignals) ? pf.sizeSignals.map(String).filter(Boolean).slice(0, 5) : [],
      techHints: [...new Set([...minedTech, ...factTech])].slice(0, 8),
      recentNews: typeof pf.recentNews === 'string' && pf.recentNews.trim()
        ? pf.recentNews.trim().substring(0, 280)
        : (prospectNews ? prospectNews.substring(0, 280) : null),
    };
    if (await checkCanceled()) return;

    // 4. competitors — reuse battle-card extraction (fetchPageSet + extractFacts shape)
    const competitors = [];
    const failedCompetitors = [];
    const comps = cls.competitors;
    for (let i = 0; i < comps.length; i++) {
      if (await checkCanceled()) return;
      const comp = comps[i];
      const pct = 25 + Math.round(((i + 1) / Math.max(1, comps.length)) * 50);
      await setJobProgressAndBroadcast(jobId, `Extracting competitor angles (${i + 1}/${comps.length}: ${comp.domain})…`, pct, { tokensUsed: jobTokensRef.value });
      let data = null;
      try {
        data = await workerCollectStructuredPageData(comp.url, jobTokensRef);
      } catch (e) {
        data = { url: comp.url, domain: comp.domain, pricing: 'N/A', features: 'N/A', targetAudience: 'N/A', recentNews: 'N/A', error: e.message || 'extraction failed' };
      }
      const isFailed = !!(data.error && data.pricing === 'N/A' && data.features === 'N/A');
      if (isFailed) {
        failedCompetitors.push(comp.url);
      } else {
        knownUrls.push(comp.url);
        competitors.push({
          domain: data.domain || comp.domain,
          url: comp.url,
          sourceUrl: comp.url,
          pricing: data.pricing,
          features: data.features,
          targetAudience: data.targetAudience,
          recentNews: data.recentNews,
        });
      }
      await updateJobAndBroadcast(jobId, { tokensUsed: jobTokensRef.value });
    }
    if (await checkCanceled()) return;

    // 5. ONE synthesis call (4000 tokens)
    await setJobProgressAndBroadcast(jobId, 'Synthesizing brief…', 88, { tokensUsed: jobTokensRef.value });
    const synthPrompt = buildDealRoomPrompt({ prospect: prospectFacts, competitors, profile });
    let brief = null;
    let stats = { total: 0, kept: 0, omitted: 0 };
    try {
      const raw = await ai.chat(synthPrompt, 4000);
      jobTokensRef.value += estimateTokens(synthPrompt) + estimateTokens(raw);
      const parsed = parseDealRoomJson(raw);
      const validated = validateBrief(parsed, knownUrls);
      brief = validated.brief;
      stats = validated.stats;
      if (!brief.prospect.name || brief.prospect.name === 'Unknown prospect') {
        brief.prospect.name = prospectFacts.name || prospectDomain;
      }
    } catch (e) {
      // partial: prospect + competitor facts preserved, synthesis failed
      const partialLines = [
        `Prospect: ${prospectFacts.name} — ${prospectFacts.whatTheyDo || 'extraction incomplete'}`,
        ...competitors.map((c) => `${c.domain}: ${String(c.pricing || '').substring(0, 120)}`),
      ];
      const partial = `Deal Room facts collected but synthesis failed: ${e.message}\n\n${partialLines.join('\n')}`;
      await saveToHistoryWorker(`Deal Room — ${prospectFacts.name} (partial)`, partial, 'dealroom', jobTokensRef.value);
      await updateJobAndBroadcast(jobId, {
        status: JobStatus.FAILED,
        error: e.message || 'Brief synthesis failed',
        progress:{step:'Failed - partial saved', percent:100},
        tokensUsed: jobTokensRef.value,
        resultRef: partial,
        partialResult: partial,
        successSummary: `Facts collected for prospect + ${competitors.length} competitor(s); synthesis failed.`,
        failedUrls: failedCompetitors
      });
      await refreshHeartbeat();
      return;
    }

    // 6. render + save as dealroom history
    const markdown = renderDealRoomMarkdown(brief, brief.prospect.name);
    await saveToHistoryWorker(`Deal Room — ${brief.prospect.name}`, markdown, 'dealroom', jobTokensRef.value);
    try { await analytics.trackEvent('deal_room_used', { competitors: competitors.length, omitted: stats.omitted }); } catch (e) {}
    await updateJobAndBroadcast(jobId, {
      status: JobStatus.DONE,
      progress:{step:'Complete', percent:100},
      tokensUsed: jobTokensRef.value,
      resultRef: markdown,
      briefJson: brief,
      briefStats: stats,
      successSummary: failedCompetitors.length
        ? `Brief ready (prospect + ${competitors.length} competitor(s); ${failedCompetitors.length} skipped). ${stats.omitted} unsourced item(s) omitted.`
        : (competitors.length
            ? `Brief ready (prospect + ${competitors.length} competitor(s)). ${stats.omitted} unsourced item(s) omitted.`
            : `Prospect-only brief ready (no competitor tabs open). ${stats.omitted} unsourced item(s) omitted.`),
      failedUrls: failedCompetitors
    });
    broadcast({ type:'JOB_DONE', jobId });
  } catch (e) {
    await updateJobAndBroadcast(jobId, {
      status: JobStatus.FAILED,
      error: e.message || 'Deal Room failed',
      progress:{step:'Failed', percent:100},
      tokensUsed: jobTokensRef.value,
      failedUrls: [prospectUrl]
    });
  } finally {
    await refreshHeartbeat();
  }
}

// ---------- existing autofill helpers ----------
async function waitForTarget(tabId, action, timeoutMs = AUTOFILL_MAX_WAIT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = await executeInTab(tabId, (a) => {
      const normalize = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
      const findByHint = (hint) => {
        const key = normalize(hint);
        if (!key) return null;
        const nodes = [...document.querySelectorAll("input,textarea,select,button,[role='button'],a,[contenteditable='true'],[role='combobox']")];
        let best = null;
        let bestScore = -1;
        for (const el of nodes) {
          const hay = normalize([
            el.innerText || "",
            el.labels?.[0]?.innerText || "",
            el.closest("label")?.innerText || "",
            el.getAttribute("aria-label") || "",
            el.getAttribute("title") || "",
            el.name || "",
            el.id || "",
            el.placeholder || ""
          ].join(" "));
          let score = 0;
          if (hay.includes(key)) score += 5;
          score += key.split(" ").filter((t) => t.length > 2 && hay.includes(t)).length;
          if (score > bestScore) {
            bestScore = score;
            best = el;
          }
        }
        return bestScore > 0 ? best : null;
      };
      const sel = String(a.selector || "").trim();
      if (sel && document.querySelector(sel)) return true;
      const hinted = findByHint(a.field || a.value || a.label || a.text || "");
      return !!hinted;
    }, [action]);
    if (found) return true;
    await sleep(220);
  }
  return false;
}

async function runAutofillStep(job) {
  const action = job.actions[job.index];
  if (!action) return { done: true };
  const actionType = String(action.type || "").toLowerCase();

  if (actionType === "waitfor" || actionType === "wait" || actionType === "wait_for") {
    const ok = await waitForTarget(job.tabId, action, Number(action.waitMs || 12000));
    return ok
      ? { ok: true, mode: "waitFor", field: action.field || action.selector || "" }
      : { ok: false, mode: "waitFor", field: action.field || action.selector || "", reason: "wait_target_not_found" };
  }

  const result = await executeInTab(job.tabId, (a) => {
    const normalize = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
    const toBool = (v) => {
      if (typeof v === "boolean") return v;
      return ["1", "true", "yes", "y", "on", "checked"].includes(normalize(v));
    };
    const setNativeValue = (el, value) => {
      const str = String(value ?? "");
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      if (descriptor?.set) descriptor.set.call(el, str);
      else el.value = str;
    };
    const trigger = (el) => {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    };
    const robustClick = (el) => {
      try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (e) {}
      try { el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); } catch (e) {}
      try {
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      } catch (e) {}
      try { el.click(); } catch (e) {}
    };
    const findByHint = (hint, includeClickables = false) => {
      const key = normalize(hint);
      if (!key) return null;
      const selector = includeClickables
        ? "input,textarea,select,button,[role='button'],input[type='submit'],a,[contenteditable='true'],[role='combobox'],span,div"
        : "input,textarea,select,[contenteditable='true'],[role='combobox']";
      const nodes = [...document.querySelectorAll(selector)];
      let best = null;
      let bestScore = -1;
      for (const el of nodes) {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
        const hay = normalize([
          el.innerText || "",
          el.labels?.[0]?.innerText || "",
          el.closest("label")?.innerText || "",
          el.getAttribute("aria-label") || "",
          el.getAttribute("title") || "",
          el.name || "",
          el.id || "",
          el.placeholder || "",
          el.className || ""
        ].join(" "));
        let score = 0;
        if (hay.includes(key)) score += 5;
        score += key.split(" ").filter((t) => t.length > 2 && hay.includes(t)).length;
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }
      return bestScore > 0 ? best : null;
    };
    const selectOption = (selectEl, valueText) => {
      const target = normalize(valueText);
      let option = [...selectEl.options].find((opt) => normalize(opt.value) === target || normalize(opt.text) === target);
      if (!option) option = [...selectEl.options].find((opt) => normalize(opt.text).includes(target));
      if (!option) return false;
      selectEl.value = option.value;
      trigger(selectEl);
      return true;
    };
    const selectComboboxOption = (valueText) => {
      const target = normalize(valueText);
      const options = [...document.querySelectorAll("[role='option'], li[role='option'], li, .option, [data-value]")];
      const match = options.find((opt) => normalize(opt.innerText || opt.getAttribute("data-value") || "").includes(target));
      if (!match) return false;
      robustClick(match);
      return true;
    };

    const sel = String(a.selector || "").trim();
    const isClick = String(a.type || "").toLowerCase() === "click";
    let el = sel ? document.querySelector(sel) : null;
    if (!el) el = findByHint(a.field || a.label || a.value || a.text || "", isClick);
    if (!el) return { ok: false, reason: "selector_not_found", field: a.field || "", selector: sel };

    const tag = (el.tagName || "").toLowerCase();
    const type = String(a.type || el.type || tag).toLowerCase();
    const value = a.value;
    const choiceText = String(a.choiceText || value || "").trim();
    el.focus();

    if (isClick) {
      robustClick(el);
      return { ok: true, mode: "click", field: a.field || "", selector: sel };
    }
    if (tag === "select" || type === "select") {
      const ok = selectOption(el, choiceText);
      return { ok, mode: "select", field: a.field || "", selector: sel, reason: ok ? "" : "option_not_found" };
    }
    if (type === "checkbox" || el.type === "checkbox") {
      el.checked = toBool(value);
      trigger(el);
      return { ok: true, mode: "checkbox", field: a.field || "", selector: sel };
    }
    if (type === "radio" || el.type === "radio") {
      const name = el.name;
      let chosen = null;
      if (name) {
        const escaped = name.replace(/"/g, '\\"');
        const radios = [...document.querySelectorAll(`input[type="radio"][name="${escaped}"]`)];
        chosen = radios.find((r) => normalize(r.value) === normalize(choiceText));
        if (!chosen) chosen = radios.find((r) => normalize(r.closest("label")?.innerText || "").includes(normalize(choiceText)));
        if (!chosen) chosen = radios[0];
      }
      if (!chosen) return { ok: false, mode: "radio", field: a.field || "", selector: sel, reason: "radio_option_not_found" };
      chosen.checked = true;
      trigger(chosen);
      return { ok: true, mode: "radio", field: a.field || "", selector: sel };
    }
    if (el.isContentEditable || type === "combobox" || el.getAttribute("role") === "combobox") {
      robustClick(el);
      if ("value" in el) {
        setNativeValue(el, value ?? "");
        trigger(el);
      } else {
        el.textContent = String(value ?? "");
        trigger(el);
      }
      const picked = choiceText ? selectComboboxOption(choiceText) : true;
      return { ok: !!picked, mode: "combobox", field: a.field || "", selector: sel, reason: picked ? "" : "combobox_option_not_found" };
    }
    if ("value" in el) {
      setNativeValue(el, value ?? "");
      trigger(el);
      return { ok: true, mode: "value", field: a.field || "", selector: sel };
    }
    return { ok: false, reason: "unsupported_field", field: a.field || "", selector: sel };
  }, [action]);
  return result || { ok: false, reason: "step_execution_failed", field: action.field || "" };
}

async function runAutofillJob(jobId) {
  const job = autofillJobs.get(jobId);
  if (!job || job.status !== "running") return;
  while (job.status === "running" && job.index < job.actions.length) {
    const step = job.actions[job.index];
    const stepResult = await runAutofillStep(job).catch((e) => ({
      ok: false,
      reason: e?.message || "step_failed",
      field: step?.field || ""
    }));
    job.results.push(stepResult);
    job.index += 1;
    job.updatedAt = Date.now();
    await chrome.storage.local.set({ lastAutofillJob: job });

    const type = String(step?.type || "").toLowerCase();
    if (type === "click") {
      await waitForTabComplete(job.tabId, 10000);
      const waitMs = Math.max(0, Math.min(6000, Number(step?.waitMs || step?.afterClickWaitMs || 900)));
      if (waitMs) await sleep(waitMs);
    }
  }
  if (job.status === "running") {
    job.status = "done";
    job.updatedAt = Date.now();
    await chrome.storage.local.set({ lastAutofillJob: job });
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  chrome.runtime.setUninstallURL('https://atomai.featurebase.app/?source=uninstall');
  // Phase 8-closer/9: funnel — install event ONLY on first install, not update.
  // events.js also dedupes via installTs (belt & suspenders).
  if (details?.reason === 'install') {
    try { analytics.trackInstall().catch(() => {}); } catch (e) {}
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') }).catch(() => {});
  }
  // Monitoring v0: weekly refresh alarm (period 10080 min = 7 days).
  try { chrome.alarms.create(WEEKLY_REFRESH_ALARM, { periodInMinutes: WEEKLY_PERIOD_MIN }); } catch (e) {}
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!isTrustedSender(sender)) {
    sendResponse({ error: 'Untrusted sender.' });
    return false;
  }

  // ---- Phase 9: launch instrumentation ----
  if (request.type === 'TRACK_EVENT') {
    (async () => {
      try {
        await analytics.trackEvent(String(request.event || ''), request.props || {});
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  if (request.type === 'TRIAGE_SUMMARY') {
    (async () => {
      try { sendResponse(await triage.summary()); }
      catch (e) { sendResponse({ error: e.message }); }
    })();
    return true;
  }

  if (request.type === 'GET_LAUNCH_REPORT') {
    (async () => {
      try { sendResponse(await analytics.getLaunchReport()); }
      catch (e) { sendResponse({ error: e.message }); }
    })();
    return true;
  }

  if (request.type === 'AI_CHAT') {
    (async () => {
      try {
        const text = await ai.chat(request.prompt, request.maxTokens);
        sendResponse({ text });
      } catch (err) {
        await appendDebugLog({
          scope: 'AI_CHAT',
          level: 'error',
          message: err.message || 'AI call failed',
          detail: { promptLength: String(request.prompt || '').length, maxTokens: request.maxTokens || null }
        });
        sendResponse({ error: err.message || 'AI call failed' });
      }
    })();
    return true;
  }

  if (request.type === 'LINKEDIN_CONTEXT') {
    // F2: content script relayed a LinkedIn person/company detection.
    // sanitizeLinkedInContext bounds every field — content-script input is
    // not trusted shape even from our own script.
    (async () => {
      try {
        const ctx = sanitizeLinkedInContext(request.payload);
        if (!ctx) { sendResponse({ ok: false }); return; }
        await chrome.storage.local.set({ [CONTEXT_KEY]: ctx });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  // ---- Auto Task (Phase 4 repair): loop + approvals live in the SW ----
  if (request.type === 'AUTO_TASK_START') {
    (async () => {
      try {
        const res = await autoTask.start({ goal: request.goal, tabId: request.tabId });
        sendResponse(res);
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || 'Failed to start task.' });
      }
    })();
    return true;
  }

  if (request.type === 'AUTO_TASK_STOP') {
    (async () => {
      try { sendResponse(await autoTask.cancel()); }
      catch (e) { sendResponse({ ok: false, error: e?.message || 'Failed to cancel.' }); }
    })();
    return true;
  }

  if (request.type === 'AUTO_TASK_PAUSE') {
    (async () => {
      try { sendResponse(await autoTask.pause()); }
      catch (e) { sendResponse({ ok: false, error: e?.message || 'Failed to pause.' }); }
    })();
    return true;
  }

  if (request.type === 'AUTO_TASK_RESUME') {
    (async () => {
      try { sendResponse(await autoTask.resume()); }
      catch (e) { sendResponse({ ok: false, error: e?.message || 'Failed to resume.' }); }
    })();
    return true;
  }

  if (request.type === 'AUTO_TASK_APPROVAL') {
    (async () => {
      try { sendResponse(await autoTask.decide({ decision: request.decision })); }
      catch (e) { sendResponse({ ok: false, error: e?.message || 'Failed to record decision.' }); }
    })();
    return true;
  }

  if (request.type === 'AUTO_TASK_GET_STATE') {
    (async () => {
      try { sendResponse({ run: await autoTask.getState() }); }
      catch (e) { sendResponse({ error: e?.message || 'Failed to read state.' }); }
    })();
    return true;
  }

  // ---- Auto Task recipes (Phase 6, wired into the live loop) ----
  if (request.type === 'AUTO_TASK_SAVE_RECIPE') {
    (async () => {
      try { sendResponse(await autoTask.saveRecipeFromRun({ name: request.name })); }
      catch (e) { sendResponse({ ok: false, error: e?.message || 'Failed to save recipe.' }); }
    })();
    return true;
  }

  if (request.type === 'AUTO_TASK_LIST_RECIPES') {
    (async () => {
      try { sendResponse({ ok: true, recipes: await autoTask.listRecipeSummaries() }); }
      catch (e) { sendResponse({ ok: false, error: e?.message || 'Failed to list recipes.' }); }
    })();
    return true;
  }

  if (request.type === 'AUTO_TASK_RUN_RECIPE') {
    (async () => {
      try { sendResponse(await autoTask.startRecipe({ recipeId: request.recipeId, tabId: request.tabId })); }
      catch (e) { sendResponse({ ok: false, error: e?.message || 'Failed to run recipe.' }); }
    })();
    return true;
  }

  // ---- Phase 5: job orchestration messages (+ Deal Room) ----
  if (request.type === 'JOB_CREATE' || request.type === 'BATTLECARD_START' || request.type === 'MULTITAB_START' || request.type === 'DEALROOM_START') {
    (async () => {
      try {
        let type = request.jobType || request.type;
        if (type === 'BATTLECARD_START') type = JobType.BATTLECARD;
        else if (type === 'MULTITAB_START') type = JobType.MULTITAB;
        else if (type === 'DEALROOM_START') type = JobType.DEALROOM;
        else type = request.payload?.type || request.jobType || JobType.BATTLECARD;

        // normalize type string
        const t = String(type).toLowerCase();
        const finalType = t.includes('battle') ? JobType.BATTLECARD : t.includes('multi') ? JobType.MULTITAB : (t.includes('deal') ? JobType.DEALROOM : t);

        const payload = request.payload || {};
        // for battlecard, expect payload.urls
        if (finalType === JobType.BATTLECARD && !payload.urls) {
          // try alternate field names
          if (Array.isArray(request.urls)) payload.urls = request.urls;
          else if (Array.isArray(request.competitorUrls)) payload.urls = request.competitorUrls;
        }
        if (finalType === JobType.MULTITAB && !payload.topic && request.topic) payload.topic = request.topic;

        const job = await createAndRunJob(finalType, payload);
        sendResponse({ ok: true, jobId: job.id, job });
      } catch (e) {
        sendResponse({ error: e.message || 'Failed to create job' });
      }
    })();
    return true;
  }

  if (request.type === 'JOB_LIST' || request.type === 'GET_JOBS') {
    (async () => {
      const jobs = await getJobs();
      sendResponse({ ok: true, jobs });
    })();
    return true;
  }

  if (request.type === 'JOB_GET' || request.type === 'GET_JOB') {
    (async () => {
      const jobId = String(request.jobId || request.id || '');
      const job = await getJob(jobId);
      if (!job) sendResponse({ error: 'Job not found' });
      else sendResponse({ ok: true, job });
    })();
    return true;
  }

  if (request.type === 'JOB_CANCEL' || request.type === 'CANCEL_JOB') {
    (async () => {
      const jobId = String(request.jobId || request.id || '');
      if (!jobId) { sendResponse({ error: 'jobId required' }); return; }
      const job = await requestCancel(jobId);
      if (!job) sendResponse({ error: 'Job not found' });
      else {
        broadcast({ type: 'JOB_UPDATE', job });
        // the running pipeline will detect cancelRequested and transition to canceled
        // also immediately mark if not already running? For non-running, set canceled directly
        if (job.status === JobStatus.RUNNING) {
          // pipeline will handle, but we also broadcast cancelRequested
        } else {
          // no-op
        }
        sendResponse({ ok: true, job });
      }
    })();
    return true;
  }

  if (request.type === 'JOB_RETRY' || request.type === 'RETRY_JOB') {
    (async () => {
      const jobId = String(request.jobId || request.id || '');
      const original = await getJob(jobId);
      if (!original) { sendResponse({ error: 'Original job not found' }); return; }
      if (original.status !== JobStatus.FAILED) { sendResponse({ error: 'Only failed jobs can be retried' }); return; }
      // Deal Room has no per-URL retry semantics — re-run the full payload.
      if (original.type === JobType.DEALROOM) {
        if (!original.payload?.prospectUrl) { sendResponse({ error: 'Original deal room has no prospect URL' }); return; }
        const newJob = await createAndRunJob(JobType.DEALROOM, { ...original.payload, retryOf: original.id });
        sendResponse({ ok: true, jobId: newJob.id, job: newJob });
        return;
      }
      const failedUrls = Array.isArray(original.failedUrls) ? original.failedUrls.filter(Boolean) : [];
      if (!failedUrls.length) { sendResponse({ error: 'No failed competitors to retry' }); return; }
      const payload = { urls: failedUrls, retryOf: original.id, originalPayload: original.payload };
      const newJob = await createAndRunJob(original.type, payload);
      sendResponse({ ok: true, jobId: newJob.id, job: newJob });
    })();
    return true;
  }

  // ---- Objection library: refresh + edit persistence ----
  // OBJECTION_REFRESH re-runs objection-lib for the parent card's first
  // competitor and patches the parent job in place (objections + resultRef).
  if (request.type === 'OBJECTION_REFRESH') {
    (async () => {
      try {
        const jobId = String(request.jobId || request.id || '');
        const parent = await getJob(jobId);
        if (!parent) { sendResponse({ error: 'Job not found' }); return; }
        if (parent.type !== JobType.BATTLECARD) { sendResponse({ error: 'Objection refresh applies to battle cards' }); return; }
        if (!await hasHostPermissionSW()) { sendResponse({ error: 'Host permission not granted.' }); return; }
        const urls = Array.isArray(parent.payload?.urls) ? parent.payload.urls.filter(Boolean) : [];
        if (!urls.length) { sendResponse({ error: 'Parent card has no competitor URLs' }); return; }
        const domain = (()=>{ try{return new URL(urls[0]).hostname.replace(/^www\./i,'');}catch{return '';}})();
        if (!domain) { sendResponse({ error: 'Could not parse competitor domain' }); return; }
        const tokensRef = { value: Number(parent.tokensUsed || 0) };
        broadcast({ type: 'JOB_UPDATE', job: { ...parent, progress: { step: `Refreshing objections from ${domain}…`, percent: 95 } } });
        const ob = await runObjectionExtraction(domain, { jobId: parent.id, tokensRef });
        const table = parent.tableMarkdown || splitObjectionsBlock(parent.resultRef || '').table;
        const resultRef = ob.items.length ? table + '\n' + renderObjectionsMarkdown(ob.items) : table;
        const updatedHistoryId = parent.historyId
          ? (await updateHistoryEntry(parent.historyId, resultRef)) || parent.historyId
          : await saveToHistoryWorker('Competitor Battle Card (objections refreshed)', resultRef, 'compare', tokensRef.value);
        const updated = await updateJobAndBroadcast(jobId, {
          objections: ob.items,
          tableMarkdown: table,
          resultRef,
          historyId: updatedHistoryId || undefined,
          tokensUsed: tokensRef.value,
          successSummary: ob.items.length
            ? `Objections refreshed from ${domain} docs (${ob.items.length} item(s)).`
            : `Objection refresh found nothing new on ${domain}.`,
        });
        sendResponse({ ok: true, job: updated });
      } catch (e) {
        sendResponse({ error: e?.message || 'Objection refresh failed' });
      }
    })();
    return true;
  }

  // JOB_UPDATE_OBJECTIONS persists user edits to the objections block:
  // rebuttals edited, needsInput cleared on non-empty edit, resultRef rebuilt.
  if (request.type === 'JOB_UPDATE_OBJECTIONS') {
    (async () => {
      try {
        const jobId = String(request.jobId || request.id || '');
        const parent = await getJob(jobId);
        if (!parent) { sendResponse({ error: 'Job not found' }); return; }
        if (!Array.isArray(request.objections)) { sendResponse({ error: 'objections array required' }); return; }
        const cleaned = request.objections
          .filter((o) => o && typeof o === 'object')
          .map((o) => {
            const prev = (Array.isArray(parent.objections) ? parent.objections : [])
              .find((p) => String(p?.objection || '') === String(o.objection || '') && String(p?.sourceUrl || '') === String(o.sourceUrl || ''));
            const counterArgument = String(o.counterArgument ?? prev?.counterArgument ?? '').trim().substring(0, 220);
            return {
              objection: String(o.objection || prev?.objection || '').trim().substring(0, 220),
              theirClaim: String(o.theirClaim ?? prev?.theirClaim ?? '').trim().substring(0, 220),
              counterArgument,
              sourceUrl: String(o.sourceUrl || prev?.sourceUrl || ''),
              quote: String(o.quote ?? prev?.quote ?? '').trim().substring(0, 200),
              confidence: ['high', 'medium', 'low'].includes(o.confidence) ? o.confidence : (prev?.confidence || 'medium'),
              verification: prev?.verification === 'verified' ? 'verified' : 'inferred',
              proofRef: prev?.proofRef || null,
              // user edit resolves "needs your input" once a counter exists
              needsInput: counterArgument ? false : true,
            };
          })
          .filter((o) => o.objection && o.counterArgument && /^https?:\/\//i.test(o.sourceUrl))
          .slice(0, 12);
        const table = parent.tableMarkdown || splitObjectionsBlock(parent.resultRef || '').table;
        const resultRef = cleaned.length ? table + '\n' + renderObjectionsMarkdown(cleaned) : table;
        const updatedHistoryId = parent.historyId
          ? (await updateHistoryEntry(parent.historyId, resultRef)) || parent.historyId
          : await saveToHistoryWorker('Competitor Battle Card (objections edited)', resultRef, 'compare', Number(parent.tokensUsed || 0));
        const updated = await updateJobAndBroadcast(jobId, {
          objections: cleaned,
          tableMarkdown: table,
          resultRef,
          historyId: updatedHistoryId || undefined,
          successSummary: `Objections edited by user (${cleaned.length} item(s)).`,
        });
        sendResponse({ ok: true, job: updated });
      } catch (e) {
        sendResponse({ error: e?.message || 'Failed to save objection edits' });
      }
    })();
    return true;
  }

  // ---- Share the card: Slack webhook POST (no backend) ----
  // SHARE_SLACK {jobId} → builds Block Kit from the job + win/loss history
  // and POSTs to the user's Slack webhook URL (Settings). Quota: plain webhook
  // POST, not an AI call — no model quota consumed.
  if (request.type === 'SHARE_SLACK') {
    (async () => {
      try {
        const jobId = String(request.jobId || request.id || '');
        const job = await getJob(jobId);
        if (!job) { sendResponse({ error: 'Job not found' }); return; }
        if (job.type !== JobType.BATTLECARD) { sendResponse({ error: 'Slack share applies to battle cards' }); return; }
        // Read settings fresh from storage (in-memory copy can lag direct writes).
        // NOTE: an explicitly-cleared ('') webhook must win over memory —
        // only fall back to memory when storage has no userSettings at all.
        let webhook = String(userSettings.slackWebhookUrl || '').trim();
        let ownProduct = userSettings.ownProductUrl || '';
        try {
          const stored = await chrome.storage.local.get(['userSettings']);
          if (stored && typeof stored.userSettings === 'object') {
            webhook = String(stored.userSettings.slackWebhookUrl || '').trim();
            ownProduct = stored.userSettings.ownProductUrl || '';
          }
        } catch (e) {}
        if (!/^https:\/\/hooks\.slack\.com\//i.test(webhook)) {
          sendResponse({ error: 'Slack webhook URL not set. Add one in Settings → Slack Webhook, then share again.' });
          return;
        }
        const urls = Array.isArray(job.payload?.urls) ? job.payload.urls.filter(Boolean) : [];
        const firstUrl = urls[0] || '';
        let competitor = '';
        try { competitor = new URL(firstUrl).hostname.replace(/^www\./i, ''); } catch { competitor = firstUrl || 'competitor'; }
        const facts = Array.isArray(job.competitorFacts) && job.competitorFacts.length ? job.competitorFacts[0] : {};
        const allWinLoss = await getWinLoss(chrome.storage.local);
        const mine = allWinLoss.filter((r) => r.competitor === competitor.toLowerCase());
        const wins = mine.filter((r) => r.outcome === 'won').map((r) => r.why).filter(Boolean);
        const losses = mine.filter((r) => r.outcome === 'lost').map((r) => r.why).filter(Boolean);
        const winStats = {
          won: mine.filter((r) => r.outcome === 'won').length,
          lost: mine.filter((r) => r.outcome === 'lost').length,
          winReasons: wins,
          lossReasons: losses,
        };
        let yourCompany = 'us';
        try {
          if (ownProduct) yourCompany = new URL(ownProduct).hostname.replace(/^www\./i, '');
        } catch {}
        const blocks = buildSlackBlocks({
          yourCompany,
          competitor,
          verifiedDate: new Date(Number(job.verifiedAt || job.updatedAt || Date.now())).toLocaleDateString(),
          pricing: facts.pricing || '',
          features: facts.features || '',
          targetAudience: facts.targetAudience || '',
          objections: job.objections || [],
          winStats,
        });
        const res = await fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ blocks }),
        });
        if (!res.ok) {
          sendResponse({ error: `Slack rejected the post (HTTP ${res.status}). Check the webhook URL in Settings.` });
          return;
        }
        try { await analytics.trackEvent('shared', { surface: 'slack-webhook', jobId }); } catch (e) {}
        sendResponse({ ok: true, status: res.status });
      } catch (e) {
        sendResponse({ error: e?.message || 'Slack share failed' });
      }
    })();
    return true;
  }

  // ---- Monitoring v0: dev/manual trigger (alarm fires this in production) ----
  if (request.type === 'RUN_WEEKLY_REFRESH') {
    (async () => {
      try {
        const result = await runWeeklyRefresh();
        sendResponse({ ok: true, result });
      } catch (e) {
        sendResponse({ error: e?.message || 'Weekly refresh failed' });
      }
    })();
    return true;
  }

  // ---- Monitoring v0: re-verify flow ----
  // REVERIFY_CARD {jobId} → full re-extraction for the card's first competitor,
  // merged with preserved user edits; vanished items flagged stale; history
  // updated in place; monitorState change flag cleared for the domain.
  if (request.type === 'REVERIFY_CARD') {
    (async () => {
      try {
        const jobId = String(request.jobId || request.id || '');
        const parent = await getJob(jobId);
        if (!parent) { sendResponse({ error: 'Job not found' }); return; }
        if (parent.type !== JobType.BATTLECARD) { sendResponse({ error: 'Re-verify applies to battle cards' }); return; }
        if (!await hasHostPermissionSW()) { sendResponse({ error: 'Host permission not granted.' }); return; }
        const urls = Array.isArray(parent.payload?.urls) ? parent.payload.urls.filter(Boolean) : [];
        if (!urls.length) { sendResponse({ error: 'Parent card has no competitor URLs' }); return; }
        const firstUrl = urls[0];
        const domain = (()=>{ try{return new URL(firstUrl).hostname.replace(/^www\./i,'');}catch{return '';}})();
        if (!domain) { sendResponse({ error: 'Could not parse competitor domain' }); return; }
        const tokensRef = { value: Number(parent.tokensUsed || 0) };
        await setJobProgressAndBroadcast(jobId, `Re-verifying ${domain}…`, 50, { tokensUsed: tokensRef.value });
        // full re-extraction: facts + objections
        let freshFacts = null;
        try {
          freshFacts = await workerCollectStructuredPageData(firstUrl, tokensRef);
        } catch (e) {
          freshFacts = { url: firstUrl, domain, error: e?.message || 're-extraction failed' };
        }
        const ob = await runObjectionExtraction(domain, { jobId: parent.id, tokensRef });
        // merge: preserve user-edited counters (same objection+sourceUrl), flag stale
        const oldItems = Array.isArray(parent.objections) ? parent.objections : [];
        const freshKey = (o) => `${String(o?.objection || '')}|||${String(o?.sourceUrl || '')}`;
        const freshKeys = new Set(ob.items.map(freshKey));
        const merged = ob.items.map((fresh) => {
          const prev = oldItems.find((p) => freshKey(p) === freshKey(fresh));
          if (prev && !prev.needsInput && String(prev.counterArgument || '').trim() &&
              String(prev.counterArgument).trim() !== String(fresh.counterArgument || '').trim()) {
            return { ...fresh, counterArgument: String(prev.counterArgument).trim().substring(0, 220) };
          }
          return fresh;
        });
        let staleCount = 0;
        for (const prev of oldItems) {
          if (!freshKeys.has(freshKey(prev))) {
            staleCount += 1;
            merged.push({ ...prev, stale: true });
          }
        }
        // update stored facts for this domain
        const facts = Array.isArray(parent.competitorFacts) ? [...parent.competitorFacts] : [];
        const factIdx = facts.findIndex((f) => {
          try { return new URL(f?.url || '').hostname.replace(/^www\./i, '') === domain; }
          catch { return (f?.domain || '') === domain; }
        });
        if (freshFacts && !freshFacts.error) {
          if (factIdx >= 0) facts[factIdx] = freshFacts;
          else facts.unshift(freshFacts);
        }
        const table = parent.tableMarkdown || splitObjectionsBlock(parent.resultRef || '').table;
        const resultRef = merged.length ? table + '\n' + renderObjectionsMarkdown(merged) : table;
        const updatedHistoryId = parent.historyId
          ? (await updateHistoryEntry(parent.historyId, resultRef)) || parent.historyId
          : await saveToHistoryWorker('Competitor Battle Card (re-verified)', resultRef, 'compare', tokensRef.value);
        // clear the change flag: this domain is now the baseline again
        try {
          const ms = await getMonitorState(chrome.storage.local);
          if (ms.competitors[domain]) {
            ms.competitors[domain] = {
              ...ms.competitors[domain],
              changesDetected: 0,
              lastCheck: Date.now(),
              lastFacts: freshFacts && !freshFacts.error
                ? { pricing: freshFacts.pricing || null, positioning: freshFacts.positioning || null }
                : (ms.competitors[domain].lastFacts || null),
            };
            await saveMonitorState(chrome.storage.local, ms);
          }
          const remaining = Object.values(ms.competitors).filter((s) => (s?.changesDetected || 0) > 0).length;
          await setMonitorBadge(remaining);
        } catch (e) {}
        const updated = await updateJobAndBroadcast(jobId, {
          objections: merged,
          competitorFacts: facts,
          tableMarkdown: table,
          resultRef,
          historyId: updatedHistoryId || undefined,
          tokensUsed: tokensRef.value,
          verifiedAt: Date.now(),
          progress: { step: 'Complete', percent: 100 },
          successSummary: `Re-verified ${domain}: ${merged.length} objection(s), ${staleCount} stale flagged.`,
        });
        broadcast({ type: 'JOB_DONE', jobId });
        sendResponse({ ok: true, job: updated, staleCount });
      } catch (e) {
        sendResponse({ error: e?.message || 'Re-verify failed' });
      }
    })();
    return true;
  }

  if (request.type === 'SET_API_KEY') {
    (async () => {
      try {
        sessionApiKey = String(request.apiKey || '').trim();
        userSettings.apiKey = sessionApiKey;
        await persistUserSettings();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ error: e.message || 'Failed to store API key.' });
      }
    })();
    return true;
  }

  if (request.type === 'GET_API_KEY') {
    sendResponse({ apiKey: userSettings.apiKey || '' });
    return true;
  }

  if (request.type === 'WORKFLOW_GET_STATE') {
    chrome.storage.local.get(['workflowState'], (data) => {
      sendResponse({ state: data.workflowState || { ...DEFAULT_WORKFLOW_STATE } });
    });
    return true;
  }

  if (request.type === 'WORKFLOW_SET_RECORDING') {
    chrome.storage.local.set({
      workflowState: {
        recording: request.recording,
        recordedSteps: [],
        status: request.status,
        tabId: request.tabId ?? null
      }
    });
    sendResponse({ ok: true });
    return true;
  }

  if (request.type === 'WORKFLOW_SAVE_STEPS') {
    chrome.storage.local.get(['workflowState'], (data) => {
      const state = data.workflowState || { ...DEFAULT_WORKFLOW_STATE };
      const steps = Array.isArray(request.steps) ? request.steps : [];
      const next = {
        ...state,
        recording: false,
        tabId: null,
        recordedSteps: steps,
        status: steps.length ? `Recorded ${steps.length} steps.` : 'No steps captured.'
      };
      chrome.storage.local.set({ workflowState: next });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (request.type === 'WORKFLOW_SYNC_STEPS') {
    chrome.storage.local.get(['workflowState'], (data) => {
      const state = data.workflowState || { ...DEFAULT_WORKFLOW_STATE };
      const next = {
        ...state,
        recording: true,
        tabId: request.tabId ?? state.tabId ?? null,
        recordedSteps: Array.isArray(request.steps) ? request.steps : state.recordedSteps,
        status: request.status || state.status || 'Recording...'
      };
      chrome.storage.local.set({ workflowState: next });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (request.type === 'WORKFLOW_CLEAR') {
    chrome.storage.local.set({ workflowState: { ...DEFAULT_WORKFLOW_STATE } });
    sendResponse({ ok: true });
    return true;
  }

  if (request.type === 'AUTOFILL_START') {
    (async () => {
      try {
        const tabId = Number(request.tabId);
        const actions = Array.isArray(request.actions) ? request.actions : [];
        if (!tabId || !actions.length) {
          sendResponse({ error: 'Invalid autofill job payload.' });
          return;
        }
        const jobId = request.jobId || `af_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const job = {
          jobId,
          tabId,
          actions,
          index: 0,
          status: 'running',
          results: [],
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        autofillJobs.set(jobId, job);
        await chrome.storage.local.set({ lastAutofillJob: job });
        runAutofillJob(jobId).catch(async (e) => {
          const failed = autofillJobs.get(jobId);
          if (!failed) return;
          failed.status = 'error';
          failed.error = e?.message || 'Autofill job failed.';
          failed.updatedAt = Date.now();
          await chrome.storage.local.set({ lastAutofillJob: failed });
        });
        sendResponse({ ok: true, jobId });
      } catch (e) {
        sendResponse({ error: e?.message || 'Failed to start autofill job.' });
      }
    })();
    return true;
  }

  if (request.type === 'AUTOFILL_STATUS') {
    (async () => {
      const jobId = String(request.jobId || '');
      if (!jobId) {
        sendResponse({ error: 'jobId is required.' });
        return;
      }
      const memoryJob = autofillJobs.get(jobId);
      if (memoryJob) {
        sendResponse({ job: memoryJob });
        return;
      }
      const data = await chrome.storage.local.get(['lastAutofillJob']);
      const stored = data.lastAutofillJob;
      if (stored?.jobId === jobId) {
        sendResponse({ job: stored });
        return;
      }
      sendResponse({ error: 'Autofill job not found.' });
    })();
    return true;
  }

  if (request.type === 'START_MONITOR_ALARM') {
    chrome.alarms.create('monitor_' + request.monitorId, {
      delayInMinutes: request.intervalMinutes || 60,
      periodInMinutes: request.intervalMinutes || 60
    });
    sendResponse({ ok: true });
    return true;
  }

  if (request.type === 'STOP_MONITOR_ALARM') {
    chrome.alarms.clear('monitor_' + request.monitorId);
    sendResponse({ ok: true });
    return true;
  }

  if (request.type === 'SAVE_REPORT') {
    chrome.storage.local.get(['researchHistory'], (data) => {
      const history = data.researchHistory || [];
      history.unshift({
        id: Date.now(),
        topic: request.payload.topic,
        report: request.payload.report,
        type: request.payload.type || 'company',
        savedAt: request.payload.savedAt || new Date().toLocaleString(),
        url: request.payload.url || '',
        preview: (request.payload.report || '').replace(/[=\n]/g, ' ').substring(0, 120),
        date: Date.now()
      });
      if (history.length > 100) history.pop();
      chrome.storage.local.set({ researchHistory: history });
    });
    sendResponse({ ok: true });
    return true;
  }

  if (request.type === 'GET_USER_SETTINGS') {
    sendResponse({ settings: { ...userSettings, isPro: isProActive() } });
    return true;
  }

  if (request.type === 'SAVE_USER_SETTINGS') {
    userSettings = sanitizeUserSettings(request.settings);
    sessionApiKey = userSettings.apiKey || '';
    persistUserSettings().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ error: e.message }));
    return true;
  }

  if (request.type === 'VERIFY_LICENSE') {
    (async () => {
      const licenseKey = String(request.licenseKey || '').trim();
      if (!licenseKey) {
        sendResponse({ ok: false, reason: 'License key is required.' });
        return;
      }
      try {
        const res = await fetch('https://atomai.pro/api/license/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ licenseKey, extensionId: chrome.runtime.id })
        });
        const data = await res.json().catch(() => ({}));
        const active = !!data?.active;
        userSettings.licenseKey = licenseKey;
        userSettings.licenseStatus = active ? 'active' : 'inactive';
        userSettings.licenseExpiresAt = Number(data?.expiresAt || 0) || 0;
        userSettings.isPro = active;
        await persistUserSettings();
        sendResponse({ ok: active, reason: active ? '' : (data?.reason || 'License is not active.') });
      } catch (e) {
        await appendDebugLog({
          scope: 'license',
          level: 'error',
          message: e.message || 'License verification failed'
        });
        sendResponse({ ok: false, reason: e.message || 'License verification failed.' });
      }
    })();
    return true;
  }

  if (request.type === 'INCREMENT_CALL_COUNT') {
    enforceQuotaAndIncrement()
      .then((result) => {
        if (!result.allowed) {
          sendResponse({ error: result.reason, count: quotaState.count });
          return;
        }
        sendResponse({ count: quotaState.count });
      })
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }

  if (request.type === 'LOG_DEBUG') {
    appendDebugLog({
      scope: request.scope || 'ui',
      level: request.level || 'error',
      message: request.message || '',
      detail: request.detail || null
    }).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ error: e.message }));
    return true;
  }

  if (request.type === 'GET_DEBUG_LOG') {
    chrome.storage.local.get(['debugLog'], (data) => {
      sendResponse({ logs: Array.isArray(data.debugLog) ? data.debugLog : [] });
    });
    return true;
  }

  if (request.type === 'CLEAR_DEBUG_LOG') {
    chrome.storage.local.remove(['debugLog']).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ error: e.message }));
    return true;
  }

  // ---- Win/Loss capture ----
  if (request.type === 'WIN_LOSS_SUBMIT') {
    (async () => {
      try {
        const competitor = String(request.competitor || '').toLowerCase().trim();
        const outcome = String(request.outcome || '').toLowerCase();
        const why = String(request.why || '').trim();
        const cardVersion = String(request.cardVersion || '').trim();
        if (!competitor || (outcome !== 'won' && outcome !== 'lost')) {
          sendResponse({ error: 'competitor and outcome (won|lost) required' });
          return;
        }
        await addWinLoss(chrome.storage.local, { competitor, outcome, why, cardVersion });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  // ---- Phase 8: trigger moment ----
  if (request.type === 'TRIGGER_CHECK') {
    (async () => {
      try {
        const data = await chrome.storage.local.get(['jobs', 'userSettings', 'triggerDismissals']);
        const decision = triggerDecideBanner({
          url: String(request.url || ''),
          hostname: String(request.hostname || ''),
          ownProductUrl: (data.userSettings && data.userSettings.ownProductUrl) || '',
          dismissals: data.triggerDismissals || {},
          jobs: Array.isArray(data.jobs) ? data.jobs : [],
          now: Date.now()
        });
        sendResponse(decision);
        // Phase 8-closer: funnel — banner shown (once/domain/day by dismissal cap).
        if (decision.show) {
          try { await analytics.track('trigger_banner_shown', { domain: decision.competitor }); } catch (e) {}
        }
      } catch (e) {
        sendResponse({ show: false, reason: 'error' });
      }
    })();
    return true;
  }

  if (request.type === 'TRIGGER_DISMISS') {
    (async () => {
      try {
        const domain = String(request.domain || '').toLowerCase();
        if (domain) {
          const data = await chrome.storage.local.get(['triggerDismissals']);
          const dismissals = data.triggerDismissals || {};
          dismissals[domain] = normalizeDateKey(); // once per domain per day
          const keys = Object.keys(dismissals);
          if (keys.length > 200) {
            for (const k of keys.slice(0, keys.length - 200)) delete dismissals[k];
          }
          await chrome.storage.local.set({ triggerDismissals: dismissals });
        }
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  if (request.type === 'TRIGGER_OPEN_CARD') {
    (async () => {
      try {
        const jobId = String(request.jobId || '');
        await chrome.storage.local.set({ openCardRequest: { jobId, domain: String(request.domain || ''), ts: Date.now() } });
        // popup opens via chrome.action.openPopup() if available, else badge + click
        let opened = false;
        try {
          if (chrome.action?.openPopup) { await chrome.action.openPopup(); opened = true; }
        } catch (e) {}
        if (!opened) {
          try {
            if (chrome.action?.setBadgeText) {
              await chrome.action.setBadgeBackgroundColor({ color: '#7b6eff' });
              await chrome.action.setBadgeText({ text: '⚔' });
            }
          } catch (e) {}
        }
        sendResponse({ ok: true, opened });
        // Phase 8-closer: funnel — banner clicked.
        try { await analytics.track('trigger_banner_clicked', { domain: String(request.domain || '') }); } catch (e) {}
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  return false;
});
hydrateState().catch(() => {});
// on startup, ensure heartbeat reflects any orphan running jobs (MV3 restart) and resume them
getJobs().then(async jobs => {
  const running = jobs.filter(j=>j.status===JobStatus.RUNNING);
  if (running.length) {
    startHeartbeat(running[0].id);
    // resume each running job (handles SW idle kill mid-job)
    for (const j of running) {
      // avoid duplicate run if cancelRequested already handled
      if (j.cancelRequested) {
        await updateJobAndBroadcast(j.id, { status: JobStatus.CANCELED, progress:{step:'Canceled', percent:100} });
        continue;
      }
      if (j.type===JobType.BATTLECARD) runBattleCardJob(j.id).catch(()=>{});
      else if (j.type===JobType.MULTITAB) runMultitabJob(j.id).catch(()=>{});
      else if (j.type===JobType.DEALROOM) runDealRoomJob(j.id).catch(()=>{});
    }
  }
}).catch(()=>{});

// Auto Task: if the SW was killed mid-run, storage still says "running" (or a
// pending approval was waiting). Re-kick the loop / re-check the approval.
autoTask.rehydrate().catch(() => {});

// Feature 6: toolbar click opens the persistent side panel (Chrome 114+);
// older Chrome gets the popup restored as the click target instead.
initSidePanel(chrome).catch(() => {});
