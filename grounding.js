// grounding.js — Phase 1: reference-based element grounding for the Auto Task agent.
//
// Replaces fuzzy text-substring element picking with a two-stage design:
//   1. collectGroundingPage() — a SELF-CONTAINED function injected into a page
//      frame via chrome.scripting.executeScript({func}). It walks the DOM
//      (shadow-piercing, nav/footer tagging, visibility filtering), registers
//      every interactive element in a per-frame registry (window.__atomReg)
//      and returns raw records. It must NOT reference anything outside its
//      own scope — Chrome serializes its source.
//   2. Pure functions below (buildSnapshot, resolveName, reground, diffSnapshots)
//      run in the extension context (SW or popup) and in Node tests. All
//      policy lives here: ref assignment, name priority, caps, dedupe,
//      re-matching after SPA re-renders.
//
// Registry contract: each frame keeps window.__atomReg = [element, ...];
// refs resolve to rids (registry indices) recorded in snapshot.byRef, so
// clickRef/typeRef execute against the live element and can detect staleness.
// Refs are per-snapshot and never persisted across runs — recipes store the
// descriptor ({role, name, path}) instead and re-ground on replay.

export const MAX_ELEMENTS = 120;
export const MAX_NAME_LEN = 60;
export const MAX_PAGE_TEXT = 4000;
export const NAME_PRIORITY = ['aria', 'text', 'title', 'placeholder', 'value'];

// Implicit ARIA roles for the tags we enumerate. Anything with an explicit
// role attribute wins over these.
export const IMPLICIT_ROLES = {
  a: 'link',
  button: 'button',
  input: 'textbox',
  select: 'combobox',
  textarea: 'textbox',
  summary: 'button',
  option: 'option',
  iframe: 'frame'
};

export const INPUT_TYPE_ROLES = {
  checkbox: 'checkbox',
  radio: 'radio',
  number: 'spinbutton',
  range: 'slider',
  search: 'searchbox'
};

export const INTERACTIVE_SELECTOR = [
  'a', 'button', 'input', 'select', 'textarea', 'option', 'summary', 'iframe',
  '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="switch"]',
  '[role="tab"]', '[role="menuitem"]', '[role="option"]', '[role="combobox"]',
  '[onclick]', '[contenteditable="true"]', '[contenteditable=""]'
].join(',');

