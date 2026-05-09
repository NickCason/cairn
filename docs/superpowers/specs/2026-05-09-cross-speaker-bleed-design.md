# Cross-speaker bleed fix — auth-pass word split + e2e test harness

**Status:** approved 2026-05-09
**Owner:** Nick / Claude
**Supersedes:** the reverted streaming-time approach in `2026-05-09-word-level-speaker-split-design.md`. Read `2026-05-09-cross-speaker-bleed-handoff.md` for the post-mortem of the failed attempt before touching code.

## Problem

A single `transcript_final` can contain words from two speakers when the silence between them is shorter than VAD's `min_silence_ms` (default 500 ms). Whisper transcribes the run as one segment; today `_drain_pending` calls `assign_speaker(t0, t1, diar_segs)` once per segment and picks the speaker with greatest overlap, attributing the entire text to one speaker.

Concrete instance from the 2026-05-09 Lex/Dario run, seq 64: `"compute. Yes. All of those. In particular, linear scaling up..."` — Lex's last word "compute" got attached to Dario's reply because Dario started immediately. The whole final was attributed to Dario.

A previous attempt at fixing this in the streaming path produced phantom speakers, ate the user's manual retags, and was reverted. The signal we need is auth-pass diarization (full-audio pyannote) which is far more accurate than streaming diar — but it's only available at scheduled auth ticks, not in real time.

## Goals

- No `transcript_final` displayed to the user (after the next auth tick) contains words from more than one speaker.
- The user's manual retags via `transcript_edit` survive auth-pass reconciliation.
- An end-to-end test harness lets us drive a Cairn recording + Safari/YouTube playback loop without manual UI clicks, and grade the output against a ground-truth transcript.
- The 10-minute Lex/Dario test (`https://www.youtube.com/watch?v=ugvHCXCOmm4&t=194s`, ground truth at `https://lexfridman.com/dario-amodei-transcript`) shows a low bleed rate AND clean per-sentence rows on visual inspection.

## Non-goals

- Within-speaker mid-sentence cuts (one thought split across two consecutive finals because of a brief mid-thought pause). Out of scope.
- Streaming-time word splitting. The streaming path keeps today's per-segment `assign_speaker`; corrective splits happen only at auth-pass time.
- Regenerating rolling summaries that referenced unsplit rows. The handoff scopes this work to the bleed itself; if stale-summary rot becomes visible, it's a follow-up.
- A new "user_unlock" UX. Once `user_locked` is set on a row, the only way to clear it is to edit the row again.

## Design

### 1. Pipeline shape

```
streaming path (unchanged in shape, plus words on the ledger):
  whisper segs → pending_finals (now carries words, absolute-time) → _drain_pending
    → per-segment assign_speaker (smoothing) → emit ONE TranscriptFinalMsg per pending
    → session.append_final(seq, ..., words=[...])  # words persisted on ledger row

auth-pass path (new corrective layer):
  scheduled tick or on-stop → _run_authoritative_pass → auth_diar_segs
    → _reconcile_ledger (existing) → emit speaker_relabel events as today
    → NEW: _split_eligible_rows(session, auth_diar_segs)
       for each ledger row whose words straddle ≥2 auth speakers AND not user_locked:
         runs = _split_into_runs(row.words, auth_diar_segs)
         if len(runs) > 1:
           rewrite ledger row N → row N (first run) + new rows N′, N′+1, …
           emit TranscriptSplitMsg(original_seq=N, rows=[...])

manual-edit hardening (new):
  transcript_edit handler → set ledger[seq].user_locked = True
  _reconcile_ledger → skip rows where user_locked is True
  _split_eligible_rows → skip rows where user_locked is True
```

Five new things in the system: (1) words on ledger rows, (2) `_split_eligible_rows` at auth-tick time, (3) `TranscriptSplitMsg` protocol message + client handler, (4) `user_locked` flag on ledger rows, (5) test harness + grading script.

### 2. Word storage on ledger rows

