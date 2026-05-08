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
