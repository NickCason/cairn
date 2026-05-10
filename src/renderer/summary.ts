// src/renderer/summary.ts

import { renderWithSpeakerTokens, type SpeakerInfo } from "./speaker-substitute.js";

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

type FinalSummaryOk = {
  type: "final_summary";
  ok: true;
  tldr: string;
  speakers: { speaker: string; contributions: string[] }[];
  decisions: string[];
  action_items: { assignee: string; item: string; due: string | null }[];
  truncated: boolean;
  model: string;
  generated_at: number;
};

type FinalSummaryErr = {
  type: "final_summary";
  ok: false;
  error: string;
  model: string;
  generated_at: number;
};

type FinalSummary = FinalSummaryOk | FinalSummaryErr;

// Cache the most recent payloads so a rename can re-render without server help.
const rollingCache = new Map<number, RollingSummary>();
let finalCache: FinalSummary | null = null;
let currentRegistry: SpeakerInfo[] = [];

function mmss(s: number): string {
  const i = Math.floor(s);
  return `${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`;
}

function renderTokens(text: string): string {
  return renderWithSpeakerTokens(text, currentRegistry);
}

function renderRollingCard(msg: RollingSummary): HTMLElement {
  const div = document.createElement("div");
  div.className = "roll-entry";
  div.dataset.idx = String(msg.idx);
  div.innerHTML = `
    <div class="roll-time">
      ${mmss(msg.window_start_s)} – ${mmss(msg.window_end_s)}
      ${msg.merged_from_failed_prior ? '<span class="merged" title="merged from prior failed window">↻</span>' : ""}
    </div>
    <ul class="roll-bullets">
      ${msg.bullets.map((b) => `<li>${renderTokens(b)}</li>`).join("")}
    </ul>`;
  return div;
}

export function handleRollingSummary(msg: RollingSummary): void {
  rollingCache.set(msg.idx, msg);
  const list = document.getElementById("rolling-list");
  if (!list) return;
  list.querySelector(".rolling-empty")?.remove();
  list.insertBefore(renderRollingCard(msg), list.firstChild); // newest on top
}

export function handleRollingReplace(msg: RollingReplace): void {
  const cached = rollingCache.get(msg.idx);
  if (cached) {
    cached.bullets = msg.bullets;
    cached.generated_at = msg.generated_at;
  }
  const list = document.getElementById("rolling-list");
  if (!list) return;
  const card = list.querySelector(`.roll-entry[data-idx="${msg.idx}"]`);
  if (!card) return;
  const ul = card.querySelector(".roll-bullets");
  if (ul) ul.innerHTML = msg.bullets.map((b) => `<li>${renderTokens(b)}</li>`).join("");
  card.classList.remove("changed");
  void (card as HTMLElement).offsetWidth;
  card.classList.add("changed");
}

function renderFinalInto(target: HTMLElement, msg: FinalSummary): void {
  target.innerHTML = "";
  if (!msg.ok) {
    target.innerHTML = `<div class="truncated-banner">Final summary failed: ${renderTokens(msg.error)}</div>`;
    return;
  }
  const parts: string[] = [];
  if (msg.truncated) {
    parts.push(`<div class="truncated-banner">Transcript truncated for summarization (>12K tokens). Final summary may miss some early content.</div>`);
  }
  parts.push(`<div class="tldr">${renderTokens(msg.tldr)}</div>`);
  if (msg.speakers.length) {
    parts.push(`<h3>By speaker</h3>`);
    for (const sp of msg.speakers) {
      parts.push(`<h4>${renderTokens(sp.speaker)}</h4><ul>${sp.contributions.map((c) => `<li>${renderTokens(c)}</li>`).join("")}</ul>`);
    }
  }
  if (msg.decisions.length) {
    parts.push(`<h3>Decisions</h3><ul>${msg.decisions.map((d) => `<li>${renderTokens(d)}</li>`).join("")}</ul>`);
  }
  if (msg.action_items.length) {
    parts.push(`<h3>Action items</h3><table class="actions"><thead><tr><th>Assignee</th><th>Item</th><th>Due</th></tr></thead><tbody>`);
    for (const a of msg.action_items) {
      parts.push(`<tr><td>${renderTokens(a.assignee)}</td><td>${renderTokens(a.item)}</td><td>${renderTokens(a.due ?? "")}</td></tr>`);
    }
    parts.push(`</tbody></table>`);
  }
  target.innerHTML = parts.join("");
}

export function handleFinalSummary(msg: FinalSummary): void {
  finalCache = msg;
  const target = document.getElementById("final-summary");
  if (!target) return;
  renderFinalInto(target, msg);

  // Reveal toggle + default to Summary view
  const tBtn = document.getElementById("view-transcript") as HTMLButtonElement | null;
  const sBtn = document.getElementById("view-summary") as HTMLButtonElement | null;
  const lines = document.getElementById("transcript-lines");
  if (tBtn) tBtn.hidden = false;
  if (sBtn) sBtn.hidden = false;
  if (lines) lines.hidden = true;
  target.hidden = false;
}

/**
 * Re-render every cached summary using ``registry``. Called whenever the
 * speaker registry changes (rename, recolor, merge).
 */
export function redrawSummaries(registry: SpeakerInfo[]): void {
  currentRegistry = registry;
  const list = document.getElementById("rolling-list");
  if (list) {
    // Re-render each cached rolling card in place.
    for (const card of Array.from(list.querySelectorAll<HTMLElement>(".roll-entry"))) {
      const idx = Number(card.dataset.idx);
      const cached = rollingCache.get(idx);
      if (!cached) continue;
      const ul = card.querySelector(".roll-bullets");
      if (ul) ul.innerHTML = cached.bullets.map((b) => `<li>${renderTokens(b)}</li>`).join("");
    }
  }
  const target = document.getElementById("final-summary");
  if (target && finalCache) renderFinalInto(target, finalCache);
}

export function resetSummaryCache(): void {
  rollingCache.clear();
  finalCache = null;
}
