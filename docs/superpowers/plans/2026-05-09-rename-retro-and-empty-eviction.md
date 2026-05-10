# Rename Retro-Substitution + Sanity Pass + Empty-Speaker Eviction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the user renames a stable_id, retroactively rewrite every stored rolling summary and the cached final summary so all variants of the old label become the new name; sanitize every freshly-generated LLM summary the same way before storing/emitting; evict empty-ledger speakers from the panel even when the cosine floor blocks a normal merge.

**Architecture:** A single regex helper `substitute_speaker_variants` lives in `cairn_svc/summarize.py`. The rename handler in `cairn_svc/server.py` walks `Session._rolling` and `Session._final_summary` (new field), substitutes via the helper plus a `\b`-anchored previous-name pass, and re-emits `RollingSummaryReplaceMsg` and `FinalSummaryMsg` (both already handled by the client). Inside `Summarizer.run_one_window` and `Summarizer.run_final`, after the LLM call, we sanitize the freshly-generated bullets/strings using the same helper for every renamed sid in `_name_for_stable`. `_orphan_sweep` gets a small relaxation so an orphan with both zero finals and zero ledger speech bypasses `min_cos`.

**Tech Stack:** Python 3.11, pytest, FastAPI WebSockets, pydantic, numpy. Client is TypeScript/Electron but already supports `rolling_summary_replace` and `final_summary` overwrite — no client change.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `cairn_svc/summarize.py` | New `substitute_speaker_variants(text, sid, name)` helper. Modify `Summarizer.run_one_window` and `Summarizer.run_final` to apply the sanity pass before store/emit. |
| `cairn_svc/session.py` | Add `_final_summary: dict \| None = None`, `set_final_summary(payload)`, `get_final_summary()`, `apply_to_rolling(transform)` for in-place bullet rewrite. |
| `cairn_svc/server.py` | `SpeakerRenameMsg` handler now calls a new `_apply_rename_retro` coroutine that rewrites stored summaries and re-emits. `_orphan_sweep` relaxed for fully-empty orphans. |
| `cairn_svc/protocol.py` | No change — reuses `RollingSummaryReplaceMsg` and `FinalSummaryMsg`. |
| `tests/test_summarize.py` | Variant-helper unit tests; sanity-pass behaviour tests. |
| `tests/test_rename_retro.py` (new) | Rename retro-rewrite tests for rolling + final. |
| `tests/test_authoritative.py` | Empty-orphan eviction test. |
| Renderer | No change. |

---

## Task 1: `substitute_speaker_variants` helper

**Files:**
- Modify: `cairn_svc/summarize.py` (add helper near `_label`/`_speaker_labels_block`, ~line 130)
- Test: `tests/test_summarize.py`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_summarize.py`:

```python
from cairn_svc.summarize import substitute_speaker_variants


def test_substitute_basic_stable_id():
    assert substitute_speaker_variants("S1 spoke", "S1", "Lex") == "Lex spoke"
    assert substitute_speaker_variants("s1 spoke", "S1", "Lex") == "Lex spoke"
    assert substitute_speaker_variants("P1 spoke", "S1", "Lex") == "Lex spoke"
    assert substitute_speaker_variants("p1 spoke", "S1", "Lex") == "Lex spoke"


def test_substitute_word_forms():
    for v in ["Speaker 1", "speaker 1", "Speaker1", "speaker1",
              "speaker_1", "Speaker_1",
              "Person 1", "person 1", "Person1", "person1",
              "person_1", "Person_1",
              "Spkr 1", "spkr 1", "Spkr1", "spkr1", "spkr_1",
              "S 1", "s 1", "P 1", "p 1"]:
        assert substitute_speaker_variants(f"{v} said hi", "S1", "Lex") == "Lex said hi", v


def test_substitute_does_not_match_neighboring_digits():
    # S1 should not match inside S10, S11, S100, etc.
    assert substitute_speaker_variants("S10 spoke", "S1", "Lex") == "S10 spoke"
    assert substitute_speaker_variants("S100 said", "S1", "Lex") == "S100 said"
    assert substitute_speaker_variants("Speaker 10", "S1", "Lex") == "Speaker 10"
    assert substitute_speaker_variants("Speaker 11", "S1", "Lex") == "Speaker 11"


def test_substitute_does_not_match_inside_words():
    assert substitute_speaker_variants("subspeaker1text", "S1", "Lex") == "subspeaker1text"
    assert substitute_speaker_variants("xS1y", "S1", "Lex") == "xS1y"


def test_substitute_multiple_variants_same_text():
    out = substitute_speaker_variants(
        "S1 met Speaker 1; later s1 and Person 1 chatted.", "S1", "Lex",
    )
    assert out == "Lex met Lex; later Lex and Lex chatted."


