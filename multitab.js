// multitab.js — open-tab classification for multi-source pipelines (Deal Room, battle cards).
// Pure + dependency-free: works in the extension SW and in Node tests.
// No chrome.* here — callers resolve tabs first (workerGetReadableTabs / Utils.getReadableTabs).

export function normalizeDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./i, '').toLowerCase(); }
  catch { return ''; }
}

export function isUsableTabUrl(url) {
  if (!/^https?:\/\//i.test(url || '')) return false;
  return !/^(chrome|chrome-extension|about|edge|brave|devtools|view-source):/i.test(url || '');
}

// Dedupe by normalized URL (fragment stripped), preserving order.
export function dedupeTabs(tabs) {
  const seen = new Set();
  const out = [];
  for (const tab of Array.isArray(tabs) ? tabs : []) {
    const key = String(tab?.url || '').split('#')[0];
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(tab);
  }
  return out;
}

// Classify open tabs into prospect vs competitors for a Deal Room brief.
// tabs: [{id, url, title, active}] (plain objects); prospectUrl: required.
// Returns { prospect, competitors, skipped } where each entry is
// {id, url, domain, title}. Rules:
//  - prospect = first tab whose domain matches the prospect URL domain.
//  - competitors = every other usable tab with a DIFFERENT domain.
//  - skipped = unusable urls, same-domain duplicates beyond the first prospect
//    tab are folded (first wins), non-http(s) tabs.
//  - cap: callers slice competitors (default total 10 incl. prospect).
export function classifyTabs({ tabs, prospectUrl, maxTotal = 10 } = {}) {
  const prospectDomain = normalizeDomain(prospectUrl);
  const result = { prospect: null, competitors: [], skipped: [] };
  if (!prospectDomain) return result;
  const seenDomains = new Set();
  for (const tab of dedupeTabs(tabs)) {
    const url = String(tab?.url || '');
    const domain = normalizeDomain(url);
    if (!domain || !isUsableTabUrl(url)) {
      result.skipped.push({ id: tab?.id ?? null, url, domain: domain || 'unknown', title: tab?.title || '', reason: 'unreadable' });
      continue;
    }
    if (domain === prospectDomain && !result.prospect) {
      result.prospect = { id: tab?.id ?? null, url, domain, title: tab?.title || domain };
      seenDomains.add(domain);
      continue;
    }
    if (seenDomains.has(domain)) {
      result.skipped.push({ id: tab?.id ?? null, url, domain, title: tab?.title || '', reason: 'duplicate-domain' });
      continue;
    }
    seenDomains.add(domain);
    result.competitors.push({ id: tab?.id ?? null, url, domain, title: tab?.title || domain });
  }
  // enforce cap: 1 prospect + (maxTotal-1) competitors
  const allowed = Math.max(0, (Number(maxTotal) || 10) - 1);
  if (result.competitors.length > allowed) {
    const extra = result.competitors.slice(allowed);
    result.competitors.length = allowed;
    for (const tab of extra) {
      result.skipped.push({ ...tab, reason: 'over-cap' });
    }
  }
  return result;
}
