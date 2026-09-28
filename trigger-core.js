// trigger-core.js — Trigger moment decision logic (shared between SW and tests)
// Determines whether to show the battle card banner on a competitor's site.

export const TRIGGER_INTERNAL_PREFIXES = [
  'chrome://', 'chrome-extension://', 'about:', 'edge://', 'brave://', 'devtools://', 'view-source:'
];

export const TRIGGER_GENERIC_HOSTS = [
  'google.com', 'gmail.com', 'youtube.com', 'facebook.com', 'twitter.com', 'x.com',
  'instagram.com', 'linkedin.com', 'reddit.com', 'wikipedia.org', 'amazon.com',
  'github.com', 'docs.google.com', 'drive.google.com', 'slack.com', 'notion.so',
  'figma.com', 'chatgpt.com', 'claude.ai', 'perplexity.ai'
];

export function isInternalUrl(url) {
  return TRIGGER_INTERNAL_PREFIXES.some((p) => String(url || '').startsWith(p));
}

export function normalizeDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./i, '').toLowerCase(); }
  catch { return ''; }
}

export function isGenericHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^www\./i, '');
  if (!h) return true;
  return TRIGGER_GENERIC_HOSTS.some((g) => {
    const bare = g.replace(/^www\./i, '');
    return h === bare || h.endsWith('.' + bare);
  });
}

export function dateKey(ts) {
  const d = new Date(ts || Date.now());
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function normalizeCompanyName(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

// job: {id, type:'battlecard', status:'done', payload:{urls:[...]}, resultRef}
export function jobCoversDomain(job, domain) {
  if (!job || job.type !== 'battlecard' || job.status !== 'done') return false;
  const urls = (job.payload && job.payload.urls) || [];
  return urls.some((u) => normalizeDomain(u) === domain);
}

// Pure decision logic — all chrome.* data resolved by caller (SW) before calling.
// ctx: {url, hostname, ownProductUrl, dismissals:{domain:dateKey}, jobs:[...], now}
// Returns {show:bool, reason, competitor?, jobId?}
export function decideBanner(ctx = {}) {
  const url = String(ctx.url || '');
  if (!url || isInternalUrl(url)) return { show: false, reason: 'internal' };

  const hostname = normalizeDomain(url) || String(ctx.hostname || '').toLowerCase().replace(/^www\./i, '');
  if (!hostname || isGenericHost(hostname)) return { show: false, reason: 'generic' };

  // never render on the user's own product URL (from profile/ownProductUrl)
  const own = normalizeDomain(ctx.ownProductUrl || '');
  if (own && hostname === own) return { show: false, reason: 'own-site' };

  // cap at once per domain per day (dismissal stored by SW under triggerDismissals)
  const dismissals = ctx.dismissals || {};
  if (dismissals[hostname] === dateKey(ctx.now)) return { show: false, reason: 'dismissed-today' };

  const jobs = Array.isArray(ctx.jobs) ? ctx.jobs : [];
  for (const job of jobs) {
    if (jobCoversDomain(job, hostname)) {
      // extract competitor name from the job's URLs
      const urls = (job.payload && job.payload.urls) || [];
      for (const u of urls) {
        const d = normalizeDomain(u);
        if (d === hostname) return { show: true, reason: 'card-exists', competitor: hostname, jobId: job.id };
      }
    }
  }
  return { show: false, reason: 'no-card' };
}