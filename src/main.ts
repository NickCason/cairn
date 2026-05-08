import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";
import * as path from "path";
import * as fs from "fs";

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
