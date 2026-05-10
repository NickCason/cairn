# Streaming-defers-to-auth-pass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Stop the streaming diarizer from minting new canonical SIDs. Use `S?` placeholder until the auth pass confirms.

**Architecture:** Three small edits in `cairn_svc/server.py` on node4: `stitch_labels` returns `"S?"` for unknown labels and collision losers; the centroid-update loop skips `"S?"`; `_drain_pending` skips the SpeakerAssigned emit for `"S?"`. Auth pass (which already mints canonical SIDs and emits relabels) is untouched.

**Tech Stack:** Python 3.11 + pytest on node4. systemd-managed `cairn-svc`.

**Spec:** `docs/superpowers/specs/2026-05-09-streaming-defers-to-auth-pass-design.md`

---

## Task 1: Failing test for stitch_labels

**Files (on node4):**
- Create: `tests/test_stitch_labels_no_mint.py`

- [ ] **Step 1: Write the failing test**

```bash
ssh node4 "cat > /home/nick/cairn-svc/tests/test_stitch_labels_no_mint.py" <<'EOF'
"""Verify stitch_labels never mints new canonical SIDs.

Per the streaming-defers-to-auth-pass design (2026-05-09): when the
streaming pyannote pass sees a pyannote-local label that doesn't match any
existing centroid, stitch_labels MUST return "S?" instead of minting a
fresh stable_id. The auth pass is the only path that introduces canonical
SIDs.
"""
import numpy as np
import pytest

from cairn_svc.server import stitch_labels
from cairn_svc.session import Session
from cairn_svc.protocol import DiarizationSegment


def _seg(label: str, t0_ms: int, t1_ms: int) -> DiarizationSegment:
    return DiarizationSegment(label=label, t_start_ms=t0_ms, t_end_ms=t1_ms)


def test_tier0_unknown_returns_S_question_not_mint():
    """Unknown pyannote label with no embedding/geometric match → 'S?'."""
    session = Session(meeting_name="t")
    new_segs = [_seg("LABEL_A", 0, 2000)]
    label_to_stable = stitch_labels(
        new_segs=new_segs,
        prev_segs=[],
        session=session,
        overlap_floor_ms=0,
        new_label_emb={"LABEL_A": np.random.RandomState(0).randn(192).astype(np.float32)},
    )
    assert label_to_stable == {"LABEL_A": "S?"}, (
        f"Expected 'S?' (defer to auth pass); got {label_to_stable}"
    )
    # Session SID counter must not have advanced.
    assert session.mint_stable_id() == "S1", (
        "stitch_labels should not have minted any stable_ids"
    )


def test_collision_loser_also_returns_S_question():
    """When two labels both want the same existing SID, only the highest
    tier wins; the loser used to mint fresh — now must return 'S?'."""
    session = Session(meeting_name="t")
    # Pre-seed a centroid for S1.
    rng = np.random.RandomState(1)
    s1_emb = rng.randn(192).astype(np.float32)
    s1_emb /= np.linalg.norm(s1_emb)
    session.update_centroid("S1", s1_emb, duration_s=10.0, tentative=False)

    # Two labels with similar embeddings to S1 (so both want it).
    near = (s1_emb + 0.05 * rng.randn(192)).astype(np.float32)
    near /= np.linalg.norm(near)
    new_segs = [
        _seg("LABEL_A", 0, 2000),
        _seg("LABEL_B", 2000, 4000),
    ]
    label_to_stable = stitch_labels(
        new_segs=new_segs,
        prev_segs=[],
        session=session,
        overlap_floor_ms=0,
        new_label_emb={"LABEL_A": near, "LABEL_B": near},
    )
    # Exactly one of them gets S1; the other gets S?.
    values = sorted(label_to_stable.values())
    assert values == ["S1", "S?"], (
        f"Expected one S1 winner and one S? loser; got {label_to_stable}"
    )


def test_tier3_high_match_still_works():
    """Sanity: a clear embedding match still adopts the existing SID."""
    session = Session(meeting_name="t")
    rng = np.random.RandomState(2)
    s1_emb = rng.randn(192).astype(np.float32)
    s1_emb /= np.linalg.norm(s1_emb)
    session.update_centroid("S1", s1_emb, duration_s=10.0, tentative=False)
    new_segs = [_seg("LABEL_A", 0, 2000)]
    label_to_stable = stitch_labels(
        new_segs=new_segs,
        prev_segs=[],
        session=session,
        overlap_floor_ms=0,
        new_label_emb={"LABEL_A": s1_emb},  # identical → cosine 1.0
    )
    assert label_to_stable == {"LABEL_A": "S1"}
EOF
```

