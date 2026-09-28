// trigger.js — Phase 5 Trigger moment (content script, runs at document_idle)
// One lightweight message per pageview: the SW decides whether to show the banner.
// If show=true, renders a minimal 44px banner with Open card / Dismiss buttons.

(function () {
  'use strict';
  if (window.__atomTriggerLoaded) return;
  window.__atomTriggerLoaded = true;

  var BANNER_ID = 'atom-trigger-banner';

  function removeBanner() {
    var b = document.getElementById('atom-trigger-banner');
    if (b) b.remove();
  }

  function renderBanner(decision) {
    if (document.getElementById('atom-trigger-banner')) return;
    var banner = document.createElement('div');
    banner.id = 'atom-trigger-banner';
    // existing design tokens (matches popup ink theme); max 48px tall, top of viewport
    banner.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0',
      'height:44px', 'max-height:48px',
      'display:flex', 'align-items:center', 'gap:8px',
      'padding:0 12px',
      'background:rgba(11,10,16,0.95)', 'border-bottom:1px solid rgba(123,110,255,0.35)',
      'z-index:2147483645',
      'font-family:Inter,system-ui,sans-serif', 'font-size:12px', 'color:#f0ecff',
      'box-shadow:0 4px 16px rgba(0,0,0,0.45)'
    ].join(';');
    var label = document.createElement('span');
    label.style.cssText = 'flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    label.textContent = 'Atom.AI: you have a battle card for ' + decision.competitor + '.';
    var open = document.createElement('button');
    open.textContent = 'Open card';
    open.style.cssText = 'background:#252233;color:#7b6eff;border:1px solid rgba(123,110,255,0.4);border-radius:8px;padding:4px 10px;font-size:11px;font-weight:700;cursor:pointer;flex-shrink:0;';
    var dismiss = document.createElement('button');
    dismiss.textContent = 'Dismiss for today';
    dismiss.style.cssText = 'background:transparent;color:#9d98b8;border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:4px 10px;font-size:11px;font-weight:600;cursor:pointer;flex-shrink:0;';
    open.addEventListener('click', function (e) {
      e.stopPropagation();
      try {
        chrome.runtime.sendMessage({ type: 'TRIGGER_OPEN_CARD', jobId: decision.jobId, domain: decision.competitor });
      } catch (err) {}
      removeBanner();
    });
    dismiss.addEventListener('click', function (e) {
      e.stopPropagation();
      try {
        chrome.runtime.sendMessage({ type: 'TRIGGER_DISMISS', domain: decision.competitor });
      } catch (err) {}
      removeBanner();
    });
    banner.appendChild(label);
    banner.appendChild(open);
    banner.appendChild(dismiss);
    (document.body || document.documentElement).appendChild(banner);
  }

  function check() {
    try {
      chrome.runtime.sendMessage(
        { type: 'TRIGGER_CHECK', url: location.href, hostname: location.hostname },
        function (resp) {
          if (chrome.runtime.lastError) return;
          if (resp && resp.show) renderBanner(resp);
        }
      );
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', check, { once: true });
  } else {
    check();
  }
})();