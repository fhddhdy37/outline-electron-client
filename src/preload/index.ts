import { contextBridge, ipcRenderer } from "electron";
import {
  APP_INFO_CHANNEL,
  TAB_OPEN_LINK_CHANNEL,
  type AppInfo,
  type TabOpenLinkRequest,
} from "../shared/ipc";
import { SlashCommandDetector } from "./meeting/command-detector";
import { EditorBridge } from "./meeting/editor-bridge";
import { MeetingController } from "./meeting/meeting-controller";

let meetingController: MeetingController | undefined;
let commandDetector: SlashCommandDetector | undefined;

/** Synthetic clicks used to translate Alt+click into Outline's split-view gesture. */
const translatedSplitClicks = new WeakSet<MouseEvent>();

function internalLinkFrom(event: MouseEvent): HTMLAnchorElement | undefined {
  if (event.button !== 0 || !(event.target instanceof Element)) {
    return undefined;
  }

  const anchor = event.target.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("download")) {
    return undefined;
  }

  try {
    const url = new URL(anchor.href, window.location.href);
    return url.origin === window.location.origin ? anchor : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Makes link modifiers match the desktop browser model while retaining
 * Outline's useful split view behind Alt+click:
 *   Ctrl/Cmd+click -> background app tab
 *   Alt+click      -> Outline split view (formerly Ctrl+click)
 */
function installLinkClickModifiers(): void {
  window.addEventListener(
    "click",
    (event) => {
      if (translatedSplitClicks.has(event)) {
        return;
      }

      const anchor = internalLinkFrom(event);
      if (!anchor) {
        return;
      }

      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();

        const splitClick = new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
          detail: event.detail,
          screenX: event.screenX,
          screenY: event.screenY,
          clientX: event.clientX,
          clientY: event.clientY,
          ctrlKey: true,
          button: event.button,
          buttons: event.buttons,
        });
        translatedSplitClicks.add(splitClick);
        event.target?.dispatchEvent(splitClick);
        return;
      }

      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const request: TabOpenLinkRequest = { url: anchor.href, background: true };
        ipcRenderer.send(TAB_OPEN_LINK_CHANNEL, request);
      }
    },
    true,
  );
}

installLinkClickModifiers();

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

