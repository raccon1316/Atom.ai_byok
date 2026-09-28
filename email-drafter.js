// email-drafter.js — Feature 1: ✉️ Draft Email in the report action bar.
//
// The brief on screen already holds the pain points, news, and people; this
// turns those ingredients into three send-ready cold-email variants (Intro /
// Pain / News hook) in ONE structured AI call. Pure helpers are exported for
// Node tests; the class only does DOM work and delegates the AI round-trip to
// structured.js so a malformed reply is repaired or fails honestly.

import { requestJSON } from './structured.js';

export const VARIANTS = [
  { key: 'intro', label: 'Intro' },
  { key: 'pain', label: 'Pain' },
  { key: 'news_hook', label: 'News hook' },
];

// Pull the information-dense sections (pain points, news, who to call) out of
// a brief instead of truncating the whole thing blindly — 2000 chars of signal
// beats 8000 of boilerplate, and the AI call stays well inside token limits.
const SECTION_KEYWORDS = [
  'pain', 'news', 'who to call', 'snapshot', 'what they do',
  'leadership', 'objections', 'opening line', 'competitors',
];

// Sections that must NEVER reach the email prompt: telling the model what not
// to mention invites it to mention it, and confidence scores are not email
// ingredients.
const EXCLUDED_KEYWORDS = ['do not reference', 'do not say', 'confidence'];

function looksLikeHeader(line) {
  const t = line.trim();
  if (!t) return false;
  if (/^===.*===$/.test(t)) return true;
  // Atom.AI briefs put an emoji at the start of every section header.
  if (t.length <= 60 && /^\p{Extended_Pictographic}/u.test(t)) return true;
  return t.length <= 60 && SECTION_KEYWORDS.some((k) => t.toLowerCase().includes(k));
}

export function sliceBriefContext(brief, budget = 2200) {
  const text = String(brief || '');
  if (!text.trim()) return '';
  const lines = text.split('\n');
  const picked = [];
  let total = 0;
  let skipping = false;
  for (let i = 0; i < lines.length; i++) {
    if (looksLikeHeader(lines[i])) {
      skipping = EXCLUDED_KEYWORDS.some((k) => lines[i].toLowerCase().includes(k));
      if (skipping) continue;
      const chunk = [lines[i].trim()];
      for (let j = i + 1; j < lines.length && !looksLikeHeader(lines[j]); j++) {
        chunk.push(lines[j]);
        if (chunk.join('\n').length > 500) break;
      }
      const block = chunk.join('\n').trim();
      if (total + block.length > budget) break;
      picked.push(block);
      total += block.length;
    }
  }
  if (!picked.length) return text.substring(0, budget);
  return picked.join('\n\n');
}

export function buildEmailPrompt(company, briefContext) {
  return `You are a top-performing SDR writing cold emails. Using ONLY the brief below about ${company || 'the company'}, write THREE cold-email variants.

Return exactly ONE JSON object:
{"intro":{"subject":"...","body":"..."},"pain":{"subject":"...","body":"..."},"news_hook":{"subject":"...","body":"..."}}

- "intro": first-touch opener referencing what the company does
- "pain": leads with a pain point from the brief
- "news_hook": opens with a recent news item from the brief

Rules per variant:
- Subject: one line, under 60 characters, never "I wanted to reach out"
- Body: under 120 words, plain text, conversational, first-person, and it must reference something SPECIFIC from the brief
- The final line is always one soft CTA question

BRIEF:
${briefContext}`;
}

// Normalizes and validates the parsed JSON. Doubles as the schema gate for
// requestJSON's repair path, so the UI never renders an undefined variant.
export function validateEmails(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return { ok: false, error: 'Expected an object with intro, pain, news_hook.' };
  }
  for (const { key, label } of VARIANTS) {
    const e = v[key];
    if (!e || typeof e !== 'object') return { ok: false, error: `Missing "${label}" variant.` };
    const subject = String(e.subject || '').trim();
    const body = String(e.body || '').trim();
    if (!subject) return { ok: false, error: `"${label}" is missing a subject line.` };
    if (subject.length > 200) return { ok: false, error: `"${label}" subject is too long.` };
    if (!body) return { ok: false, error: `"${label}" is missing a body.` };
    if (body.length > 2400) return { ok: false, error: `"${label}" body is too long.` };
    v[key] = { subject, body };
  }
  return { ok: true };
}

