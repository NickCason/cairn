import type { TranscriptPartial, TranscriptFinal } from "./ws";

type SpeakerInfo = { id: string; name: string|null; color: string };

export type TranscriptCallbacks = {
  // Called when the user finishes editing a line's text in place. Receives
  // the seq id and the new text. Cairn pushes a transcript_edit event into
  // the event log so the saved jsonl is the authoritative record.
  onTextEdit?: (seq: number, newText: string) => void;
  // Called when the user reassigns a line to a different speaker.
  onSpeakerEdit?: (seq: number, newSpeakerId: string) => void;
  // Picker data sources.
  listSpeakers?: () => SpeakerInfo[];
  createSpeaker?: () => SpeakerInfo;
};

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

function isLocked(row: HTMLElement): boolean {
  return row.dataset.locked === "1";
}

export class TranscriptView {
  private el: HTMLElement;
  private bySeq = new Map<number, HTMLElement>();
  private lastFinalRow: HTMLElement | null = null;
  private lastFinalSpeaker: string | null = null;
  private cb: TranscriptCallbacks;
  constructor(root: HTMLElement, cb: TranscriptCallbacks = {}) {
    this.el = root;
    this.cb = cb;
  }

  partial(m: TranscriptPartial) {
    let row = this.bySeq.get(m.seq);
    if (row && isLocked(row)) return;
    if (!row) {
      row = this.createRow("line partial", m.seq, /*finalized=*/false);
      this.el.appendChild(row);
    }
    row.querySelector<HTMLElement>(".text")!.textContent = m.text;
    row.scrollIntoView({ block: "end" });
  }

  final(m: TranscriptFinal, speakerLabel: { name: string|null, color: string }) {
    let row = this.bySeq.get(m.seq);
    if (row && isLocked(row)) return;
    if (!row) {
      row = this.createRow("line", m.seq, /*finalized=*/true);
      this.el.appendChild(row);
    }
    row.classList.remove("partial");
    this.assignRowSpeakerVisuals(row, m.speaker_id, speakerLabel.name, speakerLabel.color);
    const textEl = row.querySelector<HTMLElement>(".text")!;
    textEl.textContent = m.text;
    // Speaker pill is interactive only after finalization.
    this.attachSpeakerClick(row, m.seq);

    if (
      this.lastFinalRow &&
      this.lastFinalRow !== row &&
      !isLocked(this.lastFinalRow) &&
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

  // ---- internal: row construction + interaction ---------------------------

  private createRow(className: string, seq: number, finalized: boolean): HTMLElement {
    const row = document.createElement("div");
    row.className = className;
    row.dataset.seq = String(seq);
    const placeholder = finalized ? "" : "?";
    const spkInner = finalized ? "" : "…";
    row.innerHTML =
      `<span class="spk" data-spk="${placeholder}">${spkInner}</span>` +
      `<span class="text"></span>`;
    this.bySeq.set(seq, row);
    this.attachTextClick(row, seq);
    return row;
  }

  private attachTextClick(row: HTMLElement, seq: number) {
    if (!this.cb.onTextEdit) return;
    const textEl = row.querySelector<HTMLElement>(".text")!;
    textEl.classList.add("editable");
    textEl.title = "Click to edit";
    textEl.addEventListener("click", (ev) => {
      // Don't trigger when the user is just selecting text inside an active edit.
      if (textEl.isContentEditable) return;
      ev.stopPropagation();
      this.startTextEdit(row, seq);
    });
  }

  private attachSpeakerClick(row: HTMLElement, seq: number) {
    if (!this.cb.onSpeakerEdit || !this.cb.listSpeakers) return;
    const spk = row.querySelector<HTMLElement>(".spk")!;
    if (spk.dataset.bound === "1") return;
    spk.dataset.bound = "1";
    spk.classList.add("clickable");
    spk.title = "Click to reassign speaker";
    spk.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.openSpeakerMenu(row, seq, spk);
    });
  }

  private startTextEdit(row: HTMLElement, seq: number) {
    if (!this.cb.onTextEdit) return;
    const textEl = row.querySelector<HTMLElement>(".text")!;
    if (textEl.isContentEditable) return;
    const original = textEl.textContent ?? "";
    textEl.contentEditable = "plaintext-only";
    textEl.classList.add("editing");
    textEl.focus();
    const range = document.createRange();
    range.selectNodeContents(textEl);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    let committed = false;
    const finish = (commit: boolean) => {
      if (committed) return;
      committed = true;
      textEl.contentEditable = "false";
      textEl.classList.remove("editing");
      textEl.removeEventListener("blur", onBlur);
      textEl.removeEventListener("keydown", onKey);
      const newText = (textEl.textContent ?? "").trim();
      if (commit && newText && newText !== original.trim()) {
        textEl.textContent = newText;
        row.dataset.locked = "1";
        this.cb.onTextEdit!(seq, newText);
      } else {
        textEl.textContent = original;
      }
    };
    const onBlur = () => finish(true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    };
    textEl.addEventListener("blur", onBlur);
    textEl.addEventListener("keydown", onKey);
  }

  private openSpeakerMenu(row: HTMLElement, seq: number, anchor: HTMLElement) {
    if (!this.cb.onSpeakerEdit || !this.cb.listSpeakers) return;
    document.querySelectorAll(".cairn-spk-menu").forEach(n => n.remove());
    const menu = document.createElement("div");
    menu.className = "cairn-spk-menu";
    const speakers = this.cb.listSpeakers();
    for (const s of speakers) {
      const btn = document.createElement("button");
      btn.className = "spk-opt";
      btn.style.color = s.color;
      btn.textContent = s.name ?? s.id;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.assignRowSpeaker(row, seq, s.id, s.name, s.color);
        cleanup();
      });
      menu.appendChild(btn);
    }
    if (this.cb.createSpeaker) {
      const sep = document.createElement("div");
      sep.className = "spk-sep";
      menu.appendChild(sep);
      const newBtn = document.createElement("button");
      newBtn.className = "spk-opt new";
      newBtn.textContent = "+ New speaker";
      newBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const created = this.cb.createSpeaker!();
        this.assignRowSpeaker(row, seq, created.id, created.name, created.color);
        cleanup();
      });
      menu.appendChild(newBtn);
    }
    const rect = anchor.getBoundingClientRect();
    menu.style.position = "fixed";
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.left = `${rect.left}px`;
    document.body.appendChild(menu);

    const onOutside = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) cleanup();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cleanup();
    };
    const cleanup = () => {
      menu.remove();
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("keydown", onKey);
    };
    setTimeout(() => {
      document.addEventListener("mousedown", onOutside);
      document.addEventListener("keydown", onKey);
    }, 0);
  }

  private assignRowSpeakerVisuals(row: HTMLElement, id: string, name: string|null, color: string) {
    const spk = row.querySelector<HTMLElement>(".spk")!;
    spk.dataset.spk = id;
    spk.style.background = color + "33";
    spk.style.color = color;
    spk.textContent = name ?? id;
  }

  private assignRowSpeaker(row: HTMLElement, seq: number, id: string, name: string|null, color: string) {
    this.assignRowSpeakerVisuals(row, id, name, color);
    row.dataset.locked = "1";
    this.cb.onSpeakerEdit!(seq, id);
  }
}
