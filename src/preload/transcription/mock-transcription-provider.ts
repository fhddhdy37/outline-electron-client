import type {
  AudioChunk,
  TranscriptSegment,
  TranscriptionInput,
  TranscriptionProvider,
  TranscriptionStatus,
  Unsubscribe,
} from "./types";

type TranscriptListener = (segment: TranscriptSegment) => void;
type StatusListener = (status: TranscriptionStatus, message?: string) => void;

const MOCK_UTTERANCES = [
  "회의 녹음이 시작되었습니다.",
  "참석자 발화를 실시간 전사하는 위치입니다.",
  "이 줄은 나중에 OpenAI API 또는 로컬 Whisper 어댑터로 교체됩니다.",
  "전사 chunk가 들어올 때마다 현재 Outline 문서에 삽입 가능한 형태로 누적합니다.",
  "요약과 액션아이템 추출은 다음 단계로 남겨둡니다.",
];

function createId(): string {
  if ("randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `mock-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export class MockTranscriptionProvider implements TranscriptionProvider {
  readonly id = "mock";
  readonly label = "Mock realtime transcription";

  private transcriptListeners = new Set<TranscriptListener>();
  private statusListeners = new Set<StatusListener>();
  private unsubscribeFromChunks?: Unsubscribe;
  private fallbackTimer?: number;
  private emittedCount = 0;
  private startedAt = 0;

  async start(input: TranscriptionInput): Promise<void> {
    this.startedAt = Date.now();
    this.emitStatus("connecting", "Mock provider preparing stream");

    this.unsubscribeFromChunks = input.subscribeToAudioChunks((chunk) => {
      this.emitChunkTranscript(chunk);
    });

    this.fallbackTimer = window.setInterval(() => {
      if (this.emittedCount === 0) {
        this.emitChunkTranscript({
          blob: new Blob(),
          sequence: 0,
          recordedAt: Date.now(),
        });
      }
    }, 3000);

    this.emitStatus("listening", "Mock provider listening");
  }

  async stop(): Promise<void> {
    this.emitStatus("stopping", "Stopping mock provider");
    this.unsubscribeFromChunks?.();
    this.unsubscribeFromChunks = undefined;

    if (this.fallbackTimer) {
      window.clearInterval(this.fallbackTimer);
      this.fallbackTimer = undefined;
    }

    this.emitStatus("stopped", "Mock provider stopped");
  }

  onTranscript(listener: TranscriptListener): Unsubscribe {
    this.transcriptListeners.add(listener);
    return () => this.transcriptListeners.delete(listener);
  }

  onStatus(listener: StatusListener): Unsubscribe {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private emitChunkTranscript(chunk: AudioChunk): void {
    const utterance = MOCK_UTTERANCES[this.emittedCount % MOCK_UTTERANCES.length];
    const startedAt = this.startedAt + this.emittedCount * 1500;
    const endedAt = Math.max(chunk.recordedAt, startedAt + 1200);

    const segment: TranscriptSegment = {
      id: createId(),
      text: `[mock ${String(this.emittedCount + 1).padStart(2, "0")}] ${utterance}`,
      isFinal: true,
      startedAt,
      endedAt,
      confidence: 0.99,
      provider: this.id,
    };

    this.emittedCount += 1;
    this.transcriptListeners.forEach((listener) => listener(segment));
  }

  private emitStatus(status: TranscriptionStatus, message?: string): void {
    this.statusListeners.forEach((listener) => listener(status, message));
  }
}

