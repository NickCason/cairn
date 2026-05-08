# Cairn Summarization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 2-min rolling delta-recap summarizer and an on-Stop structured final summary to Cairn, served by Qwen 2.5 7B on aorus-node8 via Ollama, orchestrated server-side by cairn-svc.

**Architecture:** cairn-svc (node4) gains a per-session summarizer task with a single-flight LLM queue. Rolling windows fire ~every 120s (deferred to next VAD silence boundary, slip ≤30s) and emit `rolling_summary` events; transcript edits trigger debounced (10s) re-summaries via `rolling_summary_replace`. On Stop, a final structured-JSON summary (TL;DR, per-speaker contributions, decisions, action items) is generated and emitted as `final_summary`. The Cairn renderer renders the rolling list in the sidebar and swaps the transcript pane for the final summary post-Stop. Persistence is unchanged: the Electron client appends every WS event to `transcript.jsonl` on session save.

**Tech Stack:** Python 3.11 + FastAPI + httpx + pytest-asyncio (cairn-svc); Ollama (Qwen 2.5 7B Instruct Q4_K_M, fallback Llama 3.2 3B Q5_K_M) on node8; Electron 32 + TypeScript (Cairn client).

**Spec:** `docs/superpowers/specs/2026-05-08-cairn-summarization-design.md`

**Coordination:** The diarization-windowing fix has shipped (`cairn-svc` commit `78aa386`). All §0 rules from the spec still apply for safety on follow-up work in `ws_transcribe`.

---

## File Structure

### cairn-svc (host: precision-node4, repo: `~/cairn-svc`)

| Path | Status | Responsibility |
| --- | --- | --- |
| `cairn_svc/llm_client.py` | NEW | Async HTTP client to Ollama's OpenAI-compatible chat endpoint. Timeout, retry-once-on-conn-error, JSON parsing. |
| `cairn_svc/summarize.py` | NEW | Per-session orchestrator: window scheduler, single-flight queue, rolling/edit/final prompt builders, event emission. |
| `cairn_svc/session.py` | MODIFY (additive) | Add `transcript_ledger`, `rolling_entries`, `pending_edit_seqs`, helper methods. |
| `cairn_svc/protocol.py` | MODIFY (additive) | Add `rolling_summary`, `rolling_summary_replace`, `final_summary` message types. |
| `cairn_svc/server.py` | MODIFY (additive) | Start `run_summarize_periodically` task in `ws_transcribe`; hook Stop branch for final summary. NO restructuring per spec §0. |
| `tests/test_llm_client.py` | NEW | Unit tests for HTTP client. |
| `tests/test_summarize.py` | NEW | Unit tests for queue, scheduler, prompt building, edit handling. |
| `tests/fixtures/summarize/` | NEW | Canned LLM responses for offline tests. |
| `.env.example` | NEW | Document all CAIRN_* vars (existing env was undocumented). |
| `.env` | MODIFY (on node4 only) | Append new CAIRN_LLM_* and CAIRN_SUMMARY_* vars. |

### Cairn client (host: Mac, repo: `/Users/nickcason/dev/cairn`)

| Path | Status | Responsibility |
| --- | --- | --- |
| `src/renderer/summary.ts` | NEW | Render rolling-list entries; render final-summary view. Exports event handlers. |
| `src/renderer/ws.ts` | MODIFY (additive) | Dispatch new event types to `summary.ts`. Confirm event-log capture is type-agnostic. |
| `src/renderer/app.ts` | MODIFY (additive) | Wire titlebar Transcript/Summary toggle. |
| `src/renderer/index.html` | MODIFY | Rename "Last 2 min" → "Rolling summary"; replace `#summary` stub with `#rolling-list`; add `#final-summary` and toggle buttons. |
| `src/renderer/style.css` | MODIFY (additive) | New styles for `.rolling-list`, `.roll-entry`, `#final-summary`, toggle. |

### Ollama deployment (host: aorus-node8, no repo file)

Plain Docker invocation captured in Task 1; no checked-in files.

---

## Tasks

### Task 1: Deploy Ollama on aorus-node8 alongside Speaches

**Files:** none in repo. Document the working invocation in `.env.example` (see Task 3).

- [ ] **Step 1: SSH to node8 and check current GPU/process state**

```bash
ssh nick@aorus-node8 "nvidia-smi; docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'"
```

Expected: `speaches` container running on port 8000, GPU shows a single process holding ~3.5GB.

- [ ] **Step 2: Pull the Ollama CUDA image on node8**

```bash
ssh nick@aorus-node8 "docker pull ollama/ollama:latest"
```

Expected: image pulled, no errors.

- [ ] **Step 3: Start Ollama container on node8**

```bash
ssh nick@aorus-node8 "docker run -d \
  --name ollama \
  --restart unless-stopped \
  --gpus all \
  -v ollama_data:/root/.ollama \
  -p 11434:11434 \
  ollama/ollama:latest"
```

Expected: container ID printed; `docker ps` shows `ollama` running on `:11434`.

- [ ] **Step 4: Pull Qwen 2.5 7B Instruct Q4_K_M into Ollama**

```bash
ssh nick@aorus-node8 "docker exec ollama ollama pull qwen2.5:7b-instruct-q4_K_M"
```

Expected: ~4.4GB downloaded; final line shows `success`.

- [ ] **Step 5: Verify model loads with Speaches still running, measure GPU**

```bash
ssh nick@aorus-node8 "docker exec ollama ollama run qwen2.5:7b-instruct-q4_K_M 'Reply with the word READY only.'; nvidia-smi"
```

Expected: model responds with `READY`; `nvidia-smi` shows both `whisper` (Speaches) and `ollama` processes resident; total VRAM used <8GB.

If OOM or eviction is observed, dial down GPU layers:

```bash
ssh nick@aorus-node8 "docker exec ollama ollama show qwen2.5:7b-instruct-q4_K_M --modelfile" \
  | sed 's|^FROM .*|FROM qwen2.5:7b-instruct-q4_K_M\nPARAMETER num_gpu 28|' \
  | ssh nick@aorus-node8 "docker exec -i ollama ollama create qwen2.5-cairn -f -"
```

(Then use model name `qwen2.5-cairn` in env. The `28` is a starting point — Qwen 7B has 32 layers; reduce until it fits.)

- [ ] **Step 6: Verify OpenAI-compatible endpoint from node4**

```bash
ssh nick@precision-node4 "curl -s http://100.122.121.18:11434/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{\"model\":\"qwen2.5:7b-instruct-q4_K_M\",\"messages\":[{\"role\":\"user\",\"content\":\"Say READY in JSON: {\\\"status\\\":\\\"READY\\\"}\"}],\"format\":\"json\",\"stream\":false}'"
```

Expected: JSON response; `.choices[0].message.content` is parseable JSON containing `READY`.

- [ ] **Step 7: Verify Speaches still serves**

```bash
ssh nick@precision-node4 "curl -s http://100.122.121.18:8000/v1/models | head -c 200"
```

Expected: model list returns. (No regression.)

- [ ] **Step 8: Document the working model name and invocation**

Note (in this task's commit message or in Task 3's `.env.example`) the exact model tag that fit (e.g. `qwen2.5:7b-instruct-q4_K_M` or `qwen2.5-cairn` if num_gpu was tuned).

**No commit** — this is infrastructure, not code. State recorded in Task 3's commit.

---

### Task 2: Add `.env.example` to cairn-svc

**Files:**
- Create (on node4): `~/cairn-svc/.env.example`
- Modify (on node4 only, NOT committed): `~/cairn-svc/.env` — append new vars

- [ ] **Step 1: Write `.env.example`**

```bash
ssh nick@precision-node4 'cat > ~/cairn-svc/.env.example' <<'EOF'
# Existing transcribe/diarize config
CAIRN_DIAR_DEVICE=cuda
SPEACHES_URL=http://100.122.121.18:8000
SPEACHES_MODEL=Systran/faster-distil-whisper-large-v3
SPEACHES_LANGUAGE=en

# Summarization (Phase 1)
CAIRN_LLM_URL=http://100.122.121.18:11434
CAIRN_LLM_MODEL=qwen2.5:7b-instruct-q4_K_M
CAIRN_LLM_TIMEOUT_S=90
CAIRN_LLM_NUM_CTX_FINAL=12288
CAIRN_SUMMARY_WINDOW_S=120
CAIRN_SUMMARY_VAD_SLIP_MAX_S=30
CAIRN_SUMMARY_EDIT_DEBOUNCE_S=10
CAIRN_SUMMARY_FINAL_DRAIN_S=30
CAIRN_SUMMARY_QUEUE_MAX=8
CAIRN_SUMMARY_ENABLED=true
EOF
```

- [ ] **Step 2: Append the new vars to the live `.env`**

```bash
ssh nick@precision-node4 'cat >> ~/cairn-svc/.env' <<'EOF'

# Summarization
CAIRN_LLM_URL=http://100.122.121.18:11434
CAIRN_LLM_MODEL=qwen2.5:7b-instruct-q4_K_M
CAIRN_LLM_TIMEOUT_S=90
CAIRN_LLM_NUM_CTX_FINAL=12288
CAIRN_SUMMARY_WINDOW_S=120
CAIRN_SUMMARY_VAD_SLIP_MAX_S=30
CAIRN_SUMMARY_EDIT_DEBOUNCE_S=10
CAIRN_SUMMARY_FINAL_DRAIN_S=30
CAIRN_SUMMARY_QUEUE_MAX=8
CAIRN_SUMMARY_ENABLED=true
EOF
```

(If the model name differs because of num_gpu tuning in Task 1 Step 5, substitute that name in both files.)

- [ ] **Step 3: Commit `.env.example` (only)**

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && git add .env.example && git commit -m 'docs: env example documenting all CAIRN_* vars (incl. summarization)'"
```

---

### Task 3: `llm_client.py` — async Ollama client

**Files:**
- Create: `cairn_svc/llm_client.py`
- Test: `tests/test_llm_client.py`

- [ ] **Step 1: Write failing tests**

```python
# tests/test_llm_client.py
import pytest
import httpx
from cairn_svc.llm_client import LLMClient, LLMError


