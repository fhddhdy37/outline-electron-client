import { contextBridge, ipcRenderer } from "electron";
import {
  TAB_ACTIVATE_CHANNEL,
  TAB_CLOSE_CHANNEL,
  TAB_CREATE_CHANNEL,
  TAB_STATE_CHANNEL,
  type TabState,
} from "../shared/ipc";

/**
 * Bridge used by the tab-bar page (see chrome-html.ts). The tab bar is a
 * separate WebContentsView, so it talks to the main process purely over IPC.
 */
contextBridge.exposeInMainWorld("tabsApi", {
  create: () => ipcRenderer.send(TAB_CREATE_CHANNEL),
  close: (id: number) => ipcRenderer.send(TAB_CLOSE_CHANNEL, id),
  activate: (id: number) => ipcRenderer.send(TAB_ACTIVATE_CHANNEL, id),
  onState: (callback: (state: TabState) => void): (() => void) => {
    const listener = (_event: unknown, state: TabState): void => callback(state);
    ipcRenderer.on(TAB_STATE_CHANNEL, listener);
    return () => ipcRenderer.removeListener(TAB_STATE_CHANNEL, listener);
  },
});
