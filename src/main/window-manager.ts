import { ipcMain, screen } from "electron";
import {
  SHORTCUTS_CHANGED_CHANNEL,
  SHORTCUTS_CLOSE_CHANNEL,
  SHORTCUTS_GET_CHANNEL,
  SHORTCUTS_OPEN_CHANNEL,
  SHORTCUTS_RESET_CHANNEL,
  SHORTCUTS_SET_CHANNEL,
  TAB_ACTIVATE_CHANNEL,
  TAB_CLOSE_CHANNEL,
  TAB_CREATE_CHANNEL,
  TAB_DRAG_BEGIN_CHANNEL,
  TAB_DRAG_CANCEL_CHANNEL,
  TAB_DROP_CHANNEL,
  TAB_OPEN_LINK_CHANNEL,
  type ShortcutSetRequest,
  type ShortcutsSnapshot,
  type TabDropRequest,
  type TabOpenLinkRequest,
} from "../shared/ipc";
import { DragGhost, type GhostMode } from "./drag-ghost";
import type { ShortcutActionId, ShortcutRegistry } from "./shortcuts";
import { TabManager } from "./tab-manager";

/** How far a detached window is offset so the grabbed tab lands under the cursor. */
const DETACH_GRAB_OFFSET = { x: 120, y: 18 };
/** Slack around a tab strip; a drop inside it still counts as "on the strip". */
const DROP_MARGIN = 26;
/** Cursor sampling rate while a tab is being dragged. */
const DRAG_POLL_MS = 16;

interface DragSession {
  source: TabManager;
  tabId: number;
  ghost: DragGhost;
  timer: NodeJS.Timeout;
  torn: boolean;
}

export interface WindowManagerOptions {
  session: Electron.Session;
  preloadPath: string;
  chromePreloadPath: string;
  overlayPreloadPath: string;
  chromeHtml: string;
  overlayHtml: string;
  homeUrl: string;
  shortcuts: ShortcutRegistry;
  isAllowedOrigin(url: string): boolean;
  /** Invoked by the `login.link` action. */
  onLoginLinkShortcut(): void;
}

function containsPoint(rect: Electron.Rectangle, point: Electron.Point, margin = 0): boolean {
  return (
    point.x >= rect.x - margin &&
    point.x < rect.x + rect.width + margin &&
    point.y >= rect.y - margin &&
    point.y < rect.y + rect.height + margin
  );
}

/**
 * Owns every tabbed window plus the shortcut-settings window, and is the single
 * place IPC from the tab bars is handled — each message is routed back to the
 * window whose tab-bar view sent it.
 */
export class WindowManager {
  private readonly managers: TabManager[] = [];
  private readonly options: WindowManagerOptions;
  private drag: DragSession | undefined;

  constructor(options: WindowManagerOptions) {
    this.options = options;
    this.registerIpc();
    this.options.shortcuts.onChange(() => this.broadcastShortcuts());
  }

  get hasWindows(): boolean {
    return this.managers.some((manager) => !manager.isDestroyed);
  }

  createWindow(
    url?: string,
    bounds?: Partial<Electron.Rectangle>,
    show = true,
  ): TabManager {
    const manager = new TabManager({
      session: this.options.session,
      preloadPath: this.options.preloadPath,
      chromePreloadPath: this.options.chromePreloadPath,
      overlayPreloadPath: this.options.overlayPreloadPath,
      chromeHtml: this.options.chromeHtml,
      overlayHtml: this.options.overlayHtml,
      homeUrl: this.options.homeUrl,
      bounds,
      show,
      isAllowedOrigin: this.options.isAllowedOrigin,
      resolveShortcut: (input) => this.options.shortcuts.resolve(input),
      onShortcut: (action, source) => this.runAction(action, source),
      onTabDrop: (request, source) => this.handleTabDrop(request, source),
      onClosed: (source) => this.forget(source),
    });

    this.managers.push(manager);
    if (url !== undefined) {
      manager.createTab(url);
    }

    return manager;
  }

  /** The window the user is working in, falling back to the most recent one. */
  activeManager(): TabManager | undefined {
    const alive = this.managers.filter((manager) => !manager.isDestroyed);
    return alive.find((manager) => manager.baseWindow.isFocused()) ?? alive[alive.length - 1];
  }

  focus(): void {
    this.activeManager()?.focus();
  }

  openUrl(url: string): void {
    const manager = this.activeManager();
    if (manager) {
      manager.openUrl(url);
      return;
    }

    this.createWindow(url).focus();
  }

  /** Opens the shortcut panel as a modal sheet inside the given window. */
  openShortcuts(manager?: TabManager): void {
    (manager ?? this.activeManager())?.openOverlay();
  }

  private forget(manager: TabManager): void {
    const index = this.managers.indexOf(manager);
    if (index !== -1) {
      this.managers.splice(index, 1);
    }

    if (this.drag?.source === manager) {
      this.endDrag();
    }
  }

