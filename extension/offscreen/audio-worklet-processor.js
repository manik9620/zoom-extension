const TARGET_SAMPLE_RATE = 16000;
const MAX_CHUNK_SECONDS = 4; // hard cap so continuous speech still flushes regularly
const MIN_CHUNK_SECONDS = 0.8; // don't flush on tiny blips
const SILENCE_RMS_THRESHOLD = 0.012;
const SILENCE_HANG_SECONDS = 0.5; // pause length that counts as an utterance break

class PcmChunkProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inputSampleRate = sampleRate; // global provided by AudioWorkletGlobalScope
    this.resampleRatio = TARGET_SAMPLE_RATE / this.inputSampleRate;
    this.buffer = [];
    this.maxChunkSamples = TARGET_SAMPLE_RATE * MAX_CHUNK_SECONDS;
    this.minChunkSamples = TARGET_SAMPLE_RATE * MIN_CHUNK_SECONDS;
    this.silenceHangSamples = TARGET_SAMPLE_RATE * SILENCE_HANG_SECONDS;
    this.silentRunSamples = 0;
  }

  downsample(float32Input) {
    if (this.resampleRatio === 1) return float32Input;
    const outputLength = Math.round(float32Input.length * this.resampleRatio);
    const output = new Float32Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
      const srcIndex = i / this.resampleRatio;
      const i0 = Math.floor(srcIndex);
      const i1 = Math.min(i0 + 1, float32Input.length - 1);
      const frac = srcIndex - i0;
      output[i] = float32Input[i0] * (1 - frac) + float32Input[i1] * frac;
    }
    return output;
  }

  floatToPcm16(float32) {
    const pcm16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return pcm16;
  }

  flush() {
    if (this.buffer.length < this.minChunkSamples) return;
    const chunk = this.buffer.splice(0, this.buffer.length);
    const pcm16 = this.floatToPcm16(Float32Array.from(chunk));
    this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channelData = input[0];
    if (!channelData || channelData.length === 0) return true;

    const downsampled = this.downsample(channelData);

    let sumSquares = 0;
    for (let i = 0; i < downsampled.length; i++) {
      sumSquares += downsampled[i] * downsampled[i];
      this.buffer.push(downsampled[i]);
    }
    const rms = Math.sqrt(sumSquares / downsampled.length);

    if (rms < SILENCE_RMS_THRESHOLD) {
      this.silentRunSamples += downsampled.length;
    } else {
      this.silentRunSamples = 0;
    }

    const hitSilenceBreak = this.silentRunSamples >= this.silenceHangSamples;
    const hitMaxLength = this.buffer.length >= this.maxChunkSamples;

    if (hitSilenceBreak || hitMaxLength) {
      this.flush();
      this.silentRunSamples = 0;
    }

    return true;
  }
}

registerProcessor("pcm-chunk-processor", PcmChunkProcessor);
