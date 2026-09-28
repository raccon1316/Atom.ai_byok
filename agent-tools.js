// agent-tools.js — Phase 1: grounded action tools for the Auto Task agent.
//
// Runs in the extension context (service worker for Auto Task runs; popup for
// the legacy clickText path). Every action:
//   1. resolves a snapshot ref → {frameId, rid, descriptor}
//   2. executes a self-contained in-page function (serialized by
//      chrome.scripting.executeScript) against the live element
//   3. returns a structured observation {ok, url, title, urlChanged,
//      snapshotDiff, keyText} — no fixed sleeps, no "wait and hope".
//
// Dependencies (chrome.scripting / chrome.tabs) are constructor-injected so
// Node tests can drive the layer with mocks.

import {
  buildSnapshot, collectGroundingPage, diffSnapshots, normalizeName, searchSnapshot
} from './grounding.js';
import { nextStrategy, regroundRef, buildBadges, buildVisionPrompt, parseVisionChoice } from './recovery.js';

export const QUIET_MS = 800;
export const QUIET_MAX_MS = 10000;
export const SETTLE_MS = 150;

// ---------------------------------------------------------------------------
// In-page action functions. Each is fully self-contained (no external refs)
// because chrome.scripting serializes its source into the page.
// ---------------------------------------------------------------------------

export function atomClickByRid(rid, path, name) {
  const reg = window.__atomReg;
  const el = reg && reg[rid];
  if (!el || !el.isConnected) return { ok: false, reason: 'STALE_REF' };
  const norm = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const actual = norm(el.innerText != null ? el.innerText : el.textContent).slice(0, 60);
  if (name && actual && norm(name).slice(0, 30) !== actual.slice(0, 30)) {
    return { ok: false, reason: 'REF_MISMATCH', expected: norm(name).slice(0, 40), actual };
  }
  if (el.disabled) return { ok: false, reason: 'DISABLED' };
  try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
  const common = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y };
  const evs = [];
  if (typeof PointerEvent === 'function') {
    evs.push(['pointerdown', new PointerEvent('pointerdown', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, common))]);
    evs.push(['pointerup', new PointerEvent('pointerup', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, common))]);
  }
  evs.push(['mousedown', new MouseEvent('mousedown', common)]);
  evs.push(['mouseup', new MouseEvent('mouseup', common)]);
  const clickEv = new MouseEvent('click', Object.assign({ detail: 1 }, common));
  evs.push(['click', clickEv]);
  for (const [, ev] of evs) el.dispatchEvent(ev);

  const hrefBefore = location.href;
  const tag = el.tagName;
  const href = tag === 'A' ? el.getAttribute('href') : null;
  const target = tag === 'A' ? el.getAttribute('target') : null;

  return new Promise(resolve => {
    setTimeout(() => {
      // Untrusted (synthesized) clicks do not run default activation
      // behavior, so finish navigations/form-submits the page itself
      // didn't handle from its own listeners.
      try {
        if (!clickEv.defaultPrevented) {
          if (tag === 'A' && href && (!target || target === '_self') && location.href === hrefBefore) {
            el.ownerDocument.location.assign(href);
          } else if (tag === 'BUTTON') {
            const form = el.form || el.closest && el.closest('form');
            const type = (el.getAttribute('type') || '').toLowerCase();
            if (form && (type === 'submit' || !type)) {
              if (form.requestSubmit) form.requestSubmit(el); else form.submit();
            }
          }
        }
      } catch (e) {}
      resolve({ ok: true, clicked: actual || norm(name).slice(0, 60) || tag.toLowerCase(), navigated: location.href !== hrefBefore });
    }, 60);
  });
}

