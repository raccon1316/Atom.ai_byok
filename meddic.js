// meddic.js — Feature 4: the 📊 Qualify chip scores the current page against
// the six MEDDIC dimensions and renders a structured green/yellow/red card.
//
// Everything decision-shaped is pure and exported for tests: the dimension
// schema, the prompt, the response validator, a URL+content-hash keyed cache
// (so clicking Qualify twice never double-bills the quota), and a
// DOM-injected card renderer that never touches innerHTML with model output.

export const MEDDIC_DIMENSIONS = [
  { key: 'metrics', letter: 'M', label: 'Metrics', question: 'What measurable value will this company pay for?' },
  { key: 'economicBuyer', letter: 'E', label: 'Economic Buyer', question: 'Who can sign? Is their title visible?' },
  { key: 'decisionCriteria', letter: 'D', label: 'Decision Criteria', question: 'What do they evaluate vendors on?' },
  { key: 'decisionProcess', letter: 'D', label: 'Decision Process', question: 'Company size/type → how complex will the decision be?' },
  { key: 'pain', letter: 'I', label: 'Identify Pain', question: 'Is there explicit problem language on the site?' },
  { key: 'champion', letter: 'C', label: 'Champion', question: 'Is there a title or person who visibly benefits from solving this?' },
];

const SIGNALS = ['green', 'yellow', 'red'];
const OVERALL = ['strong', 'moderate', 'poor'];

export function buildMeddicPrompt(pageText, productName = '') {
  const dims = MEDDIC_DIMENSIONS
    .map((d) => `- "${d.key}" (${d.label}): ${d.question}`)
    .join('\n');
  const product = productName ? ` The seller is "${productName}".` : '';
  return `You are a deal-qualification analyst. Score the company on this page against MEDDIC.${product}

For each dimension return "signal" = "green" (strong signal in the page text), "yellow" (weak/partial signal), or "red" (nothing found or a blocker), plus a one-line "evidence" note quoting or pointing at the page. Nothing found = "red" with what is missing — never guess.

Return exactly ONE JSON object:
{"dimensions":[{"key":"metrics","signal":"green|yellow|red","evidence":"..."}, ...six, one per key below...],"overall":"strong|moderate|poor","summary":"one line","nextSteps":["...","...","..."]}

Dimensions:
${dims}

PAGE:
${String(pageText || '').substring(0, 6000)}`;
}

// Normalizes the model's dimensions array into the canonical six, keyed and
// ordered. Anything off (wrong keys, bad signal, missing evidence) fails with
// a repairable message.
export function validateMeddicScore(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return { ok: false, error: 'Expected an object with dimensions/overall/nextSteps.' };
  }
  if (!Array.isArray(v.dimensions)) {
    return { ok: false, error: '"dimensions" must be an array of six entries.' };
  }
  const byKey = new Map();
  for (const d of v.dimensions) {
    if (!d || typeof d !== 'object') return { ok: false, error: 'Each dimension must be an object.' };
    const key = String(d.key || '').trim();
    if (!MEDDIC_DIMENSIONS.some((m) => m.key === key)) {
      return { ok: false, error: `Unknown dimension key "${key}".` };
    }
    if (byKey.has(key)) return { ok: false, error: `Duplicate dimension "${key}".` };
    const signal = String(d.signal || '').trim().toLowerCase();
    if (!SIGNALS.includes(signal)) {
      return { ok: false, error: `"${key}" signal must be green, yellow, or red.` };
    }
    const evidence = String(d.evidence || '').trim();
    if (!evidence) return { ok: false, error: `"${key}" needs a one-line evidence note.` };
    byKey.set(key, { key, signal, evidence: evidence.substring(0, 300) });
  }
  const missing = MEDDIC_DIMENSIONS.filter((m) => !byKey.has(m.key)).map((m) => m.key);
  if (missing.length) return { ok: false, error: `Missing dimensions: ${missing.join(', ')}.` };

  const overall = String(v.overall || '').trim().toLowerCase();
  if (!OVERALL.includes(overall)) {
    return { ok: false, error: '"overall" must be strong, moderate, or poor.' };
  }
  const steps = Array.isArray(v.nextSteps) ? v.nextSteps : [];
  const nextSteps = steps.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 4);
  if (!nextSteps.length) return { ok: false, error: 'At least one next step is required.' };

  v.dimensions = MEDDIC_DIMENSIONS.map((m) => byKey.get(m.key));
  v.overall = overall;
  v.summary = String(v.summary || '').trim().substring(0, 300);
  v.nextSteps = nextSteps;
  return { ok: true };
}

// ---- cache: url + content hash → score (FIFO cap) ------------------------
const CACHE_KEY = 'meddicCache';
const CACHE_CAP = 20;

