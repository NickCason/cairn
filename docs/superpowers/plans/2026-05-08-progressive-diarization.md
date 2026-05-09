# Progressive (dyadic) authoritative diarization — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a parallel authoritative-diarization loop that runs pyannote on the full session audio at exponentially-spaced ticks, reconciles its output against already-emitted finals, and emits per-line `speaker_relabel` events. Saved transcripts inherit offline-quality attribution; live UI converges over time.

**Architecture:** Two diarization pipelines run independently. Streaming (existing, unchanged) handles live attribution on a 30 s window every 30 s. Authoritative (new) handles full-audio re-diarization on a doubling cadence (30 s, 60 s, 120 s, …, plus on-stop). Each pipeline owns its own centroid state and lock. The single `stable_id` namespace and `Session._ledger` are the only shared state; reconciliation reads the ledger, mutates speaker_ids, and emits per-line corrections.

**Tech Stack:** cairn-svc (Python 3.11, FastAPI/WebSocket, pyannote.audio 3.x, pytest) on `precision-node4` at `~/cairn-svc`. Cairn client (TypeScript, Electron renderer) at `/Users/nickcason/dev/cairn`. Reference spec: `docs/superpowers/specs/2026-05-08-progressive-diarization-design.md`.

**Repository operations:** All cairn-svc tasks run via `ssh node4` (server is local-only, no remote — commit only, no push). Client tasks run locally; commit + push to `origin/main` at the end.

---

## File Structure

### cairn-svc (`~/cairn-svc` on node4)

| File | Change | Responsibility |
|---|---|---|
| `cairn_svc/protocol.py` | MODIFY | Add `SpeakerRelabelMsg` |
| `cairn_svc/session.py` | MODIFY | Add `_auth_centroids` dict + `update_auth_centroid()` |
| `cairn_svc/server.py` | MODIFY | `_authoritative_schedule`, `_map_auth_clusters`, `_reconcile_ledger`, `_run_authoritative_pass`, `run_authoritative_periodically`; wire into ws_transcribe |
| `tests/test_authoritative.py` | NEW | Schedule, mapping, reconciliation unit tests |
| `tests/test_protocol.py` | EXTEND | SpeakerRelabelMsg dump/parse |
| `.env.example` | MODIFY | Document new `CAIRN_AUTH_DIAR_*` env vars |

### Cairn client (this repo)

| File | Change | Responsibility |
|---|---|---|
| `src/renderer/ws.ts` | MODIFY | Add `SpeakerRelabel` to `ServerMsg` union |
| `src/renderer/transcript.ts` | MODIFY (additive) | `relabelLine(seq, dstId, dstName, dstColor)` |
| `src/renderer/app.ts` | MODIFY | Handle `speaker_relabel` in `onMsg` |

---

## Task 1: Add `SpeakerRelabelMsg` to protocol

**Files:**
- Modify: `~/cairn-svc/cairn_svc/protocol.py`
- Modify: `~/cairn-svc/tests/test_protocol.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_protocol.py`:

```python
def test_speaker_relabel_msg_roundtrip():
    from cairn_svc.protocol import SpeakerRelabelMsg
    msg = SpeakerRelabelMsg(seq=42, speaker_id="S3")
    payload = msg.model_dump()
    assert payload == {"type": "speaker_relabel", "seq": 42, "speaker_id": "S3"}
```

- [ ] **Step 2: Run test — expect FAIL with import error**

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_protocol.py::test_speaker_relabel_msg_roundtrip -v 2>&1 | tail -10'
```
Expected: ImportError or AttributeError on `SpeakerRelabelMsg`.

- [ ] **Step 3: Add the class to `cairn_svc/protocol.py`**

Insert after `SpeakerMergeMsg` (existing):

```python
class SpeakerRelabelMsg(BaseModel):
    type: Literal["speaker_relabel"] = "speaker_relabel"
    seq: int
    speaker_id: str
```

- [ ] **Step 4: Run test — expect PASS**

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_protocol.py -q 2>&1 | tail -5'
```
Expected: all protocol tests pass.

- [ ] **Step 5: Commit**

```bash
ssh node4 'cd ~/cairn-svc && git add cairn_svc/protocol.py tests/test_protocol.py && git commit -m "feat(svc): SpeakerRelabelMsg protocol type"'
```

---

