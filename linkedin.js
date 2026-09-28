// linkedin.js — Feature 2: LinkedIn auto-brief.
//
// Pure module shared by three contexts: content.js dynamic-imports the
// extractor (content scripts are classic scripts, so it arrives via
// chrome.runtime.getURL import), background.js sanitizes and stores the
// payload, popup.js decides whether to show the banner. Everything degrades
// to silence — a missing h1 or a DOM change means no banner, never a broken
// one.

export const CONTEXT_KEY = 'linkedinContext';
export const DISMISSED_KEY = 'linkedinDismissed';
export const DISMISSED_CAP = 20;

function textOf(el, cap = 120) {
  if (!el) return '';
  const t = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  return t.substring(0, cap);
}

// "Co-founder & CEO at Stripe" → { title, company }. LinkedIn headlines also
// come as "Title · Company · School" or "Title | Company" — parse the most
// specific signal first, fall back through the separators.
export function parseHeadline(headline) {
  const s = String(headline || '').replace(/\s+/g, ' ').trim();
  if (!s) return { title: '', company: '' };
  const at = s.lastIndexOf(' at ');
  if (at > 0 && at < s.length - 4) {
    return { title: s.slice(0, at).trim().substring(0, 120), company: s.slice(at + 4).split(/[·|]/)[0].trim().substring(0, 120) };
  }
  for (const sep of ['·', '|', '—']) {
    const parts = s.split(sep).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      return { title: parts[0].substring(0, 120), company: parts[1].substring(0, 120) };
    }
  }
  return { title: s.substring(0, 120), company: '' };
}

// URL shape gate before any DOM work: /in/<slug>/ profiles and /company/<slug>
// pages only. Everything else (feed, jobs, posts, sales navigator) → null.
export function linkedInPageKind(url) {
  try {
    const u = new URL(String(url || ''));
    const host = u.hostname.replace(/^www\./, '');
    if (!/(^|\.)linkedin\.com$/.test(host)) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'in' && parts[1]) return 'person';
    if (parts[0] === 'company' && parts[1]) return 'company';
    return null;
  } catch (e) {
    return null;
  }
}

export function extractLinkedInContext(doc, url) {
  const kind = linkedInPageKind(url);
  if (!kind || !doc) return null;
  try {
    const name = textOf(doc.querySelector('h1'));
    if (!name) return null; // profile still loading or DOM changed — silence
    if (kind === 'company') {
      return { kind, name, title: '', company: name, url: String(url) };
    }
    // Person: headline candidates, most-specific first. All may fail on a
    // DOM change — parseHeadline('') returns empties and the banner still
    // shows the name, which is the minimum useful signal.
    const headlineSelectors = [
      '.text-body-medium.break-words',
      'div[aria-hidden="true"] .text-body-medium',
      '.pv-top-card .text-body-medium',
    ];
    let headline = '';
    for (const sel of headlineSelectors) {
      headline = textOf(doc.querySelector(sel), 200);
      if (headline) break;
    }
    if (!headline && doc.body) {
      const lines = String(doc.body.innerText || '').split('\n').map((l) => l.trim());
      headline = lines.find((l) => l.length > 8 && l.length < 160 && / (at|·|\|) /.test(l) && l !== name) || '';
    }
    const { title, company } = parseHeadline(headline);
    return { kind, name, title, company, url: String(url) };
  } catch (e) {
    return null;
  }
}

// Background-side clamp: content-script input is untrusted-shaped by the time
// it reaches storage, so every field is bounded and typed before persisting.
export function sanitizeLinkedInContext(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const kind = payload.kind === 'person' || payload.kind === 'company' ? payload.kind : null;
  const name = String(payload.name || '').trim().substring(0, 120);
  if (!kind || !name) return null;
  return {
    kind,
    name,
    title: String(payload.title || '').trim().substring(0, 120),
    company: String(payload.company || '').trim().substring(0, 120),
    url: String(payload.url || '').trim().substring(0, 300),
    ts: Number(payload.ts) > 0 ? Number(payload.ts) : Date.now(),
  };
}

export function normalizeLinkedInUrl(url) {
  try {
    const u = new URL(String(url || ''));
    return `${u.origin}${u.pathname}`.replace(/\/$/, '');
  } catch (e) {
    return String(url || '');
  }
}

export function shouldShowBanner(context, dismissedUrls) {
  if (!context || !context.kind || !context.name) return false;
  const dismissed = (Array.isArray(dismissedUrls) ? dismissedUrls : []).map(normalizeLinkedInUrl);
  return !dismissed.includes(normalizeLinkedInUrl(context.url));
}

export async function dismissLinkedInUrl(storage, url) {
  if (!storage) return;
  try {
    const normalized = normalizeLinkedInUrl(url);
    const data = await storage.get([DISMISSED_KEY]);
    const list = Array.isArray(data?.[DISMISSED_KEY]) ? data[DISMISSED_KEY] : [];
    const next = [normalized, ...list.filter((u) => u !== normalized)].slice(0, DISMISSED_CAP);
    await storage.set({ [DISMISSED_KEY]: next, [CONTEXT_KEY]: null });
  } catch (e) {
    // dismissal persistence is best-effort; the banner is already hidden
  }
}
