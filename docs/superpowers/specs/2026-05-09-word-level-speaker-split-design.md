# Word-level speaker splitting (cross-speaker bleed fix)

**Status:** approved 2026-05-09
**Owner:** Nick / Claude

## Problem

A single `transcript_final` can contain words from two speakers when the silence between them is shorter than VAD's `min_silence_ms` (500 ms). Whisper transcribes the run as one segment; today `_drain_pending` calls `assign_speaker(t0, t1, diar_segs)` once per segment and picks the speaker with greatest overlap, attributing the entire text to one speaker.

Concrete instance from the 2026-05-09 Lex/Dario run, seq 64: `"compute. Yes. All of those. In particular, linear scaling up..."` — Lex's last word "compute" got attached to Dario's reply because Dario started immediately. The whole final was attributed to Dario (S1 in that run).

The user has accepted that within-speaker mid-sentence cuts (a single thought split across two consecutive finals) are out of scope; only **cross-speaker bleeding** is in scope here.

## Goals

- No `transcript_final` contains words from more than one speaker.
- The split happens in real time as part of the streaming pipeline; no retroactive auth-pass workaround needed.
- Single-speaker segments (the dominant case) keep the same behavior they have today: one pending → one final.
- Splitting policy: aggressive — if any word's speaker differs from the preceding word's, that's a split point. The user explicitly chose this over noise-tolerant alternatives.

## Non-goals

- Within-speaker mid-sentence cuts (deferred).
- Word-level diarization beyond what whisper word timestamps + existing pyannote diar segs already provide. We're not running a separate per-word diarization model.
- Retroactive splitting via auth pass. Considered as Approach C and rejected — invasive protocol change for a problem solvable in the streaming path.

## Design

### Pipeline shape

Whisper already returns word-level timestamps and `transcribe.py::TranscriptSegment.words` already parses them. They are currently discarded after `transcribe_recent` extracts segment-level `(text, t_start_ms, t_end_ms)` for `pending_finals`. We plumb the words through.

```
transcribe_recent:
  for seg in whisper_segments:
    seq = next_seq()
    emit TranscriptPartialMsg(seq, seg.text, seg.t0, seg.t1)
    pending_finals.append((seq, seg.text, seg.t0, seg.t1, seg.words))

_drain_pending(diar_segs):
  for pending in pending_finals:
    runs = _split_into_runs(pending.words, diar_segs)
    if runs is None:
      keep in still_pending  # all words have no diar coverage yet
      continue
    for i, run in enumerate(runs):
      run_seq = pending.seq if i == 0 else session.next_seq()
      emit TranscriptFinalMsg(run_seq, run.text, run.t0, run.t1, run.speaker)
      session.append_final(seq=run_seq, ...)
```

### `_split_into_runs(words, diar_segs)`

Pure function in `cairn_svc/server.py`. Returns `None` if no word has any diar coverage (defer to next drain pass), otherwise returns a list of `Run` namedtuples / dicts with fields `speaker_id`, `t_start_ms`, `t_end_ms`, `text`, `words`.

Per-word speaker lookup:
1. For each word, compute overlap with each diar seg over `(word.t_start_ms, word.t_end_ms)`. Pick the seg with greatest overlap. If max overlap is zero, the word is "unknown".
2. If at least one word in the segment has a known speaker, every "unknown" word is attributed to the immediately-preceding known speaker (or the immediately-following one if the unknown precedes any known word). This keeps liveness without dropping into an indefinite hold for jitter at segment edges.
3. If ALL words are unknown, return `None`.

Run grouping:
1. Walk words in order. Maintain `current_run` with the first word's speaker.
2. On the first word whose speaker differs, close `current_run`, append it to `runs`, start a new run with the new speaker.
3. After the loop, append the final `current_run`.

Run text join:
- `run.text = " ".join(w.text for w in run.words)` after stripping. The whisper response already includes leading/trailing whitespace per word; we strip and re-join with a single space. This gives clean text without depending on whisper's segment-level rendering.

### Whisper-returned-no-words fallback

If `pending.words` is empty (some very short whisper segments may produce text without word arrays), fall back to today's behavior: call `assign_speaker(pending.t0, pending.t1, diar_segs)` once and emit a single final. Treat as a "single run" path internally so the rest of the loop is uniform.

### Seq allocation

