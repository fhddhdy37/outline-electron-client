export const MEETING_PANEL_STYLES = `
:host {
  all: initial;
  color-scheme: light dark;
  font-family:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.panel {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 2147483647;
  width: 380px;
  max-height: min(680px, calc(100vh - 48px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid rgba(15, 23, 42, 0.14);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.96);
  box-shadow: 0 24px 80px rgba(15, 23, 42, 0.22);
  backdrop-filter: blur(16px);
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 16px 12px;
  border-bottom: 1px solid rgba(15, 23, 42, 0.08);
}

.title {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: #0f172a;
}

.title strong {
  font-size: 15px;
  line-height: 20px;
  font-weight: 720;
}

.title span {
  color: #64748b;
  font-size: 12px;
  line-height: 16px;
}

.close {
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: #64748b;
  cursor: pointer;
  font-size: 20px;
}

.close:hover {
  background: rgba(15, 23, 42, 0.08);
}

.body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px 16px;
  overflow: auto;
}

.status-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: #334155;
  font-size: 12px;
  line-height: 16px;
}

.dot {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: #94a3b8;
}

.dot.recording {
  background: #ef4444;
  box-shadow: 0 0 0 5px rgba(239, 68, 68, 0.16);
}

.source-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.source {
  border-radius: 999px;
  padding: 4px 8px;
  background: #f1f5f9;
  color: #475569;
  font-size: 11px;
  line-height: 14px;
}

.controls {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

button {
  font: inherit;
}

.button {
  border: 0;
  border-radius: 12px;
  padding: 10px 12px;
  cursor: pointer;
  font-size: 13px;
  line-height: 18px;
  font-weight: 650;
}

.button.primary {
  background: #2563eb;
  color: #ffffff;
}

.button.danger {
  background: #fee2e2;
  color: #b91c1c;
}

.button.secondary {
  background: #f1f5f9;
  color: #334155;
}

.button:disabled {
  cursor: not-allowed;
  opacity: 0.48;
}

.transcript {
  min-height: 150px;
  max-height: 260px;
  overflow: auto;
  border: 1px solid rgba(15, 23, 42, 0.1);
  border-radius: 14px;
  background: #f8fafc;
  padding: 10px;
  color: #0f172a;
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
}

.empty {
  color: #94a3b8;
}

.segment {
  margin-bottom: 8px;
}

.warning {
  display: none;
  border-radius: 12px;
  background: #fffbeb;
  color: #92400e;
  padding: 10px;
  font-size: 12px;
  line-height: 17px;
}

.warning.visible {
  display: block;
}

@media (prefers-color-scheme: dark) {
  .panel {
    border-color: rgba(148, 163, 184, 0.22);
    background: rgba(15, 23, 42, 0.94);
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.42);
  }

  .header {
    border-bottom-color: rgba(148, 163, 184, 0.16);
  }

  .title {
    color: #e2e8f0;
  }

  .title span,
  .status {
    color: #94a3b8;
  }

  .source,
  .button.secondary {
    background: rgba(148, 163, 184, 0.14);
    color: #cbd5e1;
  }

  .transcript {
    border-color: rgba(148, 163, 184, 0.16);
    background: rgba(15, 23, 42, 0.72);
    color: #e2e8f0;
  }

  .warning {
    background: rgba(146, 64, 14, 0.22);
    color: #fde68a;
  }
}
`;

