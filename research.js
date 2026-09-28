// research.js
import { Utils } from './utils.js';
import { EmailDrafter } from './email-drafter.js';
import { pushBriefToHubSpot, buildNoteBody } from './hubspot.js';

export class Research {
  constructor(ai, userSettings) {
    this.ai = ai;
    this.userSettings = userSettings;
    this.emailDrafter = new EmailDrafter(ai);
    this.selectedCompanyType = "sales";
    this.initEventListeners();
  }

  getResultEl() {
    return document.getElementById("globalResult") || document.getElementById("result");
  }

  setResultText(text) {
    const resultEl = this.getResultEl();
    if (!resultEl) return;
    resultEl.style.display = "block";
    resultEl.innerText = text;
  }

  showProgress(show, steps = []) {
    const panel = document.getElementById("researchProgress");
    const stepsEl = document.getElementById("progressSteps");
    const bar = document.getElementById("progressBarFill");
    const cancelBtn = document.getElementById("cancelTask");
    if (!panel) return;
    panel.style.display = show ? "block" : "none";
    if (cancelBtn) cancelBtn.style.display = show ? "inline-flex" : "none";
    if (stepsEl) {
      stepsEl.innerHTML = "";
      steps.forEach((step) => {
        const div = document.createElement("div");
        div.innerText = step;
        stepsEl.appendChild(div);
      });
    }
    if (bar) bar.style.width = show ? "20%" : "0%";
  }

  setProgress(stepText, progressPercent) {
    const stepsEl = document.getElementById("progressSteps");
    const bar = document.getElementById("progressBarFill");
    if (stepsEl && stepText) {
      const div = document.createElement("div");
      div.innerText = stepText;
      stepsEl.appendChild(div);
    }
    if (bar && typeof progressPercent === "number") {
      bar.style.width = `${Math.max(0, Math.min(100, progressPercent))}%`;
    }
  }

  initEventListeners() {
    // Research buttons (Person / Deep / Market) and the battle card are wired in
    // popup.js. Wiring them here as well would double-fire every click, so only the
    // chip wiring (which popup.js does not touch) lives here.

    // Type chips
    document.querySelectorAll(".company-type-chip").forEach(chip => {
      chip.addEventListener("click", () => {
        document.querySelectorAll(".company-type-chip").forEach(c => c.classList.remove("active"));
        chip.classList.add("active");
        this.selectedCompanyType = chip.dataset.type;
      });
    });

    // Page analysis chips
    document.querySelectorAll(".intel-chip").forEach(chip => {
      chip.addEventListener("click", () => this.pageAnalysis(chip.dataset.action));
    });
  }

  async runCompanyResearch() {
    const company = document.getElementById("companyName").value.trim();
    if (!company) return alert("Enter a company name or URL");
    const btn = document.getElementById("companyResearch");
    btn.disabled = true;
    btn.innerText = "🔄 Researching...";
    try {
      this.showProgress(true, ["Starting company research..."]);
      // The button is disabled for the whole run, so its label is the only live
      // feedback the user has. Restored in the finally block below.
      const status = (msg) => { try { btn.innerText = msg; } catch (e) {} };
      const report = await this.salesResearch(company, status);
      const resultEl = this.getResultEl();
      resultEl.style.display = "block";
      resultEl.innerText = report;
      this.showReportActions("globalResult", company, report);
      await this.saveToHistory(company, report, "company");
    } catch (e) {
      this.getResultEl().innerText = "⚠️ Research failed: " + e.message;
    } finally {
      this.showProgress(false);
      btn.disabled = false;
      btn.innerText = "⚡ Generate Sales Brief";
    }
  }