  private runAction(action: ShortcutActionId, source: TabManager): void {
    switch (action) {
      case "tab.new":
        source.createTab();
        return;
      case "tab.close":
        source.closeActiveTab();
        return;
      case "tab.next":
        source.cycleTab(1);
        return;
      case "tab.prev":
        source.cycleTab(-1);
        return;
      case "window.new": {
        const bounds = source.baseWindow.getBounds();
        this.createWindow(this.options.homeUrl, {
          width: bounds.width,
          height: bounds.height,
          x: bounds.x + 32,
          y: bounds.y + 32,
        }).focus();
        return;
      }
      case "page.reload":
        source.activeWebContents()?.reload();
        return;
      case "page.back": {
        const wc = source.activeWebContents();
        if (wc?.navigationHistory.canGoBack()) {
          wc.navigationHistory.goBack();
        }
        return;
      }
      case "page.forward": {
        const wc = source.activeWebContents();
        if (wc?.navigationHistory.canGoForward()) {
          wc.navigationHistory.goForward();
        }
        return;
      }
      case "login.link":
        this.options.onLoginLinkShortcut();
        return;
      case "shortcuts.open":
        this.openShortcuts(source);
        return;
      default:
        return;
    }
  }

  /**
   * Starts tracking the cursor for a drag that just passed the threshold. The
   * tab bar cannot see past its own 40px-tall view, so the main process owns
   * the "where is this tab now" question for the rest of the gesture.
   */
  private beginDrag(source: TabManager, tabId: number): void {
    this.endDrag();

    const ghost = new DragGhost();
    ghost.prepare(source.titleOf(tabId));

    this.drag = {
      source,
      tabId,
      ghost,
      torn: false,
      timer: setInterval(() => this.trackDrag(), DRAG_POLL_MS),
    };
  }

  private trackDrag(): void {
    const drag = this.drag;
    if (!drag || drag.source.isDestroyed) {
      this.endDrag();
      return;
    }

    const point = screen.getCursorScreenPoint();
    const zone = this.zoneAt(point, drag.source);

    if (zone === "own-strip") {
      if (drag.torn) {
        drag.torn = false;
        drag.source.sendDragZone({ torn: false });
        drag.ghost.conceal();
      }
      return;
    }

    const mode: GhostMode = zone === "other-strip" ? "attach" : "window";
    if (!drag.torn) {
      drag.torn = true;
      drag.source.sendDragZone({ torn: true });
      drag.ghost.reveal(point, mode);
      return;
    }

    drag.ghost.setMode(mode, point);
    drag.ghost.moveTo(point);
  }

  private endDrag(): DragGhost | undefined {
    const drag = this.drag;
    if (!drag) {
      return undefined;
    }

    clearInterval(drag.timer);
    this.drag = undefined;
    if (drag.torn && !drag.source.isDestroyed) {
      drag.source.sendDragZone({ torn: false });
    }

    return drag.ghost;
  }

  /**
   * Resolves where a dragged tab landed: back in its own strip (reorder), on
   * another window's strip (move), or nowhere (detach into a new window).
   *
   * The decision is made from the real cursor position rather than from the
   * drag coordinates the tab bar saw, so it stays correct no matter how far
   * outside its own view the pointer travelled.
   */
  private handleTabDrop(request: TabDropRequest, source: TabManager): void {
    const ghost = this.endDrag();

    if (!source.hasTab(request.id)) {
      ghost?.destroy();
      return;
    }

    const point = screen.getCursorScreenPoint();
    const zone = this.zoneAt(point, source);

    // Detaching the only tab would just close and reopen the same window.
    if (zone === "own-strip" || (zone === "outside" && source.tabCount < 2)) {
      source.reorderTab(request.id, request.toIndex);
      void ghost?.dismiss().then(() => ghost.destroy());
      return;
    }

    if (zone === "other-strip") {
      const target = this.managerAt(point);
      if (target && target !== source) {
        this.moveTab(request.id, source, target);
      } else {
        source.reorderTab(request.id, request.toIndex);
      }
      void ghost?.dismiss().then(() => ghost.destroy());
      return;
    }

    void this.detachTab(request.id, source, point, ghost);
  }

  /** Grows the drag ghost into the window the tab is becoming, then swaps it. */
  private async detachTab(
    id: number,
    source: TabManager,
    point: Electron.Point,
    ghost: DragGhost | undefined,
  ): Promise<void> {
    const size = source.baseWindow.getBounds();
    const work = screen.getDisplayNearestPoint(point).workArea;
    const width = Math.min(size.width, work.width);
    const height = Math.min(size.height, work.height);
    const bounds = {
      width,
      height,
      x: Math.max(work.x, Math.min(point.x - DETACH_GRAB_OFFSET.x, work.x + work.width - width)),
      y: Math.max(work.y, Math.min(point.y - DETACH_GRAB_OFFSET.y, work.y + work.height - height)),
    };

    if (ghost?.isVisible) {
      await ghost.expandInto(bounds);
    }

    // The window may have closed while the animation ran.
    if (source.isDestroyed || !source.hasTab(id)) {
      ghost?.destroy();
      return;
    }

    const detached = source.takeTab(id);
    if (!detached) {
      ghost?.destroy();
      return;
    }

    // Built hidden so the ghost never blinks out before the window paints.
    const created = this.createWindow(undefined, bounds, false);
    created.adoptTab(detached);
    created.focus();
    ghost?.destroy();
  }

