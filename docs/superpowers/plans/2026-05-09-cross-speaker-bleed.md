# Cross-Speaker Bleed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop cross-speaker bleed by performing word-level speaker splits at auth-pass time (not streaming time), preserve user manual edits via a `user_locked` flag, and add an end-to-end Cairn-recording + Safari-playback test harness with bleed-rate grading against the official Lex/Dario transcript.

**Architecture:** Streaming `_drain_pending` keeps today's per-segment `assign_speaker` (smoothing). Whisper word timestamps are plumbed through `pending_finals` and stored on ledger rows after wrapping with absolute time. At every auth tick (and on stop), `_run_authoritative_pass` calls a new `_split_eligible_rows` helper that walks the ledger and splits any non-user-locked row whose words straddle multiple auth-pass speakers, emitting a new `TranscriptSplitMsg`. The `transcript_edit` handler sets `user_locked=True`; `_reconcile_ledger` and `_split_eligible_rows` both honor it. A localhost HTTP control endpoint in Electron main + a bash orchestration script let the loop run without manual UI clicks; a Python grader scores bleed rate against a static ground-truth fixture.

**Tech Stack:** Python 3.11, pytest, FastAPI WebSockets, pyannote diarization, faster-distil-whisper STT (already returning per-word timestamps), Electron + TypeScript renderer, macOS bash + osascript + Safari, Python 3 stdlib for grader.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `cairn_svc/server.py` | New module-scope `_Run` dataclass + `_split_into_runs(words, diar_segs)` pure helper. New `_split_eligible_rows(session, auth_diar_segs, ws, sent_speakers)` helper that walks ledger and emits splits. `transcribe_recent` produces absolute-time words and pushes 5-tuple `pending_finals`. `_drain_pending` unpacks 5-tuple and stores words on ledger via `session.append_final(words=...)`. `_run_authoritative_pass` calls `_split_eligible_rows` after `_reconcile_ledger`. `transcript_edit` handler sets `user_locked=True`. `_reconcile_ledger` skips `user_locked` rows. |
| `cairn_svc/session.py` | `Session.append_final` accepts `words=None`. Ledger row dict gets `words` and `user_locked` fields. |
| `cairn_svc/protocol.py` | New `SplitRow` and `TranscriptSplitMsg` Pydantic models. `TranscriptSplitMsg` added to `ServerMsg` union. |
| `tests/test_word_split.py` | Unit tests for `_split_into_runs`. |
| `tests/test_drain_pending_words.py` | Integration test that verifies `transcribe_recent → _drain_pending` produces ledger rows with **absolute-time** words from chunk-relative whisper inputs. |
| `tests/test_split_eligible_rows.py` | Unit + integration tests for the auth-pass split helper. |
| `tests/test_user_locked.py` | Tests for `transcript_edit` setting the lock + `_reconcile_ledger` and `_split_eligible_rows` respecting it. |
| `tests/test_session.py` | Extended with `words` and `user_locked` roundtrip tests. |
| `src/renderer/protocol.ts` (or in-renderer types file) | Add `SplitRow` type + `TranscriptSplitMsg` to `ServerMsg` union. |
| `src/renderer/transcript.ts` | New `splitLine(originalSeq: number, rows: SplitRow[])` method. |
| `src/renderer/index.ts` (or wherever the WS dispatch lives) | Route `transcript_split` messages to `view.splitLine(...)`. |
| `src/main.ts` | Open localhost HTTP control listener on `127.0.0.1:8765` (env override `CAIRN_CONTROL_PORT`). IPC roundtrip with renderer for start/stop and live transcript. |
| `src/preload.ts` | Expose `onControlStart`, `onControlStop`, `reportControlState`, `reportTranscript` to the renderer. |
| `scripts/cairn-loop.sh` | Bash orchestration: pkill Safari → curl /control/start → open Safari at YouTube URL → sleep N → curl /control/stop → snapshot transcript → run grader. |
| `scripts/grade-transcript.py` | Python grader: aligns Cairn finals against ground-truth reference by timestamp, reports bleed rate. |
| `scripts/build-reference.py` | One-shot scraper that downloads `https://lexfridman.com/dario-amodei-transcript`, parses speaker turns + timestamps, emits `scripts/fixtures/dario-reference.json`. |
| `scripts/fixtures/dario-reference.json` | Committed ground-truth fixture (covering at least the first 12 minutes from `t=194s`). |

---

## Path conventions used in this plan

- **Service work** is done on `node4` via `ssh node4` and lives at `~/cairn-svc/`. Tests run via `~/cairn-svc/.venv/bin/python -m pytest`.
- **Client work** is done locally in `/Users/nickcason/dev/cairn/`. Build via `npm run build`. The dev bundle is symlinked into `/Applications/Cairn.app` via `npm run install-app`.
- **Restart policy:** the user is stepping away for this run, so restart `cairn-svc` exactly once at deploy time (Task 11). If a service-restart happens earlier (e.g., to verify a code path), call it out in the commit message and confirm the next iteration is uninterrupted.

---

## Task 1: `_split_into_runs` helper + unit tests

**Files:**
- Create: `~/cairn-svc/tests/test_word_split.py` (on node4)
- Modify: `~/cairn-svc/cairn_svc/server.py` (on node4) — add module-scope `_Run` dataclass + `_split_into_runs` helper

- [ ] **Step 1: Write failing tests**

Create `tests/test_word_split.py`:

```python
"""Unit tests for _split_into_runs: word-level speaker grouping."""
from cairn_svc.diarize import DiarizationSegment
from cairn_svc.transcribe import TranscriptWord
from cairn_svc.server import _split_into_runs


def _w(text, t0, t1):
    return TranscriptWord(text=text, t_start_ms=t0, t_end_ms=t1)


def _seg(label, t0, t1):
    return DiarizationSegment(label=label, t_start_ms=t0, t_end_ms=t1)


def test_single_speaker_returns_one_run():
    words = [_w("hello", 0, 200), _w("world", 200, 500), _w("again", 500, 800)]
    diar = [_seg("S1", 0, 1000)]
    runs = _split_into_runs(words, diar)
    assert len(runs) == 1
    assert runs[0].speaker_id == "S1"
    assert runs[0].text == "hello world again"
    assert runs[0].t_start_ms == 0
    assert runs[0].t_end_ms == 800
    assert [w.text for w in runs[0].words] == ["hello", "world", "again"]


def test_speaker_change_mid_segment_returns_two_runs():
    words = [
        _w("compute.", 0, 400),
        _w("Yes.", 500, 700),
        _w("All", 750, 900),
        _w("of", 950, 1050),
        _w("those.", 1100, 1300),
    ]
    diar = [_seg("S2", 0, 450), _seg("S1", 450, 1400)]
    runs = _split_into_runs(words, diar)
    assert [r.speaker_id for r in runs] == ["S2", "S1"]
    assert runs[0].text == "compute."
    assert runs[1].text == "Yes. All of those."
    assert runs[0].t_start_ms == 0
    assert runs[0].t_end_ms == 400
    assert runs[1].t_start_ms == 500
    assert runs[1].t_end_ms == 1300


def test_three_speaker_alternation_returns_three_runs():
    words = [
        _w("hi", 0, 100), _w("there", 150, 300),
        _w("hey", 350, 500),
        _w("yo", 550, 700), _w("dude", 750, 900),
    ]
    diar = [_seg("S1", 0, 350), _seg("S2", 350, 550), _seg("S1", 550, 1000)]
    runs = _split_into_runs(words, diar)
    assert [r.speaker_id for r in runs] == ["S1", "S2", "S1"]
    assert runs[0].text == "hi there"
    assert runs[1].text == "hey"
    assert runs[2].text == "yo dude"


def test_all_words_unknown_returns_none():
    words = [_w("hi", 0, 100), _w("there", 150, 300)]
    diar = [_seg("S1", 5000, 6000)]  # no overlap
    assert _split_into_runs(words, diar) is None


def test_empty_words_returns_none():
    assert _split_into_runs([], [_seg("S1", 0, 1000)]) is None


def test_unknown_word_attributed_to_preceding_neighbor():
    words = [
        _w("a", 0, 100),       # S1
        _w("b", 200, 300),     # S1
        _w("c", 1500, 1600),   # gap
        _w("d", 2000, 2100),   # S1
    ]
    diar = [_seg("S1", 0, 400), _seg("S1", 1900, 2200)]
    runs = _split_into_runs(words, diar)
    assert len(runs) == 1
    assert runs[0].speaker_id == "S1"
    assert runs[0].text == "a b c d"


def test_unknown_word_at_start_attributed_to_following_neighbor():
    words = [
        _w("um", 0, 100),       # gap
        _w("hello", 500, 800),  # S1
    ]
    diar = [_seg("S1", 400, 1000)]
    runs = _split_into_runs(words, diar)
    assert len(runs) == 1
    assert runs[0].speaker_id == "S1"
    assert runs[0].text == "um hello"


def test_run_t_range_uses_first_and_last_word_times():
    words = [
        _w("x", 100, 200),  # S1
        _w("y", 250, 350),  # S2
        _w("z", 400, 500),  # S2
    ]
    diar = [_seg("S1", 0, 230), _seg("S2", 230, 1000)]
    runs = _split_into_runs(words, diar)
    assert runs[0].t_start_ms == 100
    assert runs[0].t_end_ms == 200
    assert runs[1].t_start_ms == 250
    assert runs[1].t_end_ms == 500


def test_text_strip_and_single_space_join():
    words = [
        TranscriptWord(text=" hello", t_start_ms=0, t_end_ms=100),
        TranscriptWord(text=" world ", t_start_ms=100, t_end_ms=200),
    ]
    diar = [_seg("S1", 0, 300)]
    runs = _split_into_runs(words, diar)
    assert runs[0].text == "hello world"


def test_consecutive_same_speaker_across_diar_segs_stays_one_run():
    words = [_w("a", 0, 100), _w("b", 600, 700)]
    diar = [_seg("S1", 0, 200), _seg("S1", 500, 800)]
    runs = _split_into_runs(words, diar)
    assert len(runs) == 1
    assert runs[0].speaker_id == "S1"


def test_run_carries_underlying_words_for_re_split():
    """Each run keeps the underlying TranscriptWord list so a subsequent
    auth tick can re-split on refined diar segs."""
    words = [_w("a", 0, 200), _w("b", 200, 400), _w("c", 400, 600)]
    diar = [_seg("S1", 0, 300), _seg("S2", 300, 700)]
    runs = _split_into_runs(words, diar)
    assert len(runs) == 2
    assert [w.text for w in runs[0].words] == ["a"]
    assert [w.text for w in runs[1].words] == ["b", "c"]
```