- [ ] **Step 2: Run to verify failure**

```bash
ssh node4 'cd /home/nick/cairn-svc && pytest tests/test_stitch_labels_no_mint.py -v 2>&1 | tail -20'
```

Expected: tests 1 and 2 FAIL because Tier 0 still mints. Test 3 should PASS (sanity check; pre-existing behavior).

## Task 2: Modify stitch_labels to return "S?"

**Files (on node4):**
- Modify: `cairn_svc/server.py` — function `stitch_labels` (around line 638)

- [ ] **Step 1: Replace both mint sites with "S?"**

Find the two `session.mint_stable_id()` calls inside `stitch_labels` (around line 730 in the Tier 0 candidate-build, and around line 747 in the collision-loser branch). Replace each with the literal string `"S?"`.

Before (Tier 0 candidate):
```python
        else:
            candidates.append((new_label, None, 0, 0.0))
```
(This branch records None as the target. The mint happens in Phase 2.)

Before (Phase 2 collision loser):
```python
    label_to_stable: dict[str, str] = {}
    claimed: set[str] = set()
    for new_label, target, _tier, _score in sorted(
        candidates, key=lambda c: (c[2], c[3]), reverse=True
    ):
        if target is not None and target not in claimed:
            label_to_stable[new_label] = target
            claimed.add(target)
        else:
            label_to_stable[new_label] = session.mint_stable_id()
    return label_to_stable
```

After (Phase 2):
```python
    label_to_stable: dict[str, str] = {}
    claimed: set[str] = set()
    for new_label, target, _tier, _score in sorted(
        candidates, key=lambda c: (c[2], c[3]), reverse=True
    ):
        if target is not None and target not in claimed:
            label_to_stable[new_label] = target
            claimed.add(target)
        else:
            # Streaming defers to the auth pass for canonical SID minting.
            # The placeholder "S?" rides through _drain_pending into the
            # ledger; the next auth tick relabels it with the canonical id.
            label_to_stable[new_label] = "S?"
    return label_to_stable
```

