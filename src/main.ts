import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";
import * as path from "path";
import * as fs from "fs";
import * as http from "node:http";

// Parse CLI: --test-file=<path>
function getTestFile(): string | null {
  const arg = process.argv.find(a => a.startsWith("--test-file="));
  return arg ? arg.split("=", 2)[1] : null;
}

// Parse CLI: --screenshot-mode=<light|dark>
function getScreenshotMode(): "light" | "dark" | null {
  const arg = process.argv.find(a => a.startsWith("--screenshot-mode="));
  if (!arg) return null;
  const val = arg.split("=", 2)[1];
  if (val === "light" || val === "dark") return val;
  return null;
}

// Parse CLI: --demo-mode=<light|dark>
function getDemoMode(): "light" | "dark" | null {
  const arg = process.argv.find(a => a.startsWith("--demo-mode="));
  if (!arg) return null;
  const val = arg.split("=", 2)[1];
  if (val === "light" || val === "dark") return val;
  return null;
}

// Parse CLI: --speakers=<N|auto>. Default behavior decided by renderer (1 in live, null in benchmark).
function getNumSpeakers(): number | null | undefined {
  const arg = process.argv.find(a => a.startsWith("--speakers="));
  if (!arg) return undefined;
  const val = arg.split("=", 2)[1];
  if (val === "auto") return null;
  const n = parseInt(val, 10);
  return isNaN(n) || n < 1 ? undefined : n;
}

let win: BrowserWindow | null = null;

// ── HTTP control endpoint ──────────────────────────────────────────────────
const CONTROL_PORT = parseInt(process.env.CAIRN_CONTROL_PORT || "8765", 10);

let controlState = {
  state: "idle" as "idle" | "recording" | "stopping" | "stopped",
  meeting_name: "",
  session_dir: null as string | null,
  ledger_count: 0,
};
let liveTranscript: any[] = [];

function startControlServer(mainWindow: BrowserWindow) {
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

  server.on("error", (err: any) => {
    if (err && err.code === "EADDRINUSE") {
      console.error(`[cairn] control endpoint port ${CONTROL_PORT} already in use; control disabled for this session`);
      return;
    }
    console.error(`[cairn] control endpoint error:`, err);
  });
  server.listen(CONTROL_PORT, "127.0.0.1", () => {
    console.log(`[cairn] control endpoint listening on 127.0.0.1:${CONTROL_PORT}`);
  });
}

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
// ──────────────────────────────────────────────────────────────────────────

async function createWindow() {
  const screenshotMode = getScreenshotMode();
  const demoMode = getDemoMode();
  const themeMode = screenshotMode || demoMode;

  win = new BrowserWindow({
    width: 1100,
    height: 720,
    titleBarStyle: "hiddenInset",
    backgroundColor: themeMode === "light" ? "#f5f5f7" : "#0d1117",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Register did-finish-load BEFORE loadFile so the event is never missed.
  const testFile = getTestFile();
  const numSpeakers = getNumSpeakers();
  win.webContents.on("did-finish-load", () => {
    win?.webContents.send("init", { testFile, screenshotMode, demoMode, numSpeakers });
  });

  await win.loadFile(path.join(__dirname, "..", "src", "renderer", "index.html"));

  // Bring window to front so screen recordings capture it
  app.focus({ steal: true });
  win.focus();

  // Screenshot capture: wait 4 s for fixture content to render, then capture + quit
  if (screenshotMode) {
    setTimeout(async () => {
      if (!win) return;
      try {
        const image = await win.webContents.capturePage();
        const screenshotsDir = path.join(__dirname, "..", "screenshots");
        fs.mkdirSync(screenshotsDir, { recursive: true });
        const outPath = path.join(screenshotsDir, `cairn-${screenshotMode}.png`);
        fs.writeFileSync(outPath, image.toPNG());
        console.log(`Screenshot saved: ${outPath}`);
      } catch (err) {
        console.error("Screenshot failed:", err);
      } finally {
        app.quit();
      }
    }, 4000);
  }
  // demo-mode: no auto-quit timer — renderer closes via window.close() after playback

  startControlServer(win);
}

app.whenReady().then(() => {
  const screenshotMode = getScreenshotMode();
  const demoMode = getDemoMode();
  const themeMode = screenshotMode || demoMode;
  // Force theme BEFORE window creation
  if (themeMode === "light") {
    nativeTheme.themeSource = "light";
  } else if (themeMode === "dark") {
    nativeTheme.themeSource = "dark";
  }
  createWindow();
});
app.on("window-all-closed", () => app.quit());

ipcMain.handle("read-file", async (_e, p: string) => {
  const fs = require("fs/promises");
  return await fs.readFile(p);
});

ipcMain.handle("save-session", async (_e, { meetingName, events }: { meetingName: string; events: any[] }) => {
  const fs = require("fs/promises");
  const path = require("path");
  const os = require("os");
  const date = new Date().toISOString().slice(0, 10);
  const slug = meetingName.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const dir = path.join(os.homedir(), "Documents", "Cairn", `${date}-${slug}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "transcript.jsonl"), events.map(e => JSON.stringify(e)).join("\n") + "\n");
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify({
    meeting_name: meetingName,
    saved_at: new Date().toISOString(),
    event_count: events.length,
  }, null, 2));
  return dir;
});
