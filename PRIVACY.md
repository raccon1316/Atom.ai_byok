# Atom.AI — Privacy Policy

**Last updated: September 18, 2026**

## Summary

Atom.AI runs entirely in your browser. Your data stays on your device unless you explicitly configure it to call your own LLM provider (Groq). We do not operate a backend that receives your page content, API keys, or research results.

## 1. API-Key Storage

- Your Groq API key (and selected model, e.g. `openai/gpt-oss-20b`) is stored **only** in `chrome.storage.local` on your device (`popup.js` load, `Settings.js` `load()`, `background.js` `hydrateState()`).
- The key is never transmitted to Atom.AI servers, never logged, and never included in analytics or webhooks unless you configure a webhook.
- `chrome.storage.session` is briefly used for the in-memory session key; it is cleared on `Reset Extension` (`Settings.js` `resetExtension()`).
- You can view, verify, or clear the key at any time in **Settings → Groq API Key → Clear Key** (Settings panel). Clearing removes it from `storage.local` immediately.

## 2. Page-Content Handling

- **When you run a feature** (Battle Card, Compare Open Tabs, Company Brief, Multi-tab Research, page extraction), the extension reads `document.title` and visible `innerText` from the relevant tab(s) via `chrome.scripting.executeScript` (`background.js` `executeInTab`/`workerGetPageText`, `utils.js` `getPageText`). The injected function strips `script/style/noscript/template` tags and truncates to ~3000–8000 chars per source.
- For **competitor battle cards** the service worker opens competitor URLs in hidden tabs (`background.js` `workerOpenAndReadUrl`), extracts the same limited text, and closes the tabs immediately after extraction. Google search snippets (if used) are fetched via the same hidden-tab path.
- Page text is assembled locally and, if AI generation is requested, sent **only** to the LLM endpoint you configured (`ai.js` `buildEndpoint()` → `https://api.groq.com/openai/v1/chat/completions`). No intermediate proxy is used; the request goes directly from your browser to Groq with your `Authorization: Bearer <key>` header.
- If no API key is set, or the provider returns `401/403`, a human-readable error is shown locally and no retry with a different provider occurs. Prompts are never cached server-side by Atom.AI.

## 3. No Data Leaves the Device Except to Your Configured LLM Provider

- **Default:** Only two network destinations are contacted: (a) the competitor / search URLs you explicitly ask to crawl (standard `https` fetches via hidden tabs), and (b) `https://api.groq.com/openai/v1/chat/completions` (your LLM provider).
- **Optional webhook:** If you set a Webhook URL in Settings (`Settings.js` API-key/webhook save), completed research reports are `POST`ed as JSON to that URL. If the field is empty, no webhook call is made.
- **No analytics backend:** The extension does not send page content, history, notes, or API keys to `atomai.pro` or any other Atom.AI endpoint, except the uninstall URL (`background.js` `onInstalled` → `chrome.runtime.setUninstallURL`) and optional license verification `https://atomai.pro/api/license/verify` (`background.js` `VERIFY_LICENSE` handler) which transmits only `{licenseKey, extensionId}` when you use Pro.
- **No cookies, no trackers, no fingerprinting.**

## 4. Analytics Stored Locally

- All “analytics” are local aggregates stored in `chrome.storage.local`:
  - `quotaState` (per-minute and daily AI call counts) (`background.js` `enforceQuotaAndIncrement`) — used for the 25/minute safety limit.
  - `automationMetrics` (`automate.js` `trackAutomationMetrics` → `{runs, localSuccessCount, aiFallbackCount, totalDurationMs}`).
  - `jobs` queue (cap 50, FIFO) and `researchHistory` (cap 100) (`jobs.js` `saveJobs`, `background.js` `saveToHistoryWorker`).
- You can export all local data (Settings → Data Management → Export All Data) or wipe it (`Settings.js` `resetExtension()` → `chrome.storage.local.clear()`).

## 5. Data Retention & Control

- **Retention:** Data persists until you clear it. Jobs auto-evict oldest entries after 50 items; history after 100; debug logs after 200 entries (`background.js` `appendDebugLog` cap).
- **Export / Import / Reset:** Settings → Data Management provides one-click export (JSON), import, and reset. Reset removes `chrome.storage.local` and `chrome.storage.session` and reloads the extension.
- **Host access:** Broad host access (`https://*/*`, `http://*/*`) is now `optional_host_permissions`. It is requested **once**, at first crawl, with the in-popup banner: “Atom needs access to read page content on competitor sites to build battle cards — one click to grant.” (Home tab `#hostPermBanner`, `popup.js` `ensureHostPermission()`). Denying blocks crawling but does not affect stored data.

## 6. Content Security

- No `eval()`, `new Function()`, or `http://` script sources are used in the bundle (verified via `grep -R "eval\\("` / `new Function` / `http://` → clean, except the `http://*/*` optional host pattern in `manifest.json` itself). All scripts are bundled and loaded with `type: "module"` under Manifest V3 CSP.

## 7. Children & Sensitive Data

- The extension is not directed to children under 13. Avoid processing pages that contain highly sensitive personal data; if you do, that data will be included in the prompt sent to your LLM provider as described above and stored locally in history/notes until you clear it.

## 8. Changes

- This policy is versioned with the extension. Updates will be reflected here and linked from **Settings → Privacy** (`#privacyLink` in the Settings panel → `chrome.runtime.getURL("PRIVACY.md")`).

## 9. Contact

- For privacy questions: open an issue at `https://github.com/anomalyco/opencode` or email the maintainer listed in the Chrome Web Store listing.

---

*If you do not agree with this policy, do not grant host permissions and do not enter an API key — the extension will remain inert.*
