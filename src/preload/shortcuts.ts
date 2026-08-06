import { contextBridge, ipcRenderer } from "electron";
import {
  SHORTCUTS_CHANGED_CHANNEL,
  SHORTCUTS_CLOSE_CHANNEL,
  SHORTCUTS_GET_CHANNEL,
  SHORTCUTS_RESET_CHANNEL,
  SHORTCUTS_SET_CHANNEL,
  SHORTCUTS_VISIBILITY_CHANNEL,
  type ShortcutsSnapshot,
} from "../shared/ipc";
import { formatBinding, keyStateBinding, type KeyState } from "../shared/shortcuts";

/**
 * Bridge for the shortcut panel (see main/shortcuts-html.ts), which runs as a
 * modal overlay view inside each window. Binding parsing lives in
 * shared/shortcuts.ts and is exposed here so the page and the main process
 * agree on what a key press means.
 */
contextBridge.exposeInMainWorld("shortcutsApi", {
  get: (): Promise<ShortcutsSnapshot> =>
    ipcRenderer.invoke(SHORTCUTS_GET_CHANNEL) as Promise<ShortcutsSnapshot>,
  set: (id: string, accelerator: string | null): Promise<ShortcutsSnapshot> =>
    ipcRenderer.invoke(SHORTCUTS_SET_CHANNEL, { id, accelerator }) as Promise<ShortcutsSnapshot>,
  reset: (id?: string): Promise<ShortcutsSnapshot> =>
    ipcRenderer.invoke(SHORTCUTS_RESET_CHANNEL, id) as Promise<ShortcutsSnapshot>,
  /** Turns a captured key press into a binding, or null if it is unusable. */
  bindingFrom: (state: KeyState, platform: string): string | null =>
    keyStateBinding(state, platform) ?? null,
  format: (accelerator: string | null, platform: string): string =>
    formatBinding(accelerator, platform),
  onChanged: (callback: (snapshot: ShortcutsSnapshot) => void): (() => void) => {
    const listener = (_event: unknown, snapshot: ShortcutsSnapshot): void => callback(snapshot);
    ipcRenderer.on(SHORTCUTS_CHANGED_CHANNEL, listener);
    return () => ipcRenderer.removeListener(SHORTCUTS_CHANGED_CHANNEL, listener);
  },
  close: () => ipcRenderer.send(SHORTCUTS_CLOSE_CHANNEL),
  /** Fires when the overlay is shown, so the page can replay its transition. */
  onShown: (callback: () => void): (() => void) => {
    const listener = (): void => callback();
    ipcRenderer.on(SHORTCUTS_VISIBILITY_CHANNEL, listener);
    return () => ipcRenderer.removeListener(SHORTCUTS_VISIBILITY_CHANNEL, listener);
  },
});
