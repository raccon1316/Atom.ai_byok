// recovery.js — Phase 2: strategy-escalation retry, Set-of-Mark vision
// fallback plumbing, and hostile-environment detection.
//
// Pure + dependency-free (Node-testable), same convention as multitab.js /
// triage.js. The execution orchestration that consumes this lives in
// agent-tools.js (executeWithRecovery); the vision LLM call is injected by
// the runner. Vision is counted at 3× call cost in metering (see autotask.js
// VISION_CALL_COST).

import { descriptorFor, reground as groundR, normalizeName } from './grounding.js';

export const MAX_ATTEMPTS_PER_ACTION = 3;
export const MAX_VISION_CALLS = 2;
export const VISION_CALL_COST = 3; // metering multiplier per vision call

// Escalation ladder. Ordered per spec: re-snapshot+reground → alternative
// grounding → waitForQuiet + retry → Set-of-Mark vision → give up and report.
//
// Reason-sensitive start position: grounding-exhaustive failures (ambiguous,
// not-found) skip straight to vision; pure staleness starts at the top.
export function nextStrategy(reason, { attempt, visionCalls } = {}) {
  const a = attempt || 0;
  const v = visionCalls || 0;
  if (reason === 'AMBIGUOUS' || reason === 'NOT_FOUND') {
    return v < MAX_VISION_CALLS ? 'VISION' : 'GIVE_UP';
  }
  if (reason === 'DISABLED' || reason === 'PASSWORD_FIELD' || reason === 'NOT_EDITABLE') {
    // A disabled control can appear once hydration finishes; a password or
    // non-editable target never becomes actionable by retrying. Only the
    // DISABLED case is worth one quiet-wait.
    return reason === 'DISABLED' && a === 0 ? 'WAIT_QUIET' : 'GIVE_UP';
  }
  if (a === 0) return 'REGROUND';
  if (a === 1) return 'ALT_NAME';
  if (a === 2) return 'WAIT_QUIET';
  if (v < MAX_VISION_CALLS) return 'VISION';
  return 'GIVE_UP';
}

// Re-match the ref's descriptor in a fresh snapshot. Records come from the
// new snapshot's byRef (keyed by ref). Returns the new ref or null.
export function regroundRef(prevSnapshot, ref, freshSnapshot, { crossRole = false } = {}) {
  const desc = descriptorFor(prevSnapshot, ref);
  if (!desc || !freshSnapshot || !freshSnapshot.byRef) return null;
  const records = Object.entries(freshSnapshot.byRef)
    .map(([r, rec]) => ({ ref: r, role: rec.role, name: rec.name, path: rec.path }));
  const hit = groundR(desc, records);
  if (hit) return hit.ref;
  if (crossRole) {
    // Alternative grounding: same identity via a different role (aria-label
    // on a div vs a real button). Name must match exactly.
    const want = normalizeName(desc.name).toLowerCase();
    if (!want) return null;
    const exact = records.filter(r => normalizeName(r.name).toLowerCase() === want);
    if (exact.length === 1) return exact[0].ref;
  }
  return null;
}

// ---- Set-of-Mark (vision fallback) ------------------------------------
// Badge assignment: visible elements with rects, in reading order (top→bot-
// tom, left→right). Coordinates stay internal — badges are painted onto the
// page as numbered overlays, the annotated screenshot goes to the vision
// model, and only the badge number crosses the LLM boundary.
export function buildBadges(snapshot, { inViewportOnly = false, max = 60 } = {}) {
  const badges = [];
  for (const [ref, rec] of Object.entries((snapshot && snapshot.byRef) || {})) {
    if (inViewportOnly && !rec.inViewport) continue;
    if (!rec.rect || (!rec.rect.w && !rec.rect.h)) continue;
    badges.push({ ref, role: rec.role, name: rec.name, rect: rec.rect, inViewport: !!rec.inViewport });
  }
  badges.sort((a, b) => (a.rect.y - b.rect.y) || (a.rect.x - b.rect.x));
  return badges.slice(0, max).map((b, i) => ({ n: i + 1, ...b }));
}

export function buildVisionPrompt(badges, targetDescription) {
  const list = badges
    .map(b => `${b.n}. ${b.role}${b.name ? ` "${b.name}"` : ''}`)
    .join('\n');
  return [
    'You are looking at a screenshot of a web page with numbered badges drawn over interactive elements.',
    `Which badge number is: ${targetDescription}?`,
    'Badges:',
    list,
    'Answer with ONLY the badge number (a single integer). If none matches, answer 0.'
  ].join('\n');
}

// Parse the model's answer to a badge → ref. Accepts "3", "Badge 3", "#3",
// or a sentence containing the first plausible number. Out-of-range or
// garbage → null (caller treats as vision failure, never guesses).
export function parseVisionChoice(answer, badges) {
  const m = String(answer == null ? '' : answer).match(/\d{1,3}/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  if (!n) return null; // 0 = "none matches" sentinel
  const badge = (badges || []).find(b => b.n === n);
  return badge ? badge.ref : null;
}

// ---- hostile-environment detection -------------------------------------
// Pure heuristics over page text/title/url (+ optional hasPasswordField flag
// from a DOM probe). Priority: captcha > login > paywall > error > no_results.
const BLOCKER_PATTERNS = [
  { kind: 'captcha', re: /captcha|are you a robot|verify (that you are )?human|i'm not a robot|not a robot|geetest|px-captcha|recaptcha/i,
    message: 'The site is showing a CAPTCHA / anti-bot check.', userHint: 'Solve it in the tab, then press Resume.' },
  { kind: 'login', re: /sign in to continue|please (log|sign) in|log in to (view|continue)|create an account to (view|continue)|sign up to continue|login required/i,
    message: 'This page needs a login before the task can continue.', userHint: 'Log in in the tab, then press Resume.' },
  { kind: 'paywall', re: /subscribe to (read|continue|unlock)|for subscribers only|this article is (for|locked)|create a free account to (continue|read)|paywall|articles (remaining|left this month)/i,
    message: 'Content is behind a paywall.', userHint: 'Subscribe or pick a different source, then press Resume or Cancel.' },
  { kind: 'error', re: /\b404\b|page not found|server error|internal server error|\b50[0-3]\b( error)?|something went wrong/i,
    message: 'The site returned an error page.', userHint: 'Check the URL or try again later.' },
  { kind: 'no_results', re: /no results (found|for)|0 results|did not match any|nothing found|no matches (were )?found|no (products|items|flights) (found|available|match)/i,
    message: 'The page reports no results for this step.', userHint: 'Adjust the task or search terms, then Resume or Cancel.' }
];

export function detectBlockers({ url = '', title = '', text = '', hasPasswordField = false } = {}) {
  const hay = `${title}\n${text}`;
  for (const p of BLOCKER_PATTERNS) {
    if (p.re.test(hay)) {
      // "login" via generic sign-in copy only counts as a blocker when a
      // password field is actually present — otherwise it's just nav text.
      if (p.kind === 'login' && !hasPasswordField && !/sign in to continue|please (log|sign) in|login required|log in to (view|continue)|create an account to (view|continue)|sign up to continue/i.test(hay)) {
        continue;
      }
      return { blocked: true, kind: p.kind, message: p.message, userHint: p.userHint, url };
    }
  }
  if (/\/404(\b|\/)|\?error=/.test(url)) {
    const e = BLOCKER_PATTERNS.find(p => p.kind === 'error');
    return { blocked: true, kind: e.kind, message: e.message, userHint: e.userHint, url };
  }
  return { blocked: false, kind: null, message: '', userHint: '', url };
}
