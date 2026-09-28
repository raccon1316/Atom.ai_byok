import { AI } from './ai.js';
import { Utils } from './utils.js';
import { Research } from './research.js';
import { Monitor } from './monitor.js';
import { Notes } from './notes.js';
import { History } from './history.js';
import { Settings } from './Settings.js';
import { Automate } from './automate.js';
import { renderDealRoomBrief, renderObjectionsBlock } from './claims-ui.js';
import { getWinLoss, getHistory, getStats, formatRecord, addWinLoss } from './winloss.js';
import { buildSlackMrkdwn, buildCrmNote } from './share.js';
import { changeBadgeLine } from './monitor-v0.js';
import { ObjectionHandler } from './objection-handler.js';
import { getProfile } from './profile.js';
import {
  CONTEXT_KEY, DISMISSED_KEY, shouldShowBanner, dismissLinkedInUrl, normalizeLinkedInUrl,
} from './linkedin.js';
import { CallAnalyzer } from './calls.js';

// Load persisted settings (BYOK: API key + model are stored in chrome.storage.local)
const { userSettings: savedSettings } = await chrome.storage.local.get(['userSettings']);
const settingsState = { apiKey: '', model: 'openai/gpt-oss-20b', ...savedSettings };

// Initialize AI – sends requests directly to Groq using the user's own API key
const ai = new AI({
    getApiKey: () => settingsState.apiKey,
    getModel: () => settingsState.model || "openai/gpt-oss-20b",
    onCall: (usageData) => updateUsageUI(usageData)
});

// Initialize modules
const research = new Research(ai, settingsState);
const monitor = new Monitor(ai);
const notes = new Notes();
const history = new History();
const settings = new Settings(settingsState);
await settings.load();
const automate = new Automate(ai, settingsState);

// Managed backend: sync Pro status + daily usage from the server on startup.
// Fails silently — an unreachable server just leaves the free-tier defaults.
async function checkLicense() {
  try {
    const res = await fetch('https://atom-ai-eight.vercel.app/api/license', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Extension-Id': chrome.runtime.id
      }
    });
    const data = await res.json();
    settingsState.isPro = data.isPro || false;
    settingsState.callsUsed = data.callsUsed || 0;
    settingsState.callsRemaining = data.callsRemaining ?? 10;
    if (data.isPro) {
      document.getElementById('usageText').innerText = 'Pro — unlimited calls';
      document.getElementById('usageFill').style.width = '100%';
    } else {
      updateUsageUI({ calls: data.callsUsed || 0, max: data.limit || 10 });
    }
  } catch (e) {
    // Fail silently, assume free tier
  }
}
await checkLicense();

// Objection Handler (F3): reads the last brief from history as optional
// context and cites the user's saved proof points (profile.js) when present.
const objectionHandler = new ObjectionHandler(ai);
document.getElementById('objectionHandleBtn')?.addEventListener('click', async () => {
  const objection = document.getElementById('objectionInput')?.value.trim();
  const statusEl = document.getElementById('objectionStatus');
  const resultEl = document.getElementById('objectionResult');
  const btn = document.getElementById('objectionHandleBtn');
  if (!objection) { alert('Type what they said first.'); return; }
  btn.disabled = true;
  const origLabel = btn.innerText;
  btn.innerText = '🛡️ Thinking…';
  statusEl.style.display = 'block';
  statusEl.innerText = 'Crafting three response strategies…';
  try {
    let briefContext = '';
    try {
      const hist = await chrome.storage.local.get(['researchHistory']);
      const last = Array.isArray(hist.researchHistory) && hist.researchHistory[0];
      if (last?.report) briefContext = String(last.report).substring(0, 2500);
    } catch (e) {}
    const profile = getProfile(settingsState);
    const result = await objectionHandler.handle(objection, { briefContext, profile });
    statusEl.innerText = '';
    objectionHandler.render(resultEl, result);
  } catch (e) {
    statusEl.innerText = '⚠️ ' + (e?.message || 'Could not build responses.');
  } finally {
    btn.disabled = false;
    btn.innerText = origLabel;
  }
});

// ---------- LinkedIn auto-brief banner (F2) ----------
// Shows only while the ACTIVE tab is the exact LinkedIn page the content
// script scanned (a stored context from another tab must not hijack the
// popup), and never re-shows a URL the user dismissed until they navigate
// elsewhere. Research reuses the existing person/company buttons so the whole
// existing flow (progress, history, error handling) runs unchanged.
(async () => {
  try {
    const banner = document.getElementById('linkedinBanner');
    if (!banner) return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const data = await chrome.storage.local.get([CONTEXT_KEY, DISMISSED_KEY]);
    const ctx = data[CONTEXT_KEY];
    const activeOk = tab?.url && normalizeLinkedInUrl(tab.url) === normalizeLinkedInUrl(ctx?.url || '');
    if (!activeOk || !shouldShowBanner(ctx, data[DISMISSED_KEY])) return;

    const icon = ctx.kind === 'company' ? '🏢' : '👤';
    const sub = ctx.kind === 'company'
      ? 'LinkedIn company page'
      : [ctx.title, ctx.company].filter(Boolean).join(' · ');
    document.getElementById('linkedinBannerText').innerText =
      `${icon} ${ctx.name}${sub ? ' — ' + sub : ''}`;
    banner.style.display = 'block';

    document.getElementById('linkedinResearchBtn')?.addEventListener('click', () => {
      banner.style.display = 'none';
      chrome.storage.local.set({ [CONTEXT_KEY]: null });
      document.querySelector('.tab-btn[data-tab="home"]')?.click();
      if (ctx.kind === 'company') {
        const inp = document.getElementById('companyName');
        if (inp) inp.value = ctx.company || ctx.name;
        document.getElementById('quickResearchBtn')?.click();
      } else {
        const inp = document.getElementById('personName');
        if (inp) inp.value = ctx.name;
        document.getElementById('personResearchBtn')?.click();
      }
    });
    document.getElementById('linkedinDismissBtn')?.addEventListener('click', async () => {
      banner.style.display = 'none';
      await dismissLinkedInUrl(chrome.storage.local, ctx.url);
    });
  } catch (e) { /* banner must never break popup startup */ }
})();

// ---------- Call Analyzer (F5) ----------
// Full transcript to the model — no client-side truncation. The 120s
// per-attempt timeout lives in calls.js; Groq reads 40k words in well under
// it, and the old 30s default aborted every long analysis mid-generation.
const callAnalyzer = new CallAnalyzer(ai);
const transcriptEl = document.getElementById('callTranscript');
callAnalyzer.attachDropzone(transcriptEl, (res) => {
  const statusEl = document.getElementById('callStatus');
  if (!statusEl) return;
  statusEl.style.display = 'block';
  statusEl.innerText = res.ok
    ? `📎 Loaded ${res.name} (${res.length.toLocaleString()} chars)`
    : `⚠️ ${res.error}`;
});
document.getElementById('analyzeCallBtn')?.addEventListener('click', async () => {
  const transcript = transcriptEl?.value.trim() || '';
  const statusEl = document.getElementById('callStatus');
  const resultEl = document.getElementById('callResult');
  const btn = document.getElementById('analyzeCallBtn');
  if (!statusEl || !resultEl || !btn) return;
  if (transcript.length < 50) {
    statusEl.style.display = 'block';
    statusEl.innerText = '⚠️ Paste a call transcript first (or drop a .txt export).';
    return;
  }
  btn.disabled = true;
  const origLabel = btn.innerText;
  btn.innerText = '📞 Analyzing…';
  statusEl.style.display = 'block';
  statusEl.innerText = '🧠 Reading the full transcript — this can take 10-20 seconds…';
  resultEl.innerHTML = '';
  try {
    const result = await callAnalyzer.analyze(transcript);
    statusEl.style.display = 'none';
    callAnalyzer.render(resultEl, result);
  } catch (e) {
    statusEl.innerText = '⚠️ ' + (e?.message || 'Analysis failed.');
  } finally {
    btn.disabled = false;
    btn.innerText = origLabel;
  }
});

// ---------- Phase 5: Service Worker Orchestration - Thin Renderer ----------
// Popup connects via long-lived port to receive job progress; also pulls from storage.
// Keeps SW alive via open port + 25s alarm heartbeat. Results land in History even if popup closed.

let jobsCache = [];
let uiPort = null;
// Monitoring v0: cached monitorState for change badges (refreshed with jobs).
let monitorStateCache = { cursor: 0, competitors: {} };

function formatTokens(n) {
  const v = Number(n || 0);
  if (v >= 1000) return `${(v/1000).toFixed(1)}k tokens`;
  return `${v} tokens`;
}

