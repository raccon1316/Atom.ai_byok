import { Utils } from './utils.js';
import {
  DEFAULT_BLOCKED_DOMAINS, addDomain, removeDomain, normalizeDomain,
} from './safety.js';

const GROQ_MODEL = "openai/gpt-oss-20b";
const BLOCKLIST_KEY = 'autoTaskBlockedDomains';

// settings.js
export class Settings {
  constructor(userSettings, ai) {
    this.userSettings = userSettings;
    this.ai = ai;
    this.initEventListeners();
  }

  async load() {
    const data = await chrome.storage.local.get(["userSettings"]);
    if (data.userSettings) Object.assign(this.userSettings, data.userSettings);

    const webhookIn = document.getElementById("webhookUrl");
    const apiKeyIn = document.getElementById("settingsApiKey");
    const ownProductIn = document.getElementById("ownProductUrl");
    const slackIn = document.getElementById("slackWebhookUrl");
    const hubspotIn = document.getElementById("hubspotToken");

    if (webhookIn) webhookIn.value = this.userSettings.webhookUrl || "";
    if (apiKeyIn) apiKeyIn.value = this.userSettings.apiKey || "";
    if (ownProductIn) ownProductIn.value = this.userSettings.ownProductUrl || "";
    if (slackIn) slackIn.value = this.userSettings.slackWebhookUrl || "";
    if (hubspotIn) hubspotIn.value = this.userSettings.hubspotToken || "";

    await this.loadBlocklist();
    await this.refreshDebugLog();
  }

  // ---- Auto Task domain blocklist ---------------------------------------
  // Storage layout: chrome.storage.local.autoTaskBlockedDomains holds ONLY the
  // user's additions. The built-in list is owned by safety.js and re-merged on
  // every read (background.js getAutoTaskBlockedDomains), so built-ins are
  // shown locked and cannot be removed — an affordance that silently failed
  // would tell the user a banking site was unblocked when it was not.
  async loadBlocklist() {
    let custom = [];
    try {
      const data = await chrome.storage.local.get([BLOCKLIST_KEY]);
      custom = Array.isArray(data?.[BLOCKLIST_KEY]) ? data[BLOCKLIST_KEY] : [];
    } catch (e) {
      custom = [];
    }
    this.blocklistCustom = custom.map(normalizeDomain).filter(Boolean);
    this.renderBlocklist();
  }

  async persistBlocklist(list) {
    this.blocklistCustom = list;
    try {
      await chrome.storage.local.set({ [BLOCKLIST_KEY]: list });
      return true;
    } catch (e) {
      return false;
    }
  }

  renderBlocklist() {
    const custom = Array.isArray(this.blocklistCustom) ? this.blocklistCustom : [];
    const defaultsBox = document.getElementById('blocklistDefaults');
    const customBox = document.getElementById('blocklistCustom');

    if (defaultsBox) {
      defaultsBox.innerText = '';
      for (const d of DEFAULT_BLOCKED_DOMAINS) {
        const row = document.createElement('span');
        row.className = 'blocklist-chip locked';
        row.innerText = `${d} 🔒`;
        row.title = 'Built in — banking and payment sites are always blocked';
        defaultsBox.appendChild(row);
      }
    }

    if (customBox) {
      customBox.innerText = '';
      if (!custom.length) {
        const empty = document.createElement('div');
        empty.style.cssText = 'font-size:11px;color:var(--tx2);';
        empty.innerText = 'No extra domains. Add one below.';
        customBox.appendChild(empty);
        return;
      }
      for (const d of custom) {
        const row = document.createElement('span');
        row.className = 'blocklist-chip';
        const label = document.createElement('span');
        label.innerText = d;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'blocklist-remove';
        btn.innerText = '✕';
        btn.title = `Remove ${d}`;
        btn.dataset.domain = d;
        btn.addEventListener('click', () => this.removeBlockedDomain(d));
        row.appendChild(label);
        row.appendChild(btn);
        customBox.appendChild(row);
      }
    }
  }

  setBlocklistStatus(msg) {
    const status = document.getElementById('blocklistStatus');
    if (status) status.innerText = msg || '';
  }

  async addBlockedDomain() {
    const input = document.getElementById('blocklistAddInput');
    const raw = input ? input.value : '';
    const res = addDomain(this.blocklistCustom, raw, DEFAULT_BLOCKED_DOMAINS);
    this.setBlocklistStatus(res.reason);
    if (!res.ok) return res;
    const saved = await this.persistBlocklist(res.list);
    if (!saved) {
      this.setBlocklistStatus('Could not save — storage write failed.');
      return { ok: false, reason: 'STORAGE_WRITE_FAILED' };
    }
    if (input) input.value = '';
    this.renderBlocklist();
    return res;
  }

  async removeBlockedDomain(domain) {
    const res = removeDomain(this.blocklistCustom, domain, DEFAULT_BLOCKED_DOMAINS);
    this.setBlocklistStatus(res.reason);
    if (!res.ok) return res;
    const saved = await this.persistBlocklist(res.list);
    if (!saved) {
      this.setBlocklistStatus('Could not save — storage write failed.');
      return { ok: false, reason: 'STORAGE_WRITE_FAILED' };
    }
    this.renderBlocklist();
    return res;
  }