- [ ] **Step 2: Verify tests fail**

```
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_word_split.py -v 2>&1 | tail -20'
```
Expected: ImportError on `_split_into_runs`.

- [ ] **Step 3: Implement helper**

Verify whether `from dataclasses import dataclass` is already imported:
```
ssh node4 "grep -n '^from dataclasses' ~/cairn-svc/cairn_svc/server.py"
```
Add the import at the top of `server.py` if absent.

Add the helper at module scope in `cairn_svc/server.py` (place it near other module-level helpers; a good anchor is just after `_orphan_sweep` if it exists, or before `_apply_rename_retro`):

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
    """Group a whisper segment's words into runs of consecutive same-speaker
    words. Returns None if NO word has any overlap with a diar seg (defer
    to next pass — diar hasn't caught up yet) OR if the words list is empty.

    Words with zero overlap to any diar seg ("unknown") are attributed to
    the immediately-preceding known speaker, or the immediately-following
    one if they precede any known word.
    """
    if not words:
        return None

    # Pass 1: best-overlap speaker per word ("" if no overlap).
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

    # Pass 2: fill unknowns with preceding known label, then sweep
    # right-to-left for unknowns that came before the first known.
    filled = list(raw)
    last_known: str = ""
    for i, lbl in enumerate(filled):
        if lbl:
            last_known = lbl
        elif last_known:
            filled[i] = last_known
    next_known: str = ""
    for i in range(len(filled) - 1, -1, -1):
        if filled[i] and not next_known:
            next_known = filled[i]
        if not filled[i] and next_known:
            filled[i] = next_known

    # Pass 3: group consecutive same-label words into runs.
    runs: list[_Run] = []
    cur_label = filled[0]
    cur_words: list = [words[0]]
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

- [ ] **Step 4: Verify tests pass**

```
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_word_split.py -v 2>&1 | tail -25'
```
Expected: 11 passed.

- [ ] **Step 5: Verify the full svc suite still passes**

```
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest -q 2>&1 | tail -5'
```
Expected: pass count ≥ prior (currently 119 per project memory) + 11 new. Sanity-check no unrelated test broke.

- [ ] **Step 6: Commit**

```
ssh node4 'cd ~/cairn-svc && git add cairn_svc/server.py tests/test_word_split.py && git commit -m "feat(svc): _split_into_runs word-level speaker grouping helper"'
```

---

## Task 2: Plumb absolute-time words through `pending_finals` to ledger

**Files:**
- Modify: `~/cairn-svc/cairn_svc/server.py` (on node4) — three sites that consume `pending_finals` plus the `transcribe_recent` site that produces them.
- Modify: `~/cairn-svc/cairn_svc/session.py` (on node4) — `append_final` signature.
- Create: `~/cairn-svc/tests/test_drain_pending_words.py` (on node4).

- [ ] **Step 1: Write the failing integration test**

`_drain_pending` is a closure inside `ws_transcribe`, so we exercise the contract via `Session.append_final` directly — but the regression we're guarding against is at the call site (chunk-relative → absolute time). The test simulates what `transcribe_recent` should do with a chunk-relative whisper word. Create `tests/test_drain_pending_words.py`:

```python
"""Regression test for the chunk-relative → absolute-time word fix.

The failed prior attempt forgot to apply t_offset_ms to whisper word
timestamps; words in chunk N had relative times like 0..500 ms which
mapped into the silence at session start under absolute-time diar segs.
This test asserts the fix.
"""
from cairn_svc.session import Session
from cairn_svc.transcribe import TranscriptWord


def test_session_append_final_accepts_words():
    """append_final accepts a words=... kwarg and stores it on the ledger row."""
    s = Session(meeting_name="t")
    seq = s.next_seq()
    words = [
        TranscriptWord(text="hello", t_start_ms=0, t_end_ms=200),
        TranscriptWord(text="world", t_start_ms=200, t_end_ms=400),
    ]
    s.append_final(seq=seq, text="hello world", speaker_id="S1",
                   t_start=0.0, t_end=0.4, words=words)
    rows = s.ledger_all()
    assert len(rows) == 1
    assert rows[0]["words"] is not None
    assert len(rows[0]["words"]) == 2
    assert rows[0]["words"][0].text == "hello"
    assert rows[0]["words"][0].t_start_ms == 0
    assert rows[0]["words"][1].t_end_ms == 400


def test_session_append_final_words_default_none():
    """words= defaults to None for backward-compat with sites that don't pass it."""
    s = Session(meeting_name="t")
    seq = s.next_seq()
    s.append_final(seq=seq, text="hi", speaker_id="S1",
                   t_start=0.0, t_end=0.1)
    rows = s.ledger_all()
    assert rows[0]["words"] is None


def test_chunk_relative_words_are_made_absolute_at_call_site():
    """Reproduce the call-site contract: whisper words are chunk-relative;
    the producer must add t_offset_ms before storing.

    This test mirrors the wrapping logic transcribe_recent will perform.
    The Session itself doesn't add the offset — callers do.
    """
    chunk_words = [
        TranscriptWord(text="hello", t_start_ms=0, t_end_ms=200),
        TranscriptWord(text="world", t_start_ms=200, t_end_ms=400),
    ]
    t_offset_ms = 12000  # 12 s into the session

    abs_words = [
        TranscriptWord(
            text=w.text,
            t_start_ms=t_offset_ms + w.t_start_ms,
            t_end_ms=t_offset_ms + w.t_end_ms,
        )
        for w in chunk_words
    ]

    s = Session(meeting_name="t")
    seq = s.next_seq()
    s.append_final(seq=seq, text="hello world", speaker_id="S1",
                   t_start=12.0, t_end=12.4, words=abs_words)
    row = s.ledger_all()[0]
    assert row["words"][0].t_start_ms == 12000
    assert row["words"][0].t_end_ms == 12200
    assert row["words"][1].t_start_ms == 12200
    assert row["words"][1].t_end_ms == 12400
```

- [ ] **Step 2: Verify tests fail**

```
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_drain_pending_words.py -v 2>&1 | tail -20'
```
Expected: TypeError on `append_final` not accepting `words=`.

- [ ] **Step 3: Update `Session.append_final` to accept `words`**

Find `append_final` in `cairn_svc/session.py`:
```
ssh node4 "grep -n 'def append_final' ~/cairn-svc/cairn_svc/session.py"
```

The current signature is approximately `append_final(self, seq: int, text: str, speaker_id: str, t_start: float, t_end: float)`. Update it to:

```python
def append_final(
    self,
    seq: int,
    text: str,
    speaker_id: str,
    t_start: float,
    t_end: float,
    words: list | None = None,
) -> None:
    """Append a final transcript row to the ledger.

    `words` is the list of absolute-time TranscriptWord entries from the
    whisper segment that produced this final. Used by auth-pass splitting.
    """
    self._ledger.append({
        "seq": seq,
        "text": text,
        "speaker_id": speaker_id,
        "t_start": t_start,
        "t_end": t_end,
        "words": words,
        "user_locked": False,  # added in Task 3 — placeholder here so the
                                # row dict shape is final from Task 2 onwards
    })
```

(The exact body shape — what the existing `_ledger.append` looks like — must be matched; preserve any other fields the row already has. The `words` and `user_locked` additions are additive.)

- [ ] **Step 4: Verify Session-level tests pass**

```
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_drain_pending_words.py -v 2>&1 | tail -20'
```
Expected: 3 passed.

- [ ] **Step 5: Update the producer in `transcribe_recent`**

Find the append site in `transcribe_recent`:
```
ssh node4 "grep -n 'pending_finals.append' ~/cairn-svc/cairn_svc/server.py"
```

Above the append, build absolute-time words. The current append is approximately:
```python
pending_finals.append((seq, text, t0, t1))
```

Replace with:
```python
abs_words = [
    TranscriptWord(
        text=w.text,
        t_start_ms=t_offset_ms + w.t_start_ms,
        t_end_ms=t_offset_ms + w.t_end_ms,
    )
    for w in s.words
] if s.words else []
pending_finals.append((seq, text, t0, t1, abs_words))
```

Where `s` is the loop variable for the whisper segment in `transcribe_recent` (verify by reading the surrounding lines). Also update the `pending_finals` declaration site:

```
ssh node4 "grep -n 'pending_finals: list' ~/cairn-svc/cairn_svc/server.py"
```

Update the type hint to:
```python
pending_finals: list[tuple[int, str, int, int, list]] = []
# (seq, text, t0_ms, t1_ms, abs_words: list[TranscriptWord])
```

Verify `from cairn_svc.transcribe import TranscriptWord` (or equivalent) is already imported near the top of `server.py`:
```
ssh node4 "grep -n 'TranscriptWord' ~/cairn-svc/cairn_svc/server.py | head"
```
Add the import if missing.

- [ ] **Step 6: Update `_drain_pending` to unpack 5-tuple and persist words**

