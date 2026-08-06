/**
 * The tab-bar page rendered in the chrome WebContentsView. Loaded via a
 * data: URL, so it must be fully self-contained (inline CSS + JS, no external
 * resources). It reads/writes tab state through `window.tabsApi` exposed by
 * preload/chrome.ts.
 *
 * Dragging is handled here rather than with HTML5 drag-and-drop: the view is
 * only 40px tall, and a native drag would stop producing events the moment the
 * pointer leaves it. Plain mouse events keep flowing to this view for the whole
 * gesture (the press captures the pointer), which is what makes "drag a tab out
 * of the window" detectable at all — the drop position itself is read from the
 * real cursor position in the main process.
 */
export const CHROME_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  :root {
    color-scheme: light dark;
    --bar-bg: #e8eaed;
    --tab-bg: transparent;
    --tab-active-bg: #ffffff;
    --tab-fg: #3c4043;
    --tab-active-fg: #1a1a1a;
    --tab-border: rgba(0, 0, 0, 0.08);
    --hover-bg: rgba(0, 0, 0, 0.06);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bar-bg: #202124;
      --tab-active-bg: #35363a;
      --tab-fg: #bdc1c6;
      --tab-active-fg: #ffffff;
      --tab-border: rgba(255, 255, 255, 0.08);
      --hover-bg: rgba(255, 255, 255, 0.08);
    }
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    height: 100%;
    overflow: hidden;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: var(--bar-bg);
    user-select: none;
  }
  body.dragging { cursor: grabbing; }
  #bar {
    display: flex;
    align-items: flex-end;
    height: 40px;
    padding: 0 6px;
    gap: 2px;
  }
  #tabs {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    flex: 1 1 auto;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
  }
  #tabs::-webkit-scrollbar { display: none; }
  body.dragging #tabs { overflow-x: hidden; }
  .tab {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    min-width: 96px;
    max-width: 220px;
    padding: 0 8px 0 12px;
    border-radius: 9px 9px 0 0;
    background: var(--tab-bg);
    color: var(--tab-fg);
    font-size: 12.5px;
    cursor: default;
    flex: 0 1 auto;
    transition: transform 0.12s ease;
  }
  .tab:hover { background: var(--hover-bg); }
  .tab.active {
    background: var(--tab-active-bg);
    color: var(--tab-active-fg);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.14);
  }
  .tab.dragged {
    transition: none;
    z-index: 3;
    background: var(--tab-active-bg);
    color: var(--tab-active-fg);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28);
  }
  /* Torn out of the strip: the tab collapses into the cursor and the
     remaining tabs close the gap, matching the floating drag preview. */
  .tab.torn {
    transition: min-width 0.16s ease, max-width 0.16s ease, padding 0.16s ease,
      opacity 0.13s ease, transform 0.16s ease;
    min-width: 0;
    max-width: 0;
    padding: 0;
    opacity: 0;
    transform: scale(0.7);
    box-shadow: none;
    pointer-events: none;
  }
  .tab .title {
    flex: 1 1 auto;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
  }
  .tab .spinner {
    width: 12px;
    height: 12px;
    flex: 0 0 auto;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    opacity: 0.6;
    animation: spin 0.7s linear infinite;
    pointer-events: none;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .tab .close {
    flex: 0 0 auto;
    width: 18px;
    height: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: inherit;
    font-size: 15px;
    line-height: 1;
    cursor: default;
    opacity: 0.7;
  }
  .tab .close:hover { background: var(--hover-bg); opacity: 1; }
  body.dragging .tab .close { visibility: hidden; }
  .bar-button {
    flex: 0 0 auto;
    height: 28px;
    min-width: 28px;
    margin-bottom: 2px;
    padding: 0;
    border: 0;
    border-radius: 14px;
    background: transparent;
    color: var(--tab-fg);
    font-size: 15px;
    line-height: 1;
    cursor: default;
  }
  #new-tab { font-size: 18px; }
  .bar-button:hover { background: var(--hover-bg); }
  body.dragging .bar-button { pointer-events: none; opacity: 0.4; }
</style>
</head>
<body>
  <div id="bar">
    <div id="tabs"></div>
    <button id="new-tab" class="bar-button" type="button" title="새 탭" aria-label="새 탭">+</button>
    <button id="shortcuts" class="bar-button" type="button" title="키보드 단축키" aria-label="키보드 단축키">⌨</button>
  </div>
  <script>
    (function () {
      var DRAG_THRESHOLD = 5;
      var TAB_GAP = 2;

      var tabsEl = document.getElementById("tabs");
      var state = { tabs: [] };
      var pendingState = null;
      var drag = null;
      var dropping = false;

      function render(next) {
        state = next && next.tabs ? next : { tabs: [] };
        tabsEl.replaceChildren();
        for (var i = 0; i < state.tabs.length; i++) {
          tabsEl.appendChild(makeTab(state.tabs[i]));
        }
      }

      function onState(next) {
        // A live drag paints its own ordering; apply the update once it ends.
        if (drag) {
          pendingState = next;
          return;
        }
        render(next);
      }

      function makeTab(tab) {
        var el = document.createElement("div");
        el.className = "tab" + (tab.active ? " active" : "");
        el.title = tab.title || "새 탭";
        el.addEventListener("mousedown", function (event) {
          startDrag(event, tab, el);
        });

        if (tab.loading) {
          var spinner = document.createElement("span");
          spinner.className = "spinner";
          el.appendChild(spinner);
        }

        var title = document.createElement("span");
        title.className = "title";
        title.textContent = tab.title || "새 탭";
        el.appendChild(title);

        var close = document.createElement("button");
        close.className = "close";
        close.type = "button";
        close.textContent = "×";
        close.setAttribute("aria-label", "탭 닫기");
        close.addEventListener("mousedown", function (event) {
          event.stopPropagation();
        });
        close.addEventListener("click", function (event) {
          event.stopPropagation();
          window.tabsApi.close(tab.id);
        });
        el.appendChild(close);

        return el;
      }

      function startDrag(event, tab, el) {
        if (event.button !== 0) {
          return;
        }

        event.preventDefault();
        if (!tab.active) {
          window.tabsApi.activate(tab.id);
        }

        var children = Array.prototype.slice.call(tabsEl.children);
        var index = children.indexOf(el);
        if (index === -1) {
          return;
        }

        var slots = children.map(function (child) {
          var rect = child.getBoundingClientRect();
          return { el: child, width: rect.width, center: rect.left + rect.width / 2 };
        });

        drag = {
          id: tab.id,
          el: el,
          index: index,
          slots: slots,
          startX: event.clientX,
          startY: event.clientY,
          lastX: event.clientX,
          targetIndex: index,
          torn: false,
          moved: false,
          began: false,
        };

        window.addEventListener("mousemove", onMouseMove, true);
        window.addEventListener("mouseup", onMouseUp, true);
        window.addEventListener("blur", cancelDrag);
      }

      /**
       * The main process owns "is this tab still in the strip?" — it samples the
       * real cursor, which the 40px-tall tab bar cannot see past.
       */
      function onDragZone(zone) {
        if (!drag || !drag.moved) {
          return;
        }

        var torn = Boolean(zone && zone.torn);
        if (torn === drag.torn) {
          return;
        }

        drag.torn = torn;
        drag.el.classList.toggle("torn", torn);
        document.body.classList.toggle("detaching", torn);

        if (torn) {
          // Close the gap: the tab now lives on the cursor, not in the strip.
          shiftSlots(drag.index);
        } else {
          drag.el.style.transform = "translateX(" + (drag.lastX - drag.startX) + "px)";
          updateTarget(drag.lastX);
        }
      }

      function onMouseMove(event) {
        if (!drag) {
          return;
        }

        // Recovery for a mouseup that never reached this view.
        if (event.buttons === 0) {
          onMouseUp();
          return;
        }

        var dx = event.clientX - drag.startX;
        var dy = event.clientY - drag.startY;
        drag.lastX = event.clientX;

        if (!drag.moved) {
          if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) {
            return;
          }
          drag.moved = true;
          drag.began = true;
          document.body.classList.add("dragging");
          drag.el.classList.add("dragged");
          window.tabsApi.dragBegin(drag.id);
        }

        // While torn out, the tab rides the cursor as a floating preview owned
        // by the main process; the strip has nothing left to move.
        if (drag.torn) {
          return;
        }

        drag.el.style.transform = "translateX(" + dx + "px)";
        updateTarget(event.clientX);
      }

      function updateTarget(clientX) {
        var pointer = drag.slots[drag.index].center + (clientX - drag.startX);
        var target = 0;
        for (var i = 0; i < drag.slots.length; i++) {
          if (i !== drag.index && pointer > drag.slots[i].center) {
            target++;
          }
        }

        drag.targetIndex = target;
        shiftSlots(target);
      }

      /** Opens a gap at the target index by sliding the tabs the drag passed over. */
      function shiftSlots(target) {
        var shift = drag.slots[drag.index].width + TAB_GAP;
        for (var i = 0; i < drag.slots.length; i++) {
          if (i === drag.index) {
            continue;
          }

          var offset = 0;
          if (i > drag.index && i <= target) {
            offset = -shift;
          } else if (i < drag.index && i >= target) {
            offset = shift;
          }

          drag.slots[i].el.style.transform = offset ? "translateX(" + offset + "px)" : "";
        }
      }

      function onMouseUp() {
        if (!drag) {
          return;
        }

        var finished = drag;
        var moved = finished.moved;
        var torn = finished.torn;
        var targetIndex = finished.targetIndex;
        dropping = true;
        cancelDrag();
        dropping = false;

        if (!moved) {
          return;
        }

        // The main process resolves the drop from the real cursor position:
        // this window's strip (reorder), another window's strip (move), or
        // nowhere (detach into a new window).
        window.tabsApi.drop({ id: finished.id, toIndex: targetIndex });

        if (!torn && targetIndex !== finished.index) {
          // Paint the new order right away; the main process confirms it next.
          var reordered = state.tabs.slice();
          var moving = reordered.splice(finished.index, 1)[0];
          reordered.splice(targetIndex, 0, moving);
          render({ tabs: reordered });
        }
      }

      function cancelDrag() {
        if (!drag) {
          return;
        }

        for (var i = 0; i < drag.slots.length; i++) {
          drag.slots[i].el.style.transform = "";
        }
        drag.el.classList.remove("dragged", "torn");
        document.body.classList.remove("dragging", "detaching");

        if (drag.began && !dropping) {
          window.tabsApi.dragCancel();
        }
        drag = null;

        window.removeEventListener("mousemove", onMouseMove, true);
        window.removeEventListener("mouseup", onMouseUp, true);
        window.removeEventListener("blur", cancelDrag);

        if (pendingState) {
          var next = pendingState;
          pendingState = null;
          render(next);
        }
      }

      document.getElementById("new-tab").addEventListener("click", function () {
        window.tabsApi.create();
      });

      document.getElementById("shortcuts").addEventListener("click", function () {
        window.tabsApi.openShortcuts();
      });

      window.tabsApi.onState(onState);
      window.tabsApi.onDragZone(onDragZone);
    })();
  </script>
</body>
</html>`;
