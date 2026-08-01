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

export interface TabDescriptor {
  id: number;
  title: string;
  active: boolean;
  loading: boolean;
}

export interface TabState {
  tabs: TabDescriptor[];
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