Find `_drain_pending`:
```
ssh node4 "grep -n 'async def _drain_pending' ~/cairn-svc/cairn_svc/server.py"
```

The current loop body unpacks `for seq, text, t0, t1 in pending_finals:`. Change to:

```python
for pending in pending_finals:
    seq, text, t0, t1, words = pending
    stable = assign_speaker(t0, t1, diar_segs)
    if stable is None:
        still_pending.append(pending)
        continue
    if stable not in sent_speakers:
        sent_speakers.add(stable)
        await ws.send_text(SpeakerAssignedMsg(
            speaker_id=stable, color_hint=session.color_hint_for(stable)
        ).model_dump_json())
    await ws.send_text(TranscriptFinalMsg(
        seq=seq, text=text, t_start_ms=t0, t_end_ms=t1, speaker_id=stable
    ).model_dump_json())
    session.append_final(
        seq=seq, text=text, speaker_id=stable,
        t_start=t0 / 1000.0, t_end=t1 / 1000.0,
        words=words,
    )
```

Note: the streaming-time behavior is **unchanged in shape** — `assign_speaker` per pending, one final per pending. Only the data flowing into the ledger gains `words`.

- [ ] **Step 7: Update the stop-branch unpack site**

Find the stop-branch flush:
```
ssh node4 "grep -n 'for seq, text, t0, t1 in pending_finals' ~/cairn-svc/cairn_svc/server.py"
```

Change the unpack to pass `words=` through. The current body is approximately:
```python
for seq, text, t0, t1 in pending_finals:
    await ws.send_text(TranscriptFinalMsg(
        seq=seq, text=text, t_start_ms=t0, t_end_ms=t1, speaker_id="S?"
    ).model_dump_json())
    session.append_final(
        seq=seq, text=text, speaker_id="S?",
        t_start=t0 / 1000.0, t_end=t1 / 1000.0,
    )
```

Change to:
```python
for seq, text, t0, t1, words in pending_finals:
    await ws.send_text(TranscriptFinalMsg(
        seq=seq, text=text, t_start_ms=t0, t_end_ms=t1, speaker_id="S?"
    ).model_dump_json())
    session.append_final(
        seq=seq, text=text, speaker_id="S?",
        t_start=t0 / 1000.0, t_end=t1 / 1000.0,
        words=words,
    )
```

- [ ] **Step 8: Run full svc test suite**

```
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest -q 2>&1 | tail -5'
```
Expected: all tests pass. New count = prior + 3 (Task 2) + previously-added 11 (Task 1).

If anything in the existing suite fails, it's likely a test that constructs `pending_finals` tuples directly. Update those tests to the 5-tuple shape; the simplest change is appending `, []` for the `words` slot.

- [ ] **Step 9: Commit**

```
ssh node4 'cd ~/cairn-svc && git add cairn_svc/server.py cairn_svc/session.py tests/test_drain_pending_words.py && git commit -m "feat(svc): plumb absolute-time whisper words through pending_finals to ledger"'
```

---

## Task 3: `user_locked` field on ledger rows + persistence

**Files:**
- Modify: `~/cairn-svc/cairn_svc/session.py`
- Modify: `~/cairn-svc/tests/test_session.py`

The Session ledger is in-memory; the user_locked field lives there for the lifetime of the session and is consulted by `_reconcile_ledger` (Task 4) and `_split_eligible_rows` (Task 6). No serialization code changes — Session doesn't persist itself.

- [ ] **Step 1: Write failing tests**

Append to `tests/test_session.py`:

```python
def test_append_final_default_user_locked_false():
    s = Session(meeting_name="t")
    seq = s.next_seq()
    s.append_final(seq=seq, text="hi", speaker_id="S1",
                   t_start=0.0, t_end=0.1)
    assert s.ledger_all()[0]["user_locked"] is False


def test_set_user_locked_marks_row():
    """Session has a helper for marking a row user_locked. Used by the
    transcript_edit handler."""
    s = Session(meeting_name="t")
    seq = s.next_seq()
    s.append_final(seq=seq, text="hi", speaker_id="S1",
                   t_start=0.0, t_end=0.1)
    s.mark_user_locked(seq)
    assert s.ledger_all()[0]["user_locked"] is True


def test_mark_user_locked_unknown_seq_is_noop():
    """Marking a non-existent seq must not raise."""
    s = Session(meeting_name="t")
    s.mark_user_locked(9999)  # no error
```

- [ ] **Step 2: Verify tests fail**

```
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_session.py -v -k "user_locked" 2>&1 | tail -15'
```
Expected: AttributeError on `mark_user_locked`.

- [ ] **Step 3: Implement `mark_user_locked` and ensure `user_locked` defaults to False**

Find `Session` class in `cairn_svc/session.py`. The `user_locked` field default was added in Task 2 step 3 (the placeholder note); confirm it's present in the row dict that `append_final` builds. Verify:

```
ssh node4 "grep -n 'user_locked' ~/cairn-svc/cairn_svc/session.py"
```

If `user_locked: False` is already in the `append_final` body (from Task 2), good. If not, add it.

Add the `mark_user_locked` method to the Session class:

```python
def mark_user_locked(self, seq: int) -> None:
    """Mark a ledger row as user-locked. _reconcile_ledger and the
    auth-pass split helper skip user-locked rows so manual user retags
    survive auth-pass corrections.

    A no-op if the seq is not in the ledger.
    """
    for row in self._ledger:
        if row.get("seq") == seq:
            row["user_locked"] = True
            return
```

- [ ] **Step 4: Verify tests pass**

```
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_session.py -v 2>&1 | tail -15'
```
Expected: all passing including the 3 new tests.

- [ ] **Step 5: Commit**

```
ssh node4 'cd ~/cairn-svc && git add cairn_svc/session.py tests/test_session.py && git commit -m "feat(svc): user_locked flag + mark_user_locked on Session ledger"'
```

---

## Task 4: `transcript_edit` sets `user_locked` + `_reconcile_ledger` respects it

**Files:**
- Modify: `~/cairn-svc/cairn_svc/server.py` (the `transcript_edit` handler + `_reconcile_ledger`).
- Create: `~/cairn-svc/tests/test_user_locked.py`.

- [ ] **Step 1: Write failing tests**

Create `tests/test_user_locked.py`:

```python
"""Tests for the user_locked flag's effect on _reconcile_ledger.

_reconcile_ledger is module-level (not a closure), but it operates on
session state. We exercise it directly with a hand-built Session.
"""
from cairn_svc.diarize import DiarizationSegment
from cairn_svc.session import Session
from cairn_svc.server import _reconcile_ledger


def _seg(label, t0, t1):
    return DiarizationSegment(label=label, t_start_ms=t0, t_end_ms=t1)


def test_reconcile_skips_user_locked_row():
    """A row marked user_locked must NOT be relabeled by _reconcile_ledger
    even if the auth-pass diar disagrees with its current speaker_id."""
    s = Session(meeting_name="t")
    seq = s.next_seq()
    s.append_final(seq=seq, text="hello", speaker_id="S1",
                   t_start=0.0, t_end=1.0)
    s.mark_user_locked(seq)

    # Auth pass says this audio is actually S2.
    auth_segs = [_seg("S2", 0, 1000)]
    relabels = _reconcile_ledger(s, auth_segs)

    assert relabels == []   # no relabel emitted
    assert s.ledger_all()[0]["speaker_id"] == "S1"  # speaker unchanged


def test_reconcile_relabels_unlocked_row():
    """Sanity check: same scenario but unlocked → relabel happens as today."""
    s = Session(meeting_name="t")
    seq = s.next_seq()
    s.append_final(seq=seq, text="hello", speaker_id="S1",
                   t_start=0.0, t_end=1.0)
    auth_segs = [_seg("S2", 0, 1000)]
    relabels = _reconcile_ledger(s, auth_segs)
    assert len(relabels) == 1
    assert relabels[0]["seq"] == seq
    assert relabels[0]["speaker_id"] == "S2"
    assert s.ledger_all()[0]["speaker_id"] == "S2"
```

(NOTE: `_reconcile_ledger`'s exact signature and return shape may differ from what's assumed above. Inspect first:
```
ssh node4 "grep -n 'def _reconcile_ledger' ~/cairn-svc/cairn_svc/server.py"
ssh node4 "grep -n 'speaker_relabel' ~/cairn-svc/cairn_svc/server.py | head -10"
```
If `_reconcile_ledger` takes more args (e.g. a callback or ws), or if its return shape differs, adapt the test. The contract being asserted is: locked rows are skipped, unlocked rows are processed as today.)

- [ ] **Step 2: Verify tests fail**

```
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_user_locked.py -v 2>&1 | tail -15'
```
Expected: failures showing _reconcile_ledger does not currently honor user_locked.

- [ ] **Step 3: Update `_reconcile_ledger` to skip user-locked rows**

Find the row iteration inside `_reconcile_ledger`:
```
ssh node4 "grep -n 'def _reconcile_ledger' ~/cairn-svc/cairn_svc/server.py"
```

Read ~30 lines to find the per-row loop. Add a guard at the top:

```python
for row in session._ledger:
    if row.get("user_locked"):
        continue
    # ... existing logic ...
```

The exact placement depends on the function structure; the principle is that the user_locked check is the first thing inside the per-row loop.

- [ ] **Step 4: Update `transcript_edit` handler to set the lock**

Find the handler:
```
ssh node4 "grep -n 'transcript_edit' ~/cairn-svc/cairn_svc/server.py"
```

Locate the branch that processes a `TranscriptEdit` message (or whatever the type is named — verify in `cairn_svc/protocol.py`). After the current code that mutates the ledger row's `speaker_id`, add:

```python
session.mark_user_locked(target_seq)  # use whatever variable name the handler uses for the row's seq
```

