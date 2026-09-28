// objection-lib.js — first-class objection extraction for battle cards.
// Pipeline: searchNews(domain) + fetchPageSet for /docs, /faq, /compare pages
// (discovery patterns below include "compare" and "vs-" — competitors often
// host gold like "/compare/acme-vs-us"), then one strict-schema extraction
// call (2000 tokens), then cross-reference rebuttals against YOUR proof
// points (profile.js). Items with no fitting proof point are marked
// "needs your input" for the user to edit.
//
// Pure + dependency-free: works in the extension SW and in Node tests.
// No chrome.* here — the SW supplies page text/links/ai.chat.

import { matchProofPoints } from './profile.js';

// Discovery patterns for objection-rich pages. NOTE (deviation log):
// no pre-existing discovery regexes were found in the codebase, so this
// module CREATES them — including the required "compare" and "vs-" patterns.
export const DOC_PATTERNS = [
  /\/docs(\/|$|\?|#)/i,
  /\/faq/i,
  /\/compare/i,
  /\/vs-/i,
  /\/alternatives/i,
  /\/competitors/i,
];

export const MAX_DOC_PAGES = 3;

function sameSite(url, domain) {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
    const d = String(domain || '').toLowerCase();
    return host === d || host.endsWith('.' + d);
  } catch {
    return false;
  }
}

function isHttpUrl(s) {
  return /^https?:\/\//i.test(String(s || ''));
}

// Filter harvested links to same-domain docs/faq/compare pages.
// links: array of url strings. Returns deduped absolute https URLs, capped.
export function discoverDocsUrls(domain, links) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(links) ? links : []) {
    const url = String(raw || '').split('#')[0].trim();
    if (!isHttpUrl(url) || !sameSite(url, domain)) continue;
    let path = '';
    try { path = new URL(url).pathname || ''; } catch { continue; }
    if (!DOC_PATTERNS.some((re) => re.test(path))) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
    if (out.length >= MAX_DOC_PAGES) break;
  }
  return out;
}

// Canonical guesses when the homepage yields no doc links.
export function candidateDocUrls(domain) {
  const d = String(domain || '').replace(/^www\./i, '');
  if (!d) return [];
  return [`https://${d}/docs`, `https://${d}/faq`, `https://${d}/compare`];
}

export function buildObjectionPrompt({ domain, pagesText, profile }) {
  const proofLines = (profile?.proofPoints || [])
    .map((p, i) => `${i + 1}. claim: ${p.claim}${p.metric ? ` | metric: ${p.metric}` : ''}`)
    .join('\n');
  return `OBJECTION-EXTRACTION. Competitor domain: ${domain}. Extract the objections THEIR reps raise about competitors like us, from their own docs/faq/compare pages below. Return ONLY a JSON object with this exact schema:
{ "objections": [{ "objection": string, "theirClaim": string, "counterArgument": string, "sourceUrl": string, "quote": string, "confidence": "high"|"medium"|"low" }] }

HARD RULES:
- 3+ items when the pages support it; fewer (even []) when they don't — never invent objections.
- sourceUrl MUST be one of the SOURCE URLs below (the page the claim came from). Omit any item you cannot source.
- quote MUST be a verbatim substring (≤200 chars) of that page's text.
- counterArgument: rebut from OUR proof points when one fits, else write your best rebuttal anyway (it will be flagged for review).
- Keep each text value under 220 chars.

OUR PROOF POINTS (cite these in counters when they fit):
${proofLines || '(none configured)'}

SOURCE PAGES:
${String(pagesText || '').substring(0, 9000)}`;
}

export function parseObjections(raw) {
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('unparseable: no JSON object in objection response');
  let parsed;
  try {
    parsed = JSON.parse(m[0]);
  } catch (e) {
    throw new Error('unparseable: invalid JSON in objection response');
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.objections)) {
    throw new Error('unparseable: missing objections array');
  }
  return parsed.objections;
}

// 'verified from their docs' when the source URL itself is a docs/faq/compare
// page on the competitor domain AND carries a non-empty quote; else 'inferred'.
export function markVerified(items, domain) {
  return (Array.isArray(items) ? items : []).map((item) => {
    const url = String(item?.sourceUrl || '');
    let onDocs = false;
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./i, '').toLowerCase();
      const d = String(domain || '').toLowerCase();
      onDocs = (host === d || host.endsWith('.' + d)) && DOC_PATTERNS.some((re) => re.test(u.pathname || ''));
    } catch { onDocs = false; }
    const verified = onDocs && String(item?.quote || '').trim().length > 0;
    return { ...item, verification: verified ? 'verified' : 'inferred' };
  });
}

// Rebuttals must cite YOUR proof points: attach the matched proof point, or
// mark needsInput when none fits (user edits the counter in the popup).
export function crossReference(items, profile) {
  return (Array.isArray(items) ? items : []).map((item) => {
    const proof = matchProofPoints(`${item?.counterArgument || ''} ${item?.theirClaim || ''}`, profile);
    if (proof) return { ...item, proofRef: proof, needsInput: false };
    return { ...item, proofRef: null, needsInput: true };
  });
}

// Markdown block appended to the battle-card resultRef (history-compatible).
export const OBJECTIONS_MARKER = '## ⚔️ Objections & Rebuttals';

export function renderObjectionsMarkdown(items) {
  const L = ['', '---', '', `## ⚔️ Objections & Rebuttals`, ''];
  if (!items?.length) {
    L.push('_No sourced objections found on their docs pages._');
    return L.join('\n');
  }
  for (const o of items) {
    const tag = o.verification === 'verified' ? 'verified from their docs' : 'inferred';
    const need = o.needsInput ? ' — ⚠️ needs your input' : '';
    const stale = o.stale ? ' — (stale — not seen in latest check)' : '';
    const proof = o.proofRef?.claim ? ` Our proof: ${o.proofRef.claim}${o.proofRef.metric ? ` (${o.proofRef.metric})` : ''}.` : '';
    const link = (() => {
      try {
        const domain = new URL(o.sourceUrl).hostname.replace(/^www\./i, '');
        return `[source: ${domain}](${o.sourceUrl})`;
      } catch { return `[source](${o.sourceUrl})`; }
    })();
    L.push(`- **${o.objection}** (${tag}${need}${stale})`);
    L.push(`  - Their claim: ${o.theirClaim || 'n/a'}`);
    L.push(`  - Counter: ${o.counterArgument || 'n/a'}.${proof} ${link}`);
    if (o.quote) L.push(`  - Quote: “${String(o.quote).substring(0, 200)}”`);
  }
  return L.join('\n');
}

// Split a composed resultRef back into {table, hasBlock}.
export function splitObjectionsBlock(resultRef) {
  const text = String(resultRef || '');
  const idx = text.indexOf(`\n\n---\n\n${OBJECTIONS_MARKER}`);
  if (idx === -1) return { table: text, hasBlock: false };
  return { table: text.substring(0, idx), hasBlock: true };
}
