import { BaseWindow, WebContentsView, shell } from "electron";
import {
  SHORTCUTS_VISIBILITY_CHANNEL,
  TAB_DRAG_ZONE_CHANNEL,
  TAB_STATE_CHANNEL,
  type TabDragZone,
  type TabDropRequest,
  type TabState,
} from "../shared/ipc";
import type { ShortcutActionId } from "./shortcuts";

const TAB_BAR_HEIGHT = 40;

/** Tab ids are global so a tab keeps its identity when it moves between windows. */
let nextTabId = 1;

interface Tab {
  id: number;
  view: WebContentsView;
  /** Removes the listeners this manager attached, so another one can take over. */
  unwire?: () => void;
}

/** A tab that has been pulled out of its window and not yet handed to another. */
export interface DetachedTab {
  id: number;
  view: WebContentsView;
}

export interface TabManagerOptions {
  session: Electron.Session;
  /** Preload for Outline tabs (meeting recorder). */
  preloadPath: string;
  /** Preload for the tab-bar chrome view. */
  chromePreloadPath: string;
  /** Preload for the shortcut overlay. */
  overlayPreloadPath: string;
  /** Self-contained HTML for the tab bar. */
  chromeHtml: string;
  /** Self-contained HTML for the shortcut overlay. */
  overlayHtml: string;
  /** URL a fresh tab opens. */
  homeUrl: string;
  /** Window bounds; defaults to a centred window when omitted. */
  bounds?: Partial<Electron.Rectangle>;
  /** Keeps the window hidden until the caller shows it. */
  show?: boolean;
  isAllowedOrigin(url: string): boolean;
  /** Maps a key press to an action, or undefined when nothing is bound. */
  resolveShortcut(input: Electron.Input): ShortcutActionId | undefined;
  onShortcut(action: ShortcutActionId, manager: TabManager): void;
  /** A tab drag finished in this window's tab bar. */
  onTabDrop(request: TabDropRequest, manager: TabManager): void;
  onClosed(manager: TabManager): void;
}

/**
 * Owns a BaseWindow that stacks a tab-bar view on top of one WebContentsView
 * per open Outline page. Only the active tab is visible; the rest stay attached
 * but hidden so their state (scroll, recording) survives a tab switch.
 *
 * Tabs are not owned exclusively: `takeTab`/`adoptTab` move a live
 * WebContentsView to another window without reloading it, which is what tab
 * drag-out and drag-between-windows are built on.
 */
export class TabManager {
  private readonly window: BaseWindow;
  private readonly chromeView: WebContentsView;
  private readonly tabs: Tab[] = [];
  private readonly options: TabManagerOptions;
  private activeId: number | undefined;
  /** Built on first use; the shortcut panel is a rarely-opened overlay. */
  private overlayView: WebContentsView | undefined;
  private overlayOpen = false;

