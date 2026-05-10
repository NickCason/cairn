# Cairn → webapp on node4 (kill Electron) — design

**Date:** 2026-05-10
**Goal:** Replace the Electron Mac client with a tailnet-served webapp running out of `cairn-svc` on node4. Mac is the v1 capture target; iPhone PWA polish and a native iOS shell with ReplayKit Broadcast Upload Extension are deliberate follow-ons. Ship today.

---

## 1. Why

- Electron adds packaging, signing, and update friction for what is already a thin renderer over a remote service.
- Same UI on every tailnet device (Mac today, iPhone Safari + future native shell tomorrow) collapses to a single bundle served from one origin.
- Sessions become server-side, browseable from any tailnet client.
- Removes the local 127.0.0.1:8765 control plane in favor of a single tailnet-scoped server.

## 2. Topology

```
                 tailscale serve
                 (TLS termination,
                  auto-renewed cert)
[Mac Safari] ─────HTTPS/WSS─────┐
[iPhone Safari] ────────────────┤
                                ▼
                    ┌───────────────────────────┐
                    │  cairn-svc on node4       │
                    │  (FastAPI + uvicorn,      │
                    │   localhost:8300)         │
                    │                           │
                    │  /                  GET   │  webapp index.html
                    │  /assets/*          GET   │  bundled JS/CSS/icons/worklet
                    │  /ws/transcribe     WS    │  existing audio + control msgs
                    │  /sessions          POST  │  save transcript+meta
                    │  /sessions          GET   │  list saved sessions
                    │  /sessions/{slug}   GET   │  read transcript.jsonl + meta
                    │  /control/start     POST  │  cairn-loop harness signal-in
                    │  /control/stop      POST  │  cairn-loop harness signal-in
                    │  /control/status    GET   │  cairn-loop poll
                    │  /control/transcript GET  │  cairn-loop transcript snapshot
                    │                           │
                    │  Disk:                    │
                    │  /home/nick/cairn-svc/    │
                    │   webapp/         (UI)    │
                    │   sessions/<slug>/        │
                    │     transcript.jsonl      │
                    │     meta.json             │
                    └───────────────────────────┘
```

`tailscale serve --bg --https=443 / http://localhost:8300` on node4 puts HTTPS in front of cairn-svc with an auto-renewed cert at `https://precision-node4.taild99f50.ts.net`. Tailnet membership is the auth boundary — no app-level auth.

## 3. What gets deleted (Mac repo `/Users/nickcason/dev/cairn`)

- `src/main.ts` (Electron host + 127.0.0.1:8765 control HTTP server)
- `src/preload.ts` (IPC bridge)
- `electron`, `electron-builder` from `devDependencies`
- `package` and `install-app` npm scripts
- `tsconfig.json` (the Electron-main config — `tsconfig.renderer.json` stays, becomes the only build config)
- The top-level `build` block in `package.json` (electron-builder config)
- `dist-app/` directory (regenerable, will be removed by clean build)

The `screenshot-fixture.ts`, `test-runner.ts`, and `screenshot/demo` modes are deferred (not deleted) but become unreachable in v1. They can be re-enabled later via URL params (e.g. `?fixture=screenshot-light`).

## 4. What changes (Mac repo)

### 4.1 `src/renderer/app.ts`

- Replace `window.cairn.saveSession(name, events)` with `fetch("/sessions", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ meeting_name, events }) })`. The endpoint returns `{ session_dir, slug }` on success.
- Delete `window.cairn.readFile` (only used by the deferred test-runner).
- Delete `window.cairn.onInit` and the entire init-payload code path. Mode is "live" by default. Read URL params directly (`new URLSearchParams(location.search)`) for `meeting_name` and `autostart`.
- Delete the `window.cairnControl.*` block. Replace with:
  - On load: if `?autostart=1` is present, auto-call `startLiveSession(meetingName)` after the WS opens.
  - On a new server-pushed `control_stop` message over `/ws/transcribe`, call `stopLiveSession()`.
- Replace `const CAIRN_SVC_URL = "ws://100.99.99.72:8300/ws/transcribe"` with `const CAIRN_SVC_URL = \`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/transcribe\``. Single bundle works from any origin.
- Re-save-on-rename (commit `86454a6`): the `saveSession` call becomes `fetch(POST /sessions)` — same overwrite-by-slug semantics on the server side.

### 4.2 `src/renderer/index.html`