def test_substitute_preserves_replacement_case():
    # The supplied name is inserted verbatim regardless of source variant case.
    assert substitute_speaker_variants("speaker 1 hi", "S1", "Lex Fridman") == "Lex Fridman hi"


def test_substitute_no_match_returns_input_unchanged():
    assert substitute_speaker_variants("nothing to see", "S1", "Lex") == "nothing to see"


def test_substitute_handles_two_digit_sid():
    assert substitute_speaker_variants("S10 said", "S10", "Guest") == "Guest said"
    assert substitute_speaker_variants("Speaker 10", "S10", "Guest") == "Guest"
    # And does not bleed into S1/S100.
    assert substitute_speaker_variants("S1 met S100", "S10", "Guest") == "S1 met S100"
```

- [ ] **Step 2: Run tests to verify they fail**

Run on node4: `cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_summarize.py -k substitute -v`
Expected: ImportError / "cannot import name 'substitute_speaker_variants'".

- [ ] **Step 3: Implement the helper**

Insert in `cairn_svc/summarize.py` immediately after `_label` (around line 144):

```python
import re as _re

# Variants the helper recognises, parameterised on the digit suffix. Each entry
# is the prefix; the regex appends the digit + word boundary.
_VARIANT_PREFIXES = (
    r"S",            # S1, s1
    r"P",            # P1, p1
    r"S\s+",         # "S 1"
    r"P\s+",         # "P 1"
    r"Speaker\s*",   # Speaker 1, Speaker1
    r"Speaker_",     # Speaker_1
    r"Person\s*",    # Person 1, Person1
    r"Person_",      # Person_1
    r"Spkr\s*",      # Spkr 1, Spkr1
    r"Spkr_",        # Spkr_1
    r"speaker_",     # speaker_1 (lowercase distinct because case-insensitive
                     # regex below covers both, but we keep this for clarity)
    r"person_",
    r"spkr_",
)


def substitute_speaker_variants(text: str, sid: str, name: str) -> str:
    """Replace every variant of ``sid`` (e.g. S1, s1, P1, Speaker 1, Spkr_1)
    with ``name``. Word-boundary anchored, digit-exact: S1 does not match
    S10, S100, S1A, or substrings inside other words. Case-insensitive on
    the prefix; the supplied ``name`` is inserted verbatim.
    """
    m = _re.fullmatch(r"[A-Za-z]+(\d+)", sid)
    if not m:
        return text
    digit = m.group(1)
    alternation = "|".join(_VARIANT_PREFIXES)
    pattern = _re.compile(
        rf"(?<![A-Za-z0-9_])(?:{alternation}){digit}(?![0-9])",
        _re.IGNORECASE,
    )
    return pattern.sub(name, text)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_summarize.py -k substitute -v`
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add cairn-svc/cairn_svc/summarize.py cairn-svc/tests/test_summarize.py
git commit -m "feat(svc): substitute_speaker_variants helper for retro rename rewrites"
```

(All `git add` paths are relative to the repo root on node4. The svc lives at `~/cairn-svc/`.)

---

## Task 2: Session API for final-summary cache + transform

**Files:**
- Modify: `cairn_svc/session.py` (add fields and methods near `rolling_entries_all`, ~line 290)
- Test: `tests/test_session.py`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_session.py`:

```python
def test_session_final_summary_get_set():
    from cairn_svc.session import Session
    s = Session(meeting_name="t")
    assert s.get_final_summary() is None
    payload = {"ok": True, "tldr": "hello", "speakers": []}
    s.set_final_summary(payload)
    assert s.get_final_summary() == payload