  constructor(options: TabManagerOptions) {
    this.options = options;

    this.window = new BaseWindow({
      width: options.bounds?.width ?? 1440,
      height: options.bounds?.height ?? 1000,
      ...(options.bounds?.x !== undefined && options.bounds?.y !== undefined
        ? { x: options.bounds.x, y: options.bounds.y }
        : {}),
      minWidth: 1024,
      minHeight: 720,
      show: options.show ?? true,
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
    this.chromeView.webContents.on("before-input-event", (event, input) =>
      this.handleShortcut(event, input),
    );

    this.window.on("resize", () => this.layout());
    this.window.on("closed", () => this.options.onClosed(this));

    this.layout();
  }

  get baseWindow(): BaseWindow {
    return this.window;
  }

  get isDestroyed(): boolean {
    return this.window.isDestroyed();
  }

  /** Identifies IPC arriving from this window's tab bar. */
  get chromeWebContentsId(): number {
    return this.chromeView.webContents.id;
  }

  get tabCount(): number {
    return this.tabs.length;
  }

  hasTab(id: number): boolean {
    return this.tabs.some((tab) => tab.id === id);
  }

  get activeTabId(): number | undefined {
    return this.activeId;
  }

  titleOf(id: number): string {
    const tab = this.tabs.find((candidate) => candidate.id === id);
    if (!tab || tab.view.webContents.isDestroyed()) {
      return "새 탭";
    }

    return tab.view.webContents.getTitle() || "새 탭";
  }

  /**
   * Shows the shortcut panel as a modal sheet inside this window: a transparent
   * view stacked over everything, dimming the page behind it.
   */
  openOverlay(): void {
    const view = this.ensureOverlay();
    if (!this.overlayOpen) {
      this.overlayOpen = true;
      this.window.contentView.addChildView(view);
      view.setVisible(true);
      this.layout();
    }

    this.focus();
    view.webContents.focus();
    view.webContents.send(SHORTCUTS_VISIBILITY_CHANNEL, true);
  }

  closeOverlay(): void {
    if (!this.overlayOpen || !this.overlayView) {
      return;
    }

    this.overlayOpen = false;
    this.overlayView.setVisible(false);
    this.window.contentView.removeChildView(this.overlayView);
    this.focusActive();
  }

  get isOverlayOpen(): boolean {
    return this.overlayOpen;
  }

  /** The overlay's webContents id, so IPC from it can be routed back here. */
  get overlayWebContentsId(): number | undefined {
    return this.overlayView && !this.overlayView.webContents.isDestroyed()
      ? this.overlayView.webContents.id
      : undefined;
  }

  sendToOverlay(channel: string, payload: unknown): void {
    if (this.overlayView && !this.overlayView.webContents.isDestroyed()) {
      this.overlayView.webContents.send(channel, payload);
    }
  }

  private ensureOverlay(): WebContentsView {
    if (this.overlayView && !this.overlayView.webContents.isDestroyed()) {
      return this.overlayView;
    }

    const view = new WebContentsView({
      webPreferences: {
        preload: this.options.overlayPreloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        transparent: true,
      },
    });

    // Transparent so the dimmed backdrop shows the page underneath.
    view.setBackgroundColor("#00000000");
    void view.webContents.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(this.options.overlayHtml)}`,
    );

    this.overlayView = view;
    return view;
  }

  /** Screen-space rectangle of the tab strip, used to resolve drag drops. */
  tabBarScreenBounds(): Electron.Rectangle {
    const bounds = this.window.getContentBounds();
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: TAB_BAR_HEIGHT };
  }

  focus(): void {
    if (this.window.isMinimized()) {
      this.window.restore();
    }
    this.window.show();
    this.window.focus();
  }

  close(): void {
    if (!this.window.isDestroyed()) {
      this.window.close();
    }
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

    const tab: Tab = { id: nextTabId++, view };
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
    this.raiseOverlay();
    this.focusActive();
    this.broadcast();
  }

  activeWebContents(): Electron.WebContents | undefined {
    const active = this.tabs.find((tab) => tab.id === this.activeId);
    if (!active || active.view.webContents.isDestroyed()) {
      return undefined;
    }

    return active.view.webContents;
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

  /** Places `id` at `toIndex` in the strip. Always re-broadcasts so the tab bar
   * can drop the optimistic ordering it painted during the drag. */
  reorderTab(id: number, toIndex: number): void {
    const from = this.tabs.findIndex((tab) => tab.id === id);
    if (from === -1) {
      this.broadcast();
      return;
    }

    const target = Math.max(0, Math.min(toIndex, this.tabs.length - 1));
    if (target !== from) {
      const [tab] = this.tabs.splice(from, 1);
      this.tabs.splice(target, 0, tab);
    }

    this.broadcast();
  }

  closeTab(id: number): void {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index === -1) {
      return;
    }

    const [tab] = this.tabs.splice(index, 1);
    tab.unwire?.();
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

  /**
   * Detaches a tab without destroying it. The caller must hand the result to
   * `adoptTab` (or close it), otherwise the WebContentsView is orphaned.
   */
  takeTab(id: number): DetachedTab | undefined {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index === -1) {
      return undefined;
    }

    const [tab] = this.tabs.splice(index, 1);
    tab.unwire?.();
    tab.unwire = undefined;
    this.window.contentView.removeChildView(tab.view);

    if (this.activeId === id) {
      const next = this.tabs[index] ?? this.tabs[index - 1];
      this.activeId = next?.id;
      if (next) {
        this.activate(next.id);
      }
    }

    this.broadcast();
    return { id: tab.id, view: tab.view };
  }

  /** Takes ownership of a tab detached from another window. */
  adoptTab(detached: DetachedTab, index?: number): void {
    const tab: Tab = { id: detached.id, view: detached.view };
    this.wireTab(tab);
    this.window.contentView.addChildView(tab.view);

    const target = index === undefined ? this.tabs.length : Math.max(0, Math.min(index, this.tabs.length));
    this.tabs.splice(target, 0, tab);

    this.activate(tab.id);
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

    const onWillNavigate = (event: Electron.Event, url: string): void => {
      if (this.options.isAllowedOrigin(url)) {
        return;
      }
      event.preventDefault();
      void shell.openExternal(url);
    };
    const onUpdate = (): void => this.broadcast();
    const onInput = (event: Electron.Event, input: Electron.Input): void =>
      this.handleShortcut(event, input);

    wc.on("will-navigate", onWillNavigate);
    wc.on("page-title-updated", onUpdate);
    wc.on("did-start-loading", onUpdate);
    wc.on("did-stop-loading", onUpdate);
    wc.on("did-navigate", onUpdate);
    wc.on("did-navigate-in-page", onUpdate);
    wc.on("before-input-event", onInput);

    tab.unwire = () => {
      if (wc.isDestroyed()) {
        return;
      }
      wc.off("will-navigate", onWillNavigate);
      wc.off("page-title-updated", onUpdate);
      wc.off("did-start-loading", onUpdate);
      wc.off("did-stop-loading", onUpdate);
      wc.off("did-navigate", onUpdate);
      wc.off("did-navigate-in-page", onUpdate);
      wc.off("before-input-event", onInput);
    };
  }

  private handleShortcut(event: Electron.Event, input: Electron.Input): void {
    const action = this.options.resolveShortcut(input);
    if (!action) {
      return;
    }

    event.preventDefault();
    this.options.onShortcut(action, this);
  }

  private focusActive(): void {
    // The overlay is modal; it keeps focus while it is up.
    if (this.overlayOpen) {
      return;
    }

    const active = this.tabs.find((tab) => tab.id === this.activeId);
    active?.view.webContents.focus();
  }

  /** Keeps the overlay above views added after it was opened. */
  private raiseOverlay(): void {
    if (!this.overlayOpen || !this.overlayView) {
      return;
    }

    this.window.contentView.removeChildView(this.overlayView);
    this.window.contentView.addChildView(this.overlayView);
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

    if (this.overlayOpen) {
      this.overlayView?.setBounds({ x: 0, y: 0, width, height });
    }
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

  /** Forwards a drag that ended in this window's tab bar to the window manager. */
  handleTabDrop(request: TabDropRequest): void {
    this.options.onTabDrop(request, this);
  }

  /** Tells the tab bar whether the dragged tab has been torn out of the strip. */
  sendDragZone(zone: TabDragZone): void {
    if (!this.chromeView.webContents.isDestroyed()) {
      this.chromeView.webContents.send(TAB_DRAG_ZONE_CHANNEL, zone);
    }
  }
}
