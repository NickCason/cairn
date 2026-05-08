import type { TranscriptPartial, TranscriptFinal } from "./ws";

export class TranscriptView {
  private el: HTMLElement;
  private bySeq = new Map<number, HTMLElement>();
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
    row.querySelector<HTMLElement>(".text")!.textContent = m.text;
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
