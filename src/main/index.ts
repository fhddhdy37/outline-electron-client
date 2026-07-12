import { app, BrowserWindow, desktopCapturer, ipcMain, shell, session } from "electron";
import path from "node:path";
import {
  APP_INFO_CHANNEL,
  DEFAULT_OUTLINE_URL,
  type AppInfo,
  type SystemAudioStrategy,
} from "../shared/ipc";

const OUTLINE_PARTITION = "persist:outline-client";
const OUTLINE_URL_ARG = "--outline-url=";

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
      platform: process.platform,
      systemAudioStrategy: systemAudioStrategy(),
    };
  });
}

function createMainWindow(outlineSession: Electron.Session): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 1000,
    minWidth: 1024,
    minHeight: 720,
    title: "Outline Desktop",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      session: outlineSession,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedOutlineOrigin(url)) {
      return { action: "allow" };
    }

    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isAllowedOutlineOrigin(url)) {
      return;
    }

    event.preventDefault();
    shell.openExternal(url);
  });

  void mainWindow.loadURL(outlineUrl.toString());

  return mainWindow;
}

app.whenReady().then(() => {
  configureIpc();
  const outlineSession = configureOutlineSession();

  createMainWindow(outlineSession);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow(outlineSession);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

