// dealroom.js — Deal Room brief pipeline helpers (pre-call brief from open tabs).
// Pure + dependency-free: prompt builders, JSON parser, source-URL validator,
// markdown renderer. Works in the extension SW and in Node tests.
// No chrome.*, no network here — the SW supplies page text + ai.chat.

export const DEALROOM_SCHEMA_KEYS = [
  'prospect', 'competitiveLandscape', 'likelyObjections',
  'talkTracks', 'landmines', 'proofPoints',
];

// Claim arrays whose every item MUST carry a sourceUrl (or it is omitted).
const SOURCED_ARRAYS = [
  'competitiveLandscape', 'likelyObjections', 'talkTracks', 'landmines', 'proofPoints',
];

// Tech-stack hint mining: keyword scan only — never invents, returns matches.
const TECH_KEYWORDS = [
  'salesforce', 'hubspot', 'stripe', 'shopify', 'wordpress', 'react', 'angular',
  'vue', 'aws', 'azure', 'google cloud', 'snowflake', 'segment', 'marketo',
  'pardot', 'netsuite', 'sap', 'oracle', 'zendesk', 'intercom', 'slack',
  'teams', 'notion', 'asana', 'jira', 'github', 'gitlab', 'figma', 'webflow',
];

export function mineTechHints(text) {
  const hay = String(text || '').toLowerCase();
  const out = [];
  for (const kw of TECH_KEYWORDS) {
    if (hay.includes(kw) && !out.includes(kw)) out.push(kw);
  }
  return out.slice(0, 8);
}

function isHttpUrl(s) {
  return /^https?:\/\//i.test(String(s || ''));
}

// Strict-JSON extraction prompt for the prospect page (+ news).
// Mirrors the battle-card extraction contract: verbatim, null when absent.
export function buildProspectPrompt(pageText, newsText) {
  return `Extract prospect company facts from the data below. Return ONLY a JSON object with these exact keys:
- whatTheyDo: one precise sentence (what they sell + who buys it)
- sizeSignals: array of short strings (employee count, funding, locations — copy verbatim, [] if absent)
- techHints: array of technology names literally named on the page ([] if none)
- recentNews: one recent item with date if present, else null

Rules: copy verbatim; use null/[] when absent (never invent); keep each value under 280 chars.

PAGE:
${String(pageText || '').substring(0, 8000)}

NEWS:
${String(newsText || '').substring(0, 1500)}`;
}

// ONE synthesis call. prospectFacts/competitorCards carry sourceUrls; the model
// MUST propagate a sourceUrl onto every claim item or omit the item.
export function buildDealRoomPrompt({ prospect, competitors, profile }) {
  const profLine = profile?.seller
    ? `Seller company: ${profile.seller}`
    : 'Seller company: unknown (write counters generically)';
  return `DEAL-ROOM-SYNTHESIS. You are a senior enterprise sales strategist writing a pre-call brief. Return ONLY a JSON object with EXACTLY these keys:
{
  "prospect": { "name": string, "whatTheyDo": string, "likelyPriorities": [{"text": string, "sourceUrl": string}], "signals": [{"text": string, "sourceUrl": string}] },
  "competitiveLandscape": [{ "competitor": string, "theirAngle": string, "yourCounter": string, "sourceUrl": string }],
  "likelyObjections": [{ "objection": string, "rebuttal": string, "sourceUrl": string }],
  "talkTracks": [{ "opener": string, "discoveryQuestion": string, "trapQuestion": string, "sourceUrl": string }],
  "landmines": [{ "whereTheyWin": string, "howToQualifyOut": string, "sourceUrl": string }],
  "proofPoints": [{ "claim": string, "metric": string, "whenToUse": string, "sourceUrl": string }]
}

HARD RULES:
- Every item in likelyPriorities, signals, competitiveLandscape, likelyObjections, talkTracks, landmines, proofPoints MUST include a sourceUrl copied from the SOURCES below. Omit any item you cannot source — never invent a URL.
- Keep each text value under 220 chars. Arrays may be empty [] when evidence is thin.
- prospect.name/whatTheyDo come from the prospect page; sourceUrl = the prospect page URL.

${profLine}

PROSPECT FACTS:
${JSON.stringify(prospect, null, 2).substring(0, 6000)}

COMPETITOR CARDS:
${JSON.stringify(competitors, null, 2).substring(0, 12000)}`;
}

export function parseDealRoomJson(raw) {
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('unparseable: no JSON object in synthesis response');
  let parsed;
  try {
    parsed = JSON.parse(m[0]);
  } catch (e) {
    throw new Error('unparseable: invalid JSON in synthesis response');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('unparseable: synthesis JSON is not an object');
  }
  return parsed;
}