## Task 2: `Session._auth_centroids` storage

**Files:**
- Modify: `~/cairn-svc/cairn_svc/session.py`
- Modify: `~/cairn-svc/tests/test_session.py` (or create `tests/test_auth_centroids.py` if simpler)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_session.py`:

```python
def test_auth_centroid_set_and_get():
    import numpy as np
    from cairn_svc.session import Session
    s = Session(meeting_name="t")
    s.mint_stable_id()  # S1
    e = np.array([1.0, 0.0, 0.0], dtype=np.float32)
    e = e / np.linalg.norm(e)
    s.update_auth_centroid("S1", e)
    got = s.get_auth_centroid("S1")
    assert got is not None
    assert np.allclose(got, e)


def test_auth_centroid_unknown_returns_none():
    from cairn_svc.session import Session
    s = Session(meeting_name="t")
    assert s.get_auth_centroid("S99") is None
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_session.py::test_auth_centroid_set_and_get tests/test_session.py::test_auth_centroid_unknown_returns_none -v 2>&1 | tail -10'
```
Expected: AttributeError on `update_auth_centroid` / `get_auth_centroid`.

- [ ] **Step 3: Add the storage to `cairn_svc/session.py`**

In `Session.__init__`, after the existing `self._centroids: dict[str, tuple[np.ndarray, float]] = {}` line, add:

```python
        # Authoritative centroids (separate from streaming centroids).
        # Authoritative pass replaces these on each tick — no EMA, since
        # pyannote already aggregates per-speaker audio over the whole
        # session per pass. See specs/2026-05-08-progressive-diarization-design.md.
        self._auth_centroids: dict[str, np.ndarray] = {}
```

Then add two methods on `Session` (place near `update_centroid`):

```python
    def update_auth_centroid(self, stable_id: str, embedding: np.ndarray) -> None:
        """Replace (not EMA) the authoritative centroid for stable_id."""
        self._auth_centroids[stable_id] = embedding.astype(np.float32, copy=True)

    def get_auth_centroid(self, stable_id: str) -> np.ndarray | None:
        return self._auth_centroids.get(stable_id)
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_session.py -q 2>&1 | tail -5'
```
Expected: all session tests pass.

- [ ] **Step 5: Commit**

```bash
ssh node4 'cd ~/cairn-svc && git add cairn_svc/session.py tests/test_session.py && git commit -m "feat(svc): Session.update_auth_centroid / get_auth_centroid"'
```

---

## Task 3: Dyadic schedule helper

**Files:**
- Modify: `~/cairn-svc/cairn_svc/server.py` (add `_authoritative_schedule`)
- Create: `~/cairn-svc/tests/test_authoritative.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_authoritative.py`:

```python
"""Unit tests for the authoritative-diarization helpers."""
import pytest


def test_schedule_starts_at_first_tick():
    from cairn_svc.server import _authoritative_schedule
    # First tick after session start: respect first_tick_s.
    assert _authoritative_schedule(elapsed_s=0.0, last_tick_s=0.0, first_tick_s=30.0) == 30.0


def test_schedule_doubles_after_first_tick():
    from cairn_svc.server import _authoritative_schedule
    # After firing at 30s, next tick at 60s.
    assert _authoritative_schedule(elapsed_s=30.0, last_tick_s=30.0, first_tick_s=30.0) == 60.0
    # After 60s, next at 120s.
    assert _authoritative_schedule(elapsed_s=60.0, last_tick_s=60.0, first_tick_s=30.0) == 120.0
    # After 120s, next at 240s.
    assert _authoritative_schedule(elapsed_s=120.0, last_tick_s=120.0, first_tick_s=30.0) == 240.0


def test_schedule_respects_first_tick_value():
    from cairn_svc.server import _authoritative_schedule
    assert _authoritative_schedule(0.0, 0.0, first_tick_s=15.0) == 15.0
    assert _authoritative_schedule(15.0, 15.0, first_tick_s=15.0) == 30.0
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_authoritative.py -v 2>&1 | tail -15'
```
Expected: ImportError on `_authoritative_schedule`.

- [ ] **Step 3: Add the helper to `cairn_svc/server.py`**

Place near the top of the module (alongside other module-level helpers, before `stitch_labels`):

```python
def _authoritative_schedule(
    elapsed_s: float, last_tick_s: float, first_tick_s: float
) -> float:
    """Return the absolute session-time (seconds since session start) at which
    the next authoritative-diarization tick should fire.

    Dyadic: first tick at first_tick_s, then doubles. last_tick_s of 0.0 means
    the schedule has not fired yet.
    """
    if last_tick_s <= 0.0:
        return first_tick_s
    return last_tick_s * 2.0
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_authoritative.py -v 2>&1 | tail -10'
```
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
ssh node4 'cd ~/cairn-svc && git add cairn_svc/server.py tests/test_authoritative.py && git commit -m "feat(svc): _authoritative_schedule helper (dyadic)"'
```

