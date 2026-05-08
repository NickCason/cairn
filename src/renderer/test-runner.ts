/** Read a 16k mono PCM WAV via Electron IPC and stream chunks to a callback at ~real time. */

const SAMPLE_RATE = 16000;
const CHUNK_SECONDS = 3.0;
const DEFAULT_PLAYBACK_SPEED = 2.0;  // 2x for faster benchmark turnaround

function parseWav(buf: ArrayBuffer): { samples: Int16Array; sampleRate: number } {
  const dv = new DataView(buf);
  // Find "fmt " and "data" chunks
  let off = 12;
  let sampleRate = 0; let dataOffset = 0; let dataLen = 0;
  while (off < buf.byteLength - 8) {
    const id = String.fromCharCode(dv.getUint8(off), dv.getUint8(off+1), dv.getUint8(off+2), dv.getUint8(off+3));
    const sz = dv.getUint32(off+4, true);
    if (id === "fmt ") sampleRate = dv.getUint32(off+12, true);
    else if (id === "data") { dataOffset = off+8; dataLen = sz; break; }
    off += 8 + sz;
  }
  const samples = new Int16Array(buf, dataOffset, dataLen / 2);
  return { samples, sampleRate };
}

export async function streamWavFile(
  path: string,
  send: (chunk: ArrayBuffer) => void,
  playbackSpeed: number = DEFAULT_PLAYBACK_SPEED,
): Promise<void> {
  const data: any = await window.cairn.readFile(path);  // Buffer (Node) -> Uint8Array
  const ab: ArrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const { samples, sampleRate } = parseWav(ab);
  if (sampleRate !== SAMPLE_RATE) {
    console.warn(`WAV sample rate ${sampleRate} != expected ${SAMPLE_RATE}; sending anyway`);
  }
  const samplesPerChunk = Math.floor(SAMPLE_RATE * CHUNK_SECONDS);
  for (let i = 0; i < samples.length; i += samplesPerChunk) {
    const slice = samples.subarray(i, Math.min(i + samplesPerChunk, samples.length));
    // copy into a fresh ArrayBuffer (subarray shares memory)
    const out = new ArrayBuffer(slice.length * 2);
    new Int16Array(out).set(slice);
    send(out);
    await new Promise(r => setTimeout(r, (CHUNK_SECONDS * 1000) / playbackSpeed));
  }
}
