import { BrowserWindow } from "electron";

/**
 * The card that rides the cursor while a tab is dragged outside its strip —
 * the Chrome "tear-off" preview.
 *
 * It is a transparent, click-through, never-focused window: showing it must not
 * disturb the drag, because the mouse press is still captured by the tab bar
 * that started it. Nothing here ever calls `show()`/`focus()` for that reason.
 */

export type GhostMode = "window" | "attach";

const MARGIN = 22;
const CARD: Record<GhostMode, { width: number; height: number }> = {
  // A miniature browser window: this tab is about to become one.
  window: { width: 268, height: 176 },
  // Just the tab itself: it is about to drop into a strip.
  attach: { width: 196, height: 34 },
};

/** Where the cursor sits inside the ghost, so it keeps holding "the tab". */
const GRAB = { x: MARGIN + 54, y: MARGIN + 17 };

const FRAME_MS = 16;

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function windowSize(mode: GhostMode): { width: number; height: number } {
  return {
    width: CARD[mode].width + MARGIN * 2,
    height: CARD[mode].height + MARGIN * 2,
  };
}

function ghostHtml(title: string): string {
  const safeTitle = title
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  :root {
    color-scheme: light dark;
    --bar: #e8eaed;
    --page: #ffffff;
    --tab: #ffffff;
    --fg: #1f2328;
    --line: rgba(0, 0, 0, 0.09);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bar: #202124;
      --page: #2b2c2f;
      --tab: #35363a;
      --fg: #e8eaed;
      --line: rgba(255, 255, 255, 0.12);
    }
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    height: 100%;
    background: transparent;
    overflow: hidden;
    font-family: system-ui, -apple-system, "Segoe UI", "Malgun Gothic", Roboto, sans-serif;
    user-select: none;
    cursor: grabbing;
  }
  #card {
    position: absolute;
    inset: ${MARGIN}px;
    display: flex;
    flex-direction: column;
    border-radius: 10px;
    overflow: hidden;
    background: var(--bar);
    box-shadow: 0 12px 34px rgba(0, 0, 0, 0.34), 0 2px 8px rgba(0, 0, 0, 0.22);
    transition: border-radius 0.12s ease;
  }
  #strip {
    flex: 0 0 auto;
    display: flex;
    align-items: flex-end;
    height: 34px;
    padding: 0 6px;
  }
  #tab {
    display: flex;
    align-items: center;
    height: 28px;
    width: 100%;
    max-width: 184px;
    padding: 0 12px;
    border-radius: 8px 8px 0 0;
    background: var(--tab);
    color: var(--fg);
    font-size: 12.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  #page {
    flex: 1 1 auto;
    background: var(--page);
    padding: 14px 16px;
  }
  #page span {
    display: block;
    height: 8px;
    margin-bottom: 9px;
    border-radius: 4px;
    background: var(--line);
  }
  #page span:nth-child(1) { width: 62%; }
  #page span:nth-child(2) { width: 88%; }
  #page span:nth-child(3) { width: 74%; }
  #page span:nth-child(4) { width: 46%; }

  /* Collapsed to the tab alone: it will drop into a strip, not become a window. */
  body.attach #card { background: transparent; box-shadow: none; }
  body.attach #strip { height: 100%; align-items: center; padding: 0; }
  body.attach #tab {
    height: 34px;
    max-width: 100%;
    border-radius: 9px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.32);
  }
  body.attach #page { display: none; }
</style>
</head>
<body>
  <div id="card">
    <div id="strip"><div id="tab">${safeTitle}</div></div>
    <div id="page"><span></span><span></span><span></span><span></span></div>
  </div>
