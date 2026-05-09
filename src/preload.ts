import { contextBridge, ipcRenderer } from "electron";

// Buffer init data in case the renderer's onInit callback is registered
// after the main process sends the 'init' IPC event (did-finish-load race).
let bufferedInit: any | null = null;
let initCallback: ((data: any) => void) | null = null;

ipcRenderer.on("init", (_e, data) => {
  if (initCallback) {
    initCallback(data);
  } else {
    bufferedInit = data;
  }
});

contextBridge.exposeInMainWorld("cairn", {
  onInit: (cb: (data: any) => void) => {
    initCallback = cb;
    if (bufferedInit !== null) {
      cb(bufferedInit);
      bufferedInit = null;
    }
  },
  readFile: (p: string) => ipcRenderer.invoke("read-file", p),
  saveSession: (meetingName: string, events: any[]) => ipcRenderer.invoke("save-session", { meetingName, events }),
});

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
