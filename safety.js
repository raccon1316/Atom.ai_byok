// safety.js — Phase 4: action risk classification + run caps + domain
// blocklist for Auto Task.
//
// Pure + dependency-free (Node-testable). Every planner action passes
// through classifyAction before execution:
//   safe    → auto-run (navigate, read, extract, scroll, hover)
//   confirm → inline Approve/Deny in the popup, 60s timeout = deny
//   blocked → never auto-run; always handed to the user
//
// The risk boundary is deliberately conservative: anything that spends
// money, sends a message, deletes data, submits a form, enters credentials,
// or touches a blocked domain is confirm or blocked.

export const RISK = { SAFE: 'safe', CONFIRM: 'confirm', BLOCKED: 'blocked' };

// Per-run caps (mirror the legacy agent loop's defaults).
export const MAX_STEPS = 25;
export const MAX_DURATION_MS = 5 * 60 * 1000;
export const APPROVAL_TIMEOUT_MS = 60 * 1000;

// Cost metering: every Auto Task run consumes quota at this multiplier
// (1 run = 25 AI-call equivalents by default).
export const AUTO_TASK_CALL_MULTIPLIER = 25;

// Default blocklist: banking/payment domains never see autonomous actions.
// User-editable in Settings (stored as autoTaskBlockedDomains).
export const DEFAULT_BLOCKED_DOMAINS = [
  'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citi.com',
  'capitalone.com', 'americanexpress.com', 'usbank.com', 'hsbc.com',
  'barclays.co.uk', 'icicibank.com', 'hdfcbank.com', 'sbi.co.in',
  'paypal.com', 'paypal.me', 'stripe.com', 'checkout.com',
  'coinbase.com', 'binance.com', 'kraken.com', 'cash.app', 'venmo.com'
];

// Submission/irreversible vocabulary — a click whose target text matches
// these is at least confirm-level.
const SUBMIT_WORDS = /^(sign[\s-]?in|log[\s-]?in|login|register|sign[\s-]?up|submit|confirm|agree|accept|i agree|place (my )?order|complete (purchase|order)|buy now|subscribe|continue to (payment|checkout)|book( now)?|reserve|send|post|publish|delete|remove|unlink|disconnect|authorize|allow|grant|download|export|apply|save changes|update|upgrade|pay)$/i;

