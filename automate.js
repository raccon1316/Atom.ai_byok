// automate.js
import { Utils } from './utils.js';
import { AgentTools } from './agent-tools.js';
import { requestJSON } from './structured.js';
import {
  MEDDIC_DIMENSIONS, buildMeddicPrompt, validateMeddicScore,
  MeddicCache, renderMeddicCard,
} from './meddic.js';

export class Automate {
  constructor(ai, userSettings) {
    this.ai = ai;
    this.userSettings = userSettings;
    this.agentStopped = false;
    this.resultHistory = [];
    this.resultIndex = -1;
    this.tools = new AgentTools({ scripting: chrome.scripting, tabs: chrome.tabs });
    this.pendingApproval = null;
    this.approvalTimer = null;
    this.siteInstructionsCache = new Map();
    this.initEventListeners();
    this.loadResultHistory();
    this.updateWorkflowUI().catch(() => {});
  }

  async loadResultHistory() {
    const data = await chrome.storage.local.get(["resultHistory", "resultIndex"]);
    if (data.resultHistory) this.resultHistory = data.resultHistory;
    if (data.resultIndex !== undefined) this.resultIndex = data.resultIndex;
    this.updateResultNav();
  }

  initEventListeners() {
    document.getElementById("ask")?.addEventListener("click", () => this.ask());
    document.getElementById("autotask")?.addEventListener("click", () => this.runAgent());
    document.getElementById("enhancePrompt")?.addEventListener("click", () => this.enhancePrompt());
    document.getElementById("summarize")?.addEventListener("click", () => this.summarizePage());
    document.getElementById("extracttable")?.addEventListener("click", () => this.extractTable());
    document.getElementById("autoFillBtn")?.addEventListener("click", () => this.autoFill());
    document.getElementById("workflowRecord")?.addEventListener("click", () => this.startRecording());
    document.getElementById("workflowStop")?.addEventListener("click", () => this.stopRecording());
    document.getElementById("workflowReplay")?.addEventListener("click", () => this.replayWorkflow());
    document.getElementById("workflowClear")?.addEventListener("click", () => this.clearWorkflow());
    document.querySelectorAll(".auto-chip").forEach(chip => chip.addEventListener("click", () => this.quickAction(chip.dataset.action)));
    document.querySelectorAll(".task-template").forEach(t => t.addEventListener("click", () => this.taskTemplate(t.dataset.task)));
    document.getElementById("resultPrev")?.addEventListener("click", () => this.prevResult());
    document.getElementById("resultNext")?.addEventListener("click", () => this.nextResult());
    document.getElementById("copy")?.addEventListener("click", () => this.copyResult());
    document.getElementById("copyMarkdownTable")?.addEventListener("click", () => this.copyAsMarkdownTable());
    document.getElementById("toSheetsResult")?.addEventListener("click", () => this.exportResultToSheets());
    document.getElementById("save")?.addEventListener("click", () => this.saveResult());
    document.getElementById("exportResult")?.addEventListener("click", () => this.exportResult());
    document.getElementById("clearNotes")?.addEventListener("click", () => this.clearNotes());
  }

  getResultEl() {
    return document.getElementById("globalResult") || document.getElementById("result");
  }


  getAutomationResultEl() {
    return this.getResultEl();
  }

  setAutomationStatus(message) {
    const resultEl = this.getAutomationResultEl();
    if (!resultEl) return;
    resultEl.style.display = "block";
    resultEl.innerText = message;
  }