---

## Task 4: Map authoritative pyannote-clusters to stable_ids

**Files:**
- Modify: `~/cairn-svc/cairn_svc/server.py` (add `_map_auth_clusters`)
- Modify: `~/cairn-svc/tests/test_authoritative.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_authoritative.py`:

```python
import numpy as np


def _emb(*v):
    a = np.array(v, dtype=np.float32)
    return a / float(np.linalg.norm(a))


def test_map_adopts_existing_authoritative_centroid_above_high():
    from cairn_svc.server import _map_auth_clusters
    from cairn_svc.session import Session
    s = Session(meeting_name="t")
    s.mint_stable_id()  # S1
    s.update_auth_centroid("S1", _emb(1.0, 0.0))
    label_emb = {"SPEAKER_00": _emb(0.99, 0.14)}  # cos ~0.99 to S1
    mapping, newly_minted = _map_auth_clusters(s, label_emb, high_threshold=0.78)
    assert mapping == {"SPEAKER_00": "S1"}
    assert newly_minted == []


def test_map_mints_new_when_below_high():
    from cairn_svc.server import _map_auth_clusters
    from cairn_svc.session import Session
    s = Session(meeting_name="t")
    s.mint_stable_id()  # S1
    s.update_auth_centroid("S1", _emb(1.0, 0.0))
    label_emb = {"SPEAKER_00": _emb(0.0, 1.0)}  # orthogonal to S1
    mapping, newly_minted = _map_auth_clusters(s, label_emb, high_threshold=0.78)
    assert mapping["SPEAKER_00"] == "S2"
    assert newly_minted == ["S2"]


def test_map_handles_collision_winner_keeps_loser_mints():
    from cairn_svc.server import _map_auth_clusters
    from cairn_svc.session import Session
    s = Session(meeting_name="t")
    s.mint_stable_id()  # S1
    s.update_auth_centroid("S1", _emb(1.0, 0.0))
    label_emb = {
        "SPEAKER_00": _emb(0.99, 0.14),  # cos ~0.99 to S1
        "SPEAKER_01": _emb(0.95, 0.30),  # cos ~0.96 to S1, also wants S1
    }
    mapping, newly_minted = _map_auth_clusters(s, label_emb, high_threshold=0.78)
    # Higher cosine wins.
    assert mapping["SPEAKER_00"] == "S1"
    assert mapping["SPEAKER_01"] == "S2"
    assert newly_minted == ["S2"]


def test_map_updates_auth_centroid_for_each_label():
    from cairn_svc.server import _map_auth_clusters
    from cairn_svc.session import Session
    s = Session(meeting_name="t")
    e = _emb(1.0, 0.0)
    label_emb = {"SPEAKER_00": e}
    mapping, _ = _map_auth_clusters(s, label_emb, high_threshold=0.78)
    sid = mapping["SPEAKER_00"]
    got = s.get_auth_centroid(sid)
    assert got is not None
    assert np.allclose(got, e)
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_authoritative.py -v 2>&1 | tail -15'
```
Expected: ImportError on `_map_auth_clusters`.

- [ ] **Step 3: Implement `_map_auth_clusters` in `cairn_svc/server.py`**

Place after `_authoritative_schedule`:

```python
def _map_auth_clusters(
    session: "Session",
    label_emb: dict[str, "np.ndarray"],
    high_threshold: float,
) -> tuple[dict[str, str], list[str]]:
    """Map authoritative pyannote-cluster labels to stable_ids.

    For each label, pick the existing authoritative centroid with highest
    cosine; adopt it if cos >= high_threshold (and no other label already
    claimed it with higher cosine). Otherwise mint a fresh stable_id. The
    chosen stable_id's authoritative centroid is updated to the label's
    embedding.

    Returns (label -> stable_id, list of newly-minted stable_ids).
    """
    # Collect candidates: (label, target_stable_id_or_None, cos_score)
    candidates: list[tuple[str, str | None, float]] = []
    for label, emb in label_emb.items():
        best_sid = None
        best_cos = 0.0
        for sid, centroid in session._auth_centroids.items():
            c = float(_cosine(emb, centroid))
            if c > best_cos:
                best_cos = c
                best_sid = sid
        if best_sid is not None and best_cos >= high_threshold:
            candidates.append((label, best_sid, best_cos))
        else:
            candidates.append((label, None, 0.0))

    # Resolve: highest score wins each stable_id; losers mint fresh.
    mapping: dict[str, str] = {}
    claimed: set[str] = set()
    newly_minted: list[str] = []
    for label, target, _score in sorted(candidates, key=lambda c: c[2], reverse=True):
        if target is not None and target not in claimed:
            mapping[label] = target
            claimed.add(target)
        else:
            new_sid = session.mint_stable_id()
            mapping[label] = new_sid
            newly_minted.append(new_sid)

    # Update auth centroids for every chosen mapping.
    for label, sid in mapping.items():
        session.update_auth_centroid(sid, label_emb[label])

    return mapping, newly_minted
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_authoritative.py -v 2>&1 | tail -12'
```
Expected: 7 passed (3 schedule + 4 mapping).

- [ ] **Step 5: Commit**

```bash
ssh node4 'cd ~/cairn-svc && git add cairn_svc/server.py tests/test_authoritative.py && git commit -m "feat(svc): _map_auth_clusters with collision resolution"'
```

---

## Task 5: Reconcile ledger against authoritative segs

**Files:**
- Modify: `~/cairn-svc/cairn_svc/server.py` (add `_reconcile_ledger`)
- Modify: `~/cairn-svc/tests/test_authoritative.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_authoritative.py`:

```python
def _seg(label, start_ms, end_ms):
    from cairn_svc.diarize import DiarizationSegment
    return DiarizationSegment(label=label, t_start_ms=start_ms, t_end_ms=end_ms)


def test_reconcile_emits_relabel_for_changed_speaker_id():
    from cairn_svc.server import _reconcile_ledger
    from cairn_svc.session import Session
    s = Session(meeting_name="t")
    s.append_final(seq=1, text="hi", speaker_id="S1", t_start=0.0, t_end=2.0)
    s.append_final(seq=2, text="hello", speaker_id="S1", t_start=3.0, t_end=5.0)
    # Authoritative says seq=2 is actually S2.
    auth_segs = [
        _seg("S1", 0, 2_000),
        _seg("S2", 3_000, 5_000),
    ]
    relabels = _reconcile_ledger(s, auth_segs)
    assert relabels == [(2, "S2")]
    assert s._ledger[2]["speaker_id"] == "S2"
    # seq=1 unchanged.
    assert s._ledger[1]["speaker_id"] == "S1"


def test_reconcile_no_changes_returns_empty():
    from cairn_svc.server import _reconcile_ledger
    from cairn_svc.session import Session
    s = Session(meeting_name="t")
    s.append_final(seq=1, text="hi", speaker_id="S1", t_start=0.0, t_end=2.0)
    auth_segs = [_seg("S1", 0, 2_000)]
    assert _reconcile_ledger(s, auth_segs) == []


def test_reconcile_skips_finals_with_no_covering_seg():
    from cairn_svc.server import _reconcile_ledger
    from cairn_svc.session import Session
    s = Session(meeting_name="t")
    s.append_final(seq=1, text="hi", speaker_id="S1", t_start=0.0, t_end=2.0)
    s.append_final(seq=2, text="silence-edge", speaker_id="S1", t_start=10.0, t_end=11.0)
    # auth_segs only cover seq=1 region.
    auth_segs = [_seg("S2", 0, 2_000)]
    relabels = _reconcile_ledger(s, auth_segs)
    # seq=1 disagrees with auth -> relabel; seq=2 has no covering seg -> skip.
    assert relabels == [(1, "S2")]
    assert s._ledger[2]["speaker_id"] == "S1"
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_authoritative.py -v 2>&1 | tail -15'
```
Expected: ImportError on `_reconcile_ledger`.

- [ ] **Step 3: Implement `_reconcile_ledger` in `cairn_svc/server.py`**