@pytest.fixture
def client():
    return LLMClient(url="http://test", model="m", timeout_s=2.0)


async def test_chat_json_returns_parsed_dict(client, respx_mock):
    respx_mock.post("http://test/v1/chat/completions").respond(
        200,
        json={"choices": [{"message": {"content": '{"bullets": ["a", "b"]}'}}]},
    )
    result = await client.chat_json(system="sys", user="usr")
    assert result == {"bullets": ["a", "b"]}


async def test_chat_json_raises_on_timeout(client, respx_mock):
    respx_mock.post("http://test/v1/chat/completions").mock(side_effect=httpx.ReadTimeout("slow"))
    with pytest.raises(LLMError):
        await client.chat_json(system="sys", user="usr")


async def test_chat_json_retries_once_on_connect_error(client, respx_mock):
    route = respx_mock.post("http://test/v1/chat/completions")
    route.side_effect = [
        httpx.ConnectError("boom"),
        httpx.Response(200, json={"choices": [{"message": {"content": '{"ok": 1}'}}]}),
    ]
    result = await client.chat_json(system="sys", user="usr")
    assert result == {"ok": 1}
    assert route.call_count == 2


async def test_chat_json_no_retry_on_4xx(client, respx_mock):
    respx_mock.post("http://test/v1/chat/completions").respond(400, json={"error": "bad"})
    with pytest.raises(LLMError):
        await client.chat_json(system="sys", user="usr")


async def test_chat_json_repair_retry_on_invalid_json(client, respx_mock):
    route = respx_mock.post("http://test/v1/chat/completions")
    route.side_effect = [
        httpx.Response(200, json={"choices": [{"message": {"content": "not json"}}]}),
        httpx.Response(200, json={"choices": [{"message": {"content": '{"bullets": []}'}}]}),
    ]
    result = await client.chat_json(system="sys", user="usr", repair=True)
    assert result == {"bullets": []}
    assert route.call_count == 2
```

- [ ] **Step 2: Install `respx` (test dep) and run to verify failure**

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && ~/.local/bin/uv pip install respx && .venv/bin/python -m pytest tests/test_llm_client.py -v"
```

Expected: collection error (`No module named 'cairn_svc.llm_client'`).

- [ ] **Step 3: Implement `llm_client.py`**

```python
# cairn_svc/llm_client.py
from __future__ import annotations

import json
import httpx
from dataclasses import dataclass


class LLMError(RuntimeError):
    pass


@dataclass
class LLMClient:
    url: str
    model: str
    timeout_s: float

    async def chat_json(
        self,
        system: str,
        user: str,
        *,
        num_ctx: int | None = None,
        repair: bool = False,
    ) -> dict:
        """Call /v1/chat/completions in JSON mode; return parsed content dict.

        - One retry on httpx.ConnectError.
        - No retry on HTTP 4xx/5xx (raises LLMError).
        - Hard timeout via timeout_s.
        - If `repair=True` and the first response's content is unparseable JSON,
          re-call with an "Output valid JSON only." nudge.
        """
        body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "format": "json",
            "stream": False,
        }
        if num_ctx is not None:
            body["options"] = {"num_ctx": num_ctx}

        async def _call(b: dict) -> dict:
            try:
                async with httpx.AsyncClient(timeout=self.timeout_s) as h:
                    r = await h.post(f"{self.url}/v1/chat/completions", json=b)
            except httpx.ConnectError:
                # one retry on connection error
                async with httpx.AsyncClient(timeout=self.timeout_s) as h:
                    r = await h.post(f"{self.url}/v1/chat/completions", json=b)
            except (httpx.ReadTimeout, httpx.WriteTimeout, httpx.PoolTimeout) as e:
                raise LLMError(f"timeout after {self.timeout_s}s: {e}") from e
            if r.status_code >= 400:
                raise LLMError(f"http {r.status_code}: {r.text[:200]}")
            try:
                content = r.json()["choices"][0]["message"]["content"]
            except (KeyError, IndexError, ValueError) as e:
                raise LLMError(f"malformed response envelope: {e}") from e
            return content  # raw string, parsed by caller

        content = await _call(body)
        try:
            return json.loads(content)
        except json.JSONDecodeError:
            if not repair:
                raise LLMError(f"non-JSON response: {content[:200]}")
            body["messages"].append(
                {"role": "user", "content": "Output valid JSON only. Try again."}
            )
            content = await _call(body)
            try:
                return json.loads(content)
            except json.JSONDecodeError as e:
                raise LLMError(f"non-JSON after repair: {content[:200]}") from e
```

- [ ] **Step 4: Run tests to verify pass**

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_llm_client.py -v"
```

Expected: 5 passed.

- [ ] **Step 5: Add respx to dev deps and commit**

Modify `pyproject.toml` `[project.optional-dependencies] dev` to include `respx>=0.21`.

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && git add cairn_svc/llm_client.py tests/test_llm_client.py pyproject.toml && git commit -m 'feat(svc): async Ollama LLM client with timeout, retry, JSON-mode parsing'"
```

---

### Task 4: `session.py` — add `transcript_ledger` (additive)

**Files:**
- Modify: `cairn_svc/session.py` (add fields + methods only — no changes to existing fields/methods)
- Test: `tests/test_session.py` (add new test cases)

- [ ] **Step 1: Write failing tests (append to existing test file)**

```python
# Append to tests/test_session.py

def test_transcript_ledger_appends_finals():
    s = Session(meeting_name="m")
    s.append_final(seq=1, text="hello", speaker_id="S1", t_start=0.0, t_end=1.5)
    s.append_final(seq=2, text="world", speaker_id="S2", t_start=1.5, t_end=2.5)
    rows = s.ledger_window(0.0, 3.0)
    assert [r["text"] for r in rows] == ["hello", "world"]
    assert [r["speaker_id"] for r in rows] == ["S1", "S2"]


def test_transcript_ledger_apply_edit_replaces_text_latest_wins():
    s = Session(meeting_name="m")
    s.append_final(seq=1, text="helo", speaker_id="S1", t_start=0.0, t_end=1.0)
    s.apply_edit(seq=1, text="hello")
    s.apply_edit(seq=1, text="HELLO")
    rows = s.ledger_window(0.0, 1.0)
    assert rows[0]["text"] == "HELLO"


def test_transcript_ledger_apply_edit_changes_speaker():
    s = Session(meeting_name="m")
    s.append_final(seq=1, text="hi", speaker_id="S1", t_start=0.0, t_end=1.0)
    s.apply_edit(seq=1, speaker_id="S2")
    rows = s.ledger_window(0.0, 1.0)
    assert rows[0]["speaker_id"] == "S2"
    assert rows[0]["text"] == "hi"  # unchanged


def test_ledger_window_filters_by_time():
    s = Session(meeting_name="m")
    s.append_final(seq=1, text="a", speaker_id="S1", t_start=0.0, t_end=1.0)
    s.append_final(seq=2, text="b", speaker_id="S1", t_start=10.0, t_end=11.0)
    s.append_final(seq=3, text="c", speaker_id="S1", t_start=20.0, t_end=21.0)
    rows = s.ledger_window(5.0, 15.0)
    assert [r["text"] for r in rows] == ["b"]
```

- [ ] **Step 2: Run tests to verify failure**

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_session.py -v -k 'ledger or apply_edit'"
```

Expected: AttributeError on `Session` lacking `append_final`/`apply_edit`/`ledger_window`.

- [ ] **Step 3: Add the methods (additive) to `session.py`**

Append inside the `Session` class, after the `# --- diar segments ---` block:

```python
    # --- transcript ledger (for summarization) ---

    # Each entry: {"seq": int, "text": str, "speaker_id": str | None,
    #              "t_start": float, "t_end": float}
    # Edits are folded latest-wins per seq via apply_edit.

    def append_final(self, *, seq: int, text: str, speaker_id: str | None,
                     t_start: float, t_end: float) -> None:
        if not hasattr(self, "_ledger"):
            self._ledger: dict[int, dict] = {}
        self._ledger[seq] = {
            "seq": seq, "text": text, "speaker_id": speaker_id,
            "t_start": t_start, "t_end": t_end,
        }

    def apply_edit(self, *, seq: int, text: str | None = None,
                   speaker_id: str | None = None) -> None:
        if not hasattr(self, "_ledger") or seq not in self._ledger:
            return
        if text is not None:
            self._ledger[seq]["text"] = text
        if speaker_id is not None:
            self._ledger[seq]["speaker_id"] = speaker_id

    def ledger_window(self, t_start: float, t_end: float) -> list[dict]:
        if not hasattr(self, "_ledger"):
            return []
        return sorted(
            (e for e in self._ledger.values() if t_start <= e["t_start"] < t_end),
            key=lambda e: e["seq"],
        )

    def ledger_all(self) -> list[dict]:
        if not hasattr(self, "_ledger"):
            return []
        return sorted(self._ledger.values(), key=lambda e: e["seq"])

    def ledger_lookup_seq_time(self, seq: int) -> tuple[float, float] | None:
        if not hasattr(self, "_ledger") or seq not in self._ledger:
            return None
        e = self._ledger[seq]
        return (e["t_start"], e["t_end"])
```

(The `hasattr` guards keep the change strictly additive — pre-summarization code paths see a Session with no `_ledger` attribute and are unaffected. Initialization happens lazily on first `append_final`.)

- [ ] **Step 4: Run tests to verify pass**

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_session.py -v"
```

Expected: all session tests pass (existing + 4 new).

- [ ] **Step 5: Commit**

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && git add cairn_svc/session.py tests/test_session.py && git commit -m 'feat(svc): transcript ledger on Session for summarization (additive)'"
```

---

### Task 5: `session.py` — add rolling state (additive)