  async salesResearch(company, onProgress) {
    // Live status for a call that can spend 10-40s gathering sources before it
    // even reaches the model. Optional: callers that do not pass it are
    // unaffected, and every write is guarded because the popup can be closed
    // while a run is still in flight.
    const status = (msg) => { try { onProgress?.(msg); } catch (e) {} };

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeHost = activeTab?.url ? new URL(activeTab.url).hostname.replace("www.", "") : "";
    const companySlug = company.toLowerCase().replace(/[^a-z0-9]/g, "");
    const isOnCompanySite = activeHost.includes(companySlug.substring(0, 5)) && Utils.isInjectableTab(activeTab);

    const fetchPageText = async (url) => {
      try {
        const tab = await chrome.tabs.create({ url, active: false });
        const text = await Promise.race([Utils.getPageText(tab.id), new Promise(r => setTimeout(() => r(""), 8000))]);
        await chrome.tabs.remove(tab.id);
        return text || "";
      } catch { return ""; }
    };

    const fetchGoogleSnippets = async (query) => {
      try {
        const url = "https://www.google.com/search?q=" + encodeURIComponent(query);
        const source = await Utils.openAndReadUrl(url, { active: false, maxLength: 5000, waitMs: 7000 });
        return source.text || "";
      } catch { return ""; }
    };

    const fetchCompanySite = async () => {
      if (isOnCompanySite) {
        return await Utils.getPageText(activeTab.id);
      }
      let searchText = "";
      let links = [];
      let tab = null;
      try {
        tab = await chrome.tabs.create({
          url: "https://www.google.com/search?q=" + encodeURIComponent(company + " official website about"),
          active: false
        });
        await Utils.waitForTab(tab.id, 7000);
        await Utils.wait(800);
        const [pageText, pageLinks] = await Promise.all([
          Utils.getPageText(tab.id, 5000),
          Utils.getGoogleLinks(tab.id)
        ]);
        searchText = pageText || "";
        links = pageLinks || [];
      } catch {
        searchText = "";
        links = [];
      } finally {
        if (tab?.id) {
          try { await chrome.tabs.remove(tab.id); } catch (e) {}
        }
      }
      if (links[0]) return await fetchPageText(links[0]);
      return searchText;
    };

    status("🔍 Reading company website…");
    const websiteData = await (async () => {
      if (isOnCompanySite) return await Utils.getPageText(activeTab.id);
      return await fetchCompanySite();
    })();

    const googleQueries = [
      company + " site:techcrunch.com OR site:reuters.com OR site:bloomberg.com OR site:forbes.com 2025",
      '"' + company + '" CEO OR founder OR "head of" OR "VP of" site:linkedin.com OR site:crunchbase.com',
      company + " reviews biggest problem OR main issue OR negative site:g2.com OR site:reddit.com OR site:glassdoor.com",
      company + " competitors alternatives vs site:g2.com OR site:crunchbase.com OR site:capterra.com"
    ];
    status("🔍 Searching news, leadership, complaints, competitors…");
    const [newsData, peopleData, painData, compData] = await Utils.mapWithConcurrency(
      googleQueries,
      (query) => fetchGoogleSnippets(query),
      2
    );

    const allData = `=== COMPANY WEBSITE ===\n${websiteData.substring(0, 2500)}\n\n=== NEWS ===\n${newsData.substring(0, 2000)}\n\n=== LEADERSHIP ===\n${peopleData.substring(0, 1500)}\n\n=== PAIN SIGNALS ===\n${painData.substring(0, 1500)}\n\n=== COMPETITORS ===\n${compData.substring(0, 1500)}`;

    const typePrompts = {
      sales: this.buildSalesPrompt(company, allData),
      full: this.buildFullPrompt(company, allData),
      competitor: this.buildCompetitorPrompt(company, allData),
      investor: this.buildInvestorPrompt(company, allData)
    };
    // The 5th argument is onProgress (ai.js chat(prompt, maxTokens, temperature,
    // retries, onProgress)); from here the button reports the request itself.
    // Only handed over when the caller actually wants it, so a caller with no
    // progress sink does not get a no-op closure invoked on every stage.
    const report = await this.ai.chat(typePrompts[this.selectedCompanyType], 1500, 0.3, 2, onProgress ? status : undefined);
    status("✅ Done");
    return report;
  }

  buildSalesPrompt(company, data) {
    return `You are a senior B2B sales intelligence analyst. Write a sales brief for ${company}. Use the data below. Format exactly as:

⚡ SALES BRIEF — ${company.toUpperCase()}
🏢 WHAT THEY DO
💰 COMPANY SNAPSHOT
🔥 THEIR PAIN POINTS
📰 RECENT NEWS
👤 WHO TO CALL
⚔️ THEIR COMPETITORS
🎯 OPENING LINE
⚠️ DO NOT REFERENCE
📊 CONFIDENCE: [X/100]

DATA:
${data}`;
  }

  buildFullPrompt(company, data) {
    return `You are a senior business intelligence analyst. Write a company dossier for ${company}. Use the data below. Format exactly as:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🗂️ COMPANY INTELLIGENCE REPORT — ${company.toUpperCase()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🏢 WHAT THEY DO
📊 COMPANY SNAPSHOT
🛠️ PRODUCTS & PRICING
👥 LEADERSHIP
📈 GROWTH SIGNALS (Last 90 days)
⚔️ COMPETITIVE LANDSCAPE
📰 RECENT NEWS
⚠️ RISKS & RED FLAGS
🔮 12-MONTH OUTLOOK
📊 RESEARCH CONFIDENCE: [X/100]

DATA:
${data}`;
  }

  buildCompetitorPrompt(company, data) {
    return `You are a competitive intelligence analyst. Write a competitor analysis for ${company}. Use the data below. Format exactly as:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚔️ COMPETITIVE INTEL — ${company.toUpperCase()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🏆 MARKET POSITION
💪 GENUINE STRENGTHS
😟 REAL WEAKNESSES
⚔️ THEIR TOP COMPETITORS
🎯 HOW TO WIN AGAINST ${company.toUpperCase()}
😤 OBJECTIONS THEY CANNOT ANSWER WELL
💡 MARKET GAPS
📊 RESEARCH CONFIDENCE: [X/100]

DATA:
${data}`;
  }

