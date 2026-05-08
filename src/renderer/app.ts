import { CairnWS, TranscriptFinal, TranscriptPartial, SpeakerAssigned, ServerMsg } from "./ws.js";
import { TranscriptView } from "./transcript.js";
import { SpeakersPanel } from "./speakers.js";

const CAIRN_SVC_URL = "ws://100.99.99.72:8300/ws/transcribe";

declare global { interface Window { cairn: {
  onInit:(cb:(d:any)=>void)=>void;
  readFile:(p:string)=>Promise<Buffer>;
  saveSession:(name:string, events:any[])=>Promise<string>;
} } }

const transcript = new TranscriptView(document.getElementById("transcript-lines")!);
const speakers = new SpeakersPanel(document.getElementById("speakers")!, (s) => {
  transcript.applySpeaker(s.id, s.name, s.color);
  ws?.rename(s.id, s.name ?? s.id, s.color);
});

const $status = document.getElementById("status")!;
const $elapsed = document.getElementById("elapsed")!;
const $recdot = document.getElementById("recdot")!;
const $stop = document.getElementById("stopbtn")! as HTMLButtonElement;
const $logo = document.getElementById("logo")!;
const $meeting = document.getElementById("meeting")!;

(async () => {
  const svgRes = await fetch("../icons/cairn.svg");
  $logo.innerHTML = await svgRes.text();
})();

let ws: CairnWS | null = null;
let started: number | null = null;
let elapsedTimer: number | null = null;
let meetingName = "Cairn";
const eventsLog: any[] = [];

function onMsg(m: ServerMsg) {
  eventsLog.push({ ...m, _recv_ts: Date.now() });
  if (m.type === "transcript_partial") transcript.partial(m as TranscriptPartial);
  else if (m.type === "transcript_final") {
    const sp = speakers.get(m.speaker_id);
    transcript.final(m as TranscriptFinal, { name: sp.name, color: sp.color });
  } else if (m.type === "speaker_assigned") {
    speakers.add(m.speaker_id, m.color_hint);
  } else if (m.type === "ack" && m.of === "start") {
    started = Date.now();
    elapsedTimer = window.setInterval(() => {
      if (!started) return;
      const s = Math.floor((Date.now() - started)/1000);
      $elapsed.textContent = `${String(Math.floor(s/3600)).padStart(2,"0")}:${String(Math.floor(s/60)%60).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;
    }, 500);
    $recdot.hidden = false;
    $stop.hidden = false;
  } else if (m.type === "ack" && m.of === "stop") {
    finalizeSession();
  }
}

let demoModeActive: string | null = null;

async function finalizeSession() {
  $recdot.hidden = true;
  $stop.hidden = true;
  if (elapsedTimer) clearInterval(elapsedTimer);
  const dir = await window.cairn.saveSession(meetingName, eventsLog);
  $status.textContent = `saved → ${dir}`;
  // demo-mode: linger 5 s so recording captures final state; benchmark: 1.5 s
  const dwell = demoModeActive ? 5000 : 1500;
  setTimeout(() => window.close(), dwell);
}

let stopAudio: (() => Promise<void>) | null = null;

$stop.onclick = async () => {
  // Immediate visual feedback; finalizeSession() will tidy up when ack/stop arrives.
  $stop.disabled = true;
  $stop.textContent = "stopping…";
  $recdot.hidden = true;
  $status.textContent = "stopping";
  if (stopAudio) { try { await stopAudio(); } catch {} stopAudio = null; }
  ws?.stop();
};

window.cairn.onInit(async ({ testFile, screenshotMode, demoMode, numSpeakers }: { testFile: string|null; screenshotMode?: string|null; demoMode?: string|null; numSpeakers?: number|null }) => {
  // Screenshot fixture mode: skip WebSocket entirely, populate with fake data
  if (screenshotMode) {
    meetingName = "vendor-sync";
    $status.textContent = "live · recording";
    const { loadFixture } = await import("./screenshot-fixture.js");
    loadFixture(onMsg, $elapsed, $meeting, $recdot, $stop);
    return;
  }

  if (demoMode) demoModeActive = demoMode;

  meetingName = testFile ? "benchmark-four-speaker" : "live";
  // Live mode default: 1 speaker (solo dictation). Override via --speakers=N or --speakers=auto.
  // Auto-detect tends to over-split a single voice on clean Mac audio.
  const speakerHint = numSpeakers === undefined ? (testFile ? null : 1) : numSpeakers;
  const speakerLabel = speakerHint === null ? "auto" : `${speakerHint}`;
  $meeting.textContent = testFile
    ? `benchmark · ${testFile.split("/").pop()}`
    : `Cairn · ${speakerLabel} speaker${speakerHint === 1 ? "" : "s"}`;
  ws = new CairnWS(CAIRN_SVC_URL, onMsg, (s) => $status.textContent = s);
  await ws.connect();
  ws.start(meetingName, speakerHint);

  if (testFile) {
    const { streamWavFile } = await import("./test-runner.js");
    // demo-mode: real-time (1×); benchmark path: 2× for faster turnaround
    const speed = demoMode ? 1.0 : 2.0;
    await streamWavFile(testFile, (buf: ArrayBuffer) => ws!.sendAudio(buf), speed);
    setTimeout(() => ws?.stop(), 6000);
  } else {
    // Live mode: capture from default input device, stream PCM chunks to n4.
    const { startLiveCapture } = await import("./audio.js");
    try {
      stopAudio = await startLiveCapture(
        (chunk: ArrayBuffer) => ws!.sendAudio(chunk),
        (err: Error) => { $status.textContent = `mic error: ${err.message}`; },
      );
    } catch (err) {
      console.error("live capture failed:", err);
    }
  }
});