Place after `_map_auth_clusters`:

```python
def _reconcile_ledger(
    session: "Session", auth_segs: list["DiarizationSegment"],
) -> list[tuple[int, str]]:
    """Compare each ledger entry against the authoritative segs covering its
    time range. Returns [(seq, new_speaker_id), ...] for entries whose
    authoritative speaker differs from what's in the ledger today; mutates
    the ledger in place so the saved transcript reflects the corrections.

    A ledger entry is considered "covered" by an authoritative seg if the
    overlap between (entry.t_start, entry.t_end) and (seg.t_start, seg.t_end)
    is non-empty. The seg with the largest overlap wins; ties broken by
    earliest start. Entries with no covering seg are left unchanged.
    """
    relabels: list[tuple[int, str]] = []
    for entry in session.ledger_all():
        e_start_ms = int(entry["t_start"] * 1000)
        e_end_ms = int(entry["t_end"] * 1000)
        best_sid: str | None = None
        best_overlap = 0
        best_seg_start = 0
        for seg in auth_segs:
            ov = max(0, min(e_end_ms, seg.t_end_ms) - max(e_start_ms, seg.t_start_ms))
            if ov > best_overlap or (ov == best_overlap and ov > 0 and seg.t_start_ms < best_seg_start):
                best_overlap = ov
                best_sid = seg.label
                best_seg_start = seg.t_start_ms
        if best_sid is None:
            continue
        if entry["speaker_id"] != best_sid:
            relabels.append((entry["seq"], best_sid))
            session.apply_edit(seq=entry["seq"], speaker_id=best_sid)
    return relabels
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_authoritative.py -v 2>&1 | tail -15'
```
Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
ssh node4 'cd ~/cairn-svc && git add cairn_svc/server.py tests/test_authoritative.py && git commit -m "feat(svc): _reconcile_ledger emits per-final relabels"'
```

---

## Task 6: `_run_authoritative_pass` orchestrator

**Files:**
- Modify: `~/cairn-svc/cairn_svc/server.py`

This task wires `diarize_pcm` (existing) → `_map_auth_clusters` → `_reconcile_ledger` → emit messages. Place inside `ws_transcribe` alongside `_run_diarization_pass`.

- [ ] **Step 1: Add new env vars near other CAIRN_DIAR_ definitions**

In the env-var block at the top of `cairn_svc/server.py` (around line 59–63):

```python
CAIRN_AUTH_DIAR_ENABLED = os.getenv("CAIRN_AUTH_DIAR_ENABLED", "true").lower() == "true"
CAIRN_AUTH_DIAR_HIGH = float(os.getenv("CAIRN_AUTH_DIAR_HIGH", "0.78"))
CAIRN_AUTH_DIAR_FIRST_TICK_S = float(os.getenv("CAIRN_AUTH_DIAR_FIRST_TICK_S", "30.0"))
```

- [ ] **Step 2: Add `auth_diar_lock` and `last_auth_tick_s` next to `diar_lock`**

Inside `ws_transcribe`, near existing `diar_lock = asyncio.Lock()`:

```python
        auth_diar_lock = asyncio.Lock()
        last_auth_tick_s = 0.0
