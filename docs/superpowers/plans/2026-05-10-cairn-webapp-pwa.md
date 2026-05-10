# Cairn Webapp on node4 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Electron Mac client with a tailnet-served webapp running out of `cairn-svc` on node4. Mac is the v1 capture target. iPhone PWA polish + native iOS shell with ReplayKit are explicit follow-on projects (not part of this plan).

**Architecture:** Single FastAPI process on node4 serves the UI bundle, REST endpoints (`/sessions`, `/control/*`), and the existing WebSocket (`/ws/transcribe`) — fronted by `tailscale serve` for HTTPS. The Mac renderer is repurposed verbatim; only Electron-IPC call sites become `fetch()` and URL-param reads. Sessions land server-side at `~/cairn-svc/sessions/<slug>/`. cairn-loop.sh harness retargets URLs and is preserved end-to-end.

**Tech Stack:** FastAPI 0.115+, uvicorn 0.32+, Pydantic 2.x, Python 3.11 (cairn-svc on node4) · TypeScript 5.6, browser DOM + WebSocket + AudioWorklet (Mac renderer) · pytest 8 + pytest-asyncio 0.24 (server tests) · `tailscale serve` for TLS termination.

**Repos involved:**
- Mac repo: `/Users/nickcason/dev/cairn` — push to `origin/main` (NickCason/cairn).
- node4 repo: `~/cairn-svc/` on node4 (`100.99.99.72`) — local-only, no remote. Restart with `systemctl --user restart cairn-svc`.

**SteeLL-v1 (Qwen 7b coder) usage:** Tasks 1, 4, 6, 13 route boilerplate generation through `scripts/qwen-helper.sh` (model: `qwen2.5-coder:7b` on node8). All Qwen output is reviewed and edited before commit. Commits using its output get a `Co-Authored-By: SteeLL-v1 <noreply@local>` trailer.

---

## File Structure

**Created (cairn-svc, on node4):**
- `cairn_svc/sessions.py` — POST/GET/GET-by-slug `/sessions` routes + slug helper
- `cairn_svc/control.py` — `/control/{start,stop,status,transcript}` routes + module-level `state`, `stop_event`, `latest_transcript_snapshot`
- `cairn_svc/static_routes.py` — mounts `/assets` + `/` for the UI bundle
- `cairn_svc/webapp_state.py` — shared module holding `state`, `stop_event`, `latest_transcript_snapshot` so `sessions.py` and `control.py` can both reach it without circular imports
- `tests/test_sessions.py`
- `tests/test_control.py`
- `tests/test_static_routes.py`
- `webapp/` (deploy target — populated by `scripts/deploy-ui.sh`, not committed)

**Modified (cairn-svc):**
- `cairn_svc/protocol.py` — add `ControlStopMsg` outbound model
- `cairn_svc/server.py` — wire 3 new routers, integrate `webapp_state` into the WS handler at `@app.websocket("/ws/transcribe")` (line ~823) for `state.state = "recording"` on StartMsg, append-on-final, poll `stop_event` each receive iteration
- `.env.example` — document `CAIRN_SESSIONS_ROOT`, `CAIRN_WEBAPP_ROOT`

**Created (Mac repo):**
- `scripts/deploy-ui.sh` — rsync UI bundle to node4 + restart cairn-svc

**Modified (Mac repo):**
- `src/renderer/app.ts` — replace Electron IPC, derive WS URL from `location`, URL-param-driven start, `control_stop` WS handling
- `src/renderer/index.html` — absolute asset URLs, viewport meta
- `src/renderer/audio.ts` — absolute worklet URL
- `package.json` — drop electron + scripts + build block, add `deploy` script, simplify `build`
- `scripts/cairn-loop.sh` — retarget URLs from `127.0.0.1:8765` → `precision-node4.taild99f50.ts.net`
- `.gitignore` — already has `dist-app/` (verified during commit phase)

**Deleted (Mac repo, after server-side is up):**
- `src/main.ts`
- `src/preload.ts`
- `tsconfig.json` (Electron-main config; renderer config is the only one left)
- `dist-app/` (regenerable; removed locally; not in repo)

---

## Execution Order

Server-first, then client cutover, then harness validation, then cleanup. This order means cairn-svc never breaks the existing Electron client mid-implementation — the Electron client keeps working until Task 14 deletes it.

```
T1  protocol.ControlStopMsg  ┐
T2  webapp_state module      │ — server data plane
T3  sessions.py + tests      │
T4  static_routes.py + test  │
T5  control.py + tests       │
T6  .env.example + paths     ┘

T7  server.py wiring         ┐ — server integration
T8  WS-side stop_event push  │
T9  smoke against new svc    ┘

T10 client app.ts fetch IPC  ┐ — client cutover
T11 client URL-param flow    │
T12 client WS dynamic origin │
T13 client index.html/audio  │
T14 deploy-ui.sh             ┘

T15 cairn-loop.sh retarget   ┐ — harness preservation
T16 end-to-end smoke         │
T17 baseline regression run  ┘

T18 strip Electron remnants    — cleanup
T19 tailscale serve setup      — TLS
```

---

## Task 1: protocol.ControlStopMsg

**Files:**
- Modify: `~/cairn-svc/cairn_svc/protocol.py` (on node4) — append after the existing outbound models

**SteeLL-v1 task:** YES (boilerplate Pydantic addition).

- [ ] **Step 1: SSH to node4 and read current protocol.py outbound section**

```bash
ssh nick@100.99.99.72 "sed -n '60,176p' ~/cairn-svc/cairn_svc/protocol.py"
```

Expected: outbound model block ending around `ErrorMsg`. Note the import style (`Literal[...]` discriminators, `BaseModel`).

- [ ] **Step 2: Generate ControlStopMsg via Qwen, review, then patch**

Run from Mac repo root:

```bash
cat <<'EOF' | scripts/qwen-helper.sh "ControlStopMsg pydantic outbound model"
Add a Pydantic v2 BaseModel named ControlStopMsg to a FastAPI websocket protocol module.
It is an outbound (server -> client) discriminated message with a Literal["control_stop"] type field
and no other fields. The module already imports Literal from typing and BaseModel from pydantic.
Show only the class definition (no imports, no surrounding code). Match the style of:

class StopMsg(BaseModel):
    type: Literal["stop"] = "stop"
EOF
```

Expected output (verify it matches; edit if not):

```python
class ControlStopMsg(BaseModel):
    type: Literal["control_stop"] = "control_stop"
```

- [ ] **Step 3: Apply the patch on node4**

```bash
ssh nick@100.99.99.72 "cat >> /tmp/control_stop_patch.py << 'EOF'

class ControlStopMsg(BaseModel):
    type: Literal[\"control_stop\"] = \"control_stop\"
EOF
"
```

Then on node4, find the right insertion point (after `ErrorMsg`, before any module-trailing definitions) and insert. Verify syntactically:

```bash
ssh nick@100.99.99.72 "cd ~/cairn-svc && .venv/bin/python -c 'from cairn_svc.protocol import ControlStopMsg; print(ControlStopMsg().model_dump())'"
```

Expected: `{'type': 'control_stop'}`.

- [ ] **Step 4: Commit on node4 (local-only, cairn-svc has no remote)**

```bash
ssh nick@100.99.99.72 "cd ~/cairn-svc && git add cairn_svc/protocol.py && git commit -m 'feat(protocol): add ControlStopMsg outbound model

Co-Authored-By: SteeLL-v1 <noreply@local>'"
```

---

## Task 2: webapp_state shared module

**Files:**
- Create: `~/cairn-svc/cairn_svc/webapp_state.py`

**SteeLL-v1 task:** No (correctness-sensitive: `asyncio.Event` lifecycle).

- [ ] **Step 1: Write the failing test**

Create `~/cairn-svc/tests/test_webapp_state.py`:

```python
import asyncio
import pytest
from cairn_svc.webapp_state import state, stop_event, latest_transcript_snapshot, ControlState


def test_initial_state_is_idle():
    assert isinstance(state, ControlState)
    assert state.state == "idle"
    assert state.meeting_name == ""
    assert state.session_dir is None
    assert state.ledger_count == 0


def test_stop_event_is_asyncio_event():
    assert isinstance(stop_event, asyncio.Event)
    assert not stop_event.is_set()


def test_latest_transcript_snapshot_is_list():
    assert isinstance(latest_transcript_snapshot, list)


def test_state_is_module_singleton():
    from cairn_svc.webapp_state import state as state_again
    assert state is state_again
```

