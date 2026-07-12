/**
 * The tab-bar page rendered in the chrome WebContentsView. Loaded via a
 * data: URL, so it must be fully self-contained (inline CSS + JS, no external
 * resources). It reads/writes tab state through `window.tabsApi` exposed by
 * preload/chrome.ts.
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
  .tab {
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
  }
  .tab:hover { background: var(--hover-bg); }
  .tab.active {
    background: var(--tab-active-bg);
    color: var(--tab-active-fg);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.14);
  }
  .tab .title {
    flex: 1 1 auto;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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
  #new-tab {
    flex: 0 0 auto;
    width: 28px;
    height: 28px;
    margin-bottom: 2px;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--tab-fg);
    font-size: 18px;
    line-height: 1;
    cursor: default;
  }
  #new-tab:hover { background: var(--hover-bg); }
</style>
</head>
<body>
  <div id="bar">
    <div id="tabs"></div>
    <button id="new-tab" type="button" title="새 탭 (Ctrl+T)" aria-label="새 탭">+</button>
  </div>
  <script>
    (function () {
      var tabsEl = document.getElementById("tabs");

      function render(state) {
        var tabs = (state && state.tabs) || [];
        tabsEl.replaceChildren();
        for (var i = 0; i < tabs.length; i++) {
          tabsEl.appendChild(makeTab(tabs[i]));
        }
      }

      function makeTab(tab) {
        var el = document.createElement("div");
        el.className = "tab" + (tab.active ? " active" : "");
        el.title = tab.title || "새 탭";
        el.addEventListener("click", function () {
          window.tabsApi.activate(tab.id);
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
        close.addEventListener("click", function (event) {
          event.stopPropagation();
          window.tabsApi.close(tab.id);
        });
        el.appendChild(close);

        return el;
      }

      document.getElementById("new-tab").addEventListener("click", function () {
        window.tabsApi.create();
      });

      window.tabsApi.onState(render);
    })();
  </script>
</body>
</html>`;
