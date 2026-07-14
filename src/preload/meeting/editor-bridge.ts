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

  /**
   * Maintains the in-progress ("still speaking") transcript run between an
   * invisible {@link sentinel} and the recording marker. Every partial rewrites
   * the run in place, so the document shows live text without committing a
   * hyphen bullet; the final call passes a committed `- …\n` replacement (with
   * no sentinel) to close the run. Pass an empty replacement to clear it.
   *
   * When {@link commit} is true the text is inserted via execCommand so the
   * editor turns "\n" into a real line break; partials keep using a raw text
   * node so the invisible sentinel is preserved for the next in-place rewrite.
   */
  streamLiveBeforeMarker(
    target: CapturedEditorTarget | undefined,
    marker: string,
    sentinel: string,
    replacement: string,
    commit: boolean,
  ): boolean {
    const root = this.editorRoot(target);
    if (!root) {
      return false;
    }

    const markerFound = this.findMarkerNode(root, marker);
    if (!markerFound) {
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

    // Pin the viewport before mutating: ProseMirror scrolls every change into
    // view, which would yank the reader back to the transcript. Capturing here
    // and restoring after lets scrolling stay under the user's control.
    const restoreScroll = this.captureScroll(root, markerFound, marker);

    // The previous live run spans [sentinel, marker). Without a sentinel yet,
    // there is nothing to delete and we insert right before the marker.
    const sentinelFound = this.findMarkerNode(root, sentinel);
    const range = document.createRange();
    if (sentinelFound) {
      range.setStart(sentinelFound.node, sentinelFound.index);
    } else {
      range.setStart(markerFound.node, markerFound.index);
    }
    range.setEnd(markerFound.node, markerFound.index);
    range.deleteContents();

    if (replacement) {
      if (commit) {
        // Commit via execCommand so "\n" becomes a real line break; a raw text
        // node's "\n" would be collapsed to a space by HTML whitespace rules.
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        root.focus({ preventScroll: true });

        let inserted = false;
        if (document.queryCommandSupported("insertText")) {
          inserted = document.execCommand("insertText", false, replacement);
        }
        if (!inserted) {
          range.insertNode(document.createTextNode(replacement));
        }
      } else {
        // Live partials keep the invisible sentinel intact for the next
        // in-place rewrite, so insert the raw text node directly.
        range.insertNode(document.createTextNode(replacement));
      }
    }
    root.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: replacement }),
    );

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

    // Restore across every stage the editor might scroll in — synchronously,
    // after ProseMirror's MutationObserver microtask, and before the next
    // paint — so the correction lands without a visible jump.
    restoreScroll();
    queueMicrotask(restoreScroll);
    requestAnimationFrame(restoreScroll);

    return true;
  }

  /**
   * Snapshots the editor's scroll position before a mutation and returns a
   * function that puts it back. When the insertion anchor sits above the
   * viewport, the height the mutation adds is compensated so the reader's
   * content stays visually fixed rather than shifting by the inserted lines.
   */
  private captureScroll(
    root: HTMLElement,
    markerFound: { node: Text; index: number },
    marker: string,
  ): () => void {
    const scroller = this.findScrollContainer(root);
    if (!scroller) {
      return () => undefined;
    }

    const prevTop = scroller.scrollTop;
    const prevLeft = scroller.scrollLeft;
    const prevHeight = scroller.scrollHeight;

    let anchorAbove = false;
    const markerRange = document.createRange();
    markerRange.setStart(markerFound.node, markerFound.index);
    markerRange.setEnd(
      markerFound.node,
      Math.min(markerFound.index + marker.length, markerFound.node.length),
    );
    const markerRect = markerRange.getBoundingClientRect();
    if (markerRect.height > 0 || markerRect.width > 0) {
      anchorAbove = markerRect.bottom <= scroller.getBoundingClientRect().top;
    }

    return () => {
      const targetTop = anchorAbove
        ? prevTop + (scroller.scrollHeight - prevHeight)
        : prevTop;
      if (Math.abs(scroller.scrollTop - targetTop) > 0.5) {
        scroller.scrollTop = targetTop;
      }
      if (Math.abs(scroller.scrollLeft - prevLeft) > 0.5) {
        scroller.scrollLeft = prevLeft;
      }
    };
  }

  /** Nearest scrollable ancestor of the editor, falling back to the page. */
  private findScrollContainer(el: HTMLElement): HTMLElement | null {
    let node: HTMLElement | null = el;
    while (node && node !== document.body && node !== document.documentElement) {
      const style = window.getComputedStyle(node);
      if (
        (style.overflowY === "auto" || style.overflowY === "scroll" || style.overflowY === "overlay") &&
        node.scrollHeight > node.clientHeight
      ) {
        return node;
      }
      node = node.parentElement;
    }
    return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
  }

  /**
   * Replaces the first occurrence of {@link oldText} with {@link newText}.
   * Best-effort (used to relabel a committed transcript line after diarization);
   * only matches when the run sits within a single text node.
   */
  replaceFirstOccurrence(
    target: CapturedEditorTarget | undefined,
    oldText: string,
    newText: string,
  ): boolean {
    const root = this.editorRoot(target);
    if (!root || !oldText) {
      return false;
    }

    const found = this.findMarkerNode(root, oldText);
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

    const range = document.createRange();
    range.setStart(found.node, found.index);
    range.setEnd(found.node, found.index + oldText.length);
    selection.removeAllRanges();
    selection.addRange(range);
    root.focus({ preventScroll: true });

    let replaced = false;
    if (document.queryCommandSupported("insertText")) {
      replaced = document.execCommand("insertText", false, newText);
    }
    if (!replaced) {
      range.deleteContents();
      range.insertNode(document.createTextNode(newText));
      replaced = true;
    }
    root.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: newText }));

    if (
      savedRange &&
      savedRange.endContainer.isConnected &&
      root.contains(savedRange.endContainer)
    ) {
      try {
        selection.removeAllRanges();
        selection.addRange(savedRange);
      } catch {
        /* stale range after re-render — leave caret at replacement */
      }
    }

    return replaced;
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