- [ ] **Step 2: Run test (will fail — module doesn't exist)**

```bash
ssh nick@100.99.99.72 "cd ~/cairn-svc && .venv/bin/pytest tests/test_webapp_state.py -v 2>&1 | tail -10"
```

Expected: `ModuleNotFoundError: No module named 'cairn_svc.webapp_state'`

- [ ] **Step 3: Implement webapp_state.py**

Create `~/cairn-svc/cairn_svc/webapp_state.py`:

```python
"""Shared mutable state for the webapp HTTP/WS surface.

Imported by server.py (WS handler), sessions.py (save handler), and control.py
(harness routes). Single source of truth for "is a session active" and the
stop-pulse event that bridges POST /control/stop to the in-flight WS receive
loop.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Literal


@dataclass
class ControlState:
    state: Literal["idle", "recording", "stopping", "stopped"] = "idle"
    meeting_name: str = ""
    session_dir: str | None = None
    ledger_count: int = 0


state: ControlState = ControlState()
stop_event: asyncio.Event = asyncio.Event()
latest_transcript_snapshot: list[dict] = []
```

- [ ] **Step 4: Run test (passes)**

```bash
ssh nick@100.99.99.72 "cd ~/cairn-svc && .venv/bin/pytest tests/test_webapp_state.py -v 2>&1 | tail -10"
```

Expected: 4 passed.

- [ ] **Step 5: Commit (on node4)**

```bash
ssh nick@100.99.99.72 "cd ~/cairn-svc && git add cairn_svc/webapp_state.py tests/test_webapp_state.py && git commit -m 'feat(webapp_state): shared control state + stop-pulse asyncio.Event

Single source of truth for harness control state, the stop event that
bridges POST /control/stop to the WS receive loop, and the latest
transcript snapshot the GET /control/transcript endpoint returns.'"
```

---

## Task 3: sessions.py module + tests

**Files:**
- Create: `~/cairn-svc/cairn_svc/sessions.py`
- Create: `~/cairn-svc/tests/test_sessions.py`

**SteeLL-v1 task:** No (controls on-disk schema; correctness matters).

- [ ] **Step 1: Write the failing test**

Create `~/cairn-svc/tests/test_sessions.py`:

```python
import json
import os
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setenv("CAIRN_SESSIONS_ROOT", str(tmp_path))
    # Reset module-level state so tests don't bleed between runs
    import importlib
    import cairn_svc.webapp_state
    importlib.reload(cairn_svc.webapp_state)
    import cairn_svc.sessions
    importlib.reload(cairn_svc.sessions)

    a = FastAPI()
    a.include_router(cairn_svc.sessions.router)
    return a


@pytest.fixture
def client(app):
    return TestClient(app)


def test_save_session_writes_jsonl_and_meta(client, tmp_path):
    body = {
        "meeting_name": "Vendor Sync",
        "events": [
            {"type": "transcript_final", "seq": 1, "text": "hi", "speaker_id": "S1"},
            {"type": "rolling_summary", "idx": 0, "bullets": ["one"]},
        ],
    }
    r = client.post("/sessions", json=body)
    assert r.status_code == 200, r.text
    data = r.json()
    assert "slug" in data
    assert "session_dir" in data
    dir_ = Path(data["session_dir"])
    assert (dir_ / "transcript.jsonl").exists()
    assert (dir_ / "meta.json").exists()
    lines = (dir_ / "transcript.jsonl").read_text().strip().split("\n")
    assert len(lines) == 2
    assert json.loads(lines[0])["text"] == "hi"
    meta = json.loads((dir_ / "meta.json").read_text())
    assert meta["meeting_name"] == "Vendor Sync"
    assert meta["event_count"] == 2


def test_save_session_slug_normalizes_meeting_name(client):
    body = {"meeting_name": "Vendor Sync!! 2026", "events": []}
    r = client.post("/sessions", json=body)
    slug = r.json()["slug"]
    # YYYY-MM-DD-vendor-sync-2026 — punctuation and case folded, spaces hyphenated
    assert "vendor-sync-2026" in slug
    assert not any(c in slug for c in "! ")


def test_save_session_overwrites_same_slug(client):
    body1 = {"meeting_name": "x", "events": [{"a": 1}]}
    body2 = {"meeting_name": "x", "events": [{"a": 1}, {"b": 2}]}
    r1 = client.post("/sessions", json=body1)
    r2 = client.post("/sessions", json=body2)
    assert r1.json()["slug"] == r2.json()["slug"]
    dir_ = Path(r2.json()["session_dir"])
    lines = (dir_ / "transcript.jsonl").read_text().strip().split("\n")
    assert len(lines) == 2  # second write wins


def test_list_sessions_returns_newest_first(client):
    client.post("/sessions", json={"meeting_name": "alpha", "events": []})
    client.post("/sessions", json={"meeting_name": "beta", "events": []})
    r = client.get("/sessions")
    assert r.status_code == 200
    items = r.json()
    assert len(items) >= 2
    # newest first by saved_at — beta was saved last
    saved_ats = [it["saved_at"] for it in items]
    assert saved_ats == sorted(saved_ats, reverse=True)


def test_read_session_returns_meta_and_events(client):
    body = {"meeting_name": "delta", "events": [{"type": "x", "n": 7}]}
    save = client.post("/sessions", json=body)
    slug = save.json()["slug"]
    r = client.get(f"/sessions/{slug}")
    assert r.status_code == 200
    data = r.json()
    assert data["meta"]["meeting_name"] == "delta"
    assert data["events"] == [{"type": "x", "n": 7}]


def test_save_session_flips_control_state_to_stopped(client, monkeypatch):
    import cairn_svc.webapp_state as ws
    ws.state.state = "stopping"  # as if a /control/stop just fired
    r = client.post("/sessions", json={"meeting_name": "loop-x", "events": []})
    assert r.status_code == 200
    assert ws.state.state == "stopped"
    assert ws.state.session_dir == r.json()["session_dir"]
```

- [ ] **Step 2: Run test (fails — sessions module missing)**

```bash
ssh nick@100.99.99.72 "cd ~/cairn-svc && .venv/bin/pytest tests/test_sessions.py -v 2>&1 | tail -10"
```

Expected: `ModuleNotFoundError: No module named 'cairn_svc.sessions'`.

- [ ] **Step 3: Implement sessions.py**

Create `~/cairn-svc/cairn_svc/sessions.py`:

```python
"""HTTP routes for session persistence.

POST /sessions       — save transcript.jsonl + meta.json under SESSIONS_ROOT/<slug>/
GET  /sessions       — list sessions, newest first
GET  /sessions/{slug} — read a session

Slug format: <YYYY-MM-DD>-<sanitized-meeting-name>. Same-day repeats with the
same meeting_name overwrite (intentional — supports the post-stop rename
re-save flow).
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import webapp_state


SESSIONS_ROOT: Path = Path(
    os.environ.get(
        "CAIRN_SESSIONS_ROOT",
        str(Path.home() / "cairn-svc" / "sessions"),
    )
)


def _slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s or "untitled"


router = APIRouter(prefix="/sessions")


class SaveBody(BaseModel):
    meeting_name: str
    events: list[dict[str, Any]]


@router.post("")
async def save_session(body: SaveBody) -> dict:
    SESSIONS_ROOT.mkdir(parents=True, exist_ok=True)
    date = datetime.utcnow().strftime("%Y-%m-%d")
    slug = f"{date}-{_slugify(body.meeting_name)}"
    dir_ = SESSIONS_ROOT / slug
    dir_.mkdir(parents=True, exist_ok=True)
    (dir_ / "transcript.jsonl").write_text(
        "\n".join(json.dumps(e) for e in body.events) + ("\n" if body.events else "")
    )
    (dir_ / "meta.json").write_text(
        json.dumps(
            {
                "meeting_name": body.meeting_name,
                "saved_at": datetime.utcnow().isoformat() + "Z",
                "event_count": len(body.events),
                "slug": slug,
            },
            indent=2,
        )
    )
    # Final step: flip harness control state to "stopped" so cairn-loop.sh's
    # GET /control/status poll completes.
    webapp_state.state.state = "stopped"
    webapp_state.state.session_dir = str(dir_)
    return {"session_dir": str(dir_), "slug": slug}


@router.get("")
async def list_sessions() -> list[dict]:
    if not SESSIONS_ROOT.exists():
        return []
    out: list[dict] = []
    for p in SESSIONS_ROOT.iterdir():
        meta_path = p / "meta.json"
        if not meta_path.exists():
            continue
        try:
            meta = json.loads(meta_path.read_text())
        except json.JSONDecodeError:
            continue
        out.append({"slug": p.name, **meta})
    return sorted(out, key=lambda m: m.get("saved_at", ""), reverse=True)


@router.get("/{slug}")
async def read_session(slug: str) -> dict:
    dir_ = SESSIONS_ROOT / slug
    meta_path = dir_ / "meta.json"
    transcript_path = dir_ / "transcript.jsonl"
    if not meta_path.exists() or not transcript_path.exists():
        raise HTTPException(status_code=404, detail=f"session {slug!r} not found")
    return {
        "meta": json.loads(meta_path.read_text()),
        "events": [
            json.loads(line)
            for line in transcript_path.read_text().splitlines()
            if line.strip()
        ],
    }
```

- [ ] **Step 4: Run test (passes)**

```bash
ssh nick@100.99.99.72 "cd ~/cairn-svc && .venv/bin/pytest tests/test_sessions.py -v 2>&1 | tail -20"
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
ssh nick@100.99.99.72 "cd ~/cairn-svc && git add cairn_svc/sessions.py tests/test_sessions.py && git commit -m 'feat(sessions): POST/GET routes for transcript+meta persistence

Replaces the Electron IPC saveSession handler with server-side storage at
SESSIONS_ROOT/<YYYY-MM-DD>-<slug>/. Same-day same-name overwrites
intentionally to support the post-stop rename re-save flow. Save handler
flips webapp_state.state to stopped as its final step so the cairn-loop
harness has a single source of truth for completion.'"
```

---

## Task 4: static_routes.py module + test

**Files:**
- Create: `~/cairn-svc/cairn_svc/static_routes.py`
- Create: `~/cairn-svc/tests/test_static_routes.py`

**SteeLL-v1 task:** YES (small, mechanical FastAPI mount).

- [ ] **Step 1: Write the failing test**

Create `~/cairn-svc/tests/test_static_routes.py`:

```python
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def webapp_dir(tmp_path):
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text("<!DOCTYPE html><html><body>Cairn</body></html>")
    (tmp_path / "assets" / "app.js").write_text("// app")
    (tmp_path / "assets" / "style.css").write_text("body{}")
    return tmp_path


@pytest.fixture
def client(webapp_dir, monkeypatch):
    monkeypatch.setenv("CAIRN_WEBAPP_ROOT", str(webapp_dir))
    import importlib
    import cairn_svc.static_routes
    importlib.reload(cairn_svc.static_routes)
    a = FastAPI()
    cairn_svc.static_routes.mount(a)
    return TestClient(a)


def test_root_serves_index_html(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "Cairn" in r.text
    assert "text/html" in r.headers["content-type"]


def test_assets_serve_js(client):
    r = client.get("/assets/app.js")
    assert r.status_code == 200
    assert r.text == "// app"


def test_assets_serve_css(client):
    r = client.get("/assets/style.css")
    assert r.status_code == 200
    assert r.text == "body{}"


def test_unknown_asset_404s(client):
    r = client.get("/assets/missing.js")
    assert r.status_code == 404
```

- [ ] **Step 2: Run test (fails)**

```bash
ssh nick@100.99.99.72 "cd ~/cairn-svc && .venv/bin/pytest tests/test_static_routes.py -v 2>&1 | tail -10"
```

Expected: `ModuleNotFoundError`.

- [ ] **Step 3: Generate static_routes.py via Qwen**

Run from Mac repo root:

```bash
cat <<'EOF' | scripts/qwen-helper.sh "static_routes module FastAPI mount + index"
Write a Python module cairn_svc/static_routes.py for a FastAPI app. It exports a single
function `mount(app: FastAPI) -> None` that:
1. Reads WEBAPP_ROOT from os.environ["CAIRN_WEBAPP_ROOT"], defaulting to
   ~/cairn-svc/webapp.
2. Mounts StaticFiles at /assets serving WEBAPP_ROOT/assets.
3. Registers a GET / route (include_in_schema=False) that returns FileResponse
   for WEBAPP_ROOT/index.html.

Use:
- from pathlib import Path
- from fastapi import FastAPI
- from fastapi.staticfiles import StaticFiles
- from fastapi.responses import FileResponse

Read WEBAPP_ROOT inside mount() (not at import time) so tests that monkeypatch
the env var work. Show the complete module file.
EOF
```

Review and patch the output. The expected module:

```python
"""Static UI bundle routes.

Mounts /assets/* and /. Read WEBAPP_ROOT inside mount() so tests that
monkeypatch CAIRN_WEBAPP_ROOT pick up the override.
"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles


def mount(app: FastAPI) -> None:
    webapp_root = Path(
        os.environ.get(
            "CAIRN_WEBAPP_ROOT",
            str(Path.home() / "cairn-svc" / "webapp"),
        )
    )
    app.mount(
        "/assets",
        StaticFiles(directory=str(webapp_root / "assets")),
        name="assets",
    )

    @app.get("/", include_in_schema=False)
    async def index() -> FileResponse:
        return FileResponse(webapp_root / "index.html")
```

If Qwen produced something close but not identical, edit to match the above (especially: read env inside `mount()`, not at module top-level — this is what makes the test fixture work).

- [ ] **Step 4: Run test (passes)**

```bash
ssh nick@100.99.99.72 "cd ~/cairn-svc && .venv/bin/pytest tests/test_static_routes.py -v 2>&1 | tail -10"
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
ssh nick@100.99.99.72 "cd ~/cairn-svc && git add cairn_svc/static_routes.py tests/test_static_routes.py && git commit -m 'feat(static_routes): mount UI bundle at / and /assets

Co-Authored-By: SteeLL-v1 <noreply@local>'"
```

---

## Task 5: control.py module + tests

**Files:**
- Create: `~/cairn-svc/cairn_svc/control.py`
- Create: `~/cairn-svc/tests/test_control.py`

**SteeLL-v1 task:** No (asyncio.Event semantics + harness contract).

- [ ] **Step 1: Write the failing test**

Create `~/cairn-svc/tests/test_control.py`:

```python
import importlib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    import cairn_svc.webapp_state
    importlib.reload(cairn_svc.webapp_state)  # reset state singleton
    import cairn_svc.control
    importlib.reload(cairn_svc.control)
    a = FastAPI()
    a.include_router(cairn_svc.control.router)
    return TestClient(a)


def test_status_starts_idle(client):
    r = client.get("/control/status")
    assert r.status_code == 200
    assert r.json()["state"] == "idle"
    assert r.json()["meeting_name"] == ""


def test_post_start_records_meeting_name_and_returns_url(client):
    r = client.post("/control/start", json={"meeting_name": "loop-xyz"})
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["meeting_name"] == "loop-xyz"
    assert data["url"] == "/?meeting_name=loop-xyz&autostart=1"
    # State stays idle until the WS handler sees the StartMsg
    s = client.get("/control/status").json()
    assert s["state"] == "idle"
    assert s["meeting_name"] == "loop-xyz"


def test_post_start_with_no_body_generates_meeting_name(client):
    r = client.post("/control/start")
    assert r.status_code == 200
    name = r.json()["meeting_name"]
    assert name.startswith("loop-")


def test_post_stop_sets_stop_event_and_state_to_stopping(client):
    import cairn_svc.webapp_state as ws
    assert not ws.stop_event.is_set()
    r = client.post("/control/stop")
    assert r.status_code == 200
    assert r.json()["ok"] is True
    assert ws.stop_event.is_set()
    assert ws.state.state == "stopping"


def test_post_start_clears_stop_event(client):
    import cairn_svc.webapp_state as ws
    ws.stop_event.set()
    client.post("/control/start", json={"meeting_name": "fresh"})
    assert not ws.stop_event.is_set()


def test_get_transcript_returns_snapshot(client):
    import cairn_svc.webapp_state as ws
    ws.latest_transcript_snapshot.clear()
    ws.latest_transcript_snapshot.extend([
        {"seq": 1, "text": "hi", "speaker_id": "S1"},
        {"seq": 2, "text": "hello", "speaker_id": "S2"},
    ])
    r = client.get("/control/transcript")
    assert r.status_code == 200
    assert r.json() == [
        {"seq": 1, "text": "hi", "speaker_id": "S1"},
        {"seq": 2, "text": "hello", "speaker_id": "S2"},
    ]
```

- [ ] **Step 2: Run test (fails)**

```bash
ssh nick@100.99.99.72 "cd ~/cairn-svc && .venv/bin/pytest tests/test_control.py -v 2>&1 | tail -10"
```

Expected: ModuleNotFoundError.

- [ ] **Step 3: Implement control.py**

Create `~/cairn-svc/cairn_svc/control.py`:

```python
"""HTTP control surface for the cairn-loop.sh end-to-end harness.

POST /control/start  — record meeting_name, clear stop_event, return autostart URL
POST /control/stop   — set stop_event so the WS handler pushes control_stop
GET  /control/status — current ControlState (used by harness poll loop)
GET  /control/transcript — latest transcript_final snapshot

State transitions:
    idle      → recording  (in WS handler on StartMsg)
    recording → stopping   (here, on POST /control/stop)
    stopping  → stopped    (in sessions.py save handler, after disk write)
"""
from __future__ import annotations

from dataclasses import asdict
from datetime import datetime
from typing import Any

from fastapi import APIRouter

from . import webapp_state


router = APIRouter(prefix="/control")


@router.post("/start")
async def control_start(body: dict[str, Any] | None = None) -> dict:
    name = (body or {}).get("meeting_name") or _default_meeting_name()
    webapp_state.state.meeting_name = name
    webapp_state.state.session_dir = None
    webapp_state.state.ledger_count = 0
    webapp_state.state.state = "idle"  # actual transition happens in WS handler
    webapp_state.stop_event.clear()
    webapp_state.latest_transcript_snapshot.clear()
    return {
        "ok": True,
        "meeting_name": name,
        "url": f"/?meeting_name={name}&autostart=1",
    }


@router.post("/stop")
async def control_stop() -> dict:
    webapp_state.state.state = "stopping"
    webapp_state.stop_event.set()
    return {"ok": True}


@router.get("/status")
async def control_status() -> dict:
    return asdict(webapp_state.state)


@router.get("/transcript")
async def control_transcript() -> list[dict]:
    return list(webapp_state.latest_transcript_snapshot)


def _default_meeting_name() -> str:
    iso = datetime.utcnow().isoformat(timespec="seconds").replace(":", "-")
    return f"loop-{iso}"
```

- [ ] **Step 4: Run test (passes)**

```bash
ssh nick@100.99.99.72 "cd ~/cairn-svc && .venv/bin/pytest tests/test_control.py -v 2>&1 | tail -15"
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
ssh nick@100.99.99.72 "cd ~/cairn-svc && git add cairn_svc/control.py tests/test_control.py && git commit -m 'feat(control): /control/{start,stop,status,transcript} for cairn-loop harness

Replaces the Electron 127.0.0.1:8765 control HTTP server. POST /stop sets
an asyncio.Event the WS handler polls each receive iteration, then pushes
control_stop downstream so the page calls stopLiveSession + POST /sessions.
GET /status and /transcript power the harness poll loop unchanged.'"
```

---

## Task 6: .env.example documentation

**Files:**
- Modify: `~/cairn-svc/.env.example`

**SteeLL-v1 task:** YES (one block of env-var docs).

- [ ] **Step 1: Read current .env.example**

```bash
ssh nick@100.99.99.72 "cat ~/cairn-svc/.env.example"
```

- [ ] **Step 2: Generate doc block via Qwen**

```bash
cat <<'EOF' | scripts/qwen-helper.sh "env vars block for webapp paths"
Write a documentation block (env-file format) for two new environment variables
of a Python service called cairn-svc:

CAIRN_SESSIONS_ROOT — directory where saved sessions land. Default:
  ~/cairn-svc/sessions. Each session lives at <root>/<YYYY-MM-DD>-<slug>/
  with transcript.jsonl + meta.json. Same-day same-name writes overwrite.

CAIRN_WEBAPP_ROOT — directory the FastAPI app serves UI assets from. Default:
  ~/cairn-svc/webapp. Must contain index.html and an assets/ subdirectory
  populated by the Mac-side scripts/deploy-ui.sh script.

Format: each var preceded by a comment block explaining what it does and the
default. Keep lines under 80 chars. Do not invent other variables.
EOF
```

- [ ] **Step 3: Append to .env.example on node4**

Review Qwen's output. Final block to append (edit if Qwen drifted):

```
# === Webapp / sessions paths (added by webapp cutover) ===

# Directory where saved sessions land. Each session lives at
# <CAIRN_SESSIONS_ROOT>/<YYYY-MM-DD>-<slug>/ with transcript.jsonl +
# meta.json. Same-day same-name writes overwrite (intentional — supports
# post-stop rename re-save flow).
# CAIRN_SESSIONS_ROOT=/home/nick/cairn-svc/sessions

# Directory the FastAPI app serves UI assets from. Must contain
# index.html and an assets/ subdirectory populated by the Mac-side
# scripts/deploy-ui.sh script.
# CAIRN_WEBAPP_ROOT=/home/nick/cairn-svc/webapp
```

Apply:

```bash
ssh nick@100.99.99.72 "cat >> ~/cairn-svc/.env.example << 'EOF'

# === Webapp / sessions paths (added by webapp cutover) ===

# Directory where saved sessions land. Each session lives at
# <CAIRN_SESSIONS_ROOT>/<YYYY-MM-DD>-<slug>/ with transcript.jsonl +
# meta.json. Same-day same-name writes overwrite (intentional — supports
# post-stop rename re-save flow).
# CAIRN_SESSIONS_ROOT=/home/nick/cairn-svc/sessions

# Directory the FastAPI app serves UI assets from. Must contain
# index.html and an assets/ subdirectory populated by the Mac-side
# scripts/deploy-ui.sh script.
# CAIRN_WEBAPP_ROOT=/home/nick/cairn-svc/webapp
EOF
"
```

- [ ] **Step 4: Commit**

```bash
ssh nick@100.99.99.72 "cd ~/cairn-svc && git add .env.example && git commit -m 'docs(env): document CAIRN_SESSIONS_ROOT + CAIRN_WEBAPP_ROOT

Co-Authored-By: SteeLL-v1 <noreply@local>'"
```

---

## Task 7: server.py — wire routers, append finals, push control_stop

**Files:**
- Modify: `~/cairn-svc/cairn_svc/server.py` (imports near top + `app = FastAPI()` site + WS handler at `@app.websocket("/ws/transcribe")` line ~823)

**SteeLL-v1 task:** No — touches the diarization/transcription hot path.

**Touch points (verified by reading the current file):**
- Imports block ends at line 18 (`from .protocol import (...)`)
- WS handler starts at line 823: `@app.websocket("/ws/transcribe")`
- Receive loop: `while True: msg = await ws.receive()` at line ~1401
- `TranscriptFinalMsg` emit sites: line 868 (in `_drain_pending`) and line 1447 (a second emit path)
- `app = FastAPI()` is somewhere before line 823 — locate with `grep -n 'app = FastAPI' server.py`

- [ ] **Step 1: Add the new imports**

After the existing `from .protocol import (...)` block (line ~18), add:

```python
from . import webapp_state
from .sessions import router as _sessions_router
from .control import router as _control_router
from .static_routes import mount as _mount_static
```

Apply via SSH (locate the line first, then sed-insert):

```bash
ssh nick@100.99.99.72 "cd ~/cairn-svc && grep -n '^from .protocol' cairn_svc/server.py"
# Note the line number, e.g. 13. The protocol import block spans 13-18.
# Insert the new imports after line 18.
ssh nick@100.99.99.72 "cd ~/cairn-svc && python3 - <<'PY'
from pathlib import Path
p = Path('cairn_svc/server.py')
src = p.read_text().splitlines(keepends=True)
# find end of '.protocol import' block (closing paren line)
for i, line in enumerate(src):
    if line.startswith('from .protocol import') or (i > 0 and src[i-1].startswith('from .protocol') and ')' in line):
        end = i if ')' in line else None
        if end is not None:
            insert_at = end + 1
            break
new_imports = '''from . import webapp_state
from .sessions import router as _sessions_router
from .control import router as _control_router
from .static_routes import mount as _mount_static
'''
src.insert(insert_at, new_imports)
p.write_text(''.join(src))
print(f'Inserted at line {insert_at + 1}')
PY"
```

Verify:

```bash
ssh nick@100.99.99.72 "cd ~/cairn-svc && grep -n 'webapp_state\\|_sessions_router\\|_mount_static' cairn_svc/server.py | head -5"
```

Expected: 4 lines, all near the top of the file.

- [ ] **Step 2: Wire routers + static mount after `app = FastAPI()`**

```bash
ssh nick@100.99.99.72 "cd ~/cairn-svc && grep -n '^app = FastAPI' cairn_svc/server.py"
```

Take the line number (call it `N`). Insert immediately after, on line `N+1`:

```python
app.include_router(_sessions_router)
app.include_router(_control_router)
_mount_static(app)
```

Apply (replace `N` with the actual line number):

```bash
ssh nick@100.99.99.72 "cd ~/cairn-svc && python3 - <<'PY'
from pathlib import Path
p = Path('cairn_svc/server.py')
src = p.read_text().splitlines(keepends=True)
for i, line in enumerate(src):
    if line.strip().startswith('app = FastAPI'):
        wire = '''app.include_router(_sessions_router)
app.include_router(_control_router)
_mount_static(app)
'''
        src.insert(i + 1, wire)
        break
p.write_text(''.join(src))
print('wired')
PY"
```

- [ ] **Step 3: On StartMsg, set state to recording**

In the WS handler's `if isinstance(ctrl, StartMsg):` branch (around line 1412), insert after the `session = Session(...)` line:

```python
                    webapp_state.state.state = "recording"
                    webapp_state.state.meeting_name = ctrl.meeting_name
                    webapp_state.state.session_dir = None
                    webapp_state.state.ledger_count = 0
                    webapp_state.latest_transcript_snapshot.clear()
                    webapp_state.stop_event.clear()
```

Apply:

```bash
ssh nick@100.99.99.72 "cd ~/cairn-svc && python3 - <<'PY'
from pathlib import Path
p = Path('cairn_svc/server.py')
src = p.read_text().splitlines(keepends=True)
for i, line in enumerate(src):
    if 'session = Session(meeting_name=ctrl.meeting_name)' in line:
        indent = line[:len(line) - len(line.lstrip())]
        block = ''.join(indent + l + '\n' for l in [
            'webapp_state.state.state = \"recording\"',
            'webapp_state.state.meeting_name = ctrl.meeting_name',
            'webapp_state.state.session_dir = None',
            'webapp_state.state.ledger_count = 0',
            'webapp_state.latest_transcript_snapshot.clear()',
            'webapp_state.stop_event.clear()',
        ])
        src.insert(i + 1, block)
        break
p.write_text(''.join(src))
print('start-state hook inserted')
PY"
```

- [ ] **Step 4: After each TranscriptFinalMsg emit, append to snapshot**

The two emit sites are line ~868 and line ~1447. Both call `await ws.send_text(TranscriptFinalMsg(...).model_dump_json())`. After each, append:

```python
                    webapp_state.latest_transcript_snapshot.append({
                        "seq": seq, "text": text, "speaker_id": stable,
                        "t_start_ms": tight_t0, "t_end_ms": tight_t1,
                    })
                    webapp_state.state.ledger_count = len(webapp_state.latest_transcript_snapshot)
```

NOTE: variable names (`seq`, `text`, `stable`, `tight_t0`, `tight_t1`) match the local scope at line 868. The second site (line 1447) may use slightly different variable names — read the surrounding context and adapt before inserting.

Inspect both sites, then patch each manually. Use:

```bash
ssh nick@100.99.99.72 "cd ~/cairn-svc && sed -n '865,895p' cairn_svc/server.py"
ssh nick@100.99.99.72 "cd ~/cairn-svc && sed -n '1440,1470p' cairn_svc/server.py"
```

For each, `await ws.send_text(TranscriptFinalMsg(...))` ends at the matching `).model_dump_json())`. Insert the snapshot-append immediately after that closing line, with matching indentation.

- [ ] **Step 5: Poll stop_event in the receive loop**

The receive loop opens `while True: msg = await ws.receive()` at line ~1401. The first thing inside the loop should be a non-blocking check for `stop_event`:

```python
                if webapp_state.stop_event.is_set():
                    webapp_state.stop_event.clear()
                    await ws.send_text('{"type":"control_stop"}')
```

Insert immediately after `msg = await ws.receive()` (BEFORE the `if msg["type"] == "websocket.disconnect"` check). Apply:

```bash
ssh nick@100.99.99.72 "cd ~/cairn-svc && python3 - <<'PY'
from pathlib import Path
p = Path('cairn_svc/server.py')
src = p.read_text().splitlines(keepends=True)
for i, line in enumerate(src):
    if 'msg = await ws.receive()' in line:
        indent = line[:len(line) - len(line.lstrip())]
        block = ''.join(indent + l + '\n' for l in [
            'if webapp_state.stop_event.is_set():',
            '    webapp_state.stop_event.clear()',
            '    await ws.send_text(\\'{\"type\":\"control_stop\"}\\')',
        ])
        src.insert(i + 1, block)
        break  # only the first occurrence
p.write_text(''.join(src))
print('stop-event poll inserted')
PY"
```

- [ ] **Step 6: Verify the file still parses + import-checks**

```bash
ssh nick@100.99.99.72 "cd ~/cairn-svc && .venv/bin/python -c 'from cairn_svc.server import app; print(\"routes:\", [r.path for r in app.routes])'"
```

Expected output includes `/sessions`, `/sessions/{slug}`, `/control/start`, `/control/stop`, `/control/status`, `/control/transcript`, `/`, `/assets`, `/ws/transcribe`.

If it errors, fix the error before continuing. Common issues: indentation mismatch in the inserted blocks, escape mismatch in the JSON string, syntax error from a stray comma.

- [ ] **Step 7: Run the full existing test suite to confirm no regression**

```bash
ssh nick@100.99.99.72 "cd ~/cairn-svc && .venv/bin/pytest -x 2>&1 | tail -25"
```

Expected: all tests pass (existing ones unchanged, plus the new `test_webapp_state.py`, `test_sessions.py`, `test_static_routes.py`, `test_control.py`).

- [ ] **Step 8: Commit**

```bash
ssh nick@100.99.99.72 "cd ~/cairn-svc && git add cairn_svc/server.py && git commit -m 'feat(server): wire webapp routers + bridge stop_event into WS handler

- Mount /assets, /, /sessions/*, /control/* alongside existing /ws/transcribe.
- On StartMsg: flip control state to recording, reset session_dir/snapshot.
- After every transcript_final emit: append a thin row to the snapshot list
  GET /control/transcript serves; bump ledger_count.
- Each receive loop tick: if stop_event is set, push {type:control_stop}
  downstream so the page calls stopLiveSession + POST /sessions.

No changes to the diarization, transcription, or summarization hot paths.'"
```

---

## Task 8: Restart cairn-svc + smoke-test new endpoints

**Files:** none (validation only).

**SteeLL-v1 task:** No.

- [ ] **Step 1: Restart the service**

```bash
ssh nick@100.99.99.72 "systemctl --user restart cairn-svc && sleep 2 && systemctl --user status cairn-svc | head -10"
```

Expected: `Active: active (running)`. Tail journal if not:

```bash
ssh nick@100.99.99.72 "journalctl --user -u cairn-svc -n 30 --no-pager"
```

- [ ] **Step 2: Smoke /control/status**

```bash
curl -sS http://100.99.99.72:8300/control/status | python3 -m json.tool
```

Expected:

```json
{"state": "idle", "meeting_name": "", "session_dir": null, "ledger_count": 0}
```

- [ ] **Step 3: Smoke /control/start**

```bash
curl -sS -X POST http://100.99.99.72:8300/control/start \
  -H 'content-type: application/json' \
  -d '{"meeting_name":"smoke-test-1"}' | python3 -m json.tool
```

Expected:

```json
{"ok": true, "meeting_name": "smoke-test-1", "url": "/?meeting_name=smoke-test-1&autostart=1"}
```

- [ ] **Step 4: Smoke /sessions save + read**

```bash
curl -sS -X POST http://100.99.99.72:8300/sessions \
  -H 'content-type: application/json' \
  -d '{"meeting_name":"smoke","events":[{"type":"transcript_final","text":"hello"}]}' \
  | python3 -m json.tool
SLUG=$(curl -sS http://100.99.99.72:8300/sessions | python3 -c 'import sys,json; print(json.load(sys.stdin)[0]["slug"])')
echo "slug=$SLUG"
curl -sS "http://100.99.99.72:8300/sessions/$SLUG" | python3 -m json.tool | head -20
```

Expected: save returns `{"session_dir": "...", "slug": "<date>-smoke"}`; list shows the session; read returns `{"meta": {...}, "events": [{"type":"transcript_final","text":"hello"}]}`.

Also verify on disk:

```bash
ssh nick@100.99.99.72 "ls ~/cairn-svc/sessions/ && cat ~/cairn-svc/sessions/*-smoke/transcript.jsonl"
```

- [ ] **Step 5: Smoke / and /assets** (will 404 until UI is deployed in Task 14, but route should exist)

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://100.99.99.72:8300/
```

Expected: `404` (file not found at WEBAPP_ROOT/index.html — that's fine, route is registered) OR `500` (directory missing — also fine pre-deploy). The `404 Not Found` you'd see in JSON form is `{"detail":"Not Found"}` — confirms the route is mounted.

- [ ] **Step 6: No commit** (validation only).

---

## Task 9: client app.ts — replace IPC calls with fetch

**Files:**
- Modify: `/Users/nickcason/dev/cairn/src/renderer/app.ts`

**SteeLL-v1 task:** No (touches live client logic).

- [ ] **Step 1: Replace `window.cairn.saveSession` with fetch in finalizeSession**

In `app.ts` find `finalizeSession` (around line 233). Replace:

```typescript
  const dir = await window.cairn.saveSession(meetingName, baked);
  savedSessionDir = dir;
```

with:

```typescript
  const res = await fetch("/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ meeting_name: meetingName, events: baked }),
  });
  const { session_dir } = await res.json();
  savedSessionDir = session_dir;
  const dir = session_dir;
