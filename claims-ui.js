// claims-ui.js — citation chips, confidence badges, brief HTML rendering.
// Pure string builders (no DOM access): popup.js sets innerHTML with the
// output. Same visual language for every claim surface (battle cards,
// deal room): every claim clickable, confidence shown, nulls honest.

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./i, ''); }
  catch { return 'source'; }
}

// Clickable citation chip. quote becomes the hover title when provided.
export function citeChip(sourceUrl, quote) {
  const url = String(sourceUrl || '');
  if (!/^https?:\/\//i.test(url)) return '';
  const title = quote ? ` title="${esc(String(quote).substring(0, 200))}"` : '';
  return `<a class="cite-chip" href="${esc(url)}" target="_blank" rel="noopener"${title}>[${esc(domainOf(url))}]</a>`;
}

export function confidenceBadge(stats) {
  const omitted = Number(stats?.omitted || 0);
  const level = omitted === 0 ? 'high' : 'medium';
  const label = omitted === 0 ? 'high confidence — all claims sourced' : `medium confidence — ${omitted} unsourced item(s) omitted`;
  return `<span class="conf-badge conf-${level}">${esc(label)}</span>`;
}

function claimLi(text, sourceUrl, quote) {
  const chip = citeChip(sourceUrl, quote);
  return `<li>${esc(text)}${chip ? ' ' + chip : ''}</li>`;
}

// Objections block for battle cards. Items carry verification status
// ('verified from their docs' vs 'inferred'), an optional needs-input badge,
// and — when editable — per-item Edit buttons + a block-level Refresh button.
// Pure string builder; popup.js wires the buttons by id/data-idx.
export function renderObjectionsBlock(items, { editable = false, jobId = '' } = {}) {
  const list = Array.isArray(items) ? items : [];
  let html = `<div class="obj-block" id="objectionBlock">` +
    `<div class="dr-sec-h">⚔️ Objections &amp; Rebuttals (${list.length})` +
    (editable ? ` <button class="job-btn" id="refreshObjections" data-id="${esc(jobId)}" title="Re-run objection extraction">⚡ Refresh objections</button>` : '') +
    `</div>`;
  if (!list.length) {
    html += `<div class="dr-empty">No sourced objections found on their docs pages.</div>`;
  } else {
    html += `<ul class="dr-list">`;
    list.forEach((o, idx) => {
      const tag = o?.verification === 'verified' ? 'verified from their docs' : 'inferred';
      const need = o?.needsInput ? ` <span class="obj-needs">⚠️ needs your input</span>` : '';
      const stale = o?.stale ? ` <span class="obj-stale">stale — not seen in latest check</span>` : '';
      const proof = o?.proofRef?.claim
        ? `<br><span class="obj-proof">Our proof: ${esc(o.proofRef.claim)}${o.proofRef.metric ? ` (${esc(o.proofRef.metric)})` : ''}</span>` : '';
      html += `<li data-idx="${idx}"><b>“${esc(o?.objection || '')}”</b> ` +
        `<span class="obj-tag obj-${o?.verification === 'verified' ? 'verified' : 'inferred'}">${esc(tag)}</span>${need}${stale}<br>` +
        `<span class="obj-claim">Their claim: ${esc(o?.theirClaim || 'n/a')}</span><br>` +
        `<span class="obj-counter">Counter: ${esc(o?.counterArgument || 'n/a')}</span>${proof} ${citeChip(o?.sourceUrl, o?.quote)}` +
        (editable ? `<br><button class="job-btn obj-edit" data-idx="${idx}">✏️ Edit rebuttal</button><div class="obj-edit-area" data-idx="${idx}" style="display:none;"><textarea rows="2" style="width:100%;">${esc(o?.counterArgument || '')}</textarea><div style="margin-top:4px;"><button class="job-btn view obj-save" data-idx="${idx}">Save</button> <button class="job-btn obj-cancel" data-idx="${idx}">Cancel</button></div></div>` : '') +
        `</li>`;
    });
    html += `</ul>`;
  }
  html += `</div>`;
  return html;
}

// Full Deal Room brief HTML. Null honesty: empty sections render an explicit
// "not found" line instead of being skipped silently.
export function renderDealRoomBrief(brief, stats) {
  const p = brief?.prospect || {};
  const title = p.name || 'Prospect';
  const sec = (heading, inner) => `<div class="dr-sec"><div class="dr-sec-h">${esc(heading)}</div>${inner}</div>`;
  const listOrEmpty = (items, emptyText) => {
    if (!items?.length) return `<div class="dr-empty">${esc(emptyText)}</div>`;
    return `<ul class="dr-list">${items.join('')}</ul>`;
  };

  const priorities = (p.likelyPriorities || []).map((x) => claimLi(x.text, x.sourceUrl));
  const signals = (p.signals || []).map((x) => claimLi(x.text, x.sourceUrl));
  const landscape = (brief?.competitiveLandscape || []).map((c) =>
    `<li><b>${esc(c.competitor)}</b> — their angle: ${esc(c.theirAngle)} ${citeChip(c.sourceUrl)}<br>Counter: ${esc(c.yourCounter)}</li>`);
  const objections = (brief?.likelyObjections || []).map((o) =>
    claimLi(`“${o.objection}” → ${o.rebuttal}`, o.sourceUrl));
  const tracks = (brief?.talkTracks || []).map((t) =>
    `<li>Opener: ${esc(t.opener)}<br>Discovery: ${esc(t.discoveryQuestion)}<br>Trap: ${esc(t.trapQuestion)} ${citeChip(t.sourceUrl)}</li>`);
  const mines = (brief?.landmines || []).map((m) =>
    claimLi(`Where they win: ${m.whereTheyWin} → qualify out: ${m.howToQualifyOut}`, m.sourceUrl));
  const proofs = (brief?.proofPoints || []).map((f) =>
    claimLi(`${f.claim} (${f.metric}) — use when: ${f.whenToUse}`, f.sourceUrl));

  return `<div class="dr-brief">` +
    `<div class="dr-title">🎯 Deal Room — ${esc(title)}</div>` +
    confidenceBadge(stats) +
    sec('Prospect', `<div class="dr-what">${esc(p.whatTheyDo || 'Not found in sources.')}</div>` +
      `<div class="dr-sub">Priorities</div>` + listOrEmpty(priorities, 'No sourced priorities found.') +
      `<div class="dr-sub">Signals</div>` + listOrEmpty(signals, 'No sourced signals found.')) +
    sec('Competitive landscape', listOrEmpty(landscape, 'No competitor tabs open — prospect-only brief.')) +
    sec('Likely objections', listOrEmpty(objections, 'No sourced objections found.')) +
    sec('Talk tracks', listOrEmpty(tracks, 'No sourced talk tracks.')) +
    sec('Landmines', listOrEmpty(mines, 'No sourced landmines.')) +
    sec('Proof points', listOrEmpty(proofs, 'No sourced proof points.')) +
    `</div>`;
}