export function atomTypeByRid(rid, text, clear, submit) {
  const reg = window.__atomReg;
  const el = reg && reg[rid];
  if (!el || !el.isConnected) return { ok: false, reason: 'STALE_REF' };
  if (el.disabled) return { ok: false, reason: 'DISABLED' };
  const value = String(text == null ? '' : text);
  try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
  el.focus();
  const isField = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
  if (!isField) return { ok: false, reason: 'NOT_EDITABLE', tag: el.tagName };
  if ((el.type || '').toLowerCase() === 'password') return { ok: false, reason: 'PASSWORD_FIELD' };

  let used = '';
  if (clear !== false) {
    if (el.setSelectionRange && el.value != null) {
      try { el.setSelectionRange(0, el.value.length); } catch (e) {}
    }
    used = document.execCommand && document.execCommand('insertText', false, value) ? 'insertText' : '';
    if (!used) {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
      if (setter) setter.call(el, value); else el.value = value;
      used = 'nativeSetter';
    }
  } else {
    used = document.execCommand && document.execCommand('insertText', false, value) ? 'insertText' : '';
    if (!used) {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
      if (setter) setter.call(el, el.value + value); else el.value = el.value + value;
      used = 'nativeSetter';
    }
  }
  if (used === 'nativeSetter' || used === '') {
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }
  const actual = el.isContentEditable ? String(el.innerText == null ? '' : el.innerText) : String(el.value == null ? '' : el.value);

  if (submit) {
    const keyOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
    el.dispatchEvent(new KeyboardEvent('keydown', keyOpts));
    el.dispatchEvent(new KeyboardEvent('keyup', keyOpts));
    const form = el.form || (el.closest && el.closest('form'));
    if (form && form.requestSubmit) { try { form.requestSubmit(); } catch (e) {} }
  }
  const matched = actual === value;
  return { ok: true, method: used, value: actual.slice(0, 120), matched, expected: value.slice(0, 120) };
}

