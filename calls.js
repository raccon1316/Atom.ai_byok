// calls.js — Feature 5: call transcript → structured deal breakdown.
//
// The one feature built around the model's long context: the FULL transcript
// goes to the model (no truncation — that is the entire point), with a raised
// per-attempt timeout because a 40k-word read plus a 2000-token structured
// answer legitimately runs minutes, not seconds. .docx is refused with an
// actionable message rather than half-parsed.

import { requestJSON } from './structured.js';
import { MEDDIC_DIMENSIONS } from './meddic.js';

export const CALL_TIMEOUT_MS = 120000;

export function buildTranscriptPrompt(transcript) {
  return `You are a sales manager reviewing a call transcript. Produce a structured breakdown the rep can act on immediately.

Return exactly ONE JSON object:
{
  "summary": "3-4 sentences on what happened",
  "objections": ["each objection raised, quoting the prospect's own words where present"],
  "nextSteps": ["each next step, with its owner if mentioned, e.g. 'John will send the contract by Friday'"],
  "dealSignal": {"direction": "better|neutral|worse", "reason": "one sentence"},
  "riskSignals": ["e.g. budget frozen, competitor mentioned, no timeline, no decision maker present"],
  "followUpEmail": {"subject": "...", "body": "1-2 paragraphs, ready to send"},
  "meddicUpdate": [{"key": "<one of: metrics, economicBuyer, decisionCriteria, decisionProcess, pain, champion>", "learning": "what we learned"}]
}

Rules: every array may be empty if truly nothing applies — do not invent. meddicUpdate lists ONLY dimensions where something was actually learned. The follow-up email must reference specifics from the call.

TRANSCRIPT:
${String(transcript || '')}`;
}

// Normalizes the model output into the shape render() consumes. Arrays the
// model omitted become empty (an empty section is honest; a missing one is
// not), while the pieces every render needs are strictly validated.
export function validateCallAnalysis(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return { ok: false, error: 'Expected a JSON object with the call breakdown.' };
  }
  const summary = String(v.summary || '').trim();
  if (summary.length < 20) return { ok: false, error: '"summary" must be 3-4 sentences.' };
  v.summary = summary.substring(0, 2000);

  for (const key of ['objections', 'nextSteps', 'riskSignals']) {
    if (v[key] == null) v[key] = [];
    if (!Array.isArray(v[key])) return { ok: false, error: `"${key}" must be an array.` };
    v[key] = v[key].map((s) => String(s || '').trim()).filter(Boolean).map((s) => s.substring(0, 500));
  }

  const sig = v.dealSignal;
  if (!sig || typeof sig !== 'object') return { ok: false, error: '"dealSignal" is required.' };
  const direction = String(sig.direction || '').trim().toLowerCase();
  if (!['better', 'neutral', 'worse'].includes(direction)) {
    return { ok: false, error: '"dealSignal.direction" must be better, neutral, or worse.' };
  }
  const reason = String(sig.reason || '').trim();
  if (!reason) return { ok: false, error: '"dealSignal.reason" is required.' };
  v.dealSignal = { direction, reason: reason.substring(0, 400) };

  const mail = v.followUpEmail;
  if (!mail || typeof mail !== 'object') return { ok: false, error: '"followUpEmail" is required.' };
  const subject = String(mail.subject || '').trim();
  const body = String(mail.body || '').trim();
  if (!subject || !body) return { ok: false, error: '"followUpEmail" needs a subject and a body.' };
  v.followUpEmail = { subject: subject.substring(0, 200), body: body.substring(0, 4000) };

  if (v.meddicUpdate == null) v.meddicUpdate = [];
  if (!Array.isArray(v.meddicUpdate)) return { ok: false, error: '"meddicUpdate" must be an array.' };
  v.meddicUpdate = v.meddicUpdate
    .map((m) => {
      const key = String(m?.key || '').trim();
      const learning = String(m?.learning || '').trim();
      return { key, learning: learning.substring(0, 400) };
    })
    .filter((m) => MEDDIC_DIMENSIONS.some((d) => d.key === m.key) && m.learning);

  return { ok: true };
}

