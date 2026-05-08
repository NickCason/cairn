# Cairn Summarization — Design Spec

**Date:** 2026-05-08
**Status:** Approved (Nick) — ready for implementation planning
**Phase:** 1 (initial summarization)

---

## 0. Concurrent agent — coordination contract

A separate Claude Code session is concurrently working on a **diarization fix** in this same `cairn-svc` codebase. This spec is written so the two efforts can land in parallel and rebase cleanly.

### Files both efforts touch

| File | Diarization fix changes | Summarization changes | Conflict shape |
| --- | --- | --- | --- |
| `cairn_svc/server.py` | Rewrites `_run_diarization_pass`; modifies the Stop branch of `ws_transcribe` | Adds new periodic task `run_summarize_periodically`; adds new control-message handler branch in `ws_transcribe`; adds new `final_summary` step to Stop branch | **Different functions / different blocks of `ws_transcribe`.** No shared symbols beyond top-level state. |
| `cairn_svc/session.py` | Adds speaker-stitching state | Adds a transcript ledger + summary state | **Both additive.** No removed/renamed fields. |
| `cairn_svc/protocol.py` | (no changes) | Adds new message types | No conflict. |

### Files only summarization touches

- `cairn_svc/summarize.py` — new module (orchestrator, prompt builder, Ollama client, single-flight queue)
- `cairn_svc/llm_client.py` — new module (thin Ollama / OpenAI-compatible HTTP client with timeout)
- `tests/test_summarize.py`, `tests/test_llm_client.py` — new
- `tests/fixtures/summarize/*.jsonl` — new (offline LLM-output fixtures)
- `cairn-svc/.env.example` — additions only
- Cairn client (`/Users/nickcason/dev/cairn/src/renderer/*`) — `app.ts`, `ws.ts`, `transcript.ts`, `index.html`, `style.css`; new `summary.ts`
- Ollama deployment scripts on `aorus-node8` (no shared files with svc)

### Files only diarization-fix touches
Per the other agent's note: nothing exclusively theirs in cairn-svc beyond the changes captured above.

### Hard rules — both agents

