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
    const ch = input[0]; // mono — first channel only

    // Walk the source samples at this.ratio increments, picking nearest-neighbor.
    while (this.acc < ch.length) {
      const idx = Math.floor(this.acc);
      const s = Math.max(-1, Math.min(1, ch[idx]));
      this.buffer[this.bufferIdx++] = (s * 32767) | 0;
      if (this.bufferIdx >= this.chunkSamples) this.flush();
      this.acc += this.ratio;
    }
    // Carry remainder into the next process() call.
    this.acc -= ch.length;
    return true;
  }
}

registerProcessor('cairn-pcm', CairnPCMProcessor);
