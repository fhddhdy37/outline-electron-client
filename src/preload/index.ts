import { contextBridge, ipcRenderer } from "electron";
import { APP_INFO_CHANNEL, type AppInfo } from "../shared/ipc";
import { SlashCommandDetector } from "./meeting/command-detector";
import { EditorBridge } from "./meeting/editor-bridge";
import { MeetingController } from "./meeting/meeting-controller";

let meetingController: MeetingController | undefined;
let commandDetector: SlashCommandDetector | undefined;

async function resolveAppInfo(): Promise<AppInfo> {
  return ipcRenderer.invoke(APP_INFO_CHANNEL) as Promise<AppInfo>;
}

async function boot(): Promise<void> {
  const appInfo = await resolveAppInfo();
  meetingController = new MeetingController({
    appInfo,
    editorBridge: new EditorBridge(),
  });

  commandDetector = new SlashCommandDetector({
    command: "/회의",
    onCommand: (context) => meetingController?.openFromCommand(context),
  });
  commandDetector.start();
}

contextBridge.exposeInMainWorld("outlineMeeting", {
  openPanel: () => meetingController?.openManually(),
  getAppInfo: () => resolveAppInfo(),
});

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", () => void boot(), { once: true });
} else {
  void boot();
}

window.addEventListener("beforeunload", () => {
  commandDetector?.stop();
});