function statusIcon(status) {
  if (status === 'running') return '⏳';
  if (status === 'done') return '✅';
  if (status === 'failed') return '⚠️';
  if (status === 'canceled') return '⛔';
  return '•';
}

function renderJobsList(jobs) {
  const container = document.getElementById('jobsList');
  const countEl = document.getElementById('jobsCount');
  if (!container) return;
  jobsCache = Array.isArray(jobs) ? jobs : [];
  // sort newest first
  jobsCache.sort((a,b)=> (b.createdAt||0)-(a.createdAt||0));
  if (countEl) countEl.innerText = `${jobsCache.length} jobs`;
  if (!jobsCache.length) {
    container.innerHTML = '<div style="font-size:11px;color:var(--tx3);text-align:center;padding:12px;">No jobs yet. Start a battle card.</div>';
    return;
  }
  container.innerHTML = '';
  for (const job of jobsCache) {
    const card = document.createElement('div');
    card.className = 'job-card';
    const pct = Math.max(0, Math.min(100, Number(job.progress?.percent||0)));
    const step = job.progress?.step || job.status;
    const tokens = formatTokens(job.tokensUsed);
    const isRunning = job.status === 'running';
    const isFailed = job.status === 'failed';
    const isDone = job.status === 'done';
    const isCanceled = job.status === 'canceled';
    const failedUrls = Array.isArray(job.failedUrls) ? job.failedUrls : [];
    const successSummary = job.successSummary || '';
    // compact display for payload urls
    const urlsPreview = Array.isArray(job.payload?.urls) ? job.payload.urls.map(u=>{try{return new URL(u).hostname;}catch{return u;}}).join(', ').slice(0,60) : '';
    // Monitoring v0: change badge for done battlecards with detected pricing changes
    let changeBadge = '';
    if (isDone && job.type === 'battlecard' && Array.isArray(job.payload?.urls) && job.payload.urls.length) {
      try {
        const d = new URL(job.payload.urls[0]).hostname.replace(/^www\./i, '').toLowerCase();
        const line = changeBadgeLine(d, monitorStateCache);
        if (line) changeBadge = `<div class="job-change-badge">${line} <button class="job-btn reverify" data-id="${job.id}">Re-verify now</button></div>`;
      } catch (e) {}
    }
    card.innerHTML = `
      <div class="job-card-head">
        <span class="job-type">${statusIcon(job.status)} ${String(job.type||'job').toUpperCase()}</span>
        <span class="job-status ${job.status}">${job.status}</span>
      </div>
      <div class="job-urls" title="${(job.payload?.urls||[]).join('\n')}">${urlsPreview || ''}</div>
      <div class="job-step">${step}</div>
      <div class="job-progress-track"><div class="job-progress-fill" style="width:${pct}%"></div></div>
      <div class="job-meta">
        <span class="job-tokens">${isRunning ? 'running…' : (isDone||isFailed) ? `used ~${tokens}` : tokens}</span>
        <span class="job-time">${new Date(job.createdAt||Date.now()).toLocaleTimeString()}</span>
      </div>
      ${successSummary ? `<div class="job-summary">${successSummary}</div>` : ''}
      ${isFailed && job.partialResult ? `<div class="job-partial"><em>Partial result saved to History</em></div>` : ''}
      ${changeBadge}
      <div class="job-actions">
        ${isRunning ? `<button class="job-btn cancel" data-id="${job.id}">Cancel</button>` : ''}
        ${isFailed && failedUrls.length ? `<button class="job-btn retry" data-id="${job.id}">Retry failed (${failedUrls.length})</button>` : ''}
        ${isFailed && !failedUrls.length ? `<button class="job-btn retry-all" data-id="${job.id}">Retry</button>` : ''}
        ${(isDone || isFailed) && job.resultRef ? `<button class="job-btn view" data-id="${job.id}">View</button>` : ''}
      </div>
    `;
    container.appendChild(card);
  }
  // wire actions
  container.querySelectorAll('.job-btn.cancel').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const id = btn.dataset.id;
      btn.disabled = true; btn.innerText='Canceling…';
      try { await chrome.runtime.sendMessage({ type:'JOB_CANCEL', jobId:id }); } catch(e){}
    });
  });
  container.querySelectorAll('.job-btn.retry, .job-btn.retry-all').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const id = btn.dataset.id;
      setButtonLoading(btn, true, 'Retrying…');
      try {
        const res = await chrome.runtime.sendMessage({ type:'JOB_RETRY', jobId:id });
        if (res?.error) showError(res.error);
      } catch(e){ showError(e.message); }
      finally { setButtonLoading(btn, false, 'Retry'); }
    });
  });
  // Monitoring v0: one-click re-verify on cards with detected changes
  container.querySelectorAll('.job-btn.reverify').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const id = btn.dataset.id;
      setButtonLoading(btn, true, 'Re-verifying…');
      try {
        const res = await chrome.runtime.sendMessage({ type:'REVERIFY_CARD', jobId:id });
        if (res?.error) showError(res.error);
        else if (res?.job) { upsertJobCache(res.job); renderBattlecardView(res.job); }
      } catch(e){ showError(e.message); }
      finally { setButtonLoading(btn, false, 'Re-verify'); }
      await refreshJobsFromStorage();
    });
  });
  container.querySelectorAll('.job-btn.view').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const id = btn.dataset.id;
      const job = jobsCache.find(j=>j.id===id);
      if (!job) return;
      // remove any previous deal-room action bar so bars don't stack
      document.getElementById('dealRoomActions')?.remove();
      const panel = document.getElementById('globalResult');
      if (panel) {
        // Deal Room briefs render as HTML with clickable citation chips
        if (job.type==='dealroom' && job.briefJson) {
          panel.style.display='block';
          panel.innerHTML = renderDealRoomBrief(job.briefJson, job.briefStats) + `
            <div class="dr-actions" id="dealRoomActions">
              <button class="job-btn view" id="copyDealBrief">📋 Copy brief</button>
              <button class="job-btn" id="openDealHistory">🕘 View in History</button>
            </div>
            <div style="font-size:10px;color:var(--tx3);margin-top:6px;">Already saved to History as “Deal Room”. Job ${job.id} · used ~${formatTokens(job.tokensUsed)}.</div>`;
          document.getElementById('copyDealBrief')?.addEventListener('click', async ()=>{
            try { await navigator.clipboard.writeText(job.resultRef || ''); } catch(e){}
          });
          document.getElementById('openDealHistory')?.addEventListener('click', ()=>{
            switchTab('history');
            try { history.loadHistory(); } catch(e){}
          });
          return;
        }
        panel.innerText = job.resultRef || job.partialResult || 'No result';
        // battle cards render the table + objections block (chips, refresh, edit)
        if (job.type==='battlecard' && job.resultRef) {
          try { renderBattlecardView(job); } catch(e){}
        }
      }
    });
  });
}

async function refreshJobsFromStorage() {
  try {
    const data = await chrome.storage.local.get(['jobs', 'monitorState']);
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    if (data.monitorState && typeof data.monitorState === 'object') monitorStateCache = data.monitorState;
    renderJobsList(jobs);
  } catch(e){}
}

// Battle card View: table text + action bar + objections HTML block + Win/Loss
// (chips, verified/inferred badges, refresh + per-item edit + win/loss). Re-rendered
// from the job object after every refresh/edit round-trip.
function renderBattlecardView(job) {
  const panel = document.getElementById('globalResult');
  if (!panel || !job) return;
  document.getElementById('battleActions')?.remove();
  document.getElementById('objectionBlock')?.remove();
  document.getElementById('winlossBlock')?.remove();
  document.getElementById('shareMenu')?.remove();
  panel.style.display = 'block';

  // Extract table part (strip objections block if present)
  const tablePart = job.tableMarkdown
    || String(job.resultRef || job.partialResult || '').split('\n\n---\n\n## ⚔️ Objections')[0]
    || 'No result';
  panel.innerText = tablePart;
  try { research.attachBattleActions(job.resultRef || tablePart); } catch(e){}

  // Objections block (chips, verified/inferred badges, refresh + per-item edit)
  const items = Array.isArray(job.objections) ? job.objections : [];
  if (items.length) {
    const bar = document.getElementById('battleActions');
    const html = renderObjectionsBlock(items, { editable: true, jobId: job.id });
    if (bar) bar.insertAdjacentHTML('afterend', html);
    else panel.insertAdjacentHTML('beforeend', html);
    wireObjectionButtons(job);
  }

  // Win/Loss block (tally + buttons + history)
  renderWinLossBlock(job);

  // Share menu (Slack webhook / copy mrkdwn / copy CRM note)
  renderShareMenu(job);
}

