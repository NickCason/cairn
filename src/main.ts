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
  await win.loadFile(path.join(__dirname, "..", "src", "renderer", "index.html"));

  const testFile = getTestFile();
  win.webContents.on("did-finish-load", () => {
    win?.webContents.send("init", { testFile });
  });
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());

ipcMain.handle("read-file", async (_e, p: string) => {
  const fs = require("fs/promises");
  return await fs.readFile(p);
});
