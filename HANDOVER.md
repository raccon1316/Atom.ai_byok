# HANDOVER — Feature session (2026-09-26)

Commits `f9ac8ec`…`9d91fe9` on `master`. Suite: **485 passing / 0 failing across 35 files**
(run each with plain `node qa/test-<file>`; `qa/test-background-load.js` needs
`node --experimental-vm-modules` — it does not self-respawn).

## 1. Built vs specified — the 7 features

1. **Email Drafter** — Built as specified. Deviations, both pre-approved: all 3 variants come
   from ONE structured AI call (not 3 parallel calls), and the brief context passed to the model
   is the dense-section slice (pain/news/who-to-call), with "DO NOT REFERENCE" and confidence
   sections explicitly excluded so the model can't leak them into an email.
2. **LinkedIn Auto-Brief** — Built with changes. (a) `LINKEDIN_CONTEXT` did not exist anywhere
   despite the brief's file map claiming it — built from scratch; the SW handler lives in
   `background.js` (the real router), not `automate.js`. (b) Banner additionally checks the
   ACTIVE tab URL matches the stored context before showing — a stale context from another tab
   must not hijack the popup (spec was silent on staleness). (c) Dismissal ledger is normalized-URL
   keyed, FIFO 20, and also clears the live context. Selectors are best-guess and must be
   verified live (see §3).
3. **Objection Handler** — Built as specified, plus the approved `profile.js` integration: the
   Proof strategy must cite the user's own saved proof points (claim + metric) when present, with
   honest "no proof points on file" fallback wording. Separate module from `objection-lib.js` as
   required.
4. **MEDDIC Qualify chip** — Built as specified, plus the approved per-URL+content-hash cache
   (FIFO 20, chrome.storage.local) with a visible "cached" timestamp; the prompt also receives the
   seller's own company name from the profile for relevance. Color logic and "nothing found = red,
   never guess" enforced in both prompt and validator.
