/** Live mic capture: getUserMedia → AudioWorklet → Int16 PCM 16 kHz chunks. */

export type AudioStopFn = () => Promise<void>;

export async function startLiveCapture(
  send: (chunk: ArrayBuffer) => void,
  onError: (err: Error) => void,
): Promise<AudioStopFn> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
      video: false,
    });
  } catch (err) {
    onError(err as Error);
    throw err;
  }

  const ctx = new AudioContext();
  // Worklet file is served from the same dir as index.html (renderer/).
  // audio-worklet.js sits next to index.html (sibling relative URL).
  await ctx.audioWorklet.addModule("audio-worklet.js");
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "cairn-pcm");

  node.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
    send(ev.data);
  };

  source.connect(node);
  // Note: deliberately not connecting node → ctx.destination, so we don't
  // play the mic back through the speakers.

  return async () => {
    try { source.disconnect(); } catch {}
    try { node.disconnect(); } catch {}
    for (const t of stream.getTracks()) t.stop();
    await ctx.close();
  };
}

/** Devices the user could pick from in the future (not surfaced in UI yet). */
export async function listInputDevices(): Promise<MediaDeviceInfo[]> {
  // Permissions need to have been granted at least once for labels to be populated.
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter(d => d.kind === "audioinput");
}
