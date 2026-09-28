// monitor.js
import { Utils } from './utils.js';

export class Monitor {
  constructor(ai, userSettings) {
    this.ai = ai;
    this.userSettings = userSettings;
    this.monitors = [];
    this.initEventListeners();
    this.load();
  }

  async load() {
    const data = await chrome.storage.local.get(["monitors"]);
    this.monitors = data.monitors || [];
    this.render();
    this.loadDailyBrief();
  }

  render() {
    const list = document.getElementById("monitorList");
    if (!list) return;
    list.querySelectorAll(".monitor-item").forEach((el) => el.remove());
    const empty = document.getElementById("monitorEmpty");
    if (empty) empty.style.display = this.monitors.length ? "none" : "block";
    this.monitors.forEach((m, i) => {
      const item = document.createElement("div");
      item.className = "monitor-item";
      const statusText = m.lastChecked ? "OK " + new Date(m.lastChecked).toLocaleDateString() : "Pending";
      item.innerHTML = `
        <div>
          <div class="monitor-name">${m.name}</div>
          <div class="monitor-url">${(m.url || "").substring(0, 35)}${m.url?.length > 35 ? "..." : ""}</div>
          <div style="font-size:10px;margin-top:2px;color:var(--green);">${statusText}</div>
        </div>
        <div class="monitor-actions">
          <button class="icon-btn" data-index="${i}" data-action="check">Check</button>
          <button class="icon-btn danger" data-index="${i}" data-action="remove">x</button>
        </div>
      `;
      list.appendChild(item);
    });
    list.querySelectorAll("[data-action='check']").forEach((btn) => {
      btn.addEventListener("click", () => this.checkMonitor(parseInt(btn.dataset.index)));
    });
    list.querySelectorAll("[data-action='remove']").forEach((btn) => {
      btn.addEventListener("click", () => this.removeMonitor(parseInt(btn.dataset.index)));
    });
  }

  async checkMonitor(idx) {
    const monitor = this.monitors[idx];
    const resultEl = document.getElementById("monitorResult");
    if (resultEl) {
      resultEl.style.display = "block";
      resultEl.innerText = `Checking ${monitor.name}...`;
    }
    try {
      const combined = await Utils.googleResearch(monitor.name + " news updates 2025");
      const report = await this.ai.chat(`What's new with "${monitor.name}" recently?\n\nData:\n${combined.substring(0, 6000)}\n\nProvide:\nLatest News\nRecent Changes\nKey Developments\nWhat to Watch`);
      if (resultEl) resultEl.innerText = `${monitor.name} - ${new Date().toLocaleDateString()}\n\n${report}`;
      monitor.lastChecked = Date.now();
      monitor.lastReport = report;
      await chrome.storage.local.set({ monitors: this.monitors });
      this.render();
    } catch (e) {
      if (resultEl) resultEl.innerText = "Failed to check. Try again.";
    }
  }

  async removeMonitor(idx) {
    this.monitors.splice(idx, 1);
    await chrome.storage.local.set({ monitors: this.monitors });
    this.render();
  }

  async addMonitor() {
    const name = document.getElementById("monitorName").value.trim();
    let url = document.getElementById("monitorUrl").value.trim();
    if (!name) return alert("Enter a competitor name");
    if (!url) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      url = tab.url;
    }
    this.monitors.push({ name, url, addedAt: Date.now(), lastChecked: null });
    await chrome.storage.local.set({ monitors: this.monitors });
    this.render();
    document.getElementById("monitorName").value = "";
    document.getElementById("monitorUrl").value = "";
  }

  async checkAll() {
    const btn = Monitor.btn("checkAllMonitorsBtn", "monitorCheckAll");
    if (btn) btn.disabled = true;
    const resultEl = document.getElementById("monitorResult");

    try {
      if (resultEl) {
        resultEl.style.display = "block";
        resultEl.innerText = "Checking all competitors...";
      }

      let fullReport = `Competitor Intel - ${new Date().toDateString()}\n${"=".repeat(40)}\n\n`;
      const results = await Utils.mapWithConcurrency(this.monitors, async (monitor) => {
        if (resultEl) resultEl.innerText = `Checking ${monitor.name}...`;
        const combined = await Utils.googleResearch(monitor.name + " news 2025");
        const report = await this.ai.chat(`Summarize in 3 lines what's new with "${monitor.name}" recently:\n${combined.substring(0, 3000)}`);
        return { name: monitor.name, report, checkedAt: Date.now() };
      }, 3);

      results.forEach((entry, index) => {
        if (!entry) return;
        fullReport += `${entry.name}\n${entry.report}\n\n`;
        this.monitors[index].lastChecked = entry.checkedAt;
      });

      await chrome.storage.local.set({ monitors: this.monitors, dailyBrief: fullReport });
      // #briefContent only exists on the standalone brief view, not in the popup's
      // Monitor tab. This line used to throw a TypeError here, which meant the
      // report below never rendered and render() never ran — "Check All Now"
      // looked like it failed no matter what.
      const briefEl = document.getElementById("briefContent");
      if (briefEl) briefEl.innerText = fullReport;
      if (resultEl) resultEl.innerText = fullReport;
      this.render();
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async loadDailyBrief() {
    const data = await chrome.storage.local.get(["dailyBrief"]);
    const dateEl = document.getElementById("briefDate");
    const contentEl = document.getElementById("briefContent");
    if (dateEl) dateEl.innerText = new Date().toDateString();
    if (contentEl) contentEl.innerText = data.dailyBrief || "Add competitors below to get your daily intelligence brief.";
  }

  // The popup's Monitor tab names these buttons #addMonitorBtn /
  // #checkAllMonitorsBtn, but this class looked for #monitorAdd / #monitorCheckAll.
  // Both names are resolved (markup first) so neither the current popup nor any
  // other host of this markup is left with a dead button.
  static btn(...ids) {
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) return el;
    }
    return null;
  }

  initEventListeners() {
    const addBtn = Monitor.btn("addMonitorBtn", "monitorAdd");
    if (addBtn) addBtn.addEventListener("click", () => this.addMonitor());
    const checkAllBtn = Monitor.btn("checkAllMonitorsBtn", "monitorCheckAll");
    if (checkAllBtn) checkAllBtn.addEventListener("click", () => this.checkAll());
    const refreshBtn = document.getElementById("refreshBrief");
    if (refreshBtn) refreshBtn.addEventListener("click", () => this.checkAll());
  }
}
