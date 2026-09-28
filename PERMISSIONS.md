# Atom.AI — Permissions Audit (Phase 6)

Every permission declared in `manifest.json` is mapped to the exact code location(s) that require it and a one-sentence justification. No blanket or unused permissions remain.

| Permission | Declared In | Used In (file:line, re-audited 2026-09-19) | Justification |
|---|---|---|---|
| `activeTab` | `manifest.json:32` → `permissions` | `research.js:99` (`chrome.tabs.query({active:true})`), `automate.js:63` (`getActiveTab`), `utils.js:152` (`getReadableTabs`) | Grants temporary, one-click access to the *currently active* tab so Battle Card / Compare Open Tabs can read `document.title`/`innerText` without pre-granted host access; no background crawling. |
| `scripting` | `manifest.json:33` → `permissions` | `background.js:338` (`executeInTab` → `chrome.scripting.executeScript`), `background.js:390` (`workerGetPageText`), `utils.js:94` (`getPageText`), `automate.js:439` (`collectStructuredPageData`) | Required to inject the small content-extraction function that reads and cleans page text; all other "read page" helpers delegate through this single API. |
| `tabs` | `manifest.json:34` → `permissions` | `background.js:350` (`chrome.tabs.get`), `background.js:414` (`chrome.tabs.query`), `background.js:463` (`chrome.tabs.create`), `background.js:481` (`chrome.tabs.remove`), `utils.js:152` (`getReadableTabs`), `research.js:99` (query active tab) | Needed to enumerate open tabs for multi-tab research and Compare Open Tabs, to `create`/`remove` hidden tabs that fetch competitor URLs, and to query the active tab for context. |
| `storage` | `manifest.json:35` → `permissions` | `background.js:220` (`chrome.storage.local.get` hydrate), `jobs.js:43` (`chrome.storage.local.get([JOBS_KEY])`), `popup.js:139` (jobs list), `history.js:13` (research history) | Persists user settings (Groq API key, model), jobs queue (cap 50 FIFO), research history, notes, monitor state, funnel analytics + launchMetrics, and triage log; all data stays local. |
| `alarms` | `manifest.json:36` → `permissions` | `background.js:130` (`chrome.alarms.create(HEARTBEAT_ALARM)` heartbeat), `background.js:1387` (`monitor_*` periodic checks) | Keeps the MV3 service worker alive during long jobs (heartbeat + storage-liveness fallback) and schedules periodic competitor-monitor checks. |
| `optional_host_permissions` `https://*/*` + `http://*/*` | `manifest.json:39` → `optional_host_permissions` | `background.js:498` (`chrome.permissions.contains` gate), `popup.js:216`/`popup.js:219` (`ensureHostPermission` → `chrome.permissions.request`) | Only requested *at first crawl* via `chrome.permissions.request` (one-line banner in `popup.html` + `popup.js:ensureHostPermission`). Allows the worker to open and read arbitrary competitor domains in hidden tabs; denied → job fails with "Grant host access" and no network call is made. |

## Removed / Not Declared

| Permission | Reason Not Declared |
|---|---|
| `notifications` | No code calls `chrome.notifications.*` (verified via `grep -rn "chrome.notifications" .` → zero live-code hits 2026-09-18; `monitor.js` renders alerts into `#monitorResult` in-popup). Phase 7 audit decision: **keep removed**. Job completion/monitor alerts surface via in-popup badge/banner + `chrome.action.setBadgeText` (`background.js: setJobBadge`, cleared on popup open) — needs no permission. |
| `host_permissions` (blanket) | Replaced by `optional_host_permissions` as required by store hygiene; host access is now explicit, user-gated, and explained in-popup. |
| `identity`, `cookies`, `webRequest`, etc. | Not used anywhere; not declared. |

## Verification

```bash
grep -R "chrome\\.tabs\\." --include="*.js"      # tabs
grep -R "chrome\\.scripting\\." --include="*.js" # scripting
grep -R "chrome\\.storage\\." --include="*.js"    # storage
grep -R "chrome\\.alarms\\." --include="*.js"     # alarms
grep -R "chrome\\.permissions\\." --include="*.js" # optional host gate
grep -R "notifications" --include="*.js"            # → no hits (removed)
```

Manifest after Phase 6:

```json
"permissions": ["activeTab","scripting","tabs","storage","alarms"],
"optional_host_permissions": ["https://*/*","http://*/*"]
```

Content script `content_scripts` still declares `matches: ["https://*/*","http://*/*"]` for the floating pill / toolbar UI, but *data extraction for crawls* goes through the `scripting`+`tabs` path gated by the optional host grant above.

## Phase 8 addition

`trigger.js` added to `content_scripts` **after** `content.js` (trigger moment banner on competitor sites with saved battle cards). **No new permissions**: the banner decision runs in the SW (`trigger-core.js` via the `TRIGGER_CHECK` message), storage already covered by `storage`, popup opening uses `chrome.action.openPopup()` (no permission) with a `chrome.action.setBadgeText` fallback, and dismissal persistence uses `chrome.storage.local` (`triggerDismissals`, once per domain per day).

## Deal Room addition (no new permissions)

Deal Room (`multitab.js` classifier, `dealroom.js` prompts/validator, `claims-ui.js` renderer, `runDealRoomJob` in the SW) reuses the exact APIs the battle-card pipeline already justified: `tabs` (read open tabs, open/close hidden crawl tabs), `scripting` (page-text extraction), `storage` (jobs, history type `dealroom`), `alarms` (heartbeat/liveness), and `optional_host_permissions` (crawl gate). No manifest changes.

## Share the card + Monitoring v0 additions (no new permissions)

Share (`share.js` builders, `SHARE_SLACK` POST to the user's own webhook URL, clipboard copies) uses `fetch` to a user-configured `https://hooks.slack.com/` endpoint and `navigator.clipboard` — neither needs a manifest permission. Monitoring v0 (`monitor-v0.js`, `weekly-refresh` alarm at 10080 min, `runWeeklyRefresh`, `REVERIFY_CARD`) reuses `alarms` (already declared), `tabs`/`scripting` (light re-crawl), `storage` (`monitorState`), and `chrome.action.setBadgeText` (no permission; `notifications` stays removed). No manifest changes.

## Side Panel addition (Feature 6)

`sidePanel` added to `permissions` (manifest.json). Used in: `side-panel.js:initSidePanel` (called from `background.js` startup) → `chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true})`. Justification: opens Atom.AI as a persistent side panel on toolbar click instead of a popup that closes on the first click away — a UX change only; the API surfaces no new data. Paired manifest change: `side_panel.default_path: "popup.html"` declared and `action.default_popup` REMOVED (Chrome opens the popup instead of the panel if both are present). Backward compat: on Chrome <114 the `sidePanel` API is absent, so `initSidePanel` restores the popup as the click target via `chrome.action.setPopup({popup:"popup.html"})` — the extension is never left without a click surface. `body` width is `min(400px, 100vw)` so the 400px layout fits the ~360-400px panel.