```

- [ ] **Step 3: Implement `_run_authoritative_pass(reason)` inside `ws_transcribe`**

Place near `_run_diarization_pass`:

```python
        async def _run_authoritative_pass(reason: str):
            """Run pyannote on the FULL session audio and emit retroactive
            speaker_relabel events for any ledger entries whose speaker
            attribution should change.

            Independent of streaming diarization — owns its own lock and
            centroid registry (Session._auth_centroids).
            """
            nonlocal last_auth_tick_s
            if session is None or not CAIRN_AUTH_DIAR_ENABLED:
                return
            if auth_diar_lock.locked():
                log.info("auth_diar(%s): skip — prior pass still running", reason)
                return
            async with auth_diar_lock:
                buf_s = session.buffer_seconds()
                if buf_s < 3.0:
                    return

                sr = session.sample_rate
                pcm = bytes(session._audio[: int(buf_s * sr) * 2])

                loop = asyncio.get_running_loop()
                t0 = loop.time()
                try:
                    local_segs, label_emb = await loop.run_in_executor(
                        None, lambda: diarize_pcm(pcm, sr)
                    )
                except Exception as e:
                    log.warning("auth_diar(%s) failed: %s", reason, e)
                    return
                runtime_s = loop.time() - t0

                # Map pyannote-local clusters to stable_ids using authoritative centroids.
                mapping, newly_minted = _map_auth_clusters(
                    session, label_emb, high_threshold=CAIRN_AUTH_DIAR_HIGH
                )

                # Build authoritative segs with stable_id labels.
                auth_segs = [
                    DiarizationSegment(
                        label=mapping[s.label],
                        t_start_ms=s.t_start_ms,
                        t_end_ms=s.t_end_ms,
                    )
                    for s in local_segs
                ]

                # Announce any newly-minted authoritative ids to the client.
                for sid in newly_minted:
                    await _emit_msg(SpeakerAssignedMsg(
                        speaker_id=sid, color_hint=session.color_hint_for(sid)
                    ).model_dump())

                # Reconcile the ledger; emit relabels.
                relabels = _reconcile_ledger(session, auth_segs)
                for seq, new_sid in relabels:
                    await _emit_msg(SpeakerRelabelMsg(
                        seq=seq, speaker_id=new_sid
                    ).model_dump())

                last_auth_tick_s = buf_s
                log.info(
                    "auth_diar(%s): buf=%.1fs runtime=%.2fs labels=%d minted=%d relabels=%d",
                    reason, buf_s, runtime_s, len(mapping), len(newly_minted), len(relabels),
                )
```

- [ ] **Step 4: Add `SpeakerRelabelMsg` to imports at top of `server.py`**

In the import block where `SpeakerMergeMsg` is imported, add `SpeakerRelabelMsg`:

```python
from .protocol import (
    ...,
    SpeakerMergeMsg,
    SpeakerRelabelMsg,
    ...,
)
```

- [ ] **Step 5: Verify import surface**

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -c "from cairn_svc.server import _run_authoritative_pass; print(\"unreachable\")" 2>&1 | tail -3'
```

`_run_authoritative_pass` is a closure inside `ws_transcribe`, not module-level — the import will fail. Instead verify the module loads:

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -c "import cairn_svc.server; print(\"ok\")"'
```
Expected: `ok`.

- [ ] **Step 6: Run unit suite — confirm no regression**

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/ -q 2>&1 | tail -5'
```
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
ssh node4 'cd ~/cairn-svc && git add cairn_svc/server.py && git commit -m "feat(svc): _run_authoritative_pass orchestrator"'
```

---

## Task 7: `run_authoritative_periodically` background loop + lifecycle wiring

**Files:**
- Modify: `~/cairn-svc/cairn_svc/server.py`

- [ ] **Step 1: Add `run_authoritative_periodically()` inside `ws_transcribe`**

Place near `run_diarization_periodically`:

```python
        async def run_authoritative_periodically():
            if not CAIRN_AUTH_DIAR_ENABLED or session is None:
                return
            try:
                while True:
                    if session is None:
                        return
                    elapsed = session.buffer_seconds()
                    next_tick = _authoritative_schedule(
                        elapsed_s=elapsed,
                        last_tick_s=last_auth_tick_s,
                        first_tick_s=CAIRN_AUTH_DIAR_FIRST_TICK_S,
                    )
                    sleep_s = max(1.0, next_tick - elapsed)
                    await asyncio.sleep(sleep_s)
                    await _run_authoritative_pass("periodic")
            except asyncio.CancelledError:
                return
```

- [ ] **Step 2: Spawn the task next to `diar_task` / `transcribe_task` / `summary_task`**

Find the line `diar_task = asyncio.create_task(run_diarization_periodically())` (currently around server.py:583/606). Immediately after it:

```python
                    auth_task = asyncio.create_task(run_authoritative_periodically())
```

- [ ] **Step 3: Cancel `auth_task` in the same place where `diar_task` is cancelled**

In the cancellation block (around server.py:590), add:

```python
                    auth_task.cancel()
```

(matching the existing `diar_task.cancel()`).

- [ ] **Step 4: Run a final authoritative pass on stop**

Find the existing on-stop block where `await _run_diarization_pass("stop")` is called (around server.py:601–604). Immediately after it:

```python
                        if CAIRN_AUTH_DIAR_ENABLED:
                            await _run_authoritative_pass("stop")