1. **Do NOT reorder or restructure `ws_transcribe`** in `server.py`. Only add new blocks or replace specific named blocks (e.g., the existing Stop branch). Top-level `async def` declarations inside `ws_transcribe` keep their relative order.
2. **Do NOT rename or remove top-level state declarations** in `ws_transcribe` (the local closures and shared dicts/lists). Add new state by appending; do not refactor existing names.
3. **Additive-only edits to `session.py` and `protocol.py`.** No renaming existing fields, no reordering existing message types.
4. **Both agents leave `cairn_svc/transcribe.py`, `cairn_svc/diarize.py` (modulo the diarization fix's intended changes), `cairn_svc/vad.py`, and `cairn_svc/cleanup.py` formatting alone.** Touch only what is functionally required.
5. **Imports:** new modules import from existing modules; never the reverse direction added by the diarization fix. Summarization does not import from `diarize.py` or `transcribe.py`.
6. **One PR per effort** — do not bundle. Diarization-fix lands first if ready; summarization rebases on top.

### Soft rules

- If either agent must touch a function the other has changed, leave a `# COORDINATION:` comment marking the line and stop to surface the collision rather than silently merging intent.
- VAD silence-boundary detection is shared infrastructure; summarization **reads** boundary timestamps from the transcribe pipeline but does not modify VAD code.

---

## 1. Goal

Add a meeting-summarization layer on top of Cairn's stable STT + diarization pipeline. Two outputs:

1. **Rolling delta recap** — every ~2 minutes during the meeting, a short bullet recap of what was new in that window is appended to a sidebar list. Reader is assumed to have seen earlier entries.
2. **Final structured summary** — on Stop, a single structured artifact: TL;DR, per-speaker contributions, decisions, action items.

Both are produced server-side by an LLM running on `aorus-node8` alongside Speaches.

## 2. Non-goals (Phase 1)

- No streaming token-level rendering of summaries (whole-entry replace is fine).
- No multi-speaker action-item disambiguation beyond what the LLM produces directly.
- No retrieval/search over the rolling list.
- No translation, no multi-language summaries (English only, matching Speaches).
- No automatic re-summarization of saved sessions opened later (replay renders existing events from jsonl as-is).
- No per-rolling-entry edit history (only the latest version of each entry is kept).

---

## 3. Architecture

```
┌─────────────────┐    WS      ┌─────────────────────────┐    HTTP   ┌──────────────────┐
│ Cairn (Electron)│◀──────────▶│ cairn-svc (node4)       │──────────▶│ Ollama (node8)   │
│  - renderer     │            │  - ws_transcribe        │           │  qwen2.5:7b-q4   │
│  - summary.ts   │            │  - run_summarize_       │           │  port 11434      │
│  - sidebar list │            │      periodically (NEW) │           │  OpenAI-compat   │
│  - final view   │            │  - summarize.py (NEW)   │           └──────────────────┘
└─────────────────┘            │  - llm_client.py (NEW)  │                    ▲
                               │  - per-session queue    │                    │  shares GPU
                               └─────────────────────────┘                    │
                                            │                                 ▼
                                            │            ┌──────────────────┐
                                            ▼            │ Speaches (node8) │
                                  transcript.jsonl       │ whisper STT      │
                                  (appends new event     │ port 8000        │
                                  types)                 └──────────────────┘
```

### Components

- **`cairn_svc/summarize.py` (NEW)** — orchestrator. Owns:
  - per-session window timer (target 120s, deferred to next VAD silence boundary, slip cap 30s),
  - prompt builder (rolling and final),
  - per-session **single-flight LLM queue** — at most one LLM call in flight per session; rolling triggers and edit-driven re-summaries enqueue behind it,
  - emission of `rolling_summary` / `rolling_summary_replace` / `final_summary` events on the session WS,
  - failure handling (90s hard timeout, missed-window merge into next window).
  - **Persistence:** the server does NOT write jsonl. The Cairn client buffers every WS event and writes `transcript.jsonl` on session save (`src/main.ts:119`). The new event types must flow through the existing client-side event log unchanged — verify that the renderer's WS-event capture is type-agnostic (no allowlist) so summary events are persisted without renderer-side gating.
- **`cairn_svc/llm_client.py` (NEW)** — thin async HTTP client to Ollama's `/v1/chat/completions` endpoint (OpenAI-compatible). Handles timeout, retry-once-on-connection-error, JSON-mode response parsing.
- **`cairn_svc/session.py` (extended)** — adds:
  - `transcript_ledger`: list of finalized lines `[{seq, text, speaker_id, t_start, t_end}]` (also folds `transcript_edit` with latest-wins semantics) — this is the source of truth the summarizer reads from. Already implicitly present in transcripts; this formalizes a lookup.
  - `rolling_entries`: list of past entries `[{idx, window_start_s, window_end_s, bullets, generated_at}]`.
  - `pending_edit_seqs`: set of seqs whose edits should re-trigger re-summary on next debounce flush.
- **`cairn_svc/protocol.py` (extended)** — new outbound message types (see §6).
- **`cairn_svc/server.py` (extended)** — `ws_transcribe` gains:
  - a new `asyncio.create_task(run_summarize_periodically(session, ws))` started alongside transcribe/diarize,
  - a new control-message branch for client-initiated final summary (or just trigger on Stop),
  - in the Stop branch: await final summary completion (bounded by hard timeout) before closing the WS.
- **Cairn renderer (extended)** —
  - `index.html`: rename `Last 2 min` → `Rolling summary`; container becomes a scrollable list. Add hidden `#final-summary` view in the transcript pane region. Add `Transcript` / `Summary` toggle in the titlebar (visible after first `final_summary` event).
  - `summary.ts` (NEW): renders rolling-list entries (newest on top, timestamp), and renders the final structured summary view.
  - `ws.ts` (extended): dispatch new event types to `summary.ts`.
  - `style.css`: rolling-entry card styles, final-summary section styles, toggle button styles.

---

## 4. Data flow

### 4.1 Rolling summary (happy path)

1. Session opens. Summarizer task starts, target window length 120s (configurable), tracking `next_window_target_t = session_start + 120`.
2. While `now < next_window_target_t`, sleep in 1s ticks.
3. When `now >= next_window_target_t`:
   a. Ask VAD pipeline for the next silence boundary at-or-after `next_window_target_t`. Wait up to `slip_max_s` (30s) for one. If none arrives, force-cut at `next_window_target_t + slip_max_s`.
   b. Snapshot `transcript_ledger` for the window `[window_start_s, window_end_s]` (edit-folded text, speaker labels resolved).
   c. Snapshot `rolling_entries` (all prior recaps) as compact bullets.
   d. Enqueue an LLM call onto the session's single-flight queue. Wait for it to be picked up.
   e. On success: parse bullets, append to `rolling_entries`, emit `rolling_summary` WS event. Client persists it via the existing event-log path on session save.
   f. Set `next_window_target_t = window_end_s + 120`.
4. On timeout / error: log, set a `last_window_failed = (window_start_s, window_end_s)` flag, set `next_window_target_t = window_end_s + 120`. The next window's prompt covers the failed window's text **plus** the new window's text; the next emitted entry's `window_start_s` reflects the merged span.
5. On Stop: cancel future windows, do not emit a final partial rolling entry shorter than ~30s of speech. (See §4.3 for final summary.)

### 4.2 Edit-driven re-summary

1. `transcript_edit` arrives. `session.py` updates the ledger (latest-wins per seq) and adds `seq` to `pending_edit_seqs`.
2. Summarizer maintains a 10s debounce timer (`CAIRN_SUMMARY_EDIT_DEBOUNCE_S`). On each new edit, the timer resets.
3. When the debounce fires:
   a. Compute the set of `rolling_entries` indices whose `[window_start_s, window_end_s]` spans intersect any edited seq's `t_start`/`t_end`.
   b. For each affected entry (oldest first), enqueue a **resummarize-window** LLM call onto the same single-flight queue used by rolling triggers.
   c. On success: replace the entry in `rolling_entries`, emit a `rolling_summary_replace` WS event with the same `idx`. Client appends to its event log; on replay, latest event for that `idx` wins (see §6).
4. Edits made while a re-summary is queued/in-flight for that entry are coalesced (the queued call sees the latest ledger state).

### 4.3 Final summary

1. Triggered on Stop.
2. If a rolling re-summary or rolling trigger is in flight, wait up to 30s for the queue to drain (configurable). If still in flight at deadline, force-cancel.
3. Build the final prompt using the **edit-folded full transcript** (speaker-labeled) plus the full `rolling_entries` list as supplementary context.
4. Single LLM call with JSON-mode response (schema in §5.2). Hard timeout `CAIRN_LLM_TIMEOUT_S` (90s).
5. On success: emit `final_summary` WS event, then close WS normally. Client persists via its event log on session save.
6. On failure: emit `final_summary` event with `{ok: false, error}` payload, close WS normally. (The user can re-trigger from the saved session in a future phase; not v1.)

### 4.4 Single-flight queue semantics

- One queue per session. Items: `{kind: 'rolling' | 'resummarize' | 'final', payload}`.
- At most one item is being processed at a time.
- Final summary takes priority: when Stop arrives, the queue is drained (rolling/resummarize items dropped if not yet started; in-flight is allowed to finish or is cancelled at the 30s deadline).
- Queue depth cap: 8. If exceeded, oldest queued (non-final) items are dropped with a warning log.

---

## 5. LLM serving on aorus-node8

### 5.1 Deployment

- Deploy Ollama in Docker, matching the Speaches deploy pattern.
- Image: `ollama/ollama:latest` (CUDA build).
- Port: `11434` (host).
- Restart: `unless-stopped`.
- GPU: same Quadro P4000 8GB; Speaches keeps ~3.5GB; budget ~4.5GB for Ollama.
- Primary model: `qwen2.5:7b-instruct-q4_K_M` (~4.4GB on disk, ~4.7-5.2GB at runtime with 8K context). Use Ollama `num_gpu` (layer count) to dial offload until the model loads with ≥500MB GPU free for KV-cache spikes. Validate with `nvidia-smi` while Speaches and Ollama both serve concurrently.
- Fallback model: `llama3.2:3b-instruct-q5_K_M` (~2.5GB), used if Qwen 7B latency exceeds ~30s for a typical rolling call after partial offload tuning.
- Health check from cairn-svc: `GET /api/tags` returns 200.

### 5.2 Prompts

#### Rolling delta recap (system prompt, fixed)

> You are a meeting note-taker. Given the last segment of a live conversation transcript and a list of bullet recaps from earlier in the same meeting, produce 1–3 short bullets describing what is **new** in the latest segment. Assume the reader has seen the earlier recaps. Do not repeat earlier points. Be concrete: name decisions, questions, and action items if they appear. Skip filler. If nothing meaningful happened, output a single bullet: "(no substantive new content)".
>
> Output JSON: `{"bullets": ["...", "..."]}`. No prose outside JSON.

User prompt template:

```
PRIOR RECAPS (oldest → newest):
- [00:00–02:00] {bullets joined with "; "}
- [02:00–04:00] {bullets joined with "; "}
…

LATEST SEGMENT [{window_start_mmss}–{window_end_mmss}]:
{speaker_labeled_transcript}
```

Speaker labels in the transcript use the resolved display name (e.g., `Alice:`) when set, else `Speaker A:` etc. Empty speaker → `S?:`.

#### Final structured summary (system prompt, fixed)

> You are a meeting note-taker producing the final summary of a recorded conversation. Use the full transcript as the source of truth; the rolling recaps are supplementary context that may be coarse. Be faithful — do not invent attendees, decisions, or action items.
>
> Output JSON matching this schema (no fields outside it, no prose outside JSON):
> ```
> {
>   "tldr": "1–3 sentences",
>   "speakers": [
>     {"speaker": "<display name or label>", "contributions": ["...", "..."]}
>   ],
>   "decisions": ["...", "..."],
>   "action_items": [
>     {"assignee": "<display name or label or 'unassigned'>", "item": "...", "due": "<text or null>"}
>   ]
> }
> ```
> If a section has no items, return an empty array. `tldr` is required and non-empty.

User prompt:

```
ROLLING RECAPS (chronological):
{bulleted list}

FULL TRANSCRIPT (speaker-labeled):
{full transcript}
```

#### Re-summarize a single rolling window

Same as rolling delta recap, but `LATEST SEGMENT` is the affected window's edit-folded text, and `PRIOR RECAPS` includes only entries strictly older than that window's `idx`.

### 5.3 Token budgeting

- Rolling call: ~120s of speech ≈ 250–400 tokens of text. Prior recaps grow ~30 tokens per window. A 60-min meeting → ~30 windows → ~900 tokens of recaps + 400 tokens latest segment + ~250 tokens system/instructions ≈ ~1,600 tokens prompt. Comfortably within an 8K context.
- Final call: 60-min meeting transcript ≈ 7K–10K tokens. **Cap context to 12K tokens for the final call** (Ollama `num_ctx` set per call). If transcript exceeds the cap after speaker-labeling, truncate the **oldest** transcript text first while keeping all rolling recaps; emit a `truncated: true` flag in the resulting `final_summary` event.

---

## 6. Wire protocol additions

All new messages flow **server → client** unless noted. Added to `cairn_svc/protocol.py` as new types only — no existing types renamed.

### 6.1 `rolling_summary`

```json
{
  "type": "rolling_summary",
  "idx": 0,
  "window_start_s": 0.0,
  "window_end_s": 124.5,
  "bullets": ["...", "..."],
  "generated_at": 1715188800.123,
  "merged_from_failed_prior": false
}
```

`merged_from_failed_prior: true` when this entry's window absorbed a previously failed window per §4.1.

### 6.2 `rolling_summary_replace`

```json
{
  "type": "rolling_summary_replace",
  "idx": 3,
  "bullets": ["...", "..."],
  "generated_at": 1715189000.456,
  "reason": "edit"
}
```

Client replaces the entry at `idx` in place. Window bounds do not change.

### 6.3 `final_summary`

```json
{
  "type": "final_summary",
  "ok": true,
  "tldr": "...",
  "speakers": [{"speaker": "Alice", "contributions": ["..."]}],
  "decisions": ["..."],
  "action_items": [{"assignee": "Bob", "item": "...", "due": null}],
  "truncated": false,
  "model": "qwen2.5:7b-instruct-q4_K_M",
  "generated_at": 1715189100.789
}
```

On failure: `{"type": "final_summary", "ok": false, "error": "<message>", "model": "...", "generated_at": ...}`.

### 6.4 jsonl persistence

The **client** writes `~/Documents/Cairn/<date>-<meeting-name>/transcript.jsonl` on session save (`src/main.ts:119`). Each line is the raw WS message + `_recv_ts`. The new summary event types follow this convention with no special handling required, **provided** the client's event-log capture is not gated on a type allowlist. Implementation must verify and, if needed, widen the capture path.

On replay:
- `rolling_summary`: append to in-memory list at `idx`.
- `rolling_summary_replace`: replace existing entry at `idx`. Latest event wins.
- `final_summary`: render in the final-summary view; if multiple `final_summary` events exist (e.g., a failed one followed by a successful retry in a future phase), latest wins.

### 6.5 Client → server (none in v1)

Final summary is triggered by the existing Stop control flow, not a new client message.

---

## 7. UI changes (Cairn renderer)

### 7.1 Sidebar — rolling list

- `index.html`: change `<h2 class="pane-title summary-title">Last 2 min</h2>` → `Rolling summary`.
- Replace `<div id="summary" class="summary-stub">—</div>` with `<div id="rolling-list" class="rolling-list"></div>`.
- Each entry rendered as a card:
  ```html
  <div class="roll-entry" data-idx="0">
    <div class="roll-time">00:00 – 02:04</div>
    <ul class="roll-bullets"><li>…</li></ul>
  </div>
  ```
- Newest on top. Sidebar already scrolls (`.pane { overflow-y: auto }`).
- Empty state: `<div class="rolling-empty">No summary yet — first recap appears around 2:00.</div>`
- `merged_from_failed_prior` entries get a small `↻` glyph next to the time range.
- `rolling_summary_replace` re-renders the matching `data-idx` card with no animation other than a 1s subtle background fade to indicate it changed.

### 7.2 Final summary view + Transcript/Summary toggle

- New hidden section inside the transcript pane:
  ```html
  <section class="pane transcript">
    <h2 class="pane-title">Transcript</h2>
    <div id="transcript-lines"></div>
    <div id="final-summary" hidden></div>
  </section>
  ```
- New titlebar buttons (visible only after the first `final_summary` event for the session):
  ```html
  <button id="view-transcript" class="ghostbtn" hidden>Transcript</button>
  <button id="view-summary" class="ghostbtn" hidden>Summary</button>
  ```
- Default view post-Stop: Summary visible, Transcript hidden. Toggle swaps `hidden` on the two children.
- `final-summary` content rendered by `summary.ts`:
  - TL;DR as a single paragraph.
  - Speakers as a list of `<h3>{name}</h3><ul>…</ul>` blocks.
  - Decisions as `<h3>Decisions</h3><ul>…</ul>`.
  - Action items as a table with columns: Assignee, Item, Due.
  - If `truncated: true`, render a small banner: "Transcript truncated for summarization (>12K tokens). Final summary may miss some early content."

### 7.3 Styling

Add to `style.css`:
- `.rolling-list` (vertical flex, gap 8px).
- `.roll-entry` (card, similar to `.summary-stub` background/border).
- `.roll-time` (muted, 11px, uppercase optional).
- `.roll-bullets` (small li padding, no list-style markers, indent 12px).
- `.roll-entry.changed` (1s fade highlight).
- `#final-summary` typography (sectioned, slightly larger than transcript text for scannability).

### 7.4 Saved-session replay

Existing replay path (which renders historic `transcript.jsonl`) is extended in `transcript.ts` (or a small extension in `summary.ts`) to dispatch `rolling_summary` / `rolling_summary_replace` / `final_summary` events through the same handlers used live. No special-case code: the renderer is event-driven and replay is just the same events arriving fast.

---

## 8. Configuration

Added to `~/cairn-svc/.env` (and `.env.example`):

```
CAIRN_LLM_URL=http://100.122.121.18:11434
CAIRN_LLM_MODEL=qwen2.5:7b-instruct-q4_K_M
CAIRN_LLM_TIMEOUT_S=90
CAIRN_LLM_NUM_CTX_FINAL=12288
CAIRN_SUMMARY_WINDOW_S=120
CAIRN_SUMMARY_VAD_SLIP_MAX_S=30
CAIRN_SUMMARY_EDIT_DEBOUNCE_S=10
CAIRN_SUMMARY_FINAL_DRAIN_S=30
CAIRN_SUMMARY_QUEUE_MAX=8
CAIRN_SUMMARY_ENABLED=true
```

`CAIRN_SUMMARY_ENABLED=false` disables the entire summarizer task without code changes — useful for fallback if Ollama is misbehaving or for the diarization-fix agent's testing if needed.

---

## 9. Failure handling — recap

| Failure | Response |
| --- | --- |
| Ollama unreachable on a rolling call | 90s hard timeout → fail. Next window absorbs the failed window's text; client sees an `↻` marker on the merged entry. |
| Ollama unreachable on a re-summary | 90s hard timeout → fail. Affected entry stays as-is; pending edit seqs remain in the set and re-trigger on next edit. |
| Ollama unreachable on final summary | 90s hard timeout → fail. `final_summary` event with `ok: false` is emitted and persisted. WS closes normally. |
| LLM returns invalid JSON | One repair retry: append "Output valid JSON only." to the prompt and re-call. If still bad: treat as failure for that call. |
| Edit arrives during in-flight call | Edit is recorded in ledger immediately; the in-flight call is not cancelled. The next debounce tick processes pending seqs against the (now-updated) entry. |
| Stop arrives during in-flight rolling | Wait up to `CAIRN_SUMMARY_FINAL_DRAIN_S` (30s) for drain. Then proceed to final regardless. |
| Speaches outage (no transcripts) | Rolling task continues to fire every 120s; if a window has zero new text, summarizer skips the LLM call and emits no entry (does not advance `last_window_failed`). |

---

## 10. Testing

### 10.1 Unit tests (`tests/test_summarize.py`)

- Window scheduler: target time + VAD-slip behavior (mock `find_commit_boundary_s`).
- Single-flight queue: ordering, final-priority drain, depth cap.
- Failure-merge: a failed window's text appears in the next window's prompt; `merged_from_failed_prior=true` on the resulting event.
- Edit debounce: rapid edits coalesce to one re-summary; affected indices computed correctly when an edit straddles a window boundary.
- Empty-window skip: zero new finals → no LLM call, no event.

### 10.2 Unit tests (`tests/test_llm_client.py`)

- HTTP timeout enforced.
- One retry on connection-reset; no retry on HTTP 4xx.
- JSON-mode parsing; invalid JSON triggers the repair retry path.

### 10.3 Fixture-driven integration test

- Replay `cairn-svc/tests/fixtures/live-2026-05-08.jsonl` through the summarizer with the LLM client mocked to return canned bullet payloads from `tests/fixtures/summarize/*.jsonl`.
- Assert: N rolling events emitted at expected windows, edits trigger expected re-summary, final event matches schema.

### 10.4 Manual smoke test

- Run a 5-min mock meeting in dev (`npm start` + cairn-svc on node4 + Ollama on node8 with real model).
- Verify: 2 rolling entries appear in sidebar at ~2:00 and ~4:00; final summary appears on Stop; transcript/summary toggle swaps panes; saved session replays summaries from disk.
- Verify GPU: `ssh nick@aorus-node8 nvidia-smi` shows Speaches + Ollama both resident, no OOM.

---

## 11. Implementation ordering (rough)

1. Ollama deploy on node8 + `llm_client.py` + tests. Verify a single `/v1/chat/completions` round-trip from cairn-svc with both Speaches and Ollama up.
2. `summarize.py` skeleton: window scheduler + single-flight queue + ledger snapshot. Mock LLM client. Unit tests.
3. Wire `run_summarize_periodically` into `ws_transcribe`. Smoke test with real LLM, no edits.
4. Edit-driven re-summary path. Unit tests + fixture-driven test.
5. Final summary path (Stop branch hook). Unit + smoke.
6. Renderer: rolling list rendering. Smoke against real svc.
7. Renderer: final summary view + toggle. Smoke.
8. Replay: confirm saved sessions render summaries from jsonl unchanged.

Each step is a candidate for a separate implementation-plan task.

---

## 12. Open questions / phase-2 carryover

- **Re-run final summary later** — not in v1; user can re-trigger from a saved session in a future phase by replaying transcript.jsonl through the summarizer.
- **Streaming token rendering** — not in v1; whole-entry replace is acceptable.
- **Action-item export** (e.g., to a Notion task DB) — out of scope; the `action_items` JSON is structured enough to add later.
- **Long-meeting context overflow** — handled v1 by oldest-truncation with a banner; smarter compression deferred.
- **Cross-meeting memory** (e.g., recurring participants, ongoing project context) — out of scope for Phase 1.