// Helper to set button loading state
function setButtonLoading(btn, loading, originalText) {
  if (!btn) return;
  if (loading) {
    btn.dataset.originalText = btn.innerText;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> ' + (btn.dataset.loadingText || 'Loading…');
  } else {
    btn.disabled = false;
    btn.innerText = btn.dataset.originalText || originalText || '';
  }
}

function showError(message, panelId = 'globalResult') {
  const panel = document.getElementById(panelId);
  if (panel) {
    panel.style.display = 'block';
    panel.innerHTML = `<div class="error-message" style="color:var(--a3);padding:12px;background:rgba(255,110,142,0.1);border:1px solid var(--a3);border-radius:8px;">${message}</div>`;
  }
}

function showLoading(message, panelId = 'globalResult') {
  const panel = document.getElementById(panelId);
  if (panel) {
    panel.style.display = 'block';
    panel.innerHTML = `<div class="loading-message" style="padding:16px;text-align:center;color:var(--tx2);"><span class="spinner" style="display:inline-block;width:16px;height:16px;border:2px solid var(--a);border-right-color:transparent;border-radius:50%;animation:spin 1s linear infinite;margin-right:8px;"></span>${message}</div>`;
    if (!document.getElementById('spinner-style')) {
      const style = document.createElement('style');
      style.id = 'spinner-style';
      style.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
      document.head.appendChild(style);
    }
  }
}

function hideLoading(panelId = 'globalResult') {
  const panel = document.getElementById(panelId);
  if (panel && panel.querySelector('.loading-message')) {
    panel.innerHTML = '';
    panel.style.display = 'none';
  }
}

function showSuccess(message, panelId = 'globalResult') {
  const panel = document.getElementById(panelId);
  if (panel) {
    panel.style.display = 'block';
    panel.innerHTML = `<div class="success-message" style="color:var(--a2);padding:12px;background:rgba(79,239,212,0.1);border:1px solid var(--a2);border-radius:8px;">${message}</div>`;
    setTimeout(() => hideLoading('globalResult'), 3000);
  }
}

// Derive the share payload from a done battlecard job + local stores.
async function buildSharePayload(job) {
  const urls = Array.isArray(job.payload?.urls) ? job.payload.urls.filter(Boolean) : [];
  let competitor = '';
  try { competitor = new URL(urls[0]).hostname.replace(/^www\./i, ''); } catch { competitor = urls[0] || 'competitor'; }
  const facts = (Array.isArray(job.competitorFacts) && job.competitorFacts.length ? job.competitorFacts[0] : {}) || {};
  const allWinLoss = await getWinLoss(chrome.storage.local);
  const mine = allWinLoss.filter((r) => r.competitor === competitor.toLowerCase());
  let yourCompany = 'us';
  try {
    if (settingsState.ownProductUrl) yourCompany = new URL(settingsState.ownProductUrl).hostname.replace(/^www\./i, '');
  } catch (e) {}
  return {
    yourCompany,
    competitor,
    verifiedDate: new Date(Number(job.updatedAt || Date.now())).toLocaleDateString(),
    pricing: facts.pricing || '',
    features: facts.features || '',
    targetAudience: facts.targetAudience || '',
    objections: job.objections || [],
    winStats: {
      won: mine.filter((r) => r.outcome === 'won').length,
      lost: mine.filter((r) => r.outcome === 'lost').length,
      winReasons: mine.filter((r) => r.outcome === 'won').map((r) => r.why).filter(Boolean),
      lossReasons: mine.filter((r) => r.outcome === 'lost').map((r) => r.why).filter(Boolean),
    },
  };
}

function renderShareMenu(job) {
  if (job.type !== 'battlecard' || job.status !== 'done') return;
  const panel = document.getElementById('globalResult');
  if (!panel || document.getElementById('shareMenu')) return;
  const wrap = document.createElement('div');
  wrap.id = 'shareMenu';
  wrap.style.cssText = 'margin-top:12px;padding:10px;border-top:1px solid var(--line);';
  wrap.innerHTML = `
    <div style="margin-bottom:8px;font-weight:600;">📤 Share this card</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;">
      <button class="job-btn" id="shareSlack">Share to Slack</button>
      <button class="job-btn" id="copySlack">Copy for Slack</button>
      <button class="job-btn" id="copyCrm">Copy as CRM note</button>
    </div>
    <div id="shareStatus" style="margin-top:6px;font-size:11px;color:var(--tx2);"></div>
  `;
  document.getElementById('winlossBlock')?.insertAdjacentElement('afterend', wrap)
    || document.getElementById('objectionBlock')?.insertAdjacentElement('afterend', wrap)
    || document.getElementById('battleActions')?.insertAdjacentElement('afterend', wrap)
    || panel.appendChild(wrap);
  const status = (msg) => { const el = document.getElementById('shareStatus'); if (el) el.innerText = msg; };
document.getElementById('shareSlack')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setButtonLoading(btn, true, 'Sharing…');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'SHARE_SLACK', jobId: job.id });
      if (res?.error) status(`Slack share failed: ${res.error}`);
      else status('Shared to Slack ✓');
    } catch (err) { status(`Slack share failed: ${err.message}`); }
    finally { setButtonLoading(btn, false, 'Share to Slack'); }
  });
  document.getElementById('copySlack')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setButtonLoading(btn, true, 'Copying…');
    try {
      await navigator.clipboard.writeText(buildSlackMrkdwn(await buildSharePayload(job)));
      status('Copied for Slack ✓ — paste into any channel or DM.');
    } catch (e) { status(`Copy failed: ${e.message}`); }
    finally { setButtonLoading(btn, false, 'Copy for Slack'); }
  });
  document.getElementById('copyCrm')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    setButtonLoading(btn, true, 'Copying…');
    try {
      await navigator.clipboard.writeText(buildCrmNote(await buildSharePayload(job)));
      status('CRM note copied ✓ — paste into the deal record.');
    } catch (e) { status(`Copy failed: ${e.message}`); }
    finally { setButtonLoading(btn, false, 'Copy as CRM note'); }
  });
}

async function renderWinLossBlock(job) {
  // Only for battlecard type
  if (job.type !== 'battlecard') return;
  const panel = document.getElementById('globalResult');
  if (!panel) return;

  // Extract first competitor domain from payload urls
  const urls = Array.isArray(job.payload?.urls) ? job.payload.urls.filter(Boolean) : [];
  if (!urls.length) return;
  const domain = (() => { try { return new URL(urls[0]).hostname.replace(/^www\./i, ''); } catch { return ''; } })();
  if (!domain) return;

  // Fetch win/loss history for this competitor
  const history = await getWinLoss(chrome.storage.local);
  const stats = getStats(history.filter(r => r.competitor === domain.toLowerCase()));

  // Build win/loss block HTML
  const block = document.createElement('div');
  block.id = 'winlossBlock';
  block.className = 'winloss-block';
  block.style.cssText = 'margin-top:12px;padding:10px;border-top:1px solid var(--line);';

  // Tally
  const tally = stats.total
    ? `Your record vs ${domain}: ${stats.won}W / ${stats.lost}L`
    : `No record vs ${domain} yet`;

  // Buttons
  const buttons = `
    <button class="job-btn" id="wlWon" data-outcome="won" style="margin-right:8px;">🟢 Won</button>
    <button class="job-btn" id="wlLost" data-outcome="lost" style="margin-right:8px;">🔴 Lost</button>
    <button class="job-btn" id="wlHistory" style="margin-right:8px;">📜 History</button>
  `;

  // Collapsible reason input
  const whyInput = `
    <div id="wlWhyWrap" style="display:none;margin-top:8px;">
      <input type="text" id="wlWhy" placeholder="Why? (optional)" style="width:100%;padding:6px 8px;border-radius:6px;border:1px solid var(--line);background:var(--ink3);color:var(--tx);font-size:11px;">
      <div style="margin-top:6px;display:flex;gap:6px;">
        <button class="job-btn" id="wlSubmit">Submit</button>
        <button class="job-btn" id="wlCancel" style="background:transparent;color:var(--tx2);">Cancel</button>
      </div>
    </div>
  `;

  // History list
  const historyHtml = (await getHistory(chrome.storage.local, domain.toLowerCase())).length
    ? `<div style="margin-top:10px;font-size:11px;color:var(--tx2);">${(await getHistory(chrome.storage.local, domain.toLowerCase())).map(formatRecord).join('<br>')}</div>`
    : '';

  block.innerHTML = `
    <div style="margin-bottom:8px;font-weight:600;">${esc(tally)}</div>
    ${buttons}
    ${whyInput}
    ${historyHtml}
  `;

  // Insert after objections block or at end
  document.getElementById('objectionBlock')?.insertAdjacentElement('afterend', block)
    || document.getElementById('battleActions')?.insertAdjacentElement('afterend', block)
    || panel.appendChild(block);

  // Wire buttons
  document.getElementById('wlWon')?.addEventListener('click', () => showWhyInput('won'));
  document.getElementById('wlLost')?.addEventListener('click', () => showWhyInput('lost'));
  document.getElementById('wlCancel')?.addEventListener('click', () => { document.getElementById('wlWhyWrap').style.display = 'none'; });
document.getElementById('wlSubmit')?.addEventListener('click', async () => {
    const btn = document.getElementById('wlSubmit');
    const why = document.getElementById('wlWhy')?.value || '';
    const outcome = btn.dataset.outcome;
    setButtonLoading(btn, true, 'Saving…');
    try {
      await addWinLoss(chrome.storage.local, { competitor: domain, outcome, why, cardVersion: '1.0' });
      document.getElementById('wlWhyWrap').style.display = 'none';
      document.getElementById('wlWhy').value = '';
      renderWinLossBlock(job);
      upsertJobCache(job);
      showSuccess('Result saved!');
    } catch (err) {
      showError('Failed to save result: ' + err.message);
    } finally {
      setButtonLoading(btn, false, 'Submit');
    }
  });
  document.getElementById('wlHistory')?.addEventListener('click', () => {
    switchTab('history');
    const search = document.getElementById('historySearch');
    if (search) { search.value = domain; history.loadHistory('all', domain); }
  });

  function showWhyInput(outcome) {
    document.getElementById('wlWhyWrap').style.display = 'block';
    document.getElementById('wlSubmit').dataset.outcome = outcome;
    document.getElementById('wlWhy').focus();
  }
}