**Files:**
- Modify: `cairn_svc/session.py`
- Test: `tests/test_session.py`

- [ ] **Step 1: Write failing tests**

```python
# Append to tests/test_session.py

def test_rolling_entry_append_and_get():
    s = Session(meeting_name="m")
    idx = s.add_rolling_entry(window_start_s=0.0, window_end_s=120.0,
                              bullets=["a", "b"], merged_from_failed_prior=False)
    assert idx == 0
    entries = s.rolling_entries_all()
    assert entries[0]["bullets"] == ["a", "b"]
    assert entries[0]["window_end_s"] == 120.0


def test_rolling_entry_replace_in_place():
    s = Session(meeting_name="m")
    s.add_rolling_entry(0.0, 120.0, ["a"], False)
    s.add_rolling_entry(120.0, 240.0, ["b"], False)
    s.replace_rolling_entry(idx=0, bullets=["A"])
    assert s.rolling_entries_all()[0]["bullets"] == ["A"]
    assert s.rolling_entries_all()[1]["bullets"] == ["b"]


def test_pending_edit_seqs_set():
    s = Session(meeting_name="m")
    s.note_edit(7)
    s.note_edit(7)
    s.note_edit(11)
    assert s.drain_pending_edits() == {7, 11}
    assert s.drain_pending_edits() == set()
```

- [ ] **Step 2: Run to verify failure**

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_session.py -v -k 'rolling or pending_edit'"
```

Expected: AttributeError on missing methods.

- [ ] **Step 3: Add methods (additive)**

Append to `Session` class:

```python
    # --- rolling summary state ---

    # Each entry: {"idx": int, "window_start_s": float, "window_end_s": float,
    #              "bullets": list[str], "generated_at": float,
    #              "merged_from_failed_prior": bool}

    def add_rolling_entry(self, window_start_s: float, window_end_s: float,
                          bullets: list[str], merged_from_failed_prior: bool) -> int:
        if not hasattr(self, "_rolling"):
            self._rolling: list[dict] = []
        import time as _t
        idx = len(self._rolling)
        self._rolling.append({
            "idx": idx,
            "window_start_s": window_start_s,
            "window_end_s": window_end_s,
            "bullets": bullets,
            "generated_at": _t.time(),
            "merged_from_failed_prior": merged_from_failed_prior,
        })
        return idx

    def replace_rolling_entry(self, idx: int, bullets: list[str]) -> None:
        import time as _t
        self._rolling[idx]["bullets"] = bullets
        self._rolling[idx]["generated_at"] = _t.time()

    def rolling_entries_all(self) -> list[dict]:
        return list(getattr(self, "_rolling", []))

    def note_edit(self, seq: int) -> None:
        if not hasattr(self, "_pending_edits"):
            self._pending_edits: set[int] = set()
        self._pending_edits.add(seq)

    def drain_pending_edits(self) -> set[int]:
        if not hasattr(self, "_pending_edits"):
            return set()
        out, self._pending_edits = self._pending_edits, set()
        return out
```

- [ ] **Step 4: Run to verify pass**

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_session.py -v"
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && git add cairn_svc/session.py tests/test_session.py && git commit -m 'feat(svc): rolling-summary state on Session (entries, pending edits)'"
```

---

### Task 6: `summarize.py` — `SingleFlightQueue`

**Files:**
- Create: `cairn_svc/summarize.py` (queue only for now)
- Test: `tests/test_summarize.py`

- [ ] **Step 1: Write failing tests**

```python
# tests/test_summarize.py
import asyncio
import pytest
from cairn_svc.summarize import SingleFlightQueue, QueueItem


async def test_queue_processes_items_in_order():
    q = SingleFlightQueue(max_depth=8)
    out = []

    async def handler(item):
        out.append(item.payload)

    task = asyncio.create_task(q.run(handler))
    await q.put(QueueItem(kind="rolling", payload="a"))
    await q.put(QueueItem(kind="rolling", payload="b"))
    await asyncio.sleep(0.05)
    q.stop()
    await task
    assert out == ["a", "b"]


async def test_queue_drops_oldest_non_final_when_full():
    q = SingleFlightQueue(max_depth=2)
    await q.put(QueueItem(kind="rolling", payload="a"))
    await q.put(QueueItem(kind="rolling", payload="b"))
    await q.put(QueueItem(kind="rolling", payload="c"))
    items = []
    async def handler(item):
        items.append(item.payload)
    task = asyncio.create_task(q.run(handler))
    await asyncio.sleep(0.05)
    q.stop()
    await task
    assert items == ["b", "c"]  # "a" was dropped


async def test_queue_final_takes_priority_and_drops_pending():
    q = SingleFlightQueue(max_depth=8)
    items = []
    started = asyncio.Event()
    release = asyncio.Event()

    async def handler(item):
        items.append(item.payload)
        if item.payload == "slow":
            started.set()
            await release.wait()

    task = asyncio.create_task(q.run(handler))
    await q.put(QueueItem(kind="rolling", payload="slow"))
    await started.wait()
    await q.put(QueueItem(kind="rolling", payload="dropped"))
    await q.put(QueueItem(kind="final", payload="finalize"))
    release.set()
    await asyncio.sleep(0.05)
    q.stop()
    await task
    assert items == ["slow", "finalize"]
```

- [ ] **Step 2: Run to verify failure**

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_summarize.py -v"
```

Expected: ImportError (no `cairn_svc.summarize`).

- [ ] **Step 3: Implement queue**

```python
# cairn_svc/summarize.py
from __future__ import annotations

import asyncio
from collections import deque
from dataclasses import dataclass
from typing import Any, Callable, Awaitable


@dataclass
class QueueItem:
    kind: str  # "rolling" | "resummarize" | "final"
    payload: Any


class SingleFlightQueue:
    """Async FIFO queue, one item processed at a time.

    - max_depth: when full, oldest non-final items are dropped on put().
    - On a "final" put: pending non-final items are dropped; final is enqueued
      to run as soon as the in-flight item (if any) completes or is cancelled.
    """

    def __init__(self, max_depth: int):
        self.max_depth = max_depth
        self._q: deque[QueueItem] = deque()
        self._wake = asyncio.Event()
        self._stopped = False

    async def put(self, item: QueueItem) -> None:
        if item.kind == "final":
            # Drop any pending non-final items
            self._q = deque(i for i in self._q if i.kind == "final")
        else:
            while len(self._q) >= self.max_depth:
                # Drop oldest non-final
                for i, qi in enumerate(self._q):
                    if qi.kind != "final":
                        del self._q[i]
                        break
                else:
                    break  # only finals queued; can't drop
        self._q.append(item)
        self._wake.set()

    def stop(self) -> None:
        self._stopped = True
        self._wake.set()

    async def run(self, handler: Callable[[QueueItem], Awaitable[None]]) -> None:
        while not self._stopped:
            if not self._q:
                self._wake.clear()
                await self._wake.wait()
                continue
            item = self._q.popleft()
            try:
                await handler(item)
            except Exception:
                # Handler is responsible for its own logging/retries; queue continues.
                pass
```

- [ ] **Step 4: Run to verify pass**

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_summarize.py -v"
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && git add cairn_svc/summarize.py tests/test_summarize.py && git commit -m 'feat(svc): single-flight queue for per-session summarizer'"
```

---

### Task 7: `summarize.py` — window scheduler

**Files:**
- Modify: `cairn_svc/summarize.py`
- Test: `tests/test_summarize.py`

- [ ] **Step 1: Write failing tests**

```python
# Append to tests/test_summarize.py
from cairn_svc.summarize import WindowScheduler


async def test_scheduler_emits_at_target_time(monkeypatch):
    times = iter([0.0, 60.0, 119.0, 121.0])
    monkeypatch.setattr("cairn_svc.summarize._now", lambda: next(times))
    sched = WindowScheduler(window_s=120.0, vad_slip_max_s=30.0)
    boundary = await sched.next_boundary(start_s=0.0, vad_silence_at=lambda after: after)
    assert boundary == 121.0  # first tick at-or-past target


async def test_scheduler_defers_to_vad_boundary(monkeypatch):
    times = iter([0.0, 121.0])
    monkeypatch.setattr("cairn_svc.summarize._now", lambda: next(times))
    sched = WindowScheduler(window_s=120.0, vad_slip_max_s=30.0)
    # VAD boundary is at 135.0 (within slip cap)
    boundary = await sched.next_boundary(start_s=0.0, vad_silence_at=lambda after: 135.0)
    assert boundary == 135.0


async def test_scheduler_force_cuts_at_slip_cap(monkeypatch):
    times = iter([0.0, 121.0])
    monkeypatch.setattr("cairn_svc.summarize._now", lambda: next(times))
    sched = WindowScheduler(window_s=120.0, vad_slip_max_s=30.0)
    # No VAD boundary returned (None) — force cut at target + slip cap
    boundary = await sched.next_boundary(start_s=0.0, vad_silence_at=lambda after: None)
    assert boundary == 150.0  # 120 + 30
```

- [ ] **Step 2: Run to verify failure**

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_summarize.py -v -k 'scheduler'"
```

Expected: ImportError on `WindowScheduler`.

- [ ] **Step 3: Implement scheduler**

Append to `cairn_svc/summarize.py`:

```python
import time as _time
from typing import Callable

def _now() -> float:
    return _time.monotonic()


class WindowScheduler:
    """Decides when to close a rolling window.

    - Sleeps until target_s elapsed since start_s.
    - Then asks VAD for the next silence boundary at-or-after target.
    - Returns that boundary if within slip cap; else returns target + slip cap.
    """

    def __init__(self, window_s: float, vad_slip_max_s: float):
        self.window_s = window_s
        self.vad_slip_max_s = vad_slip_max_s

    async def next_boundary(
        self,
        start_s: float,
        vad_silence_at: Callable[[float], float | None],
        sleep: Callable[[float], "Awaitable[None]"] = asyncio.sleep,
    ) -> float:
        target = start_s + self.window_s
        while True:
            now = _now()
            if now >= target:
                break
            await sleep(min(1.0, target - now))
        vad = vad_silence_at(target)
        if vad is None or vad > target + self.vad_slip_max_s:
            return target + self.vad_slip_max_s
        return vad