  buildInvestorPrompt(company, data) {
    return `You are a VC analyst. Write an investor brief for ${company}. Use the data below. Format exactly as:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 INVESTOR BRIEF — ${company.toUpperCase()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚡ VERDICT
📌 INVESTMENT THESIS
💰 FUNDING & FINANCIALS
📈 GROWTH SIGNALS
🏆 COMPETITIVE MOAT
🌍 MARKET OPPORTUNITY
⚠️ KEY RISKS
🚪 EXIT SCENARIOS
📊 RESEARCH CONFIDENCE: [X/100]

DATA:
${data}`;
  }

  async runPersonResearch() {
    const person = document.getElementById("personName").value.trim();
    if (!person) return alert("Enter a person name");
    const btn = document.getElementById("personResearchBtn");
    btn.disabled = true;
    btn.innerText = "🔄 Researching...";
    try {
      const resultEl = this.getResultEl();
      resultEl.style.display = "block";
      resultEl.innerText = "🔄 Finding information...";
      // Label is the only live feedback while the model works; restored in finally.
      const status = (msg) => { try { btn.innerText = msg; } catch (e) {} };
      const [bioData, newsData, linkedinData] = await Promise.all([
        Utils.googleResearch(person + " biography career background"),
        Utils.googleResearch(person + " interview quote opinion 2025"),
        Utils.googleResearch('"' + person + '" site:linkedin.com OR site:crunchbase.com OR site:twitter.com')
      ]);
      const combined = [bioData, newsData, linkedinData].join("\n\n").substring(0, 6000);
      const personReport = await this.ai.chat(`You are a sales intelligence analyst. Prepare a pre-meeting brief on ${person}. Be specific and useful. Use the data below. Format exactly as:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 PERSON BRIEF — ${person.toUpperCase()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🧑 WHO THEY ARE
💼 CAREER PATTERN
🎯 WHAT DRIVES THEM
💬 HOW TO APPROACH
🔑 3 SPECIFIC TALKING POINTS
❓ 3 SMART QUESTIONS TO ASK
📰 RECENT ACTIVITY
📊 RESEARCH CONFIDENCE: [X/100]

DATA:
${combined}`, 600, 0.3, 2, status);
      status("✅ Done");
      resultEl.innerText = personReport;
      this.showReportActions("globalResult", person, personReport);
      await this.saveToHistory(person, personReport, "person");
    } catch (e) {
      this.getResultEl().innerText = "⚠️ Research failed: " + e.message;
    } finally {
      btn.disabled = false;
      // Restore the exact static label from popup.html — a lookalike with an
      // emoji prefix would visibly change the button after the first run.
      btn.innerText = "Research Person";
    }
  }

  async deepResearch() {
    const topic = document.getElementById("deepTopic").value.trim();
    if (!topic) return alert("Enter a research topic");
    const btn = document.getElementById("deepResearchBtn");
    btn.disabled = true;
    btn.innerText = "🔄 Researching...";
    try {
      const resultEl = this.getResultEl();
      resultEl.style.display = "block";
      this.showProgress(true, ["Searching sources..."]);
      resultEl.innerText = "🔄 Searching multiple sources...";
      const combined = await Utils.googleResearch(topic + " 2025");
      this.setProgress("Analyzing source data...", 55);
      // Label is the only live feedback while the model works; restored in finally.
      const status = (msg) => { try { btn.innerText = msg; } catch (e) {} };
      const report = await this.ai.chat(`You are a professional business research analyst. Write a structured research report on: "${topic}". Use the data below. Format exactly as:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ATOM.AI RESEARCH REPORT
Topic: ${topic}
Date: ${new Date().toDateString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔍 OVERVIEW
📊 KEY FACTS & DATA
📰 RECENT DEVELOPMENTS
⚖️ DIFFERENT PERSPECTIVES
🔮 OUTLOOK & IMPLICATIONS
📚 SOURCES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

DATA:
${combined.substring(0, 8000)}`, 600, 0.3, 2, status);
      this.setProgress("Finalizing report...", 100);
      status("✅ Done");
      resultEl.innerText = report;
      this.showReportActions("globalResult", topic, report);
      await this.saveToHistory(topic, report, "deep");
    } catch (e) {
      this.getResultEl().innerText = "⚠️ Research failed: " + e.message;
    } finally {
      this.showProgress(false);
      btn.disabled = false;
      btn.innerText = "Deep Research";
    }
  }

