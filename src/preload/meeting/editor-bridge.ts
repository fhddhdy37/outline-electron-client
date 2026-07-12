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
}

