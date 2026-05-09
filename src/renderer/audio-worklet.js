// AudioWorklet processor: takes the mic input (typically 48 kHz Float32),
// downsamples to 16 kHz mono Int16, buffers ~3 seconds, posts chunks to main thread.

class CairnPCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.chunkSamples = this.targetRate * 3; // 3 s
    this.buffer = new Int16Array(this.chunkSamples);
    this.bufferIdx = 0;
    this.srcRate = sampleRate; // worklet global, typically 48000
    this.ratio = this.srcRate / this.targetRate;
    this.acc = 0; // fractional source-sample accumulator across process() calls
  }

  flush() {
    // Send a copy of the filled portion as a fresh ArrayBuffer (transferable).
    const out = new Int16Array(this.bufferIdx);
    out.set(this.buffer.subarray(0, this.bufferIdx));
    this.port.postMessage(out.buffer, [out.buffer]);
    this.bufferIdx = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channels = input;
    const len = input[0].length;
    const nch = channels.length;

    while (this.acc < len) {
      const idx = Math.floor(this.acc);
      let sum = 0;
      for (let c = 0; c < nch; c++) sum += channels[c][idx];
      const s = Math.max(-1, Math.min(1, sum / nch));
      this.buffer[this.bufferIdx++] = (s * 32767) | 0;
      if (this.bufferIdx >= this.chunkSamples) this.flush();
      this.acc += this.ratio;
    }
    this.acc -= len;
    return true;
  }
}

registerProcessor('cairn-pcm', CairnPCMProcessor);