function upsertJobCache(job) {
  if (!job) return;
  const idx = jobsCache.findIndex(j => j.id === job.id);
  if (idx >= 0) jobsCache[idx] = job; else jobsCache.unshift(job);
  renderJobsList(jobsCache);
}

function wireObjectionButtons(job) {
  const refreshBtn = document.getElementById('refreshObjections');
  if (refreshBtn) refreshBtn.addEventListener('click', async () => {
    setButtonLoading(refreshBtn, true, 'Refreshing…');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'OBJECTION_REFRESH', jobId: job.id });
      if (res?.error) showError(res.error);
      else if (res?.job) { upsertJobCache(res.job); renderBattlecardView(res.job); return; }
    } catch (e) { showError(e.message); }
    finally { setButtonLoading(refreshBtn, false, '⚡ Refresh objections'); }
  });
  document.querySelectorAll('.obj-edit').forEach(btn => btn.addEventListener('click', () => {
    const area = document.querySelector(`.obj-edit-area[data-idx="${btn.dataset.idx}"]`);
    if (area) area.style.display = area.style.display === 'none' ? 'block' : 'none';
  }));
  document.querySelectorAll('.obj-cancel').forEach(btn => btn.addEventListener('click', () => {
    const area = document.querySelector(`.obj-edit-area[data-idx="${btn.dataset.idx}"]`);
    if (area) area.style.display = 'none';
  }));
  document.querySelectorAll('.obj-save').forEach(btn => btn.addEventListener('click', async () => {
    const idx = Number(btn.dataset.idx);
    const area = document.querySelector(`.obj-edit-area[data-idx="${btn.dataset.idx}"]`);
    const text = area?.querySelector('textarea')?.value ?? '';
    if (!text.trim()) { showError('Rebuttal cannot be empty.'); return; }
    const items = (Array.isArray(job.objections) ? job.objections : []).map((o, i) =>
      i === idx ? { ...o, counterArgument: text.trim() } : o);
    setButtonLoading(btn, true, 'Saving…');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'JOB_UPDATE_OBJECTIONS', jobId: job.id, objections: items });
      if (res?.error) showError(res.error);
      else if (res?.job) { upsertJobCache(res.job); renderBattlecardView(res.job); return; }
    } catch (e) { showError(e.message); }
    finally { setButtonLoading(btn, false, 'Save'); }
  }));
}

function connectPort() {
  try {
    uiPort = chrome.runtime.connect({ name: 'atom.ui' });
    uiPort.onMessage.addListener((msg)=>{
      if (!msg || !msg.type) return;
      if (msg.type==='JOBS_SNAPSHOT' && Array.isArray(msg.jobs)) {
        renderJobsList(msg.jobs);
      } else if (msg.type==='JOB_UPDATE' && msg.job) {
        const idx = jobsCache.findIndex(j=>j.id===msg.job.id);
        if (idx>=0) jobsCache[idx]=msg.job;
        else jobsCache.unshift(msg.job);
        renderJobsList(jobsCache);
      } else if (msg.type==='JOB_CREATED' && msg.job) {
        jobsCache.unshift(msg.job);
        renderJobsList(jobsCache);
      } else if (msg.type==='JOB_DONE' || msg.type==='JOB_CANCELED') {
        // will be followed by JOB_UPDATE, but refresh just in case
        refreshJobsFromStorage();
        // also refresh history so card appears even if popup closed
        try { history.loadHistory(); } catch(e){}
      }
    });
    uiPort.onDisconnect.addListener(()=>{
      uiPort = null;
      // try reconnect after 1s (SW may have restarted)
      setTimeout(()=>{ if (!uiPort) connectPort(); }, 1000);
    });
  } catch(e){}
}

// initial connect + storage pull
connectPort();
refreshJobsFromStorage();
// also listen to storage changes for resilience (popup close/open gate)
chrome.storage.onChanged.addListener((changes, area)=>{
  if (area==='local' && changes.jobs) {
    const jobs = Array.isArray(changes.jobs.newValue) ? changes.jobs.newValue : [];
    renderJobsList(jobs);
    // if any job just completed, refresh history view if on history tab
    try { if (currentTab==='history') history.loadHistory(); } catch(e){}
  }
});
// poll fallback every 3s if port disconnected and job running (ensures gate test)
setInterval(async ()=>{
  if (!uiPort) await refreshJobsFromStorage();
  else {
    // if we have running jobs, pull to ensure sync (MV3 wake)
    const hasRunning = jobsCache.some(j=>j.status==='running');
    if (hasRunning) refreshJobsFromStorage();
  }
}, 3000);

// Also expose for manual refresh button
window.refreshJobs = refreshJobsFromStorage;
// wire job list toolbar buttons (after DOM ready)
setTimeout(()=>{
  document.getElementById('refreshJobsBtn')?.addEventListener('click', refreshJobsFromStorage);
  document.getElementById('clearJobsBtn')?.addEventListener('click', async ()=>{
    const data = await chrome.storage.local.get(['jobs']);
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    // keep only running jobs (clear finished)
    const running = jobs.filter(j=>j.status==='running');
    await chrome.storage.local.set({ jobs: running });
    refreshJobsFromStorage();
  });
}, 500);

// ---------- Phase 6: optional host permissions (store hygiene) ----------
async function hasHostPermission() {
  try { return await chrome.permissions.contains({ origins: ["https://*/*", "http://*/*"] }); } catch { return false; }
}
async function ensureHostPermission() {
  if (await hasHostPermission()) return true;
  try {
    const granted = await chrome.permissions.request({ origins: ["https://*/*", "http://*/*"] });
    await refreshHostPermBanner();
    return granted;
  } catch { return false; }
}
async function refreshHostPermBanner() {
  const has = await hasHostPermission();
  const banner = document.getElementById('hostPermBanner');
  if (banner) banner.style.display = has ? 'none' : 'block';
}