Verify that the lock is set AFTER the speaker_id change so a downstream `_reconcile_ledger` running on this row will see the new speaker AND the lock.

- [ ] **Step 5: Add a third test for the transcript_edit handler path**

Append to `tests/test_user_locked.py`:

```python
def test_transcript_edit_handler_sets_user_locked():
    """When the user retags a row via transcript_edit, the row becomes
    user-locked so subsequent auth passes don't overwrite it."""
    # This test mimics the work the transcript_edit branch does; if the
    # branch is too tangled to import directly, this is a contract test
    # for the helper sequence (mutate speaker_id, then mark_user_locked).
    s = Session(meeting_name="t")
    seq = s.next_seq()
    s.append_final(seq=seq, text="hello", speaker_id="S1",
                   t_start=0.0, t_end=1.0)

    # Simulated handler logic:
    for row in s._ledger:
        if row["seq"] == seq:
            row["speaker_id"] = "S2"
            break
    s.mark_user_locked(seq)

    assert s.ledger_all()[0]["speaker_id"] == "S2"
    assert s.ledger_all()[0]["user_locked"] is True
```

- [ ] **Step 6: Run tests**

```
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_user_locked.py -v 2>&1 | tail -15'
```
Expected: 3 passed.

- [ ] **Step 7: Run full suite**

```
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest -q 2>&1 | tail -5'
```
Expected: all pass.

- [ ] **Step 8: Commit**

```
ssh node4 'cd ~/cairn-svc && git add cairn_svc/server.py tests/test_user_locked.py && git commit -m "feat(svc): user_locked respected in _reconcile_ledger; transcript_edit sets lock"'
```

---

## Task 5: `TranscriptSplitMsg` protocol model