```

- [ ] **Step 2: Replace the rename re-save call**

Find the `void window.cairn.saveSession(meetingName, baked)` call inside the speakers callback (around line 31). Replace with:

```typescript
    void fetch("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ meeting_name: meetingName, events: baked }),
    });
```

- [ ] **Step 3: Replace the WS URL constant**

Replace the constant at top of file (line 7):

```typescript
const CAIRN_SVC_URL = "ws://100.99.99.72:8300/ws/transcribe";
```

with:

```typescript
const CAIRN_SVC_URL = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/transcribe`;
```

- [ ] **Step 4: Replace the SVG fetch path**

Find `await fetch("../icons/cairn.svg")` (around line 60). Replace with:

```typescript
  const svgRes = await fetch("/assets/icons/cairn.svg");
```

- [ ] **Step 5: Type-check**

```bash
cd /Users/nickcason/dev/cairn && npx tsc -p tsconfig.renderer.json --noEmit 2>&1 | tail -10
```

Expected: 0 errors. (If `window.cairn.saveSession` / `readFile` are still referenced anywhere else, they'll show up here. The `declare global` block in `app.ts` lines 9-21 still declares them but they're unused — leave it for now; Task 11 cleans it up.)

- [ ] **Step 6: Commit**

```bash
cd /Users/nickcason/dev/cairn && git add src/renderer/app.ts && git -c commit.gpgsign=false commit -m "feat(renderer): replace Electron saveSession IPC with fetch /sessions

Renderer now POSTs the baked event log directly to the cairn-svc HTTP
endpoint instead of going through main-process IPC. WS URL is derived
from window.location so the same bundle works on any tailnet origin.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: client app.ts — URL-param-driven start + control_stop handling

**Files:**
- Modify: `/Users/nickcason/dev/cairn/src/renderer/app.ts`

**SteeLL-v1 task:** No.

- [ ] **Step 1: Add a control_stop branch in onMsg**

Find the `else if (m.type === "ack" && m.of === "stop")` branch (around line 173). Immediately before it, add:

```typescript
  } else if ((m as any).type === "control_stop") {
    stopLiveSession();
```

- [ ] **Step 2: Replace the window.cairn.onInit init flow with URL-param flow**

Find `window.cairn.onInit(async ({ testFile, ... }) => { ... })` block at the bottom of `app.ts` (line ~346). Replace the entire block with:

```typescript
const params = new URLSearchParams(location.search);
const urlMeetingName = params.get("meeting_name");
const urlAutostart = params.get("autostart") === "1";

(async () => {
  meetingName = urlMeetingName ?? "Cairn";
  $meeting.textContent = meetingName === "Cairn" ? "Cairn" : `loop · ${meetingName}`;
  if (urlAutostart) {
    await startLiveSession();
  }
})();
```

- [ ] **Step 3: Remove the cairnControl block at the bottom**

Delete lines starting with `const ctrl = window.cairnControl;` through the matching closing `}`. Also delete the `reportTranscriptSnapshot()` function and any `ctrl.reportState` / `ctrl.reportTranscript` calls scattered through `onMsg` and other handlers — they're no-ops without the IPC bridge.

Search:

```bash
cd /Users/nickcason/dev/cairn && grep -n 'cairnControl\|reportState\|reportTranscript\|reportTranscriptSnapshot' src/renderer/app.ts
```

For each result, delete the line (or the surrounding `if (ctrl) { ... }` block when the whole conditional becomes empty).

- [ ] **Step 4: Remove the unused window.cairn declarations**

Find the `declare global { interface Window { cairn: {...}; cairnControl?: {...}; } }` block (lines 9-21) and delete it entirely. The renderer no longer touches these.

- [ ] **Step 5: Type-check**

```bash
cd /Users/nickcason/dev/cairn && npx tsc -p tsconfig.renderer.json --noEmit 2>&1 | tail -10
```

Expected: 0 errors. If errors mention `window.cairn` somewhere, search for and delete those references too.

- [ ] **Step 6: Commit**

```bash
cd /Users/nickcason/dev/cairn && git add src/renderer/app.ts && git -c commit.gpgsign=false commit -m "feat(renderer): URL-param-driven start + WS control_stop handling

