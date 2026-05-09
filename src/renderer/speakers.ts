type Speaker = { id: string; name: string|null; color: string };

const PALETTE = ["#79c0ff","#e3b341","#56d364","#ff7b72","#d2a8ff","#7ee787","#ffa657","#ff9492","#a5d6ff","#f2cc60","#bc8cff"];

export class SpeakersPanel {
  private speakers = new Map<string, Speaker>();
  private el: HTMLElement;
  private nextManualIdx = 0;
  constructor(root: HTMLElement, private onChange: (s: Speaker) => void) { this.el = root; }

  add(id: string, color: string) {
    if (this.speakers.has(id)) return;
    const spk: Speaker = { id, name: null, color };
    this.speakers.set(id, spk);
    this.render();
  }

  get(id: string): Speaker { return this.speakers.get(id) ?? { id, name: null, color: "#8b949e" }; }

  list(): Speaker[] { return Array.from(this.speakers.values()); }

  // Allocate the next user-created speaker id (M1, M2, …) with a fresh palette
  // color, register it, and return both. Server-assigned ids are S1/S2/… so the
  // M-prefix avoids collision with future automatic ids.
  createManual(): Speaker {
    this.nextManualIdx += 1;
    const id = `M${this.nextManualIdx}`;
    const color = PALETTE[(this.speakers.size) % PALETTE.length];
    const spk: Speaker = { id, name: null, color };
    this.speakers.set(id, spk);
    this.render();
    return spk;
  }

  reset() { this.speakers.clear(); this.nextManualIdx = 0; this.render(); }

  rename(id: string, name: string) {
    const s = this.speakers.get(id); if (!s) return;
    s.name = name; this.onChange(s); this.render();
  }
  recolor(id: string, color: string) {
    const s = this.speakers.get(id); if (!s) return;
    s.color = color; this.onChange(s); this.render();
  }

  /**
   * Absorb srcId's panel entry into dstId. dst keeps its current name and color
   * (dst-wins); src is removed from the panel. No-op if srcId is unknown or if
   * src === dst.
   */
  merge(srcId: string, dstId: string) {
    if (srcId === dstId) return;
    if (!this.speakers.has(srcId)) return;
    // Ensure dst exists; if not, mirror src onto dst before deleting.
    if (!this.speakers.has(dstId)) {
      const src = this.speakers.get(srcId)!;
      this.speakers.set(dstId, { id: dstId, name: src.name, color: src.color });
    }
    this.speakers.delete(srcId);
    this.render();
  }

  private render() {
    this.el.innerHTML = "";
    for (const s of this.speakers.values()) {
      const row = document.createElement("div");
      row.className = "spkrow";
      row.innerHTML = `
        <span class="swatch" style="background:${s.color}" title="click to recolor"></span>
        <span class="spkname" contenteditable="true">${s.name ?? s.id}</span>`;
      const swatch = row.querySelector<HTMLElement>(".swatch")!;
      const name = row.querySelector<HTMLElement>(".spkname")!;
      swatch.onclick = () => this.cycleColor(s.id);
      name.onblur = () => this.rename(s.id, name.textContent?.trim() || s.id);
      name.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); name.blur(); } };
      this.el.appendChild(row);
    }
  }

  private cycleColor(id: string) {
    const PALETTE = ["#79c0ff","#e3b341","#56d364","#ff7b72","#d2a8ff","#7ee787","#ffa657"];
    const cur = this.speakers.get(id)?.color ?? PALETTE[0];
    const i = PALETTE.indexOf(cur);
    const next = PALETTE[(i + 1) % PALETTE.length];
    this.recolor(id, next);
  }
}
