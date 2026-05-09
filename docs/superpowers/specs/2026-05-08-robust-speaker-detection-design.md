# Robust speaker detection — design spec

**Date:** 2026-05-08
**Status:** Approved (brainstorming → writing-plans)
**Repos affected:** `cairn-svc` (~/cairn-svc on precision-node4), `cairn` client (this repo)

## Goal

Replace the current geometry-only cross-window speaker stitching with an embedding-augmented identity model that survives long silences and pyannote relabeling. Remove the speaker-count dropdown from the client (full auto-detect). When the system later realizes two stable ids are the same person, retroactively rewrite past transcript lines to the older id.

## Background

Today's pipeline (sliding-window pyannote, 90 s window / 60 s overlap / 30 s step) stitches windows together via `stitch_labels` in `cairn_svc/server.py`: for each pyannote-local label in a new window, it sums millisecond overlap with prior stable-id segments inside the 60 s overlap zone and adopts the best match if overlap ≥ 20 % of the new label's speech in the window; otherwise it mints a new stable id.

Observed failure: every few minutes a speaker gets re-minted as a fresh id. Two regimes both trigger it:
- **Post-silence:** if a speaker stays quiet through the 60 s overlap zone, the next window has no overlap to bridge them, so they mint fresh.
- **Mid-conversation:** pyannote occasionally relabels mid-window or only catches a speaker for a brief moment in the overlap zone (<20 % of window time), and they mint fresh.

There is no voice-identity memory; cross-window identity is purely geometric. The user-facing workaround was a dropdown to declare expected speaker count, which adds inflexibility and still doesn't fix the underlying drift.

## Non-goals

- Replacing pyannote with a different diarization stack
- Changing the windowing scheme (`DIAR_WINDOW_S=90`, `DIAR_OVERLAP_S=60`, `DIAR_STEP_S=30` stay)
- New external dependencies — the embedding model already runs as part of pyannote's pipeline
- Per-meeting speaker enrollment / cross-meeting voiceprint persistence
- Manual merge/split UI (auto-merge handles the cases we care about; manual remains a future option)

## Approach

Each `stable_id` carries a **voice centroid** that persists for the whole session — a duration-weighted EMA of the speaker's segment embeddings. Stitching combines geometric overlap (today's signal) with cosine similarity against every known centroid. After every pyannote pass, a **merge sweep** pairwise-compares centroids and collapses ids whose voices have converged, emitting a `speaker_merge` event that the client uses to retroactively rewrite past lines.

## Architecture & components

### cairn-svc (`~/cairn-svc` on node4)

- **`cairn_svc/diarize.py`** — extend the pyannote pipeline call to return per-segment embeddings alongside the existing `(label, t_start_ms, t_end_ms)`. Pyannote computes these internally; expose them via the pipeline's hook surface.
- **`cairn_svc/session.py`** — add `Session._centroids: dict[str, tuple[np.ndarray, float]]` mapping `stable_id → (centroid_vec, total_observed_seconds)`. New methods:
  - `update_centroid(stable_id, embedding, duration_s, tentative=False)`
  - `merge_stable(src, dst)` — absorbs centroid, rewrites `_diar_segs`, rewrites `_ledger` finals, drops `src` from `_centroids` / `_color_for_stable`.
- **`cairn_svc/server.py`** —
  - `stitch_labels()` gains the hybrid decision rule below; signature loses `max_stable`.
  - New `merge_sweep(session)` runs after each stitch, emits `SpeakerMergeMsg` per merge.
  - Drop `num_speakers_hint` plumbing from `ws_transcribe` (state, `start` parsing, `set_num_speakers` handler).
- **`cairn_svc/protocol.py`** — add `SpeakerMergeMsg`. Remove `SetNumSpeakersMsg` and the `num_speakers` field from `StartMsg`.

### Cairn client (this repo)

- **`src/renderer/ws.ts`** — add `SpeakerMergeMsg` type to the union. Drop `setNumSpeakers()` method and the `numSpeakers` arg on `start()`.
- **`src/renderer/app.ts`** —
  - Handle `m.type === "speaker_merge"` in `onMsg`: dispatches into transcript and speakers panel.
  - Remove the `$speakersToggle` element ref, `currentSpeakers` state, `loadSpeakers`/`saveSpeakers` localStorage round-trip, the `set_num_speakers` flow, and `refreshSpeakerToggleLabel`.