`Session.append_final` gains `words: list[TranscriptWord] | None = None`. The ledger row dict gains a `words` field. On stop, words are persisted to the saved JSON as `[{text, t_start_ms, t_end_ms}, ...]`.

**Critical: word-time domain.** Whisper word timestamps are CHUNK-RELATIVE (each chunk starts at 0). The fix from the failed attempt: in `transcribe_recent`, when pushing into `pending_finals`, wrap each word with absolute timestamps by adding `t_offset_ms` (the same offset already applied to the segment-level `t0`/`t1`). This must happen at the call site, not inside `_split_into_runs`.

```python
abs_words = [
    TranscriptWord(
        text=w.text,
        t_start_ms=t_offset_ms + w.t_start_ms,
        t_end_ms=t_offset_ms + w.t_end_ms,
    )
    for w in s.words
]
pending_finals.append((seq, text, t0, t1, abs_words))
```

The integration test for this MUST construct `TranscriptSegment.words` with chunk-relative timestamps (0..chunk_duration_ms) and assert that ledger rows post-`_drain_pending` carry absolute-time words. Don't repeat the failed attempt's mistake of testing the helper with already-absolute words.

### 3. `_split_into_runs(words, diar_segs)`

Pure function in `cairn_svc/server.py` (module scope). Same shape as the failed attempt's helper — that helper itself was sound; the bug was the call site. Reproducing here:

```python
@dataclass
class _Run:
    speaker_id: str
    t_start_ms: int
    t_end_ms: int
    text: str
    words: list  # underlying TranscriptWord list — used if a run later re-splits

def _split_into_runs(
    words: list,
    diar_segs: list[DiarizationSegment],
) -> list[_Run] | None:
    if not words:
        return None
    raw: list[str] = []
    for w in words:
        best_label = ""
        best_overlap = 0
        for d in diar_segs:
            ov = max(0, min(w.t_end_ms, d.t_end_ms) - max(w.t_start_ms, d.t_start_ms))
            if ov > best_overlap:
                best_overlap = ov
                best_label = d.label
        raw.append(best_label)
    if not any(raw):
        return None
    filled = list(raw)
    last_known = ""
    for i, lbl in enumerate(filled):
        if lbl:
            last_known = lbl
        elif last_known:
            filled[i] = last_known
    next_known = ""
    for i in range(len(filled) - 1, -1, -1):
        if filled[i] and not next_known:
            next_known = filled[i]
        if not filled[i] and next_known:
            filled[i] = next_known
    runs: list[_Run] = []
    cur_label = filled[0]
    cur_words = [words[0]]
    for w, lbl in zip(words[1:], filled[1:]):
        if lbl == cur_label:
            cur_words.append(w)
            continue
        runs.append(_Run(
            speaker_id=cur_label,
            t_start_ms=cur_words[0].t_start_ms,
            t_end_ms=cur_words[-1].t_end_ms,
            text=" ".join(x.text.strip() for x in cur_words),
            words=list(cur_words),
        ))
        cur_label = lbl
        cur_words = [w]
    runs.append(_Run(
        speaker_id=cur_label,
        t_start_ms=cur_words[0].t_start_ms,
        t_end_ms=cur_words[-1].t_end_ms,
        text=" ".join(x.text.strip() for x in cur_words),
        words=list(cur_words),
    ))
    return runs
```

Run-grouping policy: **always split** — any speaker change between consecutive words is a split point. The signal at auth-pass time is trustworthy, unlike streaming diar.

Idempotent re-split: if a row's words have already been split into runs once, the next auth tick operates on each post-split row independently. A row whose words all map to one auth speaker yields `runs of length 1` — no-op. So splits compound monotonically without thrashing.

### 4. `_split_eligible_rows(session, auth_diar_segs)`

New helper in `cairn_svc/server.py`. Called inside `_run_authoritative_pass`, immediately after `_reconcile_ledger` finishes (so any `speaker_relabel` events have already flowed and the ledger reflects the latest auth-pass speaker assignments). Runs on every auth tick at the existing scheduler's configured cadence (`CAIRN_AUTH_DIAR_FIRST_TICK_S` and the existing doubling schedule) and on the on-stop tick.