**Files:**
- Modify: `~/cairn-svc/cairn_svc/protocol.py`
- Modify: `~/cairn-svc/tests/test_protocol.py` (or add new file if it doesn't exist)

- [ ] **Step 1: Write failing test**

Check whether `tests/test_protocol.py` exists:
```
ssh node4 "ls ~/cairn-svc/tests/test_protocol.py 2>&1 || echo NOT_FOUND"
```

If not found, create it. Append (or create) `tests/test_protocol.py`:

```python
"""Tests for protocol Pydantic models."""
import json

from cairn_svc.protocol import TranscriptSplitMsg, SplitRow


def test_transcript_split_msg_serializes():
    msg = TranscriptSplitMsg(
        original_seq=64,
        rows=[
            SplitRow(seq=64, text="compute.", speaker_id="S2",
                     t_start_ms=0, t_end_ms=400),
            SplitRow(seq=79, text="Yes. All of those.", speaker_id="S1",
                     t_start_ms=500, t_end_ms=1300),
        ],
    )
    payload = json.loads(msg.model_dump_json())
    assert payload["type"] == "transcript_split"
    assert payload["original_seq"] == 64
    assert len(payload["rows"]) == 2
    assert payload["rows"][0]["seq"] == 64
    assert payload["rows"][0]["speaker_id"] == "S2"
    assert payload["rows"][1]["seq"] == 79
    assert payload["rows"][1]["text"] == "Yes. All of those."


def test_transcript_split_msg_in_server_msg_union_parses():
    """Confirm TranscriptSplitMsg is in the ServerMsg union."""
    from cairn_svc.protocol import ServerMsg  # exists today as a Union

    raw = {
        "type": "transcript_split",
        "original_seq": 5,
        "rows": [
            {"seq": 5, "text": "a", "speaker_id": "S1",
             "t_start_ms": 0, "t_end_ms": 100},
            {"seq": 6, "text": "b", "speaker_id": "S2",
             "t_start_ms": 100, "t_end_ms": 200},
        ],
    }
    # The ServerMsg union should be discriminated by `type` and parse this
    # into TranscriptSplitMsg. Pydantic's TypeAdapter is the canonical way.
    from pydantic import TypeAdapter
    parsed = TypeAdapter(ServerMsg).validate_python(raw)
    assert isinstance(parsed, TranscriptSplitMsg)
```

- [ ] **Step 2: Verify tests fail**

```
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_protocol.py -v 2>&1 | tail -15'
```
Expected: ImportError on `TranscriptSplitMsg` and `SplitRow`.

- [ ] **Step 3: Add the Pydantic models**

Open `cairn_svc/protocol.py`. Find the existing `TranscriptFinalMsg` / `SpeakerRelabelMsg` etc. for style. Add:

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

Find the `ServerMsg` union (or `Annotated[Union[...], Field(discriminator="type")]` declaration):
```
ssh node4 "grep -n 'ServerMsg' ~/cairn-svc/cairn_svc/protocol.py"
```

Add `TranscriptSplitMsg` to the union members.

- [ ] **Step 4: Verify tests pass**

```
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_protocol.py -v 2>&1 | tail -10'
```
Expected: 2 passed (or all the pre-existing ones plus 2).

- [ ] **Step 5: Commit**

```
ssh node4 'cd ~/cairn-svc && git add cairn_svc/protocol.py tests/test_protocol.py && git commit -m "feat(svc): TranscriptSplitMsg + SplitRow protocol models"'
```

---

## Task 6: `_split_eligible_rows` helper + wire into `_run_authoritative_pass`

**Files:**
- Modify: `~/cairn-svc/cairn_svc/server.py`
- Create: `~/cairn-svc/tests/test_split_eligible_rows.py`

- [ ] **Step 1: Write failing tests**

Create `tests/test_split_eligible_rows.py`:

```python
"""Tests for _split_eligible_rows: walks the ledger, splits non-locked
rows whose words straddle multiple auth-pass speakers, returns the list
of TranscriptSplitMsg payloads (or equivalent dicts) for the caller to
emit on the WS.
"""
from cairn_svc.diarize import DiarizationSegment
from cairn_svc.session import Session
from cairn_svc.transcribe import TranscriptWord
from cairn_svc.server import _split_eligible_rows


def _w(text, t0, t1):
    return TranscriptWord(text=text, t_start_ms=t0, t_end_ms=t1)


def _seg(label, t0, t1):
    return DiarizationSegment(label=label, t_start_ms=t0, t_end_ms=t1)


def test_single_speaker_row_no_split():
    s = Session(meeting_name="t")
    seq = s.next_seq()
    words = [_w("hello", 0, 200), _w("world", 200, 500)]
    s.append_final(seq=seq, text="hello world", speaker_id="S1",
                   t_start=0.0, t_end=0.5, words=words)
    auth_segs = [_seg("S1", 0, 600)]

    splits = _split_eligible_rows(s, auth_segs)
    assert splits == []
    assert len(s.ledger_all()) == 1


def test_two_speaker_row_splits_into_two_rows():
    s = Session(meeting_name="t")
    seq = s.next_seq()
    words = [
        _w("compute.", 0, 400),
        _w("Yes.", 500, 700),
        _w("All", 750, 900),
        _w("of", 950, 1050),
        _w("those.", 1100, 1300),
    ]
    s.append_final(seq=seq, text="compute. Yes. All of those.",
                   speaker_id="S1",
                   t_start=0.0, t_end=1.3, words=words)
    auth_segs = [_seg("S2", 0, 450), _seg("S1", 450, 1400)]

    splits = _split_eligible_rows(s, auth_segs)
    assert len(splits) == 1
    sp = splits[0]
    assert sp["original_seq"] == seq
    assert len(sp["rows"]) == 2
    assert sp["rows"][0]["seq"] == seq
    assert sp["rows"][0]["speaker_id"] == "S2"
    assert sp["rows"][0]["text"] == "compute."
    assert sp["rows"][1]["seq"] != seq
    assert sp["rows"][1]["speaker_id"] == "S1"
    assert sp["rows"][1]["text"] == "Yes. All of those."

    # Ledger has been rewritten: 2 rows, in seq order.
    rows = s.ledger_all()
    assert len(rows) == 2
    assert rows[0]["seq"] == seq
    assert rows[0]["speaker_id"] == "S2"
    assert rows[0]["text"] == "compute."
    assert rows[1]["speaker_id"] == "S1"
    assert rows[1]["text"] == "Yes. All of those."


def test_user_locked_row_not_split():
    s = Session(meeting_name="t")
    seq = s.next_seq()
    words = [
        _w("compute.", 0, 400),
        _w("Yes.", 500, 700),
    ]
    s.append_final(seq=seq, text="compute. Yes.", speaker_id="S1",
                   t_start=0.0, t_end=0.7, words=words)
    s.mark_user_locked(seq)
    auth_segs = [_seg("S2", 0, 450), _seg("S1", 450, 800)]

    splits = _split_eligible_rows(s, auth_segs)
    assert splits == []
    assert len(s.ledger_all()) == 1
    assert s.ledger_all()[0]["speaker_id"] == "S1"  # unchanged


def test_row_with_no_words_skipped():
    s = Session(meeting_name="t")
    seq = s.next_seq()
    s.append_final(seq=seq, text="hi", speaker_id="S1",
                   t_start=0.0, t_end=0.1, words=None)
    auth_segs = [_seg("S2", 0, 200)]
    splits = _split_eligible_rows(s, auth_segs)
    assert splits == []


def test_row_with_all_unknown_words_not_split():
    """Auth diar doesn't cover this span yet — leave the row alone."""
    s = Session(meeting_name="t")
    seq = s.next_seq()
    words = [_w("a", 0, 100), _w("b", 100, 200)]
    s.append_final(seq=seq, text="a b", speaker_id="S1",
                   t_start=0.0, t_end=0.2, words=words)
    auth_segs = [_seg("S2", 5000, 6000)]
    splits = _split_eligible_rows(s, auth_segs)
    assert splits == []


def test_idempotent_re_split_no_op():
    """Running _split_eligible_rows twice with the same auth_segs yields
    no additional splits the second time."""
    s = Session(meeting_name="t")
    seq = s.next_seq()
    words = [
        _w("compute.", 0, 400),
        _w("Yes.", 500, 700),
    ]
    s.append_final(seq=seq, text="compute. Yes.", speaker_id="S1",
                   t_start=0.0, t_end=0.7, words=words)
    auth_segs = [_seg("S2", 0, 450), _seg("S1", 450, 800)]

    first = _split_eligible_rows(s, auth_segs)
    assert len(first) == 1

    second = _split_eligible_rows(s, auth_segs)
    assert second == []
    assert len(s.ledger_all()) == 2
```

- [ ] **Step 2: Verify tests fail**

```
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_split_eligible_rows.py -v 2>&1 | tail -20'
```
Expected: ImportError on `_split_eligible_rows`.

- [ ] **Step 3: Implement `_split_eligible_rows` at module scope in `cairn_svc/server.py`**

Add near `_split_into_runs`:

```python
def _split_eligible_rows(
    session: "Session",
    auth_diar_segs: list[DiarizationSegment],
) -> list[dict]:
    """Walk the ledger and split any non-user-locked row whose words
    straddle multiple auth-pass speakers.

    Returns a list of dicts, one per split, each shaped like:
        {"original_seq": int, "rows": [
            {"seq": int, "text": str, "speaker_id": str,
             "t_start_ms": int, "t_end_ms": int}, ...
        ], "new_speakers": [str, ...]}

    The caller is responsible for emitting SpeakerAssignedMsg for any
    speaker in `new_speakers` that hasn't been sent yet, then a
    TranscriptSplitMsg for each split.

    The ledger is rewritten in place: the original row is replaced with
    runs[0]'s fields; runs[1:] are appended to the ledger. Ordering by
    t_start is preserved relative to the original row's position; new
    rows are inserted directly after the original.
    """
    splits: list[dict] = []
    # Iterate by index because we may insert new rows mid-iteration.
    i = 0
    while i < len(session._ledger):
        row = session._ledger[i]
        if row.get("user_locked"):
            i += 1
            continue
        words = row.get("words")
        if not words:
            i += 1
            continue
        runs = _split_into_runs(words, auth_diar_segs)
        if runs is None or len(runs) <= 1:
            i += 1
            continue

        original_seq = row["seq"]

        # Rewrite row in place with runs[0]'s fields.
        row["text"] = runs[0].text
        row["speaker_id"] = runs[0].speaker_id
        row["t_start"] = runs[0].t_start_ms / 1000.0
        row["t_end"] = runs[0].t_end_ms / 1000.0
        row["words"] = runs[0].words

        # Append subsequent runs as new rows just after `i`.
        new_rows_payload: list[dict] = [{
            "seq": original_seq,
            "text": runs[0].text,
            "speaker_id": runs[0].speaker_id,
            "t_start_ms": runs[0].t_start_ms,
            "t_end_ms": runs[0].t_end_ms,
        }]
        for k, run in enumerate(runs[1:], start=1):
            new_seq = session.next_seq()
            new_row = {
                "seq": new_seq,
                "text": run.text,
                "speaker_id": run.speaker_id,
                "t_start": run.t_start_ms / 1000.0,
                "t_end": run.t_end_ms / 1000.0,
                "words": run.words,
                "user_locked": False,
            }
            session._ledger.insert(i + k, new_row)
            new_rows_payload.append({
                "seq": new_seq,
                "text": run.text,
                "speaker_id": run.speaker_id,
                "t_start_ms": run.t_start_ms,
                "t_end_ms": run.t_end_ms,
            })

        splits.append({
            "original_seq": original_seq,
            "rows": new_rows_payload,
            "new_speakers": [r.speaker_id for r in runs],
        })

        # Skip past the rows we just inserted.
        i += len(runs)

    return splits
```

(Note on quote-string `"Session"` — if `Session` is imported at the top of `server.py`, drop the quotes; if it's a circular import, keep them.)

- [ ] **Step 4: Verify Step 1 tests pass**

```
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_split_eligible_rows.py -v 2>&1 | tail -25'
```
Expected: 6 passed.

- [ ] **Step 5: Wire `_split_eligible_rows` into `_run_authoritative_pass`**

Find `_run_authoritative_pass` and locate the call to `_reconcile_ledger`:
```
ssh node4 "grep -n '_reconcile_ledger\|_run_authoritative_pass' ~/cairn-svc/cairn_svc/server.py | head -20"
```

Identify the exact variable holding the auth-pass diar segs (likely `auth_segs`, `auth_diar_segs`, or stored on `session._auth_diar_segs`). Read 30 lines around `_reconcile_ledger` to confirm. Immediately AFTER `_reconcile_ledger` is invoked, add:

```python
splits = _split_eligible_rows(session, <auth_segs_var>)
for sp in splits:
    for sid in sp["new_speakers"]:
        if sid not in sent_speakers:
            sent_speakers.add(sid)
            await ws.send_text(SpeakerAssignedMsg(
                speaker_id=sid, color_hint=session.color_hint_for(sid)
            ).model_dump_json())
    await ws.send_text(TranscriptSplitMsg(
        original_seq=sp["original_seq"],
        rows=[SplitRow(**r) for r in sp["rows"]],
    ).model_dump_json())
```

(`sent_speakers` is the set declared in `ws_transcribe`; `_run_authoritative_pass` must already have access to it. If not, the easiest fix is to pass `sent_speakers` and `ws` as parameters. Check the existing closure signature first; the other auth-pass emissions like `speaker_relabel` already need `ws` access, so the wiring should already exist.)

Add the import at the top of `server.py` if missing:
```python
from cairn_svc.protocol import TranscriptSplitMsg, SplitRow
```

- [ ] **Step 6: Run full svc suite**

```
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest -q 2>&1 | tail -5'
```
Expected: all pass.

- [ ] **Step 7: Commit**

```
ssh node4 'cd ~/cairn-svc && git add cairn_svc/server.py tests/test_split_eligible_rows.py && git commit -m "feat(svc): _split_eligible_rows runs at auth-pass time + emits transcript_split"'
```

---

## Task 7: Client `splitLine` + dispatch wiring

**Files:**
- Modify: client renderer protocol types (location depends on existing organization — verify with `grep`).
- Modify: `src/renderer/transcript.ts`.
- Modify: the renderer's WS message dispatch site (likely `src/renderer/index.ts` or `src/renderer/ws.ts` or similar).

- [ ] **Step 1: Locate the protocol type file and dispatch site**

```
grep -RIn "transcript_final" /Users/nickcason/dev/cairn/src/renderer/ | head -20
grep -RIn "speaker_relabel" /Users/nickcason/dev/cairn/src/renderer/ | head -10
```

`speaker_relabel` is the closest analog to what we're adding — find where it's parsed and where `view.relabelLine(...)` is called. That's the dispatch site.

- [ ] **Step 2: Add `SplitRow` + `TranscriptSplitMsg` types**

In whichever file holds the renderer's `ServerMsg` union (likely a `protocol.ts`-style file or inline near the dispatch), add:

```ts
export interface SplitRow {
  seq: number;
  text: string;
  speaker_id: string;
  t_start_ms: number;
  t_end_ms: number;
}

export interface TranscriptSplitMsg {
  type: "transcript_split";
  original_seq: number;
  rows: SplitRow[];
}
```

Add `TranscriptSplitMsg` to the `ServerMsg` discriminated union next to `SpeakerRelabelMsg`.

- [ ] **Step 3: Implement `splitLine` on `TranscriptView`**

In `src/renderer/transcript.ts`, find the existing `relabelLine(seq, speakerId)` method (it was added in commit `cee1b87` per the git log). Add a new method modeled on it:

```ts
splitLine(originalSeq: number, rows: SplitRow[]): void {
  if (rows.length === 0) return;

  // Mutate the existing row to reflect rows[0].
  const first = rows[0];
  this.relabelLine(originalSeq, first.speaker_id);
  this.updateLineText(originalSeq, first.text, first.t_start_ms, first.t_end_ms);

  // Insert rows[1:] as new rows directly after originalSeq.
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    this.appendFinalAfter(originalSeq, {
      seq: r.seq,
      text: r.text,
      speaker_id: r.speaker_id,
      t_start_ms: r.t_start_ms,
      t_end_ms: r.t_end_ms,
    });
  }
}
```

This depends on two helpers that may need to exist on `TranscriptView`:

- `updateLineText(seq, text, t_start_ms, t_end_ms)` — replace the rendered text/timestamps for a given seq's row in place. If no equivalent helper exists today, factor it out of the existing `final()` method (which currently builds and inserts a new row when a final arrives — it likely has a "find or create" pattern that can be split into "create" and "update" halves).
- `appendFinalAfter(afterSeq, finalLike)` — insert a new row immediately after the row keyed by `afterSeq`. If no equivalent exists, model it on the existing time-ordered insert path.

If the existing `final(msg)` method already does "find or create + render", look for the row-element store (likely a `Map<number, HTMLElement>`); the helpers are mostly internal accessors.

Read `src/renderer/transcript.ts` to confirm structure before writing the helpers; the goal is to avoid duplicating the row-rendering code.

- [ ] **Step 4: Wire dispatch**

In the renderer's WS message handler (the function that switches on `msg.type`), add a case for `transcript_split`:

```ts
case "transcript_split":
  view.splitLine(msg.original_seq, msg.rows);
  break;
```

Place it next to the existing `speaker_relabel` case for consistency.

- [ ] **Step 5: Build the renderer to verify TypeScript compiles**

```
cd /Users/nickcason/dev/cairn && npm run build 2>&1 | tail -20
```
Expected: build succeeds with no TS errors.

- [ ] **Step 6: Commit**

```
cd /Users/nickcason/dev/cairn && git add src/renderer/ && git commit -m "feat(client): handle transcript_split — replace row in place + insert split rows"
```

---

## Task 8: Electron HTTP control endpoint

**Files:**
- Modify: `src/main.ts` (Electron main process)
- Modify: `src/preload.ts` (preload script)
- Modify: `src/renderer/index.ts` (or wherever the Start/Stop button handlers live)

- [ ] **Step 1: Read existing main + preload + renderer wiring**

```
grep -n "ipcMain\|ipcRenderer\|contextBridge" /Users/nickcason/dev/cairn/src/main.ts /Users/nickcason/dev/cairn/src/preload.ts 2>&1 | head -30
grep -RIn "Start" /Users/nickcason/dev/cairn/src/renderer/index.ts | head -10
```

Confirm where the existing Start/Stop button handlers live and what they call. Note the imports for `BrowserWindow` and the main window reference; note whether there's an existing IPC scheme.

- [ ] **Step 2: Add the HTTP control listener in `src/main.ts`**

Near the top of `src/main.ts`, after the existing imports:

```ts
import * as http from "node:http";
```

Add a module-level state cache + helper that opens the listener after the main window is created. After `createWindow()` call (or wherever the window is born):

```ts
const CONTROL_PORT = parseInt(process.env.CAIRN_CONTROL_PORT || "8765", 10);

let controlState = {
  state: "idle" as "idle" | "recording" | "stopping" | "stopped",
  meeting_name: "",
  session_dir: null as string | null,
  ledger_count: 0,
};
let liveTranscript: any[] = [];

function startControlServer(mainWindow: Electron.BrowserWindow) {
  const server = http.createServer((req, res) => {
    // Loopback-only safety check — refuse if Host header isn't 127.0.0.1.
    const host = (req.headers.host || "").toLowerCase();
    if (!host.startsWith("127.0.0.1")) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "loopback-only" }));
      return;
    }
    if (req.method === "POST" && req.url === "/control/start") {
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => {
        let payload: any = {};
        try { payload = body ? JSON.parse(body) : {}; } catch { /* ignore */ }
        const meetingName = payload.meeting_name
          || `loop-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        mainWindow.webContents.send("cairn:control-start", { meeting_name: meetingName });
        controlState.state = "recording";
        controlState.meeting_name = meetingName;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, meeting_name: meetingName }));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/control/stop") {
      mainWindow.webContents.send("cairn:control-stop", {});
      controlState.state = "stopping";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "GET" && req.url === "/control/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(controlState));
      return;
    }
    if (req.method === "GET" && req.url === "/control/transcript") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(liveTranscript));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
  });

  server.listen(CONTROL_PORT, "127.0.0.1", () => {
    console.log(`[cairn] control endpoint listening on 127.0.0.1:${CONTROL_PORT}`);
  });
}
```

Call `startControlServer(mainWindow)` after `mainWindow` is created.

Add IPC handlers in `src/main.ts` to receive state updates from the renderer:

```ts
import { ipcMain } from "electron";