// Ask once, automatically, the first time the popup is opened after install, so
// the content script is not silently missing on every site until the user
// notices a banner.
//
// Caveat that shapes this function: Chrome only honours permissions.request()
// from a real user gesture. Clicking the toolbar icon to open the popup usually
// supplies one, but that is not guaranteed — so the attempt is wrapped, and a
// refusal (no activation) simply leaves the banner showing, which IS the
// reliable path. "Asked once" is recorded BEFORE the request so a refused
// attempt cannot turn into a prompt on every single popup open.
const HOST_PERM_PROMPTED_KEY = 'hostPermPrompted';
async function autoPromptHostPermission() {
  if (await hasHostPermission()) return true;
  let asked = false;
  try {
    const d = await chrome.storage.local.get([HOST_PERM_PROMPTED_KEY]);
    asked = !!(d && d[HOST_PERM_PROMPTED_KEY]);
  } catch (e) { /* storage unavailable — treat as not yet asked */ }
  if (asked) { await refreshHostPermBanner(); return false; }
  try { await chrome.storage.local.set({ [HOST_PERM_PROMPTED_KEY]: true }); } catch (e) {}
  try {
    const granted = await chrome.permissions.request({ origins: ["https://*/*", "http://*/*"] });
    await refreshHostPermBanner();
    return granted;
  } catch (e) {
    // No user activation, or the user dismissed the prompt. Not an error worth
    // surfacing: the banner explains the situation and carries a button.
    await refreshHostPermBanner();
    return false;
  }
}

// initial check + auto-prompt + wire button + listen for external grants
setTimeout(async ()=>{
  await refreshHostPermBanner();
  document.getElementById('grantHostPermBtn')?.addEventListener('click', async ()=>{
    const btn = document.getElementById('grantHostPermBtn');
    if (btn) { btn.disabled=true; btn.innerText='Requesting…'; }
    const ok = await ensureHostPermission();
    if (btn) { btn.disabled=false; btn.innerText = ok ? 'Granted ✓' : 'Grant host access'; }
    if (!ok) showError('Host access is required to crawl competitor sites. Please grant when prompted, or enable https://*/* in chrome://extensions → Atom.AI → Site access.');
  });
  // also re-check when popup regains focus (user may have granted in extensions page)
  window.addEventListener('focus', refreshHostPermBanner);
  // react to permission changes from background
  try { chrome.permissions.onAdded?.addListener?.(refreshHostPermBanner); chrome.permissions.onRemoved?.addListener?.(refreshHostPermBanner); } catch {}
  // First-open automatic ask. Runs last so the button is already wired if the
  // user has to click it instead.
  await autoPromptHostPermission();
}, 600);

// DOM Elements
const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = {
    home: document.getElementById('tab-home'),
    research: document.getElementById('tab-research'),
    monitor: document.getElementById('tab-monitor'),
    notes: document.getElementById('tab-notes'),
    calls: document.getElementById('tab-calls'),
    history: document.getElementById('tab-history')
};

// Phase 9: single-purpose v1 — hide non-core surfaces (keep code, hide UI).
// Core = competitive battle cards from open tabs. Research/auto/extraction
// surfaces stay in the codebase (and post-v1 roadmap) but are hidden now so the
// store listing's single-purpose claim matches the visible product exactly.
document.querySelectorAll('[data-v1-hide]').forEach(el => { el.style.display = 'none'; });
function isTabHidden(tabId) {
    const btn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
    return !!btn && btn.getAttribute('data-v1-hide') === '1';
}

let currentTab = 'home';

// Tab switching
function switchTab(tabId) {
    // Guard: never switch into a v1-hidden tab (e.g. restored lastActiveTab).
    if (isTabHidden(tabId)) tabId = 'home';
    Object.values(tabContents).forEach(content => {
        if (content) content.style.display = 'none';
    });
    tabContents[tabId].style.display = 'block';
    tabBtns.forEach(btn => {
        if (btn.dataset.tab === tabId) btn.classList.add('active');
        else btn.classList.remove('active');
    });
    currentTab = tabId;
    chrome.storage.local.set({ lastActiveTab: tabId });
    
    // Refresh tab content if needed
    if (tabId === 'monitor') monitor.load();
    if (tabId === 'notes') notes.load();
    if (tabId === 'history') history.loadHistory();
    if (tabId === 'home') refreshJobsFromStorage();
}

// ---------- Phase 9: triage banner (3+ same-signature failures in 24h) ----------
async function refreshTriageBanner() {
    try {
        const res = await chrome.runtime.sendMessage({ type: 'TRIAGE_SUMMARY' });
        if (!res || res.error || !res.banner) {
            const b = document.getElementById('triageBanner');
            if (b) b.style.display = 'none';
            return;
        }
        const banner = document.getElementById('triageBanner');
        const sig = document.getElementById('triageSignature');
        if (banner) banner.style.display = 'block';
        if (sig) sig.textContent = res.banner.signature;
    } catch (e) {}
}
function wireTriageDetails() {
    document.getElementById('triageDetailsBtn')?.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.runtime.sendMessage({ type: 'TRIAGE_SUMMARY' }, (res) => {
            if (!res || res.error) return;
            const panel = document.getElementById('globalResult');
            if (!panel) return;
            panel.style.display = 'block';
            const lines = (res.top3 || []).map(t => `${t.signature}: ${t.count}× (24h)`);
            panel.innerText = `Recent failures (24h): ${res.recent24h}\n` + (lines.join('\n') || 'None') + '\n\nSignatures & fixes — see qa/triage.md.';
        });
    });
}
setTimeout(() => { refreshTriageBanner(); wireTriageDetails(); }, 600);

tabBtns.forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// Restore last tab
chrome.storage.local.get(['lastActiveTab'], (result) => {
    if (result.lastActiveTab && tabContents[result.lastActiveTab]) {
        switchTab(result.lastActiveTab);
    } else {
        switchTab('home');
    }
});

// --- Input Persistence ---
const PERSISTENCE_KEY = 'atomAI_inputState';

async function saveInputState() {
    const state = {
        companyName: document.getElementById('companyName')?.value || '',
        deepTopic: document.getElementById('deepTopic')?.value || '',
        personName: document.getElementById('personName')?.value || '',
        marketTopic: document.getElementById('marketTopic')?.value || '',
        prompt: document.getElementById('prompt')?.value || '',
        monitorName: document.getElementById('monitorName')?.value || '',
        monitorUrl: document.getElementById('monitorUrl')?.value || '',
        webhookUrl: document.getElementById('webhookUrl')?.value || '',
        settingsApiKey: document.getElementById('settingsApiKey')?.value || '',
        battleUrls: Array.from(document.querySelectorAll('.battle-url')).map(inp => inp.value),
        globalResult: document.getElementById('globalResult')?.innerText || '',
        lastActiveTab: currentTab,
    };
    await chrome.storage.local.set({ [PERSISTENCE_KEY]: state });
}

async function restoreInputState() {
    const data = await chrome.storage.local.get([PERSISTENCE_KEY]);
    const state = data[PERSISTENCE_KEY];
    if (!state) return;

    const inputs = {
        companyName: 'companyName',
        deepTopic: 'deepTopic',
        personName: 'personName',
        marketTopic: 'marketTopic',
        prompt: 'prompt',
        monitorName: 'monitorName',
        monitorUrl: 'monitorUrl',
        webhookUrl: 'webhookUrl',
        settingsApiKey: 'settingsApiKey',
    };

    for (const [key, id] of Object.entries(inputs)) {
        const el = document.getElementById(id);
        if (el && state[key]) el.value = state[key];
    }

    // Restore battle URLs
    if (state.battleUrls && state.battleUrls.length > 0) {
        const battleContainer = document.getElementById('battleInputs');
        if (battleContainer) {
            battleContainer.innerHTML = '';
            state.battleUrls.forEach(url => addCompetitorRow(url));
        }
    }

    // Restore global result
    const globalResult = document.getElementById('globalResult');
    if (globalResult && state.globalResult) {
        globalResult.innerText = state.globalResult;
        globalResult.style.display = 'block';
    }

    // Restore last active tab
    if (state.lastActiveTab && tabContents[state.lastActiveTab]) {
        switchTab(state.lastActiveTab);
    }

    // Restore API key in settings (if present)
    if (state.settingsApiKey) {
        const settingsApiKeyEl = document.getElementById('settingsApiKey');
        if (settingsApiKeyEl) settingsApiKeyEl.value = state.settingsApiKey;
        refreshNoKeyBanner();
    }
}

// Debounced save function
let saveTimeout;
function debouncedSave() {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveInputState, 500);
}

// Attach input listeners for persistence
function attachPersistenceListeners() {
    const inputIds = [
        'companyName', 'deepTopic', 'personName', 'marketTopic',
        'prompt', 'monitorName', 'monitorUrl', 'webhookUrl', 'settingsApiKey'
    ];

    inputIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', debouncedSave);
            el.addEventListener('change', debouncedSave);
        }
    });

    // Also save on battle URL changes
    document.addEventListener('input', (e) => {
        if (e.target.classList.contains('battle-url')) {
            debouncedSave();
        }
    });

    // Save global result changes
    const globalResult = document.getElementById('globalResult');
    if (globalResult) {
        const observer = new MutationObserver(debouncedSave);
        observer.observe(globalResult, { childList: true, characterData: true, subtree: true });
    }
}