- `transcribe_recent` allocates one seq per whisper segment (unchanged) and emits a single `TranscriptPartialMsg`.
- `_drain_pending` allocates additional seqs only when a pending splits into multiple runs. The first run inherits the pending's seq; subsequent runs allocate fresh seqs via `session.next_seq()`.
- The partial briefly shows the un-split text under the first run's seq; the client overlay replaces it with the first run's final text. Additional runs appear as fresh finals with no prior partial — the existing client handles this case for any other final that arrives without a matching partial.

### Speaker-assigned emission

The existing `sent_speakers: set[str]` guard in `_drain_pending` prevents duplicate `SpeakerAssignedMsg`. With multiple runs per pending, the loop must check each run's speaker against `sent_speakers` and emit a new `SpeakerAssignedMsg` for any first-time speaker. This is a trivial extension of the current logic — same set, same check, just inside the run loop.

### Ledger writes

Each run calls `session.append_final` with its own seq + text + t_start + t_end + speaker. The ledger ends up with N rows for a pending that splits into N runs. Existing code that scans the ledger (rolling summaries, reconcile, orphan sweep) operates on these rows transparently — they look like any other ledger row.

## Edge cases

- **Single-speaker pending (common case):** `_split_into_runs` returns one run; `_drain_pending` allocates no additional seqs; behavior is identical to today.
- **Pending with only unknown words:** `_split_into_runs` returns `None`; pending stays in `still_pending` — same as today's "no covering seg" path.
- **Pending with mixed unknown/known words:** unknown words attributed to neighbor (preceding-then-following). Edge: if a single-word run flanks two different-speaker known words, attribute it to the preceding speaker (deterministic).
- **Whisper segment with `.words = []`:** fall back to existing per-segment `assign_speaker`. One pending → one final.
- **Pending where two consecutive words have identical speaker but different diar segs:** runs grouped by speaker_id, not seg identity, so this stays one run.

## Testing

### Unit tests for `_split_into_runs` (`tests/test_word_split.py`)

- `test_single_speaker_returns_one_run`: 5 words all under one diar seg → one run with all words.
- `test_speaker_change_mid_segment_returns_two_runs`: 4 words under seg A, 3 words under seg B → two runs with correct text and t_ranges.
- `test_three_speaker_alternation`: A→B→A → three runs.
- `test_all_words_unknown_returns_none`: words with no diar overlap → `None`.
- `test_unknown_word_attributed_to_preceding_neighbor`: known-known-unknown-known with unknown overlapping nothing → unknown joins the preceding run.
- `test_unknown_word_at_start_attributed_to_following_neighbor`: unknown-known-known → unknown joins the first known run.
- `test_run_t_range_tightness`: t_start = first word's t_start, t_end = last word's t_end (not the segment's t_range).

### Integration tests for `_drain_pending` (extend `tests/test_authoritative.py` or new file)

- `test_drain_emits_one_final_for_single_speaker`: single-speaker pending → one TranscriptFinalMsg, original seq, one ledger row.
- `test_drain_emits_multiple_finals_for_mixed_pending`: pending with words split A/B → two finals, first with original seq, second with fresh seq, two ledger rows, both speakers in `sent_speakers`.
- `test_drain_keeps_pending_when_all_words_unknown`: pending stays in still_pending; no finals emitted.
- `test_drain_falls_back_when_words_empty`: pending with `words=[]` falls back to per-segment `assign_speaker` and emits one final.

### Regression

Existing tests in `tests/test_authoritative.py` and others that touch `_drain_pending` should pass without modification. If any tests construct `pending_finals` tuples directly, they must be updated to the 5-tuple shape — note this in the implementation plan.

## File touches

| File | Change |
| --- | --- |
| `cairn_svc/server.py::transcribe_recent` | Push 5-tuple `(seq, text, t0, t1, words)` into `pending_finals`. |
| `cairn_svc/server.py::_drain_pending` | Replace per-segment `assign_speaker` with `_split_into_runs` loop; emit one final per run with seq allocation as above; `sent_speakers` check moves inside run loop. |
| `cairn_svc/server.py` | New `_split_into_runs(words, diar_segs)` helper at module scope. |
| `tests/test_word_split.py` | New unit + integration tests. |
| `tests/test_authoritative.py` | Update if any tests construct `pending_finals` tuples (5-tuple now). |

## Out of scope (explicit)

- Within-speaker mid-sentence cuts (terminator-punctuation idea).
- Word-level diarization model beyond reusing existing pyannote diar segs.
- Retroactive splitting via auth pass.
- New protocol message types.
