import { BaseWindow, WebContentsView, ipcMain, shell } from "electron";
import {
  TAB_ACTIVATE_CHANNEL,
  TAB_CLOSE_CHANNEL,
  TAB_CREATE_CHANNEL,
  TAB_STATE_CHANNEL,
  type TabState,
} from "../shared/ipc";

const TAB_BAR_HEIGHT = 40;

interface Tab {
  id: number;
  view: WebContentsView;
}

export interface TabManagerOptions {
  session: Electron.Session;
  /** Preload for Outline tabs (meeting recorder). */
  preloadPath: string;
  /** Preload for the tab-bar chrome view. */
  chromePreloadPath: string;
  /** Self-contained HTML for the tab bar. */
  chromeHtml: string;
  /** URL a fresh tab opens. */
  homeUrl: string;
  isAllowedOrigin(url: string): boolean;
  /** Invoked on Ctrl/Cmd+Shift+L (load login link from clipboard). */
  onLoginLinkShortcut?: () => void;
}

/**
 * Owns a frameless-content BaseWindow that stacks a tab-bar view on top of one
 * WebContentsView per open Outline page. Only the active tab is visible; the
 * rest stay attached but hidden so their state (scroll, recording) survives a
 * tab switch.
 */
export class TabManager {
  private readonly window: BaseWindow;
  private readonly chromeView: WebContentsView;
  private readonly tabs: Tab[] = [];
  private readonly options: TabManagerOptions;
  private activeId: number | undefined;
  private nextId = 1;

