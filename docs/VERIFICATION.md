# Verification report

What was verified while building NotePilot AI, how, and what could not be verified in the build environment.

## Summary

| Area | Status | How |
|---|---|---|
| Build: MV3 manifest, side panel, service worker, content script | ✅ Verified | `npm run build`; extension loads in Chromium 141 with no console errors |
| Extension ID pinning for OAuth | ✅ Verified | `setup:oauth` predicts the ID, and Chromium assigned exactly that ID when loading the build |
| Docs API → organized notes pipeline | ✅ Verified (simulated backend) | Real built extension in real Chromium; `docs.googleapis.com` requests routed to a mutable fake document with the documented REST response shape |
| Spec §15 acceptance workflow, steps 1–11 | ✅ Verified (scripted model) | Engine-level simulation (`tests/acceptance.test.ts`) and the browser E2E run (`e2e/run-e2e.mjs`, 21/21 checks) |
| Summary + companion Google Doc | ✅ Verified (simulated Drive) | Built extension in Chromium: *Summarize* shows the summary in the notes' outline (same numbers, titles and order as the notes), its section headings navigate, the Drive upload request is a `POST` that creates a Google Doc (summary, notes, insights), a second click `PATCH`es the same doc, and the notes doc is never a target. Opening the companion doc in a tab keeps the panel on the notes it came from (recognized by its saved id, or by its "— NotePilot notes" name), so it is never rewritten or summarized itself. A new doc is made only when the old one was deleted, trashed or can no longer be changed by NotePilot; any other Drive error is reported instead. Unit tests cover deleted/trashed docs, a disabled Drive API, refused permission and token refresh |
| What the student wrote is never modified | ✅ Verified | Every Docs request in the E2E run was `GET`; Drive requests only ever targeted the companion doc. Static tests allow exactly one writer (the lecture transcript), forbid any other Docs write, any Drive scope other than `drive.file` and any Drive endpoint other than upload |
| Lecture recording: transcript section and organizing | ✅ Verified (simulated) | `tests/recording.test.ts` (20 tests) and `tests/recorder.test.ts` (5): append plans checked against a model of a Docs body, the writer's requests, transcription requests, the recording session, and the real `SyncEngine` with transcript blocks. Not run against real Google Docs, a real microphone or a real transcription model (see below) |
| Robustness (staleness, cancellation, back-off, offline, invalid output, budget, consent, persistence, long docs) | ✅ Verified | `tests/engine.test.ts` (17 tests, fake timers) |
| Proxy server | ✅ Verified | `server/tests/app.test.ts` (7 tests over real HTTP) |
| Sign-in against a real Google account and a real Google Doc | ⚠️ Not verified | Requires your own OAuth client bound to your extension ID (see below) |
| Rewrite and insight quality with a real LLM | ⚠️ Not verified | No model API key was available in the build environment |
| Google's HTML → Google Docs conversion of the companion doc | ⚠️ Not verified | Needs a real Drive account. The HTML uses only elements Google's importer documents support (headings, lists, tables, bold/italic, inline colours); a rendering of it is checked in the E2E run |

## Test inventory (all passing)

- **Extension:** 286 tests in 16 files: docParser 5, identity 7, patch 21, context 7, completion 12, summaryExport 19, acceptance 2, engine 18, ai 16, writes 6, recording 64, recorder 5, onDevice 41, transcription 48, freeTier 7, simpleRewrite 8.
- **Server:** 15 tests.
- **Browser E2E:** 21 checks, built extension in Chromium 141 (headless):
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
  19. *Summarize* shows a concise summary in the notes' outline (same numbered sections, in order, with a table and numbered steps) and saves the summary, organized notes and insights to a new Google Doc
  20. summary section headings link to their sections in the notes
  21. summarizing again updates the same Google Doc (a fresh summary, not a cached one) instead of creating another

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

## Next version: free options