  async getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error("No active tab found.");
    return tab;
  }

  async getActiveInjectableTab() {
    const tab = await this.getActiveTab();
    if (!Utils.isInjectableTab(tab)) {
      throw new Error("Open a normal website first. Chrome pages and extension pages cannot be analyzed.");
    }
    return tab;
  }

  async getActivePageContext(maxLength = 4500) {
    const tab = await this.getActiveInjectableTab();
    const text = await Utils.getPageText(tab.id, maxLength);
    if (!text || text.length < 80) {
      throw new Error("Could not read enough content from the current page.");
    }
    return {
      tab,
      text,
      title: tab.title || Utils.safeTabLabel(tab),
      url: tab.url || ""
    };
  }

  parseAgentDecision(decision) {
    let cleaned = String(decision || "").replace(/```json|```/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) cleaned = match[0];
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== "object" || !parsed.action) {
      throw new Error("Invalid agent decision.");
    }
    parsed.params = parsed.params && typeof parsed.params === "object" ? parsed.params : {};
    return parsed;
  }

  buildAutomationFailure(goal, stepLog) {
    const recent = stepLog.slice(-5).map((step, index) =>
      `${index + 1}. ${step.action} -> ${String(step.result || "").substring(0, 160)}`
    ).join("\n");
    return `I could not complete this auto task reliably.\n\nGoal: ${goal}\n\nRecent steps:\n${recent || "No useful steps recorded."}\n\nTry a more specific instruction, or start from the page you want me to work on before running the task.`;
  }

  buildSourceAppendix(sources, skipped = []) {
    const lines = [];
    if (sources?.length) {
      lines.push("SOURCES USED");
      lines.push(...sources.map((source, index) => `${index + 1}. ${source.domain} - ${source.title}`));
    }
    if (skipped?.length) {
      lines.push("");
      lines.push("SKIPPED TABS");
      lines.push(...skipped.map((item, index) => `${index + 1}. ${item.title || item.url || "Unknown"} - ${item.reason}`));
    }
    return lines.join("\n").trim();
  }

  async logDebug(scope, message, detail = null, level = "error") {
    try {
      await chrome.runtime.sendMessage({
        type: "LOG_DEBUG",
        scope,
        level,
        message: String(message || ""),
        detail
      });
    } catch (e) {}
  }

  async runWithTimeout(fn, timeoutMs, timeoutMessage = "Operation timed out.") {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs))
    ]);
  }

  isDurationExceeded(startMs, maxMs) {
    return Date.now() - startMs > maxMs;
  }

  inferExtractionPlan(goal) {
    const text = String(goal || "");
    const urlMatch = text.match(/https?:\/\/[^\s,]+/i);
    const countMatch = text.match(/first\s+(\d+)/i);
    const parenFields = text.match(/\(([^)]+)\)/);
    let fields = [];
    if (parenFields?.[1]) {
      fields = parenFields[1].split(",").map((f) => f.trim()).filter(Boolean);
    }
    if (!fields.length) {
      const extractMatch = text.match(/extract\s+(?:first\s+\d+\s+)?(.+?)(?:then|and then|, then|$)/i);
      if (extractMatch?.[1]) {
        fields = extractMatch[1]
          .split(/,| and /i)
          .map((f) => f.replace(/\bpost titles?\b/i, "title").trim())
          .filter((f) => f.length > 1 && f.length < 40);
      }
    }
    if (!fields.length) {
      fields = ["title", "link"];
    }
    return {
      url: urlMatch ? urlMatch[0] : "",
      count: countMatch ? Math.max(1, Math.min(100, Number(countMatch[1]))) : 20,
      fields,
      wantsSheets: /google\s*sheets?/i.test(text)
    };
  }

  toTSV(rows, fields) {
    const header = fields.join("\t");
    const lines = rows.map((row) => fields.map((field) => String(row[field] || "").replace(/\t|\n/g, " ").trim()).join("\t"));
    return [header, ...lines].join("\n");
  }

  toCSV(rows, fields) {
    const escape = (value) => {
      const v = String(value || "").replace(/\r?\n/g, " ").trim();
      return /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    };
    const header = fields.map(escape).join(",");
    const lines = rows.map((row) => fields.map((field) => escape(row[field])).join(","));
    return [header, ...lines].join("\n");
  }

  normalizeOutputFormat(format) {
    const f = String(format || "tsv").toLowerCase().trim();
    return ["tsv", "csv", "json"].includes(f) ? f : "tsv";
  }

  formatRows(rows, fields, outputFormat = "tsv") {
    const normalizedFields = fields?.length
      ? fields
      : Array.from(new Set((rows || []).flatMap((row) => Object.keys(row || {}))));
    const cleanRows = (rows || []).map((row) => {
      const mapped = {};
      normalizedFields.forEach((field) => { mapped[field] = String(row?.[field] ?? ""); });
      return mapped;
    });
    const format = this.normalizeOutputFormat(outputFormat);
    if (format === "json") return JSON.stringify(cleanRows, null, 2);
    if (format === "csv") return this.toCSV(cleanRows, normalizedFields);
    return this.toTSV(cleanRows, normalizedFields);
  }

  safeParseJsonArray(value) {
    const text = String(value || "").replace(/```json|```/gi, "").trim();
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : null;
    } catch (e) {}

    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (arrayMatch?.[0]) {
      try {
        const parsed = JSON.parse(arrayMatch[0]);
        return Array.isArray(parsed) ? parsed : null;
      } catch (e) {}
    }
    return null;
  }

  safeParseJsonObject(value) {
    const text = String(value || "").replace(/```json|```/gi, "").trim();
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch (e) {}

    const objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch?.[0]) {
      try {
        const parsed = JSON.parse(objMatch[0]);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
      } catch (e) {}
    }
    return null;
  }

  mapRowsHeuristically(rows, fields, count) {
    const wanted = Math.max(1, Math.min(100, Number(count) || 20));
    const normalizedFields = fields.map((f) => String(f || "").trim()).filter(Boolean);
    return rows.slice(0, wanted).map((row) => {
      const text = String(row?.text || "");
      const chunks = text.split("|").map((p) => p.trim()).filter(Boolean);
      const obj = {};
      normalizedFields.forEach((field, idx) => {
        const key = field.toLowerCase();
        if (key === "link" || key === "url") {
          obj[field] = String(row?.link || "");
        } else if ((key === "title" || key === "name") && chunks.length) {
          obj[field] = chunks[0];
        } else if ((key === "rank" || key === "position") && chunks.length) {
          obj[field] = (chunks[0].match(/\d+/)?.[0] || "");
        } else if (key === "year") {
          obj[field] = (text.match(/\b(19|20)\d{2}\b/)?.[0] || "");
        } else if (key === "rating" || key === "score") {
          obj[field] = (text.match(/\b\d+(?:\.\d+)?(?:\/10)?\b/)?.[0] || "");
        } else if (key === "upvotes" || key === "votes") {
          obj[field] = (text.match(/\b\d+(?:\.\d+)?\s*(?:k|m)?\b/i)?.[0] || "");
        } else {
          obj[field] = chunks[idx] || "";
        }
      });
      return obj;
    });
  }

  async collectStructuredPageData(tabId, limit = 80) {
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: (maxItems) => {
        const pickText = (el) => (el?.innerText || "").replace(/\s+/g, " ").trim();
        const isVisible = (el) => {
          const style = window.getComputedStyle(el);
          return style && style.display !== "none" && style.visibility !== "hidden";
        };
        const hostname = location.hostname.toLowerCase();

        const rows = [];
        const pushRow = (type, text, link = "") => {
          const t = String(text || "").replace(/\s+/g, " ").trim();
          if (!t || t.length < 6) return;
          rows.push({ type, text: t, link: String(link || "") });
        };

        if (hostname.includes("imdb.com")) {
          const imdbRows = document.querySelectorAll("li.ipc-metadata-list-summary-item");
          imdbRows.forEach((li, index) => {
            const titleEl = li.querySelector("h3");
            const meta = [...li.querySelectorAll(".cli-title-metadata span")].map((x) => pickText(x)).filter(Boolean);
            const rating = pickText(li.querySelector("[data-testid='ratingGroup--imdb-rating']"));
            const titleText = pickText(titleEl).replace(/^\d+\.\s*/, "");
            const rank = String(index + 1);
            const text = [rank, titleText, ...meta, rating].filter(Boolean).join(" | ");
            const link = li.querySelector("a[href]")?.href || "";
            pushRow("imdb", text, link);
          });
        }

        if (hostname.includes("reddit.com")) {
          const redditRows = document.querySelectorAll("shreddit-post, article, div[data-testid='post-container']");
          redditRows.forEach((post) => {
            const title = pickText(
              post.querySelector("a[slot='title'], h3, [data-testid='post-title-text'], a[data-click-id='body']")
            );
            const upvotes = pickText(
              post.querySelector("[id*='vote-arrows'] + div, [data-testid='vote-arrows'] + div, faceplate-number")
            );
            const link = post.querySelector("a[href*='/r/'], a[data-click-id='body']")?.href || "";
            const text = [title, upvotes].filter(Boolean).join(" | ");
            if (title) pushRow("reddit", text, link);
          });
        }

        if (hostname.includes("goodreads.com")) {
          const goodreadsRows = document.querySelectorAll("tr[itemtype*='Book'], .bookalike.review, .elementList");
          goodreadsRows.forEach((row) => {
            const title = pickText(
              row.querySelector("a.bookTitle, a[data-testid='bookTitle'], [itemprop='name']")
            );
            const author = pickText(
              row.querySelector("a.authorName, [itemprop='author'], [data-testid='name']")
            ).replace(/^by\s+/i, "");
            const rating = pickText(
              row.querySelector(".minirating, [aria-label*='rating'], [itemprop='ratingValue']")
            );
            const link = row.querySelector("a.bookTitle, a[data-testid='bookTitle'], a[href*='/book/show/']")?.href || "";
            const text = [title, author, rating].filter(Boolean).join(" | ");
            if (title) pushRow("goodreads", text, link);
          });
        }

        if (hostname.includes("linkedin.com")) {
          const linkedInRows = document.querySelectorAll(
            ".reusable-search__result-container, .entity-result, .search-result__info, .artdeco-entity-lockup"
          );
          linkedInRows.forEach((row) => {
            const name = pickText(
              row.querySelector(
                ".entity-result__title-text a, .app-aware-link span[aria-hidden='true'], .search-result__result-link"
              )
            );
            const headline = pickText(
              row.querySelector(".entity-result__primary-subtitle, .subline-level-1, .search-result__snippets")
            );
            const company = pickText(
              row.querySelector(".entity-result__secondary-subtitle, .subline-level-2")
            );
            const link = row.querySelector("a[href*='/in/'], a[href*='/company/'], a.app-aware-link")?.href || "";
            const text = [name, headline, company].filter(Boolean).join(" | ");
            if (name || headline) pushRow("linkedin", text, link);
          });
        }

        if (hostname.includes("amazon.")) {
          const amazonRows = document.querySelectorAll(
            "[data-component-type='s-search-result'], .s-result-item, .sg-col-inner"
          );
          amazonRows.forEach((row) => {
            const title = pickText(
              row.querySelector("h2 a span, h2 span, .a-size-base-plus")
            );
            const price = pickText(
              row.querySelector(".a-price .a-offscreen, .a-price-whole, .a-color-price")
            );
            const rating = pickText(
              row.querySelector("[aria-label*='out of 5 stars'], .a-icon-alt")
            );
            const reviews = pickText(
              row.querySelector("a[href*='customerReviews'] span, .s-link-style .a-size-base")
            );
            const link = row.querySelector("h2 a[href], a.a-link-normal[href*='/dp/']")?.href || "";
            const text = [title, price, rating, reviews].filter(Boolean).join(" | ");
            if (title) pushRow("amazon", text, link);
          });
        }

        const tableRows = [...document.querySelectorAll("table tr")];
        tableRows.forEach((tr) => {
          const cells = [...tr.querySelectorAll("th,td")].map((c) => pickText(c)).filter(Boolean);
          if (cells.length >= 2) {
            pushRow("table", cells.join(" | "), tr.querySelector("a[href]")?.href || "");
          }
        });

        const listRows = [...document.querySelectorAll("ol li, ul li")];
        listRows.forEach((li) => {
          if (!isVisible(li)) return;
          const t = pickText(li);
          if (t.length >= 15) pushRow("list", t, li.querySelector("a[href]")?.href || "");
        });

        const cardRows = [...document.querySelectorAll("article, .card, [class*='item'], [class*='post'], [class*='row']")];
        cardRows.forEach((el) => {
          if (!isVisible(el)) return;
          const t = pickText(el);
          if (t.length >= 20 && t.length <= 600) {
            pushRow("card", t, el.querySelector("a[href]")?.href || "");
          }
        });

        if (rows.length < 8) {
          const headingRows = [...document.querySelectorAll("h1, h2, h3")];
          headingRows.forEach((h) => {
            if (!isVisible(h)) return;
            const title = pickText(h);
            if (!title) return;
            const nearby = h.closest("a, article, li, div");
            const link = nearby?.querySelector?.("a[href]")?.href || h.querySelector("a[href]")?.href || "";
            pushRow("heading", title, link);
          });
        }

        const dedup = [];
        const seen = new Set();
        for (const row of rows) {
          const key = `${row.text}::${row.link}`.slice(0, 500);
          if (!seen.has(key)) {
            seen.add(key);
            dedup.push(row);
          }
          if (dedup.length >= maxItems) break;
        }
        return dedup;
        },
        args: [Math.max(20, Math.min(300, limit))]
      });
      return res?.[0]?.result || [];
    } catch (e) {
      await this.logDebug("collectStructuredPageData", e.message || "collectStructuredPageData failed", {
        tabId,
        limit
      });
      return [];
    }
  }

  sanitizeCacheKeyPart(value) {
    return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
  }

  async analyzePageLocally(tabId) {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const visible = (el) => {
          const style = window.getComputedStyle(el);
          return style.display !== "none" && style.visibility !== "hidden";
        };
        const count = (selector) => document.querySelectorAll(selector).length;
        const tableCount = count("table");
        const formCount = count("form");
        const listCount = count("ol li, ul li");
        const cardCount = count("article, .card, [class*='card'], [class*='item'], [class*='post'], [role='article']");
        const headingCount = count("h1, h2, h3");
        const linkCount = count("a[href]");
        const mainTextLength = (document.body?.innerText || "").replace(/\s+/g, " ").trim().length;
        const repeatedBlocks = Math.max(listCount, cardCount, count("table tr"));

        const visibleTables = [...document.querySelectorAll("table")].filter(visible);
        const largestTableRows = visibleTables.reduce((max, table) => Math.max(max, table.querySelectorAll("tr").length), 0);
        const largestTableCols = visibleTables.reduce((max, table) => {
          return Math.max(max, table.querySelector("tr")?.querySelectorAll("th,td")?.length || 0);
        }, 0);

        let pageType = "mixed";
        let confidence = 0.45;
        if (tableCount > 0 && largestTableRows >= 4 && largestTableCols >= 2) {
          pageType = "table";
          confidence = Math.min(0.95, 0.55 + Math.min(0.4, largestTableRows / 50));
        } else if (cardCount >= 8 || listCount >= 10) {
          pageType = "cards";
          confidence = Math.min(0.92, 0.5 + Math.min(0.35, Math.max(cardCount, listCount) / 60));
        } else if (formCount > 0 && formCount >= tableCount && formCount >= 1) {
          pageType = "form";
          confidence = 0.8;
        } else if (headingCount >= 8 && mainTextLength > 2000) {
          pageType = "article";
          confidence = 0.7;
        } else if (linkCount > 100 && repeatedBlocks > 20) {
          pageType = "search";
          confidence = 0.62;
        }

        const fingerprint = [
          location.hostname,
          tableCount,
          formCount,
          listCount,
          cardCount,
          headingCount,
          largestTableRows,
          largestTableCols,
          Math.round(mainTextLength / 100)
        ].join(":");

        return {
          url: location.href,
          title: document.title || "",
          pageType,
          confidence,
          counts: { tableCount, formCount, listCount, cardCount, headingCount, linkCount, repeatedBlocks, mainTextLength },
          largestTable: { rows: largestTableRows, cols: largestTableCols },
          fingerprint
        };
      }
    });
    return res?.[0]?.result || null;
  }

  async getCachedPageAnalysis(url, fingerprint) {
    const key = `pageAnalysis:${this.sanitizeCacheKeyPart(url)}:${this.sanitizeCacheKeyPart(fingerprint)}`;
    const data = await chrome.storage.local.get([key]);
    const cached = data[key];
    if (!cached?.analysis || !cached?.savedAt) return null;
    const ageMs = Date.now() - Number(cached.savedAt || 0);
    if (ageMs > 10 * 60 * 1000) return null;
    return cached.analysis;
  }

  async saveCachedPageAnalysis(url, fingerprint, analysis) {
    const key = `pageAnalysis:${this.sanitizeCacheKeyPart(url)}:${this.sanitizeCacheKeyPart(fingerprint)}`;
    await chrome.storage.local.set({ [key]: { analysis, savedAt: Date.now() } });
  }

  validateRows(rows, fields) {
    if (!Array.isArray(rows) || !rows.length) return false;
    const keys = new Set(rows.flatMap((row) => Object.keys(row || {}).map((k) => String(k).toLowerCase())));
    const expected = (fields || []).map((f) => String(f).toLowerCase()).filter(Boolean);
    if (!expected.length) return true;
    const missing = expected.filter((field) => !keys.has(field));
    return missing.length <= Math.max(1, Math.floor(expected.length / 3));
  }

  async trackAutomationMetrics(patch = {}) {
    const data = await chrome.storage.local.get(["automationMetrics"]);
    const base = data.automationMetrics || {
      runs: 0,
      localSuccessCount: 0,
      aiFallbackCount: 0,
      totalDurationMs: 0,
      avgTaskMs: 0
    };
    const next = {
      runs: Number(base.runs || 0) + 1,
      localSuccessCount: Number(base.localSuccessCount || 0) + (patch.localSuccess ? 1 : 0),
      aiFallbackCount: Number(base.aiFallbackCount || 0) + (patch.aiFallback ? 1 : 0),
      totalDurationMs: Number(base.totalDurationMs || 0) + Math.max(0, Number(patch.durationMs || 0))
    };
    next.avgTaskMs = next.runs ? Math.round(next.totalDurationMs / next.runs) : 0;
    await chrome.storage.local.set({ automationMetrics: next });
  }

  async runLocalFirstExtraction(goal) {
    const plan = this.inferExtractionPlan(goal);
    if (!/extract|collect|scrape|pull/i.test(goal)) return null;
    let tab = await this.getActiveTab();
    if (plan.url) {
      await chrome.tabs.update(tab.id, { url: plan.url });
      await Utils.waitForTab(tab.id, 15000);
      await this.tools.waitForQuiet(tab.id, { maxMs: 5000 });
      tab = await this.getActiveTab();
    }
    if (!Utils.isInjectableTab(tab)) return null;

    const liveAnalysis = await this.analyzePageLocally(tab.id);
    if (!liveAnalysis) return null;
    const cached = await this.getCachedPageAnalysis(liveAnalysis.url, liveAnalysis.fingerprint);
    const analysis = cached || liveAnalysis;
    if (!cached) await this.saveCachedPageAnalysis(liveAnalysis.url, liveAnalysis.fingerprint, liveAnalysis);

    const confidencePct = Math.round((Number(analysis.confidence || 0) || 0) * 100);
    this.setAutomationStatus(`Detected: ${analysis.pageType} page (${confidencePct}% confidence). Running local extraction first...`);

    const maxRows = Math.max(1, Math.min(120, Number(plan.count || 20)));
    let rows = [];
    let sourceMode = "";
    if (analysis.pageType === "table" && analysis.confidence >= 0.55) {
      const extracted = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (limit) => {
          const pick = (el) => (el?.innerText || "").replace(/\s+/g, " ").trim();
          const tables = [...document.querySelectorAll("table")];
          if (!tables.length) return [];
          const ranked = tables
            .map((table) => ({
              table,
              score: table.querySelectorAll("tr").length * Math.max(1, table.querySelector("tr")?.querySelectorAll("th,td")?.length || 0)
            }))
            .sort((a, b) => b.score - a.score);
          const table = ranked[0].table;
          const headers = [...table.querySelectorAll("thead th")].map(pick).filter(Boolean);
          const dataRows = (table.querySelectorAll("tbody tr").length ? [...table.querySelectorAll("tbody tr")] : [...table.querySelectorAll("tr")]);
          return dataRows.slice(0, limit).map((tr) => {
            const cells = [...tr.querySelectorAll("th,td")].map(pick).filter(Boolean);
            const row = {};
            cells.forEach((cell, i) => {
              row[headers[i] || `col${i + 1}`] = cell;
            });
            const link = tr.querySelector("a[href]")?.href || "";
            if (link) row.link = link;
            return row;
          }).filter((row) => Object.keys(row).length >= 2);
        },
        args: [maxRows]
      });
      const rawRows = extracted?.[0]?.result || [];
      const fields = plan.fields.length ? plan.fields : Object.keys(rawRows[0] || {});
      rows = rawRows.map((row) => {
        const out = {};
        fields.forEach((field, idx) => {
          const exact = Object.keys(row).find((k) => k.toLowerCase() === field.toLowerCase());
          out[field] = String(row?.[exact || field] ?? row?.[`col${idx + 1}`] ?? "");
        });
        if (fields.every((f) => f.toLowerCase() !== "link") && row.link) out.link = row.link;
        return out;
      });
      sourceMode = "local-table";
    } else if ((analysis.pageType === "cards" || analysis.pageType === "search" || analysis.pageType === "mixed") && analysis.confidence >= 0.5) {
      const structured = await this.collectStructuredPageData(tab.id, maxRows * 3);
      rows = this.mapRowsHeuristically(structured, plan.fields, maxRows);
      sourceMode = "local-cards";
    }

    if (!this.validateRows(rows, plan.fields)) {
      return { handled: false, analysis, reason: "low_local_confidence_or_missing_fields" };
    }

    const limited = rows.slice(0, maxRows).map((row) => {
      const out = {};
      plan.fields.forEach((field) => { out[field] = String(row?.[field] ?? ""); });
      return out;
    });
    const tsv = this.toTSV(limited, plan.fields);
    let sheetsStatus = "";
    if (plan.wantsSheets) {
      const write = await this.tryWriteToGoogleSheets(tsv);
      sheetsStatus = write.ok
        ? "Wrote data into the active Google Sheets editor."
        : `Could not auto-write to Google Sheets (${write.reason}). Data copied below; paste manually into Sheets.`;
    }
    return {
      handled: true,
      localOnly: true,
      analysis,
      result: [
        `Local extraction completed (${sourceMode}): ${limited.length} row(s).`,
        `Detected page type: ${analysis.pageType} (${Math.round((analysis.confidence || 0) * 100)}%).`,
        sheetsStatus,
        "",
        "TSV OUTPUT:",
        tsv
      ].filter(Boolean).join("\n")
    };
  }

  async tryWriteToGoogleSheets(tsv) {
    return await Utils.tryWriteToGoogleSheets(tsv);
  }

  async runStructuredExtractionTask(goal) {
    const plan = this.inferExtractionPlan(goal);
    if (!plan.url) return null;
    if (!/extract|collect|scrape|pull/i.test(goal)) return null;

    this.showLoader(true, "Running structured extraction...");
    const tab = await this.getActiveTab();
    await chrome.tabs.update(tab.id, { url: plan.url });
    await Utils.waitForTab(tab.id, 15000);
    await this.tools.waitForQuiet(tab.id, { maxMs: 5000 });

    const rows = await this.collectStructuredPageData(tab.id, plan.count * 4);
    if (!rows.length) {
      return "Could not find extractable rows on that page.";
    }

    const raw = rows.map((row, i) => `${i + 1}. ${row.text}${row.link ? ` | LINK: ${row.link}` : ""}`).join("\n");
    const jsonText = await this.ai.chat(
      `Goal: ${goal}

Fields required: ${plan.fields.join(", ")}
Row count target: ${plan.count}

Convert the raw page snippets below into STRICT JSON array only (no markdown), max ${plan.count} rows.
Each object must only include these keys: ${plan.fields.join(", ")}.
If a field is missing, use empty string.

RAW SNIPPETS:
${raw.substring(0, 14000)}`,
      1800
    );

    let parsed = this.safeParseJsonArray(jsonText);
    if (!parsed) {
      const repairText = await this.ai.chat(
        `Return ONLY valid JSON array.
Use exactly these keys in each row: ${plan.fields.join(", ")}.
No comments. No markdown.

Input:
${String(jsonText).substring(0, 7000)}`,
        900
      );
      parsed = this.safeParseJsonArray(repairText);
    }

    if (!parsed) {
      const fallback = this.mapRowsHeuristically(rows, plan.fields, plan.count);
      if (!fallback.length) {
        return "Extraction parsing failed. Try a smaller count or simpler schema.";
      }
      parsed = fallback;
    }

    const limited = parsed.slice(0, plan.count).map((row) => {
      const obj = {};
      plan.fields.forEach((field) => {
        obj[field] = String(row?.[field] ?? "");
      });
      return obj;
    });

    const tsv = this.toTSV(limited, plan.fields);
    let sheetsStatus = "";
    if (plan.wantsSheets) {
      const write = await this.tryWriteToGoogleSheets(tsv);
      sheetsStatus = write.ok
        ? "Wrote data into the active Google Sheets editor."
        : `Could not auto-write to Google Sheets (${write.reason}). Data copied below; paste manually into Sheets.`;
    }

    return [
      `Structured extraction completed: ${limited.length} row(s).`,
      sheetsStatus,
      "",
      "TSV OUTPUT:",
      tsv
    ].filter(Boolean).join("\n");
  }
  async ask() {
    const prompt = document.getElementById("prompt").value.trim();
    if (!prompt) return;
    const btn = document.getElementById("ask");
    btn.disabled = true;
    this.showLoader(true, "Working...");
    try {
      const { title, url, text } = await this.getActivePageContext(4500);
      const result = await this.ai.chat(
        `${prompt}\n\nCurrent page title: ${title}\nCurrent page URL: ${url}\n\nPage content:\n${text}`
      );
      this.setResult(result);
    } catch (e) {
      this.setResult("Error: " + e.message);
    } finally {
      this.showLoader(false);
      btn.disabled = false;
    }
  }
  async summarizePage() {
    const btn = document.getElementById("summarize");
    btn.disabled = true;
    this.showLoader(true, "Summarizing...");
    try {
      const { title, url, text } = await this.getActivePageContext(5000);
      const result = await this.ai.chat(
        `Summarize this page in clear bullet points with key takeaways for a business professional.\n\nTitle: ${title}\nURL: ${url}\n\n${text}`
      );
      this.setResult(result);
    } catch (e) {
      this.setResult("Error: " + e.message);
    } finally {
      this.showLoader(false);
      btn.disabled = false;
    }
  }
  async extractTable() {
    const btn = document.getElementById("extracttable");
    btn.disabled = true;
    this.showLoader(true, "Extracting data...");
    try {
      const { title, url, text } = await this.getActivePageContext(5000);
      const result = await this.ai.chat(
        `Extract all structured data - tables, lists, prices, rankings, contacts, and stats. Format clearly with labels.\n\nTitle: ${title}\nURL: ${url}\n\n${text}`
      );
      this.setResult(result);
    } catch (e) {
      this.setResult("Error: " + e.message);
    } finally {
      this.showLoader(false);
      btn.disabled = false;
    }
  }
  async autoFill() {
    return await this.autoFillEnhanced();
    const instructions = document.getElementById("autofillInstructions").value.trim();
    if (!instructions) return alert("Describe what to fill");
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!Utils.isInjectableTab(tab)) return alert("Navigate to a page with a form first.");
    const resultEl = this.getResultEl();
    resultEl.style.display = "block";
    resultEl.innerText = "🔄 Reading form fields...";
    const snap = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => [...document.querySelectorAll("input,textarea,select")].map(el => ({
        tag: el.tagName, type: el.type || "", id: el.id || "",
        name: el.name || "", placeholder: el.placeholder || "",
        label: el.labels?.[0]?.innerText || ""
      }))
    });
    const fields = snap?.[0]?.result || [];
    if (!fields.length) {
      resultEl.innerText = "No form fields found on this page.";
      return;
    }
    const plan = await this.ai.chat(`Form fields:\n${JSON.stringify(fields)}\n\nUser instructions: "${instructions}"\n\nReply ONLY with JSON array (no markdown):\n[{"selector":"input[name='x']","value":"val"}]`, 800);
    let actions;
    try {
      actions = JSON.parse(plan.replace(/```json|```/g, "").trim());
    } catch {
      resultEl.innerText = "Could not parse fill plan. Try again.";
      return;
    }
    let filled = 0;
    for (const a of actions) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (s, v) => {
            const el = document.querySelector(s);
            if (el) {
              el.focus();
              el.value = v;
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
            }
          },
          args: [a.selector, a.value]
        });
        filled++;
        await Utils.wait(350);
      } catch (e) {}
    }
    resultEl.innerText = `✅ Filled ${filled} of ${actions.length} fields!`;
  }

  async autoFillEnhanced() {
    const instructions = document.getElementById("autofillInstructions").value.trim();
    if (!instructions) return alert("Describe what to fill");
    const btn = document.getElementById("autoFillBtn");
    btn.disabled = true;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!Utils.isInjectableTab(tab)) {
      btn.disabled = false;
      return alert("Navigate to a page with a form first.");
    }

    const resultEl = this.getResultEl();
    resultEl.style.display = "block";
    resultEl.innerText = "Reading form fields...";

    const snap = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const pick = (s) => (s || "").replace(/\s+/g, " ").trim();
        const esc = (v) => {
          if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(v);
          return String(v).replace(/"/g, '\\"');
        };
        const isVisible = (el) => {
          const style = window.getComputedStyle(el);
          return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
        };
        const inferLabel = (el) => {
          const direct = el.labels?.[0]?.innerText;
          if (direct) return pick(direct);
          const byFor = el.id ? document.querySelector(`label[for="${esc(el.id)}"]`)?.innerText : "";
          if (byFor) return pick(byFor);
          const parentLabel = el.closest("label")?.innerText;
          if (parentLabel) return pick(parentLabel);
          const aria = el.getAttribute("aria-label");
          if (aria) return pick(aria);
          return "";
        };
        const buildSelector = (el) => {
          if (el.id) return `#${esc(el.id)}`;
          if (el.name) return `${el.tagName.toLowerCase()}[name="${esc(el.name)}"]`;
          if (el.getAttribute("data-testid")) return `[data-testid="${esc(el.getAttribute("data-testid"))}"]`;
          if (el.getAttribute("aria-label")) return `${el.tagName.toLowerCase()}[aria-label="${esc(el.getAttribute("aria-label"))}"]`;
          if (el.placeholder) return `${el.tagName.toLowerCase()}[placeholder="${esc(el.placeholder)}"]`;
          return el.tagName.toLowerCase();
        };
        return [...document.querySelectorAll("input,textarea,select,[contenteditable='true'],[role='combobox']")]
          .filter((el) => !el.disabled && isVisible(el))
          .slice(0, 220)
          .map((el) => {
            const tag = el.tagName.toLowerCase();
            return {
              selector: buildSelector(el),
              tag,
              type: String(el.type || "").toLowerCase(),
              id: el.id || "",
              name: el.name || "",
              placeholder: el.placeholder || "",
              label: inferLabel(el),
              role: el.getAttribute("role") || "",
              options: tag === "select"
                ? [...el.options].slice(0, 25).map((o) => ({ text: pick(o.text), value: String(o.value || "") }))
                : []
            };
          });
      }
    });

    const fields = snap?.[0]?.result || [];
    const hasClickOrWaitIntent = /(^|[;\n\r])\s*(click|tap|press|wait\s+for|wait\s+\d+)/i.test(instructions);
    if (!fields.length && !hasClickOrWaitIntent) {
      resultEl.innerText = "No form fields found on this page.";
      return;
    }
    if (!fields.length && hasClickOrWaitIntent) {
      resultEl.innerText = "No form fields detected. Running click/wait flow...";
    }

    const buildFallbackActions = () => {
      const normalize = (text) => String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
      const lines = String(instructions)
        .split(/\r?\n|;/)
        .map((line) => line.trim());

      const pairActions = [];
      const flowActions = [];
      for (const line of lines) {
        if (!line) continue;
        const kv = line.match(/^([^:=\-]{2,50})\s*[:=]\s*(.+)$/);
        if (kv) {
          pairActions.push({ key: kv[1].trim(), value: kv[2].trim() });
          continue;
        }
        const clickMatch = line.match(/^(?:click|tap|press)\s+(.+)$/i);
        if (clickMatch) {
          flowActions.push({ type: "click", field: clickMatch[1].trim(), value: clickMatch[1].trim() });
          continue;
        }
        const waitForMatch = line.match(/^wait\s+for\s+(.+)$/i);
        if (waitForMatch) {
          flowActions.push({ type: "waitFor", field: waitForMatch[1].trim(), waitMs: 12000 });
          continue;
        }
        const waitMsMatch = line.match(/^wait\s+(\d+)\s*(?:ms|milliseconds|sec|seconds)?$/i);
        if (waitMsMatch) {
          const raw = Number(waitMsMatch[1] || 0);
          const waitMs = /sec/i.test(line) ? raw * 1000 : raw;
          flowActions.push({ type: "waitFor", waitMs: Math.max(300, Math.min(30000, waitMs || 1200)) });
        }
      }

      const mapped = pairActions.map((pair) => {
        const target = normalize(pair.key);
        let best = null;
        let bestScore = -1;
        for (const field of fields) {
          const hay = normalize([field.label, field.name, field.placeholder, field.id].join(" "));
          let score = 0;
          if (hay.includes(target)) score += 5;
          score += target.split(" ").filter((t) => t.length > 2 && hay.includes(t)).length;
          if (score > bestScore) {
            best = field;
            bestScore = score;
          }
        }
        if (!best || bestScore < 1) return null;
        return { selector: best.selector, value: pair.value, field: pair.key, type: best.type || best.tag };
      }).filter(Boolean);

      return [...mapped, ...flowActions];
    };

    let actions = [];
    let planError = "";
    try {
      const plan = await this.ai.chat(
        `Create a strict form fill plan from user instructions.
Instructions:
${instructions}

Detected fields:
${JSON.stringify(fields).substring(0, 14000)}

Return ONLY JSON array with objects like:
{"selector":"...","value":"...","field":"...","type":"text|textarea|select|checkbox|radio|combobox|click|waitFor","choiceText":"optional","waitMs":1200}

Rules:
- Use selectors from detected fields for input/select steps.
- For select/combobox fields prefer "choiceText".
- For checkbox/radio set value as true/false or option text.
- Include click steps when user instructions say "click next/continue/login".
- For click/wait steps you may omit selector and use "field" text (for button/link label).
- Keep order exactly as required by the user flow.`,
        1000
      );
      actions = this.safeParseJsonArray(plan) || [];
    } catch (e) {
      planError = e?.message || "AI planning failed.";
    }

    if (!actions.length) actions = buildFallbackActions();
    if (!actions.length) {
      resultEl.innerText = planError
        ? `Could not build autofill plan (${planError}). Use lines like "Email: x", "Click Next", "Password: y".`
        : "Could not build autofill plan. Use lines like \"Email: x\", \"Click Next\", \"Password: y\".";
      return;
    }

    const jobId = `af_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    resultEl.innerText = "Applying autofill plan in passive mode...";
    const startRes = await chrome.runtime.sendMessage({
      type: "AUTOFILL_START",
      jobId,
      tabId: tab.id,
      actions
    });
    if (!startRes?.ok) {
      resultEl.innerText = `Could not start autofill: ${startRes?.error || "Unknown error"}`;
      return;
    }

    resultEl.innerText = "Autofill started in background mode. It will continue even if popup closes.";

    let finalStatus = null;
    for (let i = 0; i < 20; i++) {
      await Utils.wait(700);
      const probe = await chrome.runtime.sendMessage({ type: "AUTOFILL_STATUS", jobId });
      const status = probe?.job || null;
      if (!status) continue;
      if (status.status === "done" || status.status === "error") {
        finalStatus = status;
        break;
      }
    }

    if (!finalStatus) {
      resultEl.innerText = "Autofill is still running in passive mode. You can close popup and reopen to continue.";
      return;
    }

    const outcomes = finalStatus.results || [];
    const successCount = outcomes.filter((o) => o.ok).length;
    const failList = outcomes.filter((o) => !o.ok);
    const details = failList.slice(0, 5).map((o) => `- ${o.field || o.selector || "field"}: ${o.reason || "not filled"}`).join("\n");
    resultEl.innerText = [
      finalStatus.status === "error" ? `Run failed: ${finalStatus.error || "unknown error"}` : `Executed ${successCount} of ${actions.length} step(s).`,
      failList.length ? `Failed: ${failList.length}` : "No failures.",
      details
    ].filter(Boolean).join("\n");
    const fillBtn = document.getElementById("autoFillBtn");
    if (fillBtn) fillBtn.disabled = false;
  }

  async quickAction(action) {
    const resultEl = this.getResultEl();
    if (!resultEl) return;
    resultEl.style.display = "block";
    resultEl.innerText = "Working on: " + action + "...";
    let tab = null;
    try {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch (e) {
      resultEl.innerText = "Error reading current tab: " + e.message;
      return;
    }
    if (!Utils.isInjectableTab(tab)) {
      resultEl.innerText = "Open a normal website first.";
      return;
    }
    try {
      switch (action) {
        case "extractleads": {
          const text = await Utils.getPageText(tab.id);
          const result = await this.ai.chat(`Extract all business leads from this page. For each lead provide: Company/Person Name, Email, Phone, Website/LinkedIn, Role/Title. Format as clean numbered list. Page:\n${text.substring(0, 4000)}`);
          resultEl.innerText = result || "No leads found.";
          break;
        }
        case "extractcsv": {
          const text = await Utils.getPageText(tab.id);
          const csv = await this.ai.chat(`Extract ALL structured/tabular data from this page and format as CSV with headers. Label each section if multiple tables exist.\n\nPage:\n${text.substring(0, 4000)}`);
          if (!csv) { resultEl.innerText = "No tabular data found."; break; }
          resultEl.innerText = csv;
          const blob = new Blob([csv], { type: "text/csv" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = "atom_export.csv";
          a.click();
          break;
        }
        case "emails": {
          const res = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              const text = document.body.innerText + document.body.innerHTML;
              return [...new Set((text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []))].slice(0, 30);
            }
          });
          const emails = res?.[0]?.result || [];
          resultEl.innerText = emails.length ? `📧 Found ${emails.length} email(s):\n\n` + emails.join("\n") : "No emails found.";
          break;
        }
        case "phones": {
          const res = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              const text = document.body.innerText;
              return [...new Set((text.match(/(\+?[\d\s\-().]{8,18})/g) || []).filter(p => p.replace(/\D/g, "").length >= 7))].slice(0, 20);
            }
          });
          const phones = res?.[0]?.result || [];
          resultEl.innerText = phones.length ? `📞 Found ${phones.length} phone(s):\n\n` + phones.join("\n") : "No phone numbers found.";
          break;
        }
        case "prices": {
          const text = await Utils.getPageText(tab.id);
          const result = await this.ai.chat(`Extract ALL prices from this page. Format as a clean list with item and price. Include discounts and original prices.\n\nPage:\n${text.substring(0, 3000)}`);
          resultEl.innerText = result || "No prices found.";
          break;
        }
        case "techstack": {
          const res = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              const scripts = [...document.querySelectorAll("script[src]")].map(s => s.src);
              const metas = [...document.querySelectorAll("meta")].map(m => m.name + ":" + m.content);
              const html = document.documentElement.outerHTML.substring(0, 8000);
              return { scripts, metas, html };
            }
          });
          const data = res?.[0]?.result || {};
          const result = await this.ai.chat(`Identify the tech stack of this website based on:\nScripts: ${JSON.stringify(data.scripts?.slice(0, 20))}\nMeta tags: ${JSON.stringify(data.metas?.slice(0, 10))}\nHTML snippet: ${(data.html || "").substring(0, 2000)}\n\nList: Frontend framework, Backend signals, Analytics tools, Ad tools, CMS, CDN, Payment systems, Chat tools, Marketing stack.`);
          resultEl.innerText = result;
          break;
        }
        case "links": {
          const res = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              const seen = new Set(); const links = [];
              document.querySelectorAll("a[href]").forEach(a => {
                if (!seen.has(a.href) && a.href.startsWith("http")) {
                  seen.add(a.href);
                  links.push({ text: (a.innerText || "").trim().substring(0, 60), url: a.href });
                }
              });
              return links.slice(0, 50);
            }
          });
          const links = res?.[0]?.result || [];
          resultEl.innerText = `🔗 Found ${links.length} links:\n\n` + links.map((l, i) => `${i + 1}. ${l.text || "(no text)"}\n   ${l.url}`).join("\n\n");
          break;
        }
        case "readmode": {
          const text = await Utils.getPageText(tab.id);
          const result = await this.ai.chat(`Extract and reformat this article in clean reading mode — remove ads/navigation/clutter. Present just the core content clearly structured:\n\n${text.substring(0, 4000)}`);
          resultEl.innerText = result || "Could not reformat this page.";
          break;
        }
        case "qualify": {
          const text = await Utils.getPageText(tab.id);
          const url = tab.url || "";
          const cache = this.meddicCache || (this.meddicCache = new MeddicCache(globalThis.chrome?.storage?.local || null));
          const hit = await cache.get(url, text);
          if (hit) {
            resultEl.innerHTML = "";
            resultEl.appendChild(renderMeddicCard(document, hit.result, { cachedAt: new Date(hit.scoredAt).toLocaleString() }));
            break;
          }
          resultEl.innerText = "📊 Scoring MEDDIC on this page…";
          const score = await requestJSON(this.ai, {
            prompt: buildMeddicPrompt(text, this.userSettings?.profile?.company || ""),
            maxTokens: 1200,
            temperature: 0.2,
            validate: validateMeddicScore,
          });
          await cache.put(url, text, score);
          resultEl.innerHTML = "";
          resultEl.appendChild(renderMeddicCard(document, score, {}));
          break;
        }
        default:
          resultEl.innerText = "⚠️ Unknown action: " + action;
      }
    } catch (e) {
      resultEl.innerText = "⚠️ Error: " + e.message;
    }
  }

  // Direct web search without LLM calls. Used by the searchWeb tool AND the runAgent fast-path.
  async searchWebDirect(query, engine = "google") {
    query = String(query || "").trim();
    if (!query) return "ERROR: Missing search query.";
    engine = String(engine || "google").toLowerCase();
    const engines = {
      google: "https://www.google.com/search?q=",
      duckduckgo: "https://duckduckgo.com/?q=",
      bing: "https://www.bing.com/search?q="
    };
    const base = engines[engine] || engines.google;
    const tab = await this.getActiveTab();
    await chrome.tabs.update(tab.id, { url: base + encodeURIComponent(query) });
    await Utils.waitForTab(tab.id, 12000);
    await this.tools.waitForQuiet(tab.id, { maxMs: 5000 });
    // Read top results so the agent (or user) can decide next steps
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const seen = new Set();
          const results = [];
          const nodes = [...document.querySelectorAll("a[href^='http']")];
          for (const a of nodes) {
            const title = (a.innerText || "").replace(/\s+/g, " ").trim();
            const href = a.href;
            if (!title || title.length < 15) continue;
            if (href.includes("google.com/search") || href.includes("duckduckgo.com") || href.includes("bing.com/search")) continue;
            const key = href.split("#")[0];
            if (seen.has(key)) continue;
            seen.add(key);
            results.push({ title: title.slice(0, 100), url: key.slice(0, 200) });
            if (results.length >= 8) break;
          }
          return { ok: true, count: results.length, results, pageText: (document.body?.innerText || "").slice(0, 1500) };
        }
      });
      const out = res?.[0]?.result;
      if (out?.ok && out.count > 0) {
        const list = out.results.map((r, i) => `${i + 1}. ${r.title} | ${r.url}`).join("\n");
        return `OK: Searched "${query}" on ${engine}. Top results:\n${list}\n\nUse navigate with a result URL or clickText to open one.`;
      }
    } catch (e) { /* fall through to plain navigation result */ }
    return `OK: Searched "${query}" on ${engine}. Read the page with readPage to see results.`;
  }

  // Detect simple "search for X" goals so runAgent can skip the LLM loop entirely.
  // Returns { query, engine } or null.
  matchSearchShortcut(goal) {
    const g = String(goal || "").trim();
    if (!g || g.length > 160) return null;
    // "open google and search amazon" / "open bing search cats"
    let m = g.match(/^open\s+(google|bing|duckduckgo)?\s*(?:and\s+)?search\s+(?:for\s+)?(.+)$/i);
    if (m) return { engine: (m[1] || "google").toLowerCase(), query: m[2].trim() };
    // "search google for amazon" / "search for amazon" / "search amazon"
    m = g.match(/^search\s+(?:on\s+)?(?:(google|bing|duckduckgo)\s+)?(?:for\s+)?(.+)$/i);
    if (m) return { engine: (m[1] || "google").toLowerCase(), query: m[2].trim() };
    // "google amazon" / "bing cheap flights"
    m = g.match(/^(google|bing|duckduckgo)\s+(.+)$/i);
    if (m) return { engine: m[1].toLowerCase(), query: m[2].trim() };
    return null;
  }

  async enhancePrompt() {
    const input = document.getElementById("prompt");
    const raw = input?.value.trim() || "";
    if (!raw) return alert("Enter a task description first.");
    const btn = document.getElementById("enhancePrompt");
    const originalText = btn ? btn.innerText : "";
    if (btn) {
      btn.disabled = true;
      btn.innerText = "✨ Enhancing...";
    }
    this.showLoader(true, "Enhancing prompt...");
    try {
      const enhanced = await this.ai.chat(
        `You are an expert prompt engineer for a browser automation agent that can navigate pages, click, search, extract tables, leads, and summarize.\n\nRewrite the user's rough task into a clear, specific, actionable instruction (1-3 sentences). Add missing details only when obvious (e.g. target site, desired output format). Keep the original intent and language. Do NOT add explanations, quotes, or markdown — return ONLY the enhanced task prompt.\n\nUser task: "${raw}"`,
        300,
        0.4
      );
      const cleaned = String(enhanced || "").replace(/^["'\s]+|["'\s]+$/g, "").replace(/```/g, "").trim();
      if (!cleaned) throw new Error("AI returned an empty enhancement.");
      input.value = cleaned;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    } catch (e) {
      alert("Enhance failed: " + (e.message || e));
    } finally {
      this.showLoader(false);
      if (btn) {
        btn.disabled = false;
        btn.innerText = originalText || "✨ Enhance";
      }
    }
  }

  async runAgent() {
    const goal = document.getElementById("prompt").value.trim();
    if (!goal) { window.showToast?.("Enter a task goal.", "error"); return; }
    const btn = document.getElementById("autotask");
    const stopBtn = document.getElementById("agentStop");
    // Auto Task runs in the service worker so it survives the popup closing.
    // The popup only starts it here; progress is rendered from storage.onChanged.
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !Utils.isInjectableTab(tab)) {
        throw new Error("Open a normal website tab first (not chrome:// or the extension page).");
      }
      const res = await chrome.runtime.sendMessage({ type: 'AUTO_TASK_START', goal, tabId: tab.id });
      if (!res || res.ok === false || res.error) {
        throw new Error(res?.error || res?.reason || 'Could not start the task.');
      }
      this.agentStopped = false;
      if (btn) btn.disabled = true;
      if (stopBtn) stopBtn.style.display = "inline-block";
      this.showLoader(true, "Agent running in background… safe to close the popup.");
    } catch (e) {
      this.showLoader(false);
      if (btn) btn.disabled = false;
      if (stopBtn) stopBtn.style.display = "none";
      window.showToast?.(String(e?.message || e), 'error');
    }
  }
  async crossTabIntelligence() {
    const tabs = await Utils.getReadableTabs({ currentWindow: true, maxTabs: 5 });
    const { sources, skipped } = await Utils.collectTabSources(tabs, { maxLength: 1600, waitMs: 7000 });
    if (!sources.length) return "No readable tabs found.";

    const combined = sources.map((source, index) =>
      `[SOURCE ${index + 1}] ${source.title}\nDomain: ${source.domain}\nURL: ${source.url}\n${source.text}`
    ).join("\n\n---\n\n");

    const synthesis = await this.ai.chat(`You are a market intelligence analyst. Analyze these ${sources.length} open tabs together.

Requirements:
- Cite each important claim with [Source: domain]
- Flag contradictions explicitly
- Mention when evidence is thin
- Keep the answer practical and specific

Produce:
1. KEY FACTS
2. CONTRADICTIONS OR GAPS
3. UNIQUE INSIGHTS
4. UNIFIED SUMMARY
5. BEST NEXT ACTION

Sources:
${combined}`, 1600);

    const appendix = this.buildSourceAppendix(sources, skipped);
    return appendix ? `${synthesis}\n\n${appendix}` : synthesis;
  }
  async multiTabResearch() {
    // Phase 5: delegate to service worker so it survives popup close
    this.showLoader(true, "Queuing multi-tab job… You can close popup.");
    try {
      const tabs = await Utils.getReadableTabs({ currentWindow: true, maxTabs: 5 });
      const urls = tabs.map(t=>t.url).filter(u=>/^https?:\/\//i.test(u));
      if (!urls.length) {
        this.setResult("Could not read any open website tabs. Open 2 to 4 normal websites first.");
        return;
      }
      const payload = { urls };
      const res = await chrome.runtime.sendMessage({ type:'JOB_CREATE', jobType:'multitab', payload });
      if (res?.error) {
        this.setResult("Error: " + res.error);
        return;
      }
      this.setResult(`Queued multi-tab job ${res.jobId || res.job?.id}. Progress appears in Jobs on Home. You can close popup — it runs in background and will save to History.`);
    } catch (e) {
      this.setResult("Error: " + e.message);
    } finally {
      this.showLoader(false);
    }
  }
  taskTemplate(task) {
    document.getElementById("prompt").value = task;
    this.runAgent();
  }

  async getWorkflowState() {
    const res = await chrome.runtime.sendMessage({ type: "WORKFLOW_GET_STATE" });
    return res?.state || { recording: false, recordedSteps: [], status: "No workflow recorded.", tabId: null };
  }

  async getWorkflowTargetTab(preferredTabId = null) {
    if (preferredTabId) {
      try {
        const tab = await chrome.tabs.get(preferredTabId);
        if (Utils.isInjectableTab(tab)) return tab;
      } catch (e) {}
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  getWorkflowRecorderScript() {
    return () => {
      const loadSteps = async () => {
        try {
          const key = `workflowSteps:${location.origin}:${location.pathname}`;
          const data = await chrome.storage.local.get([key]);
          return Array.isArray(data[key]) ? data[key] : [];
        } catch (e) {
          return [];
        }
      };

      const persistSteps = async () => {
        try {
          const key = `workflowSteps:${location.origin}:${location.pathname}`;
          await chrome.storage.local.set({ [key]: window.__workflowSteps || [] });
        } catch (e) {}
        try {
          chrome.runtime.sendMessage({
            type: "WORKFLOW_SYNC_STEPS",
            steps: window.__workflowSteps || [],
            tabId: window.__workflowTabId || null,
            status: `Recording... ${window.__workflowSteps?.length || 0} step(s) captured`
          });
        } catch (e) {}
      };

      const buildSelector = (el) => {
        if (!el) return null;
        if (el.id) return `#${CSS.escape(el.id)}`;
        if (el.getAttribute("name")) return `${el.tagName.toLowerCase()}[name="${el.getAttribute("name")}"]`;
        if (el.getAttribute("data-testid")) return `[data-testid="${el.getAttribute("data-testid")}"]`;
        if (el.getAttribute("aria-label")) return `${el.tagName.toLowerCase()}[aria-label="${el.getAttribute("aria-label")}"]`;
        if (el.placeholder) return `${el.tagName.toLowerCase()}[placeholder="${el.placeholder}"]`;
        if (el.type) return `${el.tagName.toLowerCase()}[type="${el.type}"]`;
        return el.tagName.toLowerCase();
      };

      const upsertFillStep = (selector, value) => {
        const steps = window.__workflowSteps;
        const last = steps[steps.length - 1];
        if (last && last.action === "fillInput" && last.selector === selector && last.url === location.href) {
          last.value = value;
          last.timestamp = Date.now();
        } else {
          steps.push({ action: "fillInput", selector, value, url: location.href, timestamp: Date.now() });
        }
      };

      const clickListener = (e) => {
        if (!window.__workflowRecording) return;
        const el = e.target?.closest("a, button, input, select, textarea, [role='button'], [onclick]");
        if (!el) return;
        const selector = buildSelector(el);
        if (!selector) return;
        window.__workflowSteps.push({
          action: "click",
          selector,
          url: location.href,
          timestamp: Date.now(),
          text: (el.innerText || el.value || "").substring(0, 80)
        });
        persistSteps();
      };

      const inputListener = (e) => {
        if (!window.__workflowRecording) return;
        const el = e.target;
        if (!el || !["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return;
        const selector = buildSelector(el);
        if (!selector) return;

        if (el.tagName === "SELECT" || el.type === "checkbox" || el.type === "radio") {
          upsertFillStep(selector, el.type === "checkbox" ? Boolean(el.checked) : el.value);
        } else {
          upsertFillStep(selector, el.value);
        }
        persistSteps();
      };

      if (window.__workflowListeners) {
        document.removeEventListener("click", window.__workflowListeners.click, true);
        document.removeEventListener("input", window.__workflowListeners.input, true);
        document.removeEventListener("change", window.__workflowListeners.change, true);
      }

      return (async () => {
        window.__workflowSteps = await loadSteps();
        window.__workflowTabId = window.__workflowTabId || null;
        window.__workflowRecording = true;
        window.__workflowListeners = {
          click: clickListener,
          input: inputListener,
          change: inputListener
        };

        document.addEventListener("click", window.__workflowListeners.click, true);
        document.addEventListener("input", window.__workflowListeners.input, true);
        document.addEventListener("change", window.__workflowListeners.change, true);
        await persistSteps();

        return {
          ok: true,
          url: location.href,
          stepCount: window.__workflowSteps.length
        };
      })();
    };
  }

  async startRecording() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!Utils.isInjectableTab(tab)) {
      document.getElementById("workflowStatus").innerText = "⚠️ Go to a real website first, then click Record.";
      return;
    }
    await chrome.runtime.sendMessage({
      type: "WORKFLOW_SET_RECORDING",
      recording: true,
      tabId: tab.id,
      status: "⏺ Recording... Interact with the page, then reopen Atom.AI to stop."
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: this.getWorkflowRecorderScript()
    });
    await this.updateWorkflowUI();
  }

  async stopRecording() {
    const state = await this.getWorkflowState();
    const tab = await this.getWorkflowTargetTab(state.tabId);
    if (!Utils.isInjectableTab(tab)) {
      document.getElementById("workflowStatus").innerText = "⚠️ Could not reconnect to the recorded tab.";
      return;
    }

    let steps = [];
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          window.__workflowRecording = false;
          if (window.__workflowListeners) {
            document.removeEventListener("click", window.__workflowListeners.click, true);
            document.removeEventListener("input", window.__workflowListeners.input, true);
            document.removeEventListener("change", window.__workflowListeners.change, true);
          }
          return (async () => {
            let savedSteps = window.__workflowSteps || [];
            if (!savedSteps.length) {
              try {
                const key = `workflowSteps:${location.origin}:${location.pathname}`;
                const data = await chrome.storage.local.get([key]);
                if (Array.isArray(data[key])) savedSteps = data[key];
                await chrome.storage.local.remove([key]);
              } catch (e) {}
            }
            return savedSteps;
          })();
        }
      });
      steps = res?.[0]?.result || [];
    } catch (e) {
      steps = state.recordedSteps || [];
    }

    if (!steps.length && state.recordedSteps?.length) {
      steps = state.recordedSteps;
    }

    await chrome.runtime.sendMessage({ type: "WORKFLOW_SAVE_STEPS", steps });
    await this.updateWorkflowUI();
  }

  async replayWorkflow() {
    const state = await this.getWorkflowState();
    const steps = state.recordedSteps || [];
    if (!steps.length) {
      document.getElementById("workflowStatus").innerText = "No workflow to replay.";
      return;
    }
    const btn = document.getElementById("workflowReplay");
    if (btn) btn.disabled = true;
    document.getElementById("workflowStatus").innerText = "▶ Replaying...";
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let currentUrl = tab?.url || "";
    let failedSteps = 0;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      try {
        if (step.url && currentUrl !== step.url) {
          await chrome.tabs.update(tab.id, { url: step.url });
          await Utils.waitForTab(tab.id, 10000);
          await Utils.wait(800);
          currentUrl = step.url;
        }
        if (step.action === "click") {
          const clickRes = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (sel, txt) => {
              const el = document.querySelector(sel);
              if (el) {
                el.scrollIntoView({ block: "center" });
                el.click();
                return { ok: true, mode: "selector" };
              }
              const normalized = (txt || "").toLowerCase().trim();
              if (normalized) {
                const candidates = [...document.querySelectorAll("a,button,[role='button'],input[type='button'],input[type='submit']")];
                const byText = candidates.find((node) =>
                  (node.innerText || node.value || node.getAttribute("aria-label") || "").toLowerCase().includes(normalized)
                );
                if (byText) {
                  byText.scrollIntoView({ block: "center" });
                  byText.click();
                  return { ok: true, mode: "text" };
                }
              }
              return { ok: false };
            },
            args: [step.selector, step.text || ""]
          });
          if (!clickRes?.[0]?.result?.ok) failedSteps++;
        } else if (step.action === "fillInput") {
          const fillRes = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (sel, val, labelText) => {
              const el = document.querySelector(sel);
              if (el) {
                el.focus();
                if (typeof val === "boolean" && el.type === "checkbox") {
                  el.checked = val;
                } else {
                  el.value = val;
                }
                el.dispatchEvent(new Event("input", { bubbles: true }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
                return { ok: true, mode: "selector" };
              }
              const normalized = (labelText || "").toLowerCase().trim();
              if (normalized) {
                const inputCandidates = [...document.querySelectorAll("input,textarea,select")];
                const byHint = inputCandidates.find((node) => {
                  const hint = `${node.placeholder || ""} ${node.name || ""} ${node.id || ""} ${(node.getAttribute("aria-label") || "")}`.toLowerCase();
                  return hint.includes(normalized);
                });
                if (byHint) {
                  byHint.focus();
                  if (typeof val === "boolean" && byHint.type === "checkbox") byHint.checked = val;
                  else byHint.value = val;
                  byHint.dispatchEvent(new Event("input", { bubbles: true }));
                  byHint.dispatchEvent(new Event("change", { bubbles: true }));
                  return { ok: true, mode: "hint" };
                }
              }
              return { ok: false };
            },
            args: [step.selector, step.value, step.text || ""]
          });
          if (!fillRes?.[0]?.result?.ok) failedSteps++;
        }
        await Utils.wait(600);
      } catch (e) {
        failedSteps++;
      }
    }
    const successCount = Math.max(0, steps.length - failedSteps);
    document.getElementById("workflowStatus").innerText = failedSteps
      ? `Replayed ${successCount}/${steps.length} steps. ${failedSteps} step(s) failed.`
      : `Replayed ${steps.length} steps.`;
    if (btn) btn.disabled = false;
  }
  async clearWorkflow() {
    await chrome.runtime.sendMessage({ type: "WORKFLOW_CLEAR" });
    this.updateWorkflowUI();
  }

  async updateWorkflowUI() {
    const state = await this.getWorkflowState();
    if (!state) return;
    document.getElementById("workflowStatus").innerText = state.status;
    document.getElementById("workflowRecord").disabled = state.recording;
    document.getElementById("workflowStop").disabled = !state.recording;
    document.getElementById("workflowReplay").disabled = state.recordedSteps.length === 0;
    const stepCount = document.getElementById("workflowStepCount");
    const liveBadge = document.getElementById("workflowLiveBadge");
    const stateLabel = document.getElementById("workflowStateLabel");
    if (stepCount) stepCount.innerText = String(state.recordedSteps.length || 0);
    if (liveBadge) liveBadge.innerText = state.recording ? "Recording" : (state.recordedSteps.length ? "Ready to replay" : "Idle");
    if (stateLabel) stateLabel.innerText = state.recording ? "Capturing" : (state.recordedSteps.length ? "Saved" : "Ready");
  }

  showLoader(show, msg) {
    const l = document.getElementById("loader");
    if (l) {
      l.style.display = show ? "block" : "none";
      if (msg) l.innerText = "⚡ " + msg;
    }
  }

  setResult(text) {
    const r = this.getResultEl();
    if (r) r.innerText = text;
    document.dispatchEvent(new CustomEvent("atom:result-meta", {
      detail: {
        area: "automate",
        text,
        signal: text && text.length > 500 ? "Deep output" : "Quick output"
      }
    }));
    this.pushResult(text);
  }

  pushResult(text) {
    if (!text || text === "Result will appear here...") return;
    if (this.resultHistory[this.resultHistory.length - 1] === text) return;
    this.resultHistory.push(text);
    if (this.resultHistory.length > 10) this.resultHistory.shift();
    this.resultIndex = this.resultHistory.length - 1;
    this.updateResultNav();
    Utils.setBoundedStorageArray("resultHistory", this.resultHistory, {
      maxItems: 10,
      minItems: 3,
      trimStep: 2
    }).catch(() => {});
    chrome.storage.local.set({ resultIndex: this.resultIndex });
  }

  updateResultNav() {
    const counter = document.getElementById("resultCounter");
    if (counter) {
      counter.innerText = this.resultHistory.length ? `${this.resultIndex+1}/${this.resultHistory.length}` : "";
    }
  }

  prevResult() {
    if (this.resultIndex > 0) {
      this.resultIndex--;
      const text = this.resultHistory[this.resultIndex];
      const r = this.getResultEl();
      if (r) r.innerText = text;
      document.dispatchEvent(new CustomEvent("atom:result-meta", {
        detail: {
          area: "automate",
          text,
          signal: text && text.length > 500 ? "Deep output" : "Quick output"
        }
      }));
      this.updateResultNav();
    }
  }

  nextResult() {
    if (this.resultIndex < this.resultHistory.length - 1) {
      this.resultIndex++;
      const text = this.resultHistory[this.resultIndex];
      const r = this.getResultEl();
      if (r) r.innerText = text;
      document.dispatchEvent(new CustomEvent("atom:result-meta", {
        detail: {
          area: "automate",
          text,
          signal: text && text.length > 500 ? "Deep output" : "Quick output"
        }
      }));
      this.updateResultNav();
    }
  }

  async copyResult() {
    const text = this.getResultEl()?.innerText || "";
    await navigator.clipboard.writeText(text);
    const btn = document.getElementById("copy");
    if (btn) {
      const prev = btn.innerText;
      btn.innerText = "✅ Copied!";
      setTimeout(() => btn.innerText = prev, 1200);
    }
  }

  convertToMarkdownTable(text) {
    const raw = String(text || "").trim();
    const arr = this.safeParseJsonArray(raw);
    if (arr?.length) {
      const cols = Array.from(new Set(arr.flatMap((r) => Object.keys(r || {}))));
      const head = `| ${cols.join(" | ")} |`;
      const sep = `| ${cols.map(() => "---").join(" | ")} |`;
      const rows = arr.map((row) => `| ${cols.map((c) => String(row?.[c] ?? "")).join(" | ")} |`);
      return [head, sep, ...rows].join("\n");
    }
    if (raw.includes("\t")) {
      return raw.split(/\r?\n/).map((line, idx) => {
        const row = `| ${line.split("\t").map((x) => x.trim()).join(" | ")} |`;
        if (idx === 0) {
          const sep = `| ${line.split("\t").map(() => "---").join(" | ")} |`;
          return `${row}\n${sep}`;
        }
        return row;
      }).join("\n");
    }
    return raw;
  }

  async copyAsMarkdownTable() {
    const text = this.getResultEl()?.innerText || "";
    await navigator.clipboard.writeText(this.convertToMarkdownTable(text));
  }

  async exportResultToSheets() {
    const text = this.getResultEl()?.innerText || "";
    const tsv = Utils.textToTSV(text);
    const res = await this.tryWriteToGoogleSheets(tsv);
    this.setAutomationStatus(res.ok ? "Prepared Google Sheets export." : res.reason);
  }

  async saveResult() {
    const text = document.getElementById("result").innerText;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const d = await chrome.storage.local.get(["notes"]);
    const notes = d.notes || [];
    notes.push({ text, savedAt: new Date().toLocaleString(), url: tab?.url || "" });
    const save = await Utils.setBoundedStorageArray("notes", notes, {
      maxItems: 200,
      minItems: 25,
      trimStep: 10
    });
    if (!save.ok) await Utils.writeDebugLog(`Failed to save notes: ${save.error?.message || "quota error"}`, "warn");
    const btn = document.getElementById("save");
    if (btn) {
      const prev = btn.innerText;
      btn.innerText = "✅ Saved!";
      setTimeout(() => btn.innerText = prev, 1200);
    }
  }

  exportResult() {
    const blob = new Blob([this.getResultEl()?.innerText || ""], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "atom_research.txt";
    a.click();
  }

  async clearNotes() {
    if (confirm("Clear all saved notes?")) {
      await chrome.storage.local.remove("notes");
      this.setResult("🗑️ Notes cleared.");
    }
  }
}