// ---- file intake -----------------------------------------------------------
// .txt plus the transcript exports reps actually get (.vtt / .srt). .docx is a
// zip archive — parsing it "with a simple binary read" would silently corrupt
// the transcript, so it is refused with the exact workaround instead.
export const ACCEPTED_EXTENSIONS = ['.txt', '.vtt', '.srt'];

export async function readTranscriptFile(file) {
  const name = String(file?.name || '').toLowerCase();
  if (name.endsWith('.docx')) {
    throw new Error('Export your transcript as .txt from Gong/Zoom, or paste it directly here.');
  }
  if (ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext))) {
    if (typeof file?.text === 'function') return await file.text();
    if (typeof file?._content === 'string') return file._content; // test shim
    throw new Error('Could not read the file. Try pasting the text instead.');
  }
  throw new Error('Unsupported file type. Export your transcript as .txt from Gong/Zoom, or paste it directly here.');
}

export class CallAnalyzer {
  constructor(ai) {
    this.ai = ai;
  }

  async analyze(transcript) {
    return await requestJSON(this.ai, {
      prompt: buildTranscriptPrompt(transcript),
      maxTokens: 2000,
      temperature: 0.3,
      retries: 1,
      timeoutMs: CALL_TIMEOUT_MS,
      validate: validateCallAnalysis,
    });
  }

  // Drop a transcript file straight onto the textarea.
  attachDropzone(textarea, onLoaded) {
    if (!textarea) return;
    textarea.addEventListener('dragover', (e) => {
      e.preventDefault();
      textarea.style.borderColor = 'var(--a)';
    });
    textarea.addEventListener('dragleave', () => {
      textarea.style.borderColor = '';
    });
    textarea.addEventListener('drop', async (e) => {
      e.preventDefault();
      textarea.style.borderColor = '';
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      try {
        const text = await readTranscriptFile(file);
        textarea.value = text;
        onLoaded?.({ ok: true, name: file.name, length: text.length });
      } catch (err) {
        onLoaded?.({ ok: false, name: file.name, error: err?.message || 'Could not read the file.' });
      }
    });
  }

