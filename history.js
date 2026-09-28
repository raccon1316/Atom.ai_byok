// history.js
import { Utils } from './utils.js';
import { getStats } from './winloss.js';

export class History {
  constructor(ai) {
    this.ai = ai;
    this.currentFilter = "all";
    this.currentWinLossFilter = "all";
    this.currentItem = null;
    this.initEventListeners();
  }

async loadHistory(filter = "all", search = "", winLossFilter = "all") {
    const data = await chrome.storage.local.get(["researchHistory", "winloss"]);
    let history = data.researchHistory || [];
    const winloss = data.winloss || [];
    if (filter !== "all") history = history.filter(h => h.type === filter);
    if (search) history = history.filter(h => (h.topic || "").toLowerCase().includes(search) || (h.report || "").toLowerCase().includes(search));
    if (winLossFilter !== "all") {
      history = history.filter(h => {
        const s = getStats(winloss.filter(w => w.competitor === h.topic.toLowerCase()));
        if (winLossFilter === 'won') return s.won > 0;
        if (winLossFilter === 'lost') return s.lost > 0;
        return true;
      });
    }

    const list = document.getElementById("historyList");
    const empty = document.getElementById("historyEmpty");
    if (!list) return;
    list.querySelectorAll(".history-card").forEach(el => el.remove());
    if (empty) empty.style.display = history.length ? "none" : "block";

    for (const item of history) {
      const card = document.createElement("div");
      card.className = "history-card";
      const icon = this.getIcon(item.type);
      const typeLabel = this.getTypeLabel(item.type);
      const wl = winloss.filter(w => w.competitor === item.topic.toLowerCase());
      const s = getStats(wl);
      const wlBadge = winloss.length
        ? `<span class="wl-badge" style="font-size:10px;padding:1px 6px;border-radius:99px;background:${s.won > s.lost ? 'rgba(79,239,212,0.15)' : 'rgba(255,110,142,0.15)'};color:${s.won >= s.lost ? 'var(--a2)' : 'var(--a3)'};border:1px solid ${s.won >= s.lost ? 'rgba(79,239,212,0.3)' : 'rgba(255,110,142,0.3)'};font-size:9px;padding:1px 6px;border-radius:99px;">${s.won}W/${s.lost}L</span>`
        : '';
      card.innerHTML = `
        <div class="history-card-top">
          <span class="history-card-icon">${icon}</span>
          <span class="history-card-topic">${item.topic || "Untitled"}</span>
          ${wlBadge}
        </div>
        <div class="history-card-preview">${(item.preview || "").substring(0, 120)}</div>
        <div class="history-card-meta">
          <span class="history-card-date">${item.savedAt || ""}</span>
          <span class="history-card-type type-${item.type}">${typeLabel}</span>
          <button class="history-card-del" data-id="${item.id}">🗑</button>
        </div>
      `;
      card.addEventListener("click", (e) => {
        if (e.target.classList.contains("history-card-del")) return;
        this.openViewer(item);
      });
      const delBtn = card.querySelector(".history-card-del");
      if (delBtn) {
        delBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const d = await chrome.storage.local.get(["researchHistory"]);
          const updated = d.researchHistory.filter(h => h.id !== item.id);
          const save = await Utils.setBoundedStorageArray("researchHistory", updated, {
            maxItems: 100,
            minItems: 20,
            trimStep: 10
          });
          if (!save.ok) await Utils.writeDebugLog(`Failed to save research history: ${save.error?.message || "quota error"}`, "warn");
          this.loadHistory(this.currentFilter, document.getElementById("historySearch")?.value || "", this.currentWinLossFilter);
        });
      }
list.appendChild(card);
    }
  }

  // Inline viewer: the History tab has no separate viewer DOM, so render the
  // full report into the list area with back + export actions.
  openViewer(item) {
    this.currentItem = item;
    const list = document.getElementById("historyList");
    if (!list) return;
    const search = document.getElementById("historySearch");
    if (search) search.style.display = "none";
    list.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "history-viewer";
    wrap.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
        <button id="hvBack" class="btn-secondary" style="font-size:11px;padding:4px 10px;">← Back</button>
        <span style="font-weight:600;font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${item.topic || "Report"}</span>
      </div>
      <pre style="white-space:pre-wrap;word-break:break-word;font-size:11px;line-height:1.6;color:var(--tx2);max-height:300px;overflow-y:auto;background:var(--ink3);border:1px solid var(--line);border-radius:8px;padding:10px;"></pre>
      <div style="display:flex;gap:8px;margin-top:8px;">
        <button id="hvCopy" class="btn-secondary" style="font-size:11px;padding:6px 10px;">📋 Copy</button>
        <button id="hvPdf" class="btn-secondary" style="font-size:11px;padding:6px 10px;">🖨 PDF</button>
        <button id="hvTxt" class="btn-secondary" style="font-size:11px;padding:6px 10px;">📄 TXT</button>
      </div>`;
    wrap.querySelector("pre").innerText = item.report || "";
    list.appendChild(wrap);
    wrap.querySelector("#hvBack").addEventListener("click", () => this.closeViewer());
    wrap.querySelector("#hvCopy").addEventListener("click", async (e) => {
      try {
        await navigator.clipboard.writeText(item.report || "");
        e.currentTarget.innerText = "✅ Copied!";
        setTimeout(() => { e.currentTarget.innerText = "📋 Copy"; }, 1200);
      } catch (err) {}
    });
    wrap.querySelector("#hvPdf").addEventListener("click", () => this.exportPDF(item));
    wrap.querySelector("#hvTxt").addEventListener("click", () => this.exportTXT(item));
  }

  closeViewer() {
    const search = document.getElementById("historySearch");
    if (search) search.style.display = "";
    this.loadHistory(this.currentFilter, document.getElementById("historySearch")?.value || "", this.currentWinLossFilter);
  }

  initEventListeners() {
    const backBtn = document.getElementById("historyBack");
    if (backBtn) backBtn.addEventListener("click", () => this.closeViewer());

    const copyBtn = document.getElementById("historyViewCopy");
    if (copyBtn) copyBtn.addEventListener("click", async () => {
      if (this.currentItem) {
        await navigator.clipboard.writeText(this.currentItem.report);
        copyBtn.innerText = "✅ Copied!";
        setTimeout(() => copyBtn.innerText = "📋 Copy", 1200);
      }
    });

    const pdfBtn = document.getElementById("historyViewPDF");
    if (pdfBtn) pdfBtn.addEventListener("click", () => {
      if (this.currentItem) this.exportPDF(this.currentItem);
    });

    const txtBtn = document.getElementById("historyViewTxt");
    if (txtBtn) txtBtn.addEventListener("click", () => {
      if (this.currentItem) this.exportTXT(this.currentItem);
    });

    const clearAllBtn = document.getElementById("historyClearAll");
    if (clearAllBtn) clearAllBtn.addEventListener("click", async () => {
      if (confirm("Delete ALL research history? This cannot be undone.")) {
        await chrome.storage.local.remove("researchHistory");
        this.loadHistory();
      }
    });

    const searchInput = document.getElementById("historySearch");
    if (searchInput) searchInput.addEventListener("input", (e) => this.loadHistory(this.currentFilter, e.target.value, this.currentWinLossFilter));

    const wlFilter = document.getElementById("historyWinLossFilter");
    if (wlFilter) wlFilter.addEventListener("change", (e) => { this.currentWinLossFilter = e.target.value; this.loadHistory(this.currentFilter, document.getElementById("historySearch")?.value || "", e.target.value); });

    const exportWinLossBtn = document.getElementById("exportWinLossBtn");
    if (exportWinLossBtn) exportWinLossBtn.addEventListener("click", async () => {
      const data = await chrome.storage.local.get(["winloss"]);
      const list = data.winloss || [];
      const json = JSON.stringify(list, null, 2);
      const csv = ['competitor,outcome,why,date,cardVersion', ...list.map(r => `"${r.competitor}","${r.outcome}","${r.why.replace(/"/g, '""')}","${r.date}","${r.cardVersion}"`).join('\n')].join('\n');
      const type = confirm('Export as CSV? (Cancel for JSON)') ? 'csv' : 'json';
      const blob = new Blob([type === 'csv' ? csv : JSON.stringify(list, null, 2)], { type: type === 'csv' ? 'text/csv' : 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `winloss-${new Date().toISOString().slice(0,10)}.${type === 'csv' ? 'csv' : 'json'}`;
      a.click();
      URL.revokeObjectURL(a.href);
    });

    }

  getIcon(type) {
    const icons = { deep: "🔬", company: "🏢", person: "👤", market: "📊", page: "🔍", compare: "⚖️", dealroom: "🎯" };
    return icons[type] || "📋";
  }

  getTypeLabel(type) {
    const labels = { deep: "Deep Research", company: "Company", person: "Person", market: "Market", page: "Page Analysis", compare: "Compare", dealroom: "Deal Room" };
    return labels[type] || "Research";
  }

  exportPDF(item) {
    const html = `<!DOCTYPE html>
<html>
<head><title>Atom.AI — ${item.topic}</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family: Arial, sans-serif; padding: 48px; color: #1a1a2e; max-width: 800px; margin: 0 auto; }
.header { border-bottom: 3px solid #6c63ff; padding-bottom: 20px; margin-bottom: 28px; }
.logo { font-size: 11px; font-weight: 800; letter-spacing: 3px; color: #6c63ff; text-transform: uppercase; margin-bottom: 8px; }
h1 { font-size: 22px; color: #1a1a2e; margin-bottom: 6px; }
.date { font-size: 12px; color: #888; }
pre { white-space: pre-wrap; word-break: break-word; font-family: Arial, sans-serif; font-size: 13px; line-height: 1.8; color: #2a2a3e; }
@media print { body { padding: 24px; } button { display: none; } }
</style>
</head>
<body>
<div class="header">
<div class="logo">ATOM.AI RESEARCH REPORT</div>
<h1>${item.topic}</h1>
<div class="date">Generated: ${item.savedAt || new Date().toLocaleString()}</div>
</div>
<pre>${(item.report || "").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>
<button onclick="window.print()" style="margin-top:24px;padding:12px 24px;background:#6c63ff;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700;">Print / Save as PDF</button>
</body>
</html>`;
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, "_blank");
    if (win) setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  exportTXT(item) {
    const blob = new Blob([item.report], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "atom_" + (item.topic || "report").replace(/\s+/g, "_").toLowerCase() + ".txt";
    a.click();
  }
}