```

- [ ] **Step 4: Run to verify pass**

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_summarize.py -v -k 'scheduler'"
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && git add cairn_svc/summarize.py tests/test_summarize.py && git commit -m 'feat(svc): window scheduler with VAD-boundary deferral and slip cap'"
```

---

### Task 8: `summarize.py` — rolling prompt builder

**Files:**
- Modify: `cairn_svc/summarize.py`
- Test: `tests/test_summarize.py`

- [ ] **Step 1: Write failing tests**

```python
# Append to tests/test_summarize.py
from cairn_svc.summarize import build_rolling_prompt, ROLLING_SYSTEM


def test_rolling_prompt_includes_prior_recaps_and_window():
    prior = [
        {"window_start_s": 0.0, "window_end_s": 120.0, "bullets": ["intro", "scope"]},
        {"window_start_s": 120.0, "window_end_s": 240.0, "bullets": ["pricing q"]},
    ]
    window_lines = [
        {"speaker_id": "Alice", "text": "Let's land on the tier."},
        {"speaker_id": "Bob", "text": "Enterprise stays custom."},
    ]
    sys, usr = build_rolling_prompt(
        prior_entries=prior,
        window_start_s=240.0, window_end_s=362.0,
        window_lines=window_lines,
    )
    assert sys == ROLLING_SYSTEM
    assert "00:00" in usr and "02:00" in usr
    assert "intro; scope" in usr
    assert "pricing q" in usr
    assert "04:00" in usr and "06:02" in usr
    assert "Alice: Let's land on the tier." in usr
    assert "Bob: Enterprise stays custom." in usr


def test_rolling_prompt_handles_unknown_speaker():
    sys, usr = build_rolling_prompt(
        prior_entries=[],
        window_start_s=0.0, window_end_s=120.0,
        window_lines=[{"speaker_id": None, "text": "anon"}],
    )
    assert "S?: anon" in usr
```

- [ ] **Step 2: Run to verify failure**

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_summarize.py -v -k 'rolling_prompt'"
```

Expected: ImportError on `build_rolling_prompt`.

- [ ] **Step 3: Implement prompt builder**

Append to `cairn_svc/summarize.py`:

```python
ROLLING_SYSTEM = (
    "You are a meeting note-taker. Given the last segment of a live conversation "
    "transcript and a list of bullet recaps from earlier in the same meeting, "
    "produce 1-3 short bullets describing what is new in the latest segment. "
    "Assume the reader has seen the earlier recaps. Do not repeat earlier points. "
    "Be concrete: name decisions, questions, and action items if they appear. "
    "Skip filler. If nothing meaningful happened, output a single bullet: "
    "\"(no substantive new content)\".\n\n"
    "Output JSON: {\"bullets\": [\"...\", \"...\"]}. No prose outside JSON."
)


def _mmss(s: float) -> str:
    s = int(s)
    return f"{s // 60:02d}:{s % 60:02d}"


def _label(speaker_id: str | None) -> str:
    return speaker_id if speaker_id else "S?"


def build_rolling_prompt(
    *,
    prior_entries: list[dict],
    window_start_s: float,
    window_end_s: float,
    window_lines: list[dict],
) -> tuple[str, str]:
    parts = ["PRIOR RECAPS (oldest -> newest):"]
    if not prior_entries:
        parts.append("(none yet)")
    for e in prior_entries:
        parts.append(
            f"- [{_mmss(e['window_start_s'])}-{_mmss(e['window_end_s'])}] "
            f"{'; '.join(e['bullets'])}"
        )
    parts.append("")
    parts.append(f"LATEST SEGMENT [{_mmss(window_start_s)}-{_mmss(window_end_s)}]:")
    for ln in window_lines:
        parts.append(f"{_label(ln['speaker_id'])}: {ln['text']}")
    return ROLLING_SYSTEM, "\n".join(parts)
```

- [ ] **Step 4: Run to verify pass**

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_summarize.py -v -k 'rolling_prompt'"
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && git add cairn_svc/summarize.py tests/test_summarize.py && git commit -m 'feat(svc): rolling delta-recap prompt builder'"
```

---

### Task 9: `summarize.py` — Summarizer orchestrator (rolling path with failure-merge)

**Files:**
- Modify: `cairn_svc/summarize.py`
- Test: `tests/test_summarize.py`

- [ ] **Step 1: Write failing tests**

```python
# Append to tests/test_summarize.py
from unittest.mock import AsyncMock
from cairn_svc.summarize import Summarizer, SummarizerConfig
from cairn_svc.session import Session


def _make_summarizer(session, llm, config_overrides=None):
    cfg = SummarizerConfig(
        window_s=120.0, vad_slip_max_s=30.0, edit_debounce_s=10.0,
        final_drain_s=30.0, queue_max=8, timeout_s=90.0,
        num_ctx_final=12288, model="m", enabled=True,
    )
    if config_overrides:
        for k, v in config_overrides.items():
            setattr(cfg, k, v)
    emitted = []
    return Summarizer(
        session=session, llm=llm, cfg=cfg,
        emit=lambda msg: emitted.append(msg),
        vad_silence_at=lambda after: after,
        session_start_s=0.0,
    ), emitted


async def test_summarizer_emits_rolling_event_on_success():
    session = Session(meeting_name="m")
    session.append_final(seq=1, text="hello", speaker_id="Alice", t_start=0.0, t_end=60.0)
    session.append_final(seq=2, text="world", speaker_id="Bob", t_start=60.0, t_end=110.0)
    llm = AsyncMock()
    llm.chat_json = AsyncMock(return_value={"bullets": ["greeting exchanged"]})
    summ, emitted = _make_summarizer(session, llm)
    await summ.run_one_window(window_start_s=0.0, window_end_s=120.0)
    assert len(emitted) == 1
    msg = emitted[0]
    assert msg["type"] == "rolling_summary"
    assert msg["bullets"] == ["greeting exchanged"]
    assert msg["window_end_s"] == 120.0
    assert msg["merged_from_failed_prior"] is False
    assert session.rolling_entries_all()[0]["bullets"] == ["greeting exchanged"]


async def test_summarizer_merges_failed_window_into_next():
    session = Session(meeting_name="m")
    session.append_final(seq=1, text="a", speaker_id="A", t_start=0.0, t_end=110.0)
    session.append_final(seq=2, text="b", speaker_id="A", t_start=130.0, t_end=230.0)
    from cairn_svc.llm_client import LLMError
    llm = AsyncMock()
    llm.chat_json = AsyncMock(side_effect=[LLMError("timeout"),
                                           {"bullets": ["combined"]}])
    summ, emitted = _make_summarizer(session, llm)
    await summ.run_one_window(window_start_s=0.0, window_end_s=120.0)  # fails
    assert emitted == []
    await summ.run_one_window(window_start_s=120.0, window_end_s=240.0)  # succeeds, merged
    assert len(emitted) == 1
    msg = emitted[0]
    assert msg["merged_from_failed_prior"] is True
    assert msg["window_start_s"] == 0.0  # merged span
    assert msg["window_end_s"] == 240.0


async def test_summarizer_skips_empty_window():
    session = Session(meeting_name="m")
    llm = AsyncMock()
    llm.chat_json = AsyncMock()
    summ, emitted = _make_summarizer(session, llm)
    await summ.run_one_window(window_start_s=0.0, window_end_s=120.0)
    assert emitted == []
    llm.chat_json.assert_not_called()
```

- [ ] **Step 2: Run to verify failure**

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_summarize.py -v -k 'summarizer_'"
```

Expected: ImportError on `Summarizer`/`SummarizerConfig`.

- [ ] **Step 3: Implement Summarizer (rolling path)**

Append to `cairn_svc/summarize.py`:

```python
from dataclasses import dataclass, field
from .llm_client import LLMClient, LLMError
from .session import Session


@dataclass
class SummarizerConfig:
    window_s: float
    vad_slip_max_s: float
    edit_debounce_s: float
    final_drain_s: float
    queue_max: int
    timeout_s: float
    num_ctx_final: int
    model: str
    enabled: bool


@dataclass
class Summarizer:
    session: Session
    llm: LLMClient
    cfg: SummarizerConfig
    emit: Callable[[dict], None]
    vad_silence_at: Callable[[float], float | None]
    session_start_s: float
    _failed_window_start_s: float | None = field(default=None, init=False)

    async def run_one_window(self, *, window_start_s: float, window_end_s: float) -> None:
        # Effective start absorbs any prior failed window
        eff_start = self._failed_window_start_s if self._failed_window_start_s is not None else window_start_s
        merged = self._failed_window_start_s is not None

        lines = self.session.ledger_window(eff_start, window_end_s)
        if not lines:
            # Don't advance failed-window flag; nothing to summarize
            return

        prior = self.session.rolling_entries_all()
        sys, usr = build_rolling_prompt(
            prior_entries=prior,
            window_start_s=eff_start, window_end_s=window_end_s,
            window_lines=lines,
        )
        try:
            result = await self.llm.chat_json(system=sys, user=usr, repair=True)
            bullets = list(result.get("bullets", []))
        except LLMError:
            self._failed_window_start_s = eff_start
            return

        idx = self.session.add_rolling_entry(
            window_start_s=eff_start, window_end_s=window_end_s,
            bullets=bullets, merged_from_failed_prior=merged,
        )
        self._failed_window_start_s = None
        self.emit({
            "type": "rolling_summary",
            "idx": idx,
            "window_start_s": eff_start,
            "window_end_s": window_end_s,
            "bullets": bullets,
            "generated_at": _time.time(),
            "merged_from_failed_prior": merged,
        })
```

- [ ] **Step 4: Run to verify pass**

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_summarize.py -v"
```

