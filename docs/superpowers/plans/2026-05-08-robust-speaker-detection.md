# Robust speaker detection — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace geometry-only cross-window speaker stitching with embedding-augmented identity, plus a merge sweep that retroactively unifies stable_ids whose voice centroids converge. Remove the speaker-count dropdown.

**Architecture:** Each `Session.stable_id` carries a duration-weighted EMA voice centroid persisted for the whole session. `stitch_labels` picks a stable_id per pyannote-local label using a hierarchy: strong embedding match (cosine ≥ HIGH) → geometric overlap ≥ 0.20 → tentative low-band embedding match (short utterance) → mint new. After every diar pass, `merge_sweep` pairwise-compares centroids and collapses ids whose cosine ≥ MERGE_COS via `Session.merge_stable`, emitting `speaker_merge` WS events that the client uses to retroactively rewrite past lines in place.

**Tech Stack:** cairn-svc (Python 3.11, FastAPI/WebSocket, pyannote.audio 3.x, NumPy, pytest) on `precision-node4` at `~/cairn-svc`. Cairn client (TypeScript, Electron renderer, vanilla DOM) at `/Users/nickcason/dev/cairn`. Reference spec: `docs/superpowers/specs/2026-05-08-robust-speaker-detection-design.md`.

**Repository operations:** All cairn-svc tasks run via `ssh node4` (server is local-only, no remote — commit only, no push). Client tasks run locally; commit + push to `origin/main`.

---

## File Structure

### cairn-svc (`~/cairn-svc` on node4)

| File | Change | Responsibility |
|---|---|---|
| `cairn_svc/diarize.py` | MODIFY | `diarize_pcm` returns `(segs, label→embedding)` from `pipeline(..., return_embeddings=True)` |
| `cairn_svc/session.py` | MODIFY (additive) | `_centroids` dict, `update_centroid`, `merge_stable` |
| `cairn_svc/server.py` | MODIFY | `stitch_labels` hybrid rule, new `merge_sweep`, wire into `_run_diarization_pass`; remove `num_speakers_hint`, `max_stable`, `SetNumSpeakers` handling |
| `cairn_svc/protocol.py` | MODIFY | Add `SpeakerMergeMsg`; remove `SetNumSpeakersMsg` and `StartMsg.num_speakers` |
| `tests/test_stitch_labels.py` | EXTEND | Embedding-aware cases |
| `tests/test_centroids.py` | NEW | Centroid EMA + cap tests |
| `tests/test_merge_sweep.py` | NEW | Merge sweep behavior tests |
| `tests/test_session.py` | EXTEND | `merge_stable` rewrites _diar_segs and _ledger |
| `.env.example` | MODIFY | Document new `CAIRN_DIAR_*` vars |

### Cairn client (this repo)

| File | Change | Responsibility |
|---|---|---|
| `src/renderer/ws.ts` | MODIFY | Add `SpeakerMergeMsg` to `ServerMsg` union; drop `setNumSpeakers()` and `numSpeakers` arg on `start()` |
| `src/renderer/speakers.ts` | MODIFY (additive) | `merge(srcId, dstId)` |
| `src/renderer/transcript.ts` | MODIFY (additive) | `mergeSpeakers(srcId, dstId)` walks rendered DOM |
| `src/renderer/app.ts` | MODIFY | Handle `speaker_merge`; drop `$speakersToggle`, `currentSpeakers`, `loadSpeakers`/`saveSpeakers`, `refreshSpeakerToggleLabel`, `SPEAKER_VALUES`, the toggle `onclick` handler, the `speakerHint` plumbing into `startLiveSession` |
| `src/renderer/index.html` | MODIFY | Delete `#speakers-toggle` button |

---

## Task 1: Spike — verify pyannote pipeline exposes per-label embeddings

**Files:** none (research)

The whole approach hinges on pyannote 3.x's `return_embeddings=True` flag returning a per-pyannote-label centroid alongside the diarization. Confirm before touching code.

