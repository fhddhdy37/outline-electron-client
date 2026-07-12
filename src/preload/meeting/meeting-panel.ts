import type { AppInfo } from "../../shared/ipc";
import type { TranscriptSegment, TranscriptionStatus } from "../transcription/types";
import { MEETING_PANEL_STYLES } from "../styles/meeting-panel-styles";

export interface MeetingPanelEvents {
  onStart(): void;
  onStop(): void;
  onInsert(): void;
  onDownload(): void;
  onClose(): void;
}

export interface MeetingPanelSourceState {
  microphone: boolean;
  systemAudio: boolean;
  warnings: string[];
}

export class MeetingPanel {
  private readonly host: HTMLDivElement;
  private readonly statusLabel: HTMLSpanElement;
  private readonly statusDot: HTMLSpanElement;
  private readonly sourceList: HTMLDivElement;
  private readonly transcript: HTMLDivElement;
  private readonly warning: HTMLDivElement;
  private readonly startButton: HTMLButtonElement;
  private readonly stopButton: HTMLButtonElement;
  private readonly insertButton: HTMLButtonElement;
  private readonly downloadButton: HTMLButtonElement;

  constructor(appInfo: AppInfo, events: MeetingPanelEvents) {
    this.host = document.createElement("div");
    this.host.id = "outline-meeting-panel-root";

    const shadow = this.host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = MEETING_PANEL_STYLES;

    const panel = document.createElement("section");
    panel.className = "panel";
    panel.setAttribute("aria-label", "회의 녹음 패널");
    panel.innerHTML = `
      <div class="header">
        <div class="title">
          <strong>회의 녹음</strong>
          <span>Outline 안에서 녹음 + 실시간 전사</span>
        </div>
        <button class="close" type="button" aria-label="닫기">×</button>
      </div>
      <div class="body">
        <div class="status-row">
          <div class="status">
            <span class="dot"></span>
            <span data-role="status">준비됨</span>
          </div>
          <div class="source-list" data-role="sources"></div>
        </div>
        <div class="controls">
          <button class="button primary" type="button" data-action="start">시작</button>
          <button class="button danger" type="button" data-action="stop" disabled>중지</button>
          <button class="button secondary" type="button" data-action="insert" disabled>문서에 삽입</button>
          <button class="button secondary" type="button" data-action="download" disabled>녹음 다운로드</button>
        </div>
        <div class="warning" data-role="warning"></div>
        <div class="transcript" data-role="transcript">
          <span class="empty">시작을 누르면 mock 실시간 전사가 여기에 표시됩니다.</span>
        </div>
      </div>
    `;

    shadow.append(style, panel);

    this.statusLabel = panel.querySelector("[data-role='status']") as HTMLSpanElement;
    this.statusDot = panel.querySelector(".dot") as HTMLSpanElement;
    this.sourceList = panel.querySelector("[data-role='sources']") as HTMLDivElement;
    this.transcript = panel.querySelector("[data-role='transcript']") as HTMLDivElement;
    this.warning = panel.querySelector("[data-role='warning']") as HTMLDivElement;
    this.startButton = panel.querySelector("[data-action='start']") as HTMLButtonElement;
    this.stopButton = panel.querySelector("[data-action='stop']") as HTMLButtonElement;
    this.insertButton = panel.querySelector("[data-action='insert']") as HTMLButtonElement;
    this.downloadButton = panel.querySelector("[data-action='download']") as HTMLButtonElement;

    this.startButton.addEventListener("click", events.onStart);
    this.stopButton.addEventListener("click", events.onStop);
    this.insertButton.addEventListener("click", events.onInsert);
    this.downloadButton.addEventListener("click", events.onDownload);
    panel.querySelector(".close")?.addEventListener("click", events.onClose);

    this.setSources({
      microphone: false,
      systemAudio: appInfo.platform === "win32",
      warnings:
        appInfo.platform === "win32"
          ? []
          : ["현재 OS에서는 시스템 오디오 캡처가 best-effort로 동작합니다."],
    });
  }

  show(): void {
    if (!this.host.isConnected) {
      document.documentElement.append(this.host);
    }
  }

  remove(): void {
    this.host.remove();
  }

  setStatus(status: TranscriptionStatus | "ready" | "recording", message?: string): void {
    const labels: Record<typeof status, string> = {
      idle: "대기 중",
      ready: "준비됨",
      connecting: "전사 연결 중",
      listening: "전사 중",
      recording: "녹음 중",
      stopping: "중지 중",
      stopped: "중지됨",
      error: "오류",
    };

    this.statusLabel.textContent = message ? `${labels[status]} · ${message}` : labels[status];
    this.statusDot.classList.toggle("recording", status === "recording" || status === "listening");
  }

  setRecordingState(isRecording: boolean): void {
    this.startButton.disabled = isRecording;
    this.stopButton.disabled = !isRecording;
  }

  setCanInsert(canInsert: boolean): void {
    this.insertButton.disabled = !canInsert;
  }

  setCanDownload(canDownload: boolean): void {
    this.downloadButton.disabled = !canDownload;
  }

  clearTranscript(): void {
    this.transcript.replaceChildren();
    const empty = document.createElement("span");
    empty.className = "empty";
    empty.textContent = "전사 대기 중…";
    this.transcript.append(empty);
  }

  appendTranscript(segment: TranscriptSegment): void {
    const empty = this.transcript.querySelector(".empty");
    empty?.remove();

    const line = document.createElement("div");
    line.className = "segment";
    line.textContent = segment.text;
    this.transcript.append(line);
    this.transcript.scrollTop = this.transcript.scrollHeight;
  }

  setSources(state: MeetingPanelSourceState): void {
    this.sourceList.replaceChildren(
      this.createSourceBadge(state.microphone ? "마이크 ON" : "마이크 준비"),
      this.createSourceBadge(state.systemAudio ? "시스템 오디오 ON" : "시스템 오디오 미확인"),
    );

    if (state.warnings.length === 0) {
      this.warning.classList.remove("visible");
      this.warning.textContent = "";
      return;
    }

    this.warning.classList.add("visible");
    this.warning.textContent = state.warnings.join(" ");
  }

  setError(message: string): void {
    this.setStatus("error", message);
    this.warning.classList.add("visible");
    this.warning.textContent = message;
  }

  private createSourceBadge(label: string): HTMLSpanElement {
    const badge = document.createElement("span");
    badge.className = "source";
    badge.textContent = label;
    return badge;
  }
}