Expected: all summarizer tests pass.

- [ ] **Step 5: Commit**

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && git add cairn_svc/summarize.py tests/test_summarize.py && git commit -m 'feat(svc): Summarizer rolling-window path with failed-window merge'"
```

---

### Task 10: `summarize.py` — edit-driven re-summary path

**Files:**
- Modify: `cairn_svc/summarize.py`
- Test: `tests/test_summarize.py`

- [ ] **Step 1: Write failing tests**

```python
# Append to tests/test_summarize.py

async def test_resummarize_replaces_affected_entry():
    session = Session(meeting_name="m")
    session.append_final(seq=1, text="bad text", speaker_id="A",
                         t_start=0.0, t_end=110.0)
    llm = AsyncMock()
    llm.chat_json = AsyncMock(return_value={"bullets": ["original"]})
    summ, emitted = _make_summarizer(session, llm)
    await summ.run_one_window(window_start_s=0.0, window_end_s=120.0)
    # First entry exists
    assert session.rolling_entries_all()[0]["bullets"] == ["original"]

    # Edit seq 1
    session.apply_edit(seq=1, text="fixed text")
    session.note_edit(1)
    llm.chat_json = AsyncMock(return_value={"bullets": ["fixed"]})

    await summ.process_pending_edits()
    msgs = [m for m in emitted if m["type"] == "rolling_summary_replace"]
    assert len(msgs) == 1
    assert msgs[0]["idx"] == 0
    assert msgs[0]["bullets"] == ["fixed"]
    assert session.rolling_entries_all()[0]["bullets"] == ["fixed"]


async def test_resummarize_picks_correct_entry_for_seq_in_second_window():
    session = Session(meeting_name="m")
    session.append_final(seq=1, text="w1", speaker_id="A",
                         t_start=0.0, t_end=100.0)
    session.append_final(seq=2, text="w2", speaker_id="A",
                         t_start=130.0, t_end=200.0)
    llm = AsyncMock()
    llm.chat_json = AsyncMock(side_effect=[
        {"bullets": ["e1"]}, {"bullets": ["e2"]}, {"bullets": ["e2-fixed"]},
    ])
    summ, emitted = _make_summarizer(session, llm)
    await summ.run_one_window(window_start_s=0.0, window_end_s=120.0)
    await summ.run_one_window(window_start_s=120.0, window_end_s=240.0)

    session.apply_edit(seq=2, text="w2-fixed")
    session.note_edit(2)
    await summ.process_pending_edits()

    replaces = [m for m in emitted if m["type"] == "rolling_summary_replace"]
    assert len(replaces) == 1
    assert replaces[0]["idx"] == 1


async def test_resummarize_noop_when_no_pending_edits():
    session = Session(meeting_name="m")
    llm = AsyncMock()
    summ, emitted = _make_summarizer(session, llm)
    await summ.process_pending_edits()
    llm.chat_json.assert_not_called()
    assert emitted == []
```

- [ ] **Step 2: Run to verify failure**

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_summarize.py -v -k 'resummarize'"
```

Expected: AttributeError on `process_pending_edits`.

- [ ] **Step 3: Implement re-summary path**

Append to `Summarizer` class in `cairn_svc/summarize.py`:

```python
    async def process_pending_edits(self) -> None:
        seqs = self.session.drain_pending_edits()
        if not seqs:
            return
        # Compute affected rolling-entry indices
        affected: set[int] = set()
        for seq in seqs:
            tt = self.session.ledger_lookup_seq_time(seq)
            if tt is None:
                continue
            t_start, t_end = tt
            for entry in self.session.rolling_entries_all():
                if t_start < entry["window_end_s"] and t_end > entry["window_start_s"]:
                    affected.add(entry["idx"])
        # Re-summarize each affected entry oldest-first
        for idx in sorted(affected):
            entry = self.session.rolling_entries_all()[idx]
            window_lines = self.session.ledger_window(
                entry["window_start_s"], entry["window_end_s"])
            if not window_lines:
                continue
            prior = [e for e in self.session.rolling_entries_all() if e["idx"] < idx]
            sys, usr = build_rolling_prompt(
                prior_entries=prior,
                window_start_s=entry["window_start_s"],
                window_end_s=entry["window_end_s"],
                window_lines=window_lines,
            )
            try:
                result = await self.llm.chat_json(system=sys, user=usr, repair=True)
                bullets = list(result.get("bullets", []))
            except LLMError:
                # Re-add seqs so future edits can re-trigger
                for s in seqs:
                    self.session.note_edit(s)
                continue
            self.session.replace_rolling_entry(idx=idx, bullets=bullets)
            self.emit({
                "type": "rolling_summary_replace",
                "idx": idx,
                "bullets": bullets,
                "generated_at": _time.time(),
                "reason": "edit",
            })
```

- [ ] **Step 4: Run to verify pass**

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_summarize.py -v"
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && git add cairn_svc/summarize.py tests/test_summarize.py && git commit -m 'feat(svc): edit-driven re-summary path with intersect-by-time matching'"
```

---

### Task 11: `summarize.py` — final summary builder + emitter

**Files:**
- Modify: `cairn_svc/summarize.py`
- Test: `tests/test_summarize.py`

- [ ] **Step 1: Write failing tests**

```python
# Append to tests/test_summarize.py
from cairn_svc.summarize import build_final_prompt, FINAL_SYSTEM


def test_final_prompt_includes_full_transcript_and_recaps():
    prior = [{"window_start_s": 0.0, "window_end_s": 120.0, "bullets": ["intro"]}]
    lines = [
        {"speaker_id": "Alice", "text": "Hi all."},
        {"speaker_id": "Bob", "text": "Hello."},
    ]
    sys, usr = build_final_prompt(prior_entries=prior, all_lines=lines)
    assert sys == FINAL_SYSTEM
    assert "intro" in usr
    assert "Alice: Hi all." in usr
    assert "Bob: Hello." in usr


def test_final_prompt_truncates_oldest_lines_when_over_budget():
    # Each line ~10 tokens; budget 50 tokens; 8 lines -> ~80 tokens -> drop oldest
    lines = [
        {"speaker_id": "A", "text": f"line {i} text " * 5} for i in range(8)
    ]
    sys, usr, truncated = build_final_prompt(
        prior_entries=[], all_lines=lines, max_tokens=50, return_truncated_flag=True,
    )
    assert truncated is True
    # Newest line should still be present, oldest should be gone
    assert "line 7 text" in usr
    assert "line 0 text" not in usr


async def test_summarizer_final_emits_event():
    session = Session(meeting_name="m")
    session.append_final(seq=1, text="hi", speaker_id="A", t_start=0.0, t_end=10.0)
    llm = AsyncMock()
    llm.chat_json = AsyncMock(return_value={
        "tldr": "short meeting",
        "speakers": [{"speaker": "A", "contributions": ["said hi"]}],
        "decisions": [],
        "action_items": [],
    })
    summ, emitted = _make_summarizer(session, llm)
    await summ.run_final()
    finals = [m for m in emitted if m["type"] == "final_summary"]
    assert len(finals) == 1
    assert finals[0]["ok"] is True
    assert finals[0]["tldr"] == "short meeting"
    assert finals[0]["truncated"] is False


async def test_summarizer_final_emits_failure_on_llm_error():
    session = Session(meeting_name="m")
    session.append_final(seq=1, text="hi", speaker_id="A", t_start=0.0, t_end=10.0)
    from cairn_svc.llm_client import LLMError
    llm = AsyncMock()
    llm.chat_json = AsyncMock(side_effect=LLMError("nope"))
    summ, emitted = _make_summarizer(session, llm)
    await summ.run_final()
    finals = [m for m in emitted if m["type"] == "final_summary"]
    assert len(finals) == 1
    assert finals[0]["ok"] is False
    assert "nope" in finals[0]["error"]
```

- [ ] **Step 2: Run to verify failure**

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_summarize.py -v -k 'final'"
```

Expected: ImportError on `build_final_prompt`/AttributeError on `run_final`.

- [ ] **Step 3: Implement final summary**

Append to `cairn_svc/summarize.py`:

```python
FINAL_SYSTEM = (
    "You are a meeting note-taker producing the final summary of a recorded "
    "conversation. Use the full transcript as the source of truth; the rolling "
    "recaps are supplementary context that may be coarse. Be faithful -- do not "
    "invent attendees, decisions, or action items.\n\n"
    "Output JSON matching this schema (no fields outside it, no prose outside JSON):\n"
    "{\n"
    "  \"tldr\": \"1-3 sentences\",\n"
    "  \"speakers\": [{\"speaker\": \"<display name or label>\", \"contributions\": [\"...\"]}],\n"
    "  \"decisions\": [\"...\"],\n"
    "  \"action_items\": [{\"assignee\": \"<name or 'unassigned'>\", \"item\": \"...\", \"due\": \"<text or null>\"}]\n"
    "}\n"
    "If a section has no items, return an empty array. tldr is required and non-empty."
)


def _approx_tokens(text: str) -> int:
    # Rough heuristic: 1 token ~= 4 chars. Good enough for budgeting.
    return max(1, len(text) // 4)


def build_final_prompt(
    *,
    prior_entries: list[dict],
    all_lines: list[dict],
    max_tokens: int | None = None,
    return_truncated_flag: bool = False,
):
    recap_part = ["ROLLING RECAPS (chronological):"]
    if not prior_entries:
        recap_part.append("(none)")
    for e in prior_entries:
        recap_part.append(
            f"- [{_mmss(e['window_start_s'])}-{_mmss(e['window_end_s'])}] "
            f"{'; '.join(e['bullets'])}"
        )
    recap_part.append("")
    recap_part.append("FULL TRANSCRIPT (speaker-labeled):")
    recap_str = "\n".join(recap_part)

    line_strs = [f"{_label(ln['speaker_id'])}: {ln['text']}" for ln in all_lines]

    truncated = False
    if max_tokens is not None:
        budget = max_tokens - _approx_tokens(recap_str) - _approx_tokens(FINAL_SYSTEM)
        used = 0
        kept_rev: list[str] = []
        # Keep newest lines; drop oldest first
        for s in reversed(line_strs):
            t = _approx_tokens(s) + 1
            if used + t > budget:
                truncated = True
                break
            kept_rev.append(s)
            used += t
        line_strs = list(reversed(kept_rev))

    usr = recap_str + "\n" + "\n".join(line_strs)
    if return_truncated_flag:
        return FINAL_SYSTEM, usr, truncated
    return FINAL_SYSTEM, usr
```