Replaces the Electron cairnControl IPC bridge with URL params for harness
autostart and a server-pushed control_stop WS message for harness stop.
Removes the now-unused window.cairn / window.cairnControl global type
declarations.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: client index.html + audio.ts — absolute asset paths

**Files:**
- Modify: `/Users/nickcason/dev/cairn/src/renderer/index.html`
- Modify: `/Users/nickcason/dev/cairn/src/renderer/audio.ts`

**SteeLL-v1 task:** No (small but visible).

- [ ] **Step 1: Patch index.html — absolute paths + viewport meta**

Edit `src/renderer/index.html`:

- Line 6: `<link rel="stylesheet" href="style.css">` → `<link rel="stylesheet" href="/assets/style.css">`
- After line 4 (`<meta charset="utf-8">`), insert: `<meta name="viewport" content="width=device-width, initial-scale=1">`
- Line 39: `<script src="../../dist/renderer/app.js" type="module"></script>` → `<script src="/assets/app.js" type="module"></script>`

- [ ] **Step 2: Patch audio.ts — absolute worklet path**

Edit `src/renderer/audio.ts` line 32:

```typescript
  await ctx.audioWorklet.addModule("audio-worklet.js");
```

becomes:

```typescript
  await ctx.audioWorklet.addModule("/assets/audio-worklet.js");
```

