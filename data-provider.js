// data-provider.js — DataProvider interface for battle-card pipelines.
// Works in both extension SW (chrome.*) and Node (fixtures).
//
// Interface:
//   fetchPageSet(urls, opts) -> [{url, domain, title, text, ok, error}]
//   searchNews(query)         -> string (news text)
//
// Providers:
//   LocalProvider   — uses chrome.tabs (extension only; throws in Node)
//   FixtureProvider — reads qa/fixtures/<domain>.json (Node fs OR extension fetch)
//   getProvider(settings) — settings.provider === 'fixture' -> FixtureProvider
//
// extractFacts(pageData, opts) — deterministic, no-fabrication extractor used by
//   qa/run-golden.mjs. Optional {ai, model} path uses LLM with strict schema;
//   offline heuristic path is default and never guesses.

export const GOLDEN_FIELDS = ['pricing', 'positioning', 'targetAudience'];

export function estimateTokensForText(text) {
  return Math.ceil(String(text || '').length / 4);
}

function normalizeDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./i, '').toLowerCase(); }
  catch { return String(url || 'unknown').toLowerCase(); }
}

// ---------------------------------------------------------------------------
// LocalProvider (extension only)
// ---------------------------------------------------------------------------
export class LocalProvider {
  constructor(opts = {}) {
    this.maxLength = opts.maxLength || 5000;
    this.waitMs = opts.waitMs || 9000;
  }

  _assertChrome() {
    if (typeof chrome === 'undefined' || !chrome?.tabs) {
      throw new Error(
        'LocalProvider needs chrome.tabs, which Node does not have. ' +
        'Use FixtureProvider (settings.provider="fixture") with qa/fixtures/*.json. ' +
        'See qa/README.md step 1-3 to capture fixtures via qa/capture.html.'
      );
    }
  }

  async _waitForTab(tabId, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete') return true;
      } catch { return false; }
      await new Promise(r => setTimeout(r, 500));
    }
    return false;
  }

  async _getPageText(tabId, maxLength) {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: (maxLen) => {
        const clone = document.body?.cloneNode(true);
        if (clone) clone.querySelectorAll('script,style,noscript,template').forEach(el => el.remove());
        const cands = [
          document.querySelector('article'), document.querySelector('main'),
          document.querySelector('[role="main"]'), clone, document.body
        ].filter(Boolean);
        const best = cands.sort((a, b) => (b.innerText || '').length - (a.innerText || '').length)[0] || document.body;
        return String([document.title || '', best?.innerText || ''].join('\n\n')).replace(/\s+/g, ' ').trim().substring(0, maxLen);
      },
      args: [maxLength]
    });
    return res?.[0]?.result || '';
  }

  async _openAndRead(url, opts = {}) {
    this._assertChrome();
    const maxLength = opts.maxLength || this.maxLength;
    const waitMs = opts.waitMs || this.waitMs;
    let tab = null;
    try {
      tab = await chrome.tabs.create({ url, active: false });
      await this._waitForTab(tab.id, waitMs);
      await new Promise(r => setTimeout(r, 700));
      const text = await this._getPageText(tab.id, maxLength);
      if (!text || text.length < 80) {
        return { url, domain: normalizeDomain(url), title: tab.title || '', text: '', ok: false, error: 'Not enough readable text.' };
      }
      return { url, domain: normalizeDomain(url), title: tab.title || '', text, ok: true, error: '' };
    } catch (e) {
      return { url, domain: normalizeDomain(url), title: '', text: '', ok: false, error: e?.message || 'Failed to open URL.' };
    } finally {
      if (tab?.id) { try { await chrome.tabs.remove(tab.id); } catch {} }
    }
  }

  async fetchPageSet(urls, opts = {}) {
    this._assertChrome();
    const list = Array.isArray(urls) ? urls.filter(Boolean).slice(0, 5) : [];
    const out = [];
    for (const u of list) out.push(await this._openAndRead(u, opts));
    return out;
  }

  async searchNews(query) {
    this._assertChrome();
    const url = 'https://www.google.com/search?q=' + encodeURIComponent(query);
    const r = await this._openAndRead(url, { maxLength: 5000, waitMs: 7000 });
    return r.text || '';
  }
}