Per-row procedure:

1. Skip if `row.words is None or len(row.words) == 0` (no per-word timestamps; cannot split).
2. Skip if `row.user_locked is True`.
3. `runs = _split_into_runs(row.words, auth_diar_segs)`.
4. If `runs is None` (all unknown) → no-op.
5. If `len(runs) == 1` → no-op.
6. If `len(runs) >= 2`:
   - Replace `ledger[i]` (row at the matched seq) with run-0 fields (text/speaker_id/t_start/t_end/words from `runs[0]`).
   - For `runs[1:]`: allocate fresh seqs via `session.next_seq()`; call `session.append_final(seq=new_seq, text=..., speaker_id=..., t_start=..., t_end=..., words=...)`.
   - For each run whose `speaker_id` is not in the connection's `sent_speakers` set, emit a `SpeakerAssignedMsg` first.
   - Emit a single `TranscriptSplitMsg(original_seq=row.seq, rows=[SplitRow(...) for runs])`.

The function returns the count of splits performed, for observability/log lines.

### 5. `TranscriptSplitMsg` protocol message

Add to `cairn_svc/protocol.py`:

```python
class SplitRow(BaseModel):
    seq: int
    text: str
    speaker_id: str
    t_start_ms: int
    t_end_ms: int

class TranscriptSplitMsg(BaseModel):
    type: Literal["transcript_split"] = "transcript_split"
    original_seq: int
    rows: list[SplitRow]
```

Add to the `ServerMsg` union and to the renderer's `ServerMsg` discriminated union (`src/renderer/protocol.ts` or the equivalent file — verify location during implementation).

Atomicity rationale: stitching the same effect from `speaker_relabel` + invented insert + invented delete primitives would mean reasoning about ordering and partial application. One semantic message keeps client logic local and easy to test.

### 6. Client handling — `src/renderer/transcript.ts`

New method on `TranscriptView`: `splitLine(originalSeq: number, rows: SplitRow[])`. Signature mirrors existing `relabelLine(seq, speakerId)`.

Behavior:

1. Find the row element for `originalSeq` (existing seq → DOM lookup).
2. Mutate that element in place to reflect `rows[0]` (text, speaker, t_start, t_end).
3. For each `rows[1:]`, build a new row element using the same render path as a fresh `transcript_final`.
4. Insert the new rows into the DOM in time-order alongside other rows that share the time range. The existing time-ordered insert helper handles this.
5. Update the speaker panel (existing `speaker_assigned` flow already handles new speakers; the server emits `SpeakerAssignedMsg` before the split for any new speaker, so the panel is up-to-date by the time the split lands).

`renderer/index.ts` (or main message dispatch) handles the new `transcript_split` type and routes to `view.splitLine(...)`.

Sentence-overhang gap guard already lives in `transcript.ts` (`lastFinalEndMs`-based coalesce gate). The split only mutates existing rows + inserts new rows; the coalesce path is for incoming new finals from `_drain_pending`, not for splits. No interaction.

Idempotent receive: if the client receives the same `TranscriptSplitMsg` twice (network blip, replay), the second apply finds rows[0] still matches `originalSeq` and the new seqs already exist — re-applying overwrites with identical content, so it's a no-op visually.

### 7. Manual-edit clobber fix (`user_locked`)

Add to `Session`:

```python
# In Session._ledger row dict: 'user_locked': bool, default False.
```

Persisted to disk on stop (existing JSON save loop).

`transcript_edit` handler in `server.py` (the path that handles user-driven retags from the UI): after applying the new `speaker_id`, set the ledger row's `user_locked = True`.

