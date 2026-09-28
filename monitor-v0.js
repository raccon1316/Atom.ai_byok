// monitor-v0.js — Monitoring v0: cards stay fresh without a backend.
// Pure + dependency-free helpers; the SW wires the weekly alarm, light
// fetches, extractFacts and the badge. Node-testable.
//
// Weekly refresh alarm: chrome.alarms 'weekly-refresh', periodInMinutes: 10080
// (7 days). On alarm: per saved battle-card competitor — light fetch (homepage
// + pricing only, skip blog/news) → extractFacts (pricing + positioning) →
// string-similarity compare vs stored facts → if changed: monitorState update +
// toolbar badge (chrome.action.setBadgeText — NOT chrome.notifications, that
// permission was removed in Phase 6).
//
// Rules: BYOK (user's key + quota via ai.onCall). Batch: max 3 competitors per
// run, rest next cycle. No API key → skip silently.

export const MONITOR_STATE_KEY = 'monitorState';
export const WEEKLY_REFRESH_ALARM = 'weekly-refresh';
export const WEEKLY_PERIOD_MIN = 10080; // 7 days
export const BATCH_SIZE = 3;
export const CHANGE_THRESHOLD = 0.25;      // similarity < 1-0.25 → changed
export const RECENT_CHECK_MS = 6 * 24 * 3600 * 1000; // skip competitors checked < 6d ago

// Deviation note (spec honesty): BATTLECARD_FACTS does not exist in
// data-provider.js; GOLDEN_FIELDS = ['pricing','positioning','targetAudience'].
// Monitoring compares the pricing + positioning fields of GOLDEN_FIELDS.
export const MONITORED_FIELDS = ['pricing', 'positioning'];

export function defaultMonitorState() {
  return { cursor: 0, competitors: {} };
}

// per-competitor: {lastCheck, changesDetected, lastFacts, lastChangeTs}
export async function getMonitorState(storage) {
  try {
    const data = await storage.get([MONITOR_STATE_KEY]);
    const s = data?.[MONITOR_STATE_KEY];
    if (s && typeof s === 'object') return { ...defaultMonitorState(), ...s };
  } catch (e) {}
  return defaultMonitorState();
}

export async function saveMonitorState(storage, state) {
  await storage.set({ [MONITOR_STATE_KEY]: state });
  return state;
}

function tokens(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .split(/[^a-z0-9$%./]+/)
      .filter((t) => t.length >= 3)
  );
}

// Jaccard similarity on token sets (0 = nothing shared, 1 = identical).
export function similarity(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size && !B.size) return 1;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared += 1;
  const union = A.size + B.size - shared;
  return union ? shared / union : 1;
}

// Compare one field: changed when similarity < 1 - CHANGE_THRESHOLD.
export function fieldChanged(oldVal, newVal, threshold = CHANGE_THRESHOLD) {
  const o = String(oldVal ?? '');
  const n = String(newVal ?? '');
  if (!o.trim() && !n.trim()) return false;
  if (!o.trim() || !n.trim()) return true;
  return similarity(o, n) < (1 - threshold);
}

// Which monitored fields changed between fact objects.
export function diffFacts(oldFacts, newFacts, threshold = CHANGE_THRESHOLD) {
  const changed = [];
  for (const f of MONITORED_FIELDS) {
    if (fieldChanged(oldFacts?.[f], newFacts?.[f], threshold)) changed.push(f);
  }
  return changed;
}

// Next batch of competitor domains to check: not checked within
// RECENT_CHECK_MS, cursor-based, max BATCH_SIZE per run.
export function pickBatch(domains, monitorState, now = Date.now()) {
  const list = (Array.isArray(domains) ? domains : []).filter(Boolean);
  const comps = monitorState?.competitors || {};
  const fresh = list.filter((d) => {
    const s = comps[d];
    return !s?.lastCheck || (now - s.lastCheck) >= RECENT_CHECK_MS;
  });
  if (!fresh.length) return [];
  const start = Number(monitorState?.cursor || 0) % fresh.length;
  const rotated = fresh.slice(start).concat(fresh.slice(0, start));
  return rotated.slice(0, BATCH_SIZE);
}

// Toolbar badge text when changes detected (setBadgeText caps ~4 chars).
export function changeBadgeText(changedCount) {
  const n = Number(changedCount || 0);
  return n > 0 ? '⚡' : '';
}

// Card badge line (popup HTML): "⚡ Pricing changed {N}d ago".
export function changeBadgeLine(domain, monitorState, now = Date.now()) {
  const s = monitorState?.competitors?.[String(domain || '').toLowerCase()];
  if (!s?.lastChangeTs) return null;
  const days = Math.max(1, Math.floor((now - s.lastChangeTs) / (24 * 3600 * 1000)));
  return `⚡ Pricing changed ${days}d ago`;
}