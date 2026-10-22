# NotePilot AI

A Chrome extension that reads the Google Doc you're typing in and keeps a live, rewritten, organized version of it in the Chrome side panel, with AI insights alongside. One click gives you a concise summary and saves everything to a separate Google Doc. It can also record a lecture while you type and work what's said into your notes. **It never changes what you wrote:** the only thing it ever adds to your doc is the transcript of a recording you start, in its own section at the end.

<p>
<img src="docs/screenshots/02-new-section-inserted.png" width="270" alt="Organized notes with a new section inserted in place">
<img src="docs/screenshots/03-insights.png" width="270" alt="AI insights">
<img src="docs/screenshots/10-summary.png" width="270" alt="Summary in the same outline as the organized notes, with the companion Google Doc">
</p>

- **Two parallel documents.** Your Google Doc stays the raw, messy source of truth. The side panel holds a separately maintained organized document: headings, merged ideas, expanded shorthand, tables and equations.
- **Incremental, not regenerated.** Each change is diffed at paragraph level, and the model returns a *patch*: extend, rewrite, move, merge, split or delete specific sections and passages, all addressed by stable IDs. New facts go where they belong conceptually, not at the bottom.
- **Faithful.** Every organized passage cites the source paragraphs it came from. You can click to see them, and passages are labelled as *your notes*, *AI clarification* or *AI expansion (unverified)*. A deletion that would lose any of your content is reverted. Anything the model fails to represent is repaired, or shown verbatim, so nothing is silently dropped.
- **Finishes what you didn't.** Sentences you cut off mid-way are completed, and ideas you started but didn't write out are developed (Settings → Writing → *Finish incomplete notes*: Off / Finish / Develop). The words the AI added are highlighted, so you always know which part you wrote. The rewrite favours short sentences, plain words, a logical order and lists, tables or steps where they make an idea easier to follow.
- **Structured, not just reworded.** Comparisons become tables, processes become numbered steps, parallel points become (nested) lists, key terms become definitions, and notes are cut into sections and subsections so each one covers a single idea.
- **Summary + Google Doc.** *Summarize* (Notes toolbar) shows a short version of the organized notes in the same outline: the same numbered sections, each cut down to a few bullets, steps or a small table, plus a one-line overview, a key-terms table and what to review next. Section headings link to the full notes. The same click saves the summary, the organized notes and the insights to a companion Google Doc (headings show up in the Docs outline). Later clicks update that same doc, and opening it doesn't make the panel treat it as notes: the panel keeps showing the notes it came from.
- **Lecture recording.** *Record* (Notes toolbar) listens to the room through your microphone, or to an online class or video playing in another tab. Every 20 seconds or so the speech is transcribed through your AI connection and added as a timed line ("[10:42] …") to a *Lecture transcript (NotePilot)* section at the end of your Google Doc. The rewrite then works the key points into your organized notes, next to what you typed on the same topic, and leaves out filler; passages that come only from the recording are labelled *From recording*. Audio is never saved.
- **Hands-free after setup.** Adaptive polling, debouncing on typing pauses, single-flight jobs, stale-result rejection, cancellation, back-off, offline recovery.

---

## Quick start