// --- Input Persistence End ---

// Restore input state and attach persistence listeners
restoreInputState();
attachPersistenceListeners();

// --- Home Tab Actions ---

// No-key banner: shown until a Groq API key is saved in Settings
const noKeyBanner = document.getElementById('noKeyBanner');
function refreshNoKeyBanner() {
    if (noKeyBanner) noKeyBanner.style.display = settingsState.apiKey ? 'none' : 'block';
}
refreshNoKeyBanner();

// Battle Card: dynamic competitor rows
const battleContainer = document.getElementById('battleInputs');
const addCompetitorBtn = document.getElementById('addCompetitorBtn');
const compareOpenTabsBtn = document.getElementById('compareOpenTabs');
const generateBattleCardBtn = document.getElementById('generateBattleCard');

function addCompetitorRow(value = '') {
    const rowDiv = document.createElement('div');
    rowDiv.className = 'input-group battle-row';
    rowDiv.innerHTML = `<input type="text" class="battle-url" placeholder="Competitor URL" value="${value.replace(/"/g, '&quot;')}">`;
    battleContainer.appendChild(rowDiv);
}
addCompetitorBtn.addEventListener('click', () => addCompetitorRow());

// Compare open tabs — now creates a battlecard job in the service worker
compareOpenTabsBtn.addEventListener('click', async () => {
    if (!await ensureHostPermission()) {
        document.getElementById('globalResult').style.display='block';
        document.getElementById('globalResult').innerText='Host permission required. Click “Grant host access” above, then try again.';
        return;
    }
    const tabs = await Utils.getReadableTabs({ currentWindow: true, maxTabs: 5 });
    const urls = tabs.map(tab => tab.url).filter(url => /^https?:\/\//i.test(url));
    if (!urls.length) {
        showError('Open at least 2 normal websites to compare.');
        return;
    }
    battleContainer.innerHTML = '';
    urls.slice(0,5).forEach(url => addCompetitorRow(url));
    // Trigger job creation via service worker instead of inline
    generateBattleCardBtn.click();
});

// Generate battle card — thin renderer: delegate to service worker job
generateBattleCardBtn.addEventListener('click', async () => {
    const urls = Array.from(document.querySelectorAll('.battle-url'))
        .map(inp => inp.value.trim())
        .filter(Boolean);
    if (urls.length === 0) {
        showError('Enter at least one competitor URL.');
        return;
    }
    if (!await ensureHostPermission()) {
        const rp = document.getElementById('globalResult');
        rp.style.display='block';
        rp.innerText='Host permission required to crawl. Please click "Grant host access" in the banner above.';
        return;
    }
    const resultPanel = document.getElementById('globalResult');
    const btn = generateBattleCardBtn;
    setButtonLoading(btn, true, 'Generating…');
    resultPanel.style.display = 'block';
    showLoading('Queuing battle card job...');
    try {
        const res = await chrome.runtime.sendMessage({ type: 'JOB_CREATE', jobType: 'battlecard', payload: { urls } });
        if (res?.error) {
            showError(`Error: ${res.error}`);
            return;
        }
        const jobId = res.jobId || res.job?.id;
        showSuccess(`Battle card job started (${jobId}). Progress will appear below. Closing popup is safe.`);
        // immediate refresh
        await refreshJobsFromStorage();
        // also ensure history will update on completion via background
    } catch (err) {
        showError(`Error: ${err.message}`);
    } finally {
        setButtonLoading(btn, false, 'Generate Battle Card');
    }
});

// Quick company research (still direct, not job-based, but could be moved later)
const companyInput = document.getElementById('companyName');
const quickResearchBtn = document.getElementById('quickResearchBtn');
quickResearchBtn.addEventListener('click', async () => {
    const company = companyInput.value.trim();
    if (!company) return;
    const resultPanel = document.getElementById('globalResult');
    const btn = quickResearchBtn;
    setButtonLoading(btn, true, 'Researching…');
    resultPanel.style.display = 'block';
    resultPanel.innerText =
        `🔍 Researching ${company}...\n\n` +
        `• Searching company overview...\n` +
        `• Searching recent news...\n` +
        `• Searching reviews and competitors...\n` +
        `• Searching pricing information...\n\n` +
        `Building your brief...`;
    try {
        // onProgress is the trailing optional arg of chat(); salesResearch forwards
        // it so the button reports each stage. dataset.originalText (captured by
        // setButtonLoading above) still wins in the finally below.
        const report = await research.salesResearch(company, (msg) => {
            try { btn.innerText = msg; } catch (e) {}
        });
        resultPanel.innerText = report;
        research.showReportActions('globalResult', company, report);
    } catch (err) {
        showError('Failed to research company: ' + err.message);
    } finally {
      setButtonLoading(btn, false, 'Generate Sales Brief');
    }
});

// --- Research Tab Actions ---
document.getElementById('deepResearchBtn').addEventListener('click', () => {
    const topic = document.getElementById('deepTopic').value.trim();
    if (topic) research.deepResearch(topic);
});
document.getElementById('personResearchBtn').addEventListener('click', () => {
    const name = document.getElementById('personName').value.trim();
    if (name) research.runPersonResearch(name);
});
document.getElementById('marketSizeBtn').addEventListener('click', () => {
    const topic = document.getElementById('marketTopic').value.trim();
    if (topic) research.marketSize(topic);
});
document.getElementById('marketTrendsBtn').addEventListener('click', () => {
    const topic = document.getElementById('marketTopic').value.trim();
    if (topic) research.marketTrends(topic);
});
document.getElementById('marketPlayersBtn').addEventListener('click', () => {
    const topic = document.getElementById('marketTopic').value.trim();
    if (topic) research.marketPlayers(topic);
});

// Multitab research via service worker (if button exists)
const multiTabBtn = document.getElementById('intelMultiTab') || document.getElementById('multiTabResearchBtn');
if (multiTabBtn) {
  multiTabBtn.addEventListener('click', async ()=>{
    const topicEl = document.getElementById('intelTopic') || document.getElementById('deepTopic');
    const topic = topicEl?.value.trim() || '';
    const resultPanel = document.getElementById('globalResult');
    if (resultPanel){ resultPanel.style.display='block'; resultPanel.innerText='Queued multitab job... You can close popup.'; }
    try {
      const tabs = await Utils.getReadableTabs({ currentWindow:true, maxTabs:5 });
      const urls = tabs.map(t=>t.url).filter(Boolean);
      const payload = urls.length ? { urls, topic } : { topic };
      const res = await chrome.runtime.sendMessage({ type:'JOB_CREATE', jobType:'multitab', payload });
      if (res?.error && resultPanel) resultPanel.innerText = `Error: ${res.error}`;
      else if (resultPanel) resultPanel.innerText = `Multitab job started (${res.jobId}). See Jobs below.`;
      await refreshJobsFromStorage();
    } catch(e){ if (resultPanel) resultPanel.innerText = `Error: ${e.message}`; }
  });
}

// Deal Room — pre-call brief from open tabs (SW job, survives popup close)
const dealRoomBtn = document.getElementById('dealRoomBtn');
if (dealRoomBtn) {
  dealRoomBtn.addEventListener('click', async ()=>{
    const prospectUrl = document.getElementById('dealProspectUrl')?.value.trim() || '';
    const resultPanel = document.getElementById('globalResult');
    const btn = dealRoomBtn;
    if (!prospectUrl) {
      showError('Enter the prospect URL — the company you are calling.');
      return;
    }
    if (!await ensureHostPermission()) {
      if (resultPanel){ resultPanel.style.display='block'; resultPanel.innerText='Host permission required to read tabs. Please click "Grant host access" in the banner above.'; }
      return;
    }
    setButtonLoading(btn, true, 'Building...');
    showLoading('Queued Deal Room brief... Open tabs are used as competitor sources. You can close the popup.');
    try {
      const payload = {
        prospectUrl,
        maxTabs: 10,
        profile: { seller: settingsState.ownProductUrl || '' },
      };
      const res = await chrome.runtime.sendMessage({ type:'JOB_CREATE', jobType:'dealroom', payload });
      if (res?.error) {
        showError(`Error: ${res.error}`);
      } else {
        showSuccess(`Deal Room job started (${res.jobId}). Progress appears in Jobs on Home — closing the popup is safe.`);
        await refreshJobsFromStorage();
      }
    } catch(e){ showError(`Error: ${e.message}`); }
    finally { setButtonLoading(btn, false, '🎯 Build Deal Room Brief'); }
  });
}

// --- Monitor Tab ---
const addMonitorBtn = document.getElementById('addMonitorBtn');
addMonitorBtn.addEventListener('click', () => monitor.addMonitor());
const checkAllMonitorsBtn = document.getElementById('checkAllMonitorsBtn');
checkAllMonitorsBtn.addEventListener('click', () => monitor.checkAll());
// monitor.load() is called on tab switch

// --- Notes & History ---
document.getElementById('notesSearch').addEventListener('input', (e) => notes.load(e.target.value));
document.getElementById('historySearch').addEventListener('input', (e) => history.loadHistory('all', e.target.value));

// --- Settings Panel ---
const settingsPanel = document.getElementById('settingsPanel');
const settingsBtn = document.getElementById('settingsBtn');
const closeSettingsBtn = document.getElementById('closeSettingsBtn');
settingsBtn.addEventListener('click', () => settingsPanel.classList.add('open'));
closeSettingsBtn.addEventListener('click', () => {
    settingsPanel.classList.remove('open');
    refreshNoKeyBanner();
});

// Export/Import
document.getElementById('exportDataBtn').addEventListener('click', async () => {
    const allData = await chrome.storage.local.get(null);
    const blob = new Blob([JSON.stringify(allData, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `atom-ai-backup-${Date.now()}.json`;
    a.click();
});
const importFile = document.getElementById('importFile');
document.getElementById('importDataBtn').addEventListener('click', () => importFile.click());
importFile.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    const data = JSON.parse(text);
    await chrome.storage.local.set(data);
    showSuccess('Data imported. Reloading...');
    setTimeout(() => window.location.reload(), 1000);
});
document.getElementById('resetExtensionBtn').addEventListener('click', async () => {
    if (confirm('Reset all data? This cannot be undone.')) {
        await chrome.storage.local.clear();
        window.location.reload();
    }
});
document.getElementById('clearDebugLogBtn').addEventListener('click', async () => {
    await chrome.storage.local.set({ debugLogs: [] });
    document.getElementById('debugLogBox').innerText = 'Debug log cleared.';
});

// --- Helper: Usage UI
function updateUsageUI(usage) {
    const calls = usage?.calls || 0;
    const max = usage?.max || 10;
    document.getElementById('usageText').innerText = `${calls} / ${max} calls today`;
    const percent = Math.min((calls / max) * 100, 100);
    document.getElementById('usageFill').style.width = `${percent}%`;
    return true;
}

// Load debug log on settings open
function refreshDebugLog() {
    chrome.storage.local.get(['debugLogs'], (res) => {
        const logs = res.debugLogs || [];
        const box = document.getElementById('debugLogBox');
        if (!logs.length) box.innerText = 'No debug logs.';
        else box.innerText = logs.slice(0, 60).map(l => `[${l.ts}] ${l.message}`).join('\n');
    });
}
settingsBtn.addEventListener('click', refreshDebugLog);

// ---------- Auto Task UI — live timeline, approvals, cost ----------
// The agent loop itself lives in the service worker (autotask.js via
// background.js) so a run survives the popup closing. The popup only:
//   start (delegated through automate.runAgent), stop, approve/deny, and
//   render {autoTaskRun} from chrome.storage.local.

function autoTaskStatusLine(run) {
  const status = String(run.status || 'idle').toUpperCase();
  // run.step is a 1-based index of the step being executed and is 0 before the
  // first one runs, so it must be tested as a number, not for truthiness.
  // There is deliberately NO "/total" suffix: the run schema records no planned
  // step count, so a total could only be invented. run.steps is the array of
  // steps actually completed, which is not a total.
  const step = (typeof run.step === 'number' && run.step > 0) ? ' · step ' + run.step : '';
  const done = Array.isArray(run.steps) && run.steps.length ? ' · ' + run.steps.length + ' done' : '';
  return status + step + done + ' · ' + (run.aiCalls || 0) + ' AI calls this run';
}

// Cost display. The number rendered here is quotaState.count via
// userSettings.dailyCallsUsed — the SAME counter background.js enforces quota
// against. Auto Task charges AUTO_TASK_CALL_MULTIPLIER units per run into it, so
// there is no separate display-only meter that can drift from what gates usage.
function renderQuotaLine() {
  const el = document.getElementById('autoTaskQuota');
  if (!el) return;
  const apply = (data) => {
    const used = (data && data.quotaState && typeof data.quotaState.count === 'number')
      ? data.quotaState.count
      : (data && data.userSettings && Number(data.userSettings.dailyCallsUsed)) || 0;
    el.innerText = used + ' AI calls used today (auto task included)';
  };
  try {
    const p = chrome.storage.local.get(['userSettings', 'quotaState']);
    if (p && typeof p.then === 'function') p.then(apply).catch(() => {});
    else apply(p);
  } catch (e) {}
}

function renderAutoTaskRun(run) {
  const container = document.getElementById('autoTaskTimeline');
  if (!container) return;
  const autotaskBtn = document.getElementById('autotask');
  const stopBtn = document.getElementById('agentStop');
  const loader = document.getElementById('loader');

  if (!run) {
    container.innerHTML = '<div style="font-size:11px;color:var(--tx3);text-align:center;padding:8px;">No task yet.</div>';
    if (autotaskBtn) autotaskBtn.disabled = false;
    if (stopBtn) stopBtn.style.display = 'none';
    if (loader) loader.style.display = 'none';
    document.getElementById('approvalCard')?.remove();
    return;
  }

  const running = run.status === 'running' || run.status === 'waiting_approval';
  const obs = Array.isArray(run.observations) ? run.observations.slice(-10) : [];
  const head = '<div style="font-size:11px;color:var(--tx2);padding:2px 0 6px;">' + autoTaskStatusLine(run) + '</div>';
  const body = obs.length
    ? obs.map((o, i) => `
      <div style="display:flex;gap:8px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.05);font-size:11px;">
        <span style="color:var(--tx3);min-width:18px;">${Math.max(1, obs.length - 10 + i + 1)}</span>
        <span style="color:var(--tx2);flex:1;word-break:break-word;">${String(o).slice(0, 140)}</span>
      </div>`).join('')
    : run.status === 'running' || run.status === 'waiting_approval'
      ? '<div style="font-size:11px;color:var(--tx3);text-align:center;padding:8px;">Agent is thinking…</div>'
      : '<div style="font-size:11px;color:var(--tx3);text-align:center;padding:8px;">No task yet.</div>';
  container.innerHTML = head + body;
  container.scrollTop = container.scrollHeight;

  if (autotaskBtn) autotaskBtn.disabled = running;
  if (stopBtn) stopBtn.style.display = running ? 'inline-block' : 'none';
  if (loader) {
    loader.style.display = running ? 'block' : 'none';
    if (running) loader.innerText = run.status === 'waiting_approval' ? '⏳ Waiting for your approval…' : '⚡ Running in background… safe to close the popup.';
  }

  if (run.status === 'waiting_approval') {
    const pending = (run.approvals || []).find(a => a.status === 'pending');
    if (pending) showApprovalCard(pending);
  } else {
    document.getElementById('approvalCard')?.remove();
  }

  renderRecipeControls(run);
  renderQuotaLine();
}

// ---- recipes (Phase 6, wired) -------------------------------------------
// Minimal surface: list saved recipes, replay one, and offer save-as-recipe when
// the runner recorded an offer on a finished run.
function refreshRecipeList() {
  const select = document.getElementById('recipeSelect');
  if (!select) return;
  const apply = (res) => {
    const recipes = (res && res.recipes) || [];
    const previous = select.value;
    select.innerHTML = recipes.length
      ? recipes.map(r => `<option value="${r.recipeId}">${String(r.name).slice(0, 40)} (${r.stepCount})</option>`).join('')
      : '<option value="">No saved recipes yet</option>';
    if (previous && recipes.some(r => r.recipeId === previous)) select.value = previous;
  };
  try {
    const p = chrome.runtime.sendMessage({ type: 'AUTO_TASK_LIST_RECIPES' });
    if (p && typeof p.then === 'function') p.then(apply).catch(() => {});
    else apply(p);
  } catch (e) {}
}

function renderRecipeControls(run) {
  const saveBtn = document.getElementById('recipeSave');
  if (!saveBtn) return;
  const offer = run && run.recipeOffer;
  if (run && run.recipeSaved) {
    saveBtn.style.display = 'inline-block';
    saveBtn.disabled = true;
    saveBtn.innerText = '✓ Saved as recipe';
  } else if (offer) {
    saveBtn.style.display = 'inline-block';
    saveBtn.disabled = false;
    saveBtn.innerText = `Save as recipe (${offer.stepCount} steps)`;
  } else {
    saveBtn.style.display = 'none';
  }
}

// Show approval card for confirm-risk actions (60s timeout = deny).
function showApprovalCard(approval) {
  if (document.getElementById('approvalCard')) return; // already shown
  const card = document.createElement('div');
  card.id = 'approvalCard';
  card.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:10000;background:#14141f;border:1px solid #6c63ff;border-radius:12px;padding:16px;max-width:360px;box-shadow:0 8px 32px rgba(0,0,0,0.5);';
  card.innerHTML = `
    <div style="font-weight:600;color:#6c63ff;margin-bottom:8px;">⚠️ Confirmation Required</div>
    <div style="color:var(--tx);margin-bottom:12px;font-size:13px;">${approval.description || 'This action needs your approval.'}</div>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button id="approvalDeny" class="btn-secondary" style="flex:1;">Deny</button>
      <button id="approvalApprove" class="btn" style="flex:1;background:linear-gradient(135deg,#6c63ff,#00d4a8);">Approve</button>
    </div>
    <div id="approvalCountdown" style="margin-top:8px;font-size:11px;color:var(--tx2);text-align:center;"></div>
  `;
  document.body.appendChild(card);

  const startTime = Date.now();
  const timeoutMs = 60000;
  const countdown = document.getElementById('approvalCountdown');
  const timer = setInterval(() => {
    const remaining = Math.max(0, Math.ceil((timeoutMs - (Date.now() - startTime)) / 1000));
    if (countdown) countdown.innerText = 'Timeout in ' + remaining + 's (auto-deny)';
    if (remaining <= 0) clearInterval(timer);
  }, 1000);

  const send = async (decision) => {
    clearInterval(timer);
    card.remove();
    try { await chrome.runtime.sendMessage({ type: 'AUTO_TASK_APPROVAL', approvalId: approval.id, decision }); } catch (e) {}
  };
  card.querySelector('#approvalApprove').addEventListener('click', () => send('approved'));
  card.querySelector('#approvalDeny').addEventListener('click', () => send('denied'));
  setTimeout(() => { if (document.getElementById('approvalCard')) send('timeout'); }, timeoutMs);
}

// Stop button → cancel the background run. A run that has already done real
// work is destructive to abort (it cannot be resumed), so ask first; the read of
// autoTaskRun is best-effort and a failure must not block the stop itself.
document.getElementById('agentStop')?.addEventListener('click', async () => {
  try {
    const data = await chrome.storage.local.get(['autoTaskRun']);
    const stepsDone = data?.autoTaskRun?.steps?.length || 0;
    if (stepsDone > 2) {
      const ok = confirm(`Stop the task? It has completed ${stepsDone} step(s). This cannot be resumed.`);
      if (!ok) return;
    }
  } catch (e) { /* storage unavailable — stop anyway rather than trap the user */ }
  try { await chrome.runtime.sendMessage({ type: 'AUTO_TASK_STOP' }); } catch (e) {}
});

// Live updates from the service worker.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.autoTaskRun) renderAutoTaskRun(changes.autoTaskRun.newValue);
  // The quota counter is the one that gates usage — keep the displayed number
  // identical to it, including when plain AI calls move it.
  if (changes.quotaState || changes.userSettings) renderQuotaLine();
});