def test_session_apply_to_rolling_rewrites_in_place():
    from cairn_svc.session import Session
    s = Session(meeting_name="t")
    s.add_rolling_entry(
        window_start_s=0.0, window_end_s=10.0,
        bullets=["S1 said hi", "S2 said bye"],
        merged_from_failed_prior=False,
    )
    s.add_rolling_entry(
        window_start_s=10.0, window_end_s=20.0,
        bullets=["Speaker 1 continued"],
        merged_from_failed_prior=False,
    )
    s.apply_to_rolling(lambda b: b.replace("S1", "Lex").replace("Speaker 1", "Lex"))
    entries = s.rolling_entries_all()
    assert entries[0]["bullets"] == ["Lex said hi", "S2 said bye"]
    assert entries[1]["bullets"] == ["Lex continued"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_session.py -k 'final_summary or apply_to_rolling' -v`
Expected: AttributeError on `set_final_summary` / `apply_to_rolling`.

- [ ] **Step 3: Implement**

Edit `cairn_svc/session.py`. Add to `__init__` (immediately after `self._rolling: list[dict] = []` line, near line 60):

```python
        self._final_summary: dict | None = None
```

Add methods immediately after `replace_rolling_entry` (around line 290):

```python
    def set_final_summary(self, payload: dict) -> None:
        """Cache the most recently emitted final_summary payload so that
        downstream code (e.g. SpeakerRenameMsg handling) can rewrite it
        retroactively and re-emit."""
        self._final_summary = dict(payload)

    def get_final_summary(self) -> dict | None:
        return self._final_summary

    def apply_to_rolling(self, transform: "Callable[[str], str]") -> None:
        """Run ``transform`` over every bullet in every rolling entry in
        place. Used by SpeakerRenameMsg handling to rewrite stored bullets
        without resorting through the LLM."""
        for entry in self._rolling:
            entry["bullets"] = [transform(b) for b in entry["bullets"]]
```

Also ensure `Callable` is imported at the top. Add (or extend the existing typing import):

```python
from typing import Callable  # if not already present
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_session.py -k 'final_summary or apply_to_rolling' -v`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add cairn-svc/cairn_svc/session.py cairn-svc/tests/test_session.py
git commit -m "feat(svc): Session.set_final_summary + apply_to_rolling for retro rewrites"
```

---

## Task 3: Cache final-summary payload in Summarizer.run_final

**Files:**
- Modify: `cairn_svc/summarize.py` (`run_final`, ~lines 398–425)
- Test: `tests/test_summarize.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_summarize.py`:

```python
async def test_run_final_caches_payload_on_session(monkeypatch):
    """run_final should set session._final_summary so later renames can
    rewrite + re-emit it."""
    from cairn_svc.session import Session
    from cairn_svc.summarize import Summarizer, SummarizerConfig
    from cairn_svc.llm_client import LLMClient

    session = Session(meeting_name="t")
    session.append_final(seq=1, text="hi", speaker_id="S1", t_start=0.0, t_end=1.0)
    session.add_rolling_entry(
        window_start_s=0.0, window_end_s=1.0,
        bullets=["S1 said hi"], merged_from_failed_prior=False,
    )

    class FakeLLM:
        async def chat_json(self, *a, **kw):
            return {
                "tldr": "all good", "speakers": [],
                "decisions": [], "action_items": [],
            }

    emitted: list[dict] = []
    async def emit(m): emitted.append(m)

    cfg = SummarizerConfig(
        window_s=150.0, vad_slip_max_s=10.0, edit_debounce_s=0.5,
        final_drain_s=0.5, queue_max=2, timeout_s=5.0,
        num_ctx_final=4096, model="fake", enabled=True,
    )
    s = Summarizer(
        session=session, llm=FakeLLM(), cfg=cfg, emit=emit,
        vad_silence_at=lambda t: None, session_start_s=0.0,
    )

    await s.run_final()
    cached = session.get_final_summary()
    assert cached is not None
    assert cached["ok"] is True
    assert cached["tldr"] == "all good"
    assert any(m["type"] == "final_summary" for m in emitted)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_summarize.py -k caches_payload -v`
Expected: AssertionError — `cached` is None.

- [ ] **Step 3: Implement**

In `cairn_svc/summarize.py::run_final`, after the successful-result branch builds the payload, store it on the session before emitting. Replace this block (around line 401):

```python
            await self.emit({
                "type": "final_summary",
                "ok": True,
                "tldr": result.get("tldr", ""),
                "speakers": result.get("speakers", []),
                "decisions": result.get("decisions", []),
                "action_items": result.get("action_items", []),
                "truncated": truncated,
                "model": self.cfg.model,
                "generated_at": _time.time(),
            })
```

with:

```python
            payload = {
                "type": "final_summary",
                "ok": True,
                "tldr": result.get("tldr", ""),
                "speakers": result.get("speakers", []),
                "decisions": result.get("decisions", []),
                "action_items": result.get("action_items", []),
                "truncated": truncated,
                "model": self.cfg.model,
                "generated_at": _time.time(),
            }
            self.session.set_final_summary(payload)
            await self.emit(payload)
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_summarize.py -k caches_payload -v`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add cairn-svc/cairn_svc/summarize.py cairn-svc/tests/test_summarize.py
git commit -m "feat(svc): cache final_summary payload on session for retro rewrites"
```

---

## Task 4: Sanity pass on rolling-summary LLM output

**Files:**
- Modify: `cairn_svc/summarize.py::run_one_window` (around line 310)
- Test: `tests/test_summarize.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_summarize.py`:

```python
async def test_run_one_window_sanitizes_leaked_label():
    """If the LLM returns a bullet that mentions S1 but the user has
    renamed S1 to Lex, the stored + emitted bullets must say Lex."""
    from cairn_svc.session import Session
    from cairn_svc.summarize import Summarizer, SummarizerConfig

    session = Session(meeting_name="t")
    session.set_name("S1", "Lex")
    session.append_final(seq=1, text="hello", speaker_id="S1",
                         t_start=0.0, t_end=2.0)

    class FakeLLM:
        async def chat_json(self, *a, **kw):
            return {"bullets": ["S1 introduces the topic.", "Lex elaborates."]}

    emitted: list[dict] = []
    async def emit(m): emitted.append(m)

    cfg = SummarizerConfig(
        window_s=150.0, vad_slip_max_s=10.0, edit_debounce_s=0.5,
        final_drain_s=0.5, queue_max=2, timeout_s=5.0,
        num_ctx_final=4096, model="fake", enabled=True,
    )
    s = Summarizer(
        session=session, llm=FakeLLM(), cfg=cfg, emit=emit,
        vad_silence_at=lambda t: None, session_start_s=0.0,
    )

    await s.run_one_window(window_start_s=0.0, window_end_s=10.0)

    stored = session.rolling_entries_all()[0]["bullets"]
    assert stored == ["Lex introduces the topic.", "Lex elaborates."]
    rolling = next(m for m in emitted if m["type"] == "rolling_summary")
    assert rolling["bullets"] == ["Lex introduces the topic.", "Lex elaborates."]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_summarize.py -k sanitizes_leaked -v`
Expected: AssertionError — bullet still contains "S1".

- [ ] **Step 3: Implement**

In `cairn_svc/summarize.py::run_one_window`, after `bullets = list(result.get("bullets", []))` and before `idx = self.session.add_rolling_entry(...)`, insert:

```python
        # Sanity pass: substitute any label variants the LLM may have leaked
        # despite the SPEAKER LABELS prompt header. Idempotent — running it
        # against fully-substituted text is a no-op.
        bullets = _sanitize_label_leaks(bullets, self.session)
```

Then add a private helper near the top of the file (right after `substitute_speaker_variants`):

```python
def _sanitize_label_leaks(bullets: list[str], session) -> list[str]:
    """Walk every (sid, name) in session._name_for_stable and substitute
    every variant in every bullet. Catches LLM leaks like "S1 mentions..."
    appearing alongside named speakers in the same window."""
    name_map = {sid: nm for sid, nm in session._name_for_stable.items() if nm}
    if not name_map:
        return bullets
    out: list[str] = []
    for b in bullets:
        for sid, nm in name_map.items():
            b = substitute_speaker_variants(b, sid, nm)
        out.append(b)
    return out
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_summarize.py -k sanitizes_leaked -v`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add cairn-svc/cairn_svc/summarize.py cairn-svc/tests/test_summarize.py
git commit -m "feat(svc): sanitize leaked stable-id labels in rolling-summary LLM output"
```

---

## Task 5: Sanity pass on final-summary LLM output

**Files:**
- Modify: `cairn_svc/summarize.py::run_final` (around line 401)
- Test: `tests/test_summarize.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_summarize.py`:

```python
async def test_run_final_sanitizes_leaked_labels():
    from cairn_svc.session import Session
    from cairn_svc.summarize import Summarizer, SummarizerConfig

    session = Session(meeting_name="t")
    session.set_name("S1", "Lex")
    session.set_name("S2", "Dario")
    session.append_final(seq=1, text="hi", speaker_id="S1",
                         t_start=0.0, t_end=1.0)
    session.add_rolling_entry(
        window_start_s=0.0, window_end_s=1.0,
        bullets=["S1 chats"], merged_from_failed_prior=False,
    )

    class FakeLLM:
        async def chat_json(self, *a, **kw):
            return {
                "tldr": "S1 and Speaker 2 talked about scaling.",
                "speakers": [
                    {"speaker": "S1",
                     "contributions": ["S1 introduced scaling.",
                                       "person 1 followed up."]},
                    {"speaker": "Dario",
                     "contributions": ["Dario explained details."]},
                ],
                "decisions": [], "action_items": [],
            }

    emitted: list[dict] = []
    async def emit(m): emitted.append(m)

    cfg = SummarizerConfig(
        window_s=150.0, vad_slip_max_s=10.0, edit_debounce_s=0.5,
        final_drain_s=0.5, queue_max=2, timeout_s=5.0,
        num_ctx_final=4096, model="fake", enabled=True,
    )
    s = Summarizer(
        session=session, llm=FakeLLM(), cfg=cfg, emit=emit,
        vad_silence_at=lambda t: None, session_start_s=0.0,
    )
    await s.run_final()

    msg = next(m for m in emitted if m["type"] == "final_summary")
    assert msg["tldr"] == "Lex and Dario talked about scaling."
    s1_block = next(b for b in msg["speakers"] if b["speaker"] == "Lex")
    assert s1_block["contributions"] == [
        "Lex introduced scaling.", "Lex followed up.",
    ]
    cached = session.get_final_summary()
    assert cached["tldr"] == msg["tldr"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_summarize.py -k run_final_sanitizes -v`
Expected: AssertionError — strings still contain "S1" / "Speaker 2" / "person 1".

- [ ] **Step 3: Implement**

Add a helper near `_sanitize_label_leaks`:

```python
def _sanitize_final_payload(payload: dict, session) -> dict:
    """Apply substitute_speaker_variants to every text field in a
    final_summary payload using the current name_for_stable map. Also
    rewrites the speaker block's 'speaker' field so a leaked stable-id
    title (e.g. {"speaker": "S1", ...}) becomes the assigned name."""
    name_map = {sid: nm for sid, nm in session._name_for_stable.items() if nm}
    if not name_map:
        return payload

    def _sub(s: str) -> str:
        for sid, nm in name_map.items():
            s = substitute_speaker_variants(s, sid, nm)
        return s

    payload = dict(payload)
    payload["tldr"] = _sub(payload.get("tldr", ""))
    new_speakers = []
    for blk in payload.get("speakers", []):
        new_speakers.append({
            **blk,
            "speaker": _sub(blk.get("speaker", "")),
            "contributions": [_sub(c) for c in blk.get("contributions", [])],
        })
    payload["speakers"] = new_speakers
    payload["decisions"] = [_sub(d) for d in payload.get("decisions", [])]
    payload["action_items"] = [_sub(a) for a in payload.get("action_items", [])]
    return payload
```

In `run_final`, change the previously-introduced payload block to:

```python
            payload = {
                "type": "final_summary",
                "ok": True,
                "tldr": result.get("tldr", ""),
                "speakers": result.get("speakers", []),
                "decisions": result.get("decisions", []),
                "action_items": result.get("action_items", []),
                "truncated": truncated,
                "model": self.cfg.model,
                "generated_at": _time.time(),
            }
            payload = _sanitize_final_payload(payload, self.session)
            self.session.set_final_summary(payload)
            await self.emit(payload)
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_summarize.py -k run_final_sanitizes -v`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add cairn-svc/cairn_svc/summarize.py cairn-svc/tests/test_summarize.py
git commit -m "feat(svc): sanitize leaked labels in final_summary LLM output"
```

---

## Task 6: Rename handler — retro-rewrite rolling entries

**Files:**
- Modify: `cairn_svc/server.py` `SpeakerRenameMsg` branch (around line 1036) + add `_apply_rename_retro`
- Test: `tests/test_rename_retro.py` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/test_rename_retro.py`:

```python
"""Retroactive rewrite of stored summaries when a speaker is renamed."""
import pytest


async def test_rename_rewrites_stored_rolling_entries_and_emits_replace():
    from cairn_svc.session import Session
    from cairn_svc.server import _apply_rename_retro

    session = Session(meeting_name="t")
    session.add_rolling_entry(
        window_start_s=0.0, window_end_s=10.0,
        bullets=["S1 introduces topic", "S2 replies"],
        merged_from_failed_prior=False,
    )
    session.add_rolling_entry(
        window_start_s=10.0, window_end_s=20.0,
        bullets=["Speaker 1 continues"],
        merged_from_failed_prior=False,
    )

    emitted: list[dict] = []
    async def emit(m): emitted.append(m)

    await _apply_rename_retro(session, emit, sid="S1", new_name="Lex", prev_name=None)

    entries = session.rolling_entries_all()
    assert entries[0]["bullets"] == ["Lex introduces topic", "S2 replies"]
    assert entries[1]["bullets"] == ["Lex continues"]
    replaces = [m for m in emitted if m["type"] == "rolling_summary_replace"]
    assert {m["idx"] for m in replaces} == {0, 1}
    for m in replaces:
        assert m["reason"] == "rename"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_rename_retro.py -k rolling_entries -v`
Expected: ImportError on `_apply_rename_retro`.

- [ ] **Step 3: Implement**

In `cairn_svc/server.py`, add a module-level helper near the existing helpers (before `def _emit_msg` is defined inside `ws_transcribe`, e.g. just after `_orphan_sweep` ends):

```python
async def _apply_rename_retro(
    session: "Session",
    emit: "Callable[[dict], Awaitable[None]]",
    *,
    sid: str,
    new_name: str,
    prev_name: str | None,
) -> None:
    """Retroactively rewrite every stored summary so previously-emitted
    text uses ``new_name`` instead of ``sid``-style labels (or the prior
    user-assigned name). Re-emits ``rolling_summary_replace`` per affected
    rolling entry and ``final_summary`` if a final has been cached.
    """
    import re as _re
    from .summarize import substitute_speaker_variants
    import time as _time

    def _rewrite(text: str) -> str:
        text = substitute_speaker_variants(text, sid, new_name)
        if prev_name and prev_name != new_name:
            text = _re.sub(
                r"\b" + _re.escape(prev_name) + r"\b", new_name, text,
            )
        return text

    # Rolling entries: rewrite in place + re-emit each affected entry.
    affected: list[int] = []
    for entry in session.rolling_entries_all():
        before = list(entry["bullets"])
        rewritten = [_rewrite(b) for b in before]
        if rewritten != before:
            entry["bullets"] = rewritten
            affected.append(entry["idx"])
    for idx in affected:
        e = session.rolling_entries_all()[idx]
        await emit({
            "type": "rolling_summary_replace",
            "idx": idx,
            "bullets": list(e["bullets"]),
            "generated_at": _time.time(),
            "reason": "rename",
        })

    # Final summary: rewrite + re-emit if cached.
    final = session.get_final_summary()
    if final is not None:
        new_final = dict(final)
        new_final["tldr"] = _rewrite(new_final.get("tldr", ""))
        new_speakers = []
        for blk in new_final.get("speakers", []):
            new_speakers.append({
                **blk,
                "speaker": _rewrite(blk.get("speaker", "")),
                "contributions": [_rewrite(c) for c in blk.get("contributions", [])],
            })
        new_final["speakers"] = new_speakers
        new_final["decisions"] = [_rewrite(d) for d in new_final.get("decisions", [])]
        new_final["action_items"] = [_rewrite(a) for a in new_final.get("action_items", [])]
        new_final["generated_at"] = _time.time()
        session.set_final_summary(new_final)
        await emit(new_final)
```

Add the `Awaitable, Callable` import near the top of `server.py` if not already present:

```python
from typing import Awaitable, Callable, Optional
```

(Replace the existing `from typing import Optional` line.)

Now wire the rename handler. Replace:

```python
                elif isinstance(ctrl, SpeakerRenameMsg):
                    log.info("rename %s -> %s", ctrl.speaker_id, ctrl.name)
```

with the full handler (insert after the log line, BEFORE the next `elif`):

```python
                elif isinstance(ctrl, SpeakerRenameMsg):
                    if session is None:
                        continue
                    prev = session.name_for(ctrl.speaker_id)
                    log.info("rename %s -> %s", ctrl.speaker_id, ctrl.name)
                    session.set_name(ctrl.speaker_id, ctrl.name)
                    await _apply_rename_retro(
                        session, _emit_msg,
                        sid=ctrl.speaker_id, new_name=ctrl.name, prev_name=prev,
                    )
```

(Keep the existing branch logic intact otherwise; the diff above shows the new shape.)

- [ ] **Step 4: Run tests to verify pass**

Run: `cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_rename_retro.py -k rolling_entries -v`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add cairn-svc/cairn_svc/server.py cairn-svc/tests/test_rename_retro.py
git commit -m "feat(svc): retro-rewrite stored rolling summaries on speaker rename"
```

---

## Task 7: Rename handler — retro-rewrite final summary

**Files:**
- Test: `tests/test_rename_retro.py`
- (No code change — Task 6's `_apply_rename_retro` already handles the final-summary path; this task locks in test coverage.)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_rename_retro.py`:

```python
async def test_rename_rewrites_cached_final_summary():
    from cairn_svc.session import Session
    from cairn_svc.server import _apply_rename_retro

    session = Session(meeting_name="t")
    session.set_final_summary({
        "type": "final_summary",
        "ok": True,
        "tldr": "S1 and Speaker 2 covered scaling.",
        "speakers": [
            {"speaker": "S1", "contributions": ["S1 introduces topic"]},
            {"speaker": "S2", "contributions": ["Speaker 2 replies"]},
        ],
        "decisions": ["S1 wins"],
        "action_items": ["S1 follows up"],
        "truncated": False, "model": "fake", "generated_at": 0.0,
    })

    emitted: list[dict] = []
    async def emit(m): emitted.append(m)

    await _apply_rename_retro(session, emit,
                              sid="S1", new_name="Lex", prev_name=None)

    msg = next(m for m in emitted if m["type"] == "final_summary")
    assert msg["tldr"] == "Lex and Speaker 2 covered scaling."
    assert msg["speakers"][0] == {
        "speaker": "Lex",
        "contributions": ["Lex introduces topic"],
    }
    assert msg["decisions"] == ["Lex wins"]
    assert msg["action_items"] == ["Lex follows up"]
    cached = session.get_final_summary()
    assert cached["tldr"] == msg["tldr"]


async def test_rename_substitutes_previous_name_too():
    """Rename Lex -> Lex Fridman after prior Lex rename: bullets that
    already say 'Lex' (from the first rename) should now say 'Lex Fridman',
    word-boundary anchored so 'Alex' is left alone."""
    from cairn_svc.session import Session
    from cairn_svc.server import _apply_rename_retro

    session = Session(meeting_name="t")
    session.add_rolling_entry(
        window_start_s=0.0, window_end_s=10.0,
        bullets=["Lex talked, Alex listened, S1 jumped in"],
        merged_from_failed_prior=False,
    )

    emitted: list[dict] = []
    async def emit(m): emitted.append(m)

    await _apply_rename_retro(session, emit,
                              sid="S1", new_name="Lex Fridman", prev_name="Lex")
    assert session.rolling_entries_all()[0]["bullets"] == [
        "Lex Fridman talked, Alex listened, Lex Fridman jumped in"
    ]
```

- [ ] **Step 2: Run tests to verify pass**

Run: `cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_rename_retro.py -v`
Expected: 3 tests pass (the rolling test from Task 6 + these two).

- [ ] **Step 3: Commit**

```bash
git add cairn-svc/tests/test_rename_retro.py
git commit -m "test(svc): retro-rewrite covers final-summary + previous-name path"
```

---

## Task 8: Empty-orphan eviction in `_orphan_sweep`

**Files:**
- Modify: `cairn_svc/server.py::_orphan_sweep` (around lines 200–260)
- Test: `tests/test_authoritative.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_authoritative.py`:

```python
def test_orphan_sweep_evicts_zero_ledger_orphan_below_cos_floor():
    """An orphan with 0 finals AND 0 s of ledger speech should be merged
    into the closest other speaker REGARDLESS of cosine floor — nothing
    is misattributed because there are no lines to redirect, only the
    panel entry to evict."""
    from cairn_svc.server import _orphan_sweep
    from cairn_svc.session import Session
    s = Session(meeting_name="t")
    # Real speaker with healthy ledger.
    s.mint_stable_id()  # S1
    s.update_auth_centroid("S1", _emb(1.0, 0.0))
    s.append_final(seq=1, text="x", speaker_id="S1", t_start=0.0, t_end=5.0)
    s.append_final(seq=2, text="x", speaker_id="S1", t_start=6.0, t_end=11.0)
    s.append_final(seq=3, text="x", speaker_id="S1", t_start=12.0, t_end=17.0)
    # Empty orphan whose centroid is orthogonal to S1 (cos=0, well below 0.5).
    s.mint_stable_id()  # S2
    s.update_auth_centroid("S2", _emb(0.0, 1.0))

    relabels, merges = _orphan_sweep(
        s, min_finals=3, min_speech_s=4.0, min_cos=0.5,
    )
    assert relabels == []  # nothing to redirect
    assert merges == [("S2", "S1")]
    assert "S2" not in s._auth_centroids


def test_orphan_sweep_keeps_cos_floor_for_non_empty_orphan():
    """A non-empty orphan still respects min_cos so a real cameo isn't
    mis-merged."""
    from cairn_svc.server import _orphan_sweep
    from cairn_svc.session import Session
    s = Session(meeting_name="t")
    s.mint_stable_id()  # S1
    s.update_auth_centroid("S1", _emb(1.0, 0.0))
    s.append_final(seq=1, text="x", speaker_id="S1", t_start=0.0, t_end=5.0)
    s.append_final(seq=2, text="x", speaker_id="S1", t_start=6.0, t_end=11.0)
    s.append_final(seq=3, text="x", speaker_id="S1", t_start=12.0, t_end=17.0)
    # Cameo: 1 final, 1 s of speech, orthogonal centroid.
    s.mint_stable_id()  # S2
    s.update_auth_centroid("S2", _emb(0.0, 1.0))
    s.append_final(seq=4, text="cameo", speaker_id="S2", t_start=18.0, t_end=19.0)

    relabels, merges = _orphan_sweep(
        s, min_finals=3, min_speech_s=4.0, min_cos=0.5,
    )
    assert merges == []  # cosine floor protects the cameo
    assert "S2" in s._auth_centroids
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_authoritative.py -k 'evicts_zero_ledger or keeps_cos_floor' -v`
Expected: first test fails (no merge emitted because cos < min_cos).

- [ ] **Step 3: Implement**

In `cairn_svc/server.py::_orphan_sweep`, locate the loop that picks `best_target`. Replace this block:

```python
        # Pick the closest non-orphan auth centroid above the cosine floor.
        best_target: str | None = None
        best_cos = min_cos
        for sid, centroid in session._auth_centroids.items():
            if sid == orphan or sid in orphan_set:
                continue
            c = float(_cosine(e_orphan, centroid))
            if c > best_cos:
                best_cos = c
                best_target = sid
        if best_target is None:
            continue
```

with:

```python
        # An orphan with zero finals AND zero ledger speech is empty —
        # nothing is attributed to it, so the merge is purely cosmetic
        # and we can ignore the cosine floor entirely. Otherwise apply
        # the floor so a brief real cameo isn't mis-merged.
        empty = (
            counts.get(orphan, 0) == 0
            and speech_s.get(orphan, 0.0) == 0.0
        )
        floor = 0.0 if empty else min_cos
        best_target: str | None = None
        best_cos = floor
        for sid, centroid in session._auth_centroids.items():
            if sid == orphan or sid in orphan_set:
                continue
            c = float(_cosine(e_orphan, centroid))
            if c > best_cos:
                best_cos = c
                best_target = sid
        # For empty orphans we accept any non-orphan target. For non-empty
        # ones, we keep the prior behaviour (skip if no candidate above
        # the floor).
        if best_target is None:
            if not empty:
                continue
            # Empty orphan with no other auth centroid at all — pick the
            # first non-orphan sid if one exists in _auth_centroids,
            # otherwise skip (pathological solo session).
            for sid in session._auth_centroids:
                if sid != orphan and sid not in orphan_set:
                    best_target = sid
                    break
            if best_target is None:
                continue
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_authoritative.py -k 'evicts_zero_ledger or keeps_cos_floor' -v`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add cairn-svc/cairn_svc/server.py cairn-svc/tests/test_authoritative.py
git commit -m "feat(svc): evict empty-orphan speakers below cosine floor"
```

---

## Task 9: Full svc test suite + svc restart

**Files:** none modified — verification step.

- [ ] **Step 1: Run full svc test suite**

Run on node4: `cd ~/cairn-svc && .venv/bin/python -m pytest -q`
Expected: all tests pass. Count should be prior 132 + 8 (Task 1) + 2 (Task 2) + 1 (Task 3) + 1 (Task 4) + 1 (Task 5) + 1 (Task 6) + 2 (Task 7) + 2 (Task 8) = 150 passed.

If any failure occurs, fix it (do not skip / xfail) and re-run before committing further.

- [ ] **Step 2: Restart cairn-svc**

```bash
ssh node4 'systemctl --user restart cairn-svc && sleep 3 && systemctl --user is-active cairn-svc'
```

Expected output: `active`.

- [ ] **Step 3: Tail recent logs to confirm clean startup**

```bash
ssh node4 'journalctl --user -u cairn-svc -n 10 --no-pager 2>&1 | tail -10'
```

Expected: no traceback, "Application startup complete" line present.

---

## Task 10: Rebuild client + relaunch app

**Files:** none modified — packaging step.

- [ ] **Step 1: Rebuild and refresh symlink**

Run from `/Users/nickcason/dev/cairn`:

```bash
npm run install-app
```

Expected last line: `Cairn linked at /Applications/Cairn.app -> dist-app/mac-arm64/Cairn.app`.

- [ ] **Step 2: Quit running Cairn**

```bash
osascript -e 'tell application "Cairn" to quit' && sleep 2
pgrep -af "Cairn.app/Contents/MacOS" || echo "no Cairn process running"
```

Expected: "no Cairn process running".

- [ ] **Step 3: Relaunch**

```bash
open /Applications/Cairn.app && sleep 2 && pgrep -af "Cairn.app/Contents/MacOS" | head -3
```

Expected: at least one PID printed.

---

## Self-review checklist

- [x] Spec section 1 (helper) → Task 1
- [x] Spec section 2 (rename retro rewrite) → Tasks 6 + 7
- [x] Spec section 3 (LLM-output sanity pass) → Tasks 4 + 5
- [x] Spec section 4 (client side) → no work needed; existing handlers cover it
- [x] Spec section 5 (empty-orphan eviction) → Task 8
- [x] No placeholders / TODOs in plan
- [x] Type/method names consistent across tasks (`substitute_speaker_variants`, `_sanitize_label_leaks`, `_sanitize_final_payload`, `_apply_rename_retro`, `Session.set_final_summary` / `get_final_summary` / `apply_to_rolling`)