And add `run_final` to `Summarizer`:

```python
    async def run_final(self) -> None:
        all_lines = self.session.ledger_all()
        prior = self.session.rolling_entries_all()
        sys, usr, truncated = build_final_prompt(
            prior_entries=prior, all_lines=all_lines,
            max_tokens=self.cfg.num_ctx_final, return_truncated_flag=True,
        )
        try:
            result = await self.llm.chat_json(
                system=sys, user=usr, num_ctx=self.cfg.num_ctx_final, repair=True,
            )
            self.emit({
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
        except LLMError as e:
            self.emit({
                "type": "final_summary",
                "ok": False,
                "error": str(e),
                "model": self.cfg.model,
                "generated_at": _time.time(),
            })
```

- [ ] **Step 4: Run to verify pass**

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_summarize.py -v"
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && git add cairn_svc/summarize.py tests/test_summarize.py && git commit -m 'feat(svc): final structured summary with token-budget truncation'"
```

---

### Task 12: `protocol.py` — declare new message types

**Files:**
- Modify: `cairn_svc/protocol.py`
- Test: `tests/test_protocol.py`

- [ ] **Step 1: Read existing `protocol.py`**

```bash
ssh nick@precision-node4 "cat ~/cairn-svc/cairn_svc/protocol.py"
```

Note its style (constants vs Pydantic vs TypedDict). The patches below assume string constants — adjust the syntax to match what's actually there (variable names: keep additions consistent with the existing convention).

- [ ] **Step 2: Write failing test**

Append to `tests/test_protocol.py`:

```python
from cairn_svc.protocol import (
    MSG_ROLLING_SUMMARY,
    MSG_ROLLING_SUMMARY_REPLACE,
    MSG_FINAL_SUMMARY,
)


def test_summary_message_types_declared():
    assert MSG_ROLLING_SUMMARY == "rolling_summary"
    assert MSG_ROLLING_SUMMARY_REPLACE == "rolling_summary_replace"
    assert MSG_FINAL_SUMMARY == "final_summary"
```

(If the existing file uses an enum or class instead of bare constants, adapt the import + assertion to match — additive only, no rename.)

- [ ] **Step 3: Run to verify failure**

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_protocol.py -v"
```

Expected: ImportError.

- [ ] **Step 4: Add the constants (additive)**

Append to `cairn_svc/protocol.py`:

```python
# --- Summarization (Phase 1) ---
MSG_ROLLING_SUMMARY = "rolling_summary"
MSG_ROLLING_SUMMARY_REPLACE = "rolling_summary_replace"
MSG_FINAL_SUMMARY = "final_summary"
```

If the existing file uses a TypedDict-per-message style, also add minimal TypedDicts mirroring §6 of the spec — additive only.

- [ ] **Step 5: Run to verify pass**

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && .venv/bin/python -m pytest tests/test_protocol.py -v"
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && git add cairn_svc/protocol.py tests/test_protocol.py && git commit -m 'feat(svc): add summarization message-type constants'"
```

---

### Task 13: `server.py` — wire summarizer into `ws_transcribe`

**Files:**
- Modify: `cairn_svc/server.py`

> **Coordination reminder (spec §0):** Do NOT reorder `ws_transcribe`'s top-level closures or rename existing state. Only add new closures and a new `asyncio.create_task` line, plus an additive branch in the existing Stop section.

- [ ] **Step 1: Read current `server.py` around `ws_transcribe`**

```bash
ssh nick@precision-node4 "sed -n '34,200p' ~/cairn-svc/cairn_svc/server.py"
```

Identify:
- where the `transcribe` and `diarize` periodic tasks are created (this is where `run_summarize_periodically` joins them);
- where finals are produced (we need to call `session.append_final` there with `seq, text, speaker_id, t_start, t_end`);
- where `transcript_edit` messages are received (we need to call `session.apply_edit` + `session.note_edit`);
- the Stop branch.

- [ ] **Step 2: Add config loading at module scope**

After the existing env reads, append:

```python
import os

CAIRN_LLM_URL = os.getenv("CAIRN_LLM_URL", "http://100.122.121.18:11434")
CAIRN_LLM_MODEL = os.getenv("CAIRN_LLM_MODEL", "qwen2.5:7b-instruct-q4_K_M")
CAIRN_LLM_TIMEOUT_S = float(os.getenv("CAIRN_LLM_TIMEOUT_S", "90"))
CAIRN_LLM_NUM_CTX_FINAL = int(os.getenv("CAIRN_LLM_NUM_CTX_FINAL", "12288"))
CAIRN_SUMMARY_WINDOW_S = float(os.getenv("CAIRN_SUMMARY_WINDOW_S", "120"))
CAIRN_SUMMARY_VAD_SLIP_MAX_S = float(os.getenv("CAIRN_SUMMARY_VAD_SLIP_MAX_S", "30"))
CAIRN_SUMMARY_EDIT_DEBOUNCE_S = float(os.getenv("CAIRN_SUMMARY_EDIT_DEBOUNCE_S", "10"))
CAIRN_SUMMARY_FINAL_DRAIN_S = float(os.getenv("CAIRN_SUMMARY_FINAL_DRAIN_S", "30"))
CAIRN_SUMMARY_QUEUE_MAX = int(os.getenv("CAIRN_SUMMARY_QUEUE_MAX", "8"))
CAIRN_SUMMARY_ENABLED = os.getenv("CAIRN_SUMMARY_ENABLED", "true").lower() == "true"
```

- [ ] **Step 3: Add the periodic task body**

Inside `ws_transcribe`, after the existing `run_diarization_periodically` definition (don't reorder):

```python
    # ---- Summarization ----
    from .summarize import (
        Summarizer, SummarizerConfig, SingleFlightQueue, QueueItem, WindowScheduler,
    )
    from .llm_client import LLMClient

    summary_queue = SingleFlightQueue(max_depth=CAIRN_SUMMARY_QUEUE_MAX)
    summary_emit_lock = asyncio.Lock()

    async def _emit_msg(msg: dict) -> None:
        # Send through the same WS pipe used by transcribe/diarize.
        async with summary_emit_lock:
            await ws.send_json(msg)

    def _vad_silence_at(t: float) -> float | None:
        # Use the existing VAD module; if unavailable here, return None to force-cut.
        try:
            from .vad import find_commit_boundary_s
            return find_commit_boundary_s(session, after_s=t)
        except Exception:
            return None

    summarizer = Summarizer(
        session=session,
        llm=LLMClient(url=CAIRN_LLM_URL, model=CAIRN_LLM_MODEL, timeout_s=CAIRN_LLM_TIMEOUT_S),
        cfg=SummarizerConfig(
            window_s=CAIRN_SUMMARY_WINDOW_S, vad_slip_max_s=CAIRN_SUMMARY_VAD_SLIP_MAX_S,
            edit_debounce_s=CAIRN_SUMMARY_EDIT_DEBOUNCE_S,
            final_drain_s=CAIRN_SUMMARY_FINAL_DRAIN_S,
            queue_max=CAIRN_SUMMARY_QUEUE_MAX, timeout_s=CAIRN_LLM_TIMEOUT_S,
            num_ctx_final=CAIRN_LLM_NUM_CTX_FINAL, model=CAIRN_LLM_MODEL,
            enabled=CAIRN_SUMMARY_ENABLED,
        ),
        emit=lambda m: asyncio.create_task(_emit_msg(m)),
        vad_silence_at=_vad_silence_at,
        session_start_s=0.0,
    )

    async def _summary_handler(item: QueueItem) -> None:
        if item.kind == "rolling":
            await summarizer.run_one_window(**item.payload)
        elif item.kind == "resummarize":
            await summarizer.process_pending_edits()
        elif item.kind == "final":
            await summarizer.run_final()

    async def run_summarize_periodically() -> None:
        if not CAIRN_SUMMARY_ENABLED:
            return
        sched = WindowScheduler(
            window_s=CAIRN_SUMMARY_WINDOW_S, vad_slip_max_s=CAIRN_SUMMARY_VAD_SLIP_MAX_S,
        )
        cur_window_start = 0.0
        edit_debounce_task: asyncio.Task | None = None

        async def _flush_edits_after_debounce() -> None:
            await asyncio.sleep(CAIRN_SUMMARY_EDIT_DEBOUNCE_S)
            await summary_queue.put(QueueItem(kind="resummarize", payload=None))

        try:
            while True:
                window_end = await sched.next_boundary(
                    start_s=cur_window_start, vad_silence_at=_vad_silence_at,
                )
                await summary_queue.put(QueueItem(
                    kind="rolling",
                    payload={"window_start_s": cur_window_start, "window_end_s": window_end},
                ))
                cur_window_start = window_end
        except asyncio.CancelledError:
            return
```

- [ ] **Step 4: Start the periodic task and the queue runner alongside the existing tasks**

In the same place where `transcribe_task` and `diarize_task` are created with `asyncio.create_task(...)`:

```python
    summary_task = asyncio.create_task(run_summarize_periodically())
    summary_queue_task = asyncio.create_task(summary_queue.run(_summary_handler))
