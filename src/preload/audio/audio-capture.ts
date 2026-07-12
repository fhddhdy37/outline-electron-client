import type { AudioChunk, Unsubscribe } from "../transcription/types";

export interface AudioCaptureStartOptions {
  captureSystemAudio: boolean;
  timesliceMs: number;
}

export interface RecordingResult {
  blob: Blob;
  chunks: Blob[];
  mimeType: string;
  startedAt: number;
  endedAt: number;
  hasMicrophoneAudio: boolean;
  hasSystemAudio: boolean;
  warnings: string[];
}

export interface RecordingSession {
  mixedStream: MediaStream;
  startedAt: number;
  hasMicrophoneAudio: boolean;
  hasSystemAudio: boolean;
  warnings: string[];
  onAudioChunk(listener: (chunk: AudioChunk) => void): Unsubscribe;
  stop(): Promise<RecordingResult>;
}

interface ConnectedAudioNode {
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
}

function preferredMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];

  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
}

function stopStream(stream?: MediaStream): void {
  stream?.getTracks().forEach((track) => track.stop());
}

export class AudioCaptureService {
  async start(options: AudioCaptureStartOptions): Promise<RecordingSession> {
    const warnings: string[] = [];
    const audioContext = new AudioContext();
    const destination = audioContext.createMediaStreamDestination();
    const connections: ConnectedAudioNode[] = [];
    const chunks: Blob[] = [];
    const listeners = new Set<(chunk: AudioChunk) => void>();
    const startedAt = Date.now();

    const microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    const hasMicrophoneAudio = this.connectAudioStream(
      audioContext,
      destination,
      microphoneStream,
      connections,
    );

    let systemStream: MediaStream | undefined;
    let hasSystemAudio = false;

    if (options.captureSystemAudio) {
      try {
        systemStream = await navigator.mediaDevices.getDisplayMedia({
          audio: true,
          video: true,
        });

        hasSystemAudio = this.connectAudioStream(
          audioContext,
          destination,
          systemStream,
          connections,
        );

        if (!hasSystemAudio) {
          warnings.push("시스템 오디오 트랙을 받지 못했습니다. OS 또는 권한 제약일 수 있습니다.");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`시스템 오디오 캡처를 시작하지 못했습니다: ${message}`);
      }
    }

    if (!hasMicrophoneAudio && !hasSystemAudio) {
      stopStream(microphoneStream);
      stopStream(systemStream);
      await audioContext.close();
      throw new Error("No audio tracks were available for recording.");
    }

    const mimeType = preferredMimeType();
    const recorder = new MediaRecorder(
      destination.stream,
      mimeType ? { mimeType } : undefined,
    );

    let sequence = 0;
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size === 0) {
        return;
      }

      chunks.push(event.data);

      const chunk: AudioChunk = {
        blob: event.data,
        sequence,
        recordedAt: Date.now(),
      };

      sequence += 1;
      listeners.forEach((listener) => listener(chunk));
    });

    recorder.start(options.timesliceMs);

    return {
      mixedStream: destination.stream,
      startedAt,
      hasMicrophoneAudio,
      hasSystemAudio,
      warnings,
      onAudioChunk(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      stop: () =>
        new Promise<RecordingResult>((resolve) => {
          const finalize = async () => {
            connections.forEach((connection) => {
              connection.source.disconnect();
              connection.gain.disconnect();
            });

            stopStream(microphoneStream);
            stopStream(systemStream);
            stopStream(destination.stream);
            await audioContext.close();

            const endedAt = Date.now();
            resolve({
              blob: new Blob(chunks, { type: recorder.mimeType || mimeType }),
              chunks,
              mimeType: recorder.mimeType || mimeType,
              startedAt,
              endedAt,
              hasMicrophoneAudio,
              hasSystemAudio,
              warnings,
            });
          };

          if (recorder.state === "inactive") {
            void finalize();
            return;
          }

          recorder.addEventListener("stop", () => void finalize(), { once: true });
          recorder.stop();
        }),
    };
  }

  private connectAudioStream(
    audioContext: AudioContext,
    destination: MediaStreamAudioDestinationNode,
    stream: MediaStream,
    connections: ConnectedAudioNode[],
  ): boolean {
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      return false;
    }

    const sourceStream = new MediaStream(audioTracks);
    const source = audioContext.createMediaStreamSource(sourceStream);
    const gain = audioContext.createGain();
    gain.gain.value = 1;
    source.connect(gain).connect(destination);
    connections.push({ source, gain });

    return true;
  }
}

