# Cross-speaker bleed — handoff for redesign

**Status:** previous attempt reverted; redesign pending.
**Author of failed attempt:** Claude (this session, 2026-05-09).
**Audience:** the next model picking this up. Read this start-to-finish before touching code.

## What we're trying to fix

A single `transcript_final` can contain words from two speakers when the silence between them is shorter than VAD's `min_silence_ms` (default 500 ms). Whisper transcribes the run as one segment; `_drain_pending` calls `assign_speaker(t0, t1, diar_segs)` once per whisper segment and picks the speaker with the largest overlap, attributing the entire text to that one speaker.

Concrete instance from the 2026-05-09 Lex/Dario run, seq 64 in `Documents/Cairn/2026-05-09-live/transcript.jsonl.bak`: `"compute. Yes. All of those. In particular, linear scaling up..."` — Lex's last word "compute" got attached to Dario's reply because Dario started immediately. The whole final was attributed to Dario.

The user has explicitly scoped this work to **cross-speaker bleeding only**. Within-speaker mid-sentence cuts (one thought split across two consecutive finals because of a brief mid-thought pause) are out of scope.

## Architecture you need to know

- `cairn-svc` lives on `node4` (`ssh node4`, source at `~/cairn-svc/`). Tests via `~/cairn-svc/.venv/bin/python -m pytest`. The service is run by user-scope systemd (`systemctl --user restart cairn-svc`). Endpoint: `ws://100.99.99.72:8300`.
- The Electron client is at `/Users/nickcason/dev/cairn/`. `npm run install-app` rebuilds and refreshes `/Applications/Cairn.app` symlink to the dev bundle. Server-only changes do NOT need a client rebuild.
- The pipeline:
  1. Audio buffer accumulates from the WebSocket.
  2. `vad.py::find_commit_boundary_s` looks for tail silence (≥500 ms) or forces a commit at `max_chunk_s` (12 s).
  3. Audio chunk goes to whisper STT (`transcribe.py::transcribe_pcm`) → returns `list[TranscriptSegment]` with per-word timestamps in `segment.words: list[TranscriptWord]`. **Whisper word/segment timestamps are CHUNK-RELATIVE** (start at 0 for the chunk that was passed to whisper).
  4. `transcribe_recent` (in `server.py`) iterates segments, allocates a seq per segment, emits `TranscriptPartialMsg`, and pushes a tuple into `pending_finals`. Today the tuple is 4 elements: `(seq, text, t0_ms, t1_ms)` — `t0`/`t1` are **absolute session-time** (`t_offset_ms = int(last_transcribe_seconds * 1000)` is added to whisper's segment-relative times).
  5. Streaming diarization runs every 30 s on a sliding window of audio (`run_diarization_periodically`) and updates `session._diar_segs` (each `DiarizationSegment` has absolute-time `t_start_ms`/`t_end_ms` and a stable_id `label`).
  6. `_drain_pending(diar_segs)` (closure inside `ws_transcribe`) walks `pending_finals`, calls `assign_speaker(t0, t1, diar_segs)` per segment, and emits one `TranscriptFinalMsg` per pending. Pendings whose `assign_speaker` returns `None` (no diar coverage) stay in `still_pending` to retry next pass.
  7. Authoritative diarization runs at scheduled ticks (30 s, 60 s, 120 s, 240 s … and on Stop) on the full session audio. It emits `speaker_relabel` events to retroactively correct ledger attribution and `speaker_merge` events to fold ghost sids.

Key invariants:
- `pending_finals` tuple shape is consumed in three places in `server.py`: the initial declaration (~line 569), the append in `transcribe_recent` (~line 1049), and the stop-branch unpack (~line 1100). All three must move together.
- `assign_speaker` (in `diarize.py`) returns `None` ONLY when `diar_segments` is empty. Otherwise it always returns *something* (best overlap > nearest-neighbor fallback). Treating its return value as "no coverage" only works at the segment level when `diar_segs` is empty. For word-level lookup, "unknown" must be detected by checking actual overlap, not by `assign_speaker` returning `None`.

## What I tried

Word-level diarization splitting. Spec at `docs/superpowers/specs/2026-05-09-word-level-speaker-split-design.md`. Plan at `docs/superpowers/plans/2026-05-09-word-level-speaker-split.md`. Both still in the repo for reference.

In summary:
1. Added `_split_into_runs(words, diar_segs) -> list[_Run] | None` at module scope in `server.py`. Pure helper. Walks per-word, finds best-overlap diar seg, fills "unknown" words by neighbor sweep, groups consecutive same-speaker runs.
2. Widened `pending_finals` to a 5-tuple `(seq, text, t0, t1, words)`.
3. Rewrote `_drain_pending` to call `_split_into_runs` and emit one `TranscriptFinalMsg` per run. First run inherited the partial's seq; additional runs allocated fresh seqs via `session.next_seq()`. `sent_speakers` check moved inside the run loop.
4. The user picked an "always split" policy — even a single-word flip in attribution should split.

This was implemented and merged. Then in real testing it produced a major regression. I reverted all four commits (`5812f7e`, `41c92c9`, `b6acf63`, `9c32ff5`). Current `HEAD` is `ef0fa56` (the last revert). 155 tests passing.

## What went wrong

Three problems compounded — only the first was a code bug; the other two were design flaws.

### 1. (Bug, fixable.) Word timestamps were chunk-relative, not absolute

Whisper returns word `start`/`end` relative to the start of the PCM chunk handed to it (each chunk starts at 0). The segment-level `t0`/`t1` in `transcribe_recent` were correctly offset to absolute session time via `t_offset_ms`, but the per-word timestamps inside `s.words` were NOT — they were pushed raw into `pending_finals`. The diar segs in `_drain_pending` are absolute. So word-time vs diar-time was apples-to-oranges. Words past chunk 0 had relative times like 0–500 ms which mapped into the **silence at the start of the session**, producing "S?" or random matches.

I fixed this in commit `9c32ff5` by wrapping each word in a fresh `TranscriptWord` with `t_start_ms = t_offset_ms + w.t_start_ms`. The fix worked correctly in synthetic tests. The unit tests didn't catch the bug because they constructed words with already-absolute times — the helper itself is correct, the call site was wrong.

**Test gap:** the tests for `_split_into_runs` should have included a fixture that mimics how `transcribe_recent` actually produces words (chunk-relative) and verified that the call site offsets them. The next attempt MUST have an integration test that exercises `transcribe_recent → pending_finals → _drain_pending` with chunk-relative words coming from a fake `transcribe_pcm`.

### 2. (Design flaw, severe.) Splitting against streaming diar amplifies jitter

The user reported, after the offset bug was fixed:

> speakers are collapsing, early spikes of extra speakers, and still getting jumbly. stopped at 2 minutes after it killed my lex tag and split lexs intro into dario and s3.

Looking at `Documents/Cairn/2026-05-09-live/transcript.jsonl` (the third bad run, after the fix attempt landed):

- Three `speaker_assigned` events fire within the first second of audio: S1, S2, S3. Streaming diar mints multiple sids before it settles on the real cast.
- Lex's intro (~9–17 s, one whisper segment in earlier good runs) was split across **three** sub-finals attributed to different speakers.
- The user manually retagged a line via `transcript_edit` → `(seq=2, speaker_id="S2")`. A subsequent auth-tick `speaker_relabel` overwrote that edit. The user's "Lex" tag was effectively erased.

Why this happened:
- `_drain_pending` is called immediately when streaming diar produces output. At session start, streaming diar has not yet settled — it's still in the first ~30 s where it's prone to over-segmenting the same voice into multiple stable_ids.
- An "always split" policy on noisy diar produces one sub-final per attribution flicker. Even within a single utterance from a single human, streaming diar may flip its label mid-word and back, especially across diar-window boundaries early in the session.
- The old per-segment behavior was a **smoothing function** — whichever speaker had the most overlap won the whole segment, which masked jitter. Removing the smoothing without a replacement noise filter exposed it.

What's needed:
- Use **authoritative-pass diar** (the more accurate one that runs at scheduled ticks) for word-level splitting, not streaming diar. Streaming is too noisy at the boundaries.
- Or: defer splitting until the diar signal at the relevant region has stabilized (e.g. has been confirmed by ≥1 auth tick).
- Or: keep a minimum-evidence threshold even with "always split" — for example, only split if the alternate-speaker run has ≥2 consecutive words AND ≥150 ms of acoustic length AND >50 % of its time is covered by a diar seg with that label.
- Whichever is chosen, the helper should not run on the first `_drain_pending` after a chunk lands — it should wait for the next auth tick to provide stable input, or fall back to the per-segment behavior in the interim.

### 3. (Pre-existing bug, surfaced by the regression.) Auth pass clobbers manual edits

The user's `transcript_edit` (manual relabel from the UI) sets `ledger[seq].speaker_id` directly. The next auth tick's `_reconcile_ledger` walks the ledger and overwrites the speaker_id wherever it disagrees with the auth-pass diar. Manual user intent is silently overridden.

This is independent of word-level splitting but matters here because the user's only mitigation for the bleed bug — "I'll just retag the wrong lines" — also doesn't survive an auth tick. Any redesign should probably introduce a "user-locked" flag on edited rows that `_reconcile_ledger` respects.

## Where things stand right now

- `HEAD` on `node4:~/cairn-svc/` is `ef0fa56` — all four word-split commits reverted.
- `cairn-svc` restarted; clean startup at 11:44 PDT 2026-05-09; 155 tests pass.
- The Electron client (`/Applications/Cairn.app`) was last rebuilt at 11:09 PDT and does not need a rebuild for any work in this scope.
- The bleed bug is back as it was (cross-speaker words can land in one final), but the system is otherwise stable: rename retro-substitution, LLM-output sanity pass, empty-orphan eviction, JSON-fence stripping, and auth-loop survival are all still in.

The four failed commits are recoverable from git reflog if you want to study the diff:

```
git log --oneline 5812f7e^..9c32ff5
```

## Constraints for the next attempt

User's hard requirements as stated in this session:
1. Fix is for **cross-speaker bleed within a single transcript_final**, nothing else (no within-speaker mid-sentence cuts).
2. "Always split" was the user's stated preference — but you should now treat that as "always split *when the signal is trustworthy*". The user's lived experience showed that splitting against noisy signal is worse than not splitting.
3. The user iterates on real podcast audio (Lex Fridman / Dario Amodei was the test). They press play, watch the panel build up, then click Stop. Test runs are typically 2–8 minutes. Real-time degradation is immediately visible to them — do not ship a fix that's only OK in offline tests.
4. **Do not restart `cairn-svc` while the user might be testing.** Always confirm before `systemctl --user restart cairn-svc`. The user explicitly called this out as a problem in this session.
5. The user accepts longer iteration cycles for a better outcome. They picked subagent-driven development and "write a full implementation plan first" each time. Don't shortcut the process.

## Suggested redesign directions (not prescriptive)

If approach A (auth-pass diar for word splitting) seems best, sketch:
- Word-level split happens ONLY at auth-tick time, not in streaming `_drain_pending`. Streaming `_drain_pending` keeps its current per-segment `assign_speaker` behavior — the bleed remains visible until the next auth tick.
- At auth tick, after `_reconcile_ledger` runs, walk every ledger row whose audio span contains words that — under the auth-pass diar — fall on more than one speaker. Split that ledger row into multiple rows. Emit a new protocol message `transcript_split` that the client treats as: "delete row N, replace with rows N + N′, N′ + 1, …".
- Pros: split signal is the high-confidence one (pyannote on full audio). Streaming behavior is unchanged. No noise amplification.
- Cons: protocol surface grows. Bleed visible during the streaming-only window (up to the next auth tick — 30 s for tick #1, then 60 s, 120 s, 240 s). New client code path.
- This was Approach C in the original brainstorm, rejected for being more invasive than the streaming-time approach. It was the wrong call — the streaming-time approach turned out to be **more** invasive in practice because streaming diar isn't accurate enough.

Other directions worth considering:
- Keep streaming behavior; do the split retroactively via the existing `speaker_relabel` mechanism by issuing a relabel for the slice of text that's wrong. (No actual splitting; the wrong-speaker words would stay in the final but their attribution would change. Doesn't fully fix the problem — still one final, one speaker_id, just maybe wrong.)
- Tighten VAD `min_silence_ms` (currently 500 ms) so chunk boundaries fall between speakers more often. Cheap, may help cases where the gap is 200–500 ms but doesn't help when speakers truly overlap or interject.
- Address the manual-edit clobber as a precondition. The user can mitigate bleed by retagging if their tag survives auth-pass reconcile.

## Files and paths

- Spec for the failed attempt: `docs/superpowers/specs/2026-05-09-word-level-speaker-split-design.md`
- Plan for the failed attempt: `docs/superpowers/plans/2026-05-09-word-level-speaker-split.md`
- This handoff: `docs/superpowers/specs/2026-05-09-cross-speaker-bleed-handoff.md`
- Current source on node4: `ssh node4`, `~/cairn-svc/cairn_svc/{server,transcribe,diarize,vad,session}.py`
- Saved test transcripts on the local Mac: `/Users/nickcason/Documents/Cairn/2026-05-09-live/`
  - `transcript.jsonl.bak` — earlier 7-min run with the bleed visible (seq 64 case)
  - `transcript.jsonl` — most recent 2-min run (after revert; baseline working state with bleed)

## Memory of mistakes (read before designing)

- Don't trust that synthetic unit tests prove a helper "works" when it relies on a contract (time domain) that the call site might not honor. Word timestamps in particular are landmines.
- Don't ship a real-time UX change without observing what it looks like in real-time on the user's actual audio. The "always split against noisy diar" failure mode was invisible in offline tests.
- "Always X" answers from a user almost always mean "always X *when X makes sense*". Confirm policy decisions against an actual failure case if one is available.
- Ask before restarting the service. Several test runs were wasted because I restarted while the user was mid-test.