export function normalizeName(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

// Name resolution: aria-label → innerText → title → placeholder → value,
// first non-empty wins. Candidates are gathered in-page (cheap there),
// priority is applied here so tests can pin the order.
export function resolveName(candidates = {}, maxLen = MAX_NAME_LEN) {
  for (const source of NAME_PRIORITY) {
    const raw = candidates[source];
    const name = normalizeName(raw);
    if (name) return { name: name.slice(0, maxLen), source };
  }
  return { name: '', source: null };
}

export function implicitRole(rec) {
  if (rec.explicitRole) return normalizeName(rec.explicitRole).toLowerCase();
  const tag = String(rec.tag || '').toLowerCase();
  if (tag === 'input') {
    const t = String(rec.type || 'text').toLowerCase();
    return INPUT_TYPE_ROLES[t] || 'textbox';
  }
  return IMPLICIT_ROLES[tag] || (rec.onclick ? 'button' : 'generic');
}

export function refLabel(index, frameId = 0) {
  return frameId && frameId !== 0 ? `e${index + 1}@f${frameId}` : `e${index + 1}`;
}

function truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// One line per element, e.g.
//   [ref=e1] button "Search flights" (visible, enabled)
//   [ref=e2] textbox "Where from?" (value: "")
//   [ref=e3] link "Prices" (href: /pricing)
export function formatElementLine(ref, rec) {
  const bits = [];
  if (!rec.visible) bits.push('hidden');
  if (rec.disabled) bits.push('disabled');
  else bits.push('enabled');
  if (rec.checked) bits.push('checked');
  if (rec.role === 'textbox' || rec.role === 'searchbox' || rec.role === 'spinbutton') {
    bits.push(`value: "${truncate(rec.value == null ? '' : rec.value, 40)}"`);
  }
  if (rec.href) bits.push(`href: ${truncate(rec.href, 50)}`);
  if (rec.frameId && rec.frameId !== 0) bits.push('in iframe');
  if (rec.crossOrigin) bits.push('cross-origin — limited');
  const name = rec.name ? ` "${rec.name}"` : '';
  return `[ref=${ref}] ${rec.role}${name} (${bits.join(', ')})`;
}

export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

// ---- buildSnapshot ----------------------------------------------------
// raw: array of per-frame collector results, each:
//   { frameId, url, title, elements: [rawRecord...], outline, pageText }
// Records are enriched (role/name), nav/footer duplicates dropped, capped,
// refs assigned. Returns the object the agent + tools share:
//   { url, title, text, lines, byRef, frameIds, crossOriginFrames,
//     outline, pageText, tokenEstimate, elementCount }
export function buildSnapshot(rawFrames, opts = {}) {
  const maxElements = opts.maxElements || MAX_ELEMENTS;
  const maxNameLen = opts.maxNameLen || MAX_NAME_LEN;
  const frames = (Array.isArray(rawFrames) ? rawFrames : []).filter(Boolean);
  const top = frames.find(f => !f.frameId || f.frameId === 0) || frames[0] || { url: '', title: '', outline: [], pageText: '' };

  const seenNavKeys = new Set();
  const records = [];
  let truncated = false;

  for (const frame of frames) {
    const frameId = frame.frameId || 0;
    for (const raw of frame.elements || []) {
      if (records.length >= maxElements) { truncated = true; break; }
      const { name, source } = resolveName(raw.name || {}, maxNameLen);
      const rec = {
        ...raw,
        name,
        nameSource: source,
        role: implicitRole(raw),
        frameId,
        visible: raw.visible !== false,
        enabled: !raw.disabled
      };
      // Nav/footer dedupe: sticky navs and footers repeat the same links;
      // keep only the first occurrence of each role+name pair.
      if (raw.inNav) {
        const key = `${rec.role}::${normalizeName(rec.name).toLowerCase()}`;
        if (seenNavKeys.has(key)) continue;
        seenNavKeys.add(key);
      }
      records.push(rec);
    }
    if (truncated) break;
  }

  const lines = [];
  const byRef = {};
  records.forEach((rec, i) => {
    const ref = refLabel(i, rec.frameId);
    lines.push(formatElementLine(ref, rec));
    byRef[ref] = {
      rid: rec.rid,
      frameId: rec.frameId,
      role: rec.role,
      name: rec.name,
      path: rec.path,
      tag: rec.tag,
      href: rec.href || null,
      // Coordinates stay here (internal: SoM badges, scroll decisions);
      // never rendered into the LLM-visible snapshot text.
      rect: rec.rect || null,
      inViewport: !!rec.inViewport
    };
  });

  const header = `Page: ${truncate(top.title || top.url || '(untitled)', 90)}`;
  const text = [header, ...lines].join('\n');

  return {
    url: top.url || '',
    title: top.title || '',
    frameIds: frames.map(f => f.frameId || 0),
    crossOriginFrames: (top.crossOriginFrames || []).slice(0, 5),
    elementCount: records.length,
    truncated,
    lines,
    byRef,
    text,
    outline: (top.outline || []).slice(0, 20),
    pageText: truncate(top.pageText || '', MAX_PAGE_TEXT),
    tokenEstimate: estimateTokens(text) + estimateTokens(top.pageText || '')
  };
}

// ---- reground ---------------------------------------------------------
// Re-match a previous element descriptor after a re-render. Escalation:
//   1. role + exact name (case-insensitive)
//   2. role + substring either way
//   3. path similarity (trailing segments match) over role candidates
export function reground(desc, records) {
  if (!desc || !Array.isArray(records) || !records.length) return null;
  const wantRole = normalizeName(desc.role).toLowerCase();
  const wantName = normalizeName(desc.name).toLowerCase();
  const roleMatch = records.filter(r =>
    normalizeName(r.role).toLowerCase() === wantRole && r.ref
  );
  if (!roleMatch.length) return null;

  const exact = roleMatch.filter(r => normalizeName(r.name).toLowerCase() === wantName);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return pickByPath(exact, desc.path);

  const substr = roleMatch.filter(r => {
    const n = normalizeName(r.name).toLowerCase();
    return n && wantName && (n.includes(wantName) || wantName.includes(n));
  });
  if (substr.length === 1) return substr[0];
  if (substr.length > 1) return pickByPath(substr, desc.path);

  const byPath = roleMatch.filter(r => pathSimilarity(r.path, desc.path) > 0.5);
  if (byPath.length === 1) return byPath[0];
  if (byPath.length > 1) return pickByPath(byPath, desc.path);
  return null;
}

function pickByPath(candidates, path) {
  let best = null, bestScore = -1;
  for (const c of candidates) {
    const s = pathSimilarity(c.path, path);
    if (s > bestScore) { bestScore = s; best = c; }
  }
  return bestScore >= 0 ? best : null;
}

// Path similarity: fraction of trailing segments that match.
// 'div/nav/a[3]' vs 'div/nav/a[3]' = 1; 'div/footer/a[3]' = tail 'a[3]' only.
export function pathSimilarity(a, b) {
  const pa = String(a || '').split('/').filter(Boolean);
  const pb = String(b || '').split('/').filter(Boolean);
  if (!pa.length || !pb.length) return 0;
  let i = 0;
  while (i < pa.length && i < pb.length && pa[pa.length - 1 - i] === pb[pb.length - 1 - i]) i++;
  return i / Math.max(pa.length, pb.length);
}

// ---- diffSnapshots ----------------------------------------------------
// Compare two snapshots by role+name identity keys (refs churn across
// re-renders; identity does not). Returns the observation payload used
// after every action.
export function diffSnapshots(prev, next) {
  const keyOf = s => new Map(
    Object.values(s.byRef || {}).map(r => [`${r.role}::${normalizeName(r.name).toLowerCase()}`, r])
  );
  const a = prev ? keyOf(prev) : new Map();
  const b = keyOf(next);
  const added = [], removed = [];
  for (const [k, r] of b) if (!a.has(k)) added.push(r);
  for (const [k, r] of a) if (!b.has(k)) removed.push(r);
  const keyText = truncate(added.map(r => r.name || r.role).join(' · '), 300);
  return {
    added: added.length,
    removed: removed.length,
    snapshotDiff: `+${added.length} -${removed.length} elements`,
    keyText,
    urlChanged: !prev || prev.url !== next.url
  };
}

// ---- in-page collector (SELF-CONTAINED — no external references) ------
// Runs in one frame. Registers interactive elements into window.__atomReg
// (grow-only, capped) and returns raw records for buildSnapshot().
export function collectGroundingPage(maxElements = 160) {
  const doc = document;
  const win = window;
  if (!doc || !doc.body) return { error: 'NO_DOCUMENT' };

  const REG_KEY = '__atomReg';
  if (!win[REG_KEY]) win[REG_KEY] = [];
  const reg = win[REG_KEY];
  const REG_CAP = 2000;

  const INTERACTIVE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'SUMMARY', 'IFRAME']);
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'META', 'TITLE', 'HEAD', 'SVG', 'PATH', 'TEMPLATE']);
  const NODE_CAP = 20000;

  const norm = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) return false;
    const cs = win.getComputedStyle ? win.getComputedStyle(el) : null;
    if (cs) {
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      if (el.offsetParent === null && cs.position !== 'fixed' && cs.position !== 'sticky') return false;
    } else if (el.offsetParent === null) {
      return false;
    }
    return true;
  }

  function isInteractive(el) {
    const tag = el.tagName;
    if (INTERACTIVE.has(tag)) return true;
    const role = el.getAttribute && el.getAttribute('role');
    if (role && /^(button|link|checkbox|switch|tab|menuitem|option|combobox|textbox)$/i.test(role)) return true;
    if (el.hasAttribute && el.hasAttribute('onclick')) return true;
    const ce = el.getAttribute && el.getAttribute('contenteditable');
    if (ce === 'true' || ce === '') return true;
    return false;
  }

  function inNavOrFooter(el) {
    let p = el.parentElement;
    let hops = 0;
    while (p && hops < 30) {
      const tag = p.tagName;
      if (tag === 'NAV' || tag === 'FOOTER') return true;
      const role = p.getAttribute && p.getAttribute('role');
      if (role === 'navigation' || role === 'banner') return true;
      p = p.parentElement;
      hops++;
    }
    return false;
  }

  function computePath(el) {
    const parts = [];
    let node = el;
    let hops = 0;
    while (node && hops < 15) {
      const tag = String(node.tagName || '').toLowerCase();
      if (!tag) break;
      let seg = tag;
      if (node.id) {
        seg = `${tag}[@id="${node.id}"]`;
        parts.unshift(seg);
        break;
      }
      const parent = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
      if (parent) {
        let idx = 1;
        let sib = parent.firstElementChild;
        while (sib && sib !== node) {
          if (sib.tagName === node.tagName) idx++;
          sib = sib.nextElementSibling;
        }
        seg = `${tag}[${idx}]`;
      }
      parts.unshift(seg);
      const root = node.getRootNode && node.getRootNode();
      if (root && root.host) { parts.unshift('#shadow'); node = root.host; }
      else node = node.parentElement;
      hops++;
    }
    return parts.join('/');
  }

  function nameCandidates(el) {
    const ownText = (el.childNodes ? Array.from(el.childNodes) : [])
      .filter(n => n.nodeType === 3)
      .map(n => norm(n.textContent))
      .join(' ');
    const inner = norm(el.innerText != null ? el.innerText : el.textContent);
    return {
      aria: norm(el.getAttribute && el.getAttribute('aria-label')),
      text: ownText || inner,
      title: norm(el.getAttribute && el.getAttribute('title')),
      placeholder: norm(el.getAttribute && el.getAttribute('placeholder')),
      value: (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.type !== 'password'
        ? norm(el.value) : ''
    };
  }

  const vw = win.innerWidth || 1280, vh = win.innerHeight || 800;
  const elements = [];
  const outline = [];
  const crossOriginFrames = [];
  let visited = 0;

  function walk(root, depth) {
    if (elements.length >= maxElements || visited >= NODE_CAP) return;
    let kids = root.children || [];
    for (let i = 0; i < kids.length; i++) {
      const el = kids[i];
      if (!el || !el.tagName) continue;
      if (SKIP_TAGS.has(el.tagName)) continue;
      visited++;
      if (/^H[1-4]$/.test(el.tagName)) {
        const t = norm(el.textContent).slice(0, 80);
        if (t && outline.length < 20) outline.push({ tag: el.tagName.toLowerCase(), text: t });
      }
      if (el.tagName === 'IFRAME') {
        crossOriginFrames.push({
          src: (el.getAttribute('src') || '').slice(0, 100),
          title: norm(el.getAttribute('title')).slice(0, 60)
        });
      }
      if (isInteractive(el)) {
        const visible = isVisible(el);
        // Keep hidden interactives out entirely — the snapshot is an action menu.
        if (visible && elements.length < maxElements) {
          const rect = el.getBoundingClientRect();
          const rid = reg.length >= REG_CAP ? 0 : reg.push(el) - 1;
          elements.push({
            rid,
            tag: el.tagName.toLowerCase(),
            id: norm(el.id).slice(0, 40) || null,
            explicitRole: norm(el.getAttribute('role')) || '',
            type: norm(el.getAttribute('type')).toLowerCase(),
            name: nameCandidates(el),
            value: (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.type !== 'password'
              ? String(el.value == null ? '' : el.value).slice(0, 120) : '',
            checked: !!el.checked,
            disabled: !!el.disabled || (el.getAttribute && el.getAttribute('aria-disabled') === 'true'),
            href: el.tagName === 'A' ? String(el.getAttribute('href') || '').slice(0, 120) : null,
            visible: true,
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
            inViewport: rect.top < vh && rect.bottom > 0 && rect.left < vw && rect.right > 0,
            inNav: inNavOrFooter(el),
            onclick: !!((el.getAttribute && el.getAttribute('onclick')) || (el.onclick && typeof el.onclick === 'function')),
            path: computePath(el)
          });
        }
      }
      if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
      if (depth < 25) walk(el, depth + 1);
    }
  }

  walk(doc.body, 0);

  let pageText = '';
  try { pageText = norm(doc.body.innerText != null ? doc.body.innerText : doc.body.textContent).slice(0, 4000); } catch (e) { pageText = ''; }

  return {
    url: location.href,
    title: norm(doc.title).slice(0, 120),
    elements,
    outline,
    pageText,
    crossOriginFrames,
    viewport: { w: vw, h: vh },
    scrollY: Math.round(win.scrollY || 0)
  };
}

// Descriptor for a ref in a snapshot (what recipes + reground consume).
export function descriptorFor(snapshot, ref) {
  const r = snapshot && snapshot.byRef && snapshot.byRef[ref];
  if (!r) return null;
  return { role: r.role, name: r.name, path: r.path, tag: r.tag };
}

// Search a snapshot's records by text query — the grounded replacement for
// legacy clickText matching. Interactive roles with exact/substring matches
// are strong candidates; non-interactive exact matches are weak (clicking a
// headline does nothing); substring noise from non-interactive text is
// dropped. The caller disambiguates — never first-match-wins.
const STRONG_ROLES = ['link', 'button', 'tab', 'menuitem', 'option', 'checkbox', 'switch', 'textbox', 'combobox', 'searchbox', 'spinbutton', 'slider'];

export function searchSnapshot(snapshot, query) {
  const q = normalizeName(query).toLowerCase();
  if (!q) return { strong: [], weak: [] };
  const strong = [], weak = [];
  for (const [ref, r] of Object.entries((snapshot && snapshot.byRef) || {})) {
    const name = normalizeName(r.name).toLowerCase();
    if (!name) continue;
    const exact = name === q;
    const substr = name.includes(q) || q.includes(name);
    if (STRONG_ROLES.includes(r.role)) {
      if (exact || substr) strong.push(ref);
    } else if (exact) {
      weak.push(ref);
    }
  }
  return { strong: dedupeRefs(strong), weak: dedupeRefs(weak) };
}

function dedupeRefs(refs) {
  return [...new Set(refs)];
}