- **On this computer**: AI mode `device` runs every AI call on Chrome's built-in model through the Prompt API (`LanguageModel`, `extension/src/ai/onDevice.ts`): no key, no cost, nothing sent. One instruction-only base session per system prompt, cloned for each request so notes never share a session; the patch schema is the response constraint (any JSON object if Chrome can't compile it); context overflow, readiness and cancellation map to typed errors. Settings and Setup show requirements, readiness and a one-time download with progress.
- **Free cloud presets** (limits checked 2026-10-22): Groq, Google Gemini, Mistral, OpenRouter (`:free` models) and Ollama, each with a note on its limits, what happens to the notes and whether its terms require users to be 18+. Connecting to a rate-limited one slows Update frequency to *Saver*.
- **A separate transcription service** (Settings → Recording): OpenAI, Groq's free `whisper-large-v3-turbo`, a local Speaches server (`Systran/faster-whisper-small`), Mistral `voxtral-mini-latest`, or a custom address and key. Consent, the consent text and Chrome host permission follow the transcription address; with the on-device model and no service, Record says where to choose one.
- Written in parallel by Hermes Agent (on-device model; transcription service) and Claude Code (presets, notes, pacing, docs). Hermes's model hit its usage limit before the last checks, so Claude Code finished both: corrected the Mistral model id from Mistral's docs, added the schema fallback, merged and checked everything.
- Independent review (a separate Claude agent, given only the code): consent, host permission, the recording start/cancel state and on-device session lifetimes held up. Fixed from it: recording "same as the AI connection" now follows the notes to the new service's own transcription model (Groq's Whisper rather than an OpenAI model name Groq would reject); an API key is dropped when its address moves to another host, for notes and recording alike, so it is never sent to a different provider; the free-tier note and Saver apply only when a preset's models are in use, not to a paid account at the same address; the Record message names the actual cause; the overflow listener also hears Chrome's older `quotaoverflow` event.
- On-device rewrites, after a real test showed every note left "not yet organized": NotePilot's patch task (about 3,600 tokens of rules, ops that must cite note ids) is too much for Chrome's small model, which could answer with ops that cited nothing. It now gets a simpler task (`core/simpleRewrite.ts`): rewrite each new or changed note and name its section, with ids limited to the notes sent. NotePilot turns the reply into the usual patch, so every returned note is cited and placed, and notes shown as written are picked up by the next pass. Insights and the summary get exact reply shapes instead of "any JSON object". Smaller batches (2,000 characters) and four minutes per call, for a model that writes far more slowly.
- Not verified here: Chrome's real built-in model (download, speed, output quality and its context window with long notes), real free-tier limits, and a real Speaches or Groq transcription. These need a supported Chrome on capable hardware and the providers' accounts.

## Version 0.4.0: lecture recording, lower AI costs, a summary in the notes' outline

- The summary follows the organized notes' outline (same numbered sections) in a redesigned card, and the panel never treats NotePilot's own companion Google Doc as notes. Default models are GPT-5.4.
- Lower AI costs: smaller requests for routine edits (relevant sections plus previews, with a periodic full pass), pacing by the Frequency setting (Balanced: at most 12 s while typing, insights after 15 s of quiet), targeted repairs, and priced low-cost presets (`gpt-6-luna`, Claude Haiku 5.5). Fixed: new units without "after" were placed first rather than last.
- Lecture recording, as follows.


- **Record** in the Notes toolbar: microphone, or a tab chosen in Chrome's share dialog. Audio is cut into ~20 s segments (each a complete recording), silent ones are skipped, and each is transcribed through the AI endpoint (`/audio/transcriptions`, default `gpt-4o-mini-transcribe`).
- Each line is appended as "[10:42] …" to a *Lecture transcript (NotePilot)* section at the end of the Google Doc: a named range, created with the first line. Requests are planned purely (`core/transcript.ts`), checked to insert only at the end of that section and to style or name only the inserted text, and sent with `writeControl.targetRevisionId`.
- The parser marks lines inside the named range as transcript and skips NotePilot's heading. The rewrite gets them with `"recording": true` and rules for folding them in (merge with the student's notes, drop filler, fix misheard terms). They are not required to be cited, so filler is neither forced into the notes nor shown as unorganized, and transcript-only changes are organized about once a minute.
- First use: a consent note in the panel, then Google's consent for the full Docs scope (requested only then).
- Review fixes (Hermes and Codex): only "[time] …" lines and NotePilot's heading count as transcript, so text the student types at the end of the section stays a required note and new lines go before it; inserted text and paragraphs get plain formatting; a line already present is not written again; the writer stops if its last line ends up outside the section; the recorder delivers every segment before stop() resolves and keeps the tail when a track ends; after the session stops itself nothing more is sent; a spent budget (402) or three lost parts in a row stop the recording.
- Transcription models: OpenAI marks `whisper-1`, `gpt-4o-transcribe` and `gpt-4o-mini-transcribe` deprecated (shutdown 26 Feb 2027). The model is a setting; switch the default before then.
- Not verified here: the microphone prompt in a real side panel, tab audio through the share dialog, real transcription quality, and the real Docs behaviour of named ranges and `targetRevisionId` under concurrent typing. These need a real Chrome profile, a Google account with the `documents` scope added to the OAuth consent screen, and an OpenAI-compatible key with transcription.

## Version 0.3.0: structure, summary and Google Doc

- The rewrite rules now ask for structure: tables for anything compared on shared attributes, numbered steps for processes, nested bullet lists, definitions, one-sentence overviews, and generous sections and subsections (split a section once it covers two sub-topics or grows past about five passages; split long notes into separate passages).
- *Summarize* (Notes toolbar): a condensed version of the organized notes with the same outline (section numbers, titles and order), each section cut to one to four bullets, up to six numbered steps or a small table; a one- or two-sentence overview; up to eight key terms as a table; and up to three things to review next. Generated with the insights model only when clicked, and only when the notes changed (the ↻ button forces a new one).
- The same click saves a companion Google Doc: Summary → Organized notes → Insights, with headings for the Docs outline, tables, AI labels, highlighted AI completions and math converted to text. It uses the `drive.file` permission, requested on first use, and is updated in place on later clicks (a new doc is made if it was deleted or trashed).
- Not verified here: how Google converts the HTML into the final Google Doc, and real-model output quality.

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