// Enforce the no-fabrication rule: drop every claim item without a sourceUrl
// from the known extracted set. Returns {brief, stats:{total,kept,omitted}}.
export function validateBrief(parsed, knownSourceUrls) {
  const known = new Set(Array.isArray(knownSourceUrls) ? knownSourceUrls.filter(isHttpUrl) : []);
  const hasKnownSource = (item) =>
    item && typeof item === 'object' && isHttpUrl(item.sourceUrl) && known.has(String(item.sourceUrl));
  let total = 0;
  let kept = 0;
  const cleanArray = (arr, textKeys) => {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const item of arr) {
      total += 1;
      if (!item || typeof item !== 'object') continue;
      const textsOk = textKeys.every((k) => typeof item[k] === 'string' && item[k].trim().length > 0);
      if (!textsOk || !hasKnownSource(item)) continue;
      kept += 1;
      const clean = { sourceUrl: String(item.sourceUrl) };
      for (const k of textKeys) clean[k] = String(item[k]).trim().substring(0, 220);
      out.push(clean);
    }
    return out;
  };

  const prospect = parsed?.prospect && typeof parsed.prospect === 'object' ? parsed.prospect : {};
  const brief = {
    prospect: {
      name: String(prospect.name || '').trim().substring(0, 120) || 'Unknown prospect',
      whatTheyDo: String(prospect.whatTheyDo || '').trim().substring(0, 280) || null,
      likelyPriorities: cleanArray(prospect.likelyPriorities, ['text']),
      signals: cleanArray(prospect.signals, ['text']),
    },
    competitiveLandscape: cleanArray(parsed?.competitiveLandscape, ['competitor', 'theirAngle', 'yourCounter']),
    likelyObjections: cleanArray(parsed?.likelyObjections, ['objection', 'rebuttal']),
    talkTracks: cleanArray(parsed?.talkTracks, ['opener', 'discoveryQuestion', 'trapQuestion']),
    landmines: cleanArray(parsed?.landmines, ['whereTheyWin', 'howToQualifyOut']),
    proofPoints: cleanArray(parsed?.proofPoints, ['claim', 'metric', 'whenToUse']),
  };
  return { brief, stats: { total, kept, omitted: total - kept } };
}

function mdLink(url) {
  try {
    const domain = new URL(url).hostname.replace(/^www\./i, '');
    return `[source: ${domain}](${url})`;
  } catch {
    return `[source](${url})`;
  }
}

// Markdown report for history resultRef — every claim carries a clickable link.
export function renderDealRoomMarkdown(brief, prospectName) {
  const L = [];
  const title = prospectName || brief?.prospect?.name || 'Prospect';
  L.push(`# 🎯 Deal Room — ${title}`);
  L.push('');
  const p = brief?.prospect || {};
  L.push('## Prospect');
  L.push(`- **What they do:** ${p.whatTheyDo || 'Not found in sources.'}`);
  L.push(`- **Priorities:** ${(p.likelyPriorities || []).map((x) => `${x.text} ${mdLink(x.sourceUrl)}`).join(' | ') || 'Not found in sources.'}`);
  L.push(`- **Signals:** ${(p.signals || []).map((x) => `${x.text} ${mdLink(x.sourceUrl)}`).join(' | ') || 'Not found in sources.'}`);
  L.push('');
  L.push('## Competitive landscape');
  if (!brief?.competitiveLandscape?.length) {
    L.push('_No competitor tabs open — prospect-only brief._');
  } else {
    for (const c of brief.competitiveLandscape) {
      L.push(`- **${c.competitor}** — their angle: ${c.theirAngle} ${mdLink(c.sourceUrl)}`);
      L.push(`  - Counter: ${c.yourCounter}`);
    }
  }
  L.push('');
  L.push('## Likely objections');
  if (!brief?.likelyObjections?.length) L.push('_No sourced objections found._');
  else for (const o of brief.likelyObjections) L.push(`- **${o.objection}** → ${o.rebuttal} ${mdLink(o.sourceUrl)}`);
  L.push('');
  L.push('## Talk tracks');
  if (!brief?.talkTracks?.length) L.push('_No sourced talk tracks._');
  else for (const t of brief.talkTracks) L.push(`- Opener: ${t.opener} | Discovery: ${t.discoveryQuestion} | Trap: ${t.trapQuestion} ${mdLink(t.sourceUrl)}`);
  L.push('');
  L.push('## Landmines');
  if (!brief?.landmines?.length) L.push('_No sourced landmines._');
  else for (const m of brief.landmines) L.push(`- Where they win: ${m.whereTheyWin} → qualify out: ${m.howToQualifyOut} ${mdLink(m.sourceUrl)}`);
  L.push('');
  L.push('## Proof points');
  if (!brief?.proofPoints?.length) L.push('_No sourced proof points._');
  else for (const f of brief.proofPoints) L.push(`- ${f.claim} (${f.metric}) — use when: ${f.whenToUse} ${mdLink(f.sourceUrl)}`);
  return L.join('\n');
}