// ---------------------------------------------------------------------------
// FixtureProvider (Node + extension)
// ---------------------------------------------------------------------------
export class FixtureProvider {
  constructor(opts = {}) {
    // opts.fixtures: Map domain->fixture (for tests); opts.dir for Node fs
    this.fixtures = opts.fixtures || null;
    this.dir = opts.dir || null;
  }

  async _loadFixture(domain) {
    const d = String(domain || '').toLowerCase();
    if (this.fixtures && this.fixtures[d]) return this.fixtures[d];
    // Node fs path
    if (typeof process !== 'undefined' && process.versions?.node) {
      const { readFile } = await import('node:fs/promises');
      const { join, dirname } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      // resolve qa/fixtures relative to this file or opts.dir
      let base = this.dir;
      if (!base) {
        try {
          const here = dirname(fileURLToPath(import.meta.url));
          base = join(here, 'qa', 'fixtures');
        } catch { base = join(process.cwd(), 'qa', 'fixtures'); }
      }
      // try <domain>.json with dots preserved, e.g. salesforce.com.json
      const path = join(base, `${d}.json`);
      const raw = await readFile(path, 'utf8');
      return JSON.parse(raw);
    }
    // Extension: fetch via runtime URL
    const url = chrome.runtime.getURL(`qa/fixtures/${d}.json`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fixture not found: ${d}`);
    return res.json();
  }

  async fetchPageSet(urls, opts = {}) {
    const list = Array.isArray(urls) ? urls.filter(Boolean).slice(0, 5) : [];
    const out = [];
    for (const u of list) {
      const domain = normalizeDomain(u);
      try {
        const fx = await this._loadFixture(domain);
        const pageText = fx.pageText || fx.text || '';
        const maxLength = opts.maxLength || 8000;
        const text = String(pageText).substring(0, maxLength);
        if (!text || text.length < 20) {
          out.push({ url: u, domain, title: fx.title || '', text: '', ok: false, error: 'Fixture empty.' });
        } else {
          out.push({ url: u, domain, title: fx.title || fx.name || domain, text, ok: true, error: '' });
        }
      } catch (e) {
        out.push({ url: u, domain, title: '', text: '', ok: false, error: e?.message || 'Fixture missing.' });
      }
    }
    return out;
  }

  async searchNews(query) {
    // Fixture news: find fixture whose domain appears in query, else first fixture's newsText
    const q = String(query || '').toLowerCase();
    const loadAll = async () => {
      if (this.fixtures) return Object.values(this.fixtures);
      if (typeof process !== 'undefined' && process.versions?.node) {
        const { readdir, readFile } = await import('node:fs/promises');
        const { join, dirname } = await import('node:path');
        const { fileURLToPath } = await import('node:url');
        let base = this.dir;
        if (!base) {
          try { base = join(dirname(fileURLToPath(import.meta.url)), 'qa', 'fixtures'); }
          catch { base = join(process.cwd(), 'qa', 'fixtures'); }
        }
        const files = (await readdir(base)).filter(f => f.endsWith('.json'));
        const out = [];
        for (const f of files) out.push(JSON.parse(await readFile(join(base, f), 'utf8')));
        return out;
      }
      return [];
    };
    try {
      const all = await loadAll();
      const hit = all.find(fx => q.includes(String(fx.domain || '').toLowerCase()));
      if (hit?.newsText) return String(hit.newsText).substring(0, 1500);
      if (all[0]?.newsText) return String(all[0].newsText).substring(0, 1500);
    } catch {}
    return '';
  }
}

export function getProvider(settings = {}) {
  const mode = String(settings.provider || settings.mode || 'local').toLowerCase();
  if (mode === 'fixture') return new FixtureProvider(settings.fixtureOpts || {});
  return new LocalProvider(settings);
}

// ---------------------------------------------------------------------------
// extractFacts — strict, no-fabrication extractor
// ---------------------------------------------------------------------------
// pageData: {domain, url, title, pageText, newsText, sourceUrl}
// opts: {pageBudget (default 8000), model (default 'gpt-oss-120b'), ai (optional)}
// returns: {pricing, positioning, targetAudience, provenance, tokens, latencyMs, model}
//
// Rules:
//  - pageText takes priority over newsText (reconcile priority).
//  - labelled lines ("Pricing:", "Positioning:", "Target audience:") win (schema strictness).
//  - fallback: sentence scoring (never guesses; returns null if no evidence).
//  - provenance.quote must be a verbatim substring of the source text.
//  - null + note "contact sales" style is allowed for missing pricing, never fabricated.
function splitSentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.trim())
    .filter(s => s.length > 12);
}

function findLabelledLine(text, labels) {
  const lines = String(text || '').split(/\n+/);
  for (const line of lines) {
    for (const lb of labels) {
      const m = line.match(new RegExp(`^\\s*${lb}\\s*[:\\-]\\s*(.+)$`, 'i'));
      if (m && m[1].trim().length > 2) return line.trim();
    }
  }
  return null;
}

function scorePricingSentence(s) {
  let score = 0;
  if (/\$\s?\d/.test(s)) score += 4;
  if (/\b(free|trial)\b/i.test(s)) score += 2;
  if (/\/(mo|month|user|seat|yr|year)\b/i.test(s)) score += 3;
  if (/\b(enterprise|custom|contact sales)\b/i.test(s)) score += 2;
  if (/\b(pricing|plan|tier|starter|professional|business|growth|unlimited|plus)\b/i.test(s)) score += 2;
  if (s.length > 280) score -= 2;
  return score;
}

function scorePositioningSentence(s) {
  let score = 0;
  if (/\b(CRM|design|analytics|project|platform|collaborat|tracking|management|workspace|productivity)\b/i.test(s)) score += 2;
  if (/\b(built for|designed for|all-in-one|open-?source|cloud|visual|modern)\b/i.test(s)) score += 2;
  if (/\b(with|featuring|including)\b.*\b(,|and)\b/i.test(s)) score += 1;
  if (s.length < 30 || s.length > 300) score -= 1;
  return score;
}

function scoreAudienceSentence(s) {
  let score = 0;
  if (/\b(teams?|companies|startups?|designers?|marketers?|engineers?|owners?|workers?|businesses?)\b/i.test(s)) score += 3;
  if (/\b(needing|wanting|looking for|built for|designed for)\b/i.test(s)) score += 3;
  if (/\b(sales|marketing|product|growth|engineering|cross-functional)\b/i.test(s)) score += 1;
  if (s.length < 25 || s.length > 280) score -= 1;
  return score;
}

function bestSentence(sentences, scorer) {
  let best = null; let bestScore = 0;
  for (const s of sentences) {
    const sc = scorer(s);
    if (sc > bestScore) { bestScore = sc; best = s; }
  }
  return bestScore > 0 ? best : null;
}

export async function extractFacts(pageData = {}, opts = {}) {
  const t0 = Date.now();
  const model = String(opts.model || 'gpt-oss-120b');
  const pageBudget = Math.max(200, Math.min(12000, Number(opts.pageBudget ?? 8000)));
  const domain = String(pageData.domain || normalizeDomain(pageData.url || '')).toLowerCase();
  const sourceUrl = pageData.sourceUrl || pageData.url || `https://${domain}/pricing`;
  const pageText = String(pageData.pageText || pageData.text || '').substring(0, pageBudget);
  const newsText = String(pageData.newsText || '').substring(0, 1500);

  // Optional LLM path (only if caller passes ai with .chat). Strict schema, no fabrication.
  if (opts.ai?.chat) {
    const prompt =
      `Extract structured facts. Return ONLY JSON with exact keys: pricing, positioning, targetAudience.\n` +
      `Rules: copy verbatim from DATA when present; if pricing is absent use null (never invent prices); ` +
      `keep each value under 280 chars; page content outranks news.\n` +
      `DATA PAGE:\n${pageText}\n\nDATA NEWS:\n${newsText}`;
    const raw = await opts.ai.chat(prompt, 800);
    const m = String(raw).match(/\{[\s\S]*\}/);
    if (!m) throw new Error('unparseable');
    const parsed = JSON.parse(m[0]);
    const out = {
      pricing: parsed.pricing ?? null,
      positioning: parsed.positioning ?? null,
      targetAudience: parsed.targetAudience ?? null,
      provenance: {},
      tokens: {
        prompt: estimateTokensForText(prompt),
        completion: estimateTokensForText(raw),
      },
      latencyMs: Date.now() - t0,
      model,
    };
    for (const f of GOLDEN_FIELDS) {
      const v = out[f];
      const hay = (pageText + '\n' + newsText);
      const quote = typeof v === 'string' && v && hay.includes(v.substring(0, 40)) ? v.substring(0, 160) : '';
      out.provenance[f] = { sourceUrl, quote };
    }
    return out;
  }

  // ---- Offline heuristic path (default for golden harness, no API key) ----
  const result = { pricing: null, positioning: null, targetAudience: null, provenance: {} };

  // 1) labelled lines win (structured pricing sections)
  const priceLine = findLabelledLine(pageText, ['Pricing']);
  const posLine = findLabelledLine(pageText, ['Positioning']);
  const audLine = findLabelledLine(pageText, ['Target audience', 'Audience']);

  const stripLabel = (line) => String(line || '').replace(/^\s*[A-Za-z ]+\s*[:\-]\s*/, '').trim().substring(0, 280);

  if (priceLine) {
    result.pricing = stripLabel(priceLine);
    result.provenance.pricing = { sourceUrl, quote: priceLine.substring(0, 200) };
  }
  if (posLine) {
    result.positioning = stripLabel(posLine);
    result.provenance.positioning = { sourceUrl, quote: posLine.substring(0, 200) };
  }
  if (audLine) {
    result.targetAudience = stripLabel(audLine);
    result.provenance.targetAudience = { sourceUrl, quote: audLine.substring(0, 200) };
  }

  // 2) fallback sentence scoring for any missing field (page first, then news)
  const pageSentences = splitSentences(pageText);
  const newsSentences = splitSentences(newsText);
  if (!result.pricing) {
    const hit = bestSentence(pageSentences, scorePricingSentence) || bestSentence(newsSentences, scorePricingSentence);
    if (hit) {
      result.pricing = hit.substring(0, 280);
      result.provenance.pricing = { sourceUrl, quote: hit.substring(0, 200) };
    } else {
      result.provenance.pricing = { sourceUrl, quote: '' };
    }
  }
  if (!result.positioning) {
    const hit = bestSentence(pageSentences, scorePositioningSentence) || bestSentence(newsSentences, scorePositioningSentence);
    if (hit) {
      result.positioning = hit.substring(0, 280);
      result.provenance.positioning = { sourceUrl, quote: hit.substring(0, 200) };
    } else {
      result.provenance.positioning = { sourceUrl, quote: '' };
    }
  }
  if (!result.targetAudience) {
    const hit = bestSentence(pageSentences, scoreAudienceSentence) || bestSentence(newsSentences, scoreAudienceSentence);
    if (hit) {
      result.targetAudience = hit.substring(0, 280);
      result.provenance.targetAudience = { sourceUrl, quote: hit.substring(0, 200) };
    } else {
      result.provenance.targetAudience = { sourceUrl, quote: '' };
    }
  }

  const promptChars = pageText.length + 400;
  const completionChars = JSON.stringify(result).length;
  return {
    ...result,
    provenance: result.provenance,
    tokens: {
      prompt: estimateTokensForText('x'.repeat(promptChars)),
      completion: estimateTokensForText('x'.repeat(completionChars)),
    },
    latencyMs: Date.now() - t0,
    model: 'heuristic-offline',
  };
}

// Reconcile helper: page beats news, explicit beats inferred, null beats fabricated.
export function reconcileFacts(pageFacts, newsFacts) {
  const out = {};
  for (const f of GOLDEN_FIELDS) {
    out[f] = pageFacts?.[f] ?? newsFacts?.[f] ?? null;
  }
  return out;
}