export function atomSelectByRid(rid, option) {
  const reg = window.__atomReg;
  const el = reg && reg[rid];
  if (!el || !el.isConnected) return { ok: false, reason: 'STALE_REF' };
  if (el.tagName !== 'SELECT') return { ok: false, reason: 'NOT_SELECT', tag: el.tagName };
  if (el.disabled) return { ok: false, reason: 'DISABLED' };
  const want = String(option == null ? '' : option).replace(/\s+/g, ' ').trim().toLowerCase();
  const opts = Array.from(el.options || []);
  let best = null, bestScore = 0;
  for (const o of opts) {
    const t = String(o.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const v = String(o.value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    let score = 0;
    if (t === want || v === want) score = 3;
    else if (t.includes(want) || want.includes(t)) score = 2;
    else if (v.includes(want)) score = 1;
    if (score > bestScore) { bestScore = score; best = o; }
  }
  if (!best) return { ok: false, reason: 'OPTION_NOT_FOUND', wanted: want };
  el.value = best.value;
  el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  return { ok: true, selected: String(best.textContent || '').trim().slice(0, 60) };
}

export function atomHoverByRid(rid) {
  const reg = window.__atomReg;
  const el = reg && reg[rid];
  if (!el || !el.isConnected) return { ok: false, reason: 'STALE_REF' };
  const rect = el.getBoundingClientRect();
  const common = { bubbles: true, cancelable: true, composed: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  if (typeof PointerEvent === 'function') {
    el.dispatchEvent(new PointerEvent('pointerover', Object.assign({ pointerId: 1, pointerType: 'mouse' }, common)));
    el.dispatchEvent(new PointerEvent('pointerenter', Object.assign({ pointerId: 1, pointerType: 'mouse' }, common)));
  }
  el.dispatchEvent(new MouseEvent('mouseover', common));
  el.dispatchEvent(new MouseEvent('mouseenter', Object.assign({}, common, { bubbles: false })));
  return { ok: true, hovered: true };
}

export function atomScrollByRid(rid) {
  const reg = window.__atomReg;
  const el = reg && reg[rid];
  if (!el || !el.isConnected) return { ok: false, reason: 'STALE_REF' };
  try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
  return { ok: true, scrolledTo: true };
}

export function atomPressKey(key) {
  const el = document.activeElement || document.body;
  if (!el) return { ok: false, reason: 'NO_FOCUS' };
  const k = String(key || '');
  const codeMap = { Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', ArrowDown: 'ArrowDown', ArrowUp: 'ArrowUp', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight' };
  const opts = { key: k, code: codeMap[k] || k, bubbles: true, cancelable: true, composed: true };
  el.dispatchEvent(new KeyboardEvent('keydown', opts));
  el.dispatchEvent(new KeyboardEvent('keyup', opts));
  if (k === 'Enter') {
    const form = el.form || (el.closest && el.closest('form'));
    if (form && form.requestSubmit) { try { form.requestSubmit(); } catch (e) {} }
  }
  return { ok: true, key: k, on: (el.tagName || 'body').toLowerCase() };
}

export function atomScrollPage(dir, amount) {
  const d = dir === 'up' ? -1 : 1;
  window.scrollBy({ top: d * (amount || 600), behavior: 'instant' in window ? 'instant' : 'auto' });
  return { ok: true, scrollY: Math.round(window.scrollY || 0) };
}

export function atomInstallQuietWatch() {
  const w = window;
  if (w.__atomQuietInstalled) return { ok: true, installed: false };
  w.__atomQuietInstalled = true;
  const state = w.__atomQuietState = { lastRes: Date.now(), lastMut: Date.now() };
  try {
    new PerformanceObserver(list => { state.lastRes = Date.now(); })
      .observe({ entryTypes: ['resource'] });
  } catch (e) {}
  try {
    new MutationObserver(() => { state.lastMut = Date.now(); })
      .observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  } catch (e) {}
  return { ok: true, installed: true };
}

export function atomReadQuiet() {
  return window.__atomQuietState ? {
    lastRes: window.__atomQuietState.lastRes,
    lastMut: window.__atomQuietState.lastMut,
    now: Date.now()
  } : null;
}

export function atomReadState() {
  return {
    url: location.href,
    title: String(document.title || '').slice(0, 120),
    readyState: document.readyState,
    interactiveCount: (window.__atomReg || []).filter(el => el && el.isConnected).length
  };
}

// State probe for the waitFor* family — polled by the extension side.
export function atomWaitCheck(params) {
  const out = { url: location.href, title: String(document.title || '').slice(0, 120) };
  const body = document.body;
  const text = body ? String(body.innerText == null ? '' : body.innerText) : '';
  if (params && params.text) out.foundText = text.toLowerCase().includes(String(params.text).toLowerCase());
  if (params && params.urlPattern) {
    try { out.urlMatched = new RegExp(params.urlPattern, 'i').test(location.href); }
    catch (e) { out.urlMatched = false; }
  }
  if (params && params.selector) {
    let n = 0;
    try { n = document.querySelectorAll(params.selector).length; } catch (e) { n = 0; }
    out.count = n;
  }
  out.hasPasswordField = !!document.querySelector('input[type="password"]');
  return out;
}

// Set-of-Mark painting: numbered overlays over badge rects so the screenshot
// sent to the vision model is annotated. Coordinates are viewport-relative.
export function atomPaintBadges(badges) {
  try { document.getElementById('__atom-som')?.remove(); } catch (e) {}
  const layer = document.createElement('div');
  layer.id = '__atom-som';
  layer.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
  let painted = 0;
  for (const b of (badges || [])) {
    const r = b.rect || {};
    if (!r.w && !r.h) continue;
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed', `left:${r.x}px`, `top:${r.y}px`, `width:${r.w}px`, `height:${r.h}px`,
      'border:2px solid #ff3b6b', 'background:rgba(255,59,107,0.08)',
      'pointer-events:none'
    ].join(';');
    const tag = document.createElement('div');
    tag.textContent = String(b.n);
    tag.style.cssText = 'position:absolute;left:0;top:0;transform:translate(-4px,-14px);background:#ff3b6b;color:#fff;font:bold 11px/1.2 system-ui,sans-serif;padding:1px 4px;border-radius:3px;';
    el.appendChild(tag);
    layer.appendChild(el);
    painted++;
  }
  document.documentElement.appendChild(layer);
  return { ok: true, painted };
}

export function atomClearBadges() {
  const gone = !!document.getElementById('__atom-som');
  document.getElementById('__atom-som')?.remove();
  return { ok: true, removed: gone };
}

// ---------------------------------------------------------------------------
// Extension-context tool layer.
// ---------------------------------------------------------------------------

export class AgentTools {
  constructor({ scripting, tabs, collectMax = 160 } = {}) {
    this.scripting = scripting || (typeof chrome !== 'undefined' ? chrome.scripting : null);
    this.tabs = tabs || (typeof chrome !== 'undefined' ? chrome.tabs : null);
    this.collectMax = collectMax;
    this.snapshots = new Map(); // tabId -> last full snapshot
  }

  async exec(tabId, func, args = [], frameId = null, allFrames = false) {
    const target = { tabId };
    if (allFrames) target.allFrames = true;
    else if (frameId != null) target.frameIds = [frameId];
    try {
      const results = await this.scripting.executeScript({ target, func, args });
      if (!results || !results.length) return { ok: false, reason: 'NO_RESULT' };
      return results[0].result;
    } catch (e) {
      const msg = String(e && e.message || e);
      if (/cannot access|host permission|frame with id/i.test(msg)) return { ok: false, reason: 'NO_ACCESS', error: msg };
      return { ok: false, reason: 'EXEC_ERROR', error: msg };
    }
  }

  async execAllFrames(tabId, func, args = []) {
    try {
      const results = await this.scripting.executeScript({ target: { tabId, allFrames: true }, func, args });
      return (results || []).map(r => ({ frameId: r.frameId || 0, result: r.result })).filter(r => r.result);
    } catch (e) {
      const msg = String(e && e.message || e);
      if (/cannot access|host permission/i.test(msg)) return { ok: false, reason: 'NO_ACCESS', error: msg };
      return { ok: false, reason: 'EXEC_ERROR', error: msg };
    }
  }

  async snapshot(tabId, { maxElements } = {}) {
    const frames = await this.execAllFrames(tabId, collectGroundingPage, [this.collectMax]);
    if (!Array.isArray(frames)) return frames; // NO_ACCESS / EXEC_ERROR
    // execAllFrames returns raw chrome.scripting wrappers ([{frameId, result}]);
    // buildSnapshot wants the collector's page object per frame. Unwrapping is
    // required: without it every frame had `elements === undefined`, byRef came
    // back empty, and every ref action failed UNKNOWN_REF (which then escalated
    // to a vision tier that can never produce badges).
    const pages = frames.map(f => ({ frameId: f.frameId || 0, ...(f.result || {}) }));
    const snap = buildSnapshot(pages, { maxElements });
    this.snapshots.set(tabId, snap);
    return snap;
  }

  resolve(tabId, ref) {
    const snap = this.snapshots.get(tabId);
    if (!snap) return { ok: false, reason: 'NO_SNAPSHOT' };
    const rec = snap.byRef[ref];
    if (!rec) return { ok: false, reason: 'UNKNOWN_REF', ref };
    return { ok: true, rec, snap };
  }

  async observe(tabId, prevSnapshot = null) {
    const prev = prevSnapshot || this.snapshots.get(tabId) || null;
    const next = await this.snapshot(tabId);
    if (!next.byRef) return { ok: false, reason: next.reason || 'SNAPSHOT_FAILED' };
    const diff = diffSnapshots(prev, next);
    return {
      ok: true,
      url: next.url,
      title: next.title,
      elementCount: next.elementCount,
      // Post-action page text. diffSnapshots' keyText is only the NAMES of added
      // elements, so it cannot back a "text contains X" criterion on its own.
      text: String(next.pageText || '').slice(0, 1500),
      ...diff
    };
  }

  async clickRef(tabId, ref) {
    const r = this.resolve(tabId, ref);
    if (!r.ok) return { ok: false, reason: r.reason };
    const { rid, frameId, name, path } = r.rec;
    const res = await this.exec(tabId, atomClickByRid, [rid, path, name], frameId);
    if (!res || res.ok === false) return res || { ok: false, reason: 'EXEC_ERROR' };
    await this.waitForQuiet(tabId, { maxMs: 4000 });
    const observation = await this.observe(tabId);
    return { ...res, observation };
  }

  async typeRef(tabId, ref, text, { clear = true, submit = false } = {}) {
    const r = this.resolve(tabId, ref);
    if (!r.ok) return { ok: false, reason: r.reason };
    const { rid, frameId } = r.rec;
    const res = await this.exec(tabId, atomTypeByRid, [rid, text, clear, submit], frameId);
    if (!res || res.ok === false) return res || { ok: false, reason: 'EXEC_ERROR' };
    if (submit) await this.waitForQuiet(tabId, { maxMs: 5000 });
    const observation = await this.observe(tabId);
    return { ...res, observation };
  }

  async selectRef(tabId, ref, option) {
    const r = this.resolve(tabId, ref);
    if (!r.ok) return { ok: false, reason: r.reason };
    const res = await this.exec(tabId, atomSelectByRid, [r.rec.rid, option], r.rec.frameId);
    if (!res || res.ok === false) return res || { ok: false, reason: 'EXEC_ERROR' };
    await this.waitForQuiet(tabId, { maxMs: 3000 });
    const observation = await this.observe(tabId);
    return { ...res, observation };
  }

  async hoverRef(tabId, ref) {
    const r = this.resolve(tabId, ref);
    if (!r.ok) return { ok: false, reason: r.reason };
    const res = await this.exec(tabId, atomHoverByRid, [r.rec.rid], r.rec.frameId);
    return res || { ok: false, reason: 'EXEC_ERROR' };
  }

  async scrollRef(tabId, ref) {
    const r = this.resolve(tabId, ref);
    if (!r.ok) return { ok: false, reason: r.reason };
    const res = await this.exec(tabId, atomScrollByRid, [r.rec.rid], r.rec.frameId);
    if (!res || res.ok === false) return res;
    await this.wait(SETTLE_MS);
    return { ...res, observation: await this.observe(tabId) };
  }

  async pressKey(tabId, key) {
    const res = await this.exec(tabId, atomPressKey, [key]);
    if (!res || res.ok === false) return res || { ok: false, reason: 'EXEC_ERROR' };
    await this.waitForQuiet(tabId, { maxMs: 3000 });
    return { ...res, observation: await this.observe(tabId) };
  }

  async scroll(tabId, dir = 'down', amount = 600) {
    const res = await this.exec(tabId, atomScrollPage, [dir, amount]);
    if (!res || res.ok === false) return res || { ok: false, reason: 'EXEC_ERROR' };
    await this.wait(SETTLE_MS);
    return { ...res, observation: await this.observe(tabId) };
  }

  async navigate(tabId, url) {
    try {
      await this.tabs.update(tabId, { url });
    } catch (e) {
      return { ok: false, reason: 'NAV_FAILED', error: String(e && e.message || e) };
    }
    await this.waitForLoad(tabId, 15000);
    const observation = await this.observe(tabId);
    return { ok: true, navigatedTo: observation.url, observation };
  }

  async waitForLoad(tabId, timeoutMs = 15000) {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < timeoutMs) {
      last = await this.exec(tabId, atomReadState);
      if (last && last.readyState === 'complete') return last;
      await this.wait(250);
    }
    return last || { ok: false, reason: 'LOAD_TIMEOUT' };
  }

  // Quiet = no network resources for QUIET_MS and no DOM mutations for 500ms,
  // bounded by maxMs (noisy SPA pages never fully quiet — proceed at the cap).
  async waitForQuiet(tabId, { quietMs = QUIET_MS, mutMs = 500, maxMs = QUIET_MAX_MS } = {}) {
    await this.exec(tabId, atomInstallQuietWatch);
    const t0 = Date.now();
    let state = null;
    while (Date.now() - t0 < maxMs) {
      state = await this.exec(tabId, atomReadQuiet);
      const now = state && state.now || Date.now();
      if (state && now - state.lastRes >= quietMs && now - state.lastMut >= mutMs) return { ok: true, quiet: true, waitedMs: Date.now() - t0 };
      await this.wait(200);
    }
    return { ok: true, quiet: false, waitedMs: Date.now() - t0, reason: 'QUIET_TIMEOUT' };
  }

  wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async readState(tabId) {
    return await this.exec(tabId, atomReadState);
  }

  // ---- state-based waits (replacements for fixed sleeps) ---------------
  // Polls a state probe until every requested condition holds, bounded by
  // timeoutMs. Returns {ok, matched, elapsedMs, last}.
  async waitForState(tabId, { text, urlPattern, selector, minCount = 1, timeoutMs = 8000, pollMs = 250 } = {}) {
    const probe = {};
    if (text != null) probe.text = text;
    if (urlPattern != null) probe.urlPattern = urlPattern;
    if (selector != null) probe.selector = selector;
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < timeoutMs) {
      last = await this.exec(tabId, atomWaitCheck, [probe]);
      if (last && last.ok !== false) {
        const checks = [];
        if (text != null) checks.push(last.foundText === true);
        if (urlPattern != null) checks.push(last.urlMatched === true);
        if (selector != null) checks.push((last.count || 0) >= minCount);
        if (checks.length && checks.every(Boolean)) {
          return { ok: true, matched: true, elapsedMs: Date.now() - t0, last };
        }
      }
      await this.wait(pollMs);
    }
    return { ok: false, matched: false, elapsedMs: Date.now() - t0, last, reason: 'WAIT_TIMEOUT' };
  }

  waitForText(tabId, text, timeoutMs = 8000) {
    return this.waitForState(tabId, { text, timeoutMs });
  }

  waitForUrl(tabId, urlPattern, timeoutMs = 10000) {
    return this.waitForState(tabId, { urlPattern, timeoutMs });
  }

  waitForCount(tabId, selector, count = 1, timeoutMs = 8000) {
    return this.waitForState(tabId, { selector, minCount: count, timeoutMs });
  }

  // ---- Set-of-Mark capture (vision fallback) ----------------------------
  // Paints numbered badge overlays, captures the visible tab, clears the
  // overlays. Needs a captureVisibleTab implementation (injected for tests).
  async captureSoM(tabId, badges) {
    if (!badges || !badges.length) return { ok: false, reason: 'NO_BADGES' };
    const painted = await this.exec(tabId, atomPaintBadges, [badges]);
    if (!painted || painted.ok === false) return { ok: false, reason: 'PAINT_FAILED' };
    let dataUrl = null;
    try {
      if (!this.capture) throw new Error('captureVisibleTab unavailable');
      dataUrl = await this.capture(tabId, { format: 'jpeg', quality: 60 });
    } catch (e) {
      await this.exec(tabId, atomClearBadges);
      return { ok: false, reason: 'CAPTURE_FAILED', error: String(e && e.message || e) };
    }
    await this.exec(tabId, atomClearBadges);
    return { ok: true, dataUrl, painted: painted.painted };
  }

  // ---- recovery-orchestrated action -------------------------------------
  // One grounded action, retried up the escalation ladder until it lands or
  // the policy gives up. Vision tier calls deps.vision({snapshot, prompt,
  // badges, target}) → free-text answer (runner wires the LLM + screenshot).
  async executeWithRecovery(tabId, action, deps = {}) {
    const prevSnap = this.snapshots.get(tabId);
    if (!prevSnap) await this.snapshot(tabId);
    let ref = action.ref;
    let attempt = 0;
    let visionCalls = 0;
    let lastRes = null;
    const maxLoops = 8; // hard bound: 3 ladder + 2 vision + slack
    for (let i = 0; i < maxLoops; i++) {
      lastRes = await this.runAction(tabId, ref, action);
      if (lastRes && lastRes.ok) {
        const noEffect = lastRes.observation &&
          lastRes.observation.added === 0 && lastRes.observation.removed === 0 && !lastRes.observation.urlChanged;
        return { ...lastRes, noEffect: !!noEffect, recovered: attempt > 0, attempts: attempt + 1, visionCalls };
      }
      const reason = (lastRes && lastRes.reason) || 'EFFECT_FAILED';
      const strategy = nextStrategy(reason, { attempt, visionCalls });
      if (strategy === 'GIVE_UP') {
        return { ok: false, reason, attempts: attempt, visionCalls };
      }
      if (strategy === 'REGROUND' || strategy === 'ALT_NAME' || strategy === 'WAIT_QUIET') {
        if (strategy === 'WAIT_QUIET') await this.waitForQuiet(tabId, { maxMs: 6000 });
        const fresh = await this.snapshot(tabId);
        if (fresh.byRef) {
          const crossRole = strategy === 'ALT_NAME';
          const newRef = regroundRef(prevSnap || fresh, ref, fresh, { crossRole });
          if (newRef) ref = newRef;
        }
        attempt++;
      } else if (strategy === 'VISION') {
        visionCalls++;
        const fresh = await this.snapshot(tabId);
        if (!fresh.byRef) return { ok: false, reason: 'SNAPSHOT_FAILED', visionCalls, attempts: attempt };
        const badges = buildBadges(fresh, { inViewportOnly: true });
        if (!badges.length) return { ok: false, reason: 'NO_BADGES', visionCalls, attempts: attempt };
        const currentName = (fresh.byRef[ref] && fresh.byRef[ref].name) || '';
        const target = action.targetDescription || action.text || currentName || `the element at ${ref}`;
        const prompt = buildVisionPrompt(badges, target);
        let answer = null;
        if (deps && typeof deps.vision === 'function') {
          answer = await deps.vision({ snapshot: fresh, badges, prompt, target });
        }
        const picked = parseVisionChoice(answer, badges);
        if (!picked) {
          return { ok: false, reason: 'VISION_NO_MATCH', visionCalls, attempts: attempt };
        }
        ref = picked;
      } else {
        return { ok: false, reason: 'UNKNOWN_STRATEGY', visionCalls };
      }
    }
    return { ok: false, reason: 'RECOVERY_LOOP_EXHAUSTED', attempts: attempt, visionCalls };
  }

  async runAction(tabId, ref, action) {
    switch (action.kind) {
      case 'click': return await this.clickRef(tabId, ref);
      case 'type': return await this.typeRef(tabId, ref, action.text, { clear: action.clear, submit: action.submit });
      case 'select': return await this.selectRef(tabId, ref, action.option);
      case 'hover': return await this.hoverRef(tabId, ref);
      case 'scrollRef': return await this.scrollRef(tabId, ref);
      default: return { ok: false, reason: 'UNKNOWN_ACTION_KIND' };
    }
  }
}