- [ ] **Step 1: Run a one-shot probe on node4**

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -c "
import os, wave, tempfile, numpy as np
from pyannote.audio import Pipeline
import torch
# Use any small wav lying around — generate 6s of synthetic noise as a placeholder.
# Pyannote will likely produce 0 speakers on noise; the call shape is what matters.
sr = 16000
pcm = (np.random.randn(sr*6) * 1000).astype(np.int16).tobytes()
with tempfile.NamedTemporaryFile(suffix=\".wav\", delete=False) as f:
    with wave.open(f, \"wb\") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes(pcm)
    path = f.name
token = os.environ[\"PYANNOTE_HF_TOKEN\"]
pipe = Pipeline.from_pretrained(\"pyannote/speaker-diarization-3.1\", use_auth_token=token)
pipe = pipe.to(torch.device(\"cpu\"))
result = pipe(path, return_embeddings=True)
print(\"return type:\", type(result).__name__, \"len:\", len(result) if hasattr(result, \"__len__\") else \"n/a\")
if isinstance(result, tuple) and len(result) == 2:
    diar, emb = result
    print(\"diar labels:\", list(diar.labels()))
    print(\"embeddings type:\", type(emb).__name__, \"shape:\", getattr(emb, \"shape\", \"n/a\"))
"
'
```

Expected: prints `return type: tuple len: 2`, the embeddings object's type and shape (numpy array of shape `(num_speakers, embedding_dim)` or dict-like).

- [ ] **Step 2: Document the embedding-access shape**

Open `docs/superpowers/specs/2026-05-08-robust-speaker-detection-design.md` and append a single line under "Risks & mitigations" → "Pyannote embeddings inaccessible…" row, e.g.:

```markdown
> Verified 2026-05-08: `pipeline(path, return_embeddings=True)` returns `(diarization, embeddings)` where embeddings is `np.ndarray` of shape `(N_speakers, 256)` indexed in `diarization.labels()` order.
```

(Adjust to match what Step 1 actually printed — array shape, dtype, label-order semantics.)

- [ ] **Step 3: Commit the spec note**

```bash
git add docs/superpowers/specs/2026-05-08-robust-speaker-detection-design.md
git commit -m "docs: record verified pyannote embedding shape from spike"
```

If the probe fails (returns no embeddings, or pipeline raises on the kwarg) — STOP and reconvene. The fallback is a separate `pyannote/embedding` pass per segment, which is a different plan.

---

## Task 2: `diarize_pcm` returns embeddings

**Files:**
- Modify: `~/cairn-svc/cairn_svc/diarize.py:108-150` (function body)

- [ ] **Step 1: Update `diarize_pcm` signature and body**

Replace the function (note: `pipeline(...)` call now uses `return_embeddings=True`, return type changes):

```python
def diarize_pcm(
    pcm: bytes, sample_rate: int = 16000, num_speakers: Optional[int] = None,
) -> tuple[list[DiarizationSegment], dict[str, np.ndarray]]:
    """Run diarization on a PCM buffer.

    Returns (segments, label_to_embedding). The embedding for each pyannote-local
    label is pyannote's per-pass speaker centroid (one vector per label). Empty
    embedding dict when pyannote returns no speakers.
    """
    if len(pcm) == 0:
        return [], {}

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        with wave.open(tmp, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sample_rate)
            w.writeframes(pcm)
        path = tmp.name
    try:
        pipeline = get_pipeline()
        try:
            kwargs = {"return_embeddings": True}
            if num_speakers is not None:
                kwargs["num_speakers"] = num_speakers
            diarization, embeddings = pipeline(path, **kwargs)
        except Exception as e:
            msg = str(e).lower()
            if "out of memory" in msg or "cuda" in msg:
                log.warning("diarization run failed (%s); skipping this tick", e)
                try:
                    import torch
                    torch.cuda.empty_cache()
                except Exception:
                    pass
                return [], {}
            raise
        finally:
            if _PIPELINE_DEVICE == "cuda":
                try:
                    import torch
                    torch.cuda.empty_cache()
                except Exception:
                    pass
    finally:
        os.unlink(path)

    out: list[DiarizationSegment] = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        out.append(DiarizationSegment(
            label=speaker,
            t_start_ms=int(turn.start * 1000),
            t_end_ms=int(turn.end * 1000),
        ))

    # pyannote returns embeddings as np.ndarray (N_speakers, dim) indexed by
    # diarization.labels() order. Convert to {label: np.ndarray} for tidy
    # downstream access.
    emb_map: dict[str, np.ndarray] = {}
    if embeddings is not None:
        labels_in_order = list(diarization.labels())
        for i, label in enumerate(labels_in_order):
            if i < len(embeddings):
                vec = np.asarray(embeddings[i], dtype=np.float32)
                if vec.size > 0 and not np.all(vec == 0):
                    # L2-normalize so downstream cosine = dot product.
                    norm = float(np.linalg.norm(vec))
                    if norm > 0:
                        emb_map[label] = vec / norm

    return out, emb_map
```

- [ ] **Step 2: Smoke-check it imports**

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -c "from cairn_svc.diarize import diarize_pcm; import inspect; print(inspect.signature(diarize_pcm))"'
```

Expected: prints signature with the new return type. No exceptions.

- [ ] **Step 3: Commit**

```bash
ssh node4 'cd ~/cairn-svc && git add cairn_svc/diarize.py && git commit -m "feat(svc): diarize_pcm returns per-label embeddings"'
```

---

## Task 3: Update `_run_diarization_pass` to consume new tuple

**Files:**
- Modify: `~/cairn-svc/cairn_svc/server.py` (search for `diarize_pcm(`)

- [ ] **Step 1: Locate the call**

```bash
ssh node4 'cd ~/cairn-svc && grep -n "diarize_pcm\|stitch_labels(" cairn_svc/server.py'
```

Expected: a single call to `diarize_pcm` inside `_run_diarization_pass`, plus the existing `stitch_labels(...)` call site.

- [ ] **Step 2: Adapt the call to unpack the new tuple**

Find the line that looks like:
```python
new_segs = diarize_pcm(window_pcm, sample_rate=16000, num_speakers=ns)
```
and change to:
```python
new_segs, label_emb = diarize_pcm(window_pcm, sample_rate=16000, num_speakers=ns)
```

The `label_emb` dict is unused for now (Tasks 6–7 thread it into `stitch_labels`). Add a `# label_emb threaded in next task` comment to make the WIP intent explicit.

- [ ] **Step 3: Restart service to confirm no runtime regression**

```bash
ssh node4 'systemctl --user restart cairn-svc && sleep 3 && systemctl --user is-active cairn-svc && journalctl --user -u cairn-svc -n 5 --no-pager'
```

Expected: `active`, no traceback in last 5 log lines.

- [ ] **Step 4: Commit**

```bash
ssh node4 'cd ~/cairn-svc && git add cairn_svc/server.py && git commit -m "refactor(svc): unpack diarize_pcm tuple in _run_diarization_pass"'
```

---

## Task 4: `Session._centroids` + `update_centroid`

**Files:**
- Test: `~/cairn-svc/tests/test_centroids.py` (NEW)
- Modify: `~/cairn-svc/cairn_svc/session.py` (after `color_hint_for`)

- [ ] **Step 1: Write the failing tests**

Create `tests/test_centroids.py`:

```python
"""Tests for per-stable-id voice centroid management on Session."""
import numpy as np
from cairn_svc.session import Session


def _vec(x: float, y: float) -> np.ndarray:
    v = np.array([x, y], dtype=np.float32)
    n = float(np.linalg.norm(v))
    return v / n if n > 0 else v


def test_update_centroid_initializes_on_first_call():
    s = Session(meeting_name="t")
    s.mint_stable_id()  # S1
    e = _vec(1.0, 0.0)
    s.update_centroid("S1", e, duration_s=10.0, tentative=False)
    c, total = s._centroids["S1"]
    np.testing.assert_allclose(c, e, atol=1e-6)
    assert total == 10.0


def test_update_centroid_ema_weights_by_duration():
    s = Session(meeting_name="t")
    s.mint_stable_id()
    s.update_centroid("S1", _vec(1.0, 0.0), duration_s=10.0, tentative=False)
    s.update_centroid("S1", _vec(0.0, 1.0), duration_s=10.0, tentative=False)
    c, total = s._centroids["S1"]
    # 50/50 mix of two orthogonal unit vectors after L2-normalize:
    expected = _vec(0.5, 0.5)
    np.testing.assert_allclose(c, expected, atol=1e-6)
    assert total == 20.0


def test_update_centroid_per_update_cap_resists_outlier():
    s = Session(meeting_name="t")
    s.mint_stable_id()
    # 60s of speaker A
    s.update_centroid("S1", _vec(1.0, 0.0), duration_s=60.0, tentative=False)
    # 1s outlier in orthogonal direction; cap is 30s but new is 1s — should barely move.
    s.update_centroid("S1", _vec(0.0, 1.0), duration_s=1.0, tentative=False)
    c, _ = s._centroids["S1"]
    # Movement should be < 0.05 in the orthogonal axis.
    assert c[1] < 0.05


def test_update_centroid_total_cap_keeps_responsiveness():
    s = Session(meeting_name="t")
    s.mint_stable_id()
    # Fill total_s past the cap.
    for _ in range(40):
        s.update_centroid("S1", _vec(1.0, 0.0), duration_s=30.0, tentative=False)
    _, total = s._centroids["S1"]
    assert total <= 600.0  # CENTROID_TOTAL_CAP_S
    # A late update still moves the centroid measurably (would be ~0 without the cap).
    s.update_centroid("S1", _vec(0.0, 1.0), duration_s=30.0, tentative=False)
    c, _ = s._centroids["S1"]
    assert c[1] > 0.02


def test_tentative_update_downweighted():
    s = Session(meeting_name="t")
    s.mint_stable_id()
    s.update_centroid("S1", _vec(1.0, 0.0), duration_s=30.0, tentative=False)
    # Snapshot
    c0 = s._centroids["S1"][0].copy()
    s.update_centroid("S1", _vec(0.0, 1.0), duration_s=10.0, tentative=True)
    c1 = s._centroids["S1"][0]
    # Confident update of same shape for comparison
    s2 = Session(meeting_name="t2")
    s2.mint_stable_id()
    s2.update_centroid("S1", _vec(1.0, 0.0), duration_s=30.0, tentative=False)
    s2.update_centroid("S1", _vec(0.0, 1.0), duration_s=10.0, tentative=False)
    c1_confident = s2._centroids["S1"][0]
    # Tentative move ≈ ¼ the confident move on the orthogonal axis.
    move_tent = abs(c1[1] - c0[1])
    move_conf = abs(c1_confident[1] - c0[1])
    assert move_tent < move_conf
    assert move_tent < 0.30 * move_conf  # roughly quarter, allow slop
```

- [ ] **Step 2: Run failing tests**

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_centroids.py -v 2>&1 | tail -15'
```

Expected: all 5 tests fail with `AttributeError: 'Session' object has no attribute '_centroids'` or `update_centroid`.

- [ ] **Step 3: Implement `_centroids` storage and `update_centroid`**

In `cairn_svc/session.py`, add to `Session.__init__` (after `_color_for_stable`):

```python
        # Voice-identity centroids per stable id, used by stitch_labels and
        # merge_sweep to make stitching robust across silence gaps and
        # pyannote relabeling. (vec, total_observed_seconds).
        self._centroids: dict[str, tuple["np.ndarray", float]] = {}
```

Add NumPy import at top of file: `import numpy as np` (alongside existing imports).

Add the method (place after `color_hint_for`):

```python
    # --- voice centroids ---

    CENTROID_CAP_S = 30.0          # per-update weight cap
    CENTROID_TOTAL_CAP_S = 600.0   # EMA denominator cap
    TENTATIVE_DOWNWEIGHT = 0.25    # path-3.3 update factor

    def update_centroid(self, stable_id: str, embedding: "np.ndarray",
                        duration_s: float, tentative: bool) -> None:
        """Duration-weighted EMA update of a stable_id's voice centroid.

        - First call for a stable_id seeds the centroid to the new embedding.
        - Subsequent calls move the centroid toward the new embedding, weighted
          by min(duration_s, CENTROID_CAP_S) / (total_s + min(...)). The
          per-update cap prevents one big chunk from dominating.
        - total_s is capped at CENTROID_TOTAL_CAP_S so late-session updates
          remain influential (slow voice drift).
        - tentative=True applies an additional ¼ downweight, used by the
          short-utterance LOW band in stitch_labels.
        """
        if embedding is None or embedding.size == 0:
            return
        norm = float(np.linalg.norm(embedding))
        if norm <= 0.0:
            return
        e = embedding / norm if abs(norm - 1.0) > 1e-6 else embedding

        existing = self._centroids.get(stable_id)
        if existing is None:
            self._centroids[stable_id] = (e.astype(np.float32), float(duration_s))
            return

        c, total_s = existing
        t_eff = min(duration_s, self.CENTROID_CAP_S)
        if tentative:
            t_eff *= self.TENTATIVE_DOWNWEIGHT
        if t_eff <= 0.0:
            return
        w = t_eff / (total_s + t_eff)
        new_c = (1.0 - w) * c + w * e
        n = float(np.linalg.norm(new_c))
        if n > 0:
            new_c = new_c / n
        new_total = min(total_s + duration_s, self.CENTROID_TOTAL_CAP_S)
        self._centroids[stable_id] = (new_c.astype(np.float32), new_total)
```

- [ ] **Step 4: Run tests, verify pass**

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_centroids.py -v 2>&1 | tail -10'
```

Expected: 5 passed.

- [ ] **Step 5: Run full suite to ensure no regression**

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/ -q 2>&1 | tail -5'
```

Expected: all previously-passing tests still pass.

- [ ] **Step 6: Commit**

```bash
ssh node4 'cd ~/cairn-svc && git add cairn_svc/session.py tests/test_centroids.py && git commit -m "feat(svc): per-stable-id voice centroid storage with EMA + caps"'
```

---

## Task 5: `Session.merge_stable`

**Files:**
- Test: `~/cairn-svc/tests/test_session.py` (extend)
- Modify: `~/cairn-svc/cairn_svc/session.py` (after `update_centroid`)

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_session.py`:

```python
import numpy as np


def _vec(x: float, y: float):
    v = np.array([x, y], dtype=np.float32)
    n = float(np.linalg.norm(v))
    return v / n if n > 0 else v


def test_merge_stable_absorbs_centroid_duration_weighted():
    s = Session(meeting_name="t")
    s.mint_stable_id()  # S1
    s.mint_stable_id()  # S2
    s.update_centroid("S1", _vec(1.0, 0.0), 60.0, tentative=False)
    s.update_centroid("S2", _vec(0.0, 1.0), 20.0, tentative=False)
    s.merge_stable(src="S2", dst="S1")
    assert "S2" not in s._centroids
    assert "S1" in s._centroids
    c, total = s._centroids["S1"]
    # 60/(60+20) toward S1's old centroid + 20/(60+20) toward S2's
    assert total == 80.0
    assert c[0] > c[1]  # still mostly S1
    assert c[1] > 0.0   # but moved toward S2


def test_merge_stable_rewrites_diar_segs():
    from cairn_svc.diarize import DiarizationSegment
    s = Session(meeting_name="t")
    s.mint_stable_id(); s.mint_stable_id()
    s._diar_segs = [
        DiarizationSegment(label="S1", t_start_ms=0, t_end_ms=1000),
        DiarizationSegment(label="S2", t_start_ms=1000, t_end_ms=2000),
        DiarizationSegment(label="S2", t_start_ms=2000, t_end_ms=3000),
    ]
    s.merge_stable(src="S2", dst="S1")
    assert {seg.label for seg in s._diar_segs} == {"S1"}
    # Time spans preserved
    assert sum(seg.t_end_ms - seg.t_start_ms for seg in s._diar_segs) == 3000


def test_merge_stable_rewrites_ledger():
    s = Session(meeting_name="t")
    s.mint_stable_id(); s.mint_stable_id()
    s.append_final(seq=1, text="hi", speaker_id="S1", t_start=0.0, t_end=1.0)
    s.append_final(seq=2, text="hey", speaker_id="S2", t_start=1.0, t_end=2.0)
    s.append_final(seq=3, text="ok", speaker_id="S2", t_start=2.0, t_end=3.0)
    s.merge_stable(src="S2", dst="S1")
    assert s._ledger[1]["speaker_id"] == "S1"
    assert s._ledger[2]["speaker_id"] == "S1"
    assert s._ledger[3]["speaker_id"] == "S1"


def test_merge_stable_drops_src_color():
    s = Session(meeting_name="t")
    s.mint_stable_id(); s.mint_stable_id()
    assert "S2" in s._color_for_stable
    s.merge_stable(src="S2", dst="S1")
    assert "S2" not in s._color_for_stable
    assert "S1" in s._color_for_stable


def test_merge_stable_noop_when_src_missing():
    s = Session(meeting_name="t")
    s.mint_stable_id()
    # S2 was never minted.
    s.merge_stable(src="S2", dst="S1")  # should not raise
    assert "S1" in s._color_for_stable
```

- [ ] **Step 2: Run failing tests**

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_session.py -v -k merge_stable 2>&1 | tail -15'
```

Expected: 5 fails with `AttributeError: 'Session' object has no attribute 'merge_stable'`.

- [ ] **Step 3: Implement `merge_stable`**

Add after `update_centroid` in `session.py`:

```python
    def merge_stable(self, *, src: str, dst: str) -> None:
        """Absorb stable_id ``src`` into ``dst``.

        Updates dst's centroid as a duration-weighted average with src's,
        rewrites every src-labelled diar seg to dst, rewrites every
        src-attributed ledger line to dst, and drops src from _centroids
        and _color_for_stable. No-op if src is unknown.
        """
        from .diarize import DiarizationSegment

        src_centroid = self._centroids.pop(src, None)
        dst_centroid = self._centroids.get(dst)

        if src_centroid is not None and dst_centroid is not None:
            sc, st = src_centroid
            dc, dt = dst_centroid
            total = st + dt
            if total > 0:
                merged = (dt * dc + st * sc) / total
                n = float(np.linalg.norm(merged))
                if n > 0:
                    merged = merged / n
                merged_total = min(total, self.CENTROID_TOTAL_CAP_S)
                self._centroids[dst] = (merged.astype(np.float32), merged_total)
        elif src_centroid is not None and dst_centroid is None:
            # dst had no centroid yet — adopt src's.
            self._centroids[dst] = src_centroid

        # Rewrite diar segs in place.
        self._diar_segs = [
            DiarizationSegment(
                label=(dst if seg.label == src else seg.label),
                t_start_ms=seg.t_start_ms, t_end_ms=seg.t_end_ms,
            )
            for seg in self._diar_segs
        ]

        # Rewrite ledger lines.
        for entry in self._ledger.values():
            if entry["speaker_id"] == src:
                entry["speaker_id"] = dst

        # Drop src from color map.
        self._color_for_stable.pop(src, None)
```

- [ ] **Step 4: Run tests, verify pass**

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_session.py -v -k merge_stable 2>&1 | tail -10'
```

Expected: 5 passed.

- [ ] **Step 5: Run full suite**

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/ -q 2>&1 | tail -5'
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
ssh node4 'cd ~/cairn-svc && git add cairn_svc/session.py tests/test_session.py && git commit -m "feat(svc): Session.merge_stable absorbs centroid + rewrites diar/ledger"'
```

---

## Task 6: `stitch_labels` — embedding HIGH path + new signature

**Files:**
- Test: `~/cairn-svc/tests/test_stitch_labels.py` (extend)
- Modify: `~/cairn-svc/cairn_svc/server.py:58-115` (function body)

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_stitch_labels.py`:

```python
import numpy as np


def _emb(x: float, y: float) -> np.ndarray:
    v = np.array([x, y], dtype=np.float32)
    return v / float(np.linalg.norm(v))


def test_embedding_recovers_id_after_silence_gap():
    """No overlap with prior segs in the overlap zone, but embedding matches
    a known centroid → adopt the existing stable id (no new mint)."""
    s = Session(meeting_name="t")
    s.mint_stable_id()  # S1
    s.update_centroid("S1", _emb(1.0, 0.0), duration_s=30.0, tentative=False)
    # Prior pass had S1 only at the very start; overlap zone is empty.
    prev = [_seg("S1", 0, 5_000)]
    new = [_seg("SPEAKER_00", 80_000, 90_000)]  # 80-90s, no overlap
    label_emb = {"SPEAKER_00": _emb(0.99, 0.14)}  # cosine ≈ 0.99 with S1
    mapping = stitch_labels(
        new, prev, s,
        overlap_floor_ms=70_000,
        new_label_emb=label_emb,
    )
    assert mapping == {"SPEAKER_00": "S1"}


def test_embedding_overrides_geometric_when_hit_above_high_threshold():
    """Geometric overlap points to A, but embedding strongly matches B.
    Embedding HIGH wins."""
    s = Session(meeting_name="t")
    s.mint_stable_id(); s.mint_stable_id()  # S1, S2
    s.update_centroid("S1", _emb(1.0, 0.0), 30.0, tentative=False)
    s.update_centroid("S2", _emb(0.0, 1.0), 30.0, tentative=False)
    # Prior pass: S1 from 0..30s
    prev = [_seg("S1", 0, 30_000)]
    new = [_seg("SPEAKER_00", 5_000, 25_000)]  # heavy overlap with S1
    label_emb = {"SPEAKER_00": _emb(0.05, 1.0)}  # but voice matches S2
    mapping = stitch_labels(
        new, prev, s,
        overlap_floor_ms=0,
        new_label_emb=label_emb,
    )
    assert mapping == {"SPEAKER_00": "S2"}


def test_no_embeddings_falls_back_to_geometric():
    """Empty label_emb dict: behavior matches the old geometric-only path."""
    s = Session(meeting_name="t")
    s.mint_stable_id()
    prev = [_seg("S1", 0, 30_000)]
    new = [_seg("SPEAKER_01", 12_000, 28_000)]
    mapping = stitch_labels(
        new, prev, s,
        overlap_floor_ms=10_000,
        new_label_emb={},
    )
    assert mapping == {"SPEAKER_01": "S1"}


def test_no_match_mints_new_when_below_all_thresholds():
    s = Session(meeting_name="t")
    s.mint_stable_id()
    s.update_centroid("S1", _emb(1.0, 0.0), 30.0, tentative=False)
    new = [_seg("SPEAKER_00", 0, 10_000)]
    label_emb = {"SPEAKER_00": _emb(0.0, 1.0)}  # cosine 0, well below LOW
    mapping = stitch_labels(
        new, prev_segs=[], session=s,
        overlap_floor_ms=0,
        new_label_emb=label_emb,
    )
    assert mapping == {"SPEAKER_00": "S2"}  # fresh mint
```

- [ ] **Step 2: Run failing tests**

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_stitch_labels.py -v 2>&1 | tail -20'
```

Expected: the four new tests fail with `TypeError: stitch_labels() got an unexpected keyword argument 'new_label_emb'`. Existing 4 tests pass.

- [ ] **Step 3: Refactor `stitch_labels` to take `new_label_emb` and apply embedding rules**

Replace the entire `stitch_labels` function in `cairn_svc/server.py` (currently around `:58-115`):

```python
import os
import numpy as np

# Tunables (env-controlled). Read at module load; restart svc to change.
CAIRN_DIAR_STITCH_EMB_HIGH = float(os.getenv("CAIRN_DIAR_STITCH_EMB_HIGH", "0.78"))
CAIRN_DIAR_STITCH_EMB_LOW = float(os.getenv("CAIRN_DIAR_STITCH_EMB_LOW", "0.65"))
CAIRN_DIAR_FALLBACK_T_S = float(os.getenv("CAIRN_DIAR_FALLBACK_T_S", "3.0"))
CAIRN_DIAR_MERGE_COS = float(os.getenv("CAIRN_DIAR_MERGE_COS", "0.82"))
CAIRN_DIAR_MERGE_MIN_S = float(os.getenv("CAIRN_DIAR_MERGE_MIN_S", "8.0"))


def _cosine(a: "np.ndarray", b: "np.ndarray") -> float:
    na, nb = float(np.linalg.norm(a)), float(np.linalg.norm(b))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def stitch_labels(
    new_segs: list[DiarizationSegment],
    prev_segs: list[DiarizationSegment],
    session: Session,
    overlap_floor_ms: int,
    new_label_emb: dict[str, "np.ndarray"] | None = None,
) -> dict[str, str]:
    """Map each pyannote-local label in new_segs to a session-stable id.

    Hybrid decision rule per label:
      1. cosine(e_L, c_i) >= STITCH_EMB_HIGH  → adopt embedding's best id
      2. geometric overlap >= 20% of t_L     → adopt geometric's best id
      3. cosine >= STITCH_EMB_LOW AND t_L < FALLBACK_T_S
                                              → adopt embedding's best id
                                                (caller should use tentative
                                                centroid update for path 3)
      4. else                                 → mint a fresh stable_id

    Returns label → stable_id mapping. Centroid updates and merge sweep are
    the caller's responsibility (see _run_diarization_pass / merge_sweep).
    """
    from collections import defaultdict
    new_label_emb = new_label_emb or {}

    prev_by_stable: dict[str, list[DiarizationSegment]] = defaultdict(list)
    for s in prev_segs:
        if s.t_end_ms > overlap_floor_ms:
            prev_by_stable[s.label].append(s)

    label_to_stable: dict[str, str] = {}
    for new_label in {s.label for s in new_segs}:
        new_intervals = [
            (s.t_start_ms, s.t_end_ms) for s in new_segs if s.label == new_label
        ]
        total_ms = sum(b - a for a, b in new_intervals)
        t_l_s = total_ms / 1000.0

        # Geometric score
        best_geom_stable: str | None = None
        best_geom_overlap = 0
        for stable_id, prev_list in prev_by_stable.items():
            ms = sum(
                _interval_overlap_ms((a, b), (s.t_start_ms, s.t_end_ms))
                for a, b in new_intervals
                for s in prev_list
            )
            if ms > best_geom_overlap:
                best_geom_overlap = ms
                best_geom_stable = stable_id
        geom_pass = (
            best_geom_stable is not None
            and total_ms > 0
            and best_geom_overlap >= 0.2 * total_ms
        )

        # Embedding score (vs every known centroid in the session)
        e_L = new_label_emb.get(new_label)
        best_emb_stable: str | None = None
        best_emb_cos = 0.0
        if e_L is not None and session._centroids:
            for stable_id, (centroid, _) in session._centroids.items():
                c = _cosine(e_L, centroid)
                if c > best_emb_cos:
                    best_emb_cos = c
                    best_emb_stable = stable_id

        # Decision hierarchy
        if best_emb_stable is not None and best_emb_cos >= CAIRN_DIAR_STITCH_EMB_HIGH:
            label_to_stable[new_label] = best_emb_stable
        elif geom_pass:
            label_to_stable[new_label] = best_geom_stable  # type: ignore[assignment]
        elif (
            best_emb_stable is not None
            and best_emb_cos >= CAIRN_DIAR_STITCH_EMB_LOW
            and t_l_s < CAIRN_DIAR_FALLBACK_T_S
        ):
            label_to_stable[new_label] = best_emb_stable
        else:
            label_to_stable[new_label] = session.mint_stable_id()
    return label_to_stable
```

Note: the `max_stable` parameter and its cap-fallback branch are removed. Any caller passing it will break — fixed in Task 11.

- [ ] **Step 4: Run tests, confirm pass**

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_stitch_labels.py -v 2>&1 | tail -15'
```

Expected: all tests pass (existing + 4 new). If the existing `test_threshold_mints_new_id_when_overlap_below_50pct` still references `max_stable=...`, update its `stitch_labels(...)` call to drop that arg.

- [ ] **Step 5: Run full suite**

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/ -q 2>&1 | tail -5'
```

Expected: all pass except possibly a server.py-level test that calls `stitch_labels(..., max_stable=...)` — fix any such call by dropping the kwarg.

- [ ] **Step 6: Commit**

```bash
ssh node4 'cd ~/cairn-svc && git add cairn_svc/server.py tests/test_stitch_labels.py && git commit -m "feat(svc): embedding-augmented stitch_labels with HIGH/LOW thresholds"'
```

---

## Task 7: `stitch_labels` — verify path-3 (tentative LOW band)

**Files:**
- Test: `~/cairn-svc/tests/test_stitch_labels.py` (extend)

The implementation already covers path 3 (Task 6). This task locks in test coverage.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_stitch_labels.py`:

```python
def test_short_segment_takes_low_band_match():
    """t_L < FALLBACK_T_S, geometric below 20%, embedding ∈ [LOW, HIGH).
    Should adopt the embedding's match."""
    s = Session(meeting_name="t")
    s.mint_stable_id()
    s.update_centroid("S1", _emb(1.0, 0.0), 30.0, tentative=False)
    # 2s utterance, no geometric overlap with prior
    new = [_seg("SPEAKER_00", 100_000, 102_000)]
    # cosine ≈ 0.71 (in [LOW=0.65, HIGH=0.78))
    label_emb = {"SPEAKER_00": _emb(0.71, 0.71)}
    mapping = stitch_labels(
        new, prev_segs=[], session=s,
        overlap_floor_ms=90_000,
        new_label_emb=label_emb,
    )
    assert mapping == {"SPEAKER_00": "S1"}


def test_long_segment_below_high_does_not_use_low_band():
    """Same embedding score in LOW band but utterance > FALLBACK_T_S — should
    mint fresh, not adopt."""
    s = Session(meeting_name="t")
    s.mint_stable_id()
    s.update_centroid("S1", _emb(1.0, 0.0), 30.0, tentative=False)
    new = [_seg("SPEAKER_00", 100_000, 110_000)]  # 10s, > FALLBACK_T_S
    label_emb = {"SPEAKER_00": _emb(0.71, 0.71)}
    mapping = stitch_labels(
        new, prev_segs=[], session=s,
        overlap_floor_ms=90_000,
        new_label_emb=label_emb,
    )
    assert mapping == {"SPEAKER_00": "S2"}
```

- [ ] **Step 2: Run; confirm pass directly (no implementation change needed)**

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_stitch_labels.py -v 2>&1 | tail -15'
```

Expected: both new tests pass on first run (Task 6 already implemented path 3).

- [ ] **Step 3: Commit**

```bash
ssh node4 'cd ~/cairn-svc && git add tests/test_stitch_labels.py && git commit -m "test(svc): cover stitch_labels LOW-band path 3"'
```

---

## Task 8: `merge_sweep` function

**Files:**
- Test: `~/cairn-svc/tests/test_merge_sweep.py` (NEW)
- Modify: `~/cairn-svc/cairn_svc/server.py` (after `stitch_labels`)

- [ ] **Step 1: Write the failing tests**

Create `tests/test_merge_sweep.py`:

```python
"""Tests for the post-stitch merge sweep that collapses converged stable_ids."""
import numpy as np
from cairn_svc.diarize import DiarizationSegment
from cairn_svc.server import merge_sweep
from cairn_svc.session import Session


def _emb(x: float, y: float) -> np.ndarray:
    v = np.array([x, y], dtype=np.float32)
    return v / float(np.linalg.norm(v))


def test_merge_fires_on_high_similarity():
    s = Session(meeting_name="t")
    s.mint_stable_id(); s.mint_stable_id()  # S1, S2
    s.update_centroid("S1", _emb(1.0, 0.05), 30.0, tentative=False)
    s.update_centroid("S2", _emb(1.0, 0.04), 30.0, tentative=False)  # ~0.999
    pairs = merge_sweep(s, merge_cos=0.82, merge_min_s=8.0)
    assert pairs == [("S2", "S1")]
    assert "S2" not in s._centroids


def test_merge_skips_short_speakers():
    s = Session(meeting_name="t")
    s.mint_stable_id(); s.mint_stable_id()
    s.update_centroid("S1", _emb(1.0, 0.0), 30.0, tentative=False)
    s.update_centroid("S2", _emb(0.99, 0.14), 5.0, tentative=False)  # 5s < 8s
    pairs = merge_sweep(s, merge_cos=0.82, merge_min_s=8.0)
    assert pairs == []
    assert "S2" in s._centroids


def test_merge_skips_dissimilar_voices():
    s = Session(meeting_name="t")
    s.mint_stable_id(); s.mint_stable_id()
    s.update_centroid("S1", _emb(1.0, 0.0), 30.0, tentative=False)
    s.update_centroid("S2", _emb(0.0, 1.0), 30.0, tentative=False)  # cos = 0
    pairs = merge_sweep(s, merge_cos=0.82, merge_min_s=8.0)
    assert pairs == []
    assert {"S1", "S2"}.issubset(s._centroids)


def test_merge_picks_older_as_dst():
    """When both ids qualify, the younger (higher number) is absorbed
    into the older."""
    s = Session(meeting_name="t")
    s.mint_stable_id(); s.mint_stable_id(); s.mint_stable_id()
    s.update_centroid("S1", _emb(1.0, 0.05), 30.0, tentative=False)
    s.update_centroid("S2", _emb(0.0, 1.0), 30.0, tentative=False)
    s.update_centroid("S3", _emb(1.0, 0.04), 30.0, tentative=False)  # ~S1
    pairs = merge_sweep(s, merge_cos=0.82, merge_min_s=8.0)
    assert pairs == [("S3", "S1")]
    assert "S3" not in s._centroids


def test_merge_rewrites_diar_segs_for_future_geometry():
    s = Session(meeting_name="t")
    s.mint_stable_id(); s.mint_stable_id()
    s.update_centroid("S1", _emb(1.0, 0.05), 30.0, tentative=False)
    s.update_centroid("S2", _emb(1.0, 0.04), 30.0, tentative=False)
    s._diar_segs = [
        DiarizationSegment(label="S1", t_start_ms=0, t_end_ms=10_000),
        DiarizationSegment(label="S2", t_start_ms=10_000, t_end_ms=20_000),
    ]
    merge_sweep(s, merge_cos=0.82, merge_min_s=8.0)
    assert {seg.label for seg in s._diar_segs} == {"S1"}
```

- [ ] **Step 2: Run failing tests**

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_merge_sweep.py -v 2>&1 | tail -15'
```

Expected: 5 fails with `ImportError: cannot import name 'merge_sweep' from 'cairn_svc.server'`.

- [ ] **Step 3: Implement `merge_sweep`**

In `cairn_svc/server.py`, after the `stitch_labels` function, add:

```python
def merge_sweep(
    session: Session, *, merge_cos: float, merge_min_s: float,
) -> list[tuple[str, str]]:
    """Pairwise-compare every (a, b) of stable_ids whose total observed speech
    is >= merge_min_s. If cos(centroid_a, centroid_b) >= merge_cos, merge the
    younger id (higher numeric suffix) into the older. Returns the list of
    (src, dst) pairs that were merged, in merge order.
    """
    pairs: list[tuple[str, str]] = []

    def _suffix(stable_id: str) -> int:
        try:
            return int(stable_id[1:])
        except ValueError:
            return 0

    while True:
        # Snapshot eligible ids each iteration (a merge can change the set).
        eligible = sorted(
            (sid for sid, (_, t) in session._centroids.items() if t >= merge_min_s),
            key=_suffix,
        )
        merged_this_pass = False
        for i, a in enumerate(eligible):
            if a not in session._centroids:
                continue  # absorbed earlier in this loop iteration
            for b in eligible[i + 1:]:
                if b not in session._centroids:
                    continue
                ca, _ = session._centroids[a]
                cb, _ = session._centroids[b]
                cos = float(np.dot(ca, cb) / (
                    (np.linalg.norm(ca) * np.linalg.norm(cb)) or 1.0
                ))
                if cos >= merge_cos:
                    src = b if _suffix(b) > _suffix(a) else a
                    dst = a if src == b else b
                    session.merge_stable(src=src, dst=dst)
                    pairs.append((src, dst))
                    merged_this_pass = True
                    break  # restart outer loop with refreshed set
            if merged_this_pass:
                break
        if not merged_this_pass:
            break

    return pairs
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_merge_sweep.py -v 2>&1 | tail -10'
```

Expected: 5 passed.

- [ ] **Step 5: Run full suite**

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/ -q 2>&1 | tail -5'
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
ssh node4 'cd ~/cairn-svc && git add cairn_svc/server.py tests/test_merge_sweep.py && git commit -m "feat(svc): merge_sweep collapses converged stable_ids"'
```

---

## Task 9: Add `SpeakerMergeMsg` to protocol

**Files:**
- Test: `~/cairn-svc/tests/test_protocol.py` (extend)
- Modify: `~/cairn-svc/cairn_svc/protocol.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_protocol.py`:

```python
def test_speaker_merge_msg_serializes():
    from cairn_svc.protocol import SpeakerMergeMsg
    m = SpeakerMergeMsg(src="S3", dst="S1")
    assert m.type == "speaker_merge"
    j = m.model_dump_json()
    assert '"type":"speaker_merge"' in j
    assert '"src":"S3"' in j
    assert '"dst":"S1"' in j
```

- [ ] **Step 2: Run failing test**

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_protocol.py::test_speaker_merge_msg_serializes -v 2>&1 | tail -5'
```

Expected: `ImportError: cannot import name 'SpeakerMergeMsg'`.

- [ ] **Step 3: Add the class to `protocol.py`**

After the existing `*Msg` classes (e.g., after `FinalSummaryMsg`):

```python
class SpeakerMergeMsg(BaseModel):
    type: Literal["speaker_merge"] = "speaker_merge"
    src: str  # the id being absorbed (younger; disappears)
    dst: str  # the id absorbing it (older; retained)
```

- [ ] **Step 4: Run test, confirm pass**

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_protocol.py -v 2>&1 | tail -5'
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
ssh node4 'cd ~/cairn-svc && git add cairn_svc/protocol.py tests/test_protocol.py && git commit -m "feat(svc): SpeakerMergeMsg protocol type"'
```

---

## Task 10: Wire `merge_sweep` and centroid updates into `_run_diarization_pass`

**Files:**
- Modify: `~/cairn-svc/cairn_svc/server.py:171-260` (the `_run_diarization_pass` function)

This task threads three things into the existing diar pass:
1. Pass `label_emb` from `diarize_pcm` into `stitch_labels` as `new_label_emb`.
2. After stitching, update centroids for every adopted/minted stable id.
3. After centroid updates, run `merge_sweep` and emit `SpeakerMergeMsg` per pair.

- [ ] **Step 1: Locate the function**

```bash
ssh node4 'cd ~/cairn-svc && grep -n "_run_diarization_pass\|stitch_labels(" cairn_svc/server.py'
```

Expected: function header line + the existing `stitch_labels(...)` call site.

- [ ] **Step 2: Modify the call sequence**

Inside `_run_diarization_pass`, locate the block that looks roughly:

```python
new_segs, label_emb = diarize_pcm(...)  # already updated in Task 3
# ...
label_to_stable = stitch_labels(
    new_segs,
    prev_segs=session._diar_segs,
    session=session,
    overlap_floor_ms=window_start_ms,
    max_stable=num_speakers_hint,    # <-- to be removed
)
```

Replace the `stitch_labels` call with:

```python
label_to_stable = stitch_labels(
    new_segs,
    prev_segs=session._diar_segs,
    session=session,
    overlap_floor_ms=window_start_ms,
    new_label_emb=label_emb,
)

# --- centroid updates ---
# For each pyannote-local label, sum its in-window speech and update the
# adopted stable id's centroid. Tentative path: paths 1 and 2 are confident;
# path 3 (LOW + short) is tentative. We re-derive which path was taken by
# checking whether the cosine to the adopted centroid clears HIGH, since
# stitch_labels doesn't expose the path. (Acceptable approximation: the
# update is a no-op for newly-minted ids since their centroid is the new e_L.)
label_durations: dict[str, int] = {}
for seg in new_segs:
    label_durations[seg.label] = label_durations.get(seg.label, 0) + (seg.t_end_ms - seg.t_start_ms)

for new_label, stable_id in label_to_stable.items():
    e_L = label_emb.get(new_label)
    if e_L is None:
        continue
    dur_s = label_durations.get(new_label, 0) / 1000.0
    # Tentative if cos < HIGH and t_L below fallback (path 3)
    tentative = False
    existing = session._centroids.get(stable_id)
    if existing is not None:
        cos = float(np.dot(e_L, existing[0]) / (
            (np.linalg.norm(e_L) * np.linalg.norm(existing[0])) or 1.0
        ))
        if cos < CAIRN_DIAR_STITCH_EMB_HIGH and dur_s < CAIRN_DIAR_FALLBACK_T_S:
            tentative = True
    session.update_centroid(stable_id, e_L, dur_s, tentative=tentative)

# --- merge sweep + emit ---
merged_pairs = merge_sweep(
    session,
    merge_cos=CAIRN_DIAR_MERGE_COS,
    merge_min_s=CAIRN_DIAR_MERGE_MIN_S,
)
for src, dst in merged_pairs:
    log.info("merge: %s -> %s", src, dst)
    await _emit_msg(SpeakerMergeMsg(src=src, dst=dst).model_dump())
```

Add the `SpeakerMergeMsg` import at the top of `server.py`:

```python
from .protocol import (
    # ... existing imports ...
    SpeakerMergeMsg,
)
```

`_emit_msg` is defined at `server.py:304` inside `ws_transcribe`, after `_run_diarization_pass` (line 170). Python resolves closure names at call time, not definition time, so the reference inside `_run_diarization_pass` finds `_emit_msg` correctly when the diar task actually runs (after the `StartMsg` handler creates the periodic task). No hoisting needed. `SpeakerMergeMsg` is module-level, imported at the top of `server.py`.

- [ ] **Step 3: Restart service and confirm boot**

```bash
ssh node4 'systemctl --user restart cairn-svc && sleep 4 && systemctl --user is-active cairn-svc && journalctl --user -u cairn-svc -n 12 --no-pager'
```

Expected: `active`. No traceback. May see `WARNING` from pyannote unrelated to our changes.

- [ ] **Step 4: Run unit suite — sanity check**

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/ -q 2>&1 | tail -5'
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
ssh node4 'cd ~/cairn-svc && git add cairn_svc/server.py && git commit -m "feat(svc): wire centroid updates + merge_sweep into diar pass"'
```

---

## Task 11: Remove `num_speakers` plumbing

**Files:**
- Modify: `~/cairn-svc/cairn_svc/protocol.py` (drop `SetNumSpeakersMsg`, drop `num_speakers` field on `StartMsg`, drop dispatch in `parse_control`)
- Modify: `~/cairn-svc/cairn_svc/server.py` (drop `num_speakers_hint` state, drop `SetNumSpeakers` branch, drop the `num_speakers` arg to `diarize_pcm`)

This is a cohesive removal — protocol + server in one commit.

- [ ] **Step 1: Drop `SetNumSpeakersMsg` and `StartMsg.num_speakers`**

In `cairn_svc/protocol.py`:
- Remove the `num_speakers: Optional[int] = None` field from `StartMsg`.
- Remove the `SetNumSpeakersMsg` class entirely.
- Remove the `if t == "set_num_speakers": ...` branch from `parse_control`.

- [ ] **Step 2: Drop server-side state**

In `cairn_svc/server.py` (inside `ws_transcribe`):
- Remove `num_speakers_hint: int | None = None` declaration near the top of the function.
- Remove the `num_speakers_hint = ctrl.num_speakers` line in the `StartMsg` handler.
- Remove the entire `elif isinstance(ctrl, SetNumSpeakersMsg): ...` branch.
- Remove `SetNumSpeakersMsg` from the import block.
- In `_run_diarization_pass`, replace any `ns = num_speakers_hint` / `diarize_pcm(..., num_speakers=ns)` with `diarize_pcm(window_pcm, sample_rate=16000)` — drop the kwarg entirely.

- [ ] **Step 3: Run unit suite — confirm no regression**

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/ -q 2>&1 | tail -5'
```

Expected: all pass. (If `tests/test_protocol.py` had a test for `SetNumSpeakersMsg`, delete that test as part of this task.)

- [ ] **Step 4: Restart service**

```bash
ssh node4 'systemctl --user restart cairn-svc && sleep 3 && systemctl --user is-active cairn-svc && journalctl --user -u cairn-svc -n 6 --no-pager'
```

Expected: `active`, no traceback.

- [ ] **Step 5: Commit**

```bash
ssh node4 'cd ~/cairn-svc && git add cairn_svc/protocol.py cairn_svc/server.py tests/test_protocol.py && git commit -m "feat(svc): remove num_speakers hint plumbing (full auto-detect)"'
```

---

## Task 12: Document new env vars

**Files:**
- Modify: `~/cairn-svc/.env.example`

- [ ] **Step 1: Append the new tunables**

```bash
ssh node4 'cd ~/cairn-svc && cat >> .env.example << "EOF"

# Speaker-detection thresholds (cosine similarity in pyannote embedding space).
# Defaults are conservative — biased toward over-splitting at stitch time
# and letting the merge sweep clean up later. Tune on benchmarks/.
CAIRN_DIAR_STITCH_EMB_HIGH=0.78    # confident embedding-based stitch
CAIRN_DIAR_STITCH_EMB_LOW=0.65     # tentative stitch (only for short utterances)
CAIRN_DIAR_FALLBACK_T_S=3.0        # below this in-window speech, LOW band activates
CAIRN_DIAR_MERGE_COS=0.82          # merge sweep threshold (stricter than HIGH)
CAIRN_DIAR_MERGE_MIN_S=8.0         # min total speech per id to be merge-eligible
EOF
'
```

- [ ] **Step 2: Verify**

```bash
ssh node4 'cd ~/cairn-svc && tail -10 .env.example'
```

- [ ] **Step 3: Commit**

```bash
ssh node4 'cd ~/cairn-svc && git add .env.example && git commit -m "docs(svc): document speaker-detection threshold env vars"'
```

---

## Task 13: Server-side smoke run

**Files:** none

- [ ] **Step 1: Restart service and tail logs while sending a synthetic 30-second audio session**

```bash
ssh node4 'systemctl --user restart cairn-svc && sleep 3 && journalctl --user -u cairn-svc -n 5 --no-pager'
```

Expected: `Application startup complete.`, listening on `0.0.0.0:8300`. No traceback.

- [ ] **Step 2: Confirm import surface from a one-liner**

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -c "
from cairn_svc.server import stitch_labels, merge_sweep
from cairn_svc.protocol import SpeakerMergeMsg
from cairn_svc.session import Session
s = Session(meeting_name=\"x\")
assert hasattr(s, \"_centroids\")
assert hasattr(s, \"update_centroid\")
assert hasattr(s, \"merge_stable\")
print(\"OK\")
"'
```

Expected: `OK`.

No commit (verification only).

---

## Task 14: Client — `ws.ts` add `SpeakerMergeMsg`, drop `setNumSpeakers`

**Files:**
- Modify: `/Users/nickcason/dev/cairn/src/renderer/ws.ts`

- [ ] **Step 1: Edit `ws.ts`**

Replace the file body so it matches:

```typescript
export type TranscriptPartial = { type:"transcript_partial"; seq:number; text:string; t_start_ms:number; t_end_ms:number };
export type TranscriptFinal = { type:"transcript_final"; seq:number; text:string; t_start_ms:number; t_end_ms:number; speaker_id:string };
export type SpeakerAssigned = { type:"speaker_assigned"; speaker_id:string; color_hint:string };
export type SpeakerMerge = { type:"speaker_merge"; src:string; dst:string };
export type Ack = { type:"ack"; of:string; session_id:string };
export type ErrorMsg = { type:"error"; code:string; message:string };
export type RollingSummaryMsg = { type:"rolling_summary"; idx:number; window_start_s:number; window_end_s:number; bullets:string[]; generated_at:number; merged_from_failed_prior:boolean };
export type RollingReplaceMsg = { type:"rolling_summary_replace"; idx:number; bullets:string[]; generated_at:number; reason:string };
export type FinalSummaryMsg = { type:"final_summary"; ok:boolean; [key:string]:unknown };
export type ServerMsg = TranscriptPartial | TranscriptFinal | SpeakerAssigned | SpeakerMerge | Ack | ErrorMsg | RollingSummaryMsg | RollingReplaceMsg | FinalSummaryMsg;

export class CairnWS {
  private ws: WebSocket | null = null;
  constructor(private url: string, private onMsg: (m: ServerMsg) => void, private onStatus: (s:string)=>void) {}
  connect() {
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.binaryType = "arraybuffer";
      this.ws.onopen = () => { this.onStatus("connected"); resolve(); };
      this.ws.onclose = () => this.onStatus("disconnected");
      this.ws.onerror = (e) => { this.onStatus("error"); reject(e); };
      this.ws.onmessage = (e) => {
        if (typeof e.data === "string") {
          try { this.onMsg(JSON.parse(e.data) as ServerMsg); } catch (err) { console.error("bad msg", err); }
        }
      };
    });
  }
  start(meetingName: string) {
    this.send({ type: "start", meeting_name: meetingName, source: "aggregate" });
  }
  stop() { this.send({ type:"stop" }); }
  rename(id: string, name: string, color: string) { this.send({ type:"speaker_rename", speaker_id:id, name, color }); }
  sendAudio(buf: ArrayBuffer) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(buf); }
  private send(o: any) { this.ws?.send(JSON.stringify(o)); }
  close() { this.ws?.close(); }
}
```

(Removed: `setNumSpeakers`, the `numSpeakers` arg on `start()`.)

- [ ] **Step 2: Type-check**

```bash
cd /Users/nickcason/dev/cairn && npx tsc -p tsconfig.renderer.json --noEmit 2>&1 | tail -10
```

Expected: errors at every call site of `setNumSpeakers` and at the `ws.start(meetingName, currentSpeakers)` call. These are fixed in Task 18; ignore for now.

- [ ] **Step 3: Commit**

```bash
cd /Users/nickcason/dev/cairn && git add src/renderer/ws.ts && git commit -m "feat(client): SpeakerMerge type; drop setNumSpeakers from CairnWS"
```

---

## Task 15: Client — `speakers.ts.merge`

**Files:**
- Modify: `/Users/nickcason/dev/cairn/src/renderer/speakers.ts` (after `recolor`)

- [ ] **Step 1: Add the `merge` method**

In `speakers.ts`, inside the `SpeakersPanel` class, after the `recolor` method, add:

```typescript
  /**
   * Absorb srcId's panel entry into dstId. dst keeps its current name and color
   * (dst-wins); src is removed from the panel. No-op if srcId is unknown or if
   * src === dst.
   */
  merge(srcId: string, dstId: string) {
    if (srcId === dstId) return;
    if (!this.speakers.has(srcId)) return;
    // Ensure dst exists; if not, mirror src onto dst before deleting.
    if (!this.speakers.has(dstId)) {
      const src = this.speakers.get(srcId)!;
      this.speakers.set(dstId, { id: dstId, name: src.name, color: src.color });
    }
    this.speakers.delete(srcId);
    this.render();
  }
```

- [ ] **Step 2: Type-check**

```bash
cd /Users/nickcason/dev/cairn && npx tsc -p tsconfig.renderer.json --noEmit 2>&1 | tail -10
```

Expected: no new errors specific to speakers.ts (call-site errors from Task 14 still pending).

- [ ] **Step 3: Commit**

```bash
cd /Users/nickcason/dev/cairn && git add src/renderer/speakers.ts && git commit -m "feat(client): SpeakersPanel.merge(src, dst)"
```

---

## Task 16: Client — `transcript.ts.mergeSpeakers`

**Files:**
- Modify: `/Users/nickcason/dev/cairn/src/renderer/transcript.ts` (next to `applySpeaker`)

- [ ] **Step 1: Add `mergeSpeakers`**

The existing DOM (see `applySpeaker` at `transcript.ts:95`) uses `<span class="spk" data-spk="${id}">…</span>` per row. We mirror that.

After `applySpeaker` in `transcript.ts`, add:

```typescript
  /**
   * Retroactively rewrite every rendered line currently attributed to srcId
   * to dstId. Mirrors the DOM shape used by applySpeaker: each row carries
   * a <span class="spk" data-spk="..."> with background = color+"33" and
   * color = color. Caller (app.ts) resolves dstName/dstColor from the
   * SpeakersPanel before invoking, then calls speakers.merge.
   */
  mergeSpeakers(srcId: string, dstId: string, dstName: string | null, dstColor: string) {
    if (srcId === dstId) return;
    this.el.querySelectorAll<HTMLElement>(`.line .spk[data-spk="${srcId}"]`).forEach((spk) => {
      spk.dataset.spk = dstId;
      spk.style.background = dstColor + "33";
      spk.style.color = dstColor;
      spk.textContent = dstName ?? dstId;
    });
    if (this.lastFinalSpeaker === srcId) {
      this.lastFinalSpeaker = dstId;
    }
  }
```

The `lastFinalSpeaker` rewrite preserves the same-speaker mid-sentence merging behavior (`final()` at `transcript.ts:72-88`) so the very next final after a merge can still chain into the prior line if it was the merged speaker.

- [ ] **Step 2: Type-check**

```bash
cd /Users/nickcason/dev/cairn && npx tsc -p tsconfig.renderer.json --noEmit 2>&1 | tail -10
```

Expected: no new errors specific to transcript.ts.

- [ ] **Step 3: Commit**

```bash
cd /Users/nickcason/dev/cairn && git add src/renderer/transcript.ts && git commit -m "feat(client): TranscriptView.mergeSpeakers DOM rewrite"
```

---

## Task 17: Client — handle `speaker_merge` in `app.ts`

**Files:**
- Modify: `/Users/nickcason/dev/cairn/src/renderer/app.ts:146-175` (`onMsg`)

- [ ] **Step 1: Add the handler branch**

In `onMsg`, after the `final_summary` branch, before `ack`:

```typescript
  } else if (m.type === "speaker_merge") {
    const dstSpeaker = speakers.get(m.dst);
    speakers.merge(m.src, m.dst);
    transcript.mergeSpeakers(m.src, m.dst, dstSpeaker.name, dstSpeaker.color);
```

(Order matters: capture `dst`'s name/color *before* `speakers.merge` mutates the panel.)

- [ ] **Step 2: Type-check**

```bash
cd /Users/nickcason/dev/cairn && npx tsc -p tsconfig.renderer.json --noEmit 2>&1 | tail -10
```

Expected: still errors from Task 14 around the dropdown plumbing. The `speaker_merge` branch should type-check cleanly.

- [ ] **Step 3: Commit**

```bash
cd /Users/nickcason/dev/cairn && git add src/renderer/app.ts && git commit -m "feat(client): handle speaker_merge — relabel transcript + speakers panel"
```

---

## Task 18: Client — drop dropdown plumbing

**Files:**
- Modify: `/Users/nickcason/dev/cairn/src/renderer/app.ts` (multiple sections)
- Modify: `/Users/nickcason/dev/cairn/src/renderer/index.html:16` (the `#speakers-toggle` button)

- [ ] **Step 1: Remove from `index.html`**

Delete the `<button id="speakers-toggle" class="speakers-toggle" title="...">auto</button>` line. The titlebar reflows naturally.

- [ ] **Step 2: Remove from `app.ts`**

Delete every reference to:
- `$speakersToggle` (the const declaration and any `.onclick`/`.textContent` use)
- `currentSpeakers` (state variable)
- `loadSpeakers` / `saveSpeakers` (functions)
- `refreshSpeakerToggleLabel` (function)
- `SPEAKER_VALUES` and `speakerLabel` (cycle helper)
- The toggle's `onclick` handler that cycles values, calls `saveSpeakers`, calls `ws.setNumSpeakers`
- The `currentSpeakers = numSpeakers; refreshSpeakerToggleLabel();` block in benchmark/screenshot mode
- `speakerHint` derivation in `startLiveSession`

Update the `ws.start(meetingName, ...)` call to take only `meetingName`:
```typescript
ws.start(meetingName);
```

The fixture/screenshot path that previously set `currentSpeakers = numSpeakers` was wiring the dropdown's manual hint. With auto-detect there's nothing to wire — drop those lines outright. Benchmark fixtures will auto-detect like any live session; if a fixture later proves to need a deterministic count for assertion purposes, that's a fixture-side change (separate plan), not a renderer change.

- [ ] **Step 3: Type-check, build**

```bash
cd /Users/nickcason/dev/cairn && npx tsc -p tsconfig.renderer.json --noEmit 2>&1 | tail -10 && npm run build 2>&1 | tail -5
```

Expected: zero errors. Build succeeds.

- [ ] **Step 4: Commit**

```bash
cd /Users/nickcason/dev/cairn && git add src/renderer/app.ts src/renderer/index.html && git commit -m "feat(client): remove speaker-count dropdown (full auto-detect)"
```

---

## Task 19: Build, smoke, push

**Files:** none

- [ ] **Step 1: Full build**

```bash
cd /Users/nickcason/dev/cairn && npm run build 2>&1 | tail -5
```

Expected: clean build.

- [ ] **Step 2: Live smoke — start the app, run a 3-minute conversation with deliberate silence gaps**

```bash
cd /Users/nickcason/dev/cairn && open dist-app/Cairn.app 2>/dev/null || npm run start &
```

Manual verification:
1. Start a meeting.
2. Speak for 30 s, pause for 90 s (longer than `DIAR_OVERLAP_S`), resume speaking for 30 s.
3. Confirm: same speaker keeps the same `S1` color/badge across the silence, no new `S2` minted for the same voice.
4. With a second person: speak alternately. Confirm both keep stable ids.
5. If the system briefly mints an `S3` for a returning speaker that later gets recognized, confirm a `speaker_merge` arrives and the past lines re-label in place.
6. Verify the dropdown is gone from the titlebar.

- [ ] **Step 3: Push client commits**

```bash
cd /Users/nickcason/dev/cairn && git push origin main
```

- [ ] **Step 4: Final status check**

```bash
cd /Users/nickcason/dev/cairn && git status && git log --oneline -10
ssh node4 'cd ~/cairn-svc && git log --oneline -10'
```

Expected: clean trees, both repos showing the new commits in order.

---

## Out of scope (deferred)

- Embedding-aware persistence across sessions (cross-meeting voiceprints)
- Manual merge/split UI on the transcript view
- Confidence-aware coloring of pyannote-uncertain segments
- A/B benchmarking harness comparison vs current `main`. Use the existing `benchmarks/` fixtures by hand if a regression is suspected.

