import type { TranscriptPartial, TranscriptFinal } from "./ws";

// Whisper emits finals on time-window boundaries, not sentence boundaries, so a
// single utterance often arrives as 2-3 consecutive finals from the same speaker
// where neither sits on a real sentence break. We collapse those into one row at
// render time when the previous line didn't end in terminal punctuation and the
// new line starts mid-sentence.
function canMergeSentence(prev: string, next: string): boolean {
  if (!prev || !next) return false;
  const trimmedPrev = prev.replace(/[\s"')\]]+$/, "");
  const lastChar = trimmedPrev.slice(-1);
  const prevEndsSentence = /[.!?…]/.test(lastChar);
  const trimmedNext = next.trimStart();
  const nextStartsLower = /^[a-z]/.test(trimmedNext);
  return !prevEndsSentence && nextStartsLower;
}

export class TranscriptView {
  private el: HTMLElement;
  private bySeq = new Map<number, HTMLElement>();
  private lastFinalRow: HTMLElement | null = null;
  private lastFinalSpeaker: string | null = null;
  constructor(root: HTMLElement) { this.el = root; }

  partial(m: TranscriptPartial) {
    let row = this.bySeq.get(m.seq);
    if (!row) {
      row = document.createElement("div");
      row.className = "line partial";
      row.innerHTML = `<span class="spk" data-spk="?">…</span><span class="text"></span>`;
      this.bySeq.set(m.seq, row);
      this.el.appendChild(row);
    }
    row.querySelector<HTMLElement>(".text")!.textContent = m.text;
    row.scrollIntoView({ block: "end" });
  }

  final(m: TranscriptFinal, speakerLabel: { name: string|null, color: string }) {
    let row = this.bySeq.get(m.seq);
    if (!row) {
      row = document.createElement("div");
      row.className = "line";
      row.innerHTML = `<span class="spk"></span><span class="text"></span>`;
      this.bySeq.set(m.seq, row);
      this.el.appendChild(row);
    }
    row.classList.remove("partial");
    const spk = row.querySelector<HTMLElement>(".spk")!;
    spk.dataset.spk = m.speaker_id;
    spk.style.background = speakerLabel.color + "33";
    spk.style.color = speakerLabel.color;
    spk.textContent = speakerLabel.name ?? m.speaker_id;
    const textEl = row.querySelector<HTMLElement>(".text")!;
    textEl.textContent = m.text;

    if (
      this.lastFinalRow &&
      this.lastFinalRow !== row &&
      this.lastFinalSpeaker === m.speaker_id
    ) {
      const prevTextEl = this.lastFinalRow.querySelector<HTMLElement>(".text")!;
      const prevText = prevTextEl.textContent ?? "";
      if (canMergeSentence(prevText, m.text)) {
        prevTextEl.textContent = prevText.replace(/[\s,;:]+$/, "") + " " + m.text;
        for (const [seq, r] of this.bySeq) {
          if (r === row) this.bySeq.set(seq, this.lastFinalRow);
        }
        row.remove();
        row = this.lastFinalRow;
      }
    }

    this.lastFinalRow = row;
    this.lastFinalSpeaker = m.speaker_id;
  }

  // Re-skin all rows when a speaker is renamed/recolored
  applySpeaker(speakerId: string, name: string|null, color: string) {
    this.el.querySelectorAll<HTMLElement>(`.line .spk[data-spk="${speakerId}"]`).forEach(spk => {
      spk.style.background = color + "33";
      spk.style.color = color;
      spk.textContent = name ?? speakerId;
    });
  }
}
