# Streaming-side defers to auth pass for new speaker minting

**Date:** 2026-05-09  
**Scope:** Stop the streaming diarizer from minting new canonical SIDs. The streaming side becomes "label into existing canonical SIDs OR emit `S?`"; only the auth pass introduces new canonical SIDs. Eliminates spawn-then-merge speaker churn during recording.

## Problem

A 5-min Diamandis (3-speaker) recording produced **23 distinct streaming-side SIDs** (S1, S2, S4–S23) for an audio with 3 actual speakers. Auth pass merged them down to ~3 by stop, but during recording the speakers panel grew unboundedly — the user reported it as practically unusable live.

Root cause: `stitch_labels` (`cairn_svc/server.py`, line 638) currently mints a fresh stable_id whenever no tier matches:
- Tier 3 (cosine ≥ HIGH) → adopt
- Tier 2 (geom overlap ≥ 20%) → adopt
- Tier 1 (cosine ≥ LOW + short utterance) → adopt
- **Tier 0 (else)** → `session.mint_stable_id()` ← spawn source

Plus collision losers also mint fresh.

With 3 speakers the embedding space is more crowded so Tier 0 fires often. Streaming spawns ~4.6 SIDs/min while auth pass merges ~3.8 SIDs/min → net +1 visible speaker/min.

## Design

**One-line summary:** Streaming never mints. It produces `S?` for unknown clusters; auth pass is the sole authority on new canonical SIDs.

### Svc changes (`cairn_svc/server.py`)

**`stitch_labels` — replace mints with `S?`:**
- Tier 0 returns `"S?"` for the label
- Collision losers also get `"S?"`
- Function signature unchanged; downstream consumers see `"S?"` as a label value

**Centroid update (around line 1077–1093):**
- Skip the iteration when `stable_id == "S?"` (no centroid to update for the placeholder; updating one would pollute future cosine matches)

**`_drain_pending` SpeakerAssigned emit (around line 837):**
- Skip the `SpeakerAssignedMsg` if `stable == "S?"`. The renderer never gets a panel pill for the placeholder.

**Ledger storage:**
- Unchanged. `session.append_final(..., speaker_id="S?", ...)` stores the row with the placeholder. Auth pass relabel events will replace it with a canonical SID later.

**Auth pass:**
- **Unchanged.** It already mints canonical SIDs via `_map_auth_clusters` and emits `SpeakerRelabelMsg` for any ledger row whose attribution should change. `S?` rows naturally become candidates for relabel.

### Client renderer (`src/renderer/`)

**Already mostly works** because:
- `SpeakersPanel.get(id)` returns `{id, name: null, color: "#8b949e"}` (neutral grey) for unknown ids → so a row labeled `S?` renders with grey pill
- No `speaker_assigned` event arrives for `S?` → no panel pill added
- Existing `relabelLine(seq, newSid, ...)` handles the eventual S? → S_N transition

**One small visual tweak:** the `S?` pill text and color could be styled as "pending" (slight italic / lower opacity) to communicate "waiting for auth pass to confirm." Optional polish; the underlying mechanism works either way.

### Summary input

When the LLM summarizer sees `S?: <text>` in its prompt, it should treat unknown rows as "an unidentified speaker" rather than inventing a new label. The existing prompt is already sturdy enough; we'll let `S?` appear in early rolling summaries and rely on the existing `process_pending_edits` re-summarization on relabel to clean it up.

## Trade-offs

- **Brief S? window for genuinely new speakers** (≤ one auth-pass tick, currently ~30s). Acceptable per the user's choice.
- **No regression for the 2-speaker case** — Tier 3 / 2 / 1 still match dominantly when the embedding space isn't crowded, so the placeholder rarely fires.
- **Centroid quality may improve** because we no longer pollute the registry with short-lived spawn-then-merge SIDs whose centroids never converge.

## Out of scope

- Touching the auth-pass cadence (kept at current ~30–60s).
- Renderer styling of `S?` rows beyond the existing default.
- Renaming the `S?` placeholder to something fancier.

## Files touched

- `cairn_svc/server.py` — three small edits in `stitch_labels` and the streaming pyannote loop and `_drain_pending`.
- `tests/test_stitch_labels.py` — new test asserting Tier 0 returns `"S?"` and collision losers also return `"S?"`.
