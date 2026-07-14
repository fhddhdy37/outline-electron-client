import type { AppInfo } from "../../shared/ipc";
import { AudioCaptureService, type RecordingSession } from "../audio/audio-capture";
import { MockTranscriptionProvider } from "../transcription/mock-transcription-provider";
import { WhisperTranscriptionProvider } from "../transcription/whisper-transcription-provider";
import type { TranscriptSegment, TranscriptionProvider, Unsubscribe } from "../transcription/types";
import type { SlashCommandContext } from "./command-detector";
import { EditorBridge, type CapturedEditorTarget } from "./editor-bridge";
import { MeetingPanel } from "./meeting-panel";

interface MeetingControllerOptions {
  appInfo: AppInfo;
  editorBridge: EditorBridge;
}

const MEETING_MARKER = "🎙 회의 녹음 중…";
// Invisible separator marking the start of the in-progress (live) transcript
// run in the document, so partials can be rewritten in place before committing.
const LIVE_SENTINEL = "\u2063";

/** "\ub098: " / "\uc0c1\ub300: " prefix for a segment, or "" when it carries no speaker. */
function labelPrefix(segment: TranscriptSegment): string {
  return segment.speaker ? `${segment.speaker}: ` : "";
}

export class MeetingController {
  private readonly appInfo: AppInfo;
  private readonly editorBridge: EditorBridge;
  private readonly audioCapture = new AudioCaptureService();
  private panel?: MeetingPanel;
  private activeEditorTarget?: CapturedEditorTarget;
  private recordingSession?: RecordingSession;
  private transcriptionProvider?: TranscriptionProvider;
  private unsubscribeTranscript?: Unsubscribe;
  private unsubscribeStatus?: Unsubscribe;
  private unsubscribeRelabel?: Unsubscribe;
  private transcriptSegments: TranscriptSegment[] = [];
  private streamingActive = false;
  private docLiveActive = false;

  constructor(options: MeetingControllerOptions) {
    this.appInfo = options.appInfo;
    this.editorBridge = options.editorBridge;
  }

  openFromCommand(context: SlashCommandContext): void {
    if (this.recordingSession || this.streamingActive) {
      return;
    }

    const target = this.editorBridge.capture(context.editable);
    this.activeEditorTarget = target;
    this.ensurePanel();
    this.panel?.setInsertVisible(false);
    this.panel?.show();

    const consumed = this.editorBridge.consumeTrigger(target, context.command.length);
    const placeholder = `📝 회의 전사 (${this.formatTimestamp()})\n${MEETING_MARKER}`;
    const inserted = consumed && this.editorBridge.insertAtSelection(target, placeholder);

    if (inserted) {
      this.streamingActive = true;
      this.panel?.setStatus("ready", "문서에 실시간 전사 블록 생성됨");
    } else {
      this.panel?.setStatus(
        "ready",
        "`/회의` 감지됨 · 문서 삽입에 실패해 위젯에만 전사됩니다.",
      );
    }

    void this.startRecording();
  }

