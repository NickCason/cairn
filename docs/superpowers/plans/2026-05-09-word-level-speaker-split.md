# Word-Level Speaker Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop cross-speaker bleed in transcript finals by splitting each whisper segment into runs of consecutive same-speaker words, emitting one `transcript_final` per run.

**Architecture:** Whisper already returns word-level timestamps via `TranscriptSegment.words` but they're discarded after `transcribe_recent`. Plumb them through the `pending_finals` tuple as a 5th element. Replace `_drain_pending`'s single-`assign_speaker`-per-pending logic with a call to a new pure helper `_split_into_runs(words, diar_segs)` that returns a list of `Run` records (or `None` if no diar coverage yet). Each run becomes a `transcript_final` with its own seq — first run inherits the partial's seq, additional runs get fresh seqs.

**Tech Stack:** Python 3.11, pytest, FastAPI WebSockets, pyannote diarization segments, faster-distil-whisper STT (already returning per-word timestamps).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `cairn_svc/server.py` | Module-level `_split_into_runs(words, diar_segs)` pure helper. `transcribe_recent` pushes a 5-tuple `(seq, text, t0, t1, words)` into `pending_finals`. `_drain_pending` calls the helper and emits one final per run. Stop-branch flush still works (just unpacks the 5-tuple). |
| `cairn_svc/diarize.py` | No change — `DiarizationSegment` already imported by `server.py`. |
| `cairn_svc/transcribe.py` | No change — `TranscriptSegment.words` already produced. |
| `tests/test_word_split.py` (new) | Unit tests for `_split_into_runs` covering single-speaker, mid-segment flip, three-speaker alternation, all-unknown, partial-unknown, run-time tightness. |
| `tests/test_drain_pending.py` (new) | Integration tests for `_drain_pending` with mixed-speaker pendings: emits multiple finals, allocates fresh seqs, both speakers go through `sent_speakers`, ledger has one row per run. Also: single-speaker behavior unchanged; words-empty fallback; all-unknown defers. |

---

## Task 1: `_split_into_runs` helper + unit tests

**Files:**
- Create: `tests/test_word_split.py`
- Modify: `cairn_svc/server.py` — add module-level `_Run` dataclass and `_split_into_runs` helper near the existing module-scope helpers (around line 280, near `_orphan_sweep`).

- [ ] **Step 1: Write failing tests**

Create `tests/test_word_split.py`:

```python
"""Unit tests for _split_into_runs: word-level speaker splitting."""
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
    diar = [_seg("S1", 5000, 6000)]  # no overlap with words
    assert _split_into_runs(words, diar) is None


def test_unknown_word_attributed_to_preceding_neighbor():
    """A word whose span has zero overlap with any diar seg, sandwiched
    between known words, joins the preceding speaker's run."""
    words = [
        _w("a", 0, 100),       # in S1
        _w("b", 200, 300),     # in S1
        _w("c", 1500, 1600),   # GAP — no diar seg
        _w("d", 2000, 2100),   # in S1 again
    ]
    diar = [_seg("S1", 0, 400), _seg("S1", 1900, 2200)]
    runs = _split_into_runs(words, diar)
    assert len(runs) == 1
    assert runs[0].speaker_id == "S1"
    assert runs[0].text == "a b c d"


def test_unknown_word_at_start_attributed_to_following_neighbor():
    words = [
        _w("um", 0, 100),       # GAP — no diar covers
        _w("hello", 500, 800),  # in S1
    ]
    diar = [_seg("S1", 400, 1000)]
    runs = _split_into_runs(words, diar)
    assert len(runs) == 1
    assert runs[0].speaker_id == "S1"
    assert runs[0].text == "um hello"


def test_run_t_range_uses_first_and_last_word_times():
    """Run timing comes from the words it contains, not from the
    enclosing whisper segment's bounds."""
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
    """Whisper words may have leading/trailing whitespace; helper strips
    each and joins with single spaces."""
    words = [
        TranscriptWord(text=" hello", t_start_ms=0, t_end_ms=100),
        TranscriptWord(text=" world ", t_start_ms=100, t_end_ms=200),
    ]
    diar = [_seg("S1", 0, 300)]
    runs = _split_into_runs(words, diar)
    assert runs[0].text == "hello world"


def test_consecutive_same_speaker_across_diar_segs_stays_one_run():
    """Two distinct diar segs that share a stable_id (e.g. after a brief
    silence pyannote split) should still group as one run."""
    words = [
        _w("a", 0, 100),    # in first S1 seg
        _w("b", 600, 700),  # in second S1 seg (same speaker, different seg)
    ]
    diar = [_seg("S1", 0, 200), _seg("S1", 500, 800)]
    runs = _split_into_runs(words, diar)
    assert len(runs) == 1
    assert runs[0].speaker_id == "S1"
    assert runs[0].text == "a b"
```

