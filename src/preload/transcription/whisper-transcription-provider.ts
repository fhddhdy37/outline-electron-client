import type {
  TranscriptSegment,
  TranscriptionInput,
  TranscriptionProvider,
  TranscriptionStatus,
  Unsubscribe,
} from "./types";

type TranscriptListener = (segment: TranscriptSegment) => void;
type StatusListener = (status: TranscriptionStatus, message?: string) => void;

const TARGET_SAMPLE_RATE = 16000;
const CONNECT_TIMEOUT_MS = 8000;
const DONE_TIMEOUT_MS = 20000;
// Auto-reconnect on an unexpected socket close so a server blip or restart does
// not end the meeting. The audio pipeline stays up; only the socket is remade.
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10000;
const MAX_RECONNECT_ATTEMPTS = 30;

interface ServerSegmentMessage {
  type: "segment";
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number;
}

interface ServerPartialMessage {
  type: "partial";
  id: string;
  text: string;
  startMs: number;
  endMs: number;
}

const PCM_WORKLET_CODE = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this._chunks = [];
    this._length = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) {
      this._chunks.push(channel.slice(0));
      this._length += channel.length;
      if (this._length >= 4096) {
        const merged = new Float32Array(this._length);
        let offset = 0;
        for (const chunk of this._chunks) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
        this.port.postMessage(merged, [merged.buffer]);
        this._chunks = [];
        this._length = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
`;

function floatToInt16(samples: Float32Array): Int16Array {
  const output = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    output[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return output;
}

export class WhisperTranscriptionProvider implements TranscriptionProvider {
  readonly id = "whisper-selfhost";
  readonly label = "Self-hosted Whisper transcription";

  private readonly serverUrl: string;
  private transcriptListeners = new Set<TranscriptListener>();
  private statusListeners = new Set<StatusListener>();

  private socket?: WebSocket;
  private audioContext?: AudioContext;
  private sourceNode?: MediaStreamAudioSourceNode;
  private workletNode?: AudioWorkletNode;
  private muteGain?: GainNode;
  private workletUrl?: string;
  private sessionStartedAt = 0;
  private stopping = false;
  private resolveDone?: () => void;
  private language = "ko";
  private sampleRate = TARGET_SAMPLE_RATE;
  private reconnectTimer?: number;
  private reconnectAttempts = 0;

  constructor(serverUrl: string) {
    this.serverUrl = serverUrl;
  }

  async start(input: TranscriptionInput): Promise<void> {
    this.sessionStartedAt = Date.now();
    this.stopping = false;
    this.language = input.language;
    this.reconnectAttempts = 0;

    // The audio pipeline is built once and survives socket reconnects — only the
    // WebSocket is torn down and remade if the server blips.
    const audioContext = await this.createAudioContext();
    this.audioContext = audioContext;
    this.sampleRate = audioContext.sampleRate;

    this.workletUrl = URL.createObjectURL(
      new Blob([PCM_WORKLET_CODE], { type: "application/javascript" }),
    );
    await audioContext.audioWorklet.addModule(this.workletUrl);

    this.sourceNode = audioContext.createMediaStreamSource(input.audioStream);
    this.workletNode = new AudioWorkletNode(audioContext, "pcm-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });

    this.workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const socket = this.socket;
      if (socket && socket.readyState === WebSocket.OPEN && !this.stopping) {
        socket.send(floatToInt16(event.data).buffer);
      }
      // While reconnecting there is no open socket; that audio is dropped and
      // capture resumes once the connection is back.
    };

    // A rendered graph is required for the worklet to be pulled; keep it silent.
    this.muteGain = audioContext.createGain();
    this.muteGain.gain.value = 0;
    this.sourceNode.connect(this.workletNode);
    this.workletNode.connect(this.muteGain);
    this.muteGain.connect(audioContext.destination);

    // Initial connection is awaited so a start failure surfaces to the caller.
    await this.connectSocket(true);
    this.emitStatus("listening", "Whisper 서버로 스트리밍 중");
  }

  /** Opens a socket and (re)starts the server-side session on it. */
  private async connectSocket(initial: boolean): Promise<void> {
    this.emitStatus("connecting", initial ? "Whisper 서버 연결 중" : "서버 재연결 중");

    const socket = new WebSocket(this.serverUrl);
    socket.binaryType = "arraybuffer";

    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        socket.close();
        reject(new Error(`Whisper 서버 연결 시간 초과: ${this.serverUrl}`));
      }, CONNECT_TIMEOUT_MS);

      socket.addEventListener(
        "open",
        () => {
          window.clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          window.clearTimeout(timeout);
          reject(new Error(`Whisper 서버에 연결할 수 없습니다: ${this.serverUrl}`));
        },
        { once: true },
      );
    });

    this.socket = socket;
    socket.addEventListener("message", (event) => this.handleServerMessage(event));
    socket.addEventListener("close", () => {
      if (this.stopping) {
        return;
      }
      if (this.socket === socket) {
        this.socket = undefined;
      }
      this.scheduleReconnect();
    });

    socket.send(
      JSON.stringify({
        type: "start",
        sampleRate: this.sampleRate,
        language: this.language,
      }),
    );
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer !== undefined) {
      return;
    }
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.emitStatus("error", "Whisper 서버 재연결 실패");
      return;
    }

    const attempt = this.reconnectAttempts;
    this.reconnectAttempts += 1;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
    this.emitStatus("connecting", `서버 재연결 중… (${attempt + 1})`);

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.stopping) {
        return;
      }
      this.connectSocket(false)
        .then(() => {
          this.reconnectAttempts = 0;
          this.emitStatus("listening", "서버 재연결됨");
        })
        .catch(() => this.scheduleReconnect());
    }, delay);
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    this.emitStatus("stopping", "남은 오디오 전사 중");

    if (this.reconnectTimer !== undefined) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    const socket = this.socket;
    if (socket && socket.readyState === WebSocket.OPEN) {
      // Wait for the server to flush and transcribe the tail segment.
      const done = new Promise<void>((resolve) => {
        this.resolveDone = resolve;
        window.setTimeout(resolve, DONE_TIMEOUT_MS);
      });
      socket.send(JSON.stringify({ type: "stop" }));
      await done;
    }

    socket?.close();
    this.socket = undefined;
    this.resolveDone = undefined;

    this.workletNode?.port.close();
    this.sourceNode?.disconnect();
    this.workletNode?.disconnect();
    this.muteGain?.disconnect();
    this.sourceNode = undefined;
    this.workletNode = undefined;
    this.muteGain = undefined;

    if (this.workletUrl) {
      URL.revokeObjectURL(this.workletUrl);
      this.workletUrl = undefined;
    }

    await this.audioContext?.close().catch(() => undefined);
    this.audioContext = undefined;

    this.emitStatus("stopped", "전사 종료");
  }

  onTranscript(listener: TranscriptListener): Unsubscribe {
    this.transcriptListeners.add(listener);
    return () => this.transcriptListeners.delete(listener);
  }

  onStatus(listener: StatusListener): Unsubscribe {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private async createAudioContext(): Promise<AudioContext> {
    try {
      return new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
    } catch {
      // Some platforms refuse non-default rates; the server resamples instead.
      return new AudioContext();
    }
  }

  private handleServerMessage(event: MessageEvent): void {
    if (typeof event.data !== "string") {
      return;
    }

    let message: { type?: string; message?: string };
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === "ready") {
      this.emitStatus("listening", "Whisper 서버 준비됨");
      return;
    }

    if (message.type === "partial") {
      const partial = message as ServerPartialMessage;
      if (!partial.text) {
        return;
      }
      this.emitTranscript({
        id: partial.id,
        text: partial.text,
        isFinal: false,
        startedAt: this.sessionStartedAt + partial.startMs,
        endedAt: this.sessionStartedAt + partial.endMs,
        provider: this.id,
      });
      return;
    }

    if (message.type === "segment") {
      const segment = message as ServerSegmentMessage;
      if (!segment.text) {
        return;
      }
      this.emitTranscript({
        id: segment.id,
        text: segment.text,
        isFinal: true,
        startedAt: this.sessionStartedAt + segment.startMs,
        endedAt: this.sessionStartedAt + segment.endMs,
        confidence: segment.confidence,
        provider: this.id,
      });
      return;
    }

    if (message.type === "done") {
      this.resolveDone?.();
      return;
    }

    if (message.type === "error") {
      this.emitStatus("error", message.message ?? "Whisper 서버 오류");
    }
  }

  private emitTranscript(segment: TranscriptSegment): void {
    this.transcriptListeners.forEach((listener) => listener(segment));
  }

  private emitStatus(status: TranscriptionStatus, message?: string): void {
    this.statusListeners.forEach((listener) => listener(status, message));
  }
}