// Add the timeline + recipe controls + quota line, seed from current state.
setTimeout(() => {
  const card = document.getElementById('autoTaskCard');
  if (card && !document.getElementById('autoTaskTimeline')) {
    const timeline = document.createElement('div');
    timeline.id = 'autoTaskTimeline';
    timeline.style.cssText = 'max-height:180px;overflow-y:auto;margin-top:8px;padding:8px;background:rgba(0,0,0,0.2);border-radius:6px;font-size:11px;';
    timeline.innerHTML = '<div style="font-size:11px;color:var(--tx3);text-align:center;padding:8px;">No task yet.</div>';

    const recipes = document.createElement('div');
    recipes.id = 'autoTaskRecipes';
    recipes.style.cssText = 'display:flex;gap:6px;align-items:center;margin-top:8px;font-size:11px;';
    recipes.innerHTML = `
      <select id="recipeSelect" style="flex:1;min-width:0;font-size:11px;padding:4px;background:rgba(0,0,0,0.25);color:var(--tx2);border:1px solid rgba(255,255,255,0.1);border-radius:6px;">
        <option value="">Loading recipes…</option>
      </select>
      <button id="recipeRun" class="btn-secondary" style="font-size:11px;padding:4px 8px;">Run</button>
      <button id="recipeSave" class="btn-secondary" style="font-size:11px;padding:4px 8px;display:none;">Save as recipe</button>
    `;

    const quota = document.createElement('div');
    quota.id = 'autoTaskQuota';
    quota.style.cssText = 'margin-top:6px;font-size:11px;color:var(--a,#6c63ff);text-align:right;';
    const loader = document.getElementById('loader');
    if (loader) {
      loader.insertAdjacentElement('afterend', timeline);
      timeline.insertAdjacentElement('afterend', recipes);
      recipes.insertAdjacentElement('afterend', quota);
    } else {
      card.appendChild(timeline);
      card.appendChild(recipes);
      card.appendChild(quota);
    }
  }

  document.getElementById('recipeRun')?.addEventListener('click', async () => {
    const select = document.getElementById('recipeSelect');
    const recipeId = select && select.value;
    if (!recipeId) { window.showToast?.('No saved recipe to run.', 'error'); return; }
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !Utils.isInjectableTab(tab)) throw new Error('Open a normal website tab first.');
      const res = await chrome.runtime.sendMessage({ type: 'AUTO_TASK_RUN_RECIPE', recipeId, tabId: tab.id });
      if (!res || res.ok === false) throw new Error(res?.error || res?.reason || 'Could not run the recipe.');
      window.showToast?.(res.fellBackToAgent ? 'Recipe could not be replayed — continuing as a task.' : 'Recipe running in background.', 'info');
    } catch (e) {
      window.showToast?.(String(e?.message || e), 'error');
    }
  });

  document.getElementById('recipeSave')?.addEventListener('click', async () => {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'AUTO_TASK_SAVE_RECIPE' });
      if (!res || res.ok === false) throw new Error(res?.error || res?.reason || 'Could not save the recipe.');
      window.showToast?.(`Saved recipe "${res.name}" (${res.stepCount} steps).`, 'success');
      refreshRecipeList();
    } catch (e) {
      window.showToast?.(String(e?.message || e), 'error');
    }
  });

  refreshRecipeList();
  renderQuotaLine();
  try {
    const p = chrome.runtime.sendMessage({ type: 'AUTO_TASK_GET_STATE' });
    if (p && typeof p.then === 'function') {
      p.then((res) => { if (res?.run) renderAutoTaskRun(res.run); }).catch(() => {});
    }
  } catch (e) {}
}, 400);