const SEND_WORDS = /(send|share|invite|post|publish|tweet|message|email|reply|forward)/i;
const DELETE_WORDS = /(delete|remove|trash|erase|clear|cancel (order|subscription|booking|account)|unsubscribe|deactivate)/i;
const PAY_WORDS = /(checkout|place (my )?order|complete (your )?(purchase|order)|pay(ment)? now|proceed to (payment|checkout)|confirm (and )?pay|buy now|add payment|billing address|credit card|debit card)/i;
const CAPTCHA_WORDS = /(captcha|are you (a )?robot|verify (that )?you('| a)re? human|not a robot)/i;
const CREDENTIAL_WORDS = /(password|passcode|pin|otp|one[- ]time (code|password)|security code|cvv|cvc|card number|credit card|debit card|social security|ssn)/i;

// A typed value shaped like sensitive data (16-digit card, CVV-ish field).
const CARD_NUMBER_RE = /^[\s-]*(\d[ -]*){13,19}$/;

// classifyAction({kind, name, url, value, isPassword, targetUrl, blocklist}) →
//   {risk, reason, approval?}
// kind: navigate | click | type | select | pressKey | scroll | scrollRef |
//       hover | snapshot | readPage | extract | download | switchTab |
//       closeTab | askUserForHelp | done
// url      = the page the action happens on (context)
// targetUrl = for kind 'navigate', the DESTINATION being navigated to
// blocklist = domains the run must never touch (defaults to DEFAULT_BLOCKED_DOMAINS)
export function classifyAction(a = {}) {
  const kind = String(a.kind || '').toLowerCase();
  const name = String(a.name || '').trim();
  const url = String(a.url || '').toLowerCase();
  const value = String(a.value == null ? '' : a.value);

  // Hard blocks first — these never auto-run.
  if (a.isPassword || CREDENTIAL_WORDS.test(name) || /input\[type=["']?password/i.test(String(a.selector || ''))) {
    return {
      risk: RISK.BLOCKED,
      reason: 'password-or-credential-field',
      message: 'Atom.AI never auto-fills passwords or payment credentials. Enter them yourself, then press Resume.'
    };
  }
  if (CAPTCHA_WORDS.test(name) || CAPTCHA_WORDS.test(url)) {
    return {
      risk: RISK.BLOCKED,
      reason: 'captcha',
      message: 'Solve the CAPTCHA in the tab, then press Resume.'
    };
  }
  if (PAY_WORDS.test(name) || /\/(checkout|payment|pay)\b/.test(url) && (kind === 'click' || kind === 'type')) {
    return {
      risk: RISK.BLOCKED,
      reason: 'payment-or-checkout',
      message: `Payment actions are never autonomous. This needs you: ${describeApproval({ kind, name, url })}`
    };
  }
  if (CARD_NUMBER_RE.test(value) || /^\d{3,4}$/.test(value) && /cvv|cvc|security code|csc/i.test(name)) {
    return {
      risk: RISK.BLOCKED,
      reason: 'sensitive-value',
      message: 'That value looks like payment credentials. Enter it yourself.'
    };
  }

  // Navigation: the DESTINATION must be off the blocklist, not just the page the
  // run started on. A run that legitimately starts on a clean page can otherwise
  // be navigated straight into a banking/payment domain by the planner.
  if (kind === 'navigate') {
    const params = (a.params && typeof a.params === 'object') ? a.params : {};
    const destination = resolveNavigateUrl(a.targetUrl || params.url || '');
    const blocklist = Array.isArray(a.blocklist) ? a.blocklist : DEFAULT_BLOCKED_DOMAINS;
    if (destination && isDomainBlocked(destination, blocklist)) {
      return {
        risk: RISK.BLOCKED,
        reason: 'blocked-domain',
        message: `${hostOf(destination)} is on your Auto Task blocklist — navigation refused. Edit the list in Settings.`
      };
    }
    return { risk: RISK.SAFE, reason: 'navigate' };
  }

  // Confirm-level: irreversible or outward-facing.
  if (kind === 'download' || kind === 'closetab') {
    return { risk: RISK.CONFIRM, reason: `${kind}-action` };
  }
  if (kind === 'type' || kind === 'select') {
    // Typing text itself is safe: credential/sensitive values and payment
    // contexts were caught above, and the risky path always ends in a
    // submit-button click (caught below) — a typed Enter is navigation.
    return { risk: RISK.SAFE, reason: 'fill-field' };
  }
  if (kind === 'click') {
    if (DELETE_WORDS.test(name)) return { risk: RISK.CONFIRM, reason: 'delete-action' };
    if (SEND_WORDS.test(name)) return { risk: RISK.CONFIRM, reason: 'send-action' };
    if (SUBMIT_WORDS.test(name)) return { risk: RISK.CONFIRM, reason: 'form-submit' };
    return { risk: RISK.SAFE, reason: 'click' };
  }
  if (kind === 'pressKey' && a.key === 'Enter' && a.onFormSubmit) {
    return { risk: RISK.CONFIRM, reason: 'form-submit' };
  }

  // Everything else (navigate, scroll, hover, snapshot, read, extract, ask,
  // done, plain Enter) is safe.
  return { risk: RISK.SAFE, reason: kind || 'action' };
}

// Human-readable one-liner for the approval card — the exact action, no
// surprises. e.g. "Click 'Place order' on amazon.in".
export function describeApproval({ kind, name, url, value } = {}) {
  const host = safeHost(url);
  const what = String(name || value || '').trim().slice(0, 60);
  switch (String(kind || '').toLowerCase()) {
    case 'click': return `Click "${what || '(element)'}"${host ? ` on ${host}` : ''}`;
    case 'type': return `Type "${String(value || '').slice(0, 40)}"${what ? ` into "${what}"` : ''}${host ? ` on ${host}` : ''}`;
    case 'select': return `Select "${String(value || '').slice(0, 40)}" in "${what}"${host ? ` on ${host}` : ''}`;
    case 'download': return `Download a file${host ? ` from ${host}` : ''}`;
    case 'closeTab': return `Close the tab${host ? ` (${host})` : ''}`;
    default: return `${kind || 'Act'}${what ? `: ${what}` : ''}${host ? ` on ${host}` : ''}`;
  }
}

function safeHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

// ---- domain blocklist -------------------------------------------------------

// Friendly-name shortcuts the planner may emit for navigate (shared by the
// safety classifier and the executor so both reason about the same URL).
export const NAVIGATE_ALIASES = {
  youtube: 'https://www.youtube.com',
  google: 'https://www.google.com',
  reddit: 'https://www.reddit.com',
  github: 'https://www.github.com',
  amazon: 'https://www.amazon.com'
};

// 'google' → 'https://www.google.com', 'x.test/a' → 'https://x.test/a'.
export function resolveNavigateUrl(raw) {
  let url = String(raw == null ? '' : raw).trim();
  if (!url) return '';
  const key = url.toLowerCase().replace(/^https?:\/\//, '').replace('www.', '').split('.')[0];
  if (NAVIGATE_ALIASES[key]) url = NAVIGATE_ALIASES[key];
  if (!url.startsWith('http')) url = 'https://' + url;
  return url;
}

export function normalizeDomain(d) {
  return String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; }
}

// Suffix match: 'bank.chase.com' is blocked by 'chase.com'.
export function isDomainBlocked(url, blocklist) {
  const host = hostOf(url);
  if (!host) return false;
  for (const raw of blocklist || []) {
    const d = normalizeDomain(raw);
    if (!d) continue;
    if (host === d || host.endsWith(`.${d}`)) return true;
  }
  return false;
}

// ---- blocklist editing (pure, so the Settings UI stays a thin DOM shell) ---

// A plain domain only: at least one dot, no protocol, no path, no spaces, no
// port, no scheme-relative form. Deliberately stricter than normalizeDomain,
// which is permissive because it only has to handle values already stored.
const DOMAIN_RE = /^(?=.{4,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export function validateDomain(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { ok: false, domain: '', error: 'Enter a domain, e.g. example.com' };
  if (/\s/.test(raw)) return { ok: false, domain: '', error: 'A domain cannot contain spaces' };
  if (/^[a-z]+:\/\//i.test(raw) || raw.startsWith('//')) {
    return { ok: false, domain: '', error: 'Enter just the domain — no http:// or https://' };
  }
  if (raw.includes('/') || raw.includes('?') || raw.includes('#')) {
    return { ok: false, domain: '', error: 'Enter just the domain — no path' };
  }
  if (raw.includes(':')) return { ok: false, domain: '', error: 'Enter just the domain — no port' };
  if (raw.includes('@')) return { ok: false, domain: '', error: 'Enter just the domain — no email address' };
  const domain = normalizeDomain(raw);
  if (!DOMAIN_RE.test(domain)) {
    return { ok: false, domain: '', error: `"${raw}" is not a valid domain (try example.com)` };
  }
  return { ok: true, domain, error: '' };
}

// The effective list: built-in defaults plus the user's additions, deduped,
// defaults first. Every consumer must go through this so "the domain the UI
// shows as blocked" and "the domain the runner refuses" cannot diverge. Both the
// service worker (getAutoTaskBlockedDomains) and the Settings editor call this —
// that shared call is what makes the blocklist honest end to end.
export function mergeBlocklist(custom, defaults = DEFAULT_BLOCKED_DOMAINS) {
  const out = [];
  const seen = new Set();
  for (const raw of [...(Array.isArray(defaults) ? defaults : []), ...(Array.isArray(custom) ? custom : [])]) {
    const d = normalizeDomain(raw);
    if (d && !seen.has(d)) { seen.add(d); out.push(d); }
  }
  return out;
}

export function isDefaultDomain(domain, defaults = DEFAULT_BLOCKED_DOMAINS) {
  const d = normalizeDomain(domain);
  return (Array.isArray(defaults) ? defaults : []).map(normalizeDomain).includes(d);
}

// Add a custom domain. Returns the NEW custom list; built-ins are never written
// into storage because mergeBlocklist re-adds them anyway.
export function addDomain(customList, input, defaults = DEFAULT_BLOCKED_DOMAINS) {
  const check = validateDomain(input);
  if (!check.ok) return { ok: false, list: Array.isArray(customList) ? customList.slice() : [], reason: check.error };
  const list = Array.isArray(customList) ? customList.map(normalizeDomain).filter(Boolean) : [];
  if (list.includes(check.domain)) {
    return { ok: false, list, reason: `${check.domain} is already on the blocklist`, duplicate: true };
  }
  if (isDefaultDomain(check.domain, defaults)) {
    return { ok: false, list, reason: `${check.domain} is already blocked by default`, duplicate: true };
  }
  list.push(check.domain);
  return { ok: true, list, reason: `${check.domain} added`, duplicate: false };
}

export function removeDomain(customList, domain, defaults = DEFAULT_BLOCKED_DOMAINS) {
  const d = normalizeDomain(domain);
  const list = Array.isArray(customList) ? customList.map(normalizeDomain).filter(Boolean) : [];
  if (isDefaultDomain(d, defaults)) {
    // Refusing loudly: background.js re-merges the defaults on every read, so
    // pretending to remove one would leave it blocked while the UI said it was gone.
    return { ok: false, list, reason: `${d} is built in and cannot be removed`, removed: false };
  }
  const next = list.filter(x => x !== d);
  return {
    ok: true,
    list: next,
    reason: next.length === list.length ? `${d} was not on the list` : `${d} removed`,
    removed: next.length !== list.length
  };
}

// Run-start preflight: goal URL (and starting page) must be off the
// blocklist, else the run refuses before any action.
export function preflight({ url, blocklist } = {}) {
  if (isDomainBlocked(url, blocklist)) {
    return {
      allowed: false,
      reason: `blocked-domain: ${hostOf(url)}`,
      message: 'This domain is on your Auto Task blocklist (banking/payment sites are blocked by default). Edit the list in Settings.'
    };
  }
  return { allowed: true, reason: '' };
}

// ---- approval lifecycle -----------------------------------------------------

export function createApproval({ id, action, description, risk = RISK.CONFIRM, ts = Date.now() }) {
  return {
    id, action, description, risk, ts,
    status: 'pending',               // pending | approved | denied | timeout
    decidedAt: null
  };
}

export function resolveApproval(approval, decision, ts = Date.now()) {
  if (!approval || approval.status !== 'pending') return false;
  const timedOut = ts - approval.ts > APPROVAL_TIMEOUT_MS;
  approval.status = timedOut && decision === 'approved' ? 'timeout' : decision;
  approval.decidedAt = ts;
  return approval.status !== 'timeout';
}

export function isApprovalTimedOut(approval, ts = Date.now()) {
  return approval && approval.status === 'pending' && (ts - approval.ts) > APPROVAL_TIMEOUT_MS;
}