// Format an action result for the LLM's observation channel — compact,
// structured, no coordinates.
export function formatObservation(res) {
  if (!res) return 'ERROR: no result';
  if (res.ok === false) return `EFFECT_FAILED (${res.reason || 'unknown'}${res.error ? ': ' + String(res.error).slice(0, 120) : ''})`;
  const parts = [];
  if (res.clicked) parts.push(`clicked "${String(res.clicked).slice(0, 60)}"`);
  if (res.value !== undefined) parts.push(`typed${res.matched === false ? ' (MISMATCH: got "' + String(res.value).slice(0, 40) + '" expected "' + String(res.expected).slice(0, 40) + '")' : ' ok: "' + String(res.value).slice(0, 60) + '"'}`);
  if (res.selected) parts.push(`selected "${String(res.selected).slice(0, 40)}"`);
  if (res.navigatedTo) parts.push(`navigated to ${String(res.navigatedTo).slice(0, 100)}`);
  if (res.key) parts.push(`pressed ${res.key}`);
  if (res.scrollY !== undefined) parts.push(`scrollY=${res.scrollY}`);
  if (res.hovered) parts.push('hovered');
  // Extracted data IS the evidence for extraction steps — without it the run's
  // timeline (and the DONE-validator that reads it) sees only a URL.
  if (res.extracted !== undefined) parts.push(`extracted: ${String(res.extracted).slice(0, 300)}`);
  const obs = res.observation;
  if (obs && obs.ok) {
    parts.push(`url=${String(obs.url).slice(0, 90)}`);
    if (obs.urlChanged) parts.push('URL_CHANGED');
    if (obs.snapshotDiff) parts.push(`dom ${obs.snapshotDiff}`);
    if (obs.keyText) parts.push(`new: ${String(obs.keyText).slice(0, 160)}`);
  }
  return parts.length ? parts.join(' | ') : 'ok';
}