  async save() {
    const webhook = document.getElementById("webhookUrl")?.value.trim();
    const apiKey = document.getElementById("settingsApiKey")?.value.trim() || "";
    const ownProductUrl = document.getElementById("ownProductUrl")?.value.trim() || "";
    const slackWebhookUrl = document.getElementById("slackWebhookUrl")?.value.trim() || "";
    const hubspotToken = document.getElementById("hubspotToken")?.value.trim() || "";

    this.userSettings.webhookUrl = webhook ?? "";
    this.userSettings.apiKey = apiKey;
    this.userSettings.ownProductUrl = ownProductUrl;
    this.userSettings.slackWebhookUrl = slackWebhookUrl;
    this.userSettings.hubspotToken = hubspotToken;
    this.userSettings.model = this.userSettings.model || GROQ_MODEL;

    await chrome.runtime.sendMessage({ type: "SAVE_USER_SETTINGS", settings: this.userSettings });

    const btn = document.getElementById("saveSettingsBtn");
    if (btn) {
      const orig = btn.innerText;
      btn.innerText = "✅ Saved!";
      setTimeout(() => btn.innerText = orig, 1500);
    }
  }

  async saveHubspotToken() {
    const input = document.getElementById("hubspotToken");
    const status = document.getElementById("hubspotStatus");
    this.userSettings.hubspotToken = (input?.value || "").trim();
    await chrome.runtime.sendMessage({ type: "SAVE_USER_SETTINGS", settings: this.userSettings });
    if (status) {
      if (this.userSettings.hubspotToken) {
        status.innerText = "✅ Token saved — “→ HubSpot” is now on every brief.";
      } else {
        status.innerText = "Token cleared.";
      }
      setTimeout(() => { if (status.innerText.startsWith("✅") || status.innerText === "Token cleared.") status.innerText = ""; }, 2500);
    }
  }

  async addKey() {    const input = document.getElementById("settingsApiKey");
    const key = (input?.value || "").trim();
    const status = document.getElementById("apiKeyStatus");
    if (!key) {
      if (status) status.innerText = "Enter a key first.";
      return;
    }
    this.userSettings.apiKey = key;
    this.userSettings.model = this.userSettings.model || GROQ_MODEL;
    await chrome.runtime.sendMessage({ type: "SAVE_USER_SETTINGS", settings: this.userSettings });
    if (status) {
      status.innerText = "✅ Key saved";
      setTimeout(() => { if (status.innerText === "✅ Key saved") status.innerText = ""; }, 2000);
    }
    await this.verifyConnection();
  }

