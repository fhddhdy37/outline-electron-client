export const DEFAULT_OUTLINE_URL = "https://wiki.tukadlab.cloud";
export const AUTH_LINK_PROTOCOL = "outline-electron";

export const APP_INFO_CHANNEL = "outline-meeting:get-app-info";

/** Main → tab-bar: pushes the current set of tabs after any change. */
export const TAB_STATE_CHANNEL = "tabs:state";
/** Tab-bar → main: open a new tab. */
export const TAB_CREATE_CHANNEL = "tabs:create";
/** Tab-bar → main: close the tab with the given id. */
export const TAB_CLOSE_CHANNEL = "tabs:close";
/** Tab-bar → main: activate (bring to front) the tab with the given id. */
export const TAB_ACTIVATE_CHANNEL = "tabs:activate";
/** Tab-bar → main: a tab drag ended; reorder, move to another window, or detach. */
export const TAB_DROP_CHANNEL = "tabs:drop";
/** Tab-bar → main: a tab drag passed the threshold; start tracking the cursor. */
export const TAB_DRAG_BEGIN_CHANNEL = "tabs:drag-begin";
/** Tab-bar → main: the drag was abandoned without a drop. */
export const TAB_DRAG_CANCEL_CHANNEL = "tabs:drag-cancel";
/** Main → tab-bar: where the dragged tab currently is. */
export const TAB_DRAG_ZONE_CHANNEL = "tabs:drag-zone";
/** Tab-bar → main: open the keyboard-shortcut panel. */
export const SHORTCUTS_OPEN_CHANNEL = "shortcuts:open";
/** Shortcut panel → main: dismiss the panel. */
export const SHORTCUTS_CLOSE_CHANNEL = "shortcuts:close";
/** Main → shortcut panel: the panel was shown (play the open transition). */
export const SHORTCUTS_VISIBILITY_CHANNEL = "shortcuts:visibility";

export interface TabDragZone {
  /** True once the tab has left its own strip and is riding the cursor. */
  torn: boolean;
}

export interface TabDescriptor {
  id: number;
  title: string;
  active: boolean;
  loading: boolean;
}

export interface TabState {
  tabs: TabDescriptor[];
}

export interface TabDropRequest {
  id: number;
  /** Index the tab should end up at when it is dropped back on its own tab bar. */
  toIndex: number;
}

/** Shortcut window → main: read every action and its current binding. */
export const SHORTCUTS_GET_CHANNEL = "shortcuts:get";
/** Shortcut window → main: rebind one action (null accelerator unbinds it). */
export const SHORTCUTS_SET_CHANNEL = "shortcuts:set";
/** Shortcut window → main: restore every default binding. */
export const SHORTCUTS_RESET_CHANNEL = "shortcuts:reset";
/** Main → shortcut window: bindings changed. */
export const SHORTCUTS_CHANGED_CHANNEL = "shortcuts:changed";

export interface ShortcutView {
  id: string;
  label: string;
  category: string;
  /** Canonical binding (e.g. "Mod+T"), or null when the action is unbound. */
  accelerator: string | null;
  defaultAccelerator: string | null;
  /** Binding rendered for the current platform, e.g. "Ctrl + T" or "⌘ T". */
  display: string;
  /** Ids of other actions bound to the same keys. */
  conflicts: string[];
}

export interface ShortcutsSnapshot {
  platform: NodeJS.Platform;
  actions: ShortcutView[];
}

export interface ShortcutSetRequest {
  id: string;
  accelerator: string | null;
}

export type SystemAudioStrategy =
  | "windows-loopback"
  | "macos-system-picker-or-virtual-device"
  | "linux-pipewire-or-monitor-source"
  | "best-effort";

export interface AppInfo {
  appVersion: string;
  outlineUrl: string;
  outlineOrigin: string;
  authLinkProtocol: string;
  platform: NodeJS.Platform;
  systemAudioStrategy: SystemAudioStrategy;
  /** WebSocket URL of the self-hosted Whisper server, or "mock" for the mock provider. */
  sttUrl: string;
}

