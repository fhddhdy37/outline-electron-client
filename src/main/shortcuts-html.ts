/**
 * The keyboard-shortcut panel (Ctrl/Cmd+,). It runs as a transparent overlay
 * WebContentsView stacked over the whole window, so it reads as a modal sheet
 * on top of the page rather than a second window. Loaded via a data: URL, so it
 * must stay self-contained, and it talks to the main process through
 * `window.shortcutsApi` exposed by preload/shortcuts.ts.
 */
export const SHORTCUTS_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>키보드 단축키</title>
<style>
  :root {
    color-scheme: light dark;
    --panel: #ffffff;
    --sheet: #f6f7f9;
    --fg: #1f2328;
    --muted: #6b7280;
    --border: rgba(0, 0, 0, 0.1);
    --chip-bg: #eef0f4;
    --accent: #2563eb;
    --danger: #d92d20;
    --hover: rgba(0, 0, 0, 0.05);
    --shadow: 0 24px 64px rgba(0, 0, 0, 0.28), 0 2px 10px rgba(0, 0, 0, 0.16);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --panel: #252629;
      --sheet: #1b1c1f;
      --fg: #e8eaed;
      --muted: #9aa0a6;
      --border: rgba(255, 255, 255, 0.12);
      --chip-bg: #34363b;
      --accent: #7aa2ff;
      --danger: #ff7b72;
      --hover: rgba(255, 255, 255, 0.07);
      --shadow: 0 24px 64px rgba(0, 0, 0, 0.6), 0 2px 10px rgba(0, 0, 0, 0.4);
    }
  }
  * { box-sizing: border-box; }
  html, body {
    height: 100%;
    margin: 0;
    background: transparent;
    overflow: hidden;
    font-family: system-ui, -apple-system, "Segoe UI", "Malgun Gothic", Roboto, sans-serif;
    font-size: 13px;
    color: var(--fg);
    user-select: none;
  }
  #backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.42);
    opacity: 0;
    transition: opacity 0.16s ease;
  }
  body.open #backdrop { opacity: 1; }
  #sheet {
    position: fixed;
    top: 50%;
    left: 50%;
    display: flex;
    flex-direction: column;
    width: min(560px, calc(100vw - 48px));
    max-height: min(680px, calc(100vh - 64px));
    background: var(--sheet);
    border: 1px solid var(--border);
    border-radius: 14px;
    box-shadow: var(--shadow);
    overflow: hidden;
    opacity: 0;
    transform: translate(-50%, -46%) scale(0.97);
    transition: opacity 0.17s ease, transform 0.17s cubic-bezier(0.2, 0.9, 0.3, 1);
  }
  body.open #sheet {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
  }
  header {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 16px 18px 12px;
    border-bottom: 1px solid var(--border);
  }
  header div { flex: 1 1 auto; }
  h1 { margin: 0 0 4px; font-size: 15px; }
  header p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
  #dismiss {
    flex: 0 0 auto;
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--muted);
    font-size: 17px;
    line-height: 1;
    cursor: pointer;
  }
  #dismiss:hover { background: var(--hover); color: var(--fg); }
  main { flex: 1 1 auto; overflow-y: auto; padding: 12px 16px 4px; }
  .group { margin-bottom: 14px; }
  .group h2 {
    margin: 0 0 6px 4px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--muted);
  }
  .group-body {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px 8px 14px;
    border-top: 1px solid var(--border);
  }
  .row:first-child { border-top: 0; }
  .row .label { flex: 1 1 auto; }
  .row .conflict { display: block; margin-top: 2px; font-size: 11px; color: var(--danger); }
  .chip {
    flex: 0 0 auto;
    min-width: 128px;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--chip-bg);
    color: var(--fg);
    font-family: inherit;
    font-size: 12px;
    text-align: center;
    cursor: pointer;
  }
  .chip:hover { border-color: var(--accent); }
  .chip.capturing {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.25);
    color: var(--accent);
  }
  .chip.empty { color: var(--muted); }
  .chip.conflicted { border-color: var(--danger); color: var(--danger); }
  .reset {
    flex: 0 0 auto;
    width: 26px;
    height: 26px;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--muted);
    font-size: 14px;
    cursor: pointer;
    visibility: hidden;
  }
  .reset:hover { background: var(--hover); color: var(--fg); }
  .row.modified .reset { visibility: visible; }
  .hints {
    margin: 0 16px 12px;
    padding: 12px 14px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.7;
  }
  .hints h2 { margin: 0 0 6px; font-size: 12px; color: var(--fg); }
  .hints ul { margin: 0; padding-left: 18px; }
  footer {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    border-top: 1px solid var(--border);
    background: var(--panel);
  }
  #status { flex: 1 1 auto; color: var(--muted); font-size: 12px; }
  footer button {
    padding: 7px 14px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--sheet);
    color: var(--fg);
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  footer button:hover { background: var(--hover); }
</style>
</head>
<body>
  <div id="backdrop"></div>
  <div id="sheet">
    <header>
      <div>
        <h1>키보드 단축키</h1>
        <p>단축키를 클릭한 뒤 원하는 키 조합을 누르세요. Backspace로 해제, Esc로 취소합니다.</p>
      </div>
      <button id="dismiss" type="button" aria-label="닫기">×</button>
    </header>
    <main id="list"></main>
    <section class="hints">
      <h2>마우스 동작</h2>
      <ul>
        <li>탭을 좌우로 끌면 순서를 바꿉니다.</li>
        <li>탭을 탭 바 밖으로 끌면 새 창으로 분리됩니다.</li>
        <li>탭을 다른 창의 탭 바 위에 놓으면 그 창으로 옮겨집니다.</li>
      </ul>
    </section>
    <footer>
      <span id="status"></span>
      <button id="reset-all" type="button">전체 기본값</button>
      <button id="close" type="button">닫기</button>
    </footer>
  </div>
  <script>
    (function () {
      var MODIFIER_KEYS = { Control: 1, Shift: 1, Alt: 1, Meta: 1, AltGraph: 1, CapsLock: 1 };
      var CLOSE_MS = 170;
      var api = window.shortcutsApi;
      var listEl = document.getElementById("list");
      var statusEl = document.getElementById("status");
      var platform = "win32";
      var actions = [];
      var capturing = null;
      var closing = false;

      function labelOf(id) {
        for (var i = 0; i < actions.length; i++) {
          if (actions[i].id === id) {
            return actions[i].label;
          }
        }
        return id;
      }

      function apply(snapshot) {
        if (!snapshot) {
          return;
        }
        platform = snapshot.platform || platform;
        actions = snapshot.actions || [];
        render();
      }

      function render() {
        listEl.replaceChildren();

        var order = [];
        var groups = {};
        for (var i = 0; i < actions.length; i++) {
          var action = actions[i];
          if (!groups[action.category]) {
            groups[action.category] = [];
            order.push(action.category);
          }
          groups[action.category].push(action);
        }

        for (var g = 0; g < order.length; g++) {
          listEl.appendChild(makeGroup(order[g], groups[order[g]]));
        }
      }

      function makeGroup(name, items) {
        var group = document.createElement("section");
        group.className = "group";

        var heading = document.createElement("h2");
        heading.textContent = name;
        group.appendChild(heading);

        var body = document.createElement("div");
        body.className = "group-body";
        for (var i = 0; i < items.length; i++) {
          body.appendChild(makeRow(items[i]));
        }
        group.appendChild(body);

        return group;
      }

      function makeRow(action) {
        var row = document.createElement("div");
        row.className = "row";
        if (action.accelerator !== action.defaultAccelerator) {
          row.className += " modified";
        }

        var label = document.createElement("span");
        label.className = "label";
        label.textContent = action.label;
        if (action.conflicts && action.conflicts.length) {
          var conflict = document.createElement("span");
          conflict.className = "conflict";
          conflict.textContent = "충돌: " + action.conflicts.map(labelOf).join(", ");
          label.appendChild(conflict);
        }
        row.appendChild(label);

        var chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip";
        if (capturing === action.id) {
          chip.className += " capturing";
          chip.textContent = "키를 누르세요…";
        } else {
          chip.textContent = action.display;
          if (!action.accelerator) {
            chip.className += " empty";
          }
          if (action.conflicts && action.conflicts.length) {
            chip.className += " conflicted";
          }
        }
        chip.addEventListener("click", function () {
          startCapture(capturing === action.id ? null : action.id);
        });
        row.appendChild(chip);

        var reset = document.createElement("button");
        reset.type = "button";
        reset.className = "reset";
        reset.title = "기본값으로";
        reset.textContent = "↺";
        reset.addEventListener("click", function () {
          capturing = null;
          api.reset(action.id).then(apply);
          setStatus(action.label + " 기본값으로 되돌렸습니다.");
        });
        row.appendChild(reset);

        return row;
      }

      function startCapture(id) {
        capturing = id;
        setStatus(id ? "새 단축키를 누르세요. (Backspace: 해제, Esc: 취소)" : "");
        render();
      }

      function setStatus(message) {
        statusEl.textContent = message || "";
      }

      function open() {
        closing = false;
        capturing = null;
        setStatus("");
        api.get().then(apply);
        requestAnimationFrame(function () {
          document.body.classList.add("open");
        });
      }

      function dismiss() {
        if (closing) {
          return;
        }
        closing = true;
        capturing = null;
        document.body.classList.remove("open");
        // Let the sheet animate out before the view is detached.
        setTimeout(function () {
          api.close();
        }, CLOSE_MS);
      }

      document.addEventListener("keydown", function (event) {
        if (!capturing) {
          if (event.key === "Escape") {
            event.preventDefault();
            dismiss();
          }
          return;
        }

        event.preventDefault();
        event.stopPropagation();

        if (MODIFIER_KEYS[event.key]) {
          return;
        }

        if (event.key === "Escape") {
          startCapture(null);
          return;
        }

        var id = capturing;
        if (event.key === "Backspace" || event.key === "Delete") {
          capturing = null;
          api.set(id, null).then(apply);
          setStatus(labelOf(id) + " 단축키를 해제했습니다.");
          return;
        }

        var binding = api.bindingFrom(
          {
            key: event.key,
            ctrl: event.ctrlKey,
            meta: event.metaKey,
            alt: event.altKey,
            shift: event.shiftKey,
          },
          platform
        );

        if (!binding) {
          setStatus("Ctrl, Alt, Shift, ⌘ 중 하나를 함께 눌러야 합니다. (F1~F12는 단독 사용 가능)");
          return;
        }

        capturing = null;
        var name = labelOf(id);
        api.set(id, binding).then(apply);
        setStatus(name + " → " + api.format(binding, platform));
      });

      document.getElementById("reset-all").addEventListener("click", function () {
        capturing = null;
        api.reset().then(apply);
        setStatus("모든 단축키를 기본값으로 되돌렸습니다.");
      });

      document.getElementById("backdrop").addEventListener("click", dismiss);
      document.getElementById("dismiss").addEventListener("click", dismiss);
      document.getElementById("close").addEventListener("click", dismiss);

      api.onChanged(apply);
      api.onShown(open);
      open();
    })();
  </script>
</body>
</html>`;