  /** Where a point sits relative to the window a drag started from. */
  private zoneAt(point: Electron.Point, source: TabManager): "own-strip" | "other-strip" | "outside" {
    const target = this.managerAt(point);
    if (target === source) {
      return "own-strip";
    }
    if (target) {
      return "other-strip";
    }

    return containsPoint(source.tabBarScreenBounds(), point, DROP_MARGIN) ? "own-strip" : "outside";
  }

  private moveTab(id: number, source: TabManager, target: TabManager): void {
    const detached = source.takeTab(id);
    if (!detached) {
      return;
    }

    target.adoptTab(detached);
    target.focus();

    if (source.tabCount === 0) {
      source.close();
    }
  }

  /** The window whose tab strip is under `point`, preferring the focused one. */
  private managerAt(point: Electron.Point): TabManager | undefined {
    const candidates = this.managers.filter(
      (manager) =>
        !manager.isDestroyed &&
        !manager.baseWindow.isMinimized() &&
        manager.baseWindow.isVisible() &&
        containsPoint(manager.tabBarScreenBounds(), point),
    );

    return candidates.find((manager) => manager.baseWindow.isFocused()) ?? candidates[0];
  }

  private managerForSender(event: Electron.IpcMainEvent): TabManager | undefined {
    return this.managers.find(
      (manager) => !manager.isDestroyed && manager.chromeWebContentsId === event.sender.id,
    );
  }

  private managerForTabSender(event: Electron.IpcMainEvent): TabManager | undefined {
    return this.managers.find(
      (manager) => !manager.isDestroyed && manager.ownsTabWebContents(event.sender.id),
    );
  }

  private managerForOverlay(event: Electron.IpcMainEvent): TabManager | undefined {
    return this.managers.find(
      (manager) => !manager.isDestroyed && manager.overlayWebContentsId === event.sender.id,
    );
  }

  private broadcastShortcuts(): void {
    const snapshot = this.options.shortcuts.snapshot();
    for (const manager of this.managers) {
      if (!manager.isDestroyed) {
        manager.sendToOverlay(SHORTCUTS_CHANGED_CHANNEL, snapshot);
      }
    }
  }

  private registerIpc(): void {
    ipcMain.on(TAB_CREATE_CHANNEL, (event) => this.managerForSender(event)?.createTab());
    ipcMain.on(TAB_OPEN_LINK_CHANNEL, (event, request: TabOpenLinkRequest) => {
      const manager = this.managerForTabSender(event);
      if (
        manager &&
        request &&
        typeof request.url === "string" &&
        this.options.isAllowedOrigin(request.url)
      ) {
        manager.createTab(request.url, !request.background);
      }
    });
    ipcMain.on(TAB_CLOSE_CHANNEL, (event, id: number) => this.managerForSender(event)?.closeTab(id));
    ipcMain.on(TAB_ACTIVATE_CHANNEL, (event, id: number) =>
      this.managerForSender(event)?.activate(id),
    );
    ipcMain.on(TAB_DRAG_BEGIN_CHANNEL, (event, id: number) => {
      const manager = this.managerForSender(event);
      if (manager && typeof id === "number" && manager.hasTab(id)) {
        this.beginDrag(manager, id);
      }
    });
    ipcMain.on(TAB_DRAG_CANCEL_CHANNEL, (event) => {
      if (this.managerForSender(event) === this.drag?.source) {
        this.endDrag()?.destroy();
      }
    });
    ipcMain.on(TAB_DROP_CHANNEL, (event, request: TabDropRequest) => {
      const manager = this.managerForSender(event);
      if (manager && request && typeof request.id === "number") {
        manager.handleTabDrop({
          id: request.id,
          toIndex: Number.isFinite(request.toIndex) ? request.toIndex : 0,
        });
      }
    });
    ipcMain.on(SHORTCUTS_OPEN_CHANNEL, (event) => this.openShortcuts(this.managerForSender(event)));
    ipcMain.on(SHORTCUTS_CLOSE_CHANNEL, (event) => this.managerForOverlay(event)?.closeOverlay());

    ipcMain.handle(SHORTCUTS_GET_CHANNEL, (): ShortcutsSnapshot =>
      this.options.shortcuts.snapshot(),
    );
    ipcMain.handle(SHORTCUTS_SET_CHANNEL, (_event, request: ShortcutSetRequest) => {
      if (request && typeof request.id === "string") {
        this.options.shortcuts.set(
          request.id,
          typeof request.accelerator === "string" ? request.accelerator : null,
        );
      }
      return this.options.shortcuts.snapshot();
    });
    ipcMain.handle(SHORTCUTS_RESET_CHANNEL, (_event, id?: string) => {
      if (typeof id === "string") {
        this.options.shortcuts.reset(id);
      } else {
        this.options.shortcuts.resetAll();
      }
      return this.options.shortcuts.snapshot();
    });
  }
}
