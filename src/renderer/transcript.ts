import type { TranscriptPartial, TranscriptFinal, SplitRow, Word } from "./ws";

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
  // Per-row word list (absolute-time TranscriptWord triples). Keyed by row
  // element so coalesce-merge naturally reuses one entry. snapshot() reads
  // from here for word-level grading.
  private wordsByRow = new WeakMap<HTMLElement, Word[]>();
  private lastFinalRow: HTMLElement | null = null;
  private lastFinalSpeaker: string | null = null;
  private lastFinalEndMs: number | null = null;
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
    row.dataset.tStartMs = String(m.t_start_ms);
    row.dataset.tEndMs = String(m.t_end_ms);
    this.assignRowSpeakerVisuals(row, m.speaker_id, speakerLabel.name, speakerLabel.color);
    const textEl = row.querySelector<HTMLElement>(".text")!;
    textEl.textContent = m.text;
    // Speaker pill is interactive only after finalization.
    this.attachSpeakerClick(row, m.seq);
    if (m.words && m.words.length) this.wordsByRow.set(row, [...m.words]);

    // Same-speaker mid-sentence coalesce. Requires (a) speaker-id match,
    // (b) inter-utterance gap under MAX_COALESCE_GAP_MS (real mid-utterance
    // gaps are <500ms; speaker changes have larger gaps), and (c) no
    // terminal punctuation on prev. The gap guard exists because brief
    // streaming misattributions can make two different speakers' utterances
    // both appear as the same id; without timing, they'd glue into a single
    // overhung row that survives even after the auth pass relabels it.
    // 300ms is short enough to still glue a real mid-utterance pause
    // but tight enough that brief cross-speaker insertions (a one-word
    // backchannel landing inside another speaker's turn) are far less
    // likely to merge.
    const MAX_COALESCE_GAP_MS = 300;
    const gapMs = this.lastFinalEndMs == null ? Infinity : m.t_start_ms - this.lastFinalEndMs;
    if (
      this.lastFinalRow &&
      this.lastFinalRow !== row &&
      !isLocked(this.lastFinalRow) &&
      this.lastFinalSpeaker === m.speaker_id &&
      gapMs <= MAX_COALESCE_GAP_MS
    ) {
      const prevTextEl = this.lastFinalRow.querySelector<HTMLElement>(".text")!;
      const prevText = prevTextEl.textContent ?? "";
      if (canMergeSentence(prevText, m.text)) {
        prevTextEl.textContent = prevText.replace(/[\s,;:]+$/, "") + " " + m.text;
        this.lastFinalRow.dataset.tEndMs = String(m.t_end_ms);
        // Append the absorbed row's words to the surviving row.
        if (m.words && m.words.length) {
          const prior = this.wordsByRow.get(this.lastFinalRow) ?? [];
          this.wordsByRow.set(this.lastFinalRow, [...prior, ...m.words]);
        }
        for (const [seq, r] of this.bySeq) {
          if (r === row) this.bySeq.set(seq, this.lastFinalRow);
        }
        row.remove();
        row = this.lastFinalRow;
      }
    }

    this.lastFinalRow = row;
    this.lastFinalSpeaker = m.speaker_id;
    this.lastFinalEndMs = m.t_end_ms;
  }

  // Re-skin all rows when a speaker is renamed/recolored
  applySpeaker(speakerId: string, name: string|null, color: string) {
    this.el.querySelectorAll<HTMLElement>(`.line .spk[data-spk="${speakerId}"]`).forEach(spk => {
      spk.style.background = color + "33";
      spk.style.color = color;
      spk.textContent = name ?? speakerId;
    });
  }

  /**
   * Retroactively rewrite every rendered line currently attributed to srcId
   * to dstId. Mirrors the DOM shape used by applySpeaker: each row carries
   * a <span class="spk" data-spk="..."> with background = color+"33" and
   * color = color. Caller (app.ts) resolves dstName/dstColor from the
   * SpeakersPanel before invoking, then calls speakers.merge.
   */
  mergeSpeakers(srcId: string, dstId: string, dstName: string | null, dstColor: string) {
    if (srcId === dstId) return;
    this.el.querySelectorAll<HTMLElement>(`.line .spk[data-spk="${srcId}"]`).forEach((spk) => {
      spk.dataset.spk = dstId;
      spk.style.background = dstColor + "33";
      spk.style.color = dstColor;
      spk.textContent = dstName ?? dstId;
    });
    if (this.lastFinalSpeaker === srcId) {
      this.lastFinalSpeaker = dstId;
    }
  }

  /**
   * Retroactively rewrite a single line (identified by seq) to a different
   * speaker id. Used by the authoritative-diarization correction flow:
   * server says "actually seq=42 was speaker S2, not S1 as we emitted".
   *
   * dstName/dstColor are resolved by the caller (app.ts) from the
   * SpeakersPanel — same convention as mergeSpeakers.
   */
  relabelLine(seq: number, dstId: string, dstName: string | null, dstColor: string) {
    const row = this.bySeq.get(seq);
    if (!row) return;
    const spk = row.querySelector<HTMLElement>(".spk");
    if (!spk) return;
    const prevId = spk.dataset.spk ?? "";
    spk.dataset.spk = dstId;
    spk.style.background = dstColor + "33";
    spk.style.color = dstColor;
    spk.textContent = dstName ?? dstId;
    if (this.lastFinalSpeaker === prevId) {
      this.lastFinalSpeaker = dstId;
    }
  }

  /**
   * Replace the text content of an existing finalized row identified by seq.
   * Used by splitLine to update rows[0] in place after relabeling.
   */
  private updateLineText(seq: number, text: string): void {
    const row = this.bySeq.get(seq);
    if (!row) return;
    const textEl = row.querySelector<HTMLElement>(".text");
    if (!textEl) return;
    textEl.textContent = text;
  }

  /**
   * Handle a transcript_split message: mutate the existing row at originalSeq
   * to reflect rows[0], then insert rows[1:] as new finalized rows immediately
   * after it in the DOM.
   *
   * getSpeaker resolves a speaker_id to its rendered { name, color } — callers
   * pass speakers.get(id) from the SpeakersPanel, matching the relabelLine
   * convention used in app.ts.
   */
  splitLine(
    originalSeq: number,
    rows: SplitRow[],
    getSpeaker: (id: string) => { name: string | null; color: string },
  ): void {
    if (rows.length === 0) return;

    const first = rows[0];
    const firstSpeaker = getSpeaker(first.speaker_id);
    // Mutate the existing row: relabel speaker, then update text.
    this.relabelLine(originalSeq, first.speaker_id, firstSpeaker.name, firstSpeaker.color);
    this.updateLineText(originalSeq, first.text);
    const existingRow = this.bySeq.get(originalSeq);
    if (existingRow) {
      existingRow.dataset.tStartMs = String(first.t_start_ms);
      existingRow.dataset.tEndMs = String(first.t_end_ms);
      // Replace the words on the existing row with run-0's words.
      if (first.words && first.words.length) this.wordsByRow.set(existingRow, [...first.words]);
      else this.wordsByRow.delete(existingRow);
    }

    // Insert rows[1:] as new finalized rows immediately after originalSeq's DOM node.
    const anchorRow = this.bySeq.get(originalSeq);
    let insertAfter: HTMLElement | null = anchorRow ?? null;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (this.bySeq.has(r.seq)) continue;
      const sp = getSpeaker(r.speaker_id);
      const newRow = this.createRow("line", r.seq, /*finalized=*/true);
      this.assignRowSpeakerVisuals(newRow, r.speaker_id, sp.name, sp.color);
      newRow.querySelector<HTMLElement>(".text")!.textContent = r.text;
      newRow.dataset.tStartMs = String(r.t_start_ms);
      newRow.dataset.tEndMs = String(r.t_end_ms);
      this.attachSpeakerClick(newRow, r.seq);
      if (r.words && r.words.length) this.wordsByRow.set(newRow, [...r.words]);
      // Insert directly after the previous row (anchor or last inserted).
      if (insertAfter && insertAfter.parentNode === this.el) {
        insertAfter.insertAdjacentElement("afterend", newRow);
      } else {
        this.el.appendChild(newRow);
      }
      insertAfter = newRow;
    }
  }

  /**
   * Return a plain-object snapshot of all finalized transcript rows, suitable
   * for reporting to the main process via cairnControl.reportTranscript.
   * Partial rows (no speaker yet assigned, class "partial") are omitted.
   */
  snapshot(): Array<{ seq: number; speaker_id: string; text: string; t_start_ms: number; t_end_ms: number; words: Word[] | null }> {
    // After coalesce-merge, multiple bySeq entries may point at the same DOM
    // row.  Build a map from row -> lowest seq so each row is emitted once,
    // keyed by its original (pre-merge) seq for deterministic ordering.
    const seen = new Map<HTMLElement, number>(); // row -> lowest seq pointing at it
    for (const [seq, row] of this.bySeq.entries()) {
      if (row.classList.contains("partial")) continue;
      const prior = seen.get(row);
      if (prior === undefined || seq < prior) {
        seen.set(row, seq);
      }
    }
    const result: Array<{ seq: number; speaker_id: string; text: string; t_start_ms: number; t_end_ms: number; words: Word[] | null }> = [];
    for (const [row, seq] of seen.entries()) {
      const spk = row.querySelector<HTMLElement>(".spk");
      const textEl = row.querySelector<HTMLElement>(".text");
      if (!spk || !textEl) continue;
      const words = this.wordsByRow.get(row) ?? null;
      result.push({
        seq,
        speaker_id: spk.dataset.spk ?? "",
        text: textEl.textContent ?? "",
        t_start_ms: parseInt(row.dataset.tStartMs || "0", 10),
        t_end_ms: parseInt(row.dataset.tEndMs || "0", 10),
        words,
      });
    }
    // Sort by seq so callers get a stable ordered array.
    result.sort((a, b) => a.seq - b.seq);
    return result;
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