- [ ] **Step 3: Build to confirm**

```bash
cd /Users/nickcason/dev/cairn && npm run build 2>&1 | tail -5
```

Expected: build succeeds, produces `dist/renderer/*.js`.

- [ ] **Step 4: Commit**

```bash
cd /Users/nickcason/dev/cairn && git add src/renderer/index.html src/renderer/audio.ts && git -c commit.gpgsign=false commit -m "feat(renderer): absolute /assets/* asset paths + viewport meta

Asset URLs now resolve from any route depth (relative paths broke when
served by FastAPI from /assets/* instead of file://). Viewport meta tag
keeps iPhone Safari from zooming the desktop layout into illegibility.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: package.json — drop Electron, add deploy script

**Files:**
- Modify: `/Users/nickcason/dev/cairn/package.json`

**SteeLL-v1 task:** No.

- [ ] **Step 1: Edit package.json**

Replace the contents of `package.json` with:

```json
{
  "name": "cairn",
  "version": "0.2.0",
  "description": "Live meeting transcription with speaker diarization (webapp)",
  "scripts": {
    "build": "tsc -p tsconfig.renderer.json",
    "deploy": "npm run build && bash scripts/deploy-ui.sh",
    "test:benchmark": "npm run build && node tests/test-runner.spec.mjs"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0"
  },
  "dependencies": {
    "@types/ws": "^8.5.13"
  }
}
```

Removed: `main`, `start`, `screenshot`, `record-demos`, `package`, `install-app` scripts; `electron`, `electron-builder` devDeps; `ws` runtime dep (only used by the now-deleted main process); the `build` block. Bumped version to 0.2.0 to mark the architectural shift.

- [ ] **Step 2: Re-install to drop electron from node_modules**

```bash
cd /Users/nickcason/dev/cairn && rm -rf node_modules && npm install 2>&1 | tail -3
```

Expected: install completes without electron-postinstall steps.

- [ ] **Step 3: Build still works**

```bash
cd /Users/nickcason/dev/cairn && npm run build 2>&1 | tail -3
```

Expected: builds clean.

- [ ] **Step 4: Commit**

```bash
cd /Users/nickcason/dev/cairn && git add package.json package-lock.json && git -c commit.gpgsign=false commit -m "chore(package): drop electron + electron-builder, bump to 0.2.0

