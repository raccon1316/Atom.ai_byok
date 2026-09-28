// objection-handler.js — Feature 3: responses to objections the REP is facing.
//
// Distinct from objection-lib.js, which extracts objections from competitor
// documentation; this takes what a prospect just said ("your pricing is 3x
// higher") and returns three read-verbatim talking strategies (Reframe / Proof
// point / Clarify). When the user has saved their own proof points
// (profile.js), the Proof strategy is required to cite THEM — a personal
// metric beats a generic one on every call.

import { requestJSON } from './structured.js';

export const STRATEGY_TYPES = [
  { key: 'reframe', label: 'Reframe', hint: 'make the objection a reason to buy' },
  { key: 'proof', label: 'Proof point', hint: 'a metric or customer story angle' },
  { key: 'clarify', label: 'Clarify', hint: 'the question that reveals real vs. smokescreen' },
];

export function buildObjectionHandlerPrompt(objection, { briefContext = '', profile = null } = {}) {
  const obj = String(objection || '').trim().substring(0, 600);
  const brief = String(briefContext || '').trim().substring(0, 2500);
  const proofPoints = Array.isArray(profile?.proofPoints) ? profile.proofPoints : [];
  const proofBlock = proofPoints.length
    ? `The seller's OWN verified proof points (cite these, with their metrics, when a proof angle fits — prefer them over invented ones):\n${proofPoints
        .map((p) => `- ${p.claim}${p.metric ? ` (metric: ${p.metric})` : ''}`)
        .join('\n')}`
    : 'No seller proof points on file — if a proof angle fits, keep it generic but concrete-sounding and tell the rep to swap in a real customer story.';

  return `You are a sales coach preparing a rep for a LIVE call. The prospect said:

"${obj}"

Write THREE response strategies the rep can read verbatim.

Return exactly ONE JSON object:
{"strategies":[{"type":"reframe","title":"one line","script":"2-3 sentences, spoken language"},{"type":"proof","title":"...","script":"..."},{"type":"clarify","title":"...","script":"..."}]}

- "reframe": turn the objection into a reason to buy
- "proof": a metric or customer-story angle
- "clarify": ONE question that reveals whether this objection is real or a smokescreen

Each script must be 2-3 sentences maximum.
Write in first person as the salesperson.
Be specific and confident, not defensive.
Do not start any script with "I understand".

The scripts must sound like a human talking on a call — no PowerPoint bullets, no "I appreciate that", no marketing voice.${profile?.company ? ` The seller works at ${profile.company}.` : ''}
${proofBlock}
${brief ? `\nContext from the current research brief:\n${brief}` : ''}`;
}

export function validateStrategies(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || !Array.isArray(v.strategies)) {
    return { ok: false, error: 'Expected {"strategies": [...]}.' };
  }
  if (v.strategies.length !== 3) {
    return { ok: false, error: `Expected exactly 3 strategies, got ${v.strategies.length}.` };
  }
  const seen = new Set();
  for (const s of v.strategies) {
    if (!s || typeof s !== 'object') return { ok: false, error: 'Each strategy must be an object.' };
    const type = String(s.type || '').trim().toLowerCase();
    if (!STRATEGY_TYPES.some((t) => t.key === type)) {
      return { ok: false, error: `Unknown strategy type "${type}" (need reframe/proof/clarify).` };
    }
    if (seen.has(type)) return { ok: false, error: `Duplicate strategy type "${type}".` };
    seen.add(type);
    const title = String(s.title || '').trim();
    if (!title) return { ok: false, error: `"${type}" needs a one-line title.` };
    const script = String(s.script || '').trim();
    if (script.length < 40) return { ok: false, error: `"${type}" script is too short to read on a call.` };
    if (script.length > 1200) return { ok: false, error: `"${type}" script is too long for a live call.` };
    s.type = type;
    s.title = title.substring(0, 120);
    s.script = script;
  }
  // canonical order: reframe, proof, clarify
  v.strategies.sort((a, b) =>
    STRATEGY_TYPES.findIndex((t) => t.key === a.type) - STRATEGY_TYPES.findIndex((t) => t.key === b.type));
  return { ok: true };
}

export class ObjectionHandler {
  constructor(ai) {
    this.ai = ai;
  }

  async handle(objection, opts = {}) {
    return await requestJSON(this.ai, {
      prompt: buildObjectionHandlerPrompt(objection, opts),
      maxTokens: 1000,
      temperature: 0.5,
      validate: validateStrategies,
    });
  }

  // Renders expandable strategy cards into a container using DOM APIs only.
  render(container, result) {
    if (!container) return;
    while (container.firstChild) container.removeChild(container.firstChild);

    for (const s of result.strategies || []) {
      const meta = STRATEGY_TYPES.find((t) => t.key === s.type) || {};
      const card = document.createElement('div');
      card.style.cssText = 'border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:10px;margin-bottom:8px;background:rgba(0,0,0,0.25);';

      const head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;';
      const type = document.createElement('span');
      type.innerText = `💬 ${meta.label || s.type}`;
      type.style.cssText = 'font-weight:700;font-size:12px;color:var(--a);';
      const title = document.createElement('span');
      title.innerText = s.title;
      title.style.cssText = 'font-size:12px;flex:1;';
      const caret = document.createElement('span');
      caret.innerText = '▾';
      caret.style.cssText = 'color:var(--tx2);font-size:11px;';
      head.appendChild(type);
      head.appendChild(title);
      head.appendChild(caret);

      const body = document.createElement('div');
      body.style.display = 'none';
      body.style.marginTop = '8px';
      const script = document.createElement('div');
      script.innerText = s.script;
      script.style.cssText = 'font-size:12px;line-height:1.6;white-space:pre-wrap;';
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'btn btn-g bsm';
      copyBtn.innerText = '📋 Copy this script';
      copyBtn.style.cssText = 'margin-top:6px;font-size:11px;cursor:pointer;';
      copyBtn.addEventListener('click', async () => {
        await navigator.clipboard.writeText(s.script);
        copyBtn.innerText = '✅ Copied!';
        setTimeout(() => { copyBtn.innerText = '📋 Copy this script'; }, 1200);
      });
      body.appendChild(script);
      body.appendChild(copyBtn);

      head.addEventListener('click', () => {
        const open = body.style.display !== 'none';
        body.style.display = open ? 'none' : 'block';
        caret.innerText = open ? '▾' : '▴';
      });
      card.appendChild(head);
      card.appendChild(body);
      container.appendChild(card);
    }

    const strategies = result.strategies || [];
    if (strategies.length) {
      const copyAll = document.createElement('button');
      copyAll.type = 'button';
      copyAll.className = 'btn btn-g bsm';
      copyAll.innerText = '📋 Copy all 3 scripts';
      copyAll.style.cssText = 'width:100%;font-size:11px;cursor:pointer;';
      copyAll.addEventListener('click', async () => {
        const text = strategies.map((s) => {
          const meta = STRATEGY_TYPES.find((t) => t.key === s.type) || {};
          return `${meta.label || s.type} — ${s.title}\n${s.script}`;
        }).join('\n\n');
        await navigator.clipboard.writeText(text);
        copyAll.innerText = '✅ All 3 copied!';
        setTimeout(() => { copyAll.innerText = '📋 Copy all 3 scripts'; }, 1200);
      });
      container.appendChild(copyAll);
    }
  }
}
