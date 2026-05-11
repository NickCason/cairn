import { CairnWS, TranscriptFinal, TranscriptPartial, SpeakerAssigned, ServerMsg, TranscriptSplitMsg } from "./ws.js";
import { TranscriptView } from "./transcript.js";
import { SpeakersPanel } from "./speakers.js";
import { handleRollingSummary, handleRollingReplace, handleFinalSummary, redrawSummaries, resetSummaryCache } from "./summary.js";
import { substituteSpeakerVariants } from "./speaker-substitute.js";

const CAIRN_SVC_URL = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/transcribe`;


const speakers = new SpeakersPanel(document.getElementById("speakers")!, (s) => {
  transcript.applySpeaker(s.id, s.name, s.color);
  ws?.rename(s.id, s.name ?? s.id, s.color);
  redrawSummaries(speakers.list().map((sp) => ({ id: sp.id, name: sp.name, color: sp.color })));
  if (sessionState === "stopped" && savedSessionDir) {
    // WS is closed; rewrite the saved file in place by re-calling saveSession
    // with the baked events. The IPC handler already overwrites the file.
    const baked = bakeNamesIntoEvents(eventsLog, speakers.list().map((sp) => ({ id: sp.id, name: sp.name })));
    void fetch("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ meeting_name: meetingName, events: baked }),
    });
  }
});
const transcript = new TranscriptView(document.getElementById("transcript-lines")!, {
  onTextEdit: (seq, text) => {
    eventsLog.push({ type: "transcript_edit", seq, text, _recv_ts: Date.now() });
  },
  onSpeakerEdit: (seq, speakerId) => {
    eventsLog.push({ type: "transcript_edit", seq, speaker_id: speakerId, _recv_ts: Date.now() });
  },
  listSpeakers: () => speakers.list(),
  createSpeaker: () => speakers.createManual(),
});

const $status = document.getElementById("status")!;
const $elapsed = document.getElementById("elapsed")!;
const $recdot = document.getElementById("recdot")!;
const $stop = document.getElementById("stopbtn")! as HTMLButtonElement;
const $start = document.getElementById("startbtn")! as HTMLButtonElement;
const $logo = document.getElementById("logo")!;
const $meeting = document.getElementById("meeting")!;
const $clear = document.getElementById("clearbtn")! as HTMLButtonElement;
const $devicePicker = document.getElementById("device-picker")! as HTMLSelectElement;
const $viewTranscript = document.getElementById("view-transcript") as HTMLButtonElement | null;
const $viewSummary = document.getElementById("view-summary") as HTMLButtonElement | null;
const $transcriptLines = document.getElementById("transcript-lines");
const $finalSummary = document.getElementById("final-summary");

(async () => {
  const svgRes = await fetch("/assets/icons/cairn.svg");
  $logo.innerHTML = await svgRes.text();
})();

let ws: CairnWS | null = null;
let started: number | null = null;
let elapsedTimer: number | null = null;
let meetingName = "Cairn";
let eventsLog: any[] = [];
let stopAudio: (() => Promise<void>) | null = null;
let savedSessionDir: string | null = null;
let sessionState: "idle" | "recording" | "stopped" = "idle";

// === Device picker ===
// Safari rotates `deviceId` per session until getUserMedia has been called, so
// we persist a label alongside the id and prefer the label-match on reload.
function loadDeviceId(): string {
  return localStorage.getItem("cairn.deviceId") ?? "default";
}
function loadDeviceLabel(): string | null {
  return localStorage.getItem("cairn.deviceLabel");
}
function saveDevice(id: string, label: string) {
  localStorage.setItem("cairn.deviceId", id);
  if (label) localStorage.setItem("cairn.deviceLabel", label);
}
let currentDeviceId = loadDeviceId();

async function refreshDeviceList() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter(d => d.kind === "audioinput");
    const savedLabel = loadDeviceLabel();
    $devicePicker.innerHTML = "";
    const defaultOpt = document.createElement("option");
    defaultOpt.value = "default";
    defaultOpt.textContent = "Default input";
    $devicePicker.appendChild(defaultOpt);
    for (const d of inputs) {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || `Device ${d.deviceId.slice(0, 6)}`;
      $devicePicker.appendChild(opt);
    }
    // Prefer label match (survives Safari deviceId rotation); fall back to
    // previous id match; then default.
    const labelMatch = savedLabel ? inputs.find(d => d.label === savedLabel) : undefined;
    if (labelMatch) {
      $devicePicker.value = labelMatch.deviceId;
    } else {
      const exists = Array.from($devicePicker.options).some(o => o.value === currentDeviceId);
      $devicePicker.value = exists ? currentDeviceId : "default";
    }
    currentDeviceId = $devicePicker.value;
  } catch (err) {
    console.warn("enumerateDevices failed:", err);
  }
}
refreshDeviceList();

// Warm-up mic permission so deviceIds stabilize and labels populate before
// the user clicks Start. With Safari "Always Allow", this is silent.
(async () => {
  try {
    const warm = await navigator.mediaDevices.getUserMedia({ audio: true });
    warm.getTracks().forEach(t => t.stop());
    await refreshDeviceList();
  } catch {
    // permission not yet granted — refreshDeviceList re-runs after Start.
  }
})();

$devicePicker.onchange = async () => {
  currentDeviceId = $devicePicker.value;
  const opt = $devicePicker.options[$devicePicker.selectedIndex];
  saveDevice(currentDeviceId, opt?.textContent ?? "");
  // If a session is currently capturing, restart audio with the new device
  if (stopAudio && ws) {
    const oldStop = stopAudio;
    stopAudio = null;
    try { await oldStop(); } catch {}
    const { startLiveCapture } = await import("./audio.js");
    try {
      stopAudio = await startLiveCapture(
        (chunk: ArrayBuffer) => ws!.sendAudio(chunk),
        (err: Error) => { $status.textContent = `mic error: ${err.message}`; },
        currentDeviceId,
      );
    } catch (err) {
      console.error("device switch failed:", err);
    }
  }
};

function onMsg(m: ServerMsg) {
  eventsLog.push({ ...m, _recv_ts: Date.now() });
  if (m.type === "transcript_partial") transcript.partial(m as TranscriptPartial);
  else if (m.type === "transcript_final") {
    const sp = speakers.get(m.speaker_id);
    transcript.final(m as TranscriptFinal, { name: sp.name, color: sp.color });
  } else if (m.type === "speaker_assigned") {
    speakers.add(m.speaker_id, m.color_hint);
  } else if (m.type === "rolling_summary") {
    handleRollingSummary(m as any);
  } else if (m.type === "rolling_summary_replace") {
    handleRollingReplace(m as any);
  } else if (m.type === "final_summary") {
    handleFinalSummary(m as any);
  } else if (m.type === "speaker_merge") {
    const dstSpeaker = speakers.get(m.dst);
    speakers.merge(m.src, m.dst);
    transcript.mergeSpeakers(m.src, m.dst, dstSpeaker.name, dstSpeaker.color);
  } else if (m.type === "speaker_relabel") {
    const dst = speakers.get(m.speaker_id);
    transcript.relabelLine(m.seq, m.speaker_id, dst.name, dst.color);
  } else if (m.type === "transcript_split") {
    transcript.splitLine(m.original_seq, m.rows, (id) => speakers.get(id));
  } else if ((m as any).type === "control_stop") {
    stopLiveSession();
  } else if (m.type === "ack" && m.of === "start") {
    sessionState = "recording";
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
    $status.textContent = "summarizing…";
    awaitFinalSummaryThenFinalize();
  }
}

// Wait for the server's final_summary (success or failure) before writing
// transcript.jsonl, so the persisted log includes it. Falls back on a timeout
// (server LLM is bounded by CAIRN_LLM_TIMEOUT_S + drain ≈ 90 + 30s, plus margin).
let finalizing = false;
function awaitFinalSummaryThenFinalize() {
  if (finalizing) return;
  finalizing = true;
  const FINAL_WAIT_MS = 150_000;
  const startedAt = Date.now();
  const seen = () => eventsLog.some((e) => e.type === "final_summary");
  const tick = () => {
    if (seen() || Date.now() - startedAt > FINAL_WAIT_MS) {
      finalizing = false;
      finalizeSession();
      return;
    }
    setTimeout(tick, 250);
  };
  tick();
}

function bakeNamesIntoEvents(events: any[], registry: { id: string; name: string | null }[]): any[] {
  const named = registry.filter((r) => r.name && r.name !== r.id) as { id: string; name: string }[];
  if (!named.length) return events;
  const subAll = (text: string): string => {
    let t = text;
    for (const r of named) t = substituteSpeakerVariants(t, r.id, r.name);
    return t;
  };
  return events.map((e) => {
    if (e.type === "rolling_summary" || e.type === "rolling_summary_replace") {
      return { ...e, bullets: (e.bullets || []).map(subAll) };
    }
    if (e.type === "final_summary" && e.ok) {
      return {
        ...e,
        tldr: subAll(e.tldr || ""),
        speakers: (e.speakers || []).map((sp: any) => ({
          ...sp,
          speaker: subAll(sp.speaker || ""),
          contributions: (sp.contributions || []).map(subAll),
        })),
        decisions: (e.decisions || []).map(subAll),
        action_items: (e.action_items || []).map((a: any) => ({
          ...a,
          assignee: subAll(a.assignee || ""),
          item: subAll(a.item || ""),
        })),
      };
    }
    return e;
  });
}

async function finalizeSession() {
  $recdot.hidden = true;
  $stop.hidden = true;
  if (elapsedTimer) clearInterval(elapsedTimer);
  const baked = bakeNamesIntoEvents(eventsLog, speakers.list().map((s) => ({ id: s.id, name: s.name })));
  const res = await fetch("/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ meeting_name: meetingName, events: baked }),
  });
  const { session_dir } = await res.json();
  savedSessionDir = session_dir;
  const dir = session_dir;
  sessionState = "stopped";
  $status.textContent = `saved → ${dir.split("/").slice(-1)[0]}`;

  // Keep the window open, allow restart
  $start.hidden = false;
  $start.disabled = false;
  $start.textContent = "Start";
  $clear.hidden = false;
}

function clearTranscript() {
  document.getElementById("transcript-lines")!.innerHTML = "";
  document.getElementById("speakers")!.innerHTML = "";
  $elapsed.textContent = "00:00:00";
  eventsLog = [];
  // Reset speakers panel internal state so renamed/colored speakers from prior session don't carry over
  speakers.reset();
  resetSummaryCache();
  $clear.hidden = true;
  $status.textContent = "ready";
}

$clear.onclick = clearTranscript;

async function stopLiveSession() {
  $stop.disabled = true;
  $stop.textContent = "stopping…";
  $recdot.hidden = true;
  $status.textContent = "stopping";
  if (stopAudio) { try { await stopAudio(); } catch {} stopAudio = null; }
  ws?.stop();
}

$stop.onclick = () => { stopLiveSession(); };

async function startLiveSession() {
  sessionState = "idle";
  $start.hidden = true;
  $clear.hidden = true;
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
  ws.start(meetingName);

  const { startLiveCapture } = await import("./audio.js");
  try {
    stopAudio = await startLiveCapture(
      (chunk: ArrayBuffer) => ws!.sendAudio(chunk),
      (err: Error) => { $status.textContent = `mic error: ${err.message}`; },
      currentDeviceId,
    );
    // Permission is now granted — re-enumerate so labels populate
    refreshDeviceList();
  } catch (err) {
    console.error("live capture failed:", err);
    $status.textContent = "mic error";
    $start.hidden = false;
  }
}

$start.onclick = () => { startLiveSession(); };

$viewTranscript?.addEventListener("click", () => {
  if ($transcriptLines) $transcriptLines.hidden = false;
  if ($finalSummary) $finalSummary.hidden = true;
});
$viewSummary?.addEventListener("click", () => {
  if ($transcriptLines) $transcriptLines.hidden = true;
  if ($finalSummary) $finalSummary.hidden = false;
});

const params = new URLSearchParams(location.search);
const urlMeetingName = params.get("meeting_name");
const urlAutostart = params.get("autostart") === "1";

(async () => {
  meetingName = urlMeetingName ?? "Cairn";
  $meeting.textContent = meetingName === "Cairn" ? "Cairn" : `loop · ${meetingName}`;
  if (urlAutostart) {
    await startLiveSession();
  } else {
    $start.hidden = false;
  }
})();