(There's only one mint site in Phase 2; the Tier 0 candidate just records None which falls through to the same Phase 2 branch.)

Update the docstring to reflect the new tier 0 behavior:
```python
      4. else                                 → "S?" (auth pass authority) (tier 0)
```

- [ ] **Step 2: Run tests, expect 1+2 to pass and 3 still passes**

```bash
ssh node4 'cd /home/nick/cairn-svc && pytest tests/test_stitch_labels_no_mint.py -v 2>&1 | tail -20'
```

All 3 tests pass.

- [ ] **Step 3: Run the full svc test suite to check for regressions**

```bash
ssh node4 'cd /home/nick/cairn-svc && pytest -x -q 2>&1 | tail -30'
```

Expected: all pass. If any test fails because it depended on the old mint behavior, investigate. Don't paper-over by editing the test — flag and report.

## Task 3: Skip centroid update + SpeakerAssigned emit for "S?"

**Files (on node4):**
- Modify: `cairn_svc/server.py` — the streaming pyannote loop's centroid update (around line 1077) and `_drain_pending` (around line 836)

- [ ] **Step 1: Skip centroid update for "S?"**

Find the centroid-update block (search `for new_label, stable_id in label_to_stable.items():` near line 1077). Add a guard:

```python
    for new_label, stable_id in label_to_stable.items():
        if stable_id == "S?":
            continue  # placeholder — auth pass owns centroid for this segment
        e_L = label_emb.get(new_label)
        if e_L is None:
            continue
        # ... existing code ...
```

- [ ] **Step 2: Skip SpeakerAssigned emit for "S?" in _drain_pending**

Find the block around line 836 in `_drain_pending`:

```python
            if stable not in sent_speakers:
                sent_speakers.add(stable)
                await ws.send_text(SpeakerAssignedMsg(
                    speaker_id=stable, color_hint=session.color_hint_for(stable)
                ).model_dump_json())
```

Wrap with a guard:

```python
            if stable != "S?" and stable not in sent_speakers:
                sent_speakers.add(stable)
                await ws.send_text(SpeakerAssignedMsg(
                    speaker_id=stable, color_hint=session.color_hint_for(stable)
                ).model_dump_json())
```

(The `TranscriptFinalMsg` immediately after still emits with `speaker_id="S?"` — that's intentional. The renderer handles unknown ids with a default neutral pill.)

- [ ] **Step 3: Run full svc test suite**

```bash
ssh node4 'cd /home/nick/cairn-svc && pytest -x -q 2>&1 | tail -10'
```

Expected: all pass.

## Task 4: Commit + restart svc

- [ ] **Step 1: Single commit covering Tasks 1-3**

```bash
ssh node4 'cd /home/nick/cairn-svc && git add cairn_svc/server.py tests/test_stitch_labels_no_mint.py && git commit -m "feat(svc): streaming defers to auth pass for new SID minting (S? placeholder)"'
```

- [ ] **Step 2: Restart cairn-svc**

```bash
ssh node4 'sudo systemctl restart cairn-svc'
sleep 3
ssh node4 'sudo systemctl status cairn-svc --no-pager | head -10'
```

Verify status is `active (running)`.

- [ ] **Step 3: Confirm svc is reachable**

```bash
curl -fsS --max-time 3 http://100.99.99.72:8300/health 2>&1 || echo "(no /health endpoint — that's OK, the WS is the real check)"
```

The 20-min e2e harness in Task 5 is the real smoke test.

## Task 5: 20-min e2e on Diamandis ep 220

- [ ] **Step 1: Run the harness against the 3-speaker fixture**

```bash
cd /Users/nickcason/dev/cairn && \
REFERENCE=scripts/fixtures/diamandis-220-reference.json bash scripts/cairn-loop.sh \
  --url 'https://www.youtube.com/watch?v=RSNuB9pj9P8&t=296s' \
  --duration 1200 \
  --out /tmp/cairn-test-runs
```

(Run in background; 22-25 min wall.)

- [ ] **Step 2: Analyze the saved session**

After completion, examine `~/Documents/Cairn/<latest>/transcript.jsonl`:

- Count `speaker_assigned` events — expect ≤ ~5 (vs. 20 in the broken run).
- Count distinct `speaker_id` values on `transcript_final` events — expect ~3 + maybe `S?`.
- Check rate of `S?` appearances over time — should drop as auth pass relabels.
- Verify `final_summary` is populated and references the canonical 3 speakers (not S?).
- Check bleed/grade via `/tmp/cairn-test-runs/run-<latest>/grade.json`.

Compare to the failing 5-min run (memory: 23 spawns, 19 merges, 81 relabels in 5 min).

Success criteria (quantitative):
- ≤ 5 speaker_assigned events per 20 min
- speaker_merge events approach zero (auth pass mints cleanly the first time)
- final_summary speakers match the actual speakers (≥ 2 of 3)
- Bleed rate roughly comparable to the 4.4% Lex/Dario baseline

If criteria miss badly, write up findings rather than ship.
