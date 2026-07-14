import {
  app,
  BaseWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  session,
} from "electron";
import path from "node:path";
import {
  APP_INFO_CHANNEL,
  AUTH_LINK_PROTOCOL,
  DEFAULT_OUTLINE_URL,
  type AppInfo,
  type SystemAudioStrategy,
} from "../shared/ipc";
import { deriveServiceUrl } from "../shared/endpoints";
import { TabManager } from "./tab-manager";
import { CHROME_HTML } from "./chrome-html";

const OUTLINE_PARTITION = "persist:outline-client";
const OUTLINE_URL_ARG = "--outline-url=";
const OPEN_URL_ARG = "--open-url=";
const STT_URL_ARG = "--stt-url=";

let tabManager: TabManager | undefined;
let pendingLaunchUrl: string | undefined;

function resolveOutlineUrl(): URL {
  const cliValue = process.argv.find((argument) => argument.startsWith(OUTLINE_URL_ARG));
  const rawValue =
    cliValue?.slice(OUTLINE_URL_ARG.length) ?? process.env.OUTLINE_URL ?? DEFAULT_OUTLINE_URL;

  const parsed = new URL(rawValue);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Unsupported Outline URL protocol: ${parsed.protocol}`);
  }

  return parsed;
}

function systemAudioStrategy(): SystemAudioStrategy {
  if (process.platform === "win32") {
    return "windows-loopback";
  }

  if (process.platform === "darwin") {
    return "macos-system-picker-or-virtual-device";
  }

  if (process.platform === "linux") {
    return "linux-pipewire-or-monitor-source";
  }

  return "best-effort";
}

const outlineUrl = resolveOutlineUrl();

function resolveSttUrl(): string {
  const cliValue = process.argv.find((argument) => argument.startsWith(STT_URL_ARG));
  const rawValue = cliValue?.slice(STT_URL_ARG.length) ?? process.env.STT_URL;

  if (rawValue === "mock") {
    return "mock";
  }

  if (rawValue) {
    const parsed = new URL(rawValue);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      throw new Error(`Unsupported STT URL protocol: ${parsed.protocol}`);
    }
    return parsed.toString();
  }

  // Default: the stt route on the same gateway that serves Outline.
  return deriveServiceUrl(outlineUrl.origin, "stt");
}

const sttUrl = resolveSttUrl();

function isAllowedOutlineOrigin(value?: string | null): boolean {
  if (!value) {
    return false;
  }

  try {
    return new URL(value).origin === outlineUrl.origin;
  } catch {
    return false;
  }
}

function resolveAllowedOutlineUrl(value?: string | null): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = new URL(value.trim());
    if ((parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.origin === outlineUrl.origin) {
      return parsed.toString();
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function resolveDeepLinkTarget(value?: string | null): string | undefined {
  const directOutlineUrl = resolveAllowedOutlineUrl(value);
  if (directOutlineUrl) {
    return directOutlineUrl;
  }

  if (!value) {
    return undefined;
  }

  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== `${AUTH_LINK_PROTOCOL}:`) {
      return undefined;
    }

    const wrappedUrl = parsed.searchParams.get("url") ?? parsed.searchParams.get("target");
    return resolveAllowedOutlineUrl(wrappedUrl);
  } catch {
    return undefined;
  }
}

function findLaunchUrl(argv: string[]): string | undefined {
  for (const argument of argv) {
    if (argument.startsWith(OPEN_URL_ARG)) {
      const target = resolveAllowedOutlineUrl(argument.slice(OPEN_URL_ARG.length));
      if (target) {
        return target;
      }
    }

    const target = resolveDeepLinkTarget(argument);
    if (target) {
      return target;
    }
  }

  return undefined;
}

function registerAuthLinkProtocol(): void {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(AUTH_LINK_PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    return;
  }

  app.setAsDefaultProtocolClient(AUTH_LINK_PROTOCOL);
}

function focusMainWindow(): void {
  tabManager?.focus();
}

function openOutlineUrlInApp(targetUrl: string): void {
  const allowedTarget = resolveAllowedOutlineUrl(targetUrl);
  if (!allowedTarget) {
    return;
  }

  if (!tabManager || tabManager.isDestroyed) {
    pendingLaunchUrl = allowedTarget;
    return;
  }

  tabManager.openUrl(allowedTarget);
}

function handlePotentialLaunchUrl(value?: string | null): boolean {
  const target = resolveDeepLinkTarget(value);
  if (!target) {
    return false;
  }

  openOutlineUrlInApp(target);
  return true;
}

function openLoginLinkFromClipboard(): void {
  const clipboardText = clipboard.readText().trim();
  if (handlePotentialLaunchUrl(clipboardText)) {
    return;
  }

  const message =
    `Clipboard does not contain an allowed ${outlineUrl.origin} login URL. ` +
    `Copy the Outline email login link, then run this action again.`;

  if (tabManager && !tabManager.isDestroyed) {
    void dialog.showMessageBox({
      type: "warning",
      title: "Cannot open login link",
      message,
    });
    return;
  }

  dialog.showErrorBox("Cannot open login link", message);
}

function configureAppMenu(): void {
  // No application menu bar — the app uses its own tab-bar chrome. Keyboard
  // shortcuts that lived in the menu are handled directly by TabManager:
  // Ctrl/Cmd+T (new tab), Ctrl/Cmd+W (close tab), and Ctrl/Cmd+Shift+L
  // (load login link from clipboard, via onLoginLinkShortcut).
  Menu.setApplicationMenu(null);
}

function configureOutlineSession(): Electron.Session {
  const outlineSession = session.fromPartition(OUTLINE_PARTITION);

  outlineSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    const permissionName = String(permission);
    if (permissionName === "media" || permissionName === "display-capture") {
      return isAllowedOutlineOrigin(requestingOrigin);
    }

    return false;
  });

  outlineSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const permissionName = String(permission);
    const requestingUrl = details.requestingUrl || webContents.getURL();
    const allowed =
      isAllowedOutlineOrigin(requestingUrl) &&
      (permissionName === "media" || permissionName === "display-capture");

    callback(allowed);
  });

  outlineSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      if (!isAllowedOutlineOrigin(request.securityOrigin)) {
        callback({});
        return;
      }

      try {
        const sources = await desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: { width: 0, height: 0 },
        });

        const primaryScreen = sources[0];
        if (!primaryScreen) {
          callback({});
          return;
        }

        callback({
          video: primaryScreen,
          ...(request.audioRequested && process.platform === "win32"
            ? { audio: "loopback" as const }
            : {}),
        });
      } catch (error) {
        console.error("Failed to resolve display media source", error);
        callback({});
      }
    },
    { useSystemPicker: true },
  );

  return outlineSession;
}

function configureIpc(): void {
  ipcMain.handle(APP_INFO_CHANNEL, (): AppInfo => {
    return {
      appVersion: app.getVersion(),
      outlineUrl: outlineUrl.toString(),
      outlineOrigin: outlineUrl.origin,
      authLinkProtocol: AUTH_LINK_PROTOCOL,
      platform: process.platform,
      systemAudioStrategy: systemAudioStrategy(),
      sttUrl,
    };
  });
}

function createTabbedWindow(outlineSession: Electron.Session): void {
  tabManager = new TabManager({
    session: outlineSession,
    preloadPath: path.join(__dirname, "../preload/index.js"),
    chromePreloadPath: path.join(__dirname, "../preload/chrome.js"),
    chromeHtml: CHROME_HTML,
    homeUrl: outlineUrl.toString(),
    isAllowedOrigin: isAllowedOutlineOrigin,
    onLoginLinkShortcut: openLoginLinkFromClipboard,
  });

  tabManager.baseWindow.on("closed", () => {
    tabManager = undefined;
  });

  const initialUrl = pendingLaunchUrl ?? outlineUrl.toString();
  pendingLaunchUrl = undefined;
  tabManager.createTab(initialUrl);
}

pendingLaunchUrl = findLaunchUrl(process.argv);

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const launchUrl = findLaunchUrl(argv);
    if (launchUrl) {
      openOutlineUrlInApp(launchUrl);
      return;
    }

    focusMainWindow();
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    handlePotentialLaunchUrl(url);
  });

  app.whenReady().then(() => {
    registerAuthLinkProtocol();
    configureAppMenu();
    configureIpc();
    const outlineSession = configureOutlineSession();

    createTabbedWindow(outlineSession);

    app.on("activate", () => {
      if (!tabManager || tabManager.isDestroyed) {
        createTabbedWindow(outlineSession);
      } else {
        focusMainWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