  openManually(): void {
    this.ensurePanel();
    this.panel?.setInsertVisible(true);
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
    this.panel?.setCanInsert(false);
    this.panel?.setStatus("recording", "권한 요청 중");

    try {
      this.transcriptSegments = [];
      // Drop any relabel listener still waiting from a previous recording.
      this.unsubscribeRelabel?.();
      this.unsubscribeRelabel = undefined;

      this.recordingSession = await this.audioCapture.start({
        captureSystemAudio: true,
        timesliceMs: 1500,
      });

      this.panel?.setSources({
        microphone: this.recordingSession.hasMicrophoneAudio,
        systemAudio: this.recordingSession.hasSystemAudio,
        warnings: this.recordingSession.warnings,
      });

      this.transcriptionProvider = this.createTranscriptionProvider();
      this.unsubscribeTranscript = this.transcriptionProvider.onTranscript((segment) => {
        const key = segment.source ?? "default";
        if (segment.isFinal) {
          this.transcriptSegments.push(segment);
          this.panel?.commitFinalTranscript(key, segment.id, segment.speaker, segment.text);
          this.commitSegmentIntoDocument(segment);
          this.panel?.setCanInsert(true);
        } else {
          this.panel?.renderPartialTranscript(key, segment.speaker, segment.text);
          this.renderPartialIntoDocument(segment);
        }
      });
      this.unsubscribeStatus = this.transcriptionProvider.onStatus((status, message) => {
        this.panel?.setStatus(status, message);
      });
      this.unsubscribeRelabel = this.transcriptionProvider.onRelabel?.((labels) =>
        this.applyRelabel(labels),
      );

      await this.transcriptionProvider.start({
        // Per-speaker channels (ch0 mic / ch1 system) drive transcription; the
        // mixed stream is only for the downloadable recording.
        audioStream: this.recordingSession.channeledStream,
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
      this.finalizeStreaming();
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
    await session.stop();
    this.finalizeStreaming();

    // Recording finished — the transcript already lives in the document, so
    // dismiss the widget automatically instead of leaving it on screen.
    this.panel?.remove();
    this.panel = undefined;
  }

  private renderPartialIntoDocument(segment: TranscriptSegment): void {
    if (!this.streamingActive || !this.activeEditorTarget) {
      return;
    }

    // Live text sits after the sentinel and before the marker, no hyphen yet.
    const written = this.editorBridge.streamLiveBeforeMarker(
      this.activeEditorTarget,
      MEETING_MARKER,
      LIVE_SENTINEL,
      `${LIVE_SENTINEL}${labelPrefix(segment)}${segment.text}`,
      false,
    );
    this.docLiveActive = this.docLiveActive || written;
  }

  private commitSegmentIntoDocument(segment: TranscriptSegment): void {
    if (!this.streamingActive || !this.activeEditorTarget) {
      return;
    }

    // Replace the live run (if any) with the committed hyphen bullet; the lack
    // of a sentinel in the replacement closes the run.
    this.editorBridge.streamLiveBeforeMarker(
      this.activeEditorTarget,
      MEETING_MARKER,
      LIVE_SENTINEL,
      `- ${labelPrefix(segment)}${segment.text}\n`,
      true,
    );
    this.docLiveActive = false;
  }

  private finalizeStreaming(): void {
    if (this.streamingActive && this.activeEditorTarget) {
      if (this.docLiveActive) {
        // Drop any dangling live run that never got a committed final.
        this.editorBridge.streamLiveBeforeMarker(
          this.activeEditorTarget,
          MEETING_MARKER,
          LIVE_SENTINEL,
          "",
          false,
        );
        this.docLiveActive = false;
      }
      this.editorBridge.removeMarker(this.activeEditorTarget, MEETING_MARKER);
    }
    this.streamingActive = false;
  }

  private formatTimestamp(): string {
    return new Intl.DateTimeFormat("ko-KR", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date());
  }

  private createTranscriptionProvider(): TranscriptionProvider {
    if (this.appInfo.sttUrl === "mock") {
      return new MockTranscriptionProvider();
    }

    return new WhisperTranscriptionProvider(this.appInfo.sttUrl);
  }

  private applyRelabel(labels: Record<string, string>): void {
    // Panel relabels precisely by utterance id.
    this.panel?.relabelTranscript(labels);

    // Update stored segments (used by insert/download) and best-effort rewrite
    // the committed document lines.
    for (const segment of this.transcriptSegments) {
      const corrected = labels[segment.id];
      if (!corrected || corrected === segment.speaker) {
        continue;
      }
      if (this.activeEditorTarget && segment.speaker) {
        this.editorBridge.replaceFirstOccurrence(
          this.activeEditorTarget,
          `${segment.speaker}: ${segment.text}`,
          `${corrected}: ${segment.text}`,
        );
      }
      segment.speaker = corrected;
    }
  }

  private async cleanupTranscription(): Promise<void> {
    this.unsubscribeTranscript?.();
    this.unsubscribeStatus?.();
    // Keep the relabel subscription alive: the offline diarization relabel
    // arrives after stop(). It is dropped when the next recording starts.
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

    const lines = this.transcriptSegments.map(
      (segment) => `- ${labelPrefix(segment)}${segment.text}`,
    );

    return `\n\n회의 전사 (${recordedAt})\n${lines.join("\n")}\n`;
  }

  private async closePanel(): Promise<void> {
    await this.stopRecording();
    this.finalizeStreaming();
    this.panel?.remove();
    this.panel = undefined;
  }
}

