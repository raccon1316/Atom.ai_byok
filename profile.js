// profile.js — user PROFILE: your company, positioning, and proof points.
// Rebuttals generated against competitors must cite YOUR proof points
// (cross-referenced in objection-lib.js). Pure + dependency-free: works in
// the extension SW and in Node tests. No chrome.* here — callers pass
// userSettings / storage values in.
//
// Stored shape (chrome.storage.local `userProfile`, all fields optional):
//   { company, positioning, proofPoints: [{claim, metric, sourceUrl}] }

export const PROFILE_KEY = 'userProfile';

export function defaultProfile() {
  return { company: '', positioning: '', proofPoints: [] };
}

function cleanProofPoint(p) {
  if (!p || typeof p !== 'object') return null;
  const claim = String(p.claim || '').trim().substring(0, 220);
  if (!claim) return null;
  return {
    claim,
    metric: String(p.metric || '').trim().substring(0, 120),
    sourceUrl: String(p.sourceUrl || '').trim(),
  };
}

// Merge stored profile over defaults; derive company from ownProductUrl
// when the user never filled the profile in.
export function getProfile(userSettings = {}) {
  const stored = (userSettings && typeof userSettings.profile === 'object' && userSettings.profile) || {};
  const own = String(userSettings?.ownProductUrl || '').trim();
  let company = String(stored.company || '').trim();
  if (!company && own) {
    try { company = new URL(own).hostname.replace(/^www\./i, ''); } catch { company = own; }
  }
  const proofPoints = Array.isArray(stored.proofPoints)
    ? stored.proofPoints.map(cleanProofPoint).filter(Boolean).slice(0, 20)
    : [];
  return {
    company,
    positioning: String(stored.positioning || '').trim().substring(0, 280),
    proofPoints,
  };
}

const STOPWORDS = new Set(
  'a,an,the,and,or,but,if,then,else,for,to,of,in,on,at,by,with,from,as,is,are,was,were,be,been,being,it,its,this,that,these,those,you,your,we,our,they,their,he,she,them,his,her,not,no,do,does,can,will,just,than,so,such,into,over,after,before,when,what,which,who,how,all,any,more,most,other,than,too,very,up,out,about,have,has,had,our,yours,theirs,ours,us'.split(',')
);

function significantTokens(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9$%]+/)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
}

// Match a rebuttal/counter text against YOUR proof points by keyword overlap.
// Returns the best proof point when ≥2 significant tokens overlap, else null
// (caller marks "needs your input"). Pure and deterministic.
export function matchProofPoints(text, profile) {
  const points = Array.isArray(profile?.proofPoints) ? profile.proofPoints : [];
  if (!points.length) return null;
  const hay = new Set(significantTokens(text));
  if (!hay.size) return null;
  let best = null;
  let bestScore = 0;
  for (const p of points) {
    const keys = new Set(significantTokens(`${p.claim || ''} ${p.metric || ''}`));
    let score = 0;
    for (const k of keys) if (hay.has(k)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return bestScore >= 2 ? best : null;
}
