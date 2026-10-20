# Verification report

What was verified while building NotePilot AI, how, and what could not be verified in the build environment.

## Summary

| Area | Status | How |
|---|---|---|
| Build: MV3 manifest, side panel, service worker, content script | ✅ Verified | `npm run build`; extension loads in Chromium 141 with no console errors |
| Extension ID pinning for OAuth | ✅ Verified | `setup:oauth` predicts the ID, and Chromium assigned exactly that ID when loading the build |
| Docs API → organized notes pipeline | ✅ Verified (simulated backend) | Real built extension in real Chromium; `docs.googleapis.com` requests routed to a mutable fake document with the documented REST response shape |
| Spec §15 acceptance workflow, steps 1–11 | ✅ Verified (scripted model) | Engine-level simulation (`tests/acceptance.test.ts`) and the browser E2E run (`e2e/run-e2e.mjs`, 18/18 checks) |
| Original doc never modified | ✅ Verified | Every Docs request in the E2E run was `GET` (18 requests, 13 of them cheap revision checks); static tests forbid write scopes, write endpoints and non-GET methods |
| Robustness (staleness, cancellation, back-off, offline, invalid output, budget, consent, persistence, long docs) | ✅ Verified | `tests/engine.test.ts` (17 tests, fake timers) |
| Proxy server | ✅ Verified | `server/tests/app.test.ts` (7 tests over real HTTP) |
| Sign-in against a real Google account and a real Google Doc | ⚠️ Not verified | Requires your own OAuth client bound to your extension ID (see below) |
| Rewrite and insight quality with a real LLM | ⚠️ Not verified | No model API key was available in the build environment |

## Test inventory (all passing)

- **Extension:** 79 tests in 9 files: docParser 5, identity 7, patch 18, context 6, completion 12, acceptance 2, engine 17, ai 8, readonly 4.
- **Server:** 7 tests.
- **Browser E2E:** 18 checks, built extension in Chromium 141 (headless):
  1. organizes unstructured notes automatically
  2. labels AI clarifications and expansions distinctly
  3. a cut-off note ("ATP synthase uses proton gradient to") is finished, with only the AI-added words highlighted, no markers or "truncated" notes visible, and the completion rules present in the real request
  4. a new fact is placed at its conceptual location, not appended (*Anaerobic Metabolism* lands between *Glycolysis* and *Citric Acid Cycle*)
  5. a fact about an earlier topic updates that section in place, **in the same DOM node**, with **scroll position unchanged**
  6. collapsed sections stay collapsed across updates
  7. editing an earlier statement reconciles the organized version
  8. deleting a statement removes what it supported, including the AI expansion anchored to it
  9. insights update automatically and link back to sections
  10. insight section chips navigate to the organized notes
  11. the source inspector shows the original passages
  12. the original view mirrors the raw document, read-only
  13. diagnostics report measured latency
  14. the Google Doc was only read (GET), never written
  15. no console errors
  16. a second panel on the same doc mirrors the leader instead of double-processing
  17. first run shows the guided setup and sends nothing before consent
  18. later updates don't re-trigger an earlier navigation, and notes the model fails to place still appear verbatim

## Independent review

A separate review pass ran 3,000 randomized patch sequences against a deep-frozen base document (no invariant violations, no mutation of the previous version) and 3,000 randomized edit sequences against the identity matcher (no duplicate IDs). It also found seven real bugs, all now fixed and each covered by a regression test:

1. The verbatim fallback (after repeated unusable AI output) built its snapshot from the *latest* fetch, so an edit made during the failing call could be marked processed without ever reaching the model.
2. Typing and tab-visibility signals could shorten an error back-off (for example, a 429 with Retry-After).
3. After an insight chip was clicked, later updates re-ran that navigation (switching view, expanding sections, scrolling).
4. Follower panels in other windows could miss the final state of a fast update (the throttle sent the first view in the window, not the latest).
5. With processing paused or blocked, the doc was probed every 2 s instead of at the configured cadence.
6. A rejected `update_section` op could still rename the section.
7. A title-only rename of the Google Doc didn't refresh the panel.