  // Sectioned card, DOM-only — model output never enters an HTML string.
  render(container, result) {
    if (!container) return;
    while (container.firstChild) container.removeChild(container.firstChild);

    const DEAL_BADGES = {
      better: { icon: '🟢', label: 'Strong deal', fg: '#4fefd4', bg: 'rgba(79,239,212,0.12)', border: 'rgba(79,239,212,0.35)' },
      neutral: { icon: '🟡', label: 'Needs nurturing', fg: '#ffc164', bg: 'rgba(255,193,100,0.12)', border: 'rgba(255,193,100,0.35)' },
      worse: { icon: '🔴', label: 'At risk', fg: '#ff6e8e', bg: 'rgba(255,110,142,0.12)', border: 'rgba(255,110,142,0.35)' }
    };
    const badge = DEAL_BADGES[result.dealSignal.direction] || DEAL_BADGES.neutral;
    const badgeEl = document.createElement('div');
    badgeEl.innerText = `${badge.icon} ${badge.label}`;
    badgeEl.style.cssText = `display:inline-block;font-size:12px;font-weight:800;padding:4px 10px;border-radius:999px;color:${badge.fg};background:${badge.bg};border:1px solid ${badge.border};`;
    container.appendChild(badgeEl);

    const section = (title, color) => {
      const t = document.createElement('div');
      t.innerText = title;
      t.style.cssText = `font-weight:700;font-size:12px;margin:10px 0 4px;color:${color || 'var(--tx)'};`;
      container.appendChild(t);
      return t;
    };
    const bullets = (items, emptyText) => {
      if (!items || !items.length) {
        const none = document.createElement('div');
        none.innerText = emptyText;
        none.style.cssText = 'font-size:11px;color:var(--tx2);';
        container.appendChild(none);
        return;
      }
      const ul = document.createElement('ul');
      ul.style.cssText = 'margin:0 0 0 16px;padding:0;';
      for (const item of items) {
        const li = document.createElement('li');
        li.innerText = item;
        li.style.cssText = 'font-size:12px;line-height:1.55;margin-bottom:3px;';
        ul.appendChild(li);
      }
      container.appendChild(ul);
    };

    section('📋 Summary');
    const sum = document.createElement('div');
    sum.innerText = result.summary;
    sum.style.cssText = 'font-size:12px;line-height:1.6;';
    container.appendChild(sum);

    section('⚠️ Objections Raised');
    bullets(result.objections, 'None captured.');

    section('✅ Next Steps');
    bullets(result.nextSteps, 'None captured.');

    section('📊 Deal Signal');
    const sigRow = document.createElement('div');
    sigRow.style.cssText = 'display:flex;gap:8px;align-items:baseline;';
    const sig = document.createElement('span');
    sig.innerText = result.dealSignal.direction.toUpperCase();
    sig.style.cssText = `font-weight:800;font-size:12px;color:${{ better: '#4fefd4', neutral: '#ffc164', worse: '#ff6e8e' }[result.dealSignal.direction]};`;
    const why = document.createElement('span');
    why.innerText = result.dealSignal.reason;
    why.style.cssText = 'font-size:12px;color:var(--tx2);flex:1;';
    sigRow.appendChild(sig);
    sigRow.appendChild(why);
    container.appendChild(sigRow);

    section('🚩 Risk Signals');
    bullets(result.riskSignals, 'None spotted.');

    section('✉️ Follow-up Draft');
    const subj = document.createElement('input');
    subj.type = 'text';
    subj.value = result.followUpEmail.subject;
    subj.style.cssText = 'width:100%;font-size:12px;padding:5px;background:rgba(0,0,0,0.3);color:var(--tx);border:1px solid rgba(255,255,255,0.12);border-radius:6px;margin-bottom:6px;';
    const body = document.createElement('textarea');
    body.value = result.followUpEmail.body;
    body.rows = 6;
    body.style.cssText = 'width:100%;font-size:12px;padding:6px;background:rgba(0,0,0,0.3);color:var(--tx);border:1px solid rgba(255,255,255,0.12);border-radius:6px;resize:vertical;';
    container.appendChild(subj);
    container.appendChild(body);
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn btn-g bsm';
    copyBtn.innerText = '📋 Copy follow-up';
    copyBtn.style.cssText = 'margin-top:6px;font-size:11px;cursor:pointer;';
    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(`${subj.value}\n\n${body.value}`);
      copyBtn.innerText = '✅ Copied!';
      setTimeout(() => { copyBtn.innerText = '📋 Copy follow-up'; }, 1200);
    });
    container.appendChild(copyBtn);

    section('🧩 MEDDIC Update');
    if (!result.meddicUpdate.length) {
      bullets([], 'Nothing new learned about MEDDIC on this call.');
    } else {
      for (const m of result.meddicUpdate) {
        const schema = MEDDIC_DIMENSIONS.find((d) => d.key === m.key);
        const row = document.createElement('div');
        row.style.cssText = 'margin-bottom:4px;font-size:12px;';
        const label = document.createElement('span');
        label.innerText = `${schema ? schema.letter + ' — ' + schema.label : m.key}: `;
        label.style.cssText = 'font-weight:600;';
        const learning = document.createElement('span');
        learning.innerText = m.learning;
        learning.style.cssText = 'color:var(--tx2);';
        row.appendChild(label);
        row.appendChild(learning);
        container.appendChild(row);
      }
      const copyMeddic = document.createElement('button');
      copyMeddic.type = 'button';
      copyMeddic.className = 'btn btn-g bsm';
      copyMeddic.innerText = '📋 Copy MEDDIC update';
      copyMeddic.style.cssText = 'margin-top:6px;font-size:11px;cursor:pointer;';
      copyMeddic.addEventListener('click', async () => {
        const text = result.meddicUpdate.map((m) => {
          const schema = MEDDIC_DIMENSIONS.find((d) => d.key === m.key);
          return `${schema ? schema.letter + ' — ' + schema.label : m.key}: ${m.learning}`;
        }).join('\n');
        await navigator.clipboard.writeText(`MEDDIC update\n${text}`);
        copyMeddic.innerText = '✅ Copied!';
        setTimeout(() => { copyMeddic.innerText = '📋 Copy MEDDIC update'; }, 1200);
      });
      container.appendChild(copyMeddic);
    }
  }
}