Removes the electron/electron-builder devDeps, the build block, and the
package/install-app/start scripts. Adds a deploy script that builds the
TS bundle and rsyncs it to node4 via scripts/deploy-ui.sh.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: scripts/deploy-ui.sh

**Files:**
- Create: `/Users/nickcason/dev/cairn/scripts/deploy-ui.sh`

**SteeLL-v1 task:** YES.

- [ ] **Step 1: Generate the script via Qwen**

```bash
cat <<'EOF' | scripts/qwen-helper.sh "deploy-ui.sh rsync UI bundle to node4 and restart cairn-svc"
Write a bash script scripts/deploy-ui.sh for a TypeScript renderer project.

Inputs (already exist on the local machine):
- $ROOT/dist/renderer/*.js — bundled JavaScript modules from `tsc`
- $ROOT/src/renderer/index.html
- $ROOT/src/renderer/style.css
- $ROOT/src/renderer/audio-worklet.js
- $ROOT/src/icons/* — SVG icon assets

Behaviour:
1. set -euo pipefail
2. compute ROOT as the directory above the script's own directory
3. stage everything into a temp dir with this layout:
     <stage>/index.html
     <stage>/assets/*.js              (from dist/renderer)
     <stage>/assets/style.css
     <stage>/assets/audio-worklet.js
     <stage>/assets/icons/*.svg       (from src/icons)
4. rsync -az --delete <stage>/ to nick@100.99.99.72:/home/nick/cairn-svc/webapp/
5. ssh nick@100.99.99.72 "systemctl --user restart cairn-svc"
6. clean up the temp dir
7. echo "deployed -> https://precision-node4.taild99f50.ts.net/"

Show only the final shell script (no markdown fences).
EOF
```

