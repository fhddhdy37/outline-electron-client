/**
 * Keyboard-binding vocabulary shared by the main process (which matches bindings
 * against `Electron.Input`) and the shortcut-settings window (which turns key
 * presses back into bindings and renders them).
 *
 * A binding is a `+`-joined string of modifier tokens followed by one key, e.g.
 * `Mod+Shift+L`. `Mod` means Command on macOS and Control everywhere else;
 * `Ctrl` and `Meta` are literal on every platform.
 */

export interface ParsedBinding {
  /** Command on macOS, Control elsewhere. */
  mod: boolean;
  /** Literal Control, on every platform. */
  ctrl: boolean;
  /** Literal Command / Super, on every platform. */
  meta: boolean;
  alt: boolean;
  shift: boolean;
  /** Canonical (upper-case) key name, e.g. `T`, `TAB`, `LEFT`, `,`. */
  key: string;
}

export interface KeyState {
  key: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

export interface ResolvedModifiers {
  control: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

const MODIFIER_TOKENS: Record<string, keyof Omit<ParsedBinding, "key">> = {
  mod: "mod",
  cmdorctrl: "mod",
  commandorcontrol: "mod",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  super: "meta",
};

const KEY_ALIASES: Record<string, string> = {
  ESC: "ESCAPE",
  DEL: "DELETE",
  RETURN: "ENTER",
  " ": "SPACE",
  SPACEBAR: "SPACE",
  PLUS: "+",
};

const KEY_LABELS: Record<string, string> = {
  TAB: "Tab",
  ESCAPE: "Esc",
  ENTER: "Enter",
  SPACE: "Space",
  BACKSPACE: "Backspace",
  DELETE: "Delete",
  LEFT: "←",
  RIGHT: "→",
  UP: "↑",
  DOWN: "↓",
  HOME: "Home",
  END: "End",
  PAGEUP: "PageUp",
  PAGEDOWN: "PageDown",
};

/** Keys that are usable on their own, without any modifier. */
const MODIFIER_FREE_KEYS = /^(F\d{1,2})$/;

export function canonicalKey(raw: string): string {
  if (!raw) {
    return "";
  }

  let key = raw;
  if (key.startsWith("Arrow")) {
    key = key.slice("Arrow".length);
  }

  key = key.toUpperCase();
  return KEY_ALIASES[key] ?? key;
}

export function parseBinding(value: string): ParsedBinding | undefined {
  if (!value) {
    return undefined;
  }

  const parts = value.split("+");
  const parsed: ParsedBinding = {
    mod: false,
    ctrl: false,
    meta: false,
    alt: false,
    shift: false,
    key: "",
  };

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const modifier = MODIFIER_TOKENS[part.toLowerCase()];
    // Only a non-final token can be a modifier, so `Mod+Shift` binds the Shift key.
    if (modifier && index < parts.length - 1) {
      parsed[modifier] = true;
      continue;
    }

    // An empty final token is the `+` key itself (e.g. `Ctrl++`).
    parsed.key = canonicalKey(part === "" ? "+" : part);
  }

  return parsed.key ? parsed : undefined;
}

export function resolveModifiers(binding: ParsedBinding, platform: string): ResolvedModifiers {
  const isMac = platform === "darwin";
  return {
    control: binding.ctrl || (binding.mod && !isMac),
    meta: binding.meta || (binding.mod && isMac),
    alt: binding.alt,
    shift: binding.shift,
  };
}

/**
 * Platform-resolved identity of a binding. Two bindings that fire on the same
 * physical key press share a canonical form, so this is what conflict checks
 * and input matching compare.
 */
export function canonicalBinding(value: string, platform: string): string | undefined {
  const parsed = parseBinding(value);
  if (!parsed) {
    return undefined;
  }

  const modifiers = resolveModifiers(parsed, platform);
  return [
    modifiers.control ? "C" : "",
    modifiers.meta ? "M" : "",
    modifiers.alt ? "A" : "",
    modifiers.shift ? "S" : "",
    ":",
    parsed.key,
  ].join("");
}

export function keyStateBinding(state: KeyState, platform: string): string | undefined {
  const key = canonicalKey(state.key);
  if (!key || MODIFIER_TOKENS[key.toLowerCase()]) {
    return undefined;
  }

  const isMac = platform === "darwin";
  const tokens: string[] = [];

  if (isMac ? state.meta : state.ctrl) {
    tokens.push("Mod");
  }
  if (isMac ? state.ctrl : state.meta) {
    tokens.push(isMac ? "Ctrl" : "Meta");
  }
  if (state.alt) {
    tokens.push("Alt");
  }
  if (state.shift) {
    tokens.push("Shift");
  }

  if (tokens.length === 0 && !MODIFIER_FREE_KEYS.test(key)) {
    return undefined;
  }

  tokens.push(keyToken(key));
  return tokens.join("+");
}

function keyToken(key: string): string {
  return key.length === 1 ? key : key.charAt(0) + key.slice(1).toLowerCase();
}

export function formatBinding(value: string | null, platform: string): string {
  if (!value) {
    return "없음";
  }

  const parsed = parseBinding(value);
  if (!parsed) {
    return "없음";
  }

  const isMac = platform === "darwin";
  const parts: string[] = [];

  if (parsed.ctrl || (parsed.mod && !isMac)) {
    parts.push(isMac ? "⌃" : "Ctrl");
  }
  if (parsed.alt) {
    parts.push(isMac ? "⌥" : "Alt");
  }
  if (parsed.shift) {
    parts.push(isMac ? "⇧" : "Shift");
  }
  if (parsed.meta || (parsed.mod && isMac)) {
    parts.push(isMac ? "⌘" : "Meta");
  }

  parts.push(KEY_LABELS[parsed.key] ?? keyToken(parsed.key));
  return isMac ? parts.join("") : parts.join(" + ");
}