// Grounded replacement for the legacy fuzzy clickText: text query → snapshot
// search → exactly one strong match clicks; multiple returns candidates for
// the LLM to disambiguate; zero reports NOT_FOUND.
export async function clickByText(tools, tabId, query) {
  const snap = await tools.snapshot(tabId);
  if (!snap.byRef) return { ok: false, reason: snap.reason || 'SNAPSHOT_FAILED' };
  const q = normalizeName(query);
  if (!q) return { ok: false, reason: 'NO_QUERY' };
  const { strong, weak } = searchSnapshot(snap, q);
  if (strong.length === 1) {
    return await tools.clickRef(tabId, strong[0]);
  }
  if (strong.length > 1) {
    return {
      ok: false,
      reason: 'AMBIGUOUS',
      candidates: strong.slice(0, 6).map(ref => ({ ref, ...snap.byRef[ref] && { role: snap.byRef[ref].role, name: snap.byRef[ref].name } })),
      hint: 'Multiple matches — pick the right [ref=...] and use clickRef.'
    };
  }
  if (weak.length) {
    return { ok: false, reason: 'AMBIGUOUS', candidates: weak.slice(0, 6).map(ref => ({ ref, role: snap.byRef[ref].role, name: snap.byRef[ref].name })), hint: 'Weak matches only — confirm with snapshot and clickRef.' };
  }
  return { ok: false, reason: 'NOT_FOUND', query: q };
}