```

- [ ] **Step 5: Hook `transcript_edit` ingestion**

Wherever `ws_transcribe` already handles incoming `transcript_edit` messages (search for `transcript_edit` in `server.py`), add right after the existing handling:

```python
    # Existing edit handling stays as-is. Summarizer hooks:
    if "text" in edit_payload or "speaker_id" in edit_payload:
        session.apply_edit(
            seq=edit_payload["seq"],
            text=edit_payload.get("text"),
            speaker_id=edit_payload.get("speaker_id"),
        )
        session.note_edit(edit_payload["seq"])
        # Restart debounce
        if edit_debounce_task and not edit_debounce_task.done():
            edit_debounce_task.cancel()
        edit_debounce_task = asyncio.create_task(_flush_edits_after_debounce())
```

(`edit_debounce_task` must be hoisted to be accessible from this block. If `transcript_edit` handling lives outside `run_summarize_periodically`, declare `edit_debounce_task` as a `nonlocal` or move it to the outer `ws_transcribe` scope alongside other shared state.)

- [ ] **Step 6: Hook final-emit ingestion**

Wherever finals are emitted by the transcribe/diarize pipeline, add right after the existing emit:

```python
    session.append_final(
        seq=final_msg["seq"],
        text=final_msg["text"],
        speaker_id=final_msg.get("speaker_id"),
        t_start=final_msg["t_start"],
        t_end=final_msg["t_end"],
    )
```

- [ ] **Step 7: Wire Stop branch for final summary**

In the existing Stop branch (do NOT restructure), append:

```python
    # ---- Final summary on Stop ----
    if CAIRN_SUMMARY_ENABLED:
        await summary_queue.put(QueueItem(kind="final", payload=None))
        try:
            await asyncio.wait_for(
                _wait_queue_empty(summary_queue),
                timeout=CAIRN_SUMMARY_FINAL_DRAIN_S + CAIRN_LLM_TIMEOUT_S + 5,
            )
        except asyncio.TimeoutError:
            pass
    summary_task.cancel()
    summary_queue.stop()
```

Add the helper at module level (or inside `ws_transcribe`, doesn't matter):

```python
async def _wait_queue_empty(q) -> None:
    while q._q:
        await asyncio.sleep(0.1)
```

- [ ] **Step 8: Verify nothing in `ws_transcribe` was reordered or renamed**

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && git diff cairn_svc/server.py | grep -E '^-' | grep -vE '^---' | head -40"
```

Expected: only `-` lines should be inside additions (e.g., the previous closing of an `if` reformatted around an addition). If you see deleted lines outside additive contexts, revert and reshape the patch.

- [ ] **Step 9: Run all svc tests**

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && .venv/bin/python -m pytest -v"
```

Expected: all pre-existing tests pass + new tests pass.

- [ ] **Step 10: Commit**

```bash
ssh nick@precision-node4 "cd ~/cairn-svc && git add cairn_svc/server.py && git commit -m 'feat(svc): wire Summarizer into ws_transcribe (rolling, edits, final on Stop)'"
```

---

### Task 14: End-to-end smoke against real Ollama

**Files:** none (operational verification)

- [ ] **Step 1: Restart cairn-svc on node4**

WARNING: this drops live WS sessions. Confirm none are active first (`systemctl --user status cairn-svc | head -20`).

```bash
ssh nick@precision-node4 "systemctl --user restart cairn-svc && sleep 3 && journalctl --user -u cairn-svc -n 40 --no-pager"
```

Expected: clean startup, no import errors.

- [ ] **Step 2: From the Mac, start the Cairn dev app**

```bash
cd /Users/nickcason/dev/cairn && npm start
```

(Renderer changes haven't shipped yet — sidebar will still say "Last 2 min". This step verifies the svc-side wiring only.)

- [ ] **Step 3: Run a 5-min mock meeting**

Speak (or play recorded audio) for ~5 minutes. Watch the svc logs:

```bash
ssh nick@precision-node4 "journalctl --user -u cairn-svc -f"
```

Expected at ~02:00, ~04:00: log entries showing the Summarizer queueing rolling windows and the LLM client returning bullets. No tracebacks.

- [ ] **Step 4: Press Stop in the Cairn UI**

Expected in logs: a `final` queue item is processed; a `final_summary` event is sent; WS closes cleanly within ~30s.

- [ ] **Step 5: Inspect the saved jsonl**

```bash
ls -lt ~/Documents/Cairn/ | head -5
tail -n 5 ~/Documents/Cairn/<latest>/transcript.jsonl
```

Expected: `rolling_summary` events present at the expected windows; `final_summary` event present at the end.

- [ ] **Step 6: Verify GPU coexistence on node8**

```bash
ssh nick@aorus-node8 "nvidia-smi"
```

Expected: both `whisper` (Speaches) and `ollama` resident; no OOM.

- [ ] **Step 7: If latency > 30s per rolling call, switch to fallback model**

```bash
ssh nick@aorus-node8 "docker exec ollama ollama pull llama3.2:3b-instruct-q5_K_M"
ssh nick@precision-node4 "sed -i 's|^CAIRN_LLM_MODEL=.*|CAIRN_LLM_MODEL=llama3.2:3b-instruct-q5_K_M|' ~/cairn-svc/.env && systemctl --user restart cairn-svc"
```

Re-run smoke test.

**No commit** — operational verification only.

---

### Task 15: Renderer — rolling-list HTML/CSS

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/style.css`

- [ ] **Step 1: Update `index.html`**

Find:
```html
      <h2 class="pane-title summary-title">Last 2 min</h2>
      <div id="summary" class="summary-stub">—</div>
```

Replace with:
```html
      <h2 class="pane-title summary-title">Rolling summary</h2>
      <div id="rolling-list" class="rolling-list">
        <div class="rolling-empty">No summary yet — first recap appears around 2:00.</div>
      </div>
```

In the `<header class="titlebar">`, after the existing buttons, add:
```html
    <button id="view-transcript" class="ghostbtn" hidden>Transcript</button>
    <button id="view-summary" class="ghostbtn" hidden>Summary</button>
```

In `<section class="pane transcript">`, after `<div id="transcript-lines">`, add:
```html
      <div id="final-summary" hidden></div>
```

- [ ] **Step 2: Append to `style.css`**

```css
.rolling-list { display: flex; flex-direction: column; gap: 8px; }
.rolling-empty { color: var(--muted); font-size: 12px; padding: 10px;
                 background: var(--pane-bg); border: 1px solid var(--border);
                 border-radius: 5px; }
.roll-entry { background: var(--pane-bg); border: 1px solid var(--border);
              border-radius: 5px; padding: 8px 10px; font-size: 12px; }
.roll-entry.changed { animation: roll-flash 1s ease-out; }
@keyframes roll-flash { from { background: var(--pane-bg-2); } to { background: var(--pane-bg); } }
.roll-time { color: var(--muted); font-size: 10px; text-transform: uppercase;
             letter-spacing: 0.4px; margin-bottom: 4px; }
.roll-time .merged { color: var(--accent); margin-left: 4px; }
.roll-bullets { margin: 0; padding: 0; list-style: none; }
.roll-bullets li { padding: 2px 0 2px 12px; position: relative; }
.roll-bullets li::before { content: "•"; position: absolute; left: 2px; color: var(--muted); }

#final-summary { padding: 14px 0; font-size: 13px; }
#final-summary h3 { font-size: 13px; text-transform: uppercase;
                    letter-spacing: 0.6px; color: var(--muted);
                    margin: 18px 0 8px; }
#final-summary .tldr { font-size: 14px; line-height: 1.5; margin-bottom: 12px; }
#final-summary table.actions { width: 100%; border-collapse: collapse; font-size: 12px; }
#final-summary table.actions th, #final-summary table.actions td {
  text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--border);
}
#final-summary .truncated-banner { background: var(--pane-bg-2); border: 1px solid var(--border);
                                   border-radius: 4px; padding: 6px 10px; font-size: 11px;
                                   color: var(--muted); margin-bottom: 12px; }
```

- [ ] **Step 3: Visually verify**

```bash
cd /Users/nickcason/dev/cairn && npm start
```

Expected: sidebar shows "Rolling summary" header with empty-state message. Titlebar buttons are still hidden.

- [ ] **Step 4: Commit**

```bash
cd /Users/nickcason/dev/cairn && git add src/renderer/index.html src/renderer/style.css && git commit -m "feat(client): rolling-summary list + final-summary scaffolding in renderer"
```

---

### Task 16: Renderer — `summary.ts` + `ws.ts` dispatch

**Files:**
- Create: `src/renderer/summary.ts`
- Modify: `src/renderer/ws.ts`

- [ ] **Step 1: Read current `ws.ts` to find the message-dispatch site**

```bash
cat /Users/nickcason/dev/cairn/src/renderer/ws.ts
```

Identify the `onmessage` handler / type-switch.

- [ ] **Step 2: Create `summary.ts`**