```

- [ ] **Step 5: Verify module loads, run unit suite**

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -c "import cairn_svc.server; print(\"ok\")" && .venv/bin/python -m pytest tests/ -q 2>&1 | tail -5'
```
Expected: `ok`, all tests pass.

- [ ] **Step 6: Restart service**

```bash
ssh node4 'systemctl --user restart cairn-svc && sleep 3 && systemctl --user is-active cairn-svc && journalctl --user -u cairn-svc -n 6 --no-pager'
```
Expected: `active`, no traceback.

- [ ] **Step 7: Commit**

```bash
ssh node4 'cd ~/cairn-svc && git add cairn_svc/server.py && git commit -m "feat(svc): run_authoritative_periodically + on-stop final pass"'
```

---

## Task 8: Document new env vars

**Files:**
- Modify: `~/cairn-svc/.env.example`

- [ ] **Step 1: Append**

```bash
ssh node4 'cd ~/cairn-svc && cat >> .env.example << "EOF"

# Authoritative (full-audio) diarization. Runs in parallel with the streaming
# pass on a doubling cadence (FIRST_TICK_S, 2x, 4x, ...) plus once on stop;
# emits per-final speaker_relabel events to retroactively correct prior
# streaming attribution. See specs/2026-05-08-progressive-diarization-design.md.
CAIRN_AUTH_DIAR_ENABLED=true
CAIRN_AUTH_DIAR_HIGH=0.78          # cosine threshold to adopt an existing auth centroid
CAIRN_AUTH_DIAR_FIRST_TICK_S=30.0  # first authoritative tick after session start
EOF
'
```

- [ ] **Step 2: Verify**

```bash
ssh node4 'tail -10 ~/cairn-svc/.env.example'
```

- [ ] **Step 3: Commit**

```bash
ssh node4 'cd ~/cairn-svc && git add .env.example && git commit -m "docs(svc): document authoritative-diarization env vars"'
```

---

## Task 9: Server-side smoke run

**Files:** none

- [ ] **Step 1: Restart, verify import surface**

```bash
ssh node4 'systemctl --user restart cairn-svc && sleep 3 && systemctl --user is-active cairn-svc'
```
Expected: `active`.

```bash
ssh node4 'cd ~/cairn-svc && .venv/bin/python -c "
from cairn_svc.server import _authoritative_schedule, _map_auth_clusters, _reconcile_ledger
from cairn_svc.protocol import SpeakerRelabelMsg
from cairn_svc.session import Session
s = Session(meeting_name=\"x\")
assert hasattr(s, \"_auth_centroids\")
assert hasattr(s, \"update_auth_centroid\")
assert hasattr(s, \"get_auth_centroid\")
print(\"OK\")
"'
```
Expected: `OK`.

No commit (verification only).

---

## Task 10: Client — `ws.ts` add `SpeakerRelabel`

**Files:**
- Modify: `/Users/nickcason/dev/cairn/src/renderer/ws.ts`

- [ ] **Step 1: Add the type to the union**

In `ws.ts`, in the existing list of message-type aliases (around line 4 where `SpeakerMerge` is defined), add a sibling line:

```typescript
export type SpeakerRelabel = { type:"speaker_relabel"; seq:number; speaker_id:string };
```

Update the `ServerMsg` union to include it. Final union shape:

```typescript
export type ServerMsg = TranscriptPartial | TranscriptFinal | SpeakerAssigned | SpeakerMerge | SpeakerRelabel | Ack | ErrorMsg | RollingSummaryMsg | RollingReplaceMsg | FinalSummaryMsg;
```

- [ ] **Step 2: Type-check**

