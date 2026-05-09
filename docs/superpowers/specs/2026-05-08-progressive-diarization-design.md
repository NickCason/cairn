# Progressive (dyadic) authoritative diarization — design spec

**Status:** draft for review
**Author:** Cairn / streaming-diarization workstream
**Date:** 2026-05-08

## Problem

The current streaming pipeline runs pyannote on a 30-second sliding window every ~30 s. Each pass emits transcript_finals with pyannote-derived stable_ids. Live attribution is fast (≤10 s latency from utterance to colored line in the panel), but accuracy on conversational audio is bounded by two intrinsic limits of pyannote's per-window operation:

1. **Per-window clustering is unstable** when conversational turns are short (≤3 s) — the same physical speaker can split across two clusters, or two speakers can collapse into one. We have a stitcher (`stitch_labels`) that bolts cross-window identity on top, but it works against pyannote's local labels which permute every call.
2. **Per-window embeddings vary widely** for the same speaker between adjacent windows (cosine 0.18–0.92 observed on real audio). A frozen EMA centroid from one early window can't track later utterances. The streaming approach is fundamentally limited by this variance.

Empirically, on a two-person podcast we hit ~94.5 % correct attribution at best with the streaming pipeline alone, with ~5 % going to stray ids that the merge sweep cannot collapse because their centroid cosine to the main id (0.4–0.6) is well below any safe merge threshold.

A single full-session offline pyannote run on the same audio at session end produces near-perfect attribution: pyannote's clustering is global and operates on stable embeddings extracted from all available audio per speaker. This is what the library was designed for.

The streaming pass is the right answer for **live UI**; the offline pass is the right answer for **saved-transcript accuracy**. We currently only have the former.

## Goal

Produce saved-transcript attribution that is offline-quality, while keeping live UI attribution as a low-latency best-effort preview that is corrected retroactively as the session progresses. Total CPU cost should grow linearly with session length, not quadratically.

Specifically:

- The transcript that lands in `~/Documents/Cairn/<date>-<meeting>/transcript.jsonl` after the user clicks Stop has speaker_ids derived from a full-session pyannote pass.
- During the session, panel and transcript labels converge toward correctness over time — wrong attributions get corrected via retroactive relabel events on a doubling cadence.
- The user perceives "labels stabilize after ~30–60 s" rather than "labels are wrong forever".
- Latency of any single tick stays bounded; total CPU work over an N-second session is O(N).

## Non-goals

- Replacing the streaming pipeline. The 30 s sliding window stays as the live-attribution mechanism.
- Switching to a different diarization library (diart, etc.). That is a separate, larger effort tracked elsewhere.
- Cross-session speaker identity (voiceprints that survive across meetings). Out of scope as before.
- Manual merge/split UI. Out of scope as before.

## Approach: dyadic authoritative pass

A second background loop runs pyannote on the **full accumulated audio** at exponentially-spaced ticks. Each tick produces a global, authoritative attribution that is reconciled against the ledger of already-emitted finals; for any final whose authoritative speaker_id differs from what was previously emitted, the server sends a per-line `speaker_relabel` event. The client updates that one row in place.

### Why dyadic

A naive "re-diarize on every streaming tick" schedule is quadratic: at minute T you've diarized the audio T times, accumulating O(T²) total CPU work. After 30 minutes, this is hours of compute.

A dyadic schedule (run-times at 30 s, 60 s, 120 s, 240 s, …) is linear: the cost of pass *n* is twice that of pass *n-1*, and the cumulative cost is bounded by `2 · (final pass cost)` (geometric sum). After 30 minutes you've spent roughly 2× the cost of a single offline pass, distributed across the session. Per-tick wall-clock latency still grows linearly with audio length within a single tick (last pass = full session), but the *frequency* of these expensive passes halves at every doubling.

### The two pipelines run independently

| | Streaming pass | Authoritative pass |
|---|---|---|
| Cadence | every 30 s | dyadic (30, 60, 120, 240, … s) plus on-stop |
| Audio extent | last 30 s window | full session buffer |
| Speaker_id source of truth? | for new transcript_finals only | for the saved transcript |
| State | `Session._centroids` (existing) | `Session._auth_centroids` (new) |
| Lock | `diar_lock` (existing) | `auth_diar_lock` (new) |
| Output | transcript_final, speaker_assigned, speaker_merge | speaker_relabel, speaker_assigned (for newly-minted authoritative ids) |