export function contentHash(text) {
  const s = String(text || '');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function cacheKeyFor(url, pageText) {
  return `${String(url || '')}#${contentHash(pageText)}`;
}

export class MeddicCache {
  // storage may be null (tests / non-extension contexts) — reads miss, writes
  // no-op, and the caller never learns the difference because caching is an
  // optimization, not a feature.
  constructor(storage) {
    this.storage = storage || null;
  }

  async get(url, pageText) {
    if (!this.storage) return null;
    try {
      const data = await this.storage.get([CACHE_KEY]);
      const entries = Array.isArray(data?.[CACHE_KEY]) ? data[CACHE_KEY] : [];
      const hit = entries.find((e) => e && e.key === cacheKeyFor(url, pageText));
      return hit ? { scoredAt: hit.scoredAt, result: hit.result } : null;
    } catch (e) {
      return null;
    }
  }

  async put(url, pageText, result) {
    if (!this.storage) return;
    try {
      const data = await this.storage.get([CACHE_KEY]);
      const entries = Array.isArray(data?.[CACHE_KEY]) ? data[CACHE_KEY] : [];
      const key = cacheKeyFor(url, pageText);
      const next = [
        { key, url: String(url || ''), scoredAt: new Date().toISOString(), result },
        ...entries.filter((e) => e && e.key !== key),
      ].slice(0, CACHE_CAP);
      await this.storage.set({ [CACHE_KEY]: next });
    } catch (e) {
      // cache write failures are silently ignorable by design
    }
  }
}

// ---- renderer -------------------------------------------------------------
const SIGNAL_COLOR = { green: '#4fefd4', yellow: '#ffc164', red: '#ff6e8e' };
const OVERALL_COLOR = { strong: '#4fefd4', moderate: '#ffc164', poor: '#ff6e8e' };

export function meddicColorFor(signal) {
  return SIGNAL_COLOR[String(signal || '').toLowerCase()] || SIGNAL_COLOR.red;
}

// Builds the card with DOM APIs only — model output lands in text nodes, never
// in HTML strings (the notes.js XSS rule).
export function renderMeddicCard(doc, score, meta = {}) {
  const card = doc.createElement('div');
  card.className = 'meddic-card';
  card.style.cssText = 'border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:10px;margin-top:8px;background:rgba(0,0,0,0.25);';

  const head = doc.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:4px;';
  const title = doc.createElement('strong');
  title.innerText = '📊 MEDDIC Score';
  const overall = doc.createElement('span');
  overall.innerText = String(score.overall || '').toUpperCase();
  overall.style.cssText = `color:${OVERALL_COLOR[score.overall] || SIGNAL_COLOR.red};font-weight:700;`;
  head.appendChild(title);
  head.appendChild(overall);
  if (meta.cachedAt) {
    const cached = doc.createElement('span');
    cached.innerText = `· cached ${meta.cachedAt}`;
    cached.style.cssText = 'font-size:10px;color:var(--tx2);';
    head.appendChild(cached);
  }
  card.appendChild(head);

  if (score.summary) {
    const sum = doc.createElement('div');
    sum.innerText = score.summary;
    sum.style.cssText = 'font-size:12px;color:var(--tx2);margin-bottom:8px;';
    card.appendChild(sum);
  }

  for (const dim of score.dimensions || []) {
    const row = doc.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;align-items:baseline;margin-bottom:4px;';
    const dot = doc.createElement('span');
    dot.innerText = '●';
    dot.style.color = meddicColorFor(dim.signal);
    const label = doc.createElement('span');
    const schema = MEDDIC_DIMENSIONS.find((m) => m.key === dim.key);
    label.innerText = `${schema ? schema.letter + ' — ' : ''}${schema ? schema.label : dim.key}`;
    label.style.cssText = 'min-width:118px;font-weight:600;font-size:12px;';
    const ev = doc.createElement('span');
    ev.innerText = dim.evidence;
    ev.style.cssText = 'font-size:11px;color:var(--tx2);flex:1;';
    row.appendChild(dot);
    row.appendChild(label);
    row.appendChild(ev);
    card.appendChild(row);
  }

  if ((score.nextSteps || []).length) {
    const stepsTitle = doc.createElement('div');
    stepsTitle.innerText = 'Next steps';
    stepsTitle.style.cssText = 'font-weight:600;font-size:12px;margin-top:8px;';
    card.appendChild(stepsTitle);
    const list = doc.createElement('ol');
    list.style.cssText = 'margin:4px 0 0 16px;padding:0;';
    for (const step of score.nextSteps) {
      const li = doc.createElement('li');
      li.innerText = step;
      li.style.cssText = 'font-size:11px;color:var(--tx2);margin-bottom:2px;';
      list.appendChild(li);
    }
    card.appendChild(list);
  }
  return card;
}