ipcMain.on("cairn:report-state", (_event, payload) => {
  if (payload && typeof payload === "object") {
    controlState = { ...controlState, ...payload };
  }
});

ipcMain.on("cairn:report-transcript", (_event, payload) => {
  if (Array.isArray(payload)) {
    liveTranscript = payload;
    controlState.ledger_count = payload.length;
  }
});
```

- [ ] **Step 3: Expose the IPC bridges in `src/preload.ts`**

Find the existing `contextBridge.exposeInMainWorld(...)` call:
```
grep -n "contextBridge" /Users/nickcason/dev/cairn/src/preload.ts
```

Append to the exposed object:

```ts
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("cairnControl", {
  onControlStart: (handler: (payload: { meeting_name: string }) => void) => {
    ipcRenderer.on("cairn:control-start", (_e, payload) => handler(payload));
  },
  onControlStop: (handler: () => void) => {
    ipcRenderer.on("cairn:control-stop", () => handler());
  },
  reportState: (state: object) => {
    ipcRenderer.send("cairn:report-state", state);
  },
  reportTranscript: (rows: any[]) => {
    ipcRenderer.send("cairn:report-transcript", rows);
  },
});
```

(If the existing preload uses a single `cairn` namespace, prefer adding these as fields on that namespace instead of a new one. Match existing convention.)

- [ ] **Step 4: Wire the renderer to use the IPC bridges**

In the renderer (likely `src/renderer/index.ts`), find the Start/Stop button click handlers. They probably call something like `startSession(meetingName)` and `stopSession()`. Add at module init time:

```ts
const ctrl: any = (window as any).cairnControl;
if (ctrl) {
  ctrl.onControlStart(({ meeting_name }: { meeting_name: string }) => {
    // call the same code path as the Start button:
    startSession(meeting_name);
    ctrl.reportState({ state: "recording", meeting_name });
  });
  ctrl.onControlStop(() => {
    stopSession();
    ctrl.reportState({ state: "stopping" });
  });
}
```

Find where the renderer signals "stopped" (e.g. when the WS closes after stop). Add `ctrl?.reportState({ state: "stopped" })` there.

Find where the renderer maintains its in-memory transcript array (the rows shown in the panel). Plumb a call to `ctrl?.reportTranscript([...rows])` after each `transcript_final`, `transcript_split`, and `speaker_relabel` mutation. Ideally factor through a single setter so all paths route through it.

- [ ] **Step 5: Build the client and start it once for a smoke check**

```
cd /Users/nickcason/dev/cairn && npm run build 2>&1 | tail -10
```
Expected: build succeeds.

Then verify the control endpoint is listening (open Cairn.app from Finder; in another terminal):
```
sleep 4 && curl -fsS http://127.0.0.1:8765/control/status
```
Expected: `{"state":"idle","meeting_name":"","session_dir":null,"ledger_count":0}` (or similar).

If the endpoint isn't reachable, check the DevTools console / main process log for errors.

Quit Cairn before continuing.

- [ ] **Step 6: Commit**

```
cd /Users/nickcason/dev/cairn && git add src/main.ts src/preload.ts src/renderer/ && git commit -m "feat(client): localhost HTTP control endpoint for scripted start/stop + live transcript"
```

---

## Task 9: Bash orchestration script

**Files:**
- Create: `scripts/cairn-loop.sh`

- [ ] **Step 1: Create `scripts/cairn-loop.sh`**

```bash
#!/usr/bin/env bash
# cairn-loop.sh — one e2e test iteration of Cairn against a YouTube URL.
#
# Quits Safari, starts Cairn recording via the control endpoint, opens
# Safari at the given URL (with autoplay-friendly behavior), sleeps for
# the duration, stops Cairn, snapshots the transcript, runs the grader,
# prints a summary line.

set -euo pipefail

URL="${URL:-https://www.youtube.com/watch?v=ugvHCXCOmm4&t=194s}"
DURATION="${DURATION:-600}"
OUT_BASE="${OUT_BASE:-/tmp/cairn-test-runs}"
CONTROL_HOST="${CONTROL_HOST:-127.0.0.1}"
CONTROL_PORT="${CONTROL_PORT:-8765}"
REFERENCE="${REFERENCE:-$(dirname "$0")/fixtures/dario-reference.json}"

usage() {
  cat <<EOF
usage: $0 [--url URL] [--duration SEC] [--out DIR]

Defaults:
  --url       $URL
  --duration  $DURATION (seconds)
  --out       $OUT_BASE/run-<timestamp>

Env overrides: URL, DURATION, OUT_BASE, CONTROL_HOST, CONTROL_PORT, REFERENCE
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --duration) DURATION="$2"; shift 2 ;;
    --out) OUT_BASE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage; exit 1 ;;
  esac
done

TS="$(date +%Y%m%d-%H%M%S)"
OUT="$OUT_BASE/run-$TS"
mkdir -p "$OUT"

CTRL="http://${CONTROL_HOST}:${CONTROL_PORT}"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

# 1. Pre-flight: ensure Cairn is running.
if ! pgrep -f 'Cairn.app/Contents/MacOS' > /dev/null; then
  log "Cairn not running; launching."
  open -a Cairn
  sleep 4
fi

# 2. Confirm control endpoint reachable.
if ! curl -fsS --max-time 3 "$CTRL/control/status" > /dev/null; then
  log "ERROR: control endpoint $CTRL/control/status unreachable. Is the build current?"
  exit 2
fi
log "control endpoint OK"

# 3. Quit Safari.
log "quitting Safari"
osascript -e 'tell application "Safari" to quit' 2>/dev/null || true
deadline=$((SECONDS + 10))
while pgrep -x Safari > /dev/null; do
  (( SECONDS < deadline )) || { log "WARN: Safari did not quit within 10s; continuing anyway"; break; }
  sleep 0.5
done

# 4. Start Cairn recording.
MEETING_NAME="loop-$TS"
log "POST /control/start meeting=$MEETING_NAME"
START_RESP="$(curl -fsS -X POST "$CTRL/control/start" \
  -H 'Content-Type: application/json' \
  -d "{\"meeting_name\":\"$MEETING_NAME\"}")"
echo "$START_RESP" > "$OUT/start-resp.json"
if ! echo "$START_RESP" | grep -q '"ok": true'; then
  log "ERROR: /control/start did not return ok=true"
  cat "$OUT/start-resp.json"
  exit 3
fi

# 5. Open Safari at the URL; press Space to ensure playback.
log "opening Safari at $URL"
open -a Safari "$URL"
sleep 3
# 1s gap then activate + space to play (works whether autoplay fired or not).
osascript -e 'tell application "Safari" to activate' >/dev/null 2>&1 || true
sleep 1
osascript -e 'tell application "System Events" to keystroke " "' >/dev/null 2>&1 || true

# 6. Sleep for the duration.
log "recording for $DURATION s ..."
sleep "$DURATION"

# 7. Stop Cairn.
log "POST /control/stop"
curl -fsS -X POST "$CTRL/control/stop" > "$OUT/stop-resp.json"

