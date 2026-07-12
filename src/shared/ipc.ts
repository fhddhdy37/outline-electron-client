export const DEFAULT_OUTLINE_URL = "https://tukadlab.ignorelist.com";
export const AUTH_LINK_PROTOCOL = "outline-electron";

export const APP_INFO_CHANNEL = "outline-meeting:get-app-info";

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