- [ ] **Step 2: Run tests to verify they fail**

```
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_word_split.py -v 2>&1 | tail -20'
```
Expected: ImportError on `_split_into_runs` from `cairn_svc.server`.

- [ ] **Step 3: Implement helper**

In `cairn_svc/server.py`, add at module scope (recommended location: just after `_orphan_sweep` ends, before `_apply_rename_retro`). Use the existing `dataclass` import; it's already used in this file via the `from dataclasses import dataclass` style — verify with `grep -n '^from dataclasses' ~/cairn-svc/cairn_svc/server.py` and add `from dataclasses import dataclass` at the top of the file if absent.

Add the helper:

```python
@dataclass
class _Run:
    speaker_id: str
    t_start_ms: int
    t_end_ms: int
    text: str


def _split_into_runs(
    words: list,
    diar_segs: list[DiarizationSegment],
) -> list[_Run] | None:
    """Group a whisper segment's words into runs of consecutive same-speaker
    words. Returns None if NO word has any overlap with a diar seg (defer
    to next drain pass — diar hasn't caught up yet). Otherwise returns a
    list of _Run records, one per contiguous same-speaker stretch.

    Words with zero overlap to any diar seg ("unknown") are attributed to
    the immediately-preceding known speaker, or the immediately-following
    one if they precede any known word. This keeps the helper live in the
    presence of timestamp jitter at segment edges without dropping into an
    indefinite hold.
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

    # Pass 2: fill in unknown ("") with preceding known label, or the
    # following one if the unknown precedes any known word.
    filled = list(raw)
    last_known: str = ""
    for i, lbl in enumerate(filled):
        if lbl:
            last_known = lbl
        elif last_known:
            filled[i] = last_known
    # Sweep right-to-left for unknowns that came before the first known.
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
            text=" ".join(w.text.strip() for w in cur_words),
        ))
        cur_label = lbl
        cur_words = [w]
    runs.append(_Run(
        speaker_id=cur_label,
        t_start_ms=cur_words[0].t_start_ms,
        t_end_ms=cur_words[-1].t_end_ms,
        text=" ".join(w.text.strip() for w in cur_words),
    ))
    return runs
```

If `from dataclasses import dataclass` is not already imported at the top of `server.py`, add it. Verify with `grep '^from dataclasses' ~/cairn-svc/cairn_svc/server.py` — add only if absent.

- [ ] **Step 4: Run tests to verify they pass**

```
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_word_split.py -v 2>&1 | tail -20'
```
Expected: 9 passed.

- [ ] **Step 5: Commit**

```
ssh node4 'cd ~/cairn-svc && git add cairn_svc/server.py tests/test_word_split.py && git commit -m "feat(svc): _split_into_runs word-level speaker grouping helper"'
```

---

## Task 2: Plumb word timestamps through `pending_finals`

**Files:**
- Modify: `cairn_svc/server.py` — three sites that touch `pending_finals`:
  1. Initial declaration around line 569 (type comment)
  2. `transcribe_recent` append site around line 1049
  3. Stop branch unpack site around line 1101
