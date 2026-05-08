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

async function finalizeSession() {
  $recdot.hidden = true;
  $stop.hidden = true;
  if (elapsedTimer) clearInterval(elapsedTimer);
  const dir = await window.cairn.saveSession(meetingName, eventsLog);
  $status.textContent = `saved → ${dir}`;
  // for benchmark: quit after a short delay so the wrapper can read JSONL
  setTimeout(() => window.close(), 1500);
}

$stop.onclick = () => ws?.stop();

window.cairn.onInit(async ({ testFile, screenshotMode }: { testFile: string|null; screenshotMode?: string|null }) => {
  // Screenshot fixture mode: skip WebSocket entirely, populate with fake data
  if (screenshotMode) {
    meetingName = "vendor-sync";
    $status.textContent = "live · recording";
    const { loadFixture } = await import("./screenshot-fixture.js");
    loadFixture(onMsg, $elapsed, $meeting, $recdot, $stop);
    return;
  }

  meetingName = testFile ? "benchmark-four-speaker" : "live";
  $meeting.textContent = testFile ? `benchmark · ${testFile.split("/").pop()}` : "Cairn";
  ws = new CairnWS(CAIRN_SVC_URL, onMsg, (s) => $status.textContent = s);
  await ws.connect();
  // No num_speakers hint — let pyannote auto-detect speaker count
  ws.start(meetingName);

  if (testFile) {
    const { streamWavFile } = await import("./test-runner.js");
    await streamWavFile(testFile, (buf: ArrayBuffer) => ws!.sendAudio(buf));
    setTimeout(() => ws?.stop(), 6000);
  }
});
