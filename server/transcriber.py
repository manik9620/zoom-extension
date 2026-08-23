import os

from faster_whisper import WhisperModel

MODEL_SIZE = os.environ.get("WHISPER_MODEL", "small.en")

_model = None


def get_model():
    global _model
    if _model is None:
        _model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
    return _model


def transcribe_pcm16(pcm_bytes: bytes, sample_rate: int = 16000):
    """pcm_bytes: raw little-endian int16 mono samples. Returns transcribed text."""
    import numpy as np

    audio = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    model = get_model()
    segments, _ = model.transcribe(audio, language="en", beam_size=3, vad_filter=True)
    text = " ".join(seg.text.strip() for seg in segments).strip()
    return text