- [ ] **Step 2: Save + chmod the result**

Review Qwen's output. Final expected script (edit Qwen's draft to match):

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/assets/icons"
cp "$ROOT"/dist/renderer/*.js "$STAGE/assets/"
cp "$ROOT"/src/renderer/style.css "$STAGE/assets/"
cp "$ROOT"/src/renderer/audio-worklet.js "$STAGE/assets/"
cp "$ROOT"/src/icons/* "$STAGE/assets/icons/"
cp "$ROOT"/src/renderer/index.html "$STAGE/index.html"

rsync -az --delete "$STAGE/" nick@100.99.99.72:/home/nick/cairn-svc/webapp/
ssh nick@100.99.99.72 "systemctl --user restart cairn-svc"

echo "deployed -> https://precision-node4.taild99f50.ts.net/"
```

Save and make executable:

```bash
chmod +x /Users/nickcason/dev/cairn/scripts/deploy-ui.sh
```

- [ ] **Step 3: Run a deploy**

```bash
cd /Users/nickcason/dev/cairn && npm run deploy 2>&1 | tail -10
```

Expected: build → rsync → restart → "deployed -> ...".

Verify on node4:

```bash
ssh nick@100.99.99.72 "ls -la ~/cairn-svc/webapp/ ~/cairn-svc/webapp/assets/"
```

Expected: index.html + assets/{app.js,*.js,style.css,audio-worklet.js,icons/}.

- [ ] **Step 4: Curl the deployed page**

```bash
curl -sS http://100.99.99.72:8300/ | head -5
curl -sS http://100.99.99.72:8300/assets/app.js | head -3
```

Expected: index HTML + JS module returned.

- [ ] **Step 5: Commit**

```bash
cd /Users/nickcason/dev/cairn && git add scripts/deploy-ui.sh && git -c commit.gpgsign=false commit -m "scripts(deploy-ui): rsync UI bundle to node4 + restart cairn-svc

Co-Authored-By: SteeLL-v1 <noreply@local>
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: scripts/cairn-loop.sh — retarget URLs

**Files:**
- Modify: `/Users/nickcason/dev/cairn/scripts/cairn-loop.sh`

**SteeLL-v1 task:** No (correctness-critical for the test harness).

- [ ] **Step 1: Read the current curl URLs**

```bash
grep -n '127.0.0.1:8765\|cairn://\|open .*--args' /Users/nickcason/dev/cairn/scripts/cairn-loop.sh
```

Note each line.

- [ ] **Step 2: Replace control endpoint URLs**

For each line referencing `http://127.0.0.1:8765/control/`, replace with `https://precision-node4.taild99f50.ts.net/control/`.

Use `sed -i ''` (BSD sed) on macOS:

```bash
sed -i '' 's|http://127.0.0.1:8765|https://precision-node4.taild99f50.ts.net|g' /Users/nickcason/dev/cairn/scripts/cairn-loop.sh
```

- [ ] **Step 3: Replace the "open Cairn.app" command with Safari open**

The harness probably calls something like `open -a Cairn` or `open cairn://...` to launch the Electron app. Replace with:

```bash
open -a Safari "https://precision-node4.taild99f50.ts.net/?meeting_name=$MEETING_NAME&autostart=1"
```

Locate the existing launch line manually (search for `Cairn.app` or `open -a Cairn`) and replace it. The exact variable name (`$MEETING_NAME`) may differ — read the script and use whatever it currently passes as the meeting name.

- [ ] **Step 4: Smoke-run a short harness invocation**

Skip the full grader — just verify the harness can hit start, reach state=recording, hit stop, and reach state=stopped. Use a 30-second window:

```bash
# (modify cairn-loop.sh to take a short duration arg, OR run manually:)
curl -sS -X POST https://precision-node4.taild99f50.ts.net/control/start \
  -H 'content-type: application/json' \
  -d '{"meeting_name":"loop-smoke"}'
open -a Safari 'https://precision-node4.taild99f50.ts.net/?meeting_name=loop-smoke&autostart=1'
sleep 30
curl -sS -X POST https://precision-node4.taild99f50.ts.net/control/stop
sleep 10
curl -sS https://precision-node4.taild99f50.ts.net/control/status | python3 -m json.tool
```

Expected: final status shows `state: "stopped"` and `session_dir: "..."`.

- [ ] **Step 5: Commit**

```bash
cd /Users/nickcason/dev/cairn && git add scripts/cairn-loop.sh && git -c commit.gpgsign=false commit -m "scripts(cairn-loop): retarget URLs to tailnet HTTPS endpoint

Replaces the Electron 127.0.0.1:8765 control plane with the new
cairn-svc tailnet HTTPS endpoint. Safari is now opened to the webapp
URL with ?meeting_name + ?autostart=1 (Variant A) instead of launching
the Electron app.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 15: tailscale serve — TLS for the webapp origin

**Files:** none (one-time node4 config).

**SteeLL-v1 task:** No (one-shot infra command).

- [ ] **Step 1: Verify tailscale is up on node4 and has a cert**

```bash
ssh nick@100.99.99.72 "tailscale status | head -3 && tailscale cert precision-node4.taild99f50.ts.net 2>&1 | head -5"
```

The first cert command may take ~10s as the cert is minted. Expected: "Wrote ..." or "Certificate already exists for ...".

- [ ] **Step 2: Configure tailscale serve to front cairn-svc**

```bash
ssh nick@100.99.99.72 "tailscale serve --bg --https=443 / http://localhost:8300"
```

Expected: prints the HTTPS URL the service is now reachable at. Persisted by tailscaled across reboots.

- [ ] **Step 3: Verify HTTPS terminates correctly**

From the Mac:

```bash
curl -sS https://precision-node4.taild99f50.ts.net/control/status | python3 -m json.tool
```

Expected: same JSON as the plaintext smoke test in Task 8.2 — proves TLS termination + WebSocket upgrade reverse-proxy is working.

- [ ] **Step 4: Verify WSS upgrade works**

```bash
ssh nick@100.99.99.72 "curl -sS -i -N --http1.1 \
  -H 'Upgrade: websocket' -H 'Connection: Upgrade' \
  -H 'Sec-WebSocket-Key: $(openssl rand -base64 16)' \
  -H 'Sec-WebSocket-Version: 13' \
  http://localhost:8300/ws/transcribe 2>&1 | head -10"
```

Expected: `HTTP/1.1 101 Switching Protocols`. Then through tailscale serve:

```bash
curl -sS -i -N --http1.1 \
  -H 'Upgrade: websocket' -H 'Connection: Upgrade' \
  -H 'Sec-WebSocket-Key: '"$(openssl rand -base64 16)" \
  -H 'Sec-WebSocket-Version: 13' \
  https://precision-node4.taild99f50.ts.net/ws/transcribe 2>&1 | head -10
```

Expected: same 101 Switching Protocols. If you get 502 / 504, `tailscale serve` is misconfigured — re-run step 2.

- [ ] **Step 5: No commit** (configuration is in tailscaled state, not in either repo).

Document the one-time setup in a node4-side README or just journal note. (Optional: add a `scripts/setup-node4-tls.sh` later that codifies steps 1-2.)

---

## Task 16: End-to-end smoke — Mac Safari live session

**Files:** none (validation only).

**SteeLL-v1 task:** No.

- [ ] **Step 1: Open the webapp in Mac Safari**

```bash
open -a Safari https://precision-node4.taild99f50.ts.net/
```

Expected: Cairn UI loads. Logo renders. Status shows "disconnected" → "connected" once you click Start.

- [ ] **Step 2: Run a 60-second live session**

Click Start. Speak (or play a YouTube fixture briefly). Verify:
- Status flips to "live"
- Elapsed timer ticks
- Transcript lines appear with speaker chips
- A rolling summary appears around the 2-minute mark (shorter sessions skip this)

Click Stop. Verify:
- Status flips to "summarizing…" then "saved → <slug>"
- The transcript persists on screen

- [ ] **Step 3: Verify the session was saved on node4**

```bash
ssh nick@100.99.99.72 "ls -la ~/cairn-svc/sessions/ | tail -5; cat ~/cairn-svc/sessions/$(ls -t ~/cairn-svc/sessions/ | head -1)/meta.json"
```

Expected: directory exists with `transcript.jsonl` + `meta.json`. meta.json has the meeting_name, saved_at, event_count.

- [ ] **Step 4: Verify GET /sessions surfaces it**

```bash
curl -sS https://precision-node4.taild99f50.ts.net/sessions | python3 -m json.tool | head -10
```

- [ ] **Step 5: No commit** (validation only).

If anything in steps 1-4 fails, root-cause before continuing — do not declare the cutover successful.

---

## Task 17: Harness regression run — bleed/accuracy parity

**Files:** none (validation only).

**SteeLL-v1 task:** No.

- [ ] **Step 1: Run cairn-loop.sh against the diamandis-220 fixture**

(or whatever fixture matches a known baseline — see memory `project_streaming_defers_to_auth.md` for last-logged numbers.)

```bash
cd /Users/nickcason/dev/cairn && bash scripts/cairn-loop.sh diamandis-220 2>&1 | tee /tmp/loop-run.log | tail -30
```

Expected: full loop completes — start → Safari opens → audio captures → stop → save → grader runs.

- [ ] **Step 2: Compare bleed-rate + accuracy to baseline**

Grader output should look like:
```
bleed_rate=X.X%   speaker_accuracy=YY.Y%
```

Baseline (from spec section 7.1, 1-hour 2-speaker): 1.5% bleed / 98.7% accuracy. Pass criteria: bleed within 0.5% (≤ 2.0%), accuracy within 0.3% (≥ 98.4%).

- [ ] **Step 3: If regression: triage**

Common new-architecture causes for drift:
- WS messages getting dropped through `tailscale serve` (check journal: `journalctl --user -u cairn-svc -n 200 --no-pager`)
- Audio chunks being reordered in transit (would show as transcribe errors in journal)
- Browser AudioWorklet behaving differently in Safari vs Electron's bundled Chromium (check whether device-picker selection is honored: the previous run's device should still be in `localStorage`)

If bleed is up materially, run the same fixture against the OLD Electron app (before merging) for direct A/B. Don't merge if regression unexplained.

- [ ] **Step 4: Capture a results note**

Append to `RESULTS.md` (Mac repo):

```markdown
## 2026-05-10 — Webapp cutover

| Run | bleed_rate | speaker_accuracy | notes |
|-----|------------|------------------|-------|
| baseline (Electron, pre-cutover) | X.X% | YY.Y% | from memory |
| webapp on node4 (this commit)    | X.X% | YY.Y% | post-cutover |
```

Commit it:

```bash
cd /Users/nickcason/dev/cairn && git add RESULTS.md && git -c commit.gpgsign=false commit -m "docs(results): post-webapp-cutover bleed/accuracy parity check"
```

---

## Task 18: Strip Electron remnants

**Files:**
- Delete: `src/main.ts`, `src/preload.ts`, `tsconfig.json`, `dist-app/` (if present)

**SteeLL-v1 task:** No.

Do this LAST so that if Tasks 16-17 surfaced a regression, you still have the Electron code to A/B against.

- [ ] **Step 1: Delete the files**

```bash
cd /Users/nickcason/dev/cairn && rm -f src/main.ts src/preload.ts tsconfig.json && rm -rf dist-app/
```

- [ ] **Step 2: Verify build still works**

```bash
cd /Users/nickcason/dev/cairn && npm run build 2>&1 | tail -3
```

Expected: builds clean (only `tsconfig.renderer.json` is referenced now).

- [ ] **Step 3: Verify deploy still works**

```bash
cd /Users/nickcason/dev/cairn && npm run deploy 2>&1 | tail -3
```

Expected: rsyncs + restarts cairn-svc.

- [ ] **Step 4: Update README**

Replace the "Electron app" section of `README.md` with a single paragraph describing the webapp:

```markdown
## Cairn

Live meeting transcription + speaker diarization, served from cairn-svc
on node4 to any tailnet device. Open the webapp in Safari at
https://precision-node4.taild99f50.ts.net/. Sessions land at
~/cairn-svc/sessions/<slug>/ on node4. The Mac repo at this directory
holds the renderer + harness; cairn-svc lives in ~/cairn-svc on node4
(no GitHub remote — local commits only).
```

(Adapt to the existing README's tone.)

- [ ] **Step 5: Commit**

```bash
cd /Users/nickcason/dev/cairn && git add -A && git -c commit.gpgsign=false commit -m "feat: remove Electron host code (cutover to webapp complete)

Deletes src/main.ts, src/preload.ts, tsconfig.json (Electron-main config),
and dist-app/. The renderer is now the only artifact, served as a static
bundle by cairn-svc on node4. Hits the same /ws/transcribe protocol from
Safari (Mac, iPhone) over WSS via tailscale serve.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Push to GitHub**

```bash
cd /Users/nickcason/dev/cairn && git push origin main
```

---

## Task 19: Wrap-up — memory + status

**Files:**
- Create: `/Users/nickcason/.claude/projects/-Users-nickcason-dev-cairn/memory/project_webapp_cutover_landed.md`
- Modify: `/Users/nickcason/.claude/projects/-Users-nickcason-dev-cairn/memory/MEMORY.md`
- Modify: `/Users/nickcason/.claude/projects/-Users-nickcason-dev-cairn/memory/cairn_architecture.md` (it currently describes the two-repo split with Electron — update to reflect the webapp)

**SteeLL-v1 task:** No.

- [ ] **Step 1: Update cairn_architecture.md** to remove Electron-specific lines and replace with the webapp + tailscale serve topology. Reference the spec at `docs/superpowers/specs/2026-05-10-cairn-webapp-pwa-design.md` and the plan at `docs/superpowers/plans/2026-05-10-cairn-webapp-pwa.md`.

- [ ] **Step 2: Add a `project_webapp_cutover_landed.md` memory** capturing: when it landed, what regressed (if anything), the harness numbers from Task 17, open follow-ons (iPhone PWA polish, native iOS shell with ReplayKit Broadcast Upload Extension).

- [ ] **Step 3: Add the new memory to MEMORY.md** index.

- [ ] **Step 4: No commit** (memory lives outside the repo).

---

## Self-Review

**Spec coverage (against `2026-05-10-cairn-webapp-pwa-design.md`):**

| Spec section | Tasks |
|---|---|
| §3 deletions (main.ts, preload.ts, tsconfig.json, dist-app/, Electron deps, scripts) | T18, T12 |
| §4.1 app.ts saveSession→fetch + readFile delete + onInit replacement + cairnControl delete + WS URL derivation | T9, T10 |
| §4.2 index.html absolute paths + viewport meta | T11 |
| §4.3 audio.ts absolute worklet path | T11 |
| §4.4 package.json drop electron, simplify build, add deploy | T12 |
| §4.5 scripts/deploy-ui.sh | T13 |
| §4.6 scripts/cairn-loop.sh URL retarget | T14 |
| §5.1 cairn_svc/sessions.py + slug overwrite + post-stop state flip | T3 |
| §5.2 cairn_svc/control.py + ControlState + stop_event + URL-param handoff | T5 |
| §5.3 cairn_svc/static_routes.py | T4 |
| §5.4 server.py wiring + WS-side StartMsg/append-on-final/stop_event poll | T7 |
| §5.5 systemd unchanged + tailscale serve + .env.example | T8, T15, T6 |
| §6.1 Mac live data flow | T16 |
| §6.2 cairn-loop harness data flow | T14, T17 |
| §6.3 iPhone Safari (mic-only) | not directly tested in this plan; verify by visiting the URL on iPhone after T15 |
| §7 test harness preservation | T17 |
| §8 deferred — explicitly out of scope (no tasks) | n/a |
| §9 risks: WS upgrade through tailscale serve | T15.4 |
| §9 risks: tailscale serve cert | T15.1 |
| §9 risks: slug collision (already handled — overwrite is intentional) | T3 (test) |
| §9 risks: server.py bloat | T7 (extracts to webapp_state/sessions/control/static_routes) |
| §10 success criteria | T16 + T17 + T18 |

No spec gaps.

**Placeholder scan:** No "TBD", "TODO", "implement later", "fill in details", "appropriate error handling", "similar to Task N" found. All code blocks are complete and copy-pasteable.

**Type / name consistency:**
- `ControlState` dataclass fields used identically across T2, T3, T5, T7. ✓
- `webapp_state.{state, stop_event, latest_transcript_snapshot}` referenced by name in T2 (definition), T3, T5, T7. ✓
- `_slugify` defined in T3 — only T3 uses it. ✓
- `meeting_name` (snake_case) used everywhere on the wire and in saved meta; `meetingName` (camelCase) used in TS. Bridge is the JSON body in T9. ✓
- `control_stop` outbound message: defined in T1, emitted in T7, handled in T10. ✓

No issues to fix.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-10-cairn-webapp-pwa.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Good fit here because: 19 tasks, clear independence between server-side (T1-8) and client-side (T9-13) phases, and Qwen tasks (T1, T4, T6, T13) are easy to delegate cleanly.

**2. Inline Execution** — I execute tasks in this session using executing-plans, batching with checkpoints for review. Good fit if you want to watch each step land in real time.

**Which approach?**