- The `_drain_pending` site is updated in Task 3.

- [ ] **Step 1: Update tuple declaration and append**

Find this line (around line 569):

```python
    pending_finals: list[tuple[int, str, int, int]] = []  # (seq, text, t0_ms, t1_ms)
```

Replace with:

```python
    # Each pending: (seq, text, t0_ms, t1_ms, words). `words` is a list of
    # TranscriptWord with per-word timestamps; used by _split_into_runs to
    # split a whisper segment that spans multiple speakers.
    pending_finals: list[tuple[int, str, int, int, list]] = []
```

Find this line in `transcribe_recent` (around line 1049):

```python
                pending_finals.append((seq, text, t0, t1))
```

Replace with:

```python
                pending_finals.append((seq, text, t0, t1, list(s.words)))
```

(`s` is the loop variable for the whisper segment in `transcribe_recent`. `s.words` is the `list[TranscriptWord]` produced by `transcribe.py`. We copy via `list(...)` so a downstream mutation can't surprise the segment.)

- [ ] **Step 2: Update stop-branch unpack**

Find this block in the stop branch (around line 1100):

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

Replace the unpacking only — keep the body. The new shape unpacks 5 elements; the words list is intentionally unused here (stop-branch flushes "S?" without per-word splitting since the audio remained unattributed):

```python
                        for seq, text, t0, t1, _words in pending_finals:
                            await ws.send_text(TranscriptFinalMsg(
                                seq=seq, text=text, t_start_ms=t0, t_end_ms=t1, speaker_id="S?"
                            ).model_dump_json())
                            session.append_final(
                                seq=seq, text=text, speaker_id="S?",
                                t_start=t0 / 1000.0, t_end=t1 / 1000.0,
                            )
```

- [ ] **Step 3: Verify type-only change doesn't break the suite**

`_drain_pending` still uses the 4-tuple shape — it will fail to unpack until Task 3 lands. So expect failures, but only in tests/code paths that exercise `_drain_pending`. We'll verify manually that the only failing tests are the ones that drive `_drain_pending`:

```
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest -q 2>&1 | tail -10'
```

Expected: failures concentrated in tests that drive a real `_drain_pending` (likely `test_smoke_ws.py` if it covers the WS path). The intermediate failure is expected — Task 3 fixes it.

If you see failures unrelated to `_drain_pending` (e.g. import errors), STOP and re-read the change for typos before proceeding.

- [ ] **Step 4: Commit**

```
ssh node4 'cd ~/cairn-svc && git add cairn_svc/server.py && git commit -m "refactor(svc): widen pending_finals tuple to carry whisper word timestamps"'
```

(No test changes in this task — the tuple shape is consumed only by code; tests don't construct `pending_finals` directly. Task 3 brings the suite back to green.)

---

## Task 3: `_drain_pending` emits one final per run

**Files:**
- Modify: `cairn_svc/server.py` — replace the body of `_drain_pending` (around line 570).
- Create: `tests/test_drain_pending.py` — integration coverage.

- [ ] **Step 1: Write failing integration tests**

`_drain_pending` is a closure inside `ws_transcribe`, so it can't be imported directly. We'll exercise its logic by calling the helper it delegates to (`_split_into_runs`) plus an inline mini-driver that mimics `_drain_pending`'s own loop. To keep these tests focused and not dependent on running the full WS server, this task's tests live alongside the helper tests and exercise the run-emission contract via a thin reproduction.

Create `tests/test_drain_pending.py`:

```python
"""Integration tests for the run-emission contract of _drain_pending.

_drain_pending is a closure inside ws_transcribe so we can't import it
directly. These tests exercise the same shape of work: call
_split_into_runs, allocate seqs, build the same WS messages and ledger
rows. If the production loop diverges from this contract, update both.
"""
from cairn_svc.diarize import DiarizationSegment
from cairn_svc.transcribe import TranscriptWord
from cairn_svc.session import Session
from cairn_svc.server import _split_into_runs


def _w(text, t0, t1):
    return TranscriptWord(text=text, t_start_ms=t0, t_end_ms=t1)


def _seg(label, t0, t1):
    return DiarizationSegment(label=label, t_start_ms=t0, t_end_ms=t1)


def _drive(session: Session, pending: tuple, diar_segs: list, sent_speakers: set):
    """Reproduce the run-emission loop body that _drain_pending executes
    in production. Returns (msgs_emitted, still_pending_or_None)."""
    seq, text, t0, t1, words = pending
    runs = _split_into_runs(words, diar_segs)
    if runs is None:
        return [], pending
    msgs = []
    for i, run in enumerate(runs):
        run_seq = seq if i == 0 else session.next_seq()
        if run.speaker_id not in sent_speakers:
            sent_speakers.add(run.speaker_id)
            msgs.append({
                "type": "speaker_assigned",
                "speaker_id": run.speaker_id,
            })
        msgs.append({
            "type": "transcript_final",
            "seq": run_seq,
            "text": run.text,
            "t_start_ms": run.t_start_ms,
            "t_end_ms": run.t_end_ms,
            "speaker_id": run.speaker_id,
        })
        session.append_final(
            seq=run_seq, text=run.text, speaker_id=run.speaker_id,
            t_start=run.t_start_ms / 1000.0, t_end=run.t_end_ms / 1000.0,
        )
    return msgs, None


def test_single_speaker_pending_emits_one_final_with_original_seq():
    s = Session(meeting_name="t")
    s.mint_stable_id()  # S1
    seq = s.next_seq()
    pending = (seq, "hello world", 0, 500,
               [_w("hello", 0, 200), _w("world", 200, 500)])
    diar = [_seg("S1", 0, 600)]
    sent = set()

    msgs, still = _drive(s, pending, diar, sent)
    assert still is None

    finals = [m for m in msgs if m["type"] == "transcript_final"]
    assigns = [m for m in msgs if m["type"] == "speaker_assigned"]
    assert len(finals) == 1
    assert finals[0]["seq"] == seq
    assert finals[0]["text"] == "hello world"
    assert finals[0]["speaker_id"] == "S1"
    assert len(assigns) == 1
    assert assigns[0]["speaker_id"] == "S1"
    assert len(s.ledger_all()) == 1


def test_mixed_speaker_pending_emits_two_finals_with_fresh_seq_for_second():
    s = Session(meeting_name="t")
    s.mint_stable_id()  # S1
    s.mint_stable_id()  # S2
    seq = s.next_seq()
    pending = (seq, "compute. Yes. All of those.", 0, 1300, [
        _w("compute.", 0, 400),
        _w("Yes.", 500, 700),
        _w("All", 750, 900),
        _w("of", 950, 1050),
        _w("those.", 1100, 1300),
    ])
    diar = [_seg("S2", 0, 450), _seg("S1", 450, 1400)]
    sent = set()

    msgs, still = _drive(s, pending, diar, sent)
    assert still is None

    finals = [m for m in msgs if m["type"] == "transcript_final"]
    assigns = [m for m in msgs if m["type"] == "speaker_assigned"]
    assert len(finals) == 2
    assert finals[0]["seq"] == seq          # first run inherits original seq
    assert finals[1]["seq"] != seq          # second run uses fresh seq
    assert finals[0]["text"] == "compute."
    assert finals[1]["text"] == "Yes. All of those."
    assert finals[0]["speaker_id"] == "S2"
    assert finals[1]["speaker_id"] == "S1"
    assert {a["speaker_id"] for a in assigns} == {"S1", "S2"}
    # Ledger has one row per run.
    rows = s.ledger_all()
    assert len(rows) == 2
    assert {r["speaker_id"] for r in rows} == {"S1", "S2"}


def test_all_unknown_pending_stays_pending():
    s = Session(meeting_name="t")
    seq = s.next_seq()
    pending = (seq, "x y", 0, 200,
               [_w("x", 0, 100), _w("y", 100, 200)])
    diar = [_seg("S1", 5000, 6000)]  # no overlap
    sent = set()

    msgs, still = _drive(s, pending, diar, sent)
    assert msgs == []
    assert still == pending


def test_words_empty_falls_back_to_no_runs():
    """When whisper returned no per-word timestamps, _split_into_runs
    returns None and the production code should fall back to the
    existing per-segment assign_speaker path. The reproduction here
    asserts None; the production fallback is verified manually below."""
    s = Session(meeting_name="t")
    seq = s.next_seq()
    pending = (seq, "hi", 0, 200, [])  # empty words list
    diar = [_seg("S1", 0, 1000)]
    runs = _split_into_runs(pending[4], diar)
    assert runs is None
```

- [ ] **Step 2: Run tests to verify failure**

```
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_drain_pending.py -v 2>&1 | tail -25'
```
Expected: 4 tests run; some may pass already (the helper exists from Task 1 and `Session` already supports `next_seq`/`mint_stable_id`/`append_final`/`ledger_all`). Tests that fail will give a concrete error about what's missing — likely zero failures if Task 1's helper is correct, since these tests don't actually depend on `_drain_pending` itself. **If all pass:** that's expected; the integration tests are a contract spec for what the rewritten `_drain_pending` will do. Proceed to Step 3.

- [ ] **Step 3: Rewrite `_drain_pending` to use `_split_into_runs`**

In `cairn_svc/server.py`, replace the body of `_drain_pending` (currently lines ~570–596). The current body is:

```python
    async def _drain_pending(diar_segs):
        """Resolve pending partials to finals.

        diar_segs MUST already carry stable ids in their .label field (this
        is the invariant after the windowed-diarization rewrite — segs come
        from session._diar_segs, which is stitched on each pass).
        """
        nonlocal sent_speakers
        still_pending = []
        for seq, text, t0, t1 in pending_finals:
            stable = assign_speaker(t0, t1, diar_segs)
            if stable is None:
                still_pending.append((seq, text, t0, t1))
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
            )
        pending_finals[:] = still_pending
```

Replace with:

```python
    async def _drain_pending(diar_segs):
        """Resolve pending partials to finals, splitting each pending into
        runs of consecutive same-speaker words so a single whisper segment
        that spans two speakers (e.g. quick turn-taking with < 500 ms of
        silence) becomes multiple finals — one per speaker.

        diar_segs MUST already carry stable ids in their .label field (this
        is the invariant after the windowed-diarization rewrite — segs come
        from session._diar_segs, which is stitched on each pass).

        Fallback: if a whisper segment arrived without per-word timestamps
        (rare; some very short utterances), split-into-runs returns None
        for the whole pending and we use the segment-level assign_speaker
        as before. Same fallback for pendings whose words have zero diar
        coverage anywhere — those stay in still_pending until the next
        diar pass catches up (preserving today's behaviour).
        """
        nonlocal sent_speakers
        still_pending = []
        for pending in pending_finals:
            seq, text, t0, t1, words = pending
            runs = _split_into_runs(words, diar_segs) if words else None

            if runs is None and words:
                # Words are present but none had any diar coverage.
                # Defer — the next diar pass will reattempt.
                still_pending.append(pending)
                continue

            if runs is None:
                # No words at all: fall back to per-segment assign_speaker
                # so very short utterances still get attributed.
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
                )
                continue

            # One final per run. First run inherits the partial's seq;
            # additional runs allocate fresh seqs.
            for i, run in enumerate(runs):
                run_seq = seq if i == 0 else session.next_seq()
                if run.speaker_id not in sent_speakers:
                    sent_speakers.add(run.speaker_id)
                    await ws.send_text(SpeakerAssignedMsg(
                        speaker_id=run.speaker_id,
                        color_hint=session.color_hint_for(run.speaker_id),
                    ).model_dump_json())
                await ws.send_text(TranscriptFinalMsg(
                    seq=run_seq, text=run.text,
                    t_start_ms=run.t_start_ms, t_end_ms=run.t_end_ms,
                    speaker_id=run.speaker_id,
                ).model_dump_json())
                session.append_final(
                    seq=run_seq, text=run.text, speaker_id=run.speaker_id,
                    t_start=run.t_start_ms / 1000.0,
                    t_end=run.t_end_ms / 1000.0,
                )
        pending_finals[:] = still_pending
```

- [ ] **Step 4: Run full svc test suite**

```
ssh node4 'cd ~/cairn-svc && .venv/bin/python -m pytest -q 2>&1 | tail -5'
```
Expected: all tests pass. Count = 156 (155 prior + 9 from Task 1 + 4 from Task 3 − overlap). Confirm a number ≥ 168 if your prior count was 155; if you see fewer additions, recount which tests landed.

If `test_smoke_ws.py` or any other smoke test that drove the WS path was previously failing because of the Task 2 tuple-shape change, it should now pass. If any test fails, fix the production code (not the test) unless the test is actually wrong.

- [ ] **Step 5: Commit**

```
ssh node4 'cd ~/cairn-svc && git add cairn_svc/server.py tests/test_drain_pending.py && git commit -m "feat(svc): split mixed-speaker pendings into per-speaker finals at word granularity"'
```

---

## Task 4: Deploy + verify

**Files:** none modified.

- [ ] **Step 1: Restart cairn-svc**

```
ssh node4 'systemctl --user restart cairn-svc && sleep 3 && systemctl --user is-active cairn-svc'
```
Expected: `active`.

- [ ] **Step 2: Tail recent log to confirm clean startup**

```
ssh node4 'journalctl --user -u cairn-svc -n 10 --no-pager 2>&1 | tail -10'
```
Expected: no traceback; "Application startup complete" present.

- [ ] **Step 3: No client rebuild needed**

This change is server-only — no rebuild or relaunch of `Cairn.app`. The client already handles multiple `transcript_final` events with their own seqs (it's an existing protocol shape). Tell the user: "Word-level split is live on node4. Run a test to verify cross-speaker bleeding is gone."

---

## Self-review checklist

- [x] Spec section "Pipeline shape" → Tasks 1, 2, 3 collectively
- [x] Spec section "_split_into_runs" → Task 1
- [x] Spec section "Whisper-returned-no-words fallback" → Task 3, Step 3 (the `if runs is None and not words:` branch falls back to `assign_speaker`)
- [x] Spec section "Seq allocation" → Task 3, Step 3 (`run_seq = seq if i == 0 else session.next_seq()`)
- [x] Spec section "Speaker-assigned emission" → Task 3, Step 3 (sent_speakers check inside run loop)
- [x] Spec section "Ledger writes" → Task 3, Step 3 (`session.append_final` per run)
- [x] Edge case: single-speaker pending → Task 1 test `test_single_speaker_returns_one_run` and Task 3 test `test_single_speaker_pending_emits_one_final_with_original_seq`
- [x] Edge case: only unknown words → Task 1 test `test_all_words_unknown_returns_none` and Task 3 test `test_all_unknown_pending_stays_pending`
- [x] Edge case: mixed unknown/known → Task 1 tests `test_unknown_word_attributed_to_preceding_neighbor` and `test_unknown_word_at_start_attributed_to_following_neighbor`
- [x] Edge case: whisper words empty → Task 1 test `test_words_empty_falls_back_to_no_runs` and Task 3 fallback path
- [x] No placeholders / TODOs in plan
- [x] Type/method names consistent: `_split_into_runs`, `_Run`, `TranscriptWord`, `DiarizationSegment`, `pending_finals` 5-tuple shape
