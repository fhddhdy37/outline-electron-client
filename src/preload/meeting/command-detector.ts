export type EditableElement = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

export interface SlashCommandContext {
  command: string;
  editable: EditableElement;
  textBeforeCaret: string;
  detectedAt: number;
}

export interface SlashCommandDetectorOptions {
  command: string;
  onCommand(context: SlashCommandContext): void;
}

const INPUT_TEXT_TYPES = new Set([
  "email",
  "password",
  "search",
  "tel",
  "text",
  "url",
  "",
]);

export class SlashCommandDetector {
  private readonly command: string;
  private readonly onCommand: (context: SlashCommandContext) => void;
  private lastSignature = "";

  constructor(options: SlashCommandDetectorOptions) {
    this.command = options.command;
    this.onCommand = options.onCommand;
  }

  start(): void {
    document.addEventListener("input", this.handleEvent, true);
    document.addEventListener("keyup", this.handleEvent, true);
    document.addEventListener("compositionend", this.handleEvent, true);
  }

  stop(): void {
    document.removeEventListener("input", this.handleEvent, true);
    document.removeEventListener("keyup", this.handleEvent, true);
    document.removeEventListener("compositionend", this.handleEvent, true);
  }

  private handleEvent = (event: Event): void => {
    const editable = findEditableElement(event.target);
    if (!editable) {
      return;
    }

    const textBeforeCaret = getTextBeforeCaret(editable);
    if (!textBeforeCaret) {
      this.lastSignature = "";
      return;
    }

    const currentLine = textBeforeCaret.split(/\r?\n/).at(-1) ?? "";
    if (!currentLine.trimEnd().endsWith(this.command)) {
      this.lastSignature = "";
      return;
    }

    const signature = `${Date.now() >> 8}:${currentLine}:${textBeforeCaret.length}`;
    if (signature === this.lastSignature) {
      return;
    }

    this.lastSignature = signature;
    this.onCommand({
      command: this.command,
      editable,
      textBeforeCaret,
      detectedAt: Date.now(),
    });
  };
}

export function findEditableElement(target: EventTarget | null): EditableElement | null {
  if (!target) {
    return null;
  }

  const node = target instanceof Node ? target : null;
  const element = node instanceof Element ? node : node?.parentElement ?? null;
  if (!element) {
    return null;
  }

  const candidate = element.closest("textarea, input, [contenteditable='true']");
  if (!candidate) {
    return null;
  }

  if (candidate instanceof HTMLTextAreaElement) {
    return candidate;
  }

  if (candidate instanceof HTMLInputElement && INPUT_TEXT_TYPES.has(candidate.type)) {
    return candidate;
  }

  if (candidate instanceof HTMLElement && candidate.isContentEditable) {
    return candidate;
  }

  return null;
}

export function getTextBeforeCaret(editable: EditableElement): string {
  if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
    const selectionStart = editable.selectionStart ?? editable.value.length;
    return editable.value.slice(0, selectionStart);
  }

  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return editable.textContent ?? "";
  }

  const range = selection.getRangeAt(0);
  if (!editable.contains(range.endContainer)) {
    return editable.textContent ?? "";
  }

  const beforeCaret = range.cloneRange();
  beforeCaret.selectNodeContents(editable);
  beforeCaret.setEnd(range.endContainer, range.endOffset);

  return beforeCaret.toString();
}

