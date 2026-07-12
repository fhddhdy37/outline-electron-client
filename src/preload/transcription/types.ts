export type Unsubscribe = () => void;

export type TranscriptionStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "stopping"
  | "stopped"
  | "error";

export interface AudioChunk {
  blob: Blob;
  sequence: number;
  recordedAt: number;
}

export interface TranscriptSegment {
  id: string;
  text: string;
  isFinal: boolean;
  startedAt: number;
  endedAt: number;
  confidence?: number;
  provider: string;
}

export interface TranscriptionInput {
  audioStream: MediaStream;
  language: string;
  subscribeToAudioChunks(listener: (chunk: AudioChunk) => void): Unsubscribe;
}

export interface TranscriptionProvider {
  readonly id: string;
  readonly label: string;
  start(input: TranscriptionInput): Promise<void>;
  stop(): Promise<void>;
  onTranscript(listener: (segment: TranscriptSegment) => void): Unsubscribe;
  onStatus(listener: (status: TranscriptionStatus, message?: string) => void): Unsubscribe;
}