// ---------- Phase 8: trigger moment — focus requested card when popup opens ----------
// SW stored openCardRequest when the trigger banner's "Open card" was clicked
// (chrome.action.openPopup() if available, else badge + manual click).
(async () => {
    try {
        const data = await chrome.storage.local.get(['openCardRequest']);
        const req = data.openCardRequest;
        if (!req || !req.jobId) return;
        if (Date.now() - (req.ts || 0) > 60000) { // stale request
            await chrome.storage.local.remove(['openCardRequest']);
            return;
        }
        let target = jobsCache.find(x => x.id === req.jobId);
        if (!target) {
            const d2 = await chrome.storage.local.get(['jobs']);
            const found = (d2.jobs || []).find(x => x.id === req.jobId);
            if (found) { jobsCache.unshift(found); renderJobsList(jobsCache); }
            target = jobsCache.find(x => x.id === req.jobId);
        }
        if (target) {
            switchTab('home');
            const panel = document.getElementById('globalResult');
            if (panel && target.resultRef) {
                // Deal Room briefs render as HTML with clickable citation chips
                if (target.type === 'dealroom' && target.briefJson) {
                    panel.style.display = 'block';
                    panel.innerHTML = renderDealRoomBrief(target.briefJson, target.briefStats);
                } else if (target.type === 'battlecard' && target.resultRef) {
                    try { renderBattlecardView(target); } catch (e) {}
                } else {
                    panel.innerText = target.resultRef;
                }
            }
            const list = document.getElementById('jobsList');
            if (list) list.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        // request consumed
        await chrome.storage.local.remove(['openCardRequest']);
    } catch (e) {}
})();