</body>
</html>`;
}

export class DragGhost {
  private window: BrowserWindow | undefined;
  private mode: GhostMode = "window";
  private visible = false;
  private animation: NodeJS.Timeout | undefined;

  /** Builds the window up front so the tear-off itself never stutters. */
  prepare(title: string): void {
    this.destroy();

    const size = windowSize("window");
    this.window = new BrowserWindow({
      width: size.width,
      height: size.height,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      alwaysOnTop: true,
      acceptFirstMouse: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });

    this.window.setIgnoreMouseEvents(true);
    this.window.setAlwaysOnTop(true, "pop-up-menu");
    void this.window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(ghostHtml(title))}`);
    this.mode = "window";
    this.visible = false;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** Fades the ghost in at the cursor. */
  reveal(point: Electron.Point, mode: GhostMode): void {
    if (!this.window || this.window.isDestroyed() || this.visible) {
      return;
    }

    this.stopAnimation();
    this.applyMode(mode);
    this.window.setBounds(this.boundsAt(point, mode));
    this.window.setOpacity(0);
    this.window.showInactive();
    this.visible = true;
    this.fadeTo(1, 110);
  }

  moveTo(point: Electron.Point): void {
    if (!this.window || this.window.isDestroyed() || !this.visible || this.animation) {
      return;
    }

    this.window.setPosition(Math.round(point.x - GRAB.x), Math.round(point.y - GRAB.y));
  }

  setMode(mode: GhostMode, point: Electron.Point): void {
    if (!this.window || this.window.isDestroyed() || this.mode === mode) {
      return;
    }

    this.applyMode(mode);
    if (this.visible) {
      this.window.setBounds(this.boundsAt(point, mode));
    }
  }

  /** Grows the ghost into the window it is becoming, then fades it out. */
  async expandInto(bounds: Electron.Rectangle): Promise<void> {
    if (!this.window || this.window.isDestroyed() || !this.visible) {
      return;
    }

    await this.animateBounds(bounds, 150);
    await this.fadeTo(0, 90);
  }

  /** Fades the ghost out for a drop that is not a detach. */
  async dismiss(): Promise<void> {
    if (!this.window || this.window.isDestroyed() || !this.visible) {
      return;
    }

    await this.fadeTo(0, 90);
  }

  /** Hides the ghost without tearing it down, for a tab dragged back in. */
  conceal(): void {
    if (!this.window || this.window.isDestroyed() || !this.visible) {
      return;
    }

    this.stopAnimation();
    this.window.hide();
    this.visible = false;
  }

  destroy(): void {
    this.stopAnimation();
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy();
    }
    this.window = undefined;
    this.visible = false;
  }

  private applyMode(mode: GhostMode): void {
    this.mode = mode;
    void this.window?.webContents.executeJavaScript(
      `document.body.classList.toggle("attach", ${mode === "attach"});`,
      true,
    );
  }

  private boundsAt(point: Electron.Point, mode: GhostMode): Electron.Rectangle {
    const size = windowSize(mode);
    return {
      x: Math.round(point.x - GRAB.x),
      y: Math.round(point.y - GRAB.y),
      width: size.width,
      height: size.height,
    };
  }

  private stopAnimation(): void {
    if (this.animation) {
      clearInterval(this.animation);
      this.animation = undefined;
    }
  }

  private animateBounds(to: Electron.Rectangle, duration: number): Promise<void> {
    const target = this.window;
    if (!target || target.isDestroyed()) {
      return Promise.resolve();
    }

    this.stopAnimation();
    const from = target.getBounds();
    const started = Date.now();

    return new Promise((resolve) => {
      this.animation = setInterval(() => {
        if (!this.window || this.window.isDestroyed()) {
          this.stopAnimation();
          resolve();
          return;
        }

        const progress = Math.min(1, (Date.now() - started) / duration);
        const eased = easeOutCubic(progress);
        this.window.setBounds({
          x: Math.round(from.x + (to.x - from.x) * eased),
          y: Math.round(from.y + (to.y - from.y) * eased),
          width: Math.round(from.width + (to.width - from.width) * eased),
          height: Math.round(from.height + (to.height - from.height) * eased),
        });

        if (progress >= 1) {
          this.stopAnimation();
          resolve();
        }
      }, FRAME_MS);
    });
  }

  private fadeTo(opacity: number, duration: number): Promise<void> {
    const target = this.window;
    if (!target || target.isDestroyed()) {
      return Promise.resolve();
    }

    const from = target.getOpacity();
    const started = Date.now();

    return new Promise((resolve) => {
      const timer = setInterval(() => {
        if (!this.window || this.window.isDestroyed()) {
          clearInterval(timer);
          resolve();
          return;
        }

        const progress = Math.min(1, (Date.now() - started) / duration);
        this.window.setOpacity(from + (opacity - from) * progress);

        if (progress >= 1) {
          clearInterval(timer);
          resolve();
        }
      }, FRAME_MS);
    });
  }
}
