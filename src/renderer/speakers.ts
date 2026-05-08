type Speaker = { id: string; name: string|null; color: string };

export class SpeakersPanel {
  private speakers = new Map<string, Speaker>();
  private el: HTMLElement;
  constructor(root: HTMLElement, private onChange: (s: Speaker) => void) { this.el = root; }

  add(id: string, color: string) {
    if (this.speakers.has(id)) return;
    const spk: Speaker = { id, name: null, color };
    this.speakers.set(id, spk);
    this.render();
  }

  get(id: string): Speaker { return this.speakers.get(id) ?? { id, name: null, color: "#8b949e" }; }

  rename(id: string, name: string) {
    const s = this.speakers.get(id); if (!s) return;
    s.name = name; this.onChange(s); this.render();
  }
  recolor(id: string, color: string) {
    const s = this.speakers.get(id); if (!s) return;
    s.color = color; this.onChange(s); this.render();
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
