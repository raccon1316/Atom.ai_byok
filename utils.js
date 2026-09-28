export const Utils = {
  async mapWithConcurrency(items, mapper, concurrency = 3) {
    const list = Array.isArray(items) ? items : [];
    const limit = Math.max(1, Number(concurrency) || 1);
    const results = new Array(list.length);
    let nextIndex = 0;

    const worker = async () => {
      while (nextIndex < list.length) {
        const currentIndex = nextIndex++;
        results[currentIndex] = await mapper(list[currentIndex], currentIndex);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(limit, list.length) }, () => worker())
    );
    return results;
  },

  async setBoundedStorageArray(key, items, options = {}) {
    const {
      maxItems = 100,
      minItems = 10,
      trimStep = 10,
      onTrim = null
    } = options;

    let nextItems = Array.isArray(items) ? items.slice(0, maxItems) : [];
    const floor = Math.max(1, Math.min(minItems, maxItems));
    const step = Math.max(1, trimStep);

    // The write is attempted at least once, unconditionally.
    //
    // This used to be `while (nextItems.length >= floor)`, which meant an array
    // SMALLER than minItems was never written at all: the loop body never ran,
    // the function returned {ok:false}, and the caller's data was silently
    // dropped. Every caller passes a minItems floor larger than a fresh list
    // (notes 25, researchHistory 20, resultHistory 3), so "save the first note"
    // and the first couple of research entries were lost every time.
    //
    // minItems is a floor for TRIMMING under quota pressure, not a precondition
    // for writing.
    for (;;) {
      try {
        await chrome.storage.local.set({ [key]: nextItems });
        return { ok: true, count: nextItems.length, trimmed: Array.isArray(items) ? items.length - nextItems.length : 0 };
      } catch (error) {
        const isQuotaError = /quota|max.*bytes|limit/i.test(String(error?.message || ""));
        if (!isQuotaError) {
          return { ok: false, error };
        }
        // Trim only if that actually shortens the list, and never past the
        // floor. If it cannot shrink any further, report the real failure
        // instead of looping forever on an unshrinkable array.
        const nextLength = Math.max(floor, nextItems.length - step);
        if (nextLength >= nextItems.length) {
          return { ok: false, error };
        }
        nextItems = nextItems.slice(0, nextLength);
        if (typeof onTrim === 'function') onTrim();
      }
    }
  },

  async writeDebugLog(message, level = 'info') {
    const data = await chrome.storage.local.get(['debugLogs']);
    const logs = Array.isArray(data.debugLogs) ? data.debugLogs : [];
    logs.unshift({
      ts: new Date().toISOString(),
      level: String(level || 'info'),
      message: String(message || '')
    });
    await chrome.storage.local.set({ debugLogs: logs.slice(0, 100) });
  },

  textToTSV(text = '') {
    const clean = String(text || '').trim();
    if (!clean) return '';
    if (clean.includes('\t')) return clean;
    const lines = clean.split(/\r?\n/).filter(Boolean);
    if (!lines.length) return '';
    if (lines[0].includes(',')) {
      return lines.map((line) => line.split(',').map((c) => c.trim()).join('\t')).join('\n');
    }
    return 'value\n' + lines.map((line) => line.replace(/\t/g, ' ')).join('\n');
  },

  async tryWriteToGoogleSheets(tsv) {
    const payload = String(tsv || '').trim();
    if (!payload) return { ok: false, reason: 'No data provided.' };
    try {
      const sheetsUrl = 'https://docs.google.com/spreadsheets/create';
      await chrome.tabs.create({ url: sheetsUrl, active: true });
      await navigator.clipboard.writeText(payload);
      return { ok: true, reason: 'Opened Google Sheets and copied TSV. Paste into cell A1.' };
    } catch (e) {
      try {
        await navigator.clipboard.writeText(payload);
        return { ok: false, reason: 'Copied to clipboard. Paste manually in Google Sheets.' };
      } catch {
        return { ok: false, reason: e?.message || 'Failed to prepare Google Sheets export.' };
      }
    }
  },
  cleanText(text = '', maxLength = 6000) {
    return String(text || '').replace(/\s+/g, ' ').trim().substring(0, maxLength);
  },

  async getPageText(tabId, maxLength = 6000) {
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: (maxLen) => {
          const cleanClone = document.body?.cloneNode(true);
          if (cleanClone) {
            cleanClone.querySelectorAll('script,style,noscript,template').forEach((el) => el.remove());
          }

          const candidates = [
            document.querySelector('article'),
            document.querySelector('main'),
            document.querySelector('[role="main"]'),
            document.querySelector('.main'),
            cleanClone,
            document.body
          ].filter(Boolean);

          const best = candidates.sort((a, b) => (b.innerText || '').length - (a.innerText || '').length)[0] || document.body;
          const text = [document.title || '', best?.innerText || document.body?.innerText || ''].join('\n\n');
          return String(text || '').replace(/\s+/g, ' ').trim().substring(0, maxLen);
        },
        args: [maxLength]
      });
      return res?.[0]?.result || '';
    } catch (e) {
      return '';
    }
  },

  wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },

  isInjectableTab(tab) {
    if (!tab?.url) return false;
    const bad = ['chrome://', 'chrome-extension://', 'about:', 'edge://', 'brave://', 'devtools://', 'view-source:'];
    return !bad.some((prefix) => tab.url.startsWith(prefix));
  },

  isReadableHttpUrl(url) {
    return /^https?:\/\//i.test(url || '');
  },

  normalizeDomain(url) {
    try {
      return new URL(url).hostname.replace(/^www\./i, '');
    } catch {
      return 'unknown';
    }
  },

  safeTabLabel(tab) {
    if (!tab) return 'Unknown tab';
    return (tab.title || this.normalizeDomain(tab.url) || 'Untitled tab').trim();
  },

  async getReadableTabs(options = {}) {
    const {
      currentWindow = true,
      maxTabs = 5,
      excludeTabId = null,
      includeActive = true
    } = options;

    const tabs = await chrome.tabs.query(currentWindow ? { currentWindow: true } : {});
    const seenUrls = new Set();
    const filtered = tabs.filter((tab) => {
      if (!tab?.id || tab.id === excludeTabId) return false;
      if (!includeActive && tab.active) return false;
      if (!this.isInjectableTab(tab) || !this.isReadableHttpUrl(tab.url)) return false;
      const normalized = (tab.url || '').split('#')[0];
      if (seenUrls.has(normalized)) return false;
      seenUrls.add(normalized);
      return true;
    });

    filtered.sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)));
    return filtered.slice(0, maxTabs);
  },

  async readTabSource(tab, options = {}) {
    const { maxLength = 1800, waitMs = 8000 } = options;
    const source = {
      tabId: tab?.id || null,
      title: this.safeTabLabel(tab),
      url: tab?.url || '',
      domain: this.normalizeDomain(tab?.url),
      text: '',
      ok: false,
      error: ''
    };

    if (!tab?.id || !this.isInjectableTab(tab) || !this.isReadableHttpUrl(tab.url)) {
      source.error = 'Tab is not readable.';
      return source;
    }

    try {
      await this.waitForTab(tab.id, waitMs);
      await this.wait(500);
      const text = await this.getPageText(tab.id, maxLength);
      if (!text || text.length < 80) {
        source.error = 'Not enough readable text on the page.';
        return source;
      }
      source.text = text;
      source.ok = true;
      return source;
    } catch (error) {
      source.error = error?.message || 'Failed to read tab.';
      return source;
    }
  },

  async collectTabSources(tabs, options = {}) {
    const { maxLength = 1800 } = options;
    const sources = [];
    const skipped = [];

    for (const tab of tabs) {
      const source = await this.readTabSource(tab, { maxLength, waitMs: options.waitMs || 8000 });
      if (source.ok) {
        sources.push(source);
      } else {
        skipped.push({
          title: source.title,
          url: source.url,
          reason: source.error || 'Skipped'
        });
      }
    }

    return { sources, skipped };
  },

  async openAndReadUrl(url, options = {}) {
    const { active = false, maxLength = 3000, waitMs = 9000 } = options;
    let tab = null;
    try {
      tab = await chrome.tabs.create({ url, active });
      await this.waitForTab(tab.id, waitMs);
      await this.wait(700);
      const source = await this.readTabSource(tab, { maxLength, waitMs: 2000 });
      source.url = url;
      source.domain = this.normalizeDomain(url);
      return source;
    } catch (error) {
      return {
        tabId: tab?.id || null,
        title: this.safeTabLabel(tab),
        url,
        domain: this.normalizeDomain(url),
        text: '',
        ok: false,
        error: error?.message || 'Failed to open URL.'
      };
    } finally {
      if (tab?.id) {
        try { await chrome.tabs.remove(tab.id); } catch (e) {}
      }
    }
  },

  formatSourceList(sources = []) {
    return sources.map((source, index) => `${index + 1}. ${source.domain} - ${source.title}`).join('\n');
  },

  async getGoogleLinks(tabId) {
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const links = [];
          document.querySelectorAll('a h3').forEach((el) => {
            const a = el.closest('a');
            if (a && a.href && !a.href.includes('google.com')) links.push(a.href);
          });
          return links.slice(0, 4);
        }
      });
      return res?.[0]?.result || [];
    } catch {
      return [];
    }
  },

  async waitForTab(tabId, ms = 10000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete') return true;
      } catch {
        return false;
      }
      await this.wait(500);
    }
    return false;
  },

  async googleResearch(query) {
    try {
      const url = 'https://www.google.com/search?q=' + encodeURIComponent(query);
      const source = await this.openAndReadUrl(url, { active: false, maxLength: 5000, waitMs: 7000 });
      return source.text || '';
    } catch {
      return '';
    }
  },

  async collectStructuredPageData(url, aiInstance) {
    try {
      const source = await this.openAndReadUrl(url, { active: false, maxLength: 5000, waitMs: 9000 });
      if (!source.ok || !source.text) {
        return {
          url,
          pricing: 'N/A',
          features: 'N/A',
          targetAudience: 'N/A',
          recentNews: 'N/A',
          error: source.error || 'Failed to extract data'
        };
      }

      const news = await this.googleResearch(`${new URL(url).hostname} recent news 2026`);
      const combinedData = `PAGE CONTENT:\n${source.text}\n\nRECENT NEWS:\n${news.substring(0, 1500)}`;

      const prompt = `Extract the following structured information from the data below. Return ONLY a JSON object with these exact keys:
- pricing: pricing information (plans, tiers, costs)
- features: key features and capabilities
- targetAudience: who this product/service is for
- recentNews: recent news or updates

DATA:
${combinedData.substring(0, 8000)}`;

      const aiResponse = await aiInstance.chat(prompt, 800);
      
      let structuredData;
      try {
        const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          structuredData = JSON.parse(jsonMatch[0]);
        } else {
          structuredData = {
            pricing: aiResponse.substring(0, 200) || 'N/A',
            features: aiResponse.substring(200, 600) || 'N/A',
            targetAudience: aiResponse.substring(600, 800) || 'N/A',
            recentNews: news.substring(0, 300) || 'N/A'
          };
        }
      } catch {
        structuredData = {
          pricing: 'Could not extract',
          features: 'Could not extract',
          targetAudience: 'Could not extract',
          recentNews: news.substring(0, 300) || 'N/A'
        };
      }

      return {
        url,
        domain: source.domain,
        pricing: structuredData.pricing || 'N/A',
        features: structuredData.features || 'N/A',
        targetAudience: structuredData.targetAudience || 'N/A',
        recentNews: structuredData.recentNews || news.substring(0, 300) || 'N/A'
      };
    } catch (error) {
      return {
        url,
        pricing: 'N/A',
        features: 'N/A',
        targetAudience: 'N/A',
        recentNews: 'N/A',
        error: error?.message || 'Failed to collect data'
      };
    }
  }
};
