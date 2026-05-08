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
const $start = document.getElementById("startbtn")! as HTMLButtonElement;
const $logo = document.getElementById("logo")!;
const $meeting = document.getElementById("meeting")!;
const $speakersToggle = document.getElementById("speakers-toggle")! as HTMLButtonElement;

(async () => {
  const svgRes = await fetch("../icons/cairn.svg");
  $logo.innerHTML = await svgRes.text();
})();

let ws: CairnWS | null = null;
let started: number | null = null;
let elapsedTimer: number | null = null;
let meetingName = "Cairn";
let eventsLog: any[] = [];
let stopAudio: (() => Promise<void>) | null = null;
let demoModeActive: string | null = null;
let isLiveMode = false;
let isBenchmarkMode = false;

// Speaker-count toggle: cycles through these values. null = auto.
const SPEAKER_VALUES: (number | null)[] = [null, 1, 2, 3, 4, 6];
function loadSpeakers(): number | null {
  const saved = localStorage.getItem("cairn.numSpeakers");
  if (saved === null) return 1; // first-launch default for live mode
  if (saved === "auto") return null;
  const n = parseInt(saved, 10);
  return isNaN(n) ? null : n;
}
function saveSpeakers(n: number | null) {
  localStorage.setItem("cairn.numSpeakers", n === null ? "auto" : String(n));
}
function speakerLabel(n: number | null): string {
  return n === null ? "auto" : `${n} speaker${n === 1 ? "" : "s"}`;
}
let currentSpeakers: number | null = loadSpeakers();
function refreshSpeakerToggleLabel() {
  $speakersToggle.textContent = speakerLabel(currentSpeakers);
}
refreshSpeakerToggleLabel();

$speakersToggle.onclick = () => {
  const idx = SPEAKER_VALUES.findIndex(v => v === currentSpeakers);
  currentSpeakers = SPEAKER_VALUES[(idx + 1) % SPEAKER_VALUES.length];
  saveSpeakers(currentSpeakers);
  refreshSpeakerToggleLabel();
  // Apply immediately if a session is in progress; otherwise it'll be used on next start.
  if (ws) ws.setNumSpeakers(currentSpeakers);
};

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
    $stop.disabled = false;
    $stop.textContent = "Stop";
    $start.hidden = true;
  } else if (m.type === "ack" && m.of === "stop") {
    finalizeSession();
  }
}

async function finalizeSession() {
  $recdot.hidden = true;
  $stop.hidden = true;
  if (elapsedTimer) clearInterval(elapsedTimer);
  const dir = await window.cairn.saveSession(meetingName, eventsLog);
  $status.textContent = `saved → ${dir.split("/").slice(-1)[0]}`;

  if (demoModeActive || isBenchmarkMode) {
    // benchmark / demo: close the window so the test runner / recording can finish
    const dwell = demoModeActive ? 5000 : 1500;
    setTimeout(() => window.close(), dwell);
    return;
  }

  // Live mode: keep the window open, allow restart
  $start.hidden = false;
  $start.disabled = false;
  $start.textContent = "Start";
}

$stop.onclick = async () => {
  $stop.disabled = true;
  $stop.textContent = "stopping…";
  $recdot.hidden = true;
  $status.textContent = "stopping";
  if (stopAudio) { try { await stopAudio(); } catch {} stopAudio = null; }
  ws?.stop();
};

async function startLiveSession() {
  $start.hidden = true;
  $status.textContent = "connecting…";
  // Reset event log, transcript, and elapsed clock for the new session
  eventsLog = [];
  document.getElementById("transcript-lines")!.innerHTML = "";
  $elapsed.textContent = "00:00:00";
  started = null;
  if (ws) {
    try { ws.close(); } catch {}
  }
  ws = new CairnWS(CAIRN_SVC_URL, onMsg, (s) => $status.textContent = s);
  await ws.connect();
  ws.start(meetingName, currentSpeakers);

  const { startLiveCapture } = await import("./audio.js");
  try {
    stopAudio = await startLiveCapture(
      (chunk: ArrayBuffer) => ws!.sendAudio(chunk),
      (err: Error) => { $status.textContent = `mic error: ${err.message}`; },
    );
  } catch (err) {
    console.error("live capture failed:", err);
    $status.textContent = "mic error";
    $start.hidden = false;
  }
}

$start.onclick = () => { startLiveSession(); };

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

  // CLI override (--speakers=N or --speakers=auto) takes precedence over saved value.
  if (numSpeakers !== undefined) {
    currentSpeakers = numSpeakers;
    refreshSpeakerToggleLabel();
  }

  isBenchmarkMode = !!testFile;
  isLiveMode = !testFile;
  meetingName = testFile ? "benchmark-four-speaker" : "live";
  // Benchmark default: auto (4 speakers in the WAV — pyannote auto handles it).
  // Live default: whatever the toggle says (loadSpeakers() default = 1).
  const speakerHint = isBenchmarkMode ? null : currentSpeakers;
  $meeting.textContent = testFile
    ? `benchmark · ${testFile.split("/").pop()}`
    : `Cairn`;
  ws = new CairnWS(CAIRN_SVC_URL, onMsg, (s) => $status.textContent = s);
  await ws.connect();
  ws.start(meetingName, speakerHint);

  if (testFile) {
    const { streamWavFile } = await import("./test-runner.js");
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
