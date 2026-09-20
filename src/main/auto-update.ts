import { app, dialog } from "electron";
import { autoUpdater } from "electron-updater";

const UPDATE_CHECK_DELAY_MS = 5_000;

let updateDialogOpen = false;

async function promptForDownload(version: string): Promise<void> {
  if (updateDialogOpen) {
    return;
  }

  updateDialogOpen = true;
  try {
    const { response } = await dialog.showMessageBox({
      type: "info",
      title: "Update available",
      message: `Outline Electron Client ${version} is available.`,
      detail: "Would you like to download it now? You can continue using the app while it downloads.",
      buttons: ["Download", "Later"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });

    if (response === 0) {
      await autoUpdater.downloadUpdate();
    }
  } catch (error) {
    console.error("Failed to download application update", error);
  } finally {
    updateDialogOpen = false;
  }
}

async function promptForInstall(version: string): Promise<void> {
  if (updateDialogOpen) {
    return;
  }

  updateDialogOpen = true;
  try {
    const { response } = await dialog.showMessageBox({
      type: "info",
      title: "Update ready",
      message: `Outline Electron Client ${version} has been downloaded.`,
      detail: "Restart the app to finish installing the update.",
      buttons: ["Restart and install", "Later"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });

    if (response === 0) {
      autoUpdater.quitAndInstall(false, true);
    }
  } finally {
    updateDialogOpen = false;
  }
}

export function configureAutoUpdate(): void {
  if (!app.isPackaged || process.platform !== "win32") {
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", (info) => {
    void promptForDownload(info.version);
  });

  autoUpdater.on("update-downloaded", (info) => {
    void promptForInstall(info.version);
  });

  autoUpdater.on("error", (error) => {
    // A transient network or GitHub outage should not interrupt normal app use.
    console.error("Application update check failed", error);
  });

  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch((error) => {
      console.error("Failed to check for application updates", error);
    });
  }, UPDATE_CHECK_DELAY_MS);
}