  constructor(options: TabManagerOptions) {
    this.options = options;

    this.window = new BaseWindow({
      width: 1440,
      height: 1000,
      minWidth: 1024,
      minHeight: 720,
      title: "Outline Desktop",
    });

    this.chromeView = new WebContentsView({
      webPreferences: {
        preload: options.chromePreloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.window.contentView.addChildView(this.chromeView);
    void this.chromeView.webContents.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(options.chromeHtml)}`,
    );
    this.chromeView.webContents.on("did-finish-load", () => this.broadcast());

    this.registerIpc();
    this.window.on("resize", () => this.layout());
    this.window.on("closed", () => this.dispose());

    this.layout();
  }

  get baseWindow(): BaseWindow {
    return this.window;
  }

  get isDestroyed(): boolean {
    return this.window.isDestroyed();
  }

  focus(): void {
    if (this.window.isMinimized()) {
      this.window.restore();
    }
    this.window.show();
    this.window.focus();
  }

  createTab(url?: string): void {
    const view = new WebContentsView({
      webPreferences: {
        preload: this.options.preloadPath,
        session: this.options.session,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });

    const tab: Tab = { id: this.nextId++, view };
    this.wireTab(tab);
    this.window.contentView.addChildView(view);
    this.tabs.push(tab);

    void view.webContents.loadURL(url ?? this.options.homeUrl);
    this.activate(tab.id);
  }

  /** Loads a URL in the active tab, or opens a new tab if there is none. */
  openUrl(url: string): void {
    const active = this.tabs.find((tab) => tab.id === this.activeId);
    if (active) {
      void active.view.webContents.loadURL(url);
      this.focus();
      return;
    }

    this.createTab(url);
    this.focus();
  }

  activate(id: number): void {
    if (!this.tabs.some((tab) => tab.id === id)) {
      return;
    }

    this.activeId = id;
    for (const tab of this.tabs) {
      tab.view.setVisible(tab.id === id);
    }
    this.layout();
    this.focusActive();
    this.broadcast();
  }

  /** Move the active tab by `direction` (+1 next, -1 previous), wrapping around. */
  cycleTab(direction: 1 | -1): void {
    if (this.tabs.length < 2) {
      return;
    }
    const index = this.tabs.findIndex((tab) => tab.id === this.activeId);
    if (index === -1) {
      return;
    }
    const nextIndex = (index + direction + this.tabs.length) % this.tabs.length;
    this.activate(this.tabs[nextIndex].id);
  }

  closeTab(id: number): void {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index === -1) {
      return;
    }

    const [tab] = this.tabs.splice(index, 1);
    this.window.contentView.removeChildView(tab.view);
    const wc = tab.view.webContents;
    if (!wc.isDestroyed()) {
      wc.close();
    }

    if (this.activeId === id) {
      const next = this.tabs[index] ?? this.tabs[index - 1];
      if (next) {
        this.activate(next.id);
      } else {
        this.activeId = undefined;
        this.window.close();
        return;
      }
    }

    this.broadcast();
  }

  closeActiveTab(): void {
    if (this.activeId !== undefined) {
      this.closeTab(this.activeId);
    }
  }

  private wireTab(tab: Tab): void {
    const wc = tab.view.webContents;

    wc.setWindowOpenHandler(({ url }) => {
      if (this.options.isAllowedOrigin(url)) {
        this.createTab(url);
      } else {
        void shell.openExternal(url);
      }
      return { action: "deny" };
    });

    wc.on("will-navigate", (event, url) => {
      if (this.options.isAllowedOrigin(url)) {
        return;
      }
      event.preventDefault();
      void shell.openExternal(url);
    });

    wc.on("page-title-updated", () => this.broadcast());
    wc.on("did-start-loading", () => this.broadcast());
    wc.on("did-stop-loading", () => this.broadcast());
    wc.on("did-navigate", () => this.broadcast());
    wc.on("did-navigate-in-page", () => this.broadcast());
    wc.on("before-input-event", (event, input) => this.handleShortcut(event, input));
  }

  private handleShortcut(event: Electron.Event, input: Electron.Input): void {
    if (input.type !== "keyDown") {
      return;
    }

    // Ctrl+Tab / Ctrl+Shift+Tab cycles tabs. Uses Ctrl on every platform since
    // Cmd+Tab is the macOS application switcher.
    if (input.control && input.key === "Tab") {
      event.preventDefault();
      this.cycleTab(input.shift ? -1 : 1);
      return;
    }

    const modifier = process.platform === "darwin" ? input.meta : input.control;
    if (!modifier) {
      return;
    }

    const key = input.key.toLowerCase();
    if (key === "l" && input.shift) {
      event.preventDefault();
      this.options.onLoginLinkShortcut?.();
    } else if (key === "t") {
      event.preventDefault();
      this.createTab();
    } else if (key === "w") {
      event.preventDefault();
      this.closeActiveTab();
    }
  }

  private focusActive(): void {
    const active = this.tabs.find((tab) => tab.id === this.activeId);
    active?.view.webContents.focus();
  }

  private layout(): void {
    const { width, height } = this.window.getContentBounds();
    this.chromeView.setBounds({ x: 0, y: 0, width, height: TAB_BAR_HEIGHT });

    const body = {
      x: 0,
      y: TAB_BAR_HEIGHT,
      width,
      height: Math.max(0, height - TAB_BAR_HEIGHT),
    };
    const active = this.tabs.find((tab) => tab.id === this.activeId);
    active?.view.setBounds(body);
  }

  private broadcast(): void {
    if (this.chromeView.webContents.isDestroyed()) {
      return;
    }

    const state: TabState = {
      tabs: this.tabs.map((tab) => ({
        id: tab.id,
        title: tab.view.webContents.getTitle() || "새 탭",
        active: tab.id === this.activeId,
        loading: tab.view.webContents.isLoading(),
      })),
    };

    this.chromeView.webContents.send(TAB_STATE_CHANNEL, state);
  }

  private registerIpc(): void {
    // Only one TabManager is alive at a time; clear any stale handlers first.
    ipcMain.removeAllListeners(TAB_CREATE_CHANNEL);
    ipcMain.removeAllListeners(TAB_CLOSE_CHANNEL);
    ipcMain.removeAllListeners(TAB_ACTIVATE_CHANNEL);

    ipcMain.on(TAB_CREATE_CHANNEL, () => this.createTab());
    ipcMain.on(TAB_CLOSE_CHANNEL, (_event, id: number) => this.closeTab(id));
    ipcMain.on(TAB_ACTIVATE_CHANNEL, (_event, id: number) => this.activate(id));
  }

  private dispose(): void {
    ipcMain.removeAllListeners(TAB_CREATE_CHANNEL);
    ipcMain.removeAllListeners(TAB_CLOSE_CHANNEL);
    ipcMain.removeAllListeners(TAB_ACTIVATE_CHANNEL);
  }
}