# 8. Wait for state == stopped.
log "waiting for state=stopped (max 90s)"
deadline=$((SECONDS + 90))
while :; do
  STATE="$(curl -fsS "$CTRL/control/status" | python3 -c 'import sys, json; print(json.load(sys.stdin).get("state",""))')"
  if [[ "$STATE" == "stopped" ]]; then
    log "state=stopped"
    break
  fi
  (( SECONDS < deadline )) || { log "WARN: did not reach stopped state in 90s (current=$STATE)"; break; }
  sleep 1
done

# 9. Snapshot transcript.
log "snapshotting transcript"
curl -fsS "$CTRL/control/transcript" > "$OUT/transcript.json"

# 10. Grade.
log "grading vs reference"
python3 "$(dirname "$0")/grade-transcript.py" \
  --transcript "$OUT/transcript.json" \
  --reference "$REFERENCE" \
  --out "$OUT/grade.json" \
  | tee "$OUT/grade-summary.txt"

log "run output: $OUT"
```

Make it executable:

```
chmod +x /Users/nickcason/dev/cairn/scripts/cairn-loop.sh
```

- [ ] **Step 2: Smoke-test the script's argument parsing only (no full run)**

```
/Users/nickcason/dev/cairn/scripts/cairn-loop.sh --help
```
Expected: usage text printed.

- [ ] **Step 3: Commit**

```
cd /Users/nickcason/dev/cairn && git add scripts/cairn-loop.sh && git commit -m "feat(scripts): cairn-loop.sh e2e harness for repeatable Safari + Cairn runs"
```

---

## Task 10: Reference fixture + grader

**Files:**
- Create: `scripts/build-reference.py`
- Create: `scripts/fixtures/dario-reference.json` (committed; built once)
- Create: `scripts/grade-transcript.py`
- Create: `scripts/test_grade_transcript.py`

- [ ] **Step 1: Build the reference fixture**

Create `scripts/build-reference.py`:

```python
#!/usr/bin/env python3
"""Builds scripts/fixtures/dario-reference.json from
https://lexfridman.com/dario-amodei-transcript.

The page renders speaker turns as <p> elements; each turn typically has
a leading speaker name + a parenthetical timestamp like '(00:03:14)'.
We parse those into a JSON file with absolute-time entries.

This script is run ONCE to seed the fixture; the resulting JSON file is
committed and used by grade-transcript.py.
"""
import argparse
import json
import re
import sys
from pathlib import Path
from urllib.request import urlopen, Request

URL = "https://lexfridman.com/dario-amodei-transcript"
ANCHOR_SEC = 194  # YouTube ?t=194s — when Cairn recording starts

TIMESTAMP_RE = re.compile(r"\((\d{1,2}):(\d{2}):(\d{2})\)")


def fetch_html(url: str) -> str:
    req = Request(url, headers={"User-Agent": "Mozilla/5.0 (cairn-loop)"})
    with urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", errors="replace")


