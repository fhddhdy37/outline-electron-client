import type { EditableElement } from "./command-detector";

export interface CapturedEditorTarget {
  editable: EditableElement;
  kind: "text-control" | "contenteditable";
  selectionStart?: number;
  selectionEnd?: number;
  range?: Range;
}

export class EditorBridge {
  capture(editable: EditableElement): CapturedEditorTarget {
    if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
      return {
        editable,
        kind: "text-control",
        selectionStart: editable.selectionStart ?? editable.value.length,
        selectionEnd: editable.selectionEnd ?? editable.value.length,
      };
    }

    const selection = document.getSelection();
    const range =
      selection && selection.rangeCount > 0 && editable.contains(selection.getRangeAt(0).endContainer)
        ? selection.getRangeAt(0).cloneRange()
        : undefined;

    return {
      editable,
      kind: "contenteditable",
      range,
    };
  }

  insertText(target: CapturedEditorTarget | undefined, text: string): boolean {
    if (!target) {
      return false;
    }

    if (target.kind === "text-control") {
      return this.insertIntoTextControl(target, text);
    }

    return this.insertIntoContentEditable(target, text);
  }

  private insertIntoTextControl(target: CapturedEditorTarget, text: string): boolean {
    const editable = target.editable;
    if (!(editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement)) {
      return false;
    }

    const start = target.selectionStart ?? editable.value.length;
    const end = target.selectionEnd ?? start;

    editable.focus({ preventScroll: true });
    editable.setRangeText(text, start, end, "end");
    editable.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));

    return true;
  }

  private insertIntoContentEditable(target: CapturedEditorTarget, text: string): boolean {
    const editable = target.editable;
    if (!(editable instanceof HTMLElement)) {
      return false;
    }

    editable.focus({ preventScroll: true });

    const selection = document.getSelection();
    if (selection && target.range) {
      selection.removeAllRanges();
      selection.addRange(target.range);
    }

    if (document.queryCommandSupported("insertText")) {
      const inserted = document.execCommand("insertText", false, text);
      if (inserted) {
        editable.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
        return true;
      }
    }

    if (!selection || selection.rangeCount === 0) {
      editable.append(document.createTextNode(text));
      editable.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      return true;
    }

    const range = selection.getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode(text));
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    editable.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));

    return true;
  }

  /**
   * Removes the just-typed slash command (e.g. `/회의`) so the inline recording
   * block can take its place, mirroring Notion's slash-command consumption.
   */
  consumeTrigger(target: CapturedEditorTarget | undefined, length: number): boolean {
    if (!target || length <= 0) {
      return false;
    }

    if (target.kind === "text-control") {
      const editable = target.editable;
      if (!(editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement)) {
        return false;
      }
      const end = target.selectionEnd ?? editable.value.length;
      const start = Math.max(0, end - length);
      editable.focus({ preventScroll: true });
      editable.setRangeText("", start, end, "end");
      editable.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }),
      );
      return true;
    }

    const editable = target.editable;
    if (!(editable instanceof HTMLElement)) {
      return false;
    }

    const selection = document.getSelection();
    if (!selection) {
      return false;
    }

    editable.focus({ preventScroll: true });
    if (target.range) {
      selection.removeAllRanges();
      selection.addRange(target.range.cloneRange());
    }

    for (let i = 0; i < length; i += 1) {
      selection.modify("extend", "backward", "character");
    }

    if (selection.isCollapsed) {
      return false;
    }

    const deleted = document.execCommand("delete");
    editable.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    return deleted;
  }

  /**
   * Inserts text at the caret's current position (not the captured range),
   * used right after {@link consumeTrigger} to drop the recording block in place.
   */
  insertAtSelection(target: CapturedEditorTarget | undefined, text: string): boolean {
    const root = this.editorRoot(target);
    if (!root) {
      return this.insertText(target, text);
    }

    root.focus({ preventScroll: true });
    if (document.queryCommandSupported("insertText") && document.execCommand("insertText", false, text)) {
      root.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      return true;
    }

    return this.insertText(target, text);
  }

  /**
   * Streams a transcript segment into the document just before the recording
   * marker, keeping the marker as a stable anchor and restoring the user's
   * caret afterwards so live note-taking is minimally disrupted.
   */
  streamInsertBeforeMarker(
    target: CapturedEditorTarget | undefined,
    marker: string,
    text: string,
  ): boolean {
    const root = this.editorRoot(target);
    if (!root) {
      return false;
    }

    const found = this.findMarkerNode(root, marker);
    if (!found) {
      return false;
    }

    const selection = document.getSelection();
    if (!selection) {
      return false;
    }

    const savedRange =
      selection.rangeCount > 0 && root.contains(selection.getRangeAt(0).endContainer)
        ? selection.getRangeAt(0).cloneRange()
        : undefined;

    const insertRange = document.createRange();
    insertRange.setStart(found.node, found.index);
    insertRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(insertRange);
    root.focus({ preventScroll: true });

    let inserted = false;
    if (document.queryCommandSupported("insertText")) {
      inserted = document.execCommand("insertText", false, text);
    }
    if (!inserted) {
      insertRange.insertNode(document.createTextNode(text));
      inserted = true;
    }

    root.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));

    if (
      savedRange &&
      savedRange.endContainer.isConnected &&
      root.contains(savedRange.endContainer)
    ) {
      try {
        selection.removeAllRanges();
        selection.addRange(savedRange);
      } catch {
        /* stale range after re-render — leave caret at insertion point */
      }
    }

    return inserted;
  }

  /** Deletes the recording marker once streaming finishes. */
  removeMarker(target: CapturedEditorTarget | undefined, marker: string): boolean {
    const root = this.editorRoot(target);
    if (!root) {
      return false;
    }

    const found = this.findMarkerNode(root, marker);
    if (!found) {
      return false;
    }

    const selection = document.getSelection();
    if (!selection) {
      return false;
    }

    const range = document.createRange();
    range.setStart(found.node, found.index);
    range.setEnd(found.node, found.index + marker.length);
    selection.removeAllRanges();
    selection.addRange(range);
    root.focus({ preventScroll: true });

    const deleted = document.execCommand("delete");
    root.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    return deleted;
  }

  /** Viewport rect of the marker, used to anchor the floating widget inline. */
  getMarkerRect(target: CapturedEditorTarget | undefined, marker: string): DOMRect | null {
    const root = this.editorRoot(target);
    if (!root) {
      return null;
    }

    const found = this.findMarkerNode(root, marker);
    if (!found) {
      return null;
    }

    const range = document.createRange();
    range.setStart(found.node, found.index);
    range.setEnd(found.node, Math.min(found.index + marker.length, found.node.length));
    const rect = range.getBoundingClientRect();
    return rect.width === 0 && rect.height === 0 ? null : rect;
  }

  private editorRoot(target: CapturedEditorTarget | undefined): HTMLElement | null {
    const editable = target?.editable;
    if (
      editable instanceof HTMLElement &&
      editable.isContentEditable &&
      editable.isConnected
    ) {
      return editable;
    }
    return null;
  }

  private findMarkerNode(root: HTMLElement, marker: string): { node: Text; index: number } | null {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    while (current) {
      const value = current.nodeValue ?? "";
      const index = value.indexOf(marker);
      if (index >= 0) {
        return { node: current as Text, index };
      }
      current = walker.nextNode();
    }
    return null;
  }
}

