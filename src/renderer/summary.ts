// src/renderer/summary.ts

type RollingSummary = {
  type: "rolling_summary";
  idx: number;
  window_start_s: number;
  window_end_s: number;
  bullets: string[];
  generated_at: number;
  merged_from_failed_prior: boolean;
};

type RollingReplace = {
  type: "rolling_summary_replace";
  idx: number;
  bullets: string[];
  generated_at: number;
  reason: string;
};

type FinalSummary =
  | {
      type: "final_summary";
      ok: true;
      tldr: string;
      speakers: { speaker: string; contributions: string[] }[];
      decisions: string[];
      action_items: { assignee: string; item: string; due: string | null }[];
      truncated: boolean;
      model: string;
      generated_at: number;
    }
  | {
      type: "final_summary";
      ok: false;
      error: string;
      model: string;
      generated_at: number;
    };

function mmss(s: number): string {
  const i = Math.floor(s);
  return `${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`;
}

function escape(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

export function handleRollingSummary(msg: RollingSummary): void {
  const list = document.getElementById("rolling-list");
  if (!list) return;
  list.querySelector(".rolling-empty")?.remove();
  const div = document.createElement("div");
  div.className = "roll-entry";
  div.dataset.idx = String(msg.idx);
  div.innerHTML = `
    <div class="roll-time">
      ${mmss(msg.window_start_s)} – ${mmss(msg.window_end_s)}
      ${msg.merged_from_failed_prior ? '<span class="merged" title="merged from prior failed window">↻</span>' : ""}
    </div>
    <ul class="roll-bullets">
      ${msg.bullets.map((b) => `<li>${escape(b)}</li>`).join("")}
    </ul>`;
  list.insertBefore(div, list.firstChild); // newest on top
}

export function handleRollingReplace(msg: RollingReplace): void {
  const list = document.getElementById("rolling-list");
  if (!list) return;
  const card = list.querySelector(`.roll-entry[data-idx="${msg.idx}"]`);
  if (!card) return;
  const ul = card.querySelector(".roll-bullets");
  if (ul) ul.innerHTML = msg.bullets.map((b) => `<li>${escape(b)}</li>`).join("");
  card.classList.remove("changed");
  void (card as HTMLElement).offsetWidth;
  card.classList.add("changed");
}

export function handleFinalSummary(msg: FinalSummary): void {
  const target = document.getElementById("final-summary");
  if (!target) return;
  target.innerHTML = "";

  if (!msg.ok) {
    target.innerHTML = `<div class="truncated-banner">Final summary failed: ${escape(msg.error)}</div>`;
  } else {
    const parts: string[] = [];
    if (msg.truncated) {
      parts.push(`<div class="truncated-banner">Transcript truncated for summarization (>12K tokens). Final summary may miss some early content.</div>`);
    }
    parts.push(`<div class="tldr">${escape(msg.tldr)}</div>`);
    if (msg.speakers.length) {
      parts.push(`<h3>By speaker</h3>`);
      for (const sp of msg.speakers) {
        parts.push(`<h4>${escape(sp.speaker)}</h4><ul>${sp.contributions.map((c) => `<li>${escape(c)}</li>`).join("")}</ul>`);
      }
    }
    if (msg.decisions.length) {
      parts.push(`<h3>Decisions</h3><ul>${msg.decisions.map((d) => `<li>${escape(d)}</li>`).join("")}</ul>`);
    }
    if (msg.action_items.length) {
      parts.push(`<h3>Action items</h3><table class="actions"><thead><tr><th>Assignee</th><th>Item</th><th>Due</th></tr></thead><tbody>`);
      for (const a of msg.action_items) {
        parts.push(`<tr><td>${escape(a.assignee)}</td><td>${escape(a.item)}</td><td>${escape(a.due ?? "")}</td></tr>`);
      }
      parts.push(`</tbody></table>`);
    }
    target.innerHTML = parts.join("");
  }

  // Reveal toggle + default to Summary view
  const tBtn = document.getElementById("view-transcript") as HTMLButtonElement | null;
  const sBtn = document.getElementById("view-summary") as HTMLButtonElement | null;
  const lines = document.getElementById("transcript-lines");
  if (tBtn) tBtn.hidden = false;
  if (sBtn) sBtn.hidden = false;
  if (lines) lines.hidden = true;
  target.hidden = false;
}