- **`src/renderer/transcript.ts`** — new `mergeSpeakers(srcId, dstId)`. Walks rendered lines with `[data-speaker-id="${srcId}"]`, swaps the badge to `dstId`'s name/color, and updates `data-speaker-id`.
- **`src/renderer/speakers.ts`** — new `merge(srcId, dstId)`. Drops `srcId` from the panel; `dstId` retains its existing name/color (dst-wins).
- **`src/renderer/index.html`** — delete `#speakers-toggle` button. The titlebar layout reflows.

No new runtime dependencies. No new model files.

## Stitching decision rule

Per pyannote pass, for each new pyannote-local label `L` with mean embedding `e_L` (duration-weighted average of its in-window segment embeddings) and total in-window speech `t_L`:

1. **Geometric score** — `g = best_overlap_ms(L, prev_segs) / t_L`, with the best-matching prior `stable_id` recorded. Same algorithm as today.
2. **Embedding score** — `s = max over centroids c_i of cos(e_L, c_i)`, recording the matching `stable_id`. If no centroids exist, `s = 0`.
3. **Decision:**
   1. If `s ≥ STITCH_EMB_HIGH` → adopt embedding's match (strongest signal: voice match across the whole session)
   2. Else if `g ≥ 0.20` → adopt geometric's match (today's logic, preserved unchanged)
   3. Else if `s ≥ STITCH_EMB_LOW` **and** `t_L < FALLBACK_T_S` → adopt embedding's match, mark the centroid update as **tentative**
   4. Else → mint a new `stable_id`

Hierarchy rationale: embedding similarity comes first because it survives silence and relabeling; geometric overlap is the strong fallback when embeddings are weak (very short segments, poor SNR); the LOW band is a recovery path specifically for "speaker only spoke briefly in this window" — but only as tentative, so a wrong call cannot poison the centroid. Anything weaker mints fresh; the merge sweep handles unification later.

## Centroid update

Only on confident matches (decision paths 3.1 or 3.2). Path 3.3 uses a downweighted update (`w := w/4`).

```
t_eff = min(t_new, CENTROID_CAP_S)
w     = t_eff / (total_s + t_eff)
centroid := (1 - w) * centroid + w * e_new
total_s   = min(total_s + t_new, CENTROID_TOTAL_CAP_S)
```

Centroid is L2-normalized after each update so cosine collapses to dot product.

- `CENTROID_CAP_S = 30 s` — per-update weight cap; one giant chunk cannot overwrite an established centroid.
- `CENTROID_TOTAL_CAP_S = 600 s` — keeps the EMA responsive to slow voice changes (cold, mood, mic) over very long meetings; without it, hour-long meetings would have rock-solid centroids that ignore late-session evidence.

Initial centroid for a freshly minted id is just `e_L` (no EMA yet).

## Merge sweep

Runs once per pyannote pass, after stitching and centroid updates. Pairwise iterates every pair `(a, b)` of `stable_id`s where both have `total_s ≥ MERGE_MIN_S`:

- If `cos(centroid_a, centroid_b) ≥ MERGE_COS`: merge. The younger id (later `mint_stable_id` order) is `src`; older is `dst`.
- `Session.merge_stable(src, dst)`:
  - Absorb src's centroid into dst's (duration-weighted average using each side's `total_s`; cap result at `CENTROID_TOTAL_CAP_S`).
  - Rewrite `session._diar_segs`: every seg labelled `src` becomes `dst`. (Important — the next window's geometric path uses `_diar_segs` for prior-overlap calculation; if we don't rewrite, the next stitch could re-mint.)
  - Rewrite `session._ledger` finals: any line with `speaker_id == src` becomes `dst` (so the next rolling/final summary sees the merged identity).
  - Drop `src` from `_centroids` and `_color_for_stable`.
- Emit `{"type": "speaker_merge", "src": src, "dst": dst}`.

`MERGE_COS = 0.82` is **stricter** than `STITCH_EMB_HIGH = 0.78` — once we're saying "two ids that previously looked distinct are actually the same person", we want more evidence than the per-window stitch threshold.

`MERGE_MIN_S = 8 s` blocks unstable early merges where a centroid is built from one short utterance.

Sweep is `O(N²)` in stable_id count; bounded (no human meeting has > 20 distinct speakers) so cost is negligible.

## WS protocol

**New message** (server → client):
```python
class SpeakerMergeMsg(BaseModel):
    type: Literal["speaker_merge"] = "speaker_merge"
    src: str   # the id being absorbed (younger / disappears)
    dst: str   # the id absorbing it (older / retained)
```

**Removed** (both directions):
- `SetNumSpeakersMsg` — control message no longer exists
- `num_speakers` field on `StartMsg`

Server emits `SpeakerMergeMsg` to a closed WS via the same `_emit_msg` lock used for summary events; `RuntimeError` is silently swallowed (matches the post-final_summary fix pattern).

Client handler in `app.ts onMsg`:
```ts
} else if (m.type === "speaker_merge") {
  transcript.mergeSpeakers(m.src, m.dst);
  speakers.merge(m.src, m.dst);
}
```

## Client UX

- **Dropdown removal.** `#speakers-toggle` button gone from `index.html`. The titlebar reflows naturally — no layout work needed beyond CSS audit.
- **Retroactive relabeling.** When a `speaker_merge` arrives, every transcript line attributed to `src` visibly shifts to `dst`'s name and color in place. The speakers panel drops the src entry. This was the user-chosen UX: auto-rewrite, no banner, no confirm.
- **Name conflict edge case.** If the user had renamed the younger id (`src`) before the merge fires (e.g. "Bob") but the older id (`dst`) is still `S1`, **dst wins** — the merged lines display as `S1`. We accept this as the simple rule for v1; a follow-up could make name conflicts surface a banner.

## Removed code paths

- `cairn_svc/server.py`: `num_speakers_hint` state, `StartMsg.num_speakers` parsing, `SetNumSpeakersMsg` handler, `set_num_speakers` log line, `max_stable` parameter on `stitch_labels`, the cap-fallback branch inside `stitch_labels`.
- `cairn_svc/protocol.py`: `SetNumSpeakersMsg`, `StartMsg.num_speakers`.
- `src/renderer/app.ts`: `currentSpeakers`, `loadSpeakers`/`saveSpeakers`, `refreshSpeakerToggleLabel`, the `$speakersToggle.onclick` handler, the cycle-through-2/3/4/5/8 logic.
- `src/renderer/ws.ts`: `setNumSpeakers`, `numSpeakers` arg on `start`.
- `src/renderer/index.html`: `#speakers-toggle` button.

## Tunables

All env-controllable on cairn-svc, with documented defaults in `.env.example`:

| Var | Default | Meaning |
|---|---|---|
| `CAIRN_DIAR_STITCH_EMB_HIGH` | `0.78` | Cosine threshold for confident embedding-based stitching |
| `CAIRN_DIAR_STITCH_EMB_LOW` | `0.65` | Cosine threshold for tentative stitching of short segments |
| `CAIRN_DIAR_FALLBACK_T_S` | `3.0` | Below this in-window speech, the LOW band is allowed |
| `CAIRN_DIAR_CENTROID_CAP_S` | `30.0` | Per-update weight cap for EMA |
| `CAIRN_DIAR_CENTROID_TOTAL_CAP_S` | `600.0` | Total observed-seconds cap for EMA denominator |
| `CAIRN_DIAR_MERGE_COS` | `0.82` | Cosine threshold for the merge sweep |
| `CAIRN_DIAR_MERGE_MIN_S` | `8.0` | Min total speech per id to be eligible for merge |

Defaults are conservative starting points. Pyannote's embedding space (192-d, ECAPA-style) typically separates same-speaker pairs (≥ 0.75) from different-speaker pairs (≤ 0.65) once centroids have ~10 s of speech. Tune on `benchmarks/`.

## Error handling

- **Pyannote returns no embedding for a segment** (very short, filtered audio): treat that label's `e_L` as missing. `s = 0`. Falls through to geometric path. Same as cold-start behavior.
- **Zero-norm embedding** (shouldn't happen): skip the centroid update; log warning at `WARNING` level.
- **`speaker_merge` emit on closed WS**: silently swallow `RuntimeError` (same pattern as `_emit_msg` post-final_summary fix). Merge state is already updated in `Session`, so the next session-saved transcript.jsonl will reflect the merge even if the live emit was lost.

## Testing

### `tests/test_stitch_labels.py` (extend)
- `test_embedding_recovers_id_after_silence` — known centroid for S1, new window has no overlap with prior segs but `e_L` matches S1's centroid → adopts S1.
- `test_no_embeddings_falls_back_to_geometric` — segments with `embedding=None` follow the existing 0.20 overlap rule unchanged.
- `test_short_segment_uses_low_band` — `t_L < FALLBACK_T_S` with `s ∈ [LOW, HIGH)` → adopts; centroid update flagged tentative.
- `test_emb_high_overrides_geometric` — geometric prefers A but embedding strongly matches B → adopts B.

### `tests/test_centroids.py` (new)
- `test_centroid_ema_resists_outlier` — 60 s of speaker A then a 1 s outlier → centroid moves below ε.
- `test_centroid_total_cap_keeps_responsiveness` — total_s capped at `CENTROID_TOTAL_CAP_S`; late updates still influence centroid measurably.
- `test_tentative_update_downweighted` — confident vs tentative same-duration update → tentative moves centroid ~1/4 as much.

### `tests/test_merge_sweep.py` (new)
- `test_merge_fires_on_high_similarity` — two stable_ids whose centroids cross `MERGE_COS` → emits one merge event, ledger rewritten, future stitches see merged id.
- `test_merge_skips_short_speakers` — both ids below `MERGE_MIN_S` → no merge.
- `test_merge_picks_older_as_dst` — younger id absorbed into older.
- `test_merge_rewrites_diar_segs` — after merge, `session._diar_segs` contains no segs with the old src label; next stitch's geometric path sees the merged id.

### Integration
- A 5-minute fixture with deliberate 90 s silences interleaved (extension of existing benchmark fixtures): assert (a) stable_id count stays bounded, (b) merge events fire for known same-speaker scenarios across silences, (c) WER does not regress against current pipeline.
- Existing `benchmarks/` accuracy harness: re-run, compare per-speaker accuracy and total speaker count vs current `main`.

## Migration

- The wire protocol change is breaking for any client speaking the `set_num_speakers` message — there's only the one Cairn client, no others. Both sides ship together.
- Saved `transcript.jsonl` files from before this change have no `speaker_merge` events; re-render of historical sessions is unaffected.
- No DB migration; centroids live in `Session` (in-memory, per-session).

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Cosine thresholds too tight → over-splitting persists | Tune on `benchmarks/`. Defaults err toward over-splitting (safer than over-merging); merge sweep cleans up. |
| Cosine thresholds too loose → false unification (two voices merged) | `MERGE_COS = 0.82` is conservative. `MERGE_MIN_S = 8 s` blocks early instability. False merges from the user's POV are worse than over-splits, so threshold defaults bias safe. |
| Pyannote embeddings inaccessible from current pipeline call | Pre-implementation: spike `diarize.py` to confirm pipeline hook exposes embeddings. If it doesn't, run `pyannote/embedding` as a separate pass on each segment (~50 ms per segment on this CPU) — adds latency budget but not risk. <br>Verified 2026-05-08 on node4 (`pyannote/speaker-diarization-3.1`): `pipeline(path, return_embeddings=True)` returns `(diarization, embeddings)` where `embeddings` is an `np.ndarray` of shape `(N_speakers, 256)`, `dtype=float32` (empty case is `(0, 256)` `float64`), with row `i` corresponding to `list(diarization.labels())[i]`. |
| Centroid drift across very long meetings | `CENTROID_TOTAL_CAP_S = 600` keeps EMA responsive late-session. |
| Name-conflict edge case after merge ("Bob" absorbed into unrenamed "S1") | dst-wins for v1; revisit with banner UX if it bites. |