The review also flagged a design gap, which is now fixed as well: a paragraph deleted and restored (undo) between polls now keeps its identity, so no AI work is repeated.

## Version 0.2.0: finishing incomplete notes

- New setting *Finish incomplete notes* (default **Develop**). The model completes cut-off sentences and, in Develop mode, writes out ideas the student started but didn't explain. Every added word is wrapped in markers that the panel renders highlighted (tooltip: "Completed by AI"), exports render as \[editorial brackets\], and comparisons ignore.
- Fixed the cause of "Ambiguous in your notes: Source text appears truncated": the old prompt told the model never to guess, so unfinished sentences were flagged instead of finished. Separately, NotePilot used to shorten neighbouring context paragraphs to 600 characters with "…" without saying so; those are now 1,200 characters and explicitly labelled `"shortened": true`, and changed paragraphs are sent in full up to 12,000 characters.
- Rewriting rules now target comprehension: main idea first, short sentences, explicit connecting words, and steps, tables or bullets where they help.
- Not verified here: how well a real model follows these rules (all model output in the tests is scripted).

## Measured latency (E2E, scripted model at ~0.4 s)

| Metric | Value |
|---|---|
| Edit saved → change visible in panel | 2.9–4.4 s |
| Change detected → panel updated (engine metric, p50 / p90) | 2.4 s / 2.5 s |
| Docs API usage while active | ≈17–24 requests/min, mostly ~100-byte revision checks (quota: 300/min/user) |
| Docs API usage while idle (simulated 10 min) | < 7 requests/min, no full fetches |

With a real model, add its response time. A fast model typically takes a few seconds for a small patch, which puts the expected change-to-sidebar time in the 5–15 s target. The panel measures this live (Settings → Diagnostics): *change → sidebar*, *keystroke → sidebar* (when the typing signal is available) and model latency, each as p50/p90.

## What could not be verified here, and why

1. **Real Google sign-in and a real Google Doc.** `chrome.identity.getAuthToken` only works with an OAuth client created in *your* Google Cloud project and bound to *your* extension ID, signed in with *your* account. The integration follows the documented Docs REST API (`documents.get` with `includeTabsContent=true` and `suggestionsViewMode=PREVIEW_WITHOUT_SUGGESTIONS`), and the parser is tested against that response shape. The cheap change check uses Google's standard `fields` partial-response parameter. If a project ever rejects it, the engine automatically falls back to full fetches (tested).
   *To verify yourself:* complete the OAuth setup in the README, open a doc, and watch the Original view and Diagnostics.
2. **Real model output.** Every model response in the tests is scripted. The tests prove that the extension sends the right context, that it validates, applies, repairs and reconciles whatever comes back, and that it never loses note content even when the model misbehaves. They do not prove how *well* a particular model organizes notes. The prompts (`src/core/prompts.ts`) are written for that, but you should try them with your model and adjust model choice or rewriting intensity.
3. **The typing-activity signal in a real Docs tab.** The content script listens for keyboard/paste events in Google Docs frames. Without that signal, the engine falls back to poll-based pause detection, which was tested. With it, typing pauses are detected faster and *keystroke → sidebar* latency is reported.

## Known limitations

- **No true keystroke-level sync.** Google Docs exposes no edit stream to extensions, so updates follow Docs' autosave (usually within 1–2 s) plus polling. This is by design and per spec.
- **Sync runs while the side panel is open.** MV3 service workers can't poll every few seconds. On reopen, the panel shows the saved organized version immediately and catches up on changes made while it was closed.
- **Google Chrome only** for sign-in (`chrome.identity.getAuthToken`). Other Chromium browsers would need a `launchWebAuthFlow` variant.
- **Docs content the API doesn't expose as text:** equations made with the Docs equation editor show as `[equation]`, images as `[image]`, and footnote bodies are not included. Pending suggestions are excluded; only accepted text is read.
- **OAuth app verification:** while the Cloud project is in *Testing* mode, only listed test users can sign in. Wider distribution requires Google's OAuth verification for the Docs read-only scope. School Workspace admins may block unverified apps.
- **Cost and price estimates** depend on the per-token prices entered in Settings.