The streaming pipeline is unchanged in behavior. The authoritative pipeline is purely additive: it never touches `_diar_segs`, `_centroids`, the streaming pendings, or the streaming stitcher. It produces only authoritative segs and emits corrections.

### Stable-id namespace

There is a single `stable_id` namespace (S1, S2, …). Both pipelines mint into it via `Session.mint_stable_id()`. This means:

- An id minted by the streaming pass (e.g. S3) can later be authoritatively relabeled away from the affected finals — those finals get `speaker_relabel` events; S3's panel entry remains but holds no finals.
- An id newly minted by the authoritative pass (e.g. S5 the first time the auth pass sees a third voice that streaming had been bundling into S2) is announced to the client via the existing `speaker_assigned` message before any `speaker_relabel` references it.

The authoritative pass owns its own centroid registry to map "this pyannote-cluster I just saw" → stable_id. It does NOT use `_centroids` because the streaming centroids are noisy by design.

### Mapping pyannote-local clusters to stable_ids in the authoritative pass

For each authoritative pass:

1. Run `diarize_pcm` on the full audio. Receive `(segs, label_to_emb)`.
2. For each unique pyannote-local label, compute its embedding's cosine to every existing **authoritative** centroid.
3. If `cos ≥ AUTH_HIGH` (default 0.78) for some authoritative stable_id, adopt that id.
4. Otherwise mint a new stable_id and emit `speaker_assigned`.
5. Update the authoritative centroid for the adopted/minted id to the cluster's current embedding (no EMA — the embedding is computed over all of that speaker's audio in the session).

The geometric/LOW paths from the streaming stitcher are deliberately **not** used in the authoritative pass. The authoritative pass operates on full-session pyannote output; pyannote's own clustering already aggregates per-speaker audio, so the embeddings are stable enough that HIGH alone suffices.

### Per-final correction

After the authoritative pass produces `auth_segs : list[DiarizationSegment]` with stable_ids attached:

1. For every entry in `Session._ledger` (already-emitted finals), compute which authoritative seg covers the majority of its (`t_start`, `t_end`) range.
2. The authoritative speaker_id for that final = the seg's stable_id.
3. If it differs from `_ledger[seq]["speaker_id"]`:
   - Emit `SpeakerRelabelMsg(seq=seq, speaker_id=new_id)`
   - Mutate `_ledger[seq]["speaker_id"] = new_id` so the eventual save is correct.

If a final has no covering authoritative seg (silence, edge case), leave it as-is.

The first authoritative pass after session start will likely emit a flurry of relabels for early streaming-attribution mistakes. Subsequent passes emit only deltas.

### Schedule

Authoritative-pass tick times measured from session start, in seconds:

```
ticks = [30, 60, 120, 240, 480, 960, 1920, ...]
```

implemented as `next_tick = max(30, last_tick * 2)` with the loop sleeping `next_tick - elapsed_s` between ticks. A tick is also forced on `stop` to produce the final authoritative attribution before save (replacing the previous "best on stop" with a full final reconciliation).

Concurrency: the authoritative pass acquires its own lock and runs pyannote in `loop.run_in_executor(...)` (same pattern as streaming). It does not block the streaming loop. If a tick is still running when the next tick fires, the next tick is skipped (logged as `auth_skip` so we can spot it). On `stop`, we wait for any in-flight authoritative pass to finish, then run one more.

### Wire protocol

One new server→client message:

```json
{"type": "speaker_relabel", "seq": <int>, "speaker_id": "<stable_id>"}
```

`speaker_assigned` continues to fire for newly-minted authoritative ids. `speaker_merge` is **not** emitted by the authoritative pass — relabel is per-line and more precise.

### Client behavior on `speaker_relabel`

