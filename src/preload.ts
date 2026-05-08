import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("cairn", {
  onInit: (cb: (data: any) => void) => ipcRenderer.on("init", (_e, data) => cb(data)),
  readFile: (p: string) => ipcRenderer.invoke("read-file", p),
  saveSession: (meetingName: string, events: any[]) => ipcRenderer.invoke("save-session", { meetingName, events }),
});