  async multiTabResearch() {
    const topic = document.getElementById("intelTopic")?.value.trim() || document.getElementById("deepTopic")?.value.trim() || '';
    if (!topic) return alert("Enter a topic");
    const btn = document.getElementById("intelMultiTab");
    if (btn) { btn.disabled = true; btn.innerText = "Queuing…"; }
    const resultEl = this.getResultEl();
    if (resultEl) { resultEl.style.display = "block"; resultEl.innerText = "Queuing multi-source job… You can close popup."; }
    try {
      const urls = [
        "https://en.wikipedia.org/wiki/" + encodeURIComponent(topic),
        "https://news.google.com/search?q=" + encodeURIComponent(topic),
        "https://www.google.com/search?q=" + encodeURIComponent(topic)
      ];
      const res = await chrome.runtime.sendMessage({ type: 'JOB_CREATE', jobType: 'multitab', payload: { topic, urls } });
      if (res?.error) {
        if (resultEl) resultEl.innerText = "Error: " + res.error;
        return;
      }
      if (resultEl) resultEl.innerText = `Queued job ${res.jobId || res.job?.id}. Track progress in Jobs on Home. Closing popup is safe.`;
    } catch (e) {
      if (resultEl) resultEl.innerText = "Research failed: " + e.message;
    } finally {
      if (btn) { btn.disabled = false; btn.innerText = "Multi-Source"; }
    }
  }
  async compare() {
    const topic = document.getElementById("intelTopic").value.trim();
    if (!topic) return alert("Enter two things to compare e.g. 'Notion vs Airtable'");
    const btn = document.getElementById("intelCompare");
    btn.disabled = true;
    btn.innerText = "🔄 Comparing...";
    try {
      const resultEl = this.getResultEl();
      resultEl.style.display = "block";
      resultEl.innerText = "🔄 Researching both sides...";
      const combined = await Utils.googleResearch(topic);
      const report = await this.ai.chat(`Compare: "${topic}"\n\nResearch:\n${combined.substring(0, 6000)}\n\nFormat:\n📋 Overview\n⚡ Key Differences\n✅ Option A — Pros/Cons\n✅ Option B — Pros/Cons\n🏆 Verdict`);
      resultEl.innerText = report;
      this.showReportActions("globalResult", topic, report);
      await this.saveToHistory(topic, report, "compare");
    } catch (e) {
      this.getResultEl().innerText = "⚠️ Compare failed: " + e.message;
    } finally {
      btn.disabled = false;
      btn.innerText = "⚖️ Compare";
    }
  }

  async marketSize() {
    const topic = document.getElementById("marketTopic").value.trim();
    if (!topic) return alert("Enter an industry or market");
    const btn = document.getElementById("marketSizeBtn");
    btn.disabled = true;
    btn.innerText = "🔄 Researching...";
    try {
      const resultEl = this.getResultEl();
      resultEl.style.display = "block";
      resultEl.innerText = "🔄 Analyzing market size...";
      const combined = await Utils.googleResearch(topic + " market size TAM revenue 2025");
      const report = await this.ai.chat(`Market size analysis for: "${topic}"\n\nData:\n${combined.substring(0, 8000)}\n\nProvide:\n📊 Total Market Size (TAM)\n📈 Growth Rate (CAGR)\n🌍 Geographic Breakdown\n💰 Revenue Potential\n🔮 2025-2030 Projections\n📚 Sources`);
      resultEl.innerText = report;
      this.showReportActions("globalResult", topic, report);
      await this.saveToHistory(topic, report, "market");
    } catch (e) {
      this.getResultEl().innerText = "⚠️ Market size failed: " + e.message;
    } finally {
      btn.disabled = false;
      btn.innerText = "📊 Market Size";
    }
  }

  async marketTrends() {
    const topic = document.getElementById("marketTopic").value.trim();
    if (!topic) return alert("Enter an industry");
    const btn = document.getElementById("marketTrendsBtn");
    btn.disabled = true;
    btn.innerText = "🔄 Analyzing...";
    try {
      const resultEl = this.getResultEl();
      resultEl.style.display = "block";
      resultEl.innerText = "🔄 Finding trends...";
      const combined = await Utils.googleResearch(topic + " trends 2025 growth emerging");
      const report = await this.ai.chat(`Market trends for: "${topic}"\n\nData:\n${combined.substring(0, 8000)}\n\nProvide:\n📈 Top 5 Emerging Trends\n🔄 Disruptions Happening Now\n⚠️ Threats & Risks\n💡 Opportunities\n🔮 What's Next`);
      resultEl.innerText = report;
      this.showReportActions("globalResult", topic, report);
      await this.saveToHistory(topic, report, "market");
    } catch (e) {
      this.getResultEl().innerText = "⚠️ Market trends failed: " + e.message;
    } finally {
      btn.disabled = false;
      btn.innerText = "📈 Trends";
    }
  }

