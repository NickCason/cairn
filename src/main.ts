import { app, BrowserWindow, ipcMain } from "electron";
import * as path from "path";

// Parse CLI: --test-file=<path>
function getTestFile(): string | null {
  const arg = process.argv.find(a => a.startsWith("--test-file="));
  return arg ? arg.split("=", 2)[1] : null;
}

let win: BrowserWindow | null = null;

async function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0d1117",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Register did-finish-load BEFORE loadFile so the event is never missed.
  const testFile = getTestFile();
  win.webContents.on("did-finish-load", () => {
    win?.webContents.send("init", { testFile });
  });

  await win.loadFile(path.join(__dirname, "..", "src", "renderer", "index.html"));
}

app.whenReady().then(createWindow);
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
