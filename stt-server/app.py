"""Self-hosted realtime transcription server for the Outline Electron client.

Protocol (WebSocket, any path):
  client -> server
    text  {"type": "start", "sampleRate": 16000, "language": "ko"}
    binary <Int16 LE mono PCM frames at the declared sample rate>
    text  {"type": "stop"}
  server -> client
    text  {"type": "ready", "model": "...", "device": "..."}
    text  {"type": "segment", "id": "...", "text": "...",
           "startMs": 0, "endMs": 0, "confidence": 0.0}
    text  {"type": "done"}
    text  {"type": "error", "message": "..."}

Segmentation is a simple energy-based VAD: a segment is closed after
SILENCE_MS of quiet (or MAX_SEGMENT_MS), then transcribed as a whole so the
client can treat every segment as final (the panel transcript is append-only).
"""

import asyncio
import http
import json
import logging
import os
import uuid

import numpy as np
import websockets
from faster_whisper import WhisperModel

MODEL_NAME = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
DEVICE = os.environ.get("WHISPER_DEVICE", "auto")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE", "default")
PORT = int(os.environ.get("STT_PORT", "8765"))

# Energy VAD tuning (amplitudes relative to int16 full scale).
SPEECH_RMS_THRESHOLD = float(os.environ.get("STT_SPEECH_RMS", "0.010"))
SILENCE_MS = int(os.environ.get("STT_SILENCE_MS", "700"))
MIN_SPEECH_MS = int(os.environ.get("STT_MIN_SPEECH_MS", "300"))
MAX_SEGMENT_MS = int(os.environ.get("STT_MAX_SEGMENT_MS", "20000"))
# Audio kept before speech onset so quiet syllables are not clipped.
PRE_ROLL_MS = int(os.environ.get("STT_PRE_ROLL_MS", "300"))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("stt")

model: WhisperModel | None = None
# faster-whisper inference is not reentrant per model instance.
inference_lock = asyncio.Lock()


async def transcribe(audio: np.ndarray, language: str | None) -> tuple[str, float]:
    def run() -> tuple[str, float]:
        assert model is not None
        segments, _info = model.transcribe(
            audio,
            language=language or None,
            beam_size=5,
            vad_filter=True,
            condition_on_previous_text=False,
        )
        texts: list[str] = []
        probs: list[float] = []
        for segment in segments:
            text = segment.text.strip()
            if text:
                texts.append(text)
                probs.append(float(np.exp(segment.avg_logprob)))
        joined = " ".join(texts).strip()
        confidence = float(np.mean(probs)) if probs else 0.0
        return joined, confidence

    async with inference_lock:
        return await asyncio.to_thread(run)


class SegmentAssembler:
    """Accumulates PCM and yields (audio, start_ms, end_ms) speech segments."""

    def __init__(self, sample_rate: int):
        self.sample_rate = sample_rate
        self.frame_ms = 30
        self.frame_samples = sample_rate * self.frame_ms // 1000
        self.pending = np.empty(0, dtype=np.int16)
        self.segment_frames: list[np.ndarray] = []
        self.pre_roll_frames: list[np.ndarray] = []
        self.in_speech = False
        self.silence_ms = 0
        self.speech_ms = 0
        self.clock_ms = 0
        self.segment_start_ms = 0

    def push(self, pcm: np.ndarray):
        """Feed PCM; yields closed segments."""
        self.pending = np.concatenate([self.pending, pcm])
        while len(self.pending) >= self.frame_samples:
            frame = self.pending[: self.frame_samples]
            self.pending = self.pending[self.frame_samples :]
            yield from self._push_frame(frame)

    def flush(self):
        if len(self.pending) > 0:
            frame = self.pending
            self.pending = np.empty(0, dtype=np.int16)
            yield from self._push_frame(frame)
        if self.in_speech and self.speech_ms >= MIN_SPEECH_MS:
            yield self._close_segment()
        self.segment_frames = []
        self.in_speech = False

    def _push_frame(self, frame: np.ndarray):
        frame_ms = len(frame) * 1000 // self.sample_rate
        rms = float(np.sqrt(np.mean((frame.astype(np.float32) / 32768.0) ** 2)))
        is_speech = rms >= SPEECH_RMS_THRESHOLD

        if self.in_speech:
            self.segment_frames.append(frame)
            if is_speech:
                self.silence_ms = 0
                self.speech_ms += frame_ms
            else:
                self.silence_ms += frame_ms

            segment_ms = self.clock_ms + frame_ms - self.segment_start_ms
            if self.silence_ms >= SILENCE_MS or segment_ms >= MAX_SEGMENT_MS:
                if self.speech_ms >= MIN_SPEECH_MS:
                    yield self._close_segment()
                self.segment_frames = []
                self.in_speech = False
        elif is_speech:
            self.in_speech = True
            self.silence_ms = 0
            self.speech_ms = frame_ms
            pre_roll_ms = sum(len(f) for f in self.pre_roll_frames) * 1000 // self.sample_rate
            self.segment_start_ms = max(0, self.clock_ms - pre_roll_ms)
            self.segment_frames = [*self.pre_roll_frames, frame]
            self.pre_roll_frames = []

        if not self.in_speech:
            self.pre_roll_frames.append(frame)
            while (
                sum(len(f) for f in self.pre_roll_frames) * 1000 // self.sample_rate
                > PRE_ROLL_MS
            ):
                self.pre_roll_frames.pop(0)

        self.clock_ms += frame_ms

    def _close_segment(self) -> tuple[np.ndarray, int, int]:
        audio = np.concatenate(self.segment_frames)
        start_ms = self.segment_start_ms
        end_ms = start_ms + len(audio) * 1000 // self.sample_rate
        return audio, start_ms, end_ms


