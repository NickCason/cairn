import type { ServerMsg } from "./ws.js";

// Fixture data derived from benchmarks/script.json (Rockwell PLC vendor sync)
const FIXTURE_SPEAKERS = [
  { speaker_id: "spk_0", color_hint: "#79c0ff" },  // JIM
  { speaker_id: "spk_1", color_hint: "#e3b341" },  // MARIA
  { speaker_id: "spk_2", color_hint: "#56d364" },  // SARA
  { speaker_id: "spk_3", color_hint: "#ff7b72" },  // DAVE
];

const FIXTURE_NAMES: Record<string, string> = {
  spk_0: "Jim",
  spk_1: "Maria",
  spk_2: "Sara",
  spk_3: "Dave",
};

// Mix of final and partial transcript entries to show realistic state
const FIXTURE_LINES: Array<{ seq: number; speaker_id?: string; text: string; final: boolean }> = [
  { seq: 1, speaker_id: "spk_0", text: "Alright everyone, let's lock in the controller pick for the new line.", final: true },
  { seq: 2, speaker_id: "spk_1", text: "On our side we're recommending the 1756-L83E. Six week lead time if we order by Friday.", final: true },
  { seq: 3, speaker_id: "spk_0", text: "Got it. The L83E gives us the redundancy slot we need?", final: true },
  { seq: 4, speaker_id: "spk_1", text: "Yes, and the EtherNet/IP bandwidth is doubled compared to the L75.", final: true },
  { seq: 5, speaker_id: "spk_2", text: "What about the remote skids — are we keeping 5069 I/O on those?", final: true },
  { seq: 6, speaker_id: "spk_1", text: "The 5069-L320ER will handle the remote drops, same EtherNet/IP backbone.", final: true },
  { seq: 7, speaker_id: "spk_3", text: "From a purchasing angle, six weeks is tight. Can we get a unit pre-staged?", final: true },
  { seq: 8, speaker_id: "spk_1", text: "I can ask the warehouse if we have one on the shelf, but no promises.", final: true },
  { seq: 9, speaker_id: "spk_0", text: "Okay let's also drop the legacy ControlNet gateway. 1756-CN2R is end of life.", final: true },
  { seq: 10, speaker_id: "spk_2", text: "Agreed. Pure EtherNet/IP everywhere. I'll update the network drawing tomorrow.", final: true },
  // Partial line showing current speaker
  { seq: 11, text: "Send me the revised BOM before Friday close so I can cut the PO…", final: false },
];

export function loadFixture(
  onMsg: (m: ServerMsg) => void,
  $elapsed: HTMLElement,
  $meeting: HTMLElement,
  $recdot: HTMLElement,
  $stop: HTMLButtonElement
) {
  // Set meeting name
  $meeting.textContent = "vendor-sync";

  // Directly show rec dot and stop button — bypass the ack/start path so the
  // elapsed timer interval is never started (which would overwrite our fixed time).
  $recdot.hidden = false;
  $stop.hidden = false;

  // Set a fixed elapsed time
  $elapsed.textContent = "00:14:32";

  // Add speakers first
  for (const spk of FIXTURE_SPEAKERS) {
    onMsg({ type: "speaker_assigned", speaker_id: spk.speaker_id, color_hint: spk.color_hint });
  }

  // Rename speakers to real names via speaker_rename-equivalent
  // We do this by setting names after add via a synthetic approach:
  // speakers.add() just sets name=null. We'll dispatch speaker events that transcript uses.
  // The SpeakersPanel.rename() is triggered by user interaction; for fixture we instead
  // fire an additional final transcript line which will show speaker names via the speaker panel lookup.
  // The spkname spans are contenteditable — we'll set them directly via DOM after the speaker rows render.

  // Feed transcript events
  let seq_offset = 0;
  for (const line of FIXTURE_LINES) {
    if (line.final && line.speaker_id) {
      onMsg({
        type: "transcript_final",
        seq: line.seq,
        text: line.text,
        speaker_id: line.speaker_id,
        t_start_ms: seq_offset * 5000,
        t_end_ms: seq_offset * 5000 + 3000,
      });
    } else {
      onMsg({
        type: "transcript_partial",
        seq: line.seq,
        text: line.text,
        t_start_ms: seq_offset * 5000,
        t_end_ms: seq_offset * 5000 + 1000,
      });
    }
    seq_offset++;
  }

  // After speakers have been added, set display names by directly manipulating the DOM
  // (SpeakersPanel renders after add() — we just patch the rendered .spkname elements)
  requestAnimationFrame(() => {
    const rows = document.querySelectorAll<HTMLElement>(".spkrow");
    const speakerIds = FIXTURE_SPEAKERS.map(s => s.speaker_id);
    rows.forEach((row, i) => {
      const nameEl = row.querySelector<HTMLElement>(".spkname");
      if (nameEl && speakerIds[i]) {
        nameEl.textContent = FIXTURE_NAMES[speakerIds[i]] ?? speakerIds[i];
      }
    });
    // Re-apply speaker labels in transcript to match names
    const spkChips = document.querySelectorAll<HTMLElement>(".line .spk[data-spk]");
    spkChips.forEach(chip => {
      const spkId = chip.dataset.spk ?? "";
      if (FIXTURE_NAMES[spkId]) {
        chip.textContent = FIXTURE_NAMES[spkId];
      }
    });
  });
}