```bash
cd /Users/nickcason/dev/cairn && npx tsc -p tsconfig.renderer.json --noEmit 2>&1 | tail -5
```
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/nickcason/dev/cairn && git add src/renderer/ws.ts && git commit -m "feat(client): SpeakerRelabel type in ServerMsg union"
```

---

## Task 11: Client — `transcript.ts.relabelLine`

**Files:**
- Modify: `/Users/nickcason/dev/cairn/src/renderer/transcript.ts`

- [ ] **Step 1: Add the method**

Inside the `TranscriptView` class, after `mergeSpeakers` (around the same area as `applySpeaker`), add:

```typescript
  /**
   * Retroactively rewrite a single line (identified by seq) to a different
   * speaker id. Used by the authoritative-diarization correction flow:
   * server says "actually seq=42 was speaker S2, not S1 as we emitted".
   *
   * dstName/dstColor are resolved by the caller (app.ts) from the
   * SpeakersPanel — same convention as mergeSpeakers.
   */
  relabelLine(seq: number, dstId: string, dstName: string | null, dstColor: string) {
    const row = this.bySeq.get(seq);
    if (!row) return;
    const spk = row.querySelector<HTMLElement>(".spk");
    if (!spk) return;
    const prevId = spk.dataset.spk ?? "";
    spk.dataset.spk = dstId;
    spk.style.background = dstColor + "33";
    spk.style.color = dstColor;
    spk.textContent = dstName ?? dstId;
    if (this.lastFinalSpeaker === prevId) {
      this.lastFinalSpeaker = dstId;
    }
  }
```

- [ ] **Step 2: Type-check**

```bash
cd /Users/nickcason/dev/cairn && npx tsc -p tsconfig.renderer.json --noEmit 2>&1 | tail -5
```
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/nickcason/dev/cairn && git add src/renderer/transcript.ts && git commit -m "feat(client): TranscriptView.relabelLine"
```

---

## Task 12: Client — handle `speaker_relabel` in `app.ts`

**Files:**
- Modify: `/Users/nickcason/dev/cairn/src/renderer/app.ts`

- [ ] **Step 1: Add the branch in `onMsg`**

In the `onMsg` function, immediately after the existing `speaker_merge` branch and before `final_summary` (or before `ack` — whichever is adjacent), add:

```typescript
  } else if (m.type === "speaker_relabel") {
    const dst = speakers.get(m.speaker_id);
    transcript.relabelLine(m.seq, m.speaker_id, dst.name, dst.color);
```

`speakers.get` returns the gray fallback for unknown ids — safe but the panel should already know the id (server emits `speaker_assigned` for any newly-minted authoritative id before the relabel).

- [ ] **Step 2: Type-check + build**

```bash
cd /Users/nickcason/dev/cairn && npx tsc -p tsconfig.renderer.json --noEmit 2>&1 | tail -5 && npm run build 2>&1 | tail -3
```
Expected: zero errors. Build succeeds.

- [ ] **Step 3: Commit**

```bash
cd /Users/nickcason/dev/cairn && git add src/renderer/app.ts && git commit -m "feat(client): handle speaker_relabel — single-row retroactive relabel"
```

---

## Task 13: Build, smoke, push

**Files:** none

- [ ] **Step 1: Re-package the desktop app so the symlinked `/Applications/Cairn.app` picks up the new code**

```bash
cd /Users/nickcason/dev/cairn && npm run package 2>&1 | tail -5
```

- [ ] **Step 2: Manual smoke**

Launch via Spotlight/Dock. Run a 4–5 minute meeting with two speakers. Watch for:
- `speaker_relabel` events firing in the eventsLog of the saved jsonl after the first authoritative tick (at ~30 s)
- Transcript rows visibly re-skinning to the correct color after the first authoritative tick
- Saved jsonl distribution: ≥98% of finals on two stable_ids

- [ ] **Step 3: Inspect the saved transcript**

```bash
LATEST=$(find ~/Documents/Cairn -name "transcript.jsonl" -mmin -10 | head -1) && echo "$LATEST" && grep -oE '"type":"[^"]+"' "$LATEST" | sort | uniq -c && echo --- && grep '"type":"transcript_final"' "$LATEST" | grep -oE '"speaker_id":"[^"]+"' | sort | uniq -c
```
Expected: `speaker_relabel` events present; finals concentrated on 2 stable_ids.

- [ ] **Step 4: Push client commits**

```bash
cd /Users/nickcason/dev/cairn && git push origin main
```

- [ ] **Step 5: Final status check**

```bash
cd /Users/nickcason/dev/cairn && git status && git log --oneline -10
ssh node4 'cd ~/cairn-svc && git log --oneline -10'
```

Expected: clean trees, both repos showing the new commits in plan order.

---

## Out of scope (deferred)

- Switching streaming pipeline to diart (separate, larger plan)
- Per-segment embedding caching to make authoritative passes cheaper than full pyannote re-run
- Cross-session voiceprints
- Manual merge/split UI on the transcript view
- Re-using authoritative centroids to seed the streaming pass for better cold-start