  async marketPlayers() {
    const topic = document.getElementById("marketTopic").value.trim();
    if (!topic) return alert("Enter an industry");
    const btn = document.getElementById("marketPlayersBtn");
    btn.disabled = true;
    btn.innerText = "🔄 Finding...";
    try {
      const resultEl = this.getResultEl();
      resultEl.style.display = "block";
      resultEl.innerText = "🔄 Finding key players...";
      const combined = await Utils.googleResearch(topic + " top companies leaders market share 2025");
      const report = await this.ai.chat(`Key players in: "${topic}"\n\nData:\n${combined.substring(0, 8000)}\n\nProvide:\n🏆 Top 5-10 Companies\n💰 Estimated Market Share\n📍 HQ & Funding\n⚡ Competitive Advantages\n🆕 Emerging Challengers`);
      resultEl.innerText = report;
      this.showReportActions("globalResult", topic, report);
      await this.saveToHistory(topic, report, "market");
    } catch (e) {
      this.getResultEl().innerText = "⚠️ Key players failed: " + e.message;
    } finally {
      btn.disabled = false;
      btn.innerText = "🏆 Key Players";
    }
  }

  async pageAnalysis(action) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const text = await Utils.getPageText(tab.id);
    const resultEl = this.getResultEl();
    if (!resultEl) return;
    resultEl.style.display = "block";
    resultEl.innerText = "🔄 Analyzing...";

    const prompts = {
      factcheck: `Fact-check this page. Mark each claim:\n✅ Likely true\n⚠️ Unverified\n❌ Likely false/misleading\n\nBe specific with evidence.\n\nPage:\n${text.substring(0, 3000)}`,
      bias: `Analyze bias on this page:\n- Political direction (left/center/right)\n- Emotional language %\n- Missing perspectives\n- Loaded/manipulative words\n- Overall bias score /10\n\nPage:\n${text.substring(0, 3000)}`,
      scam: `Analyze this website for scam signals:\n- Trust signals present/missing\n- Pressure tactics\n- Unrealistic claims\n- Missing legitimacy info\n- Red flags\n- Scam probability % with explanation\n\nPage:\n${text.substring(0, 3000)}`,
      darkpattern: `Find dark patterns (deceptive design) on this page:\n- Fake urgency/scarcity\n- Hidden costs\n- Pre-checked boxes\n- Misleading buttons\n- Forced continuity\nList each found with explanation.\n\nPage:\n${text.substring(0, 3000)}`,
      privacy: `Privacy audit of this website:\n- Data likely collected\n- Tracking methods\n- Third-party scripts\n- Cookie consent issues\n- Data sharing risks\n- Privacy score /10\n\nPage:\n${text.substring(0, 3000)}`,
      sentiment: `Sentiment analysis of this page:\n- Overall sentiment (positive/neutral/negative)\n- Tone (formal/casual/aggressive/friendly)\n- Emotion detected\n- Key sentiment drivers\n- Score /10 from negative to positive\n\nPage:\n${text.substring(0, 3000)}`,
    };