`_reconcile_ledger`: when iterating ledger rows to compare against auth-pass speaker assignments, skip rows where `user_locked` is True. The auth-pass speaker_id is recorded internally for centroid math (so the underlying voice model still incorporates the row's audio) but the row's displayed `speaker_id` is not overwritten and no `speaker_relabel` is emitted for it.

`_split_eligible_rows`: skip user-locked rows entirely (do not split them).

Edge case: user retags a row that the auth pass would later split. The user's edit wins. Acceptable — they've signaled intent.

No client-side change. The client doesn't need to know about `user_locked`; it only sees the resulting (stable) `speaker_id`.

### 8. Test harness — Electron HTTP control endpoint

New file `src/main/control_server.ts` (or inline in `src/main.ts`). The Electron main process opens a small HTTP listener on `127.0.0.1:8765` (configurable via `CAIRN_CONTROL_PORT` env var, default 8765 — pick a port unlikely to clash; rationale for not using 8300: cairn-svc holds 8300 on node4, and using a distinct port avoids confusion).

Endpoints:

- `POST /control/start` — body optional `{ "meeting_name": "<name>" }`. Sends an IPC message to the renderer (`mainWindow.webContents.send('cairn:control-start', { meeting_name })`) which the renderer handles by invoking the same code path the Start button calls. Returns `{ "ok": true, "meeting_name": "<resolved>" }` after the renderer ACKs back via IPC, or `{ "ok": false, "error": "no window" }` if no window is open.
- `POST /control/stop` — sends `cairn:control-stop` IPC. Returns `{ "ok": true }` after ACK.
- `GET /control/status` — returns `{ "state": "idle"|"recording"|"stopping"|"stopped", "meeting_name": "...", "session_dir": "<path or null>", "ledger_count": <int> }`. Renderer reports state via IPC; main process caches it.
- `GET /control/transcript` — returns the current session's transcript as JSON (the same data the saved file would have, but live). Useful for the harness to snapshot mid-test.

Renderer side: handlers in `src/renderer/index.ts` (or wherever the existing Start button handler lives) listen for `cairn:control-start` / `cairn:control-stop` IPC events and dispatch the same logic the buttons do. State changes are reported back via `window.api.reportControlState(...)` (a small preload-exposed function).

`preload.ts` exposes:
- `onControlStart(handler)`
- `onControlStop(handler)`
- `reportControlState(state)`
- `reportTranscript(serializedJson)` (for `/control/transcript`)

Security: the listener binds to `127.0.0.1` only — never `0.0.0.0`. Rejects requests with no `Host: 127.0.0.1` header to defang DNS rebinding. No auth token (loopback-only is the gate; this is a dev affordance, not a production endpoint).

### 9. Test harness — `scripts/cairn-loop.sh`

Bash orchestration script in `scripts/`. Invocation:

```
scripts/cairn-loop.sh \
  --url 'https://www.youtube.com/watch?v=ugvHCXCOmm4&t=194s' \
  --duration 600 \
  --out /tmp/cairn-test-runs
```

Defaults if not specified:
- `--url`: the Dario YouTube link above.
- `--duration`: 600 (10 minutes).
- `--out`: `/tmp/cairn-test-runs/run-$(date +%Y%m%d-%H%M%S)/`.

Flow:

1. Pre-flight checks:
   - `pgrep -f "Cairn.app/Contents/MacOS"` — if Cairn isn't running, launch it (`open -a Cairn`) and `sleep 4` for the renderer to come up.
   - `curl -fsS http://127.0.0.1:8765/control/status` — confirm control endpoint is reachable.
   - Confirm BlackHole device exists: `ffmpeg -f avfoundation -list_devices true -i "" 2>&1 | grep -i blackhole` (informational; we don't fail on this since the user manages audio routing).
2. Quit Safari: `osascript -e 'tell application "Safari" to quit'`. Wait until `pgrep -f Safari` returns nothing (`while pgrep -f Safari > /dev/null; do sleep 0.5; done`, with a 10 s timeout).
3. Start Cairn recording: `curl -fsS -X POST http://127.0.0.1:8765/control/start -H 'Content-Type: application/json' -d '{"meeting_name":"loop-<timestamp>"}'`. Verify response `ok=true`.
4. Open Safari at the URL: `open -a Safari "<url>"`. Wait 3 s for the page to load.
5. Trigger play: `osascript -e 'tell application "Safari" to activate' -e 'tell application "System Events" to keystroke " "'`. (YouTube's `?t=Xs` cues to that timestamp; pressing Space starts playback. Some pages autoplay; the Space is a safety net.)
6. Sleep `${duration}` seconds.
7. Stop Cairn recording: `curl -fsS -X POST http://127.0.0.1:8765/control/stop`. Verify `ok=true`.
8. Poll `/control/status` until `state == "stopped"` (timeout 90 s — enough for the on-stop auth pass on a 10-minute tail).
9. Snapshot the transcript: `curl -fsS http://127.0.0.1:8765/control/transcript > "$OUT/transcript.json"`.
10. Run the grader: `python3 scripts/grade-transcript.py --transcript "$OUT/transcript.json" --reference scripts/fixtures/dario-reference.json --out "$OUT/grade.json"`.
11. Print the score line: `Bleed rate: X% (Y/Z gradeable finals); off-script finals: W; total: T`.
12. Exit 0 on a successful run regardless of the score (the grade is informational; the loop is for the human to read).

The script is idempotent: each iteration uses a fresh output directory under `--out`. Reruns don't clobber prior runs.

### 10. Grading script — `scripts/grade-transcript.py`

Inputs:
- `--transcript`: a Cairn transcript file. Accepts either JSON (single array, the `/control/transcript` snapshot shape) or JSONL (newline-delimited, the on-stop saved-to-disk shape). The grader auto-detects by sniffing the first non-whitespace character. Each entry has `seq`, `text`, `speaker_id`, `t_start_ms`, `t_end_ms`, `words` (optional).
- `--reference`: a ground-truth JSON file. Pre-derived from `https://lexfridman.com/dario-amodei-transcript` and saved as `scripts/fixtures/dario-reference.json`. Format:

```json
{
  "url": "https://lexfridman.com/dario-amodei-transcript",
  "anchor_sec": 194,
  "entries": [
    { "speaker": "Dario", "t_start_sec": 194.0, "t_end_sec": 207.5, "text": "..." },
    { "speaker": "Lex",   "t_start_sec": 207.5, "t_end_sec": 215.0, "text": "..." },
    ...
  ]
}
```

`anchor_sec = 194` because YouTube `&t=194s` is when Cairn starts recording — the reference timestamps are absolute video time, but Cairn's transcript timestamps start at 0 when the recording begins. Converting between them: `cairn_ms == reference_sec_after_anchor * 1000 == (reference_sec - 194) * 1000`. Concretely, when comparing, the script subtracts `anchor_sec` from each reference entry's t_start/t_end before alignment.

The reference file is built once from the lexfridman.com page (a separate one-shot scraper script `scripts/build-reference.py` or, simpler, a manual paste-and-reformat done at implementation time). Lex's video has lines that the official transcript misses; we capture only what's in the official transcript, and the grader treats Cairn finals with no reference overlap as "off-script" (excluded from the bleed-rate denominator).

Algorithm:

```
load reference; subtract anchor_sec from each entry's t_start/t_end → reference_ms
load cairn transcript

bleed_finals = 0
gradeable_finals = 0
off_script_finals = 0

for each cairn final c:
  c_speakers = set of reference entries r where overlap(c, r) > MIN_OVERLAP_MS (=50 ms)
  if no overlap with any reference entry:
    off_script_finals += 1
    continue
  gradeable_finals += 1
  if len(distinct r.speaker for r in c_speakers) >= 2:
    bleed_finals += 1
    record { cairn_seq: c.seq, cairn_text: c.text, cairn_speaker: c.speaker_id, ref_speakers: [...] }

bleed_rate = bleed_finals / gradeable_finals if gradeable_finals else 0
print(score line); write detailed JSON to --out
```

Output JSON shape (`grade.json`):

```json
{
  "summary": {
    "total_finals": 472,
    "gradeable_finals": 401,
    "bleed_finals": 12,
    "off_script_finals": 71,
    "bleed_rate": 0.030
  },
  "bleeds": [
    { "seq": 64, "text": "compute. Yes. All of those.", "cairn_speaker": "S1", "ref_speakers": ["Dario", "Lex"] },
    ...
  ]
}
```

`MIN_OVERLAP_MS = 50` — small enough to count brief crosstalk, large enough to ignore boundary jitter.

Reference build process at implementation time: download the HTML page once (`curl https://lexfridman.com/dario-amodei-transcript > /tmp/dario.html`), parse it (the page renders speaker turns as `<p>` elements with timestamp anchors near the top of each), and emit `dario-reference.json`. If the parse is brittle, fall back to a 30-minute manual transcription of the first 10 minutes only — we need just the first 10 minutes for this test. Either path is acceptable; commit the resulting JSON fixture into the repo so the grader is hermetic.

### 11. Saved-transcript JSON forward compatibility

Adding `words` and `user_locked` fields on ledger rows changes the saved-on-stop JSON shape. Loaders must default missing fields:

- Old transcript loaded: `words` defaults to `None`, `user_locked` defaults to `False`. Existing tests that load saved transcripts must still pass.

No version bump in the saved file format — additive additions only.

## Edge cases and guardrails

- **Whisper segment with no words.** `_split_into_runs` returns `None`; `_split_eligible_rows` no-ops on the row. The row keeps its streaming-time speaker_id forever.
- **Auth pass produces a single-word phantom run.** Always-split policy will dutifully split. Subsequent auth passes re-cluster on full audio and may merge the phantom into a real speaker (existing `speaker_merge` path) or split further. This is the same convergence behavior `_reconcile_ledger` relies on today.
- **Row already user-locked when auth tick runs.** Skipped by both `_reconcile_ledger` and `_split_eligible_rows`. The row's audio is still factored into centroid math via auth-pass clustering — only the displayed attribution is locked.
- **Words straddle `silence` between auth segs.** Unknown-fill logic: a word with zero overlap to any auth seg adopts the immediately-preceding known speaker, or the immediately-following known speaker if it precedes any known word. Same logic as the original failed-attempt helper; that helper itself was correct.
- **Consecutive same-speaker auth segs (e.g. brief silence split).** Words across them group as one run, since grouping is by `speaker_id`, not by seg identity.
- **Re-emit of `TranscriptSplitMsg` after a network blip.** Idempotent; client overwrites with identical content.
- **Concurrent `transcript_edit` arrives during an auth pass.** The auth pass is async; edits happen on the same event loop. Worst case: edit lands after `_split_eligible_rows` has already split the row — the user is editing one of the post-split rows by its new seq, which is fine. Edit lands before split runs — `user_locked` is set, split skips the row, fine.

## Testing strategy

**Unit tests on node4** (`~/cairn-svc/tests/`):

- `tests/test_word_split.py` (re-instated from the failed attempt's spec, with the call-site test added):
  - Single-speaker → one run.
  - Mid-segment flip → two runs.
  - Three-speaker alternation → three runs.
  - All unknown → `None`.
  - Unknown sandwiched → joins preceding.
  - Unknown at start → joins following.
  - Run t-range from first/last word (not segment).
  - Whitespace strip + single-space join.
  - Consecutive same-speaker different segs → one run.
- `tests/test_drain_pending_words.py`:
  - `test_drain_pending_writes_absolute_words_to_ledger`: feed `transcribe_recent` a fake whisper segment with chunk-relative words at non-zero `t_offset_ms`; assert the resulting ledger row has absolute-time words. **This is the test that would have caught the failed attempt's bug.**
- `tests/test_split_eligible_rows.py`:
  - Single-speaker row → no split.
  - Two-speaker row → split, ledger has 2 rows, `TranscriptSplitMsg` emitted with correct seqs (first inherits original, second is fresh), `SpeakerAssignedMsg` for any new speaker.
  - User-locked row that would split → no split.
  - All-unknown row → no split.
  - Re-running on already-split rows → no-op (idempotent).
- `tests/test_user_locked.py`:
  - `transcript_edit` handler sets `user_locked` on target row.
  - `_reconcile_ledger` skips user-locked rows (no `speaker_relabel` emitted).
  - `_split_eligible_rows` skips user-locked rows.
  - User-locked field persists through save/load cycle.

**Integration / smoke**:

- Existing `test_smoke_ws.py` and `test_authoritative.py` should pass without modification — words on the ledger don't change any external surface they assert on. Verify by running the full svc suite after each implementation task.

**End-to-end (the user-facing acceptance gate)**:

- Run `scripts/cairn-loop.sh` for 10 minutes against the Lex/Dario YouTube link. Expected outcome: bleed rate < 5% on gradeable finals, sentence-level coherence visible in the saved transcript, no phantom-speaker explosion at session start (the failed attempt's regression).
- The user explicitly asked for the full 10-minute transcript and grade before this work is called complete.

## File touches

| File | Change |
| --- | --- |
| `cairn_svc/server.py` | Add `_Run` dataclass, `_split_into_runs` helper, `_split_eligible_rows` helper. Update `transcribe_recent` to push absolute-time words into 5-tuple `pending_finals`. Update `_drain_pending` to unpack 5-tuple, pass `words=...` to `session.append_final`. Update `_run_authoritative_pass` to call `_split_eligible_rows` after `_reconcile_ledger`. Update `transcript_edit` handler to set `user_locked=True` on the target row. Update `_reconcile_ledger` to skip user-locked rows. |
| `cairn_svc/session.py` | Extend ledger row dict with `words` and `user_locked` fields. Extend `append_final` signature to accept `words`. Save/load cycle handles new fields with defaults. |
| `cairn_svc/protocol.py` | Add `SplitRow` and `TranscriptSplitMsg` Pydantic models. Add `TranscriptSplitMsg` to `ServerMsg` union. |
| `cairn_svc/transcribe.py` | No change. (`TranscriptSegment.words` already produced.) |
| `tests/test_word_split.py` | New unit tests for `_split_into_runs`. |
| `tests/test_drain_pending_words.py` | New integration test for chunk-relative → absolute word time fix. |
| `tests/test_split_eligible_rows.py` | New tests for the auth-pass split helper. |
| `tests/test_user_locked.py` | New tests for the manual-edit lock. |
| `tests/test_session.py` | Extend with persistence-roundtrip test for `words` + `user_locked`. Add migration test: load a pre-existing saved JSONL (no `words`, no `user_locked`) and assert the loader defaults `words=None`, `user_locked=False` without erroring. |
| `src/renderer/protocol.ts` (or wherever `ServerMsg` lives) | Add `TranscriptSplitMsg` to the union; add `SplitRow` type. |
| `src/renderer/transcript.ts` | Add `splitLine(originalSeq, rows)` method. Wire into the dispatch in `index.ts`. |
| `src/renderer/index.ts` (or main message handler) | Route `transcript_split` to `view.splitLine(...)`. |
| `src/main.ts` | Open HTTP control listener on 127.0.0.1:8765. Handle Start/Stop IPC roundtrip. |
| `src/preload.ts` | Expose `onControlStart`, `onControlStop`, `reportControlState`, `reportTranscript`. |
| `src/renderer/index.ts` | Listen for control IPC, dispatch start/stop the same way the buttons do, report state back. |
| `scripts/cairn-loop.sh` | New bash harness. |
| `scripts/grade-transcript.py` | New Python grader. |
| `scripts/build-reference.py` (optional one-shot) | Builds `dario-reference.json` from the lexfridman.com page. |
| `scripts/fixtures/dario-reference.json` | Committed ground-truth fixture for grading. |

## Out of scope (explicit)

- Within-speaker mid-sentence cuts.
- Streaming-time word splitting.
- Regenerating rolling/final summaries that referenced unsplit rows.
- A "user_unlock" UX. The lock can only be re-set by re-editing.
- Tightening VAD `min_silence_ms` from 500 ms. Considered as a complementary fix but parked — auth-pass split addresses the root cause; revisit only if the harness shows residual bleed > 5%.
- Production hardening of the control endpoint (no auth, loopback-only is the gate). It's a dev affordance.
