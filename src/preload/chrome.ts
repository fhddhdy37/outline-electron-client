import { contextBridge, ipcRenderer } from "electron";
import {
  TAB_ACTIVATE_CHANNEL,
  TAB_CLOSE_CHANNEL,
  TAB_CREATE_CHANNEL,
  TAB_DRAG_BEGIN_CHANNEL,
  TAB_DRAG_CANCEL_CHANNEL,
  TAB_DRAG_ZONE_CHANNEL,
  TAB_DROP_CHANNEL,
  TAB_STATE_CHANNEL,
  type TabDragZone,
  type TabDropRequest,
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
  drop: (request: TabDropRequest) =>
    ipcRenderer.send(TAB_DROP_CHANNEL, { id: request.id, toIndex: request.toIndex }),
  dragBegin: (id: number) => ipcRenderer.send(TAB_DRAG_BEGIN_CHANNEL, id),
  dragCancel: () => ipcRenderer.send(TAB_DRAG_CANCEL_CHANNEL),
  onDragZone: (callback: (zone: TabDragZone) => void): (() => void) => {
    const listener = (_event: unknown, zone: TabDragZone): void => callback(zone);
    ipcRenderer.on(TAB_DRAG_ZONE_CHANNEL, listener);
    return () => ipcRenderer.removeListener(TAB_DRAG_ZONE_CHANNEL, listener);
  },
  onState: (callback: (state: TabState) => void): (() => void) => {
    const listener = (_event: unknown, state: TabState): void => callback(state);
    ipcRenderer.on(TAB_STATE_CHANNEL, listener);
    return () => ipcRenderer.removeListener(TAB_STATE_CHANNEL, listener);
  },
});