    const result = await this.ai.chat(prompts[action]);
    resultEl.innerText = result;
    this.showReportActions("globalResult", action + " analysis", result);
    await this.saveToHistory(action + " — " + document.title, result, "page");
  }

  showReportActions(containerId, topic, text) {
    const container = this.getResultEl();
    if (!container) return;
    document.dispatchEvent(new CustomEvent("atom:result-meta", {
      detail: {
        area: "intel",
        text,
        signal: text && text.length > 1200 ? "Rich brief" : "Focused brief"
      }
    }));
    // Remove old action bar if exists
    const old = container.parentNode.querySelector(".report-action-bar");
    if (old) old.remove();

    const bar = document.createElement("div");
    bar.className = "report-action-bar";
    bar.style.cssText = "display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;";
    bar.innerHTML = `
      <button class="btn btn-g bsm" id="reportCopy_${containerId}">📋 Copy</button>
      <button class="btn btn-g bsm" id="reportSave_${containerId}">💾 Save</button>
      <button class="btn btn-t bsm" id="reportEmail_${containerId}">✉️ Draft Email</button>
      <button class="btn btn-t bsm" id="reportPDF_${containerId}">📄 Export PDF</button>
      <button class="btn btn-g bsm" id="reportTxt_${containerId}">📝 Export TXT</button>
      <button class="btn btn-g bsm" id="reportSheets_${containerId}">📊 To Sheets</button>
      <button class="btn btn-t bsm" id="reportHubspot_${containerId}">→ HubSpot</button>
    `;
    container.parentNode.insertBefore(bar, container.nextSibling);

    document.getElementById(`reportEmail_${containerId}`)?.addEventListener("click", () => {
      // The on-screen text IS the ingredient list (pains, news, people) — the
      // drafter slices the dense sections itself before calling the model.
      this.emailDrafter.open(containerId, topic, text);
    });
    document.getElementById(`reportHubspot_${containerId}`)?.addEventListener("click", () => {
      this.openHubspotForm(containerId, topic, text);
    });

    document.getElementById(`reportCopy_${containerId}`).addEventListener("click", async () => {
      await navigator.clipboard.writeText(text);
      const btn = document.getElementById(`reportCopy_${containerId}`);
      btn.innerText = "✅ Copied!";
      setTimeout(() => btn.innerText = "📋 Copy", 1200);
    });
    document.getElementById(`reportSave_${containerId}`).addEventListener("click", async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const d = await chrome.storage.local.get(["notes"]);
      const notes = d.notes || [];
      notes.push({ text, savedAt: new Date().toLocaleString(), url: tab?.url || "", topic });
      const saveResult = await Utils.setBoundedStorageArray("notes", notes, {
        maxItems: 200,
        minItems: 25,
        trimStep: 10
      });
      if (!saveResult.ok) {
        await Utils.writeDebugLog(`Failed to save report note: ${saveResult.error?.message || "quota error"}`, "warn");
      } else if (saveResult.trimmed > 0) {
        await Utils.writeDebugLog(`Report notes trimmed by ${saveResult.trimmed} item(s) to stay within storage quota.`, "warn");
      }
      const btn = document.getElementById(`reportSave_${containerId}`);
      btn.innerText = "✅ Saved!";
      setTimeout(() => btn.innerText = "💾 Save", 1200);
    });
    document.getElementById(`reportPDF_${containerId}`).addEventListener("click", () => {
      this.exportReportAsPDF(topic, text);
    });
    document.getElementById(`reportTxt_${containerId}`).addEventListener("click", () => {
      const blob = new Blob([text], { type: "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "atom_" + topic.replace(/\s+/g, "_").toLowerCase() + ".txt";
      a.click();
    });
    document.getElementById(`reportSheets_${containerId}`).addEventListener("click", async () => {
      const tsv = Utils.textToTSV(text);
      const out = await Utils.tryWriteToGoogleSheets(tsv);
      alert(out.ok ? "Prepared Google Sheets export." : out.reason);
    });
  }

  async runBattleCard() {
    const urls = Array.from(document.querySelectorAll(".battle-url"))
      .map((input) => input.value.trim())
      .filter(Boolean)
      .slice(0, 5);
    if (!urls.length) return alert("Enter at least one competitor URL.");
    const out = this.getResultEl();
    if (!out) return;
    document.getElementById("battleActions")?.remove();
    out.style.display = "block";
    out.innerText = "Queuing battle card in service worker... You can close popup — it runs in background.";
    try {
      const res = await chrome.runtime.sendMessage({ type: 'JOB_CREATE', jobType: 'battlecard', payload: { urls } });
      if (res?.error) { out.innerText = "Error: " + res.error; return; }
      const jobId = res.jobId || res.job?.id;
      out.innerText = `Job ${jobId} queued. Track progress in Jobs card below. Closing popup is safe.`;
      // poll for completion to show result if popup stays open
      (async () => {
        for (let i=0;i<90;i++) {
          await new Promise(r=>setTimeout(r,1000));
          const data = await chrome.storage.local.get(['jobs']);
          const job = (data.jobs||[]).find(j=>j.id===jobId);
          if (!job) continue;
          if (job.status==='done' && job.resultRef) { out.innerText = job.resultRef; this.attachBattleActions(job.resultRef); break; }
          if (job.status==='failed') {
            const txt = job.partialResult || job.resultRef || `Failed: ${job.error||'unknown'}\n${job.successSummary||''}`;
            out.innerText = txt;
            if (job.partialResult || job.resultRef) this.attachBattleActions(job.partialResult||job.resultRef);
            break;
          }
          if (job.status==='canceled') { out.innerText = 'Job canceled.'; break; }
        }
      })();
    } catch (e) {
      out.innerText = "Battle card failed: " + e.message;
    }
  }

  async battleCard(urls) {
    const competitorUrls = Array.isArray(urls) ? urls.filter(Boolean).slice(0, 5) : [];
    if (!competitorUrls.length) throw new Error("Enter at least one competitor URL.");
    // Phase 5: delegate to service worker so popup can close; poll for result and return it (keeps old callers working)
    try {
      const res = await chrome.runtime.sendMessage({ type: 'JOB_CREATE', jobType: 'battlecard', payload: { urls: competitorUrls } });
      if (res?.error) throw new Error(res.error);
      const jobId = res.jobId || res.job?.id;
      // poll storage for completion (max 3 min)
      for (let i=0;i<180;i++) {
        await new Promise(r=>setTimeout(r,1000));
        const data = await chrome.storage.local.get(['jobs']);
        const job = (data.jobs||[]).find(j=>j.id===jobId);
        if (!job) continue;
        if (job.status==='done' && job.resultRef) return job.resultRef;
        if (job.status==='failed') {
          if (job.partialResult) return job.partialResult;
          throw new Error(job.error || 'Battle card failed');
        }
        if (job.status==='canceled') throw new Error('Task canceled.');
      }
      throw new Error('Battle card timed out');
    } catch (e) {
      // fallback to direct pipeline if worker unavailable (e.g., tests)
      if (String(e.message).includes('Receiving end does not exist') || String(e.message).includes('Extension context invalidated')) {
        // direct fallback (no SW) — keep old logic for resilience
        this.showProgress(true, [`Preparing battle card for ${competitorUrls.length} competitor(s)... (direct fallback)`]);
        try {
          const structuredData = [];
          for (let i=0;i<competitorUrls.length;i++) {
            const url = competitorUrls[i];
            const domain = (()=>{ try{return new URL(url).hostname.replace(/^www\./i,'');}catch{return `tab ${i+1}`;}})();
            this.setProgress(`Processing ${i+1}/${competitorUrls.length}: ${domain} — extracting data...`, Math.round(((i+1)/competitorUrls.length)*80));
            const data = await Utils.collectStructuredPageData(url, this.ai);
            structuredData.push(data);
          }
          this.setProgress("Generating comparison table...", 92);
          const prompt = `Create a markdown comparison table for these competitors using the structured data below.\nColumns: Company | Pricing | Key Features | Target Audience | Recent News\n- Use the company/domain name for Company\n- Keep each cell concise and decision-useful\n- Return ONLY the markdown table, no extra text\n\nDATA:\n${JSON.stringify(structuredData, null, 2)}`;
          const table = await this.ai.chat(prompt, 1400);
          this.setProgress("Battle card ready.", 100);
          return table;
        } finally { this.showProgress(false); }
      }
      throw e;
    }
  }

  markdownTableToObjects(markdownTable) {
    const lines = String(markdownTable || "").split("\n").map((line) => line.trim()).filter((line) => /^\|/.test(line));
    if (lines.length < 2) return [];
    const headers = lines[0].replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    return lines.slice(2).map((line) => {
      const cells = line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const obj = {};
      headers.forEach((header, index) => {
        obj[header || `Column ${index + 1}`] = cells[index] || "";
      });
      return obj;
    }).filter((row) => Object.values(row).some(Boolean));
  }

  // Phase 9: funnel — "shared" event (copy/export of a battle card). Fire-and-forget.
  _trackShare(surface) {
    try {
      chrome.runtime.sendMessage({ type: 'TRACK_EVENT', event: 'shared', props: { surface } });
    } catch (e) {}
  }

  attachBattleActions(markdownTable) {
    const output = this.getResultEl();
    if (!output) return;
    let bar = document.getElementById("battleActions");
    if (bar) bar.remove();
    bar = document.createElement("div");
    bar.id = "battleActions";
    bar.className = "report-action-bar";
    bar.innerHTML = `
      <button class="btn btn-g bsm" id="copyBattleTable">📋 Copy as Table</button>
      <button class="btn btn-t bsm" id="copyBattleSheets">📊 Export to Sheets</button>
      <button class="btn btn-g bsm" id="copyBattlePdf">📄 Export PDF</button>
      <button class="btn btn-g bsm" id="copyBattleJson">📋 JSON</button>
      <button class="btn btn-g bsm" id="saveBattleTable">💾 Save to History</button>
    `;
    output.parentNode.insertBefore(bar, output.nextSibling);
    document.getElementById("copyBattleTable")?.addEventListener("click", async () => {
      this._trackShare("copy-table");
      await navigator.clipboard.writeText(markdownTable);
      const btn = document.getElementById("copyBattleTable");
      if (btn) {
        btn.innerText = "✅ Copied!";
        setTimeout(() => { btn.innerText = "📋 Copy as Table"; }, 1200);
      }
    });
    document.getElementById("copyBattleSheets")?.addEventListener("click", async () => {
      this._trackShare("sheets");
      const tsv = markdownTable
        .split("\n")
        .filter((line) => /^\|/.test(line) && !/^-+\|/.test(line.replace(/\s/g, "")))
        .map((line) => line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).join("\t"))
        .join("\n");
      const res = await Utils.tryWriteToGoogleSheets(tsv);
      alert(res?.reason || (res?.ok ? "Prepared Google Sheets export." : "Unable to export to Sheets."));
    });
    document.getElementById("copyBattlePdf")?.addEventListener("click", () => {
      this._trackShare("pdf");
      this.exportReportAsPDF("Competitor Battle Card", markdownTable);
    });
    document.getElementById("copyBattleJson")?.addEventListener("click", async () => {
      this._trackShare("json");
      try {
        const objects = this.markdownTableToObjects(markdownTable);
        if (!objects || objects.length === 0) {
          alert("No valid data to copy as JSON.");
          return;
        }
        const json = JSON.stringify(objects, null, 2);
        await navigator.clipboard.writeText(json);
        alert("JSON copied to clipboard!");
      } catch (e) {
        alert("Failed to parse table as JSON. Copying raw text instead.");
        await navigator.clipboard.writeText(markdownTable);
      }
    });
    document.getElementById("saveBattleTable")?.addEventListener("click", async () => {
      await this.saveToHistory("Competitor Battle Card", markdownTable, "compare");
      const btn = document.getElementById("saveBattleTable");
      btn.innerText = "✅ Saved!";
      setTimeout(() => btn.innerText = "💾 Save to History", 1200);
    });
  }

  exportReportAsPDF(topic, content) {
    const html = `<!DOCTYPE html>
<html>
<head>
  <title>Atom.AI — ${topic}</title>
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
    <h1>${topic}</h1>
    <div class="date">Generated: ${new Date().toLocaleString()}</div>
  </div>
  <pre>${content.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>
  <br><button onclick="window.print()" style="margin-top:24px;padding:12px 24px;background:#6c63ff;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700;">Print / Save as PDF</button>
</body>
</html>`;
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, "_blank");
    if (win) setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // F7: inline HubSpot push form below the action bar. The token lives in
  // userSettings (Settings → CRM); the push runs from the popup via the
  // injected fetch in hubspot.js — the key never leaves extension contexts.
  async openHubspotForm(containerId, topic, text) {
    const host = this.getResultEl();
    if (!host) return;
    const old = document.getElementById(`hubspotPanel_${containerId}`);
    if (old && old.remove) old.remove();

    const panel = document.createElement("div");
    panel.id = `hubspotPanel_${containerId}`;
    panel.style.cssText = "border:1px solid rgba(255,110,142,0.35);border-radius:8px;padding:10px;margin-top:8px;background:rgba(0,0,0,0.25);";
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:6px;";
    const input = document.createElement("input");
    input.type = "text";
    input.value = topic;
    input.placeholder = "Company name in HubSpot";
    input.style.cssText = "flex:1;font-size:12px;padding:6px;background:rgba(0,0,0,0.3);color:var(--tx);border:1px solid rgba(255,255,255,0.12);border-radius:6px;";
    const pushBtn = document.createElement("button");
    pushBtn.type = "button";
    pushBtn.className = "btn btn-t bsm";
    pushBtn.innerText = "Push to HubSpot";
    row.appendChild(input);
    row.appendChild(pushBtn);
    const status = document.createElement("div");
    status.style.cssText = "font-size:11px;color:var(--tx2);margin-top:6px;";
    panel.appendChild(row);
    panel.appendChild(status);
    host.parentNode.insertBefore(panel, host.nextSibling);

    pushBtn.addEventListener("click", async () => {
      const companyName = input.value.trim();
      if (!companyName) { status.innerText = "Enter the company name as it should appear in HubSpot."; return; }
      pushBtn.disabled = true;
      const orig = pushBtn.innerText;
      pushBtn.innerText = "Pushing…";
      status.innerText = "↗ Searching HubSpot…";
      try {
        const res = await pushBriefToHubSpot({
          fetchImpl: fetch.bind(globalThis),
          storage: chrome.storage.local,
          token: (this.userSettings?.hubspotToken || "").trim(),
          companyName,
          noteBody: buildNoteBody(companyName, text),
        });
        status.innerText = "";
        const line = document.createElement("div");
        line.style.cssText = "font-size:12px;color:#4fefd4;";
        line.innerText = `✅ Pushed to HubSpot${res.companyCreated ? " (company created)" : ""} — `;
        const link = document.createElement("a");
        link.href = res.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.innerText = `View ${companyName} →`;
        link.style.cssText = "color:#4fefd4;";
        line.appendChild(link);
        status.appendChild(line);
      } catch (e) {
        status.innerText = "⚠️ " + (e?.message || "Push failed.");
      } finally {
        pushBtn.disabled = false;
        pushBtn.innerText = orig;
      }
    });
  }

  async saveToHistory(topic, report, type) {    const data = await chrome.storage.local.get(["researchHistory"]);
    const history = data.researchHistory || [];
    history.unshift({
      id: Date.now(),
      topic,
      report,
      type,
      savedAt: new Date().toLocaleString(),
      preview: report.replace(/[━=\n]/g, " ").substring(0, 120),
      date: Date.now()
    });
    if (history.length > 100) history.pop();
    const saveResult = await Utils.setBoundedStorageArray("researchHistory", history, {
      maxItems: 100,
      minItems: 20,
      trimStep: 10
    });
    if (!saveResult.ok) {
      await Utils.writeDebugLog(`Failed to save research history: ${saveResult.error?.message || "quota error"}`, "warn");
    } else if (saveResult.trimmed > 0) {
      await Utils.writeDebugLog(`Research history trimmed by ${saveResult.trimmed} item(s) to stay within storage quota.`, "warn");
    }

    // Webhook sync
    if (this.userSettings.webhookUrl && this.userSettings.webhookUrl.startsWith("http")) {
      try {
        await fetch(this.userSettings.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ topic, report, type, source: "atom.ai", timestamp: new Date().toISOString() })
        });
      } catch (e) {}
    }
  }
}



