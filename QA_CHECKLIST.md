# Atom.AI QA Checklist

## Popup Load Test (syntax + import chain sanity)

Automated gate (must pass): `node --experimental-vm-modules qa/test-popup-load.js` —
verifies popup.js + all transitive imports parse as ES modules and execute
top-level code without throwing (catches stray syntax, missing imports,
temporal dead zones, top-level await misuse, etc.).

Manual Chrome evidence (deferred to user):
1. Reload extension → open popup → no console errors, UI renders.

## Share the Card (Slack blocks + CRM note)

Automated gate (must pass): `node --test qa/test-share.mjs` — 9 tests cover
Block Kit structure (header/sections/link buttons/record/footer), mrkdwn
paste-cleanliness, CRM-note structure, and the real SW handler end-to-end
(webhook POST with working links; actionable errors for missing/invalid webhook).

Manual Chrome evidence (deferred to user):

1. Set a Slack webhook URL in Settings (use https://webhook.site to inspect).
2. Build a battle card → View → `📤 Share` → `Share to Slack` → confirm the
   webhook inspector receives Block Kit with header, sections, working
   Source ↗ buttons, and footer.
3. `Copy for Slack` → paste into Slack → confirm mrkdwn links render.
4. `Copy as CRM note` → paste into a text field → confirm the 5-line structure.

## Monitoring v0 (cards stay fresh)

Automated gate (must pass): `node --test qa/test-monitor-v0.mjs` — 11 tests
cover similarity/batching/badges, the weekly alarm wiring (10080 min), a
baseline run + detected pricing change → toolbar badge, REVERIFY_CARD clearing
the flag with in-place history update, and silent skip with no API key.

Manual Chrome evidence (deferred to user):

1. Save a battle card → DevTools → Application → confirm `monitorState` gains
   the competitor entry after the next weekly alarm (or send RUN_WEEKLY_REFRESH
   via a test page).
2. Change the competitor's pricing page → next cycle shows “⚡ Pricing changed
   Nd ago” on the card + toolbar ⚡ badge.
3. Click `Re-verify now` → confirm facts refresh, badge clears, no history spam.

## Objection Library (competitor-docs objections)

Automated gate (must pass): `node --test qa/test-objections.mjs` — 16 tests cover
discovery patterns (compare + vs- + docs/faq, same-domain only, cap, canonical
fallback), profile merge + proof-point matching, prompt schema, JSON parsing,
verified-vs-inferred marking, proof cross-reference (proofRef vs needsInput),
markdown + HTML rendering, and the real SW pipeline end-to-end (battle card for
a real competitor → 3+ objections on /compare|/docs with proof-tied rebuttals;
refresh + edit round-trips persist to job and history).

Manual Chrome evidence (deferred to user):

1. Build a battle card for a real competitor with docs/compare pages.
2. Click View → confirm an "Objections & Rebuttals" block with 3+ items, each
   with a clickable `[domain]` chip, a "verified from their docs" or "inferred"
   badge, and rebuttals citing your proof points (or a "needs your input" badge).
3. Click `⚡ Refresh objections` → confirm the block re-runs and updates.
4. Click `✏️ Edit rebuttal` on an item, change the text, Save → confirm the edit
   persists across popup close/reopen and the needs-input badge clears.

## Deal Room (pre-call brief)

Automated gate (must pass): `node --test qa/test-dealroom.mjs` — 15 tests cover
tab classification (prospect match / dedupe / cap / skips), prompt schema,
JSON parsing, source-URL validation (unsourced claims omitted), markdown + HTML
rendering (chips, confidence, null honesty), and the real SW pipeline end-to-end
(prospect + 2 competitors → DONE brief, prospect-only, missing-URL and
unreadable-prospect failures).

Manual Chrome evidence (deferred to user):

1. Open the prospect site + 2 competitor tabs in one window.
2. Open the popup → Research tab → enter the prospect URL → `🎯 Build Deal Room Brief`.
3. Confirm the Jobs card shows live steps ("reading acme.com…", "extracting
   competitor angles…", "synthesizing brief…").
4. Click View on the done job → confirm all six sections render with clickable
   `[domain]` chips, a confidence badge, and no invented claims.
5. Confirm a "Deal Room" entry lands in History; close/reopen the popup mid-job
   → job still completes.

## Trigger Moment (Phase 8)

Automated gate (must pass): `node --test qa/test-trigger.mjs` — 12 tests cover
banner decision (card-exists / dismissed-today / own-site / generic / no-card /
running) and the real SW handlers end-to-end (TRIGGER_CHECK → show, TRIGGER_DISMISS
→ same-day suppression, TRIGGER_OPEN_CARD → openCardRequest + badge fallback).

Manual Chrome evidence (deferred to user):

1. Generate a battle card for a competitor (e.g. stripe.com), then visit
   `https://stripe.com/pricing` → confirm the 44px banner appears at the top:
   "Atom.AI: you have a battle card for stripe.com. [Open card] [Dismiss for today]".
2. Click `Open card` → confirm the popup opens (or the ⚔ badge shows and clicking
   it opens the popup) focused on that card's result.
3. Visit the same domain again the same day → confirm no banner (dismissal cap).
   Next day → banner returns.
4. Set Settings → Your Product to your own site URL, visit it → confirm no banner.
5. Visit google.com / chrome:// pages → confirm no banner ever renders.

## Multi-Tab Research

1. Open 3-4 normal websites in the same window.
2. Click `Research All Open Tabs`.
3. Confirm the output:
   - names the tabs/domains it used
   - includes source-aware findings
   - mentions skipped tabs if any could not be read
4. Confirm a history entry is saved.

Expected result:
- No silent failure
- No Chrome/internal tabs included
- Helpful message if no readable tabs are available

## Research Multi-Source

1. Enter a topic in `Deep Research`.
2. Click `Multi-Source`.
3. Confirm the report includes:
   - overview
   - key facts
   - recent news
   - risks or gaps
   - source list

Expected result:
- Report shows source quality, not just generic text
- If a source fails, the report still completes with skipped-source notes

## Auto Task

1. Open a normal website with readable content.
2. Try a simple task:
   - `summarize what this company does`
3. Try a multi-tab task:
   - `compare all my open tabs and tell me pricing differences`
4. Try a navigation task:
   - `go to github trending and tell me the top repositories`

Expected result:
- The agent should avoid repeating the same failing step
- Errors should surface as readable messages
- Multi-tab goals should use cross-tab reading instead of getting stuck on one page

## Workflow Recorder

1. Record on a normal website.
2. Click a few buttons and type into a field.
3. Reopen the popup and press `Stop`.
4. Press `Replay`.

Expected result:
- Recorded steps count is non-zero
- Replay completes on the same site flow or reports a readable error

## Settings Persistence

1. Save an API key.
2. Reopen the popup.
3. Confirm the current screen is restored.
4. Go to Settings and choose `Change Provider / API Key`.
5. Clear the key and save.

Expected result:
- Settings can be updated and cleared
- Provider setup remains editable
- Reopening the extension does not reset unexpectedly

## BYOK / Groq API Key

1. Open Settings with no key saved → confirm a clear "no key" state is shown
   (banner on Home tab and/or empty state in Settings).
2. Paste an invalid key, run any research action → confirm a readable
   "Invalid Groq API key" error appears (no network hang, no silent fail).
3. Paste a valid key, save, run Company Brief → confirm it completes and the
   result is saved to History.
4. Reopen the popup (or reload the extension) → confirm the key is still
   populated in Settings without re-entering it (persistence).
5. Switch model to `openai/gpt-oss-120b`, run a request → confirm it completes
   normally.
6. Clear the key via "Clear Key" → confirm subsequent research actions show
   the "no key" state again, and the field is empty on reopening Settings.
7. Trigger >25 AI calls within one minute (e.g. rapid competitor checks) →
   confirm the per-minute safety limit still fires with a readable message,
   and that no daily/"Upgrade to Pro" limit blocks normal usage.