1. Resolve the row by `[data-seq]` selector.
2. Re-skin its `.spk` element from the supplied speaker_id (use the panel's `speakers.get(speaker_id)` for name/color).
3. If the row's previous speaker_id matched `lastFinalSpeaker`, update `lastFinalSpeaker = new_id` (keeps consecutive-finals coalescing correct).
4. Push the event to `eventsLog` so the saved jsonl reflects the relabel sequence.

The panel itself is unchanged: ids are still added via `speaker_assigned`, removed only via `speaker_merge` (which the authoritative pass doesn't emit). Stale panel entries that no longer hold any finals are visually noise but harmless.

### Cost & latency

Per tick at minute *m*: pyannote on *m* minutes of audio. On node4's GPU, this is approximately *m* seconds of wall-clock per minute of audio (an empirical estimate; the spike instrumented during exploration showed roughly 2 s per 30 s of audio). At minute 30 the on-stop pass would take ~30 s — acceptable, the user is already in "summarizing…" wait state.

Cumulative CPU over a 30-min session: passes at 30s, 60s, 120s, 240s, 480s, 960s, 1800s + on-stop = roughly ~120 s of GPU time, vs. ~60 s for a single offline pass at the end. Slightly more than 2× single-offline cost in exchange for in-session corrections.

## Open questions / design choices already made

- **What if pyannote returns a different cluster count between authoritative passes?** Cluster count can drift up or down. We don't pin it. Each pass is independently authoritative for what it produced; the next pass can split or merge.
- **What about partials?** Out of scope — partials don't carry speaker_id. They get speaker only on finalization, by which point streaming attribution is what the user sees.
- **Why not also re-extract embeddings cheaply on each authoritative pass?** We could in a future iteration unbundle pyannote's stages and cache per-segment embeddings, then only re-cluster. For first cut we accept the cost of full re-extraction at each tick — the dyadic schedule keeps it linear.
- **Why no `speaker_merge` integration?** The streaming `merge_sweep` continues to run on streaming centroids. If it fires (e.g. two streaming-minted ids converge), the authoritative pass will have already (or will soon) issue per-final relabels that supersede the merge's coarser effect. Both are safe to coexist; on the client side `speaker_merge` and `speaker_relabel` are independent.

## Acceptance criteria

1. On a two-person podcast meeting of ≥4 minutes, the saved jsonl shows ≥98 % of finals attributed to two stable_ids.
2. Live UI shows transcripts with speaker labels appearing within 5 s of utterance (no regression from current).
3. Within 30 s of session start, prior misattributions have been corrected via `speaker_relabel` events visible in the eventsLog.
4. CPU usage on node4 is bounded — a 30-minute session does not consume more than 5 minutes of GPU time across both pipelines.
5. No regression on existing streaming behavior tests (the existing 98 svc tests stay green).

## Affected files

### cairn-svc (`~/cairn-svc` on node4)

| File | Change | Responsibility |
|---|---|---|
| `cairn_svc/protocol.py` | MODIFY | Add `SpeakerRelabelMsg` |
| `cairn_svc/session.py` | MODIFY | Add `_auth_centroids` dict and accessor; `apply_edit` already supports speaker_id changes |
| `cairn_svc/diarize.py` | (no change) | `diarize_pcm` already accepts variable-length pcm |
| `cairn_svc/server.py` | MODIFY | New `_run_authoritative_pass`, `run_authoritative_periodically`, schedule helper, mapping helper, ledger-reconciliation helper; wire into session lifecycle |
| `tests/test_authoritative.py` | NEW | Unit tests for schedule, mapping, ledger reconciliation |
| `tests/test_protocol.py` | EXTEND | SpeakerRelabelMsg roundtrip |
| `.env.example` | MODIFY | Document `CAIRN_AUTH_DIAR_HIGH`, `CAIRN_AUTH_DIAR_FIRST_TICK_S`, `CAIRN_AUTH_DIAR_ENABLED` |

### Cairn client (`/Users/nickcason/dev/cairn`)

| File | Change | Responsibility |
|---|---|---|
| `src/renderer/ws.ts` | MODIFY | Add `SpeakerRelabel` type to `ServerMsg` union |
| `src/renderer/transcript.ts` | MODIFY | `relabelLine(seq, dstId, dstName, dstColor)` — single-row DOM rewrite, lastFinalSpeaker maintenance |
| `src/renderer/app.ts` | MODIFY | onMsg handler for `speaker_relabel` |

No protocol-removal in this spec; both `speaker_merge` and `speaker_relabel` flows coexist.
