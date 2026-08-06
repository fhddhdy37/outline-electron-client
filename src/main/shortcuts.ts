import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { ShortcutView, ShortcutsSnapshot } from "../shared/ipc";
import {
  canonicalBinding,
  canonicalKey,
  formatBinding,
  parseBinding,
  resolveModifiers,
} from "../shared/shortcuts";

export type ShortcutActionId =
  | "tab.new"
  | "tab.close"
  | "tab.next"
  | "tab.prev"
  | "window.new"
  | "page.reload"
  | "page.back"
  | "page.forward"
  | "login.link"
  | "shortcuts.open";

interface ActionDefinition {
  id: ShortcutActionId;
  label: string;
  category: string;
  accelerator: string;
  /** Overrides `accelerator` on macOS when the platform convention differs. */
  darwinAccelerator?: string;
}

const ACTIONS: ActionDefinition[] = [
  { id: "tab.new", label: "새 탭", category: "탭", accelerator: "Mod+T" },
  { id: "tab.close", label: "탭 닫기", category: "탭", accelerator: "Mod+W" },
  { id: "tab.next", label: "다음 탭", category: "탭", accelerator: "Ctrl+Tab" },
  { id: "tab.prev", label: "이전 탭", category: "탭", accelerator: "Ctrl+Shift+Tab" },
  { id: "window.new", label: "새 창", category: "창", accelerator: "Mod+N" },
  { id: "page.reload", label: "새로 고침", category: "페이지", accelerator: "Mod+R" },
  {
    id: "page.back",
    label: "뒤로 가기",
    category: "페이지",
    accelerator: "Alt+Left",
    darwinAccelerator: "Mod+[",
  },
  {
    id: "page.forward",
    label: "앞으로 가기",
    category: "페이지",
    accelerator: "Alt+Right",
    darwinAccelerator: "Mod+]",
  },
  { id: "login.link", label: "클립보드의 로그인 링크 열기", category: "기타", accelerator: "Mod+Shift+L" },
  { id: "shortcuts.open", label: "단축키 설정 열기", category: "기타", accelerator: "Mod+," },
];

const FILE_NAME = "keybindings.json";

/**
 * Action ⇄ key-binding table. Defaults live in `ACTIONS`; user overrides are
 * persisted as a flat `{ actionId: binding | null }` map in userData, where
 * `null` means the user deliberately unbound the action.
 */
export class ShortcutRegistry {
  private overrides = new Map<ShortcutActionId, string | null>();
  private readonly listeners = new Set<() => void>();
  private readonly platform: NodeJS.Platform;

  constructor(platform: NodeJS.Platform = process.platform) {
    this.platform = platform;
    this.load();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The action bound to this key press, if any. */
  resolve(input: Electron.Input): ShortcutActionId | undefined {
    if (input.type !== "keyDown") {
      return undefined;
    }

    for (const action of ACTIONS) {
      const binding = this.acceleratorOf(action.id);
      if (binding && this.matches(binding, input)) {
        return action.id;
      }
    }

    return undefined;
  }

  set(id: string, accelerator: string | null): void {
    if (!ACTIONS.some((action) => action.id === id)) {
      return;
    }

    // A binding equal to the default is stored as "no override" so the entry
    // keeps following the default if it ever changes.
    if (accelerator !== null && accelerator === this.defaultAcceleratorOf(id as ShortcutActionId)) {
      this.overrides.delete(id as ShortcutActionId);
    } else {
      this.overrides.set(id as ShortcutActionId, accelerator);
    }

    this.persist();
    this.emit();
  }

  reset(id: string): void {
    if (this.overrides.delete(id as ShortcutActionId)) {
      this.persist();
      this.emit();
    }
  }

  resetAll(): void {
    if (this.overrides.size === 0) {
      return;
    }

    this.overrides.clear();
    this.persist();
    this.emit();
  }

  snapshot(): ShortcutsSnapshot {
    const canonicalCounts = new Map<string, ShortcutActionId[]>();
    for (const action of ACTIONS) {
      const binding = this.acceleratorOf(action.id);
      const canonical = binding ? canonicalBinding(binding, this.platform) : undefined;
      if (!canonical) {
        continue;
      }
      const bucket = canonicalCounts.get(canonical) ?? [];
      bucket.push(action.id);
      canonicalCounts.set(canonical, bucket);
    }

    const actions: ShortcutView[] = ACTIONS.map((action) => {
      const accelerator = this.acceleratorOf(action.id);
      const canonical = accelerator ? canonicalBinding(accelerator, this.platform) : undefined;
      const shared = canonical ? (canonicalCounts.get(canonical) ?? []) : [];

      return {
        id: action.id,
        label: action.label,
        category: action.category,
        accelerator,
        defaultAccelerator: this.defaultAcceleratorOf(action.id),
        display: formatBinding(accelerator, this.platform),
        conflicts: shared.filter((other) => other !== action.id),
      };
    });

    return { platform: this.platform, actions };
  }

  private acceleratorOf(id: ShortcutActionId): string | null {
    if (this.overrides.has(id)) {
      return this.overrides.get(id) ?? null;
    }

    return this.defaultAcceleratorOf(id);
  }

  private defaultAcceleratorOf(id: ShortcutActionId): string | null {
    const action = ACTIONS.find((candidate) => candidate.id === id);
    if (!action) {
      return null;
    }

    return (this.platform === "darwin" ? action.darwinAccelerator : undefined) ?? action.accelerator;
  }

  private matches(binding: string, input: Electron.Input): boolean {
    const parsed = parseBinding(binding);
    if (!parsed) {
      return false;
    }

    const modifiers = resolveModifiers(parsed, this.platform);
    if (
      input.control !== modifiers.control ||
      input.meta !== modifiers.meta ||
      input.alt !== modifiers.alt ||
      input.shift !== modifiers.shift
    ) {
      return false;
    }

    return canonicalKey(input.key) === parsed.key;
  }

  private get filePath(): string {
    return path.join(app.getPath("userData"), FILE_NAME);
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [id, value] of Object.entries(parsed)) {
        if (!ACTIONS.some((action) => action.id === id)) {
          continue;
        }
        if (value === null || typeof value === "string") {
          this.overrides.set(id as ShortcutActionId, value);
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        console.error("Failed to read keybindings", error);
      }
    }
  }

  private persist(): void {
    const payload: Record<string, string | null> = {};
    for (const [id, value] of this.overrides) {
      payload[id] = value;
    }

    try {
      fs.writeFileSync(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    } catch (error) {
      console.error("Failed to write keybindings", error);
    }
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