def resample_to_16k(audio: np.ndarray, sample_rate: int) -> np.ndarray:
    if sample_rate == 16000:
        return audio
    duration = len(audio) / sample_rate
    target_length = int(duration * 16000)
    positions = np.linspace(0, len(audio) - 1, target_length)
    return np.interp(positions, np.arange(len(audio)), audio).astype(np.float32)


async def handle_connection(websocket):
    sample_rate = 16000
    language: str | None = "ko"
    assembler: SegmentAssembler | None = None
    log.info("client connected: %s", websocket.remote_address)

    async def emit_segment(audio: np.ndarray, start_ms: int, end_ms: int):
        try:
            text, confidence = await transcribe(
                resample_to_16k(audio.astype(np.float32) / 32768.0, sample_rate),
                language,
            )
        except Exception:
            log.exception("transcription failed")
            await websocket.send(
                json.dumps({"type": "error", "message": "transcription failed"})
            )
            return
        if not text:
            return
        await websocket.send(
            json.dumps(
                {
                    "type": "segment",
                    "id": str(uuid.uuid4()),
                    "text": text,
                    "startMs": start_ms,
                    "endMs": end_ms,
                    "confidence": round(confidence, 3),
                },
                ensure_ascii=False,
            )
        )

    try:
        async for message in websocket:
            if isinstance(message, bytes):
                if assembler is None:
                    continue
                pcm = np.frombuffer(message, dtype="<i2")
                for audio, start_ms, end_ms in assembler.push(pcm):
                    await emit_segment(audio, start_ms, end_ms)
                continue

            try:
                control = json.loads(message)
            except json.JSONDecodeError:
                await websocket.send(
                    json.dumps({"type": "error", "message": "invalid JSON"})
                )
                continue

            if control.get("type") == "start":
                sample_rate = int(control.get("sampleRate", 16000))
                language = control.get("language") or None
                assembler = SegmentAssembler(sample_rate)
                await websocket.send(
                    json.dumps({"type": "ready", "model": MODEL_NAME, "device": DEVICE})
                )
            elif control.get("type") == "stop":
                if assembler is not None:
                    for audio, start_ms, end_ms in assembler.flush():
                        await emit_segment(audio, start_ms, end_ms)
                    assembler = None
                await websocket.send(json.dumps({"type": "done"}))
    except websockets.ConnectionClosed:
        pass
    finally:
        log.info("client disconnected: %s", websocket.remote_address)


async def health_check(connection, request):
    if request.path == "/healthz":
        return connection.respond(http.HTTPStatus.OK, "ok\n")
    return None


async def main():
    global model
    log.info("loading model %s (device=%s, compute=%s)", MODEL_NAME, DEVICE, COMPUTE_TYPE)
    model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE_TYPE)
    log.info("model loaded")

    # Warm up CUDA kernels so the first real segment is not slow.
    list(model.transcribe(np.zeros(16000, dtype=np.float32), language="ko")[0])
    log.info("model warmed up")

    async with websockets.serve(
        handle_connection,
        "0.0.0.0",
        PORT,
        max_size=2**22,
        process_request=health_check,
    ):
        log.info("listening on :%d", PORT)
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