Requirements: **Google Chrome 116+**, Node.js 20+, a Google Cloud project (free), and an OpenAI-compatible model endpoint (OpenAI, Anthropic's OpenAI-compatible API, OpenRouter, Ollama…) or the included proxy server.

```bash
npm install
npm test                 # unit + engine acceptance simulation + proxy server tests
```

### 1. Google OAuth setup (one time, ~5 minutes)

`chrome.identity` needs an OAuth client that is bound to your extension's ID, so the ID has to be fixed first:

```bash
cd extension
npm run setup:oauth      # creates a key, writes .env.local, prints your Extension ID
```

Then in the [Google Cloud Console](https://console.cloud.google.com):

1. **APIs & Services → Library →** enable **Google Docs API** and **Google Drive API** (Drive is only used to save the companion Google Doc).
2. **OAuth consent screen:** User type *External* (or *Internal* for a Workspace org). Under **Data Access**, add the scopes `https://www.googleapis.com/auth/documents.readonly` and `https://www.googleapis.com/auth/drive.file` (and, for lecture recording, `https://www.googleapis.com/auth/documents`), and add your Google account as a **test user**.
3. **Credentials → Create credentials → OAuth client ID →** Application type **Chrome Extension**, Item ID = the Extension ID printed above.
4. Record the client ID:
   ```bash
   npm run setup:oauth -- --client-id=1234-abc.apps.googleusercontent.com
   ```

### 2. Build and load

```bash
npm run build            # → extension/dist
```

Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select `extension/dist`. The ID shown must match the one from step 1.

### 3. Use it

1. Open a Google Doc and click the NotePilot toolbar icon (or press **Alt+Shift+N**).
2. The panel walks you through three steps: **Sign in with Google** (read-only), **connect an AI model** (key + model names, then *Connect & test*), and **allow sending notes**.
3. Type. That's it.
4. Optional: click **Summarize** in the Notes toolbar. The first time, Google asks you to allow NotePilot to *create files* in Drive (it can only see and change files it creates).
5. Optional: click **Record**, then **Microphone** or **A tab's audio**. The first time, the panel explains what is sent where and asks you to confirm, and Google asks you to allow NotePilot to *edit* your docs (it only ever adds transcript lines to its own section). For a tab, Chrome's share dialog opens: pick the tab and keep *Also share tab audio* on. If the side panel can't show Chrome's microphone prompt, use **Allow microphone** once. Recording uses a transcription model at your AI endpoint (OpenAI: `gpt-4o-mini-transcribe` by default; Settings → Recording); Anthropic's API has no transcription. Only record people who agree to it, and follow your school's rules on recordings.

> **Models and cost.** Defaults are `gpt-5.4-mini` (rewriting) and `gpt-5.4` (insights). The two cheapest presets rewrite for $0.10 / $0.50 per million tokens: **OpenAI, low cost** (`gpt-6-luna`, with `gpt-5.4-mini` for insights; repeated prompt text is billed at $0.01) and **Anthropic, low cost** (Claude Haiku 5.5, with Claude Sonnet 5.5 for insights; through Anthropic's OpenAI-compatible endpoint Haiku always thinks first, billed as output, and there is no prompt caching). Choosing a preset also sets its prices, so the daily cost limit matches what you're charged; edit them in Settings → Cost limits if your provider's rates differ. Any OpenAI-compatible model name works, including local ones (Ollama).

### Keeping costs down

- **Frequency** (Settings → Processing) sets how eagerly AI work runs. *Balanced* (default): while you keep typing, notes are organized at least every 12 s, and insights refresh after 15 s of quiet, at most half as often as *Realtime*. *Saver* waits up to 30 s. *Realtime* is the most responsive.
- **Only what's needed is sent.** Small notes go whole. Larger ones send the sections an edit touches (by citation, nearby notes and topic) in full and the rest as titles with short previews; every 8th rewrite, and any large change, sends everything so distant topics still get connected. Repairs are always targeted.
- **Recording** transcripts are organized about once a minute, and silent stretches are never sent.
- **JSON mode** *Strict JSON schema* (Settings → AI model, OpenAI) guarantees a well-formed patch, so a malformed reply never costs a retry; it is off by default because strict output cannot leave fields out, which NotePilot reads by convention (see `stripNullOpFields`).

---

## How it works

```
Google Doc (read-only)                         Side panel (React)
──────────────────────                         ─────────────────────────────────────────────
documents.get?fields=revisionId  ◄── adaptive poll (2–5 s while typing, slower when idle)
documents.get (full) on change   ──► parse → paragraph blocks → stable IDs (LCS + fuzzy match)
                                        │
content script: "user is typing" ──► debounce: wait for a typing pause (max-wait while typing)
  (activity only, never content)        │
                                        ▼
                         diff(processed → current): added / modified / removed blocks
                                        │
                         context: organized doc (full, or relevant sections + previews
                                  for long docs) + changes + neighbouring blocks
                                        │
                         fast model → JSON patch ops ─► zod validation ─► apply with integrity rules
                                        │                                   (refs, cycles, coverage,
                                        │                                    no-loss, de-dup)
                                        ▼
                         organized doc v(n+1) → IndexedDB → copy-on-write React render
                                        │                    (only changed nodes update)
                                        ▼
                         insights pipeline (deeper model, low priority, preemptible)
```

**Key decisions**

| Concern | Decision |
|---|---|
| No keystroke stream from Google Docs | Poll the Docs REST API. A cheap `fields=revisionId` check runs every 2–5 s while active, and a full fetch only happens when the revision changes. A tiny content script reports *that* you're typing (never *what*), so polling speeds up and typing pauses are detected. No DOM scraping. |
| MV3 service workers sleep after ~30 s | The sync engine runs in the side panel page, which stays alive while it's open. When you close it, sync pauses. When you reopen it, it catches up from the persisted snapshot. |
| Stable identity for paragraphs | Docs has no paragraph IDs. They're rebuilt each fetch: common prefix/suffix, then LCS on content hashes, then moved-block detection, then fuzzy matching inside changed regions. Edits keep their ID, and pure moves trigger no AI work. |
| Incremental rewriting | The model emits ops (`create_section`, `update_unit`, `move_unit`, `delete_section`, …) against stable IDs. Merges and splits are compositions of these. Each op is validated individually. |
| Content integrity | Every `user`/`clarification` passage must cite valid source IDs. Deletions that would orphan a source paragraph are reverted. Passages whose sources were deleted are removed (*"remove content only when the notes no longer support it"*). Uncovered paragraphs get one targeted repair call, then a verbatim "Not Yet Organized" fallback that a later pass reorganizes. |
| Concurrency | One rewrite in flight per doc. Results are rejected if the organized doc changed underneath them. Insights are aborted when a rewrite is needed. A Web Lock elects one leader panel per doc across windows, and the others mirror it over a BroadcastChannel. |
| Long documents | The whole organized doc is sent while it fits about 28k characters. Beyond that, relevant sections go in full (by citations, source neighbours and topic overlap) and the rest as previews. Initial builds of long docs are batched (about 8k characters of new text per call). |
| Stable UI | Copy-on-write patches keep object identity for unchanged passages, so memoized rows don't re-render. Keys are stable IDs, CSS scroll anchoring holds your reading position, collapse state persists per doc, highlights are a one-off soft fade, and nothing ever calls `focus()`. |

### Privacy & safety

- **What you wrote is never changed:** notes are read with the `documents.readonly` scope, and the Docs reader issues only `GET`. Saving the companion Google Doc uses `drive.file`, which Google limits to files NotePilot created itself; it's requested only when you first click *Summarize*, uses only Drive's upload endpoint, and refuses to target the doc it reads from.
- **Recording adds, and only adds, its transcript:** the full Docs scope is requested only when you first start a recording. One module (`google/transcriptWriter.ts`) uses it, to append transcript lines inside NotePilot's own named section at the end of the doc. Before anything is sent, each request is checked: one insertion at the end of that section, plus styling and naming of the text it just inserted; never deleting, replacing or moving anything. Writes carry the revision they were planned against, so Google merges them with your typing. `tests/writes.test.ts` fails the build if another module writes, another write request appears, or a broader scope is introduced.
- **Recording consent:** nothing is recorded until you start it, and the first time the panel says where the audio goes and asks you to confirm. A red strip shows while it runs; closing the panel stops it. Audio stays in memory only until it is transcribed, silent stretches are not sent, and minutes of audio count toward the daily cost limit.
- **Consent first:** no note text is sent anywhere until you approve the specific AI endpoint. Changing the endpoint asks again. You can also exclude documents, or require approval per document.
- **Prompt-injection hardening:** note text travels only as JSON-encoded data, separate from the instructions, and the system prompt treats it as untrusted. Model output is schema-validated, rendered as restricted markdown with no HTML and no images (so injected image links can't exfiltrate data), and links require a click. The extension CSP forbids remote scripts and images.
- **Redaction (on by default):** email addresses, phone/ID-number patterns and card numbers are replaced before sending. Numbers, units, dates and equations are kept intact.
- **Secrets:** your API key lives in `chrome.storage.local` (never synced) and is sent only to the endpoint you configured. For shared deployments, use the proxy server so the provider key never reaches the browser.
- **Local data:** organized notes, source mappings and the response cache live in IndexedDB. You can turn persistence off or delete everything from Settings → Privacy.

---

## Optional: the proxy server

For a class or team: one provider key on a server, per-user tokens, rate limits, daily token budgets, response caching and usage logging (counts only, never content).

```bash
cd server
cp .env.example .env      # set UPSTREAM_API_KEY, ACCESS_TOKENS=alice:<long-random-token>,...
npm run build && npm start   # http://localhost:8787
```

In the extension: Settings → AI model → **NotePilot server**, then enter the server URL (`http://localhost:8787/v1`) and your token. Endpoints: `POST /v1/chat/completions`, `POST /v1/audio/transcriptions`, `GET /v1/usage`, `GET /health`. Deploy it behind HTTPS for anything beyond localhost.

`POST /v1/audio/transcriptions` takes the same multipart upload as OpenAI's endpoint (`file`, `model`, and optional `prompt`, `language`, `response_format`) and forwards it to `UPSTREAM_BASE_URL` with the server's key. It has the same per-user token, rate limit, daily budget and `ALLOWED_MODELS` list as chat, so when the allowlist is set it must include the transcription model (for example `gpt-4o-mini-transcribe`). Uploads are capped at 25 MB. Audio and transcripts are never cached, logged or stored: the usage log records bytes, duration when the provider reports it, and token counts. With `response_format=text` the provider reports no token usage, so use `json` (the default) for the daily budget to count transcription.

---

## Testing

```bash
npm test                  # 94 extension tests + 7 server tests
cd extension && npm run e2e   # real Chromium end-to-end run (needs a Chromium/Chrome binary; CHROMIUM_PATH=…)
```

| Suite | What it covers |
|---|---|
| `docParser`, `identity` | Docs API → blocks (headings, lists, tables, chips, tabs); stable IDs across inserts, edits, deletes, moves and duplicates; a 3,000-paragraph doc diffs in < 1.5 s |
| `patch` | refs, cycles, depth, revert of lossy deletes, source reconciliation, number-aware de-duplication, merge/split/move, coverage + fallback |
| `completion` | finishing cut-off sentences and developing half-written ideas (prompt rules per setting), highlighting AI-added words, markers never shown or exported as-is, text NotePilot shortens is labelled so the model doesn't report it as "truncated" |
| `context` | injection-safe payloads, redaction, settings → prompt, relevant-section selection for long docs |
| `acceptance` | **Spec §15 workflow** on the real `SyncEngine` with a fake Docs backend and scripted model: organize → place a new fact at its conceptual location → update an earlier section in place → reconcile an edited statement → reconcile a deleted one (including the AI expansion anchored to it) → insights update → only GETs to the doc → latency p90 ≤ 15 s |
| `engine` | stale-result rejection, insight cancellation, Docs 429 back-off with Retry-After (not shortened by typing), offline recovery, invalid AI output → verbatim fallback → later self-healing (edits made during a failing call stay pending), repair calls, consent and budget gates, idle quota use (also while paused), resume from IndexedDB, batched long-doc builds, revision-check fallback, undo keeps paragraph identity |
| `ai` | OpenAI-compatible request shape, provider quirks (`max_completion_tokens`, temperature), error mapping, retry with validation feedback, cost tracking, cache |
| `summaryExport` | structure rules (tables, steps, lists, sections), summary follows the notes outline (order, numbers, parent headings), length limits that keep lists and tables valid, validation and pipeline, companion-doc HTML (outline headings, tables, labels, highlighted completions, math as text), Drive save: create, update the same doc, never the source doc, deleted/trashed doc, disabled API, refused permission, token refresh |
| `writes` | static guarantees: read-only scope in the manifest, GET-only Docs reader, the transcript writer as the only module that writes (checked, transcript-only batch updates against a revision), `drive.file` as the only Drive scope, only the upload endpoint, content script never reads or alters the editor |
| `recorder` | segments delivered in order, stop at a segment boundary keeps both parts, a track that ends mid-segment keeps its tail, short tails dropped, tracks stopped |
| `recording` | the transcript section in a model of a Docs body (the first line adds heading + line after your notes; later lines go inside the section even when you typed below it; your text never changes), refusing anything but transcript-only requests, finding the section by name, parsing it back (lines marked, NotePilot's heading skipped), the `recording` flag and rules in the prompt, the writer's requests and a view-only doc, multipart transcription and the proxy route, a session's order/continuity/silence/filler/retries/stop conditions, and on the real engine: transcript-only changes organized about once a minute while typed notes go through at once, and lines the model leaves out neither forced in nor shown as unorganized |
| `server` | auth, forwarding with the server key, cache, rate limit, daily budget, model allowlist, error passthrough |
| `e2e/run-e2e.mjs` | The **built extension in real Chromium**: Docs REST API routed to a mutable fake document, AI endpoint routed to a scripted model, and the actual side panel driven through the acceptance scenario, plus DOM-node identity, scroll preservation, collapse persistence, source inspector, multi-window leader election and first-run consent. Screenshots go to `e2e/screenshots/`. |

See [`docs/VERIFICATION.md`](docs/VERIFICATION.md) for what was actually verified and what was not.

---

## Project layout

```
extension/
  manifest.base.json        MV3 manifest (client ID + key injected at build from .env.local)
  src/core/                 pure logic: types, Docs parser, identity/diff, patch engine, schemas,
                            prompts, context builder, insights, redaction, export
  src/engine/               SyncEngine (polling, debouncing, jobs, integrity, metrics) + state
  src/google/               chrome.identity auth, read-only Docs API client, transcript writer, companion Google Doc export (drive.file)
  src/audio/                lecture recording: microphone or shared-tab audio in segments, the recording session
  src/ai/                   OpenAI-compatible client, rewrite/insight pipelines, usage tracking
  src/storage/              IndexedDB (docs, cache), chrome.storage settings
  src/sidepanel/            React UI: Notes (organized/original/outline), Insights, Settings, setup
  src/content/activity.ts   typing-activity signal (no content access)
  src/background/index.ts   opens the side panel from the toolbar button
  tests/  e2e/  scripts/setup-oauth.mjs
server/                     Node.js model proxy (no runtime dependencies)
docs/                       verification report, screenshots
```

## Troubleshooting

- **"Sign in with Google" fails with `bad client id` / `OAuth2 not granted`:** the client must be of type *Chrome Extension*, its Item ID must equal the ID shown in `chrome://extensions`, and you must rebuild after `setup:oauth`.
- **403 "Google Docs API has not been used in project…":** enable the Docs API in the same Cloud project as the OAuth client.
- **"Google Doc not saved: The Google Drive API is not enabled…":** enable the Google Drive API in the same Cloud project, then click *Summarize* again.
- **"Permission to create Google Docs was not granted":** click *Summarize* again and approve the *create files* permission (it can only touch files NotePilot creates).
- **Several "— NotePilot notes" docs in Drive:** earlier versions followed the companion doc when you opened it and made a new one on each Summarize there. That is fixed; you can delete the extra copies in Drive (keep the one the panel's *Open* button links to).
- **Edits in the companion Google Doc disappeared:** that doc is regenerated each time you click *Summarize*. Edit your original notes instead, or copy the doc (File → Make a copy) to keep a version.
- **School or work Google account blocked:** Workspace admins can block unverified third-party apps. Ask your admin to allow the OAuth client, or use a personal account for testing.
- **Panel says "AI provider rejected the API key":** re-enter the key in Settings → AI model and press *Connect & test*.
- **Nothing updates:** check the status pill. *Paused*, *Setup*, *Limit* and *Excluded* each have a one-click fix in the banner. Settings → Diagnostics shows poll interval, request rates and measured latencies.