  async verifyConnection() {
    const key = (document.getElementById("settingsApiKey")?.value.trim() || this.userSettings.apiKey || "").trim();
    const light = document.getElementById("connectionLight");
    const text = document.getElementById("connectionText");
    const setState = (state, msg) => {
      if (light) {
        if (state === true) { light.style.background = "#4fefd4"; light.style.boxShadow = "0 0 6px rgba(79,239,212,0.6)"; }
        else if (state === false) { light.style.background = "#ff6e8e"; light.style.boxShadow = "0 0 6px rgba(255,110,142,0.6)"; }
        else { light.style.background = "#ffc164"; light.style.boxShadow = "0 0 6px rgba(255,193,100,0.6)"; }
      }
      if (text) text.innerText = msg;
    };
    if (!key) { setState(false, "No key entered"); return; }
    setState(null, "Verifying…");

    const models = [GROQ_MODEL, "openai/gpt-oss-120b", "llama-3.3-70b-versatile"]
      .filter((m) => (m || "").trim()).filter((m, i, a) => a.indexOf(m) === i);

    for (const model of models) {
      try {
        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
          body: JSON.stringify({
            model,
            max_tokens: 4,
            temperature: 0,
            messages: [{ role: "user", content: "ping" }]
          })
        });
        if (res.ok) {
          if (model !== this.userSettings.model) {
            this.userSettings.model = model;
            await chrome.runtime.sendMessage({ type: "SAVE_USER_SETTINGS", settings: this.userSettings });
          }
          setState(true, "Connected ✓");
          return;
        }
        if (res.status === 401 || res.status === 403) { setState(false, "Invalid key"); return; }
        if (res.status === 402) { setState(false, "No credits / access"); return; }
        if (res.status === 429) { setState(false, "Rate limited"); return; }
      } catch (e) {
        setState(false, "Network error");
        return;
      }
    }
    setState(false, "Connection failed");
  }

  toggleApiKeyVisibility() {
    const input = document.getElementById("settingsApiKey");
    const btn = document.getElementById("toggleApiKeyBtn");
    if (!input || !btn) return;
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.innerText = show ? "🙈" : "👁";
    btn.title = show ? "Hide key" : "Show key";
  }

  async clearApiKey() {
    if (!confirm("Remove your saved Groq API key?")) return;
    const input = document.getElementById("settingsApiKey");
    if (input) input.value = "";
    this.userSettings.apiKey = "";
    await chrome.runtime.sendMessage({ type: "SAVE_USER_SETTINGS", settings: this.userSettings });

    const status = document.getElementById("apiKeyStatus");
    if (status) status.innerText = "Key removed.";

    const light = document.getElementById("connectionLight");
    const text = document.getElementById("connectionText");
    if (light) { light.style.background = "var(--tx3)"; light.style.boxShadow = "none"; }
    if (text) text.innerText = "Not connected";
  }

  // Managed backend: starts a Stripe Checkout session (subscription) for this
  // extension install. The webhook grants Pro on successful payment.
  async startCheckout() {
    const extensionId = chrome.runtime.id;
    try {
      const res = await fetch('https://atom-ai-eight.vercel.app/api/create-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extensionId })
      });
      const data = await res.json();
      if (data.url) {
        await chrome.tabs.create({ url: data.url });
      } else {
        window.showToast?.('Could not start checkout. Try again.', 'error');
      }
    } catch (e) {
      window.showToast?.('Checkout error: ' + e.message, 'error');
    }
  }

  initEventListeners() {
    document.getElementById("saveSettingsBtn")?.addEventListener("click", () => this.save());
    // CRM (F7): saving the token alone should not require the full Save button.
    document.getElementById("saveHubspotBtn")?.addEventListener("click", () => this.saveHubspotToken());
    document.getElementById("toggleApiKeyBtn")?.addEventListener("click", () => this.toggleApiKeyVisibility());
    document.getElementById("addKeyBtn")?.addEventListener("click", () => this.addKey());
    document.getElementById("verifyKeyBtn")?.addEventListener("click", () => this.verifyConnection());
    document.getElementById("clearApiKeyBtn")?.addEventListener("click", () => this.clearApiKey());
    document.getElementById("upgradeBtn")?.addEventListener("click", () => this.startCheckout());
    document.getElementById("resetExtensionBtn")?.addEventListener("click", () => this.resetExtension());
    document.getElementById("refreshDebugLogBtn")?.addEventListener("click", () => this.refreshDebugLog());
    document.getElementById("clearDebugLogBtn")?.addEventListener("click", () => this.clearDebugLog());
    document.getElementById("privacyLink")?.addEventListener("click", (e) => {
      e.preventDefault();
      try { chrome.tabs.create({ url: chrome.runtime.getURL("PRIVACY.md") }); }
      catch { window.open(chrome.runtime.getURL("PRIVACY.md"), "_blank"); }
    });
    document.getElementById("proModalClose")?.addEventListener("click", () => {
      const m = document.getElementById("proModal");
      if (m) m.style.display = "none";
    });
    document.getElementById("proNotifyBtn")?.addEventListener("click", () => this.handleProNotify());

    // Auto Task domain blocklist editor
    document.getElementById("blocklistAddBtn")?.addEventListener("click", () => this.addBlockedDomain());
    document.getElementById("blocklistAddInput")?.addEventListener("keydown", (e) => {
      if (e && e.key === "Enter") this.addBlockedDomain();
    });

    // Wire settings screen navigation
    document.getElementById("goSettings")?.addEventListener("click", () => this.load());
  }

  async resetExtension() {
    if (!confirm("This will erase all settings, notes, history, and data. Continue?")) return;
    await chrome.storage.local.clear();
    await chrome.storage.session.clear().catch(() => {});
    window.location.reload();
  }

  async refreshDebugLog() {
    const box = document.getElementById("debugLogBox");
    if (!box) return;
    const res = await chrome.storage.local.get(["debugLogs"]);
    const logs = Array.isArray(res?.debugLogs) ? res.debugLogs : [];
    if (!logs.length) {
      box.innerText = "No debug logs yet.";
      return;
    }
    box.innerText = logs.slice(0, 60).map((item) => {
      const ts = item.ts || "";
      const scope = item.scope || "general";
      const level = item.level || "error";
      const msg = item.message || "";
      return `[${ts}] [${scope}] [${level}] ${msg}`;
    }).join("\n");
  }

  async clearDebugLog() {
    await chrome.storage.local.set({ debugLogs: [] });
    const box = document.getElementById("debugLogBox");
    if (box) box.innerText = "Debug log cleared.";
    await Utils.writeDebugLog("Debug log cleared", "info");
  }

  async handleProNotify() {
    const emailInput = document.getElementById("proEmailInput");
    const email = emailInput?.value.trim();
    if (!email || !email.includes("@")) {
      alert("Please enter a valid email address.");
      return;
    }
    await chrome.storage.local.set({ proNotifyEmail: email });
    const btn = document.getElementById("proNotifyBtn");
    if (btn) {
      btn.innerText = "Notified!";
      btn.disabled = true;
      setTimeout(() => {
        btn.innerText = "Notify Me";
        btn.disabled = false;
      }, 2000);
    }
    const modal = document.getElementById("proModal");
    if (modal) modal.style.display = "none";
  }
}