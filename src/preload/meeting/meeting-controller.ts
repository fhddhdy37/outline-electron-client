import type { AppInfo } from "../../shared/ipc";
import { AudioCaptureService, type RecordingResult, type RecordingSession } from "../audio/audio-capture";
import { MockTranscriptionProvider } from "../transcription/mock-transcription-provider";
import type { TranscriptSegment, TranscriptionProvider, Unsubscribe } from "../transcription/types";
import type { SlashCommandContext } from "./command-detector";
import { EditorBridge, type CapturedEditorTarget } from "./editor-bridge";
import { MeetingPanel } from "./meeting-panel";

interface MeetingControllerOptions {
  appInfo: AppInfo;
  editorBridge: EditorBridge;
}

export class MeetingController {
  private readonly appInfo: AppInfo;
  private readonly editorBridge: EditorBridge;
  private readonly audioCapture = new AudioCaptureService();
  private panel?: MeetingPanel;
  private activeEditorTarget?: CapturedEditorTarget;
  private recordingSession?: RecordingSession;
  private recordingResult?: RecordingResult;
  private transcriptionProvider?: TranscriptionProvider;
  private unsubscribeTranscript?: Unsubscribe;
  private unsubscribeStatus?: Unsubscribe;
  private transcriptSegments: TranscriptSegment[] = [];

  constructor(options: MeetingControllerOptions) {
    this.appInfo = options.appInfo;
    this.editorBridge = options.editorBridge;
  }

  openFromCommand(context: SlashCommandContext): void {
    this.activeEditorTarget = this.editorBridge.capture(context.editable);
    this.ensurePanel();
    this.panel?.show();
    this.panel?.setStatus("ready", "`/회의` 감지됨");
  }

  openManually(): void {
    this.ensurePanel();
    this.panel?.show();
    this.panel?.setStatus("ready");
  }

  private ensurePanel(): void {
    if (this.panel) {
      return;
    }

    this.panel = new MeetingPanel(this.appInfo, {
      onStart: () => void this.startRecording(),
      onStop: () => void this.stopRecording(),
      onInsert: () => this.insertTranscriptIntoDocument(),
      onDownload: () => this.downloadRecording(),
      onClose: () => void this.closePanel(),
    });
  }

  private async startRecording(): Promise<void> {
    if (this.recordingSession) {
      return;
    }

    this.ensurePanel();
    this.panel?.clearTranscript();
    this.panel?.setRecordingState(true);
    this.panel?.setCanDownload(false);
    this.panel?.setCanInsert(false);
    this.panel?.setStatus("recording", "권한 요청 중");

    try {
      this.recordingResult = undefined;
      this.transcriptSegments = [];

      this.recordingSession = await this.audioCapture.start({
        captureSystemAudio: true,
        timesliceMs: 1500,
      });

      this.panel?.setSources({
        microphone: this.recordingSession.hasMicrophoneAudio,
        systemAudio: this.recordingSession.hasSystemAudio,
        warnings: this.recordingSession.warnings,
      });

      this.transcriptionProvider = new MockTranscriptionProvider();
      this.unsubscribeTranscript = this.transcriptionProvider.onTranscript((segment) => {
        this.transcriptSegments.push(segment);
        this.panel?.appendTranscript(segment);
        this.panel?.setCanInsert(true);
      });
      this.unsubscribeStatus = this.transcriptionProvider.onStatus((status, message) => {
        this.panel?.setStatus(status, message);
      });

      await this.transcriptionProvider.start({
        audioStream: this.recordingSession.mixedStream,
        language: "ko",
        subscribeToAudioChunks: (listener) => this.recordingSession?.onAudioChunk(listener) ?? (() => undefined),
      });

      this.panel?.setStatus("recording", "녹음 중");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.panel?.setError(message);
      this.panel?.setRecordingState(false);
      await this.cleanupTranscription();
      this.recordingSession = undefined;
    }
  }

  private async stopRecording(): Promise<void> {
    if (!this.recordingSession) {
      return;
    }

    const session = this.recordingSession;
    this.recordingSession = undefined;
    this.panel?.setStatus("stopping");

    await this.cleanupTranscription();
    this.recordingResult = await session.stop();

    this.panel?.setRecordingState(false);
    this.panel?.setCanDownload(this.recordingResult.blob.size > 0);
    this.panel?.setCanInsert(this.transcriptSegments.length > 0);
    this.panel?.setStatus("stopped");
  }

  private async cleanupTranscription(): Promise<void> {
    this.unsubscribeTranscript?.();
    this.unsubscribeStatus?.();
    this.unsubscribeTranscript = undefined;
    this.unsubscribeStatus = undefined;

    if (this.transcriptionProvider) {
      await this.transcriptionProvider.stop();
      this.transcriptionProvider = undefined;
    }
  }

  private insertTranscriptIntoDocument(): void {
    if (this.transcriptSegments.length === 0) {
      this.panel?.setError("삽입할 전사 텍스트가 아직 없습니다.");
      return;
    }

    const inserted = this.editorBridge.insertText(
      this.activeEditorTarget,
      this.formatTranscriptForOutline(),
    );

    if (!inserted) {
      this.panel?.setError("현재 Outline 편집 영역을 찾지 못했습니다. 문서 본문을 클릭한 뒤 다시 시도해 주세요.");
      return;
    }

    this.panel?.setStatus("stopped", "전사 텍스트 삽입 완료");
  }

  private formatTranscriptForOutline(): string {
    const recordedAt = new Intl.DateTimeFormat("ko-KR", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date());

    const lines = this.transcriptSegments.map((segment) => `- ${segment.text}`);

    return `\n\n회의 전사 (${recordedAt})\n${lines.join("\n")}\n`;
  }

  private downloadRecording(): void {
    if (!this.recordingResult || this.recordingResult.blob.size === 0) {
      this.panel?.setError("다운로드할 녹음 파일이 없습니다.");
      return;
    }

    const url = URL.createObjectURL(this.recordingResult.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `outline-meeting-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  private async closePanel(): Promise<void> {
    await this.stopRecording();
    this.panel?.remove();
    this.panel = undefined;
  }
}