export function gmailComposeUrl(subject, body) {
  return `https://mail.google.com/mail/u/0/?view=cm&fs=1&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export class EmailDrafter {
  constructor(ai) {
    this.ai = ai;
  }

  // Renders the draft panel directly below the result element (the same slot
  // the action bar uses). Idempotent: reopening replaces the old panel.
  async open(containerId, topic, briefText) {
    const host = document.getElementById(containerId);
    if (!host) return;
    const old = document.getElementById(`emailDraftPanel_${containerId}`);
    if (old && old.remove) old.remove();

    const panel = document.createElement('div');
    panel.className = 'email-draft-panel';
    panel.id = `emailDraftPanel_${containerId}`;
    panel.style.cssText = 'border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:10px;margin-top:8px;background:rgba(0,0,0,0.25);';
    const status = document.createElement('div');
    status.style.cssText = 'font-size:12px;color:var(--tx2);';
    status.innerText = '✉️ Drafting emails…';
    panel.appendChild(status);
    host.parentNode.insertBefore(panel, host.nextSibling);

    let variants;
    try {
      variants = await requestJSON(this.ai, {
        prompt: buildEmailPrompt(topic, sliceBriefContext(briefText)),
        maxTokens: 1200,
        temperature: 0.6,
        validate: validateEmails,
      });
    } catch (e) {
      status.innerText = '⚠️ ' + (e?.message || 'Could not draft emails.');
      return;
    }

    this.renderVariants(panel, status, variants);
  }

  // Split from open() so the rendering is testable without a live AI call.
  renderVariants(panel, status, variants) {
    status.innerText = '';
    const tabsRow = document.createElement('div');
    tabsRow.style.cssText = 'display:flex;gap:6px;margin-bottom:8px;';
    panel.appendChild(tabsRow);

    const pages = {};
    VARIANTS.forEach(({ key, label }, idx) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'ed-tab btn bsm';
      tab.innerText = label;
      tab.style.cssText = 'font-size:11px;padding:4px 10px;cursor:pointer;';
      tabsRow.appendChild(tab);

      const page = document.createElement('div');
      page.style.display = idx === 0 ? 'block' : 'none';
      const v = variants[key] || { subject: '', body: '' };

      const subjLabel = document.createElement('div');
      subjLabel.innerText = 'Subject';
      subjLabel.style.cssText = 'font-size:10px;color:var(--tx2);margin-bottom:2px;';
      const subject = document.createElement('input');
      subject.type = 'text';
      subject.value = v.subject;
      subject.style.cssText = 'width:100%;font-size:12px;padding:5px;background:rgba(0,0,0,0.3);color:var(--tx);border:1px solid rgba(255,255,255,0.12);border-radius:6px;margin-bottom:6px;';

      const body = document.createElement('textarea');
      body.value = v.body;
      body.rows = 7;
      body.style.cssText = 'width:100%;font-size:12px;padding:6px;background:rgba(0,0,0,0.3);color:var(--tx);border:1px solid rgba(255,255,255,0.12);border-radius:6px;resize:vertical;';

      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;';
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'btn btn-g bsm';
      copyBtn.innerText = '📋 Copy';
      copyBtn.addEventListener('click', async () => {
        await navigator.clipboard.writeText(`${subject.value}\n\n${body.value}`);
        copyBtn.innerText = '✅ Copied!';
        setTimeout(() => { copyBtn.innerText = '📋 Copy'; }, 1200);
      });
      const gmailBtn = document.createElement('button');
      gmailBtn.type = 'button';
      gmailBtn.className = 'btn btn-t bsm';
      gmailBtn.innerText = '📧 Open in Gmail';
      gmailBtn.addEventListener('click', () => {
        window.open(gmailComposeUrl(subject.value, body.value), '_blank');
      });
      btnRow.appendChild(copyBtn);
      btnRow.appendChild(gmailBtn);

      page.appendChild(subjLabel);
      page.appendChild(subject);
      page.appendChild(body);
      page.appendChild(btnRow);
      panel.appendChild(page);
      pages[key] = { tab, page };

      tab.addEventListener('click', () => {
        for (const { tab: t, page: p } of Object.values(pages)) {
          t.classList.remove('active');
          p.style.display = 'none';
        }
        tab.classList.add('active');
        page.style.display = 'block';
      });
    });
  }
}