```ts
// src/renderer/summary.ts

type RollingSummary = {
  type: "rolling_summary";
  idx: number;
  window_start_s: number;
  window_end_s: number;
  bullets: string[];
  generated_at: number;
  merged_from_failed_prior: boolean;
};

type RollingReplace = {
  type: "rolling_summary_replace";
  idx: number;
  bullets: string[];
  generated_at: number;
  reason: string;
};

type FinalSummary =
  | {
      type: "final_summary";
      ok: true;
      tldr: string;
      speakers: { speaker: string; contributions: string[] }[];
      decisions: string[];
      action_items: { assignee: string; item: string; due: string | null }[];
      truncated: boolean;
      model: string;
      generated_at: number;
    }
  | {
      type: "final_summary";
      ok: false;
      error: string;
      model: string;
      generated_at: number;
    };

function mmss(s: number): string {
  const i = Math.floor(s);
  return `${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`;
}

function escape(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

export function handleRollingSummary(msg: RollingSummary): void {
  const list = document.getElementById("rolling-list");
  if (!list) return;
  list.querySelector(".rolling-empty")?.remove();
  const div = document.createElement("div");
  div.className = "roll-entry";
  div.dataset.idx = String(msg.idx);
  div.innerHTML = `
    <div class="roll-time">
      ${mmss(msg.window_start_s)} – ${mmss(msg.window_end_s)}
      ${msg.merged_from_failed_prior ? '<span class="merged" title="merged from prior failed window">↻</span>' : ""}
    </div>
    <ul class="roll-bullets">
      ${msg.bullets.map((b) => `<li>${escape(b)}</li>`).join("")}
    </ul>`;
  // Newest on top
  list.insertBefore(div, list.firstChild);
}

export function handleRollingReplace(msg: RollingReplace): void {
  const list = document.getElementById("rolling-list");
  if (!list) return;
  const card = list.querySelector(`.roll-entry[data-idx="${msg.idx}"]`);
  if (!card) return;
  const ul = card.querySelector(".roll-bullets");
  if (ul) ul.innerHTML = msg.bullets.map((b) => `<li>${escape(b)}</li>`).join("");
  card.classList.remove("changed");
  void (card as HTMLElement).offsetWidth; // force reflow
  card.classList.add("changed");
}

export function handleFinalSummary(msg: FinalSummary): void {
  const target = document.getElementById("final-summary");
  if (!target) return;
  target.innerHTML = "";

  if (!msg.ok) {
    target.innerHTML = `<div class="truncated-banner">Final summary failed: ${escape(msg.error)}</div>`;
  } else {
    const parts: string[] = [];
    if (msg.truncated) {
      parts.push(`<div class="truncated-banner">Transcript truncated for summarization (>12K tokens). Final summary may miss some early content.</div>`);
    }
    parts.push(`<div class="tldr">${escape(msg.tldr)}</div>`);
    if (msg.speakers.length) {
      parts.push(`<h3>By speaker</h3>`);
      for (const sp of msg.speakers) {
        parts.push(`<h4>${escape(sp.speaker)}</h4><ul>${sp.contributions.map((c) => `<li>${escape(c)}</li>`).join("")}</ul>`);
      }
    }
    if (msg.decisions.length) {
      parts.push(`<h3>Decisions</h3><ul>${msg.decisions.map((d) => `<li>${escape(d)}</li>`).join("")}</ul>`);
    }
    if (msg.action_items.length) {
      parts.push(`<h3>Action items</h3><table class="actions"><thead><tr><th>Assignee</th><th>Item</th><th>Due</th></tr></thead><tbody>`);
      for (const a of msg.action_items) {
        parts.push(`<tr><td>${escape(a.assignee)}</td><td>${escape(a.item)}</td><td>${escape(a.due ?? "")}</td></tr>`);
      }
      parts.push(`</tbody></table>`);
    }
    target.innerHTML = parts.join("");
  }

  // Reveal toggle + default to Summary view
  const tBtn = document.getElementById("view-transcript") as HTMLButtonElement | null;
  const sBtn = document.getElementById("view-summary") as HTMLButtonElement | null;
  const lines = document.getElementById("transcript-lines");
  if (tBtn) tBtn.hidden = false;
  if (sBtn) sBtn.hidden = false;
  if (lines) lines.hidden = true;
  target.hidden = false;
}
```

- [ ] **Step 3: Modify `ws.ts` to dispatch new types**

In the existing message-dispatch switch (or if/else chain), add branches:

```ts
import { handleRollingSummary, handleRollingReplace, handleFinalSummary } from "./summary";

// inside the message handler, after existing cases:
case "rolling_summary":
  handleRollingSummary(msg as any);
  break;
case "rolling_summary_replace":
  handleRollingReplace(msg as any);
  break;
case "final_summary":
  handleFinalSummary(msg as any);
  break;
```

(Preserve the existing event-log capture line that pushes raw messages into the buffer used by `main.ts`'s save path. Verify with `grep` that the capture is BEFORE the type-switch and is type-agnostic. If it's not, fix it now: a single line `events.push(msg);` ahead of the switch.)

- [ ] **Step 4: Build and visually verify with the live svc**

```bash
cd /Users/nickcason/dev/cairn && npm start
```

Run a 5-min meeting. Expected: rolling-summary cards appear in the sidebar at ~2:00 and ~4:00, newest on top. Trigger a `transcript_edit` (click-to-edit a line in an earlier window); after 10s, that entry's bullets update with a 1s flash.

- [ ] **Step 5: Commit**

```bash
cd /Users/nickcason/dev/cairn && git add src/renderer/summary.ts src/renderer/ws.ts && git commit -m "feat(client): render rolling-summary list with in-place edit replacement"
```

---

### Task 17: Renderer — Transcript/Summary toggle wiring

**Files:**
- Modify: `src/renderer/app.ts`

- [ ] **Step 1: Read current `app.ts` to find the right wiring spot**

```bash
grep -n "stopbtn\|startbtn\|clearbtn" /Users/nickcason/dev/cairn/src/renderer/app.ts | head
```

- [ ] **Step 2: Add toggle handlers near existing button wiring**

```ts
const viewTranscriptBtn = document.getElementById("view-transcript") as HTMLButtonElement | null;
const viewSummaryBtn = document.getElementById("view-summary") as HTMLButtonElement | null;
const transcriptLines = document.getElementById("transcript-lines");
const finalSummary = document.getElementById("final-summary");

viewTranscriptBtn?.addEventListener("click", () => {
  if (transcriptLines) transcriptLines.hidden = false;
  if (finalSummary) finalSummary.hidden = true;
});
viewSummaryBtn?.addEventListener("click", () => {
  if (transcriptLines) transcriptLines.hidden = true;
  if (finalSummary) finalSummary.hidden = false;
});
```

- [ ] **Step 3: Build and verify with a real Stop**

```bash
cd /Users/nickcason/dev/cairn && npm start
```

Run a meeting, press Stop. Expected: titlebar reveals Transcript/Summary buttons; final summary view appears (TL;DR + per-speaker + decisions + action items); clicking Transcript swaps back; clicking Summary returns.

- [ ] **Step 4: Commit**

```bash
cd /Users/nickcason/dev/cairn && git add src/renderer/app.ts && git commit -m "feat(client): Transcript/Summary titlebar toggle, default to Summary on Stop"
```

---

### Task 18: Verify replay of saved sessions

**Files:** none (verification of existing replay path)

- [ ] **Step 1: Open a saved session that contains summary events**

The `npm start` flow's "open saved session" UI (or whatever existing path the renderer already uses to load a `transcript.jsonl`) should replay every event line through the same handlers. Open a session saved during Task 16/17 testing.

- [ ] **Step 2: Verify rolling list and final summary render from disk**

Expected: same visual result as during the live session — rolling cards in sidebar, Transcript/Summary toggle revealed, final summary view populated.

- [ ] **Step 3: If replay does NOT work, locate the gap**

```bash
grep -n "for.*events\|jsonl\|JSON.parse" /Users/nickcason/dev/cairn/src/renderer/*.ts /Users/nickcason/dev/cairn/src/main.ts
```

Most likely cause: the replay loop dispatches only known transcript event types and silently ignores unknown ones. Add cases for `rolling_summary`, `rolling_summary_replace`, `final_summary` mirroring the live dispatch in Task 16.

- [ ] **Step 4: Commit (if a fix was needed)**

```bash
cd /Users/nickcason/dev/cairn && git add -p && git commit -m "fix(client): replay summary events from saved transcript.jsonl"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Tasks |
| --- | --- |
| §0 Coordination contract | 13 (explicit non-restructuring callouts) |
| §1 Goal | 1–18 |
| §2 Non-goals | (no tasks; constraints only) |
| §3 Architecture | 3, 6–13, 15–17 |
| §4.1 Rolling happy path | 7, 9, 13 |
| §4.2 Edit-driven re-summary | 10, 13 |
| §4.3 Final summary | 11, 13 |
| §4.4 Single-flight queue | 6 |
| §5.1 Ollama deployment | 1 |
| §5.2 Prompts (rolling, final, repair retry) | 3, 8, 11 |
| §5.3 Token budgeting | 11 |
| §6.1–6.3 Wire protocol | 12, 9, 10, 11 |
| §6.4 jsonl persistence (client-side) | 16 (event-log verification), 18 |
| §6.5 No new client→server | (no task; absence) |
| §7.1 Sidebar rolling list | 15, 16 |
| §7.2 Final view + toggle | 15, 16, 17 |
| §7.3 Styles | 15 |
| §7.4 Replay | 18 |
| §8 Configuration | 2, 13 (loader) |
| §9 Failure handling | 3 (retry/timeout), 9 (merge), 10 (re-add seqs), 11 (final-fail event), 13 (drain) |
| §10.1 Unit tests (summarize) | 6, 7, 8, 9, 10, 11 |
| §10.2 Unit tests (llm_client) | 3 |
| §10.3 Fixture-driven integration | (covered by Task 14 smoke + offline tests in 9–11) — fixture jsonl generation is in 14's flow |
| §10.4 Manual smoke | 14, 16, 17, 18 |
| §11 Implementation ordering | 1→18 follows it |

All spec sections covered.

**Placeholder scan:** No "TBD" / "implement later" / "appropriate error handling" / "similar to" patterns. Each step has actual code, actual commands, and concrete expected outcomes.

**Type consistency:** `Summarizer`/`SummarizerConfig`/`SingleFlightQueue`/`QueueItem`/`WindowScheduler`/`build_rolling_prompt`/`build_final_prompt`/`ROLLING_SYSTEM`/`FINAL_SYSTEM`/`LLMClient`/`LLMError` — all names defined in the task that introduces them and used consistently downstream. Session methods `append_final`/`apply_edit`/`ledger_window`/`ledger_all`/`ledger_lookup_seq_time`/`add_rolling_entry`/`replace_rolling_entry`/`rolling_entries_all`/`note_edit`/`drain_pending_edits` are introduced in Tasks 4–5 and used identically in Tasks 9–11, 13. Wire-protocol message types `rolling_summary`/`rolling_summary_replace`/`final_summary` use the spec §6 schemas in producers (Tasks 9–11) and consumers (Task 16).