5. **Call Transcript Analyzer** — Partial, by your instruction. `.txt/.vtt/.srt` (paste +
   drag-drop), full untruncated transcript (test proves a 40k-word tail survives), 2000-token
   output, all 7 sections, 120s timeout, new 📞 Calls tab. `.docx` is NOT parsed — refused with
   the exact agreed message ("Export your transcript as .txt from Gong/Zoom, or paste it directly
   here."). Full .docx support deferred to a later session.
6. **Chrome Side Panel** — Built with changes (both pre-approved). (a) Uses
   `setPanelBehavior({openPanelOnActionClick:true})` at SW startup instead of intercepting
   `chrome.action.onClicked`. (b) Because `default_popup` must be removed, old Chrome (<114,
   no sidePanel API) would get a DEAD toolbar click — `initSidePanel()` restores the popup via
   `chrome.action.setPopup()` in that case, and also when `setPanelBehavior` rejects. Body width
   is `min(400px, 100vw)`. `sidePanel` permission documented in PERMISSIONS.md.
7. **HubSpot CRM Push** — Built with changes. (a) Deep link needs a portal id the companies API
   never returns — fetched once from `/oauth/v3/access-tokens/{token}` and cached; if that fails,
   the success message links to `https://app.hubspot.com/contacts/` (picker) instead of a dead URL
   (approved approach). (b) Note→company association uses the v4 "simple association" shape
   (`PUT …/associations/default`, associationTypeId 279) — the spec just said "the associations
   endpoint". (c) Push runs from the popup with global fetch; no SW message type was needed, so
   none was added.

Shared infrastructure (not in the 7, but everything sits on it): `structured.js` `requestJSON()`
(JSON-mode request, fence/prose-tolerant extraction, validation, exactly one repair round-trip,
honest failure) and `ai.js` `timeoutMs`/`json` per-call options.

## 2. Browser test list — cannot be verified by the suite

1. **Side panel**: load unpacked in Chrome 114+; click the toolbar icon → side panel opens on the
   right at ~360–400px, stays open while you click the page behind it, and Ctrl+Shift+A
   (`_execute_action`) also opens it. No vertical layout overflow at 360px on every tab
   (Home/Research/Monitor/Notes/Calls/History + Settings overlay).
2. **Side panel fallback**: on Chrome <114 (or with the sidePanel API force-undefined via devtools
   snippet) clicking the icon must still open the old popup — confirm `setPopup` fallback engages
   rather than nothing happening.
3. **Manifest wiring**: after removing `default_popup`, confirm Chrome does NOT open a popup on
   top of the panel, and that `chrome://extensions` shows no manifest errors for `side_panel`.
4. **Email drafter live path**: generate a real company brief → ✉️ Draft Email → 3 tabs render,
   variants actually reference brief specifics; Copy; Open in Gmail opens a Gmail compose with
   subject/body pre-filled and correctly encoded (emoji, quotes, newlines).
5. **MEDDIC chip live path**: on a real prospect site click 📊 Qualify → scored card renders
   colored; click again → instant "cached" card; edit nothing but confirm a hard reload of the
   page (new content hash) re-scores; confirm quota counter incremented on the first click only.
6. **Objection handler live path**: type a real objection → three expandable cards in
   reframe/proof/clarify order; proof strategy cites YOUR saved profile proof points when the
   profile is filled in; each Copy puts the script (not the title) on the clipboard.
7. **LinkedIn detection live path**: open a real `/in/<slug>` profile, open the popup → banner
   with name + parsed title/company; click Research → person brief for that name runs. Same on
   `/company/<slug>` → company brief. Dismiss → navigate within LinkedIn to another profile →
   new banner appears; return to the dismissed profile → no banner. Confirm content-script errors
   never surface on non-LinkedIn pages.
8. **Call analyzer live path**: paste a real Gong/Zoom export (10k+ words) → Analyze → completes
   within the 120s timeout (does NOT die at 30s), all 7 sections render, follow-up copy works;
   drag a real `.vtt` export onto the textarea → loads; drag a `.docx` → the exact actionable
   error appears in the status line.
9. **HubSpot push live path**: with a real private-app token in Settings → CRM: push a brief to a
   company name that already exists in the portal (note appears on the right record), push a name
   that does not exist (stub created, note attached), second push does not re-request
   introspection, success link opens the actual company record. Then with a revoked token → exact
   401 message; with a scope-less token → exact 403 message.
10. **Popup ↔ SW regression pass**: battle card, deal room, auto task, notes, history, monitor —
    confirm nothing regressed from the manifest change and the new imports (suite covers module
    graphs, not live messaging).
11. **LinkedIn SPA rescan**: click between two profiles without a full page load (LinkedIn is an
    SPA) → the second profile's context replaces the first (signature dedupe working).

## 3. Uncertainty list — confidence not guaranteed

1. **HubSpot portal id**: `/oauth/v3/access-tokens/{token}` is the documented private-app
   introspection route, but its exact response shape for `portalId` was never exercised against a
   live token. If it 404s for some account types, every push still succeeds but deep links fall
   back to the picker — check one live response before trusting the deep link.
2. **HubSpot association type id 279** (note→company, HUBSPOT_DEFINED): correct per current v4
   docs, unverified live. If association silently no-ops, notes would land in the portal but not
   on the company timeline — the failure mode is invisible to tests.
3. **HubSpot CORS from the popup**: brief asserted CRM v3 is CORS-friendly from extensions; with
   optional host access NOT granted, Chrome may block `api.hubapi.com` — the network-error message
   covers it, but whether host access is actually required is unknown until live-tested.
4. **LinkedIn selectors**: `h1` for name and `.text-body-medium.break-words` for headline are
   current-best guesses; LinkedIn ships DOM changes constantly. Degradation is graceful
   (name-only banner, then silence), but if headlines start coming back empty on ALL profiles,
   that's the selector dying, not the feature.
5. **`response_format: json_object` on `openai/gpt-oss-20b`**: Groq accepts JSON mode for most
   models; if gpt-oss rejects it, structured.js falls back to prompt-only (tested) — but the
   fallback path running on EVERY call would double latency unnoticed. Watch the first live call.
6. **structured.js parse edges not covered by tests**: (a) prose AFTER the JSON containing braces
   — extraction takes first `{` to last matching `}`, so trailing `{garbage}` in a closing sentence
   could corrupt the slice; (b) two concatenated JSON objects; (c) fence markers inside string
   values; (d) giant unicode/escaped payloads. The single repair round-trip is the safety net for
   all four, but it costs a second call when it trips.
7. **`timeoutMs=120000` and MV3**: a 2-minute abort timer plus retries (1) can outlive a service
   worker idle kill in theory; liveness/heartbeat currently keeps the SW alive for jobs, but the
   Calls analysis runs from the POPUP context — if the user closes the popup mid-analysis the
   result is lost with no history entry. Acceptable v1; noted so nobody is surprised.
8. **Chrome <114 fallback**: `chrome.action.setPopup` restoration is unit-tested against fakes,
   never against a real old-Chrome install. Also untested: whether `sidePanel` in
   `permissions` causes any store-review friction.
9. **MEDDIC cache staleness semantics**: keyed by URL + content hash, capped at 20 FIFO. A page
   that re-serves subtly different text every visit (A/B tests, live tickers) will always miss the
   cache and re-bill — harmless but worth knowing before calling it "double-click protection".

## 4. Final count

**485 passing / 0 failing across 35 test files.**
Runner: plain `node qa/test-<file>` per file; `qa/test-background-load.js` additionally needs
`node --experimental-vm-modules`. New this session: test-structured, test-side-panel,
test-email-drafter, test-meddic, test-objection-handler, test-linkedin, test-calls, test-hubspot
(113 new tests total, up from 360 across 27 files).