- `<script src="../../dist/renderer/app.js" type="module">` → `<script src="/assets/app.js" type="module">`.
- `<link rel="stylesheet" href="style.css">` → `<link rel="stylesheet" href="/assets/style.css">`.
- Add `<meta name="viewport" content="width=device-width, initial-scale=1">` (cheap, future-proofs PWA work).
- The `<script src="../icons/cairn.svg">` fetch in `app.ts` becomes `fetch("/assets/icons/cairn.svg")`.

### 4.3 `src/renderer/audio.ts`

- `await ctx.audioWorklet.addModule("audio-worklet.js")` → `await ctx.audioWorklet.addModule("/assets/audio-worklet.js")` so the absolute URL resolves regardless of route.

### 4.4 `package.json`

- Remove `electron`, `electron-builder`, the `build` block, `package` and `install-app` scripts.
- `start` is removed (no app to launch). New `deploy` script: `npm run build && bash scripts/deploy-ui.sh` (build + push to node4).
- `build` simplifies to `tsc -p tsconfig.renderer.json` (drops the Electron-main `tsc &&`).
- `main` field removed.

### 4.5 `scripts/deploy-ui.sh` (new)

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$(mktemp -d)"
mkdir -p "$STAGE/assets" "$STAGE/assets/icons"
cp "$ROOT"/dist/renderer/*.js "$STAGE/assets/"
cp "$ROOT"/src/renderer/{style.css,audio-worklet.js} "$STAGE/assets/"
cp "$ROOT"/src/icons/* "$STAGE/assets/icons/"
cp "$ROOT"/src/renderer/index.html "$STAGE/index.html"
rsync -az --delete "$STAGE/" nick@100.99.99.72:/home/nick/cairn-svc/webapp/
ssh nick@100.99.99.72 "systemctl --user restart cairn-svc"
rm -rf "$STAGE"
echo "deployed → https://precision-node4.taild99f50.ts.net/"
```

### 4.6 `scripts/cairn-loop.sh`

- Change all `curl` URLs from `http://127.0.0.1:8765/control/...` to `https://precision-node4.taild99f50.ts.net/control/...`.
- The Safari-open command targets the same host with `?meeting_name=...&autostart=1`.
- Stop-wait + final_summary polling logic unchanged (the server-side endpoint shapes match what the client previously served via Electron IPC).

## 5. What changes (cairn-svc repo `~/cairn-svc` on node4)

### 5.1 New module `cairn_svc/sessions.py`

Owns session storage and HTTP routes for save/list/read.

```python
# pseudocode shape
SESSIONS_ROOT = Path(os.environ.get("CAIRN_SESSIONS_ROOT", Path.home() / "cairn-svc" / "sessions"))

router = APIRouter(prefix="/sessions")

class SaveBody(BaseModel):
    meeting_name: str
    events: list[dict]

@router.post("")
async def save_session(body: SaveBody) -> dict:
    date = datetime.utcnow().strftime("%Y-%m-%d")
    slug = re.sub(r"[^a-z0-9]+", "-", body.meeting_name.lower()).strip("-")
    dir_ = SESSIONS_ROOT / f"{date}-{slug}"
    dir_.mkdir(parents=True, exist_ok=True)
    (dir_ / "transcript.jsonl").write_text("\n".join(json.dumps(e) for e in body.events) + "\n")
    (dir_ / "meta.json").write_text(json.dumps({
        "meeting_name": body.meeting_name,
        "saved_at": datetime.utcnow().isoformat() + "Z",
        "event_count": len(body.events),
    }, indent=2))
    return {"session_dir": str(dir_), "slug": dir_.name}

@router.get("")
async def list_sessions() -> list[dict]:
    return sorted(
        ({"slug": p.name, **json.loads((p / "meta.json").read_text())} for p in SESSIONS_ROOT.iterdir() if (p / "meta.json").exists()),
        key=lambda m: m["saved_at"], reverse=True,
    )

@router.get("/{slug}")
async def read_session(slug: str) -> dict:
    dir_ = SESSIONS_ROOT / slug
    return {
        "meta": json.loads((dir_ / "meta.json").read_text()),
        "events": [json.loads(line) for line in (dir_ / "transcript.jsonl").read_text().splitlines() if line],
    }
```

Slug algorithm matches the Mac IPC handler we're replacing so existing on-disk archives line up.

### 5.2 New module `cairn_svc/control.py`

Owns the cairn-loop harness control surface. State is process-local (a single dict) — sufficient because the harness drives one session at a time.

```python
@dataclass
class ControlState:
    state: Literal["idle","recording","stopping","stopped"] = "idle"
    meeting_name: str = ""
    session_dir: str | None = None
    ledger_count: int = 0

state = ControlState()
stop_event = asyncio.Event()  # set by POST /control/stop, cleared on each new start

router = APIRouter(prefix="/control")

@router.post("/stop")
async def control_stop() -> dict:
    state.state = "stopping"
    stop_event.set()
    return {"ok": True}

@router.get("/status")
async def control_status() -> dict:
    return asdict(state)

# /control/start kept for harness backward-compat; in v1 it just records the
# pending meeting_name the page will pick up via URL param. Returning the URL
# makes it easy for cairn-loop.sh to log/use.
@router.post("/start")
async def control_start(body: dict | None = None) -> dict:
    name = (body or {}).get("meeting_name") or f"loop-{datetime.utcnow().isoformat().replace(':','-')}"
    state.meeting_name = name
    state.state = "idle"   # actual transition to "recording" happens when the page's WS sends 'start'
    stop_event.clear()
    return {"ok": True, "meeting_name": name, "url": f"/?meeting_name={name}&autostart=1"}

@router.get("/transcript")
async def control_transcript() -> list[dict]:
    return latest_transcript_snapshot
```

The `/ws/transcribe` handler (in `server.py`) gains:
- On receipt of a `start` message: set `state.state = "recording"`, `state.session_dir = None`.
- On each transcript_final emit: append to `latest_transcript_snapshot`, bump `state.ledger_count`.
- Each iteration of the receive loop: `if stop_event.is_set(): await ws.send_json({"type":"control_stop"}); stop_event.clear()` so the page stops capturing and calls `/sessions` to save. The new `control_stop` discriminated message is added to `cairn_svc/protocol.py` (Pydantic model + Literal type) so the existing `parse_control` / typed-emit infrastructure recognizes it.
- The page's `onMsg` handler in `app.ts` gains a `control_stop` branch that calls `stopLiveSession()`.
- The `POST /sessions` save handler (in `cairn_svc/sessions.py`) sets `control_state.state = "stopped"` and `control_state.session_dir = str(dir_)` as the final step before returning. This is the single source of "stopped" — no separate `/control/finalize` endpoint. Harness polls `GET /control/status` until `state === "stopped"` as today.

### 5.3 New module `cairn_svc/static_routes.py`

```python
WEBAPP_ROOT = Path(os.environ.get("CAIRN_WEBAPP_ROOT", Path.home() / "cairn-svc" / "webapp"))

def mount(app: FastAPI) -> None:
    app.mount("/assets", StaticFiles(directory=WEBAPP_ROOT / "assets"), name="assets")

    @app.get("/", include_in_schema=False)
    async def index():
        return FileResponse(WEBAPP_ROOT / "index.html")
```

`/` is its own route (not `StaticFiles(html=True)`) so future routing additions don't get shadowed.

### 5.4 `cairn_svc/server.py` changes (minimal)

```python
from .sessions import router as sessions_router
from .control  import router as control_router, state as control_state, stop_event, latest_transcript_snapshot
from .static_routes import mount as mount_static

app = FastAPI()
app.include_router(sessions_router)
app.include_router(control_router)
mount_static(app)

# inside the existing /ws/transcribe handler, around the receive loop:
#   - set control_state.state = "recording" on StartMsg
#   - append finals to latest_transcript_snapshot
#   - poll stop_event each tick; if set, push {"type":"control_stop"} downstream
```

No other server.py logic changes. The 1514-line file gets ~30 lines of additions, none in the diarization/transcription hot path.

### 5.5 systemd / `tailscale serve`

- `~/.config/systemd/user/cairn-svc.service` — unchanged. Restart picks up the new routes.
- `tailscale serve --bg --https=443 / http://localhost:8300` — one-time setup, persisted by tailscaled across restarts.
- `.env.example` updated with `CAIRN_SESSIONS_ROOT` and `CAIRN_WEBAPP_ROOT` defaults.

## 6. End-to-end data flows

### 6.1 Mac live session

1. User opens `https://precision-node4.taild99f50.ts.net/` in Safari.
2. Page loads, fetches `/assets/cairn.svg` for logo, populates device picker via `enumerateDevices()`.
3. User clicks Start. Page opens WSS to `/ws/transcribe`, sends `{type:"start", meeting_name, source:"aggregate"}`, calls `getUserMedia` for the chosen device, streams Int16 PCM via the existing AudioWorklet.
4. cairn-svc emits `transcript_partial`/`transcript_final`/`speaker_*`/`rolling_summary`/etc. — page renders identically to today.
5. User clicks Stop. Page sends `{type:"stop"}`, awaits `final_summary`, POSTs `/sessions` with the baked event log, displays "saved → <slug>".

### 6.2 cairn-loop harness session

1. Harness curls `POST /control/start { meeting_name: "loop-xyz" }` — server records the name, returns `{ url: "/?meeting_name=loop-xyz&autostart=1" }`.
2. Harness opens `https://precision-node4.taild99f50.ts.net/?meeting_name=loop-xyz&autostart=1` in Safari.
3. Page reads URL params, autostarts the session (skipping the manual Start click).
4. Harness opens the YouTube fixture URL with `?t=` for autoplay (unchanged from today). Mac's chosen input device picks up the audio (loopback or mic).
5. After Y seconds, harness curls `POST /control/stop`. Server sets `stop_event`. WS handler sees the event next tick, sends `{type:"control_stop"}` to the page. Page calls `stopLiveSession()`, awaits `final_summary`, POSTs `/sessions`. The save handler flips `control_state.state` to `"stopped"` as its last step.
6. Harness polls `GET /control/status` until `state === "stopped"` (with the existing 900s budget).
7. Harness curls `GET /control/transcript` for the snapshot, runs `scripts/grade-transcript.py` against the reference fixture.

### 6.3 iPhone Safari (v1, mic-only)

Same as 6.1 but limited to the iPhone's mic input. Useful for in-person meetings or as a remote viewer when the Mac is the active capture client (future work — needs a `/sessions/{slug}/live` viewer route, deferred).

## 7. Test harness preservation

Hard requirement: `scripts/cairn-loop.sh` + `scripts/grade-transcript.py` continue to produce comparable bleed-rate / accuracy numbers against existing reference fixtures.

Validation steps before declaring done:
1. Existing fixture dry-run: run `cairn-loop.sh` against a known fixture (e.g. the diamandis-220 youtube fixture per recent commit `3059719`) on the new server. Compare bleed/accuracy to the last logged baseline (1-hour 2-speaker: 1.5% bleed / 98.7% accuracy per memory `project_streaming_defers_to_auth.md`).
2. If bleed-rate drift > 0.5% or accuracy drop > 0.3%, treat as a regression and root-cause before merging.
3. The Stage Manager OFF / coordinates-in-points / no-play-keystroke harness invariants are unaffected — they're properties of the AppleScript automation, not the Cairn endpoint.

## 8. Deferred (explicitly not v1)

- iPhone PWA polish: manifest.json, apple-touch-icon, service worker, install prompt, responsive CSS for ≤480px viewports.
- Native iOS app + Broadcast Upload Extension for system-audio capture on iPhone.
- Sessions browser UI (`/sessions` HTTP endpoint exists; the listing/reading UI does not).
- `--screenshot-mode`, `--demo-mode`, `--test-file` modes (re-add later as URL params).
- App-layer auth on top of tailnet membership.
- Cross-device live-view (iPhone watching a Mac-hosted session in real time).

## 9. Risks

- **Audio device selection regression on Safari.** Electron and Safari implement `enumerateDevices()` slightly differently; Safari may not surface labels until permission is granted (today's code already handles that via `refreshDeviceList()` after capture starts — should port cleanly).
- **`tailscale serve` cert provisioning.** First HTTPS request can be slow (~10s) while the cert is minted. Verify ahead of demo.
- **WebSocket through `tailscale serve`.** Requires the proxy to handle the `Upgrade: websocket` header. Tailscale serve does support this for HTTP-internal targets — verify with a smoke test before declaring the harness green.
- **Slug collision on rapid loop runs.** Date-based slug + hyphenated meeting_name can collide if two harness runs share a name within the same day. Today's Electron handler overwrites; we preserve that behavior (intentional — supports the post-stop rename re-save flow). Document explicitly.
- **`server.py` bloat creep.** The new modules are scoped to keep `server.py` from growing. Reviewer should reject any PR that adds session/control logic into `server.py` directly.

## 10. Success criteria

- Mac Safari can: open the URL, capture audio from any input device, see live transcript + speakers + rolling summary + final summary, save a session that shows up under `~/cairn-svc/sessions/<slug>/` on node4.
- The Electron app + `dist-app/Cairn.app` are removed from the project; `npm run start` builds and deploys instead.
- `cairn-loop.sh` runs end-to-end against a known fixture and produces bleed/accuracy numbers within 0.5% / 0.3% of the documented baseline.
- iPhone Safari can load the same URL and (a) connect over WSS, (b) capture mic audio, (c) display the live UI without layout being unreadable. PWA install + true responsive design are not v1.
- HTTPS via `tailscale serve` is auto-renewed; no manual cert handling on either side.
- iPhone native shell + ReplayKit work is unblocked: documented as the next project, with the WebSocket protocol unchanged so a native client can speak it directly.