def parse_entries(html: str) -> list[dict]:
    """Extract (speaker, t_start_sec, text) tuples from the transcript HTML.

    Strategy: find all <p>...</p> blocks. For each block, look for a
    leading bold/strong speaker name (commonly Lex Fridman, Dario Amodei),
    then a timestamp anchor '(HH:MM:SS)', then the spoken text. Some pages
    use slightly different markup; this parser is best-effort and the
    output should be sanity-checked manually before committing.
    """
    # Strip HTML tags but keep paragraph structure.
    paragraphs = re.findall(r"<p[^>]*>(.*?)</p>", html, flags=re.S | re.I)
    entries: list[dict] = []
    for p in paragraphs:
        # Pull out a bold speaker name.
        m_speaker = re.search(r"<(?:strong|b)[^>]*>([^<]+)</(?:strong|b)>", p, re.I)
        if not m_speaker:
            continue
        speaker = m_speaker.group(1).strip().rstrip(":").strip()
        # Pull out the timestamp.
        m_ts = TIMESTAMP_RE.search(p)
        if not m_ts:
            continue
        h, mn, s = (int(x) for x in m_ts.groups())
        t_sec = h * 3600 + mn * 60 + s
        # Strip all tags; the remaining content is the spoken text.
        text = re.sub(r"<[^>]+>", "", p)
        text = TIMESTAMP_RE.sub("", text)
        text = text.replace(speaker + ":", "").strip()
        text = re.sub(r"\s+", " ", text).strip()
        if not text:
            continue
        entries.append({
            "speaker": speaker,
            "t_start_sec": float(t_sec),
            "text": text,
        })
    # Sort by start; close intervals end at next entry's start (best effort).
    entries.sort(key=lambda e: e["t_start_sec"])
    for i in range(len(entries) - 1):
        entries[i]["t_end_sec"] = entries[i + 1]["t_start_sec"]
    if entries:
        entries[-1]["t_end_sec"] = entries[-1]["t_start_sec"] + 30.0
    return entries


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=URL)
    ap.add_argument("--anchor-sec", type=int, default=ANCHOR_SEC)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    html = fetch_html(args.url)
    entries = parse_entries(html)
    if len(entries) < 5:
        print(
            f"ERROR: only {len(entries)} entries parsed; HTML structure may "
            "have changed. Inspect the HTML manually and adjust parse_entries.",
            file=sys.stderr,
        )
        return 2

    out = {
        "url": args.url,
        "anchor_sec": args.anchor_sec,
        "entries": entries,
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out, indent=2))
    print(f"wrote {len(entries)} entries to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Build the fixture once**

```
mkdir -p /Users/nickcason/dev/cairn/scripts/fixtures
python3 /Users/nickcason/dev/cairn/scripts/build-reference.py \
  --out /Users/nickcason/dev/cairn/scripts/fixtures/dario-reference.json
```

If the parser returns fewer than 5 entries, the page structure differs from what `parse_entries` expects. Fall back to a manual approach:
1. Open `https://lexfridman.com/dario-amodei-transcript` in a browser.
2. Manually extract the first ~25 turns (covering 194 s through ~12 minutes / 920 s) into the JSON shape:
   ```json
   {
     "url": "https://lexfridman.com/dario-amodei-transcript",
     "anchor_sec": 194,
     "entries": [
       { "speaker": "Lex Fridman", "t_start_sec": 194.0, "t_end_sec": 207.5, "text": "..." },
       ...
     ]
   }
   ```
3. Save to `scripts/fixtures/dario-reference.json`.

Either path is acceptable. Commit the resulting JSON.

- [ ] **Step 3: Write the grader and its tests**

Create `scripts/grade-transcript.py`:

```python
#!/usr/bin/env python3
"""grade-transcript.py — score a Cairn transcript for cross-speaker bleed.

Usage:
    grade-transcript.py --transcript run.json --reference dario-reference.json --out grade.json

Algorithm:
  - Convert reference entries to absolute Cairn-timeline ms (subtract
    anchor_sec).
  - For each Cairn final, compute the set of distinct reference speakers
    whose entries overlap the final by > MIN_OVERLAP_MS.
  - "off-script" if no reference overlap; excluded from the bleed-rate
    denominator.
  - "gradeable" otherwise; "bleed" if >= 2 distinct reference speakers.
  - bleed_rate = bleed_finals / gradeable_finals (0.0 if gradeable == 0).
"""
import argparse
import json
import sys
from pathlib import Path

MIN_OVERLAP_MS = 50


def load_transcript(path: str) -> list[dict]:
    text = Path(path).read_text().strip()
    if not text:
        return []
    if text[0] == "[":
        # JSON array.
        return json.loads(text)
    # JSONL.
    rows: list[dict] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        rows.append(json.loads(line))
    return rows


def overlap_ms(a_start, a_end, b_start, b_end) -> int:
    return max(0, min(a_end, b_end) - max(a_start, b_start))


def grade(transcript: list[dict], reference: dict) -> dict:
    anchor_ms = int(reference.get("anchor_sec", 0) * 1000)
    ref_entries = []
    for e in reference["entries"]:
        ref_entries.append({
            "speaker": e["speaker"],
            "t_start_ms": int(e["t_start_sec"] * 1000) - anchor_ms,
            "t_end_ms": int(e["t_end_sec"] * 1000) - anchor_ms,
        })

    bleed_finals: list[dict] = []
    gradeable = 0
    off_script = 0

    for f in transcript:
        if "type" in f and f["type"] != "transcript_final":
            # Allow either pure final rows or a list of mixed-shape entries.
            continue
        t0 = int(f.get("t_start_ms", 0))
        t1 = int(f.get("t_end_ms", 0))
        speakers = set()
        for r in ref_entries:
            if overlap_ms(t0, t1, r["t_start_ms"], r["t_end_ms"]) > MIN_OVERLAP_MS:
                speakers.add(r["speaker"])
        if not speakers:
            off_script += 1
            continue
        gradeable += 1
        if len(speakers) >= 2:
            bleed_finals.append({
                "seq": f.get("seq"),
                "text": f.get("text"),
                "cairn_speaker": f.get("speaker_id"),
                "ref_speakers": sorted(speakers),
                "t_start_ms": t0,
                "t_end_ms": t1,
            })

    bleed_count = len(bleed_finals)
    bleed_rate = (bleed_count / gradeable) if gradeable else 0.0

    return {
        "summary": {
            "total_finals": len(transcript),
            "gradeable_finals": gradeable,
            "bleed_finals": bleed_count,
            "off_script_finals": off_script,
            "bleed_rate": round(bleed_rate, 4),
        },
        "bleeds": bleed_finals,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--transcript", required=True)
    ap.add_argument("--reference", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    transcript = load_transcript(args.transcript)
    reference = json.loads(Path(args.reference).read_text())
    result = grade(transcript, reference)
    Path(args.out).write_text(json.dumps(result, indent=2))

    s = result["summary"]
    print(
        f"Bleed rate: {s['bleed_rate'] * 100:.1f}% "
        f"({s['bleed_finals']}/{s['gradeable_finals']} gradeable); "
        f"off-script: {s['off_script_finals']}; total: {s['total_finals']}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

Make executable:
```
chmod +x /Users/nickcason/dev/cairn/scripts/grade-transcript.py
```

- [ ] **Step 4: Test the grader with synthetic inputs**

Create `scripts/test_grade_transcript.py`:

```python
"""Tests for grade_transcript.grade()."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import importlib.util
spec = importlib.util.spec_from_file_location(
    "grade_transcript",
    Path(__file__).parent / "grade-transcript.py",
)
grade_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(grade_mod)
grade = grade_mod.grade


def _ref(entries):
    return {"url": "x", "anchor_sec": 0, "entries": entries}


def test_clean_single_speaker_finals_zero_bleed():
    transcript = [
        {"seq": 1, "text": "a", "speaker_id": "S1", "t_start_ms": 0, "t_end_ms": 1000},
        {"seq": 2, "text": "b", "speaker_id": "S1", "t_start_ms": 1000, "t_end_ms": 2000},
    ]
    reference = _ref([
        {"speaker": "Lex", "t_start_sec": 0.0, "t_end_sec": 2.0, "text": "ground"},
    ])
    r = grade(transcript, reference)
    assert r["summary"]["bleed_finals"] == 0
    assert r["summary"]["gradeable_finals"] == 2
    assert r["summary"]["bleed_rate"] == 0.0


def test_two_speaker_overlap_counts_as_bleed():
    transcript = [
        {"seq": 1, "text": "compute. Yes.", "speaker_id": "S1",
         "t_start_ms": 0, "t_end_ms": 1300},
    ]
    reference = _ref([
        {"speaker": "Lex",   "t_start_sec": 0.0, "t_end_sec": 0.4, "text": "compute."},
        {"speaker": "Dario", "t_start_sec": 0.5, "t_end_sec": 1.3, "text": "Yes."},
    ])
    r = grade(transcript, reference)
    assert r["summary"]["bleed_finals"] == 1
    assert r["summary"]["gradeable_finals"] == 1
    assert r["summary"]["bleed_rate"] == 1.0
    assert sorted(r["bleeds"][0]["ref_speakers"]) == ["Dario", "Lex"]


def test_off_script_finals_excluded_from_denominator():
    transcript = [
        {"seq": 1, "text": "ad break", "speaker_id": "S1",
         "t_start_ms": 5000, "t_end_ms": 6000},
        {"seq": 2, "text": "real", "speaker_id": "S1",
         "t_start_ms": 0, "t_end_ms": 500},
    ]
    reference = _ref([
        {"speaker": "Lex", "t_start_sec": 0.0, "t_end_sec": 1.0, "text": "x"},
    ])
    r = grade(transcript, reference)
    assert r["summary"]["off_script_finals"] == 1
    assert r["summary"]["gradeable_finals"] == 1
    assert r["summary"]["bleed_finals"] == 0


def test_anchor_sec_offset_applied():
    transcript = [
        {"seq": 1, "text": "x", "speaker_id": "S1",
         "t_start_ms": 0, "t_end_ms": 1000},
    ]
    reference = {
        "url": "x", "anchor_sec": 194,
        "entries": [
            {"speaker": "Lex", "t_start_sec": 194.0, "t_end_sec": 195.0, "text": "x"},
        ],
    }
    r = grade(transcript, reference)
    assert r["summary"]["gradeable_finals"] == 1
    assert r["summary"]["bleed_finals"] == 0
```

Run:
```
cd /Users/nickcason/dev/cairn && python3 -m pytest scripts/test_grade_transcript.py -v 2>&1 | tail -10
```
Expected: 4 passed.

- [ ] **Step 5: Commit**

```
cd /Users/nickcason/dev/cairn && git add scripts/build-reference.py scripts/grade-transcript.py scripts/test_grade_transcript.py scripts/fixtures/dario-reference.json && git commit -m "feat(scripts): bleed-rate grader + Lex/Dario reference fixture"
```

---

## Task 11: Deploy + 10-minute end-to-end test

**Files:** none modified.

This task is the user-facing acceptance gate. The user explicitly asked for the full 10-minute transcript and grade before this work is called complete.

- [ ] **Step 1: Final svc test pass on node4**

```
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest -q 2>&1 | tail -5'
```
Expected: all pass (count = prior 119 + new tests added across Tasks 1-6).

- [ ] **Step 2: Restart cairn-svc**

```
ssh node4 'systemctl --user restart cairn-svc && sleep 4 && systemctl --user is-active cairn-svc'
```
Expected: `active`.

```
ssh node4 'journalctl --user -u cairn-svc -n 12 --no-pager'
```
Expected: clean startup ("Application startup complete"), no traceback.

- [ ] **Step 3: Build + install client**

```
cd /Users/nickcason/dev/cairn && npm run build 2>&1 | tail -5 && npm run install-app
```
Expected: build OK; `/Applications/Cairn.app` symlink refreshed.

- [ ] **Step 4: Quit any running Cairn, then launch fresh**

```
osascript -e 'tell application "Cairn" to quit' 2>/dev/null || true
sleep 2
pkill -f 'Cairn.app/Contents/MacOS' 2>/dev/null || true   # belt-and-suspenders
sleep 1
open -a Cairn
sleep 5
curl -fsS http://127.0.0.1:8765/control/status
```
Expected: `state=idle`. The first sleep gives Cairn a chance to clean-quit; the pkill catches a hung instance; the post-launch sleep waits for the renderer + control endpoint to come up.

- [ ] **Step 5: Run the 10-minute loop**

```
/Users/nickcason/dev/cairn/scripts/cairn-loop.sh \
  --url 'https://www.youtube.com/watch?v=ugvHCXCOmm4&t=194s' \
  --duration 600 \
  --out /tmp/cairn-test-runs
```

Expected at completion: `Bleed rate: X.X% (Y/Z gradeable); off-script: W; total: T` printed.

If the loop hangs at "waiting for state=stopped" past 90 s, the on-stop auth pass took too long; check `journalctl --user -u cairn-svc -n 50` and the in-flight memory's note about "tail-only on-stop" — the on-stop auth pass should be tail-only and complete in < 60 s for a 10-minute session.

- [ ] **Step 6: Verify run output**

```
ls -la /tmp/cairn-test-runs/run-*/
cat /tmp/cairn-test-runs/run-*/grade-summary.txt | tail -1
```

Read `transcript.json` to spot-check sentence-level coherence:
```
python3 -c '
import json, sys
rows = json.load(open(sys.argv[1]))
for r in rows[:30]:
  print(f"{r.get(\"seq\"):>4} {r.get(\"speaker_id\"):<6} {r.get(\"t_start_ms\")/1000:>6.1f}-{r.get(\"t_end_ms\")/1000:>6.1f}s  {r.get(\"text\")[:120]}")
' /tmp/cairn-test-runs/run-*/transcript.json | head -30
```

Confirm the first ~30 finals look like clean per-speaker sentences, not mid-sentence cuts or two-speaker bleeds.

- [ ] **Step 7: Report to the user**

Print the full transcript and the grade summary inline. If bleed_rate ≥ 5%, do NOT call the work complete — instead, examine the bleeds in `grade.json`, and either:
1. If the bleeds appear to be auth-pass false positives (phantom split), file a follow-up issue.
2. If the bleeds appear to be unsplit cross-speaker rows the auth pass missed, investigate why `_split_eligible_rows` didn't run (check journal logs for splits during the run; verify auth ticks fired).
3. Re-run the loop after any code fix.

If bleed_rate < 5% AND visual sentence-level coherence is solid, mark the work complete.

- [ ] **Step 8: No commit — this task is observation only.**

---

## Self-review checklist

- [x] Spec section 1 (Architecture overview) → Tasks 2, 6, 7 collectively
- [x] Spec section 2 (Word storage on ledger) → Task 2
- [x] Spec section 3 (`_split_into_runs`) → Task 1
- [x] Spec section 4 (`_split_eligible_rows`) → Task 6
- [x] Spec section 5 (`TranscriptSplitMsg` protocol) → Task 5
- [x] Spec section 6 (Client `splitLine`) → Task 7
- [x] Spec section 7 (`user_locked` flag) → Tasks 3 and 4
- [x] Spec section 8 (Electron HTTP control endpoint) → Task 8
- [x] Spec section 9 (Bash harness) → Task 9
- [x] Spec section 10 (Grading script) → Task 10
- [x] Spec acceptance gate (10-min run + grade) → Task 11
- [x] No "TBD"/"TODO"/"implement later" placeholders
- [x] Each step shows complete code for any code change
- [x] Type/method names consistent across tasks (`_split_into_runs`, `_Run`, `_split_eligible_rows`, `mark_user_locked`, `TranscriptSplitMsg`, `SplitRow`, `splitLine`, `cairnControl`)
- [x] `pending_finals` 5-tuple shape consistent across producer and consumers
- [x] Service vs client work clearly labeled (`ssh node4` for svc; local cwd for client)

---

## Naming/style notes for executors

- Per existing user preference in this repo, when running subagent-driven dev, each agent picks a memorable name and includes a brief honest reflection at end of work. Reviewers do the same. Spec compliance review + code quality review run between every task; no skipping for "trivial" tasks.
- Prior plans in this repo used names from a Greek/botanical/bird cycle (Cottonwood, Sablefin, Marigold, Stonechat, Bittern, Hornbill, Marlinspike, Cinquefoil, Hawfinch, Sablewing, Wagtail, Marbleback, Cinder, Marlin, Pipit, Hemlock, Skylark, Nightjar). Avoid name collisions when possible.
