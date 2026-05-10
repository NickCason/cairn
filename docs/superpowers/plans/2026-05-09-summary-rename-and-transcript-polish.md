# Summary rename + transcript polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every speaker mention in rolling + final summaries reflect the user's current naming + colors instantly (including post-stop renames), eliminate stale-SID leaks after svc-internal merges, and polish transcript rows with timestamps + spring animations.

**Architecture:** Client owns SID→name+color substitution at render time (instant, no svc round-trip; works whether WS is alive or closed). Svc emits canonical SIDs only (post-merge) and keeps its existing `_apply_rename_retro` for during-recording WS-driven re-emission so saved files stay consistent. A new svc helper applies the same retro pattern when an internal merge fires (the leak fix).

**Tech Stack:** TypeScript (renderer), Electron main process (file IO), Python 3.11 + pytest (svc on node4), Node 18+ built-in `node --test` (TS unit tests), CSS animations.

**Spec:** `docs/superpowers/specs/2026-05-09-summary-rename-and-transcript-polish-design.md`

---

## File map

**New files:**
- `src/renderer/speaker-substitute.ts` — variant-aware regex substitution + colored-span wrapping. Pure functions, no DOM deps.
- `src/renderer/speaker-substitute.test.mjs` — Node-based unit tests for the above.
- `tests/test_canonical_substitute_retro.py` — pytest unit test, run on node4.

**Modified files:**
- `src/renderer/summary.ts` — add cache for rolling+final payloads; route bullets/text through substitute helpers; expose `redrawSummaries()`.
- `src/renderer/transcript.ts` — render `mm:ss` timestamp; trigger fresh-row CSS class for the accent rail; trigger relabel-pulse CSS class on `applySpeaker`.
- `src/renderer/style.css` — animations (spring slide-in, accent rail, pulse, glow, split, rename crossfade), `.spkref` text style, `.ts` style, `prefers-reduced-motion` overrides.
- `src/renderer/app.ts` — wire `SpeakersPanel.onChange` to `summary.redrawSummaries(speakersPanel.list())`; track a module-level `sessionState`; on rename when state == "stopped", re-call `saveSession` with baked events.
- `cairn_svc/server.py` (on node4) — add `_apply_canonical_substitute_retro` near `_apply_rename_retro`; call it after every `session.merge_stable(...)` site.

---

## Task 1: TS substitute helper + tests

**Files:**
- Create: `src/renderer/speaker-substitute.ts`
- Create: `src/renderer/speaker-substitute.test.mjs`

- [ ] **Step 1: Write failing tests**

Create `src/renderer/speaker-substitute.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { substituteSpeakerVariants, escapeHtml } from "./speaker-substitute.js";

test("replaces S1 with name", () => {
  assert.equal(substituteSpeakerVariants("S1 said hello", "S1", "Peter"), "Peter said hello");
});

test("replaces all SID variants case-insensitively", () => {
  for (const variant of ["S1", "s1", "P1", "p1", "Speaker 1", "Speaker_1", "Spkr 1", "Spkr_1", "Person 1", "Person_1"]) {
    assert.equal(
      substituteSpeakerVariants(`${variant} mentioned`, "S1", "Peter"),
      "Peter mentioned",
      `failed on variant '${variant}'`,
    );
  }
});

test("does not match S10 or S1A", () => {
  assert.equal(substituteSpeakerVariants("S10 said S1A is", "S1", "Peter"), "S10 said S1A is");
});

test("does not match inside a word", () => {
  assert.equal(substituteSpeakerVariants("CASS1ON", "S1", "Peter"), "CASS1ON");
});

test("idempotent on already-substituted text", () => {
  const once = substituteSpeakerVariants("S1 spoke", "S1", "Peter");
  const twice = substituteSpeakerVariants(once, "S1", "Peter");
  assert.equal(twice, once);
});

test("handles multiple sids in one call", () => {
  let t = "S1 and S2 talked";
  t = substituteSpeakerVariants(t, "S1", "Peter");
  t = substituteSpeakerVariants(t, "S2", "Elon");
  assert.equal(t, "Peter and Elon talked");
});

test("escapeHtml escapes the four core chars", () => {
  assert.equal(escapeHtml('<a href="x">a&b</a>'), "&lt;a href=&quot;x&quot;&gt;a&amp;b&lt;/a&gt;");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/nickcason/dev/cairn && node --test src/renderer/speaker-substitute.test.mjs
```

Expected: FAIL with `Cannot find module './speaker-substitute.js'`.

- [ ] **Step 3: Implement the helper**

Create `src/renderer/speaker-substitute.ts`:

```typescript
// Pure helpers for variant-aware speaker-id substitution and HTML escaping.
// Mirrors cairn_svc/summarize.py:substitute_speaker_variants so client and
// server agree on what counts as a speaker token.

const VARIANT_PREFIXES = [
  "S",
  "P",
  "S\\s+",
  "P\\s+",
  "Speaker\\s*",
  "Speaker_",
  "Person\\s*",
  "Person_",
  "Spkr\\s*",
  "Spkr_",
  "speaker_",
  "person_",
  "spkr_",
];

export function substituteSpeakerVariants(text: string, sid: string, replacement: string): string {
  const m = sid.match(/^[A-Za-z]+(\d+)$/);
  if (!m) return text;
  const digit = m[1];
  const alternation = VARIANT_PREFIXES.join("|");
  const re = new RegExp(`(?<![A-Za-z0-9_])(?:${alternation})${digit}(?![0-9])`, "gi");
  return text.replace(re, replacement);
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
```

- [ ] **Step 4: Build TypeScript and run tests**

```bash
cd /Users/nickcason/dev/cairn && npx tsc -p tsconfig.renderer.json && node --test src/renderer/speaker-substitute.test.mjs
```

Expected: PASS, all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/speaker-substitute.ts src/renderer/speaker-substitute.test.mjs
git commit -m "feat(renderer): variant-aware speaker-id substitute helper + tests"
```

---

## Task 2: TS render-with-speaker-tokens helper + tests

**Files:**
- Modify: `src/renderer/speaker-substitute.ts` (add `renderWithSpeakerTokens`)
- Modify: `src/renderer/speaker-substitute.test.mjs` (add render tests)

- [ ] **Step 1: Add failing tests for renderWithSpeakerTokens**

Append to `src/renderer/speaker-substitute.test.mjs`:

```javascript
import { renderWithSpeakerTokens } from "./speaker-substitute.js";

test("wraps SID variants in colored spans with display name", () => {
  const html = renderWithSpeakerTokens("S1 said hi to S2", [
    { id: "S1", name: "Peter", color: "#79c0ff" },
    { id: "S2", name: null, color: "#e3b341" },
  ]);
  assert.match(html, /<span class="spkref" data-spk="S1" style="color:#79c0ff;font-weight:600">Peter<\/span> said hi to <span class="spkref" data-spk="S2" style="color:#e3b341;font-weight:600">S2<\/span>/);
});

test("html-escapes the input before wrapping", () => {
  const html = renderWithSpeakerTokens('S1 said "<hi>"', [{ id: "S1", name: "Peter", color: "#79c0ff" }]);
  assert.ok(html.includes("&lt;hi&gt;"));
  assert.ok(html.includes("&quot;"));
  assert.ok(html.includes(">Peter</span>"));
});

test("also wraps bare user-name occurrences", () => {
  // server may have substituted SID->name in transit; we still want colored spans
  const html = renderWithSpeakerTokens("Peter mentioned scaling laws", [
    { id: "S1", name: "Peter", color: "#79c0ff" },
  ]);
  assert.ok(html.includes('<span class="spkref" data-spk="S1" style="color:#79c0ff;font-weight:600">Peter</span> mentioned'));
});

test("empty registry returns escaped text only", () => {
  assert.equal(renderWithSpeakerTokens("hello <world>", []), "hello &lt;world&gt;");
});

test("name with regex metacharacters is treated literally", () => {
  const html = renderWithSpeakerTokens("Dr. O'Hara spoke", [{ id: "S1", name: "Dr. O'Hara", color: "#79c0ff" }]);
  assert.ok(html.includes(">Dr. O&#39;Hara</span>") || html.includes(">Dr. O'Hara</span>"));
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test src/renderer/speaker-substitute.test.mjs
```

Expected: FAIL with "renderWithSpeakerTokens is not a function".

- [ ] **Step 3: Implement renderWithSpeakerTokens**

Append to `src/renderer/speaker-substitute.ts`:

```typescript
export type SpeakerInfo = { id: string; name: string | null; color: string };

const REGEX_META = /[.*+?^${}()|[\]\\]/g;
function escapeRegex(s: string): string {
  return s.replace(REGEX_META, "\\$&");
}

/**
 * HTML-escape ``text``, then for each speaker in ``registry`` wrap every
 * variant of its SID (and, if the speaker has a user-assigned name, every
 * bare occurrence of the name) in a colored <span class="spkref">. Returns
 * safe HTML.
 *
 * Two-pass to avoid double-wrapping:
 *   1. Substitute SID variants → wrapped spans.
 *   2. For each named speaker, split the result on existing .spkref span
 *      boundaries and only apply name-substitution to the non-span chunks.
 */
export function renderWithSpeakerTokens(text: string, registry: SpeakerInfo[]): string {
  let out = escapeHtml(text);

  // Pass 1: SID variants → spans.
  for (const spk of registry) {
    const display = spk.name ?? spk.id;
    const span = `<span class="spkref" data-spk="${spk.id}" style="color:${spk.color};font-weight:600">${escapeHtml(display)}</span>`;
    out = substituteSpeakerVariants(out, spk.id, span);
  }

  // Pass 2: bare user-name occurrences → spans, skipping inside existing spans.
  for (const spk of registry) {
    if (!spk.name) continue;
    const span = `<span class="spkref" data-spk="${spk.id}" style="color:${spk.color};font-weight:600">${escapeHtml(spk.name)}</span>`;
    const nameRe = new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(escapeHtml(spk.name))}(?![A-Za-z0-9_])`, "gi");
    const parts = out.split(/(<span class="spkref"[^>]*>[^<]*<\/span>)/g);
    out = parts
      .map((p) => (p.startsWith('<span class="spkref"') ? p : p.replace(nameRe, span)))
      .join("");
  }

  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx tsc -p tsconfig.renderer.json && node --test src/renderer/speaker-substitute.test.mjs
```

Expected: PASS, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/speaker-substitute.ts src/renderer/speaker-substitute.test.mjs
git commit -m "feat(renderer): renderWithSpeakerTokens wraps speaker mentions in colored spans"
```

---

## Task 3: Summary cache + redraw on rename

**Files:**
- Modify: `src/renderer/summary.ts`
- Modify: `src/renderer/app.ts`
- Modify: `src/renderer/style.css`

- [ ] **Step 1: Add cache + render-pipeline plumbing in summary.ts**

Replace the body of `src/renderer/summary.ts` with:

```typescript
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
```

- [ ] **Step 2: Wire SpeakersPanel.onChange in app.ts**

In `src/renderer/app.ts`, find the `ws?.rename(s.id, s.name ?? s.id, s.color);` line (around line 24) and update the surrounding `onChange` callback:

```typescript
const speakers = new SpeakersPanel(document.getElementById("speakers")!, (s) => {
  ws?.rename(s.id, s.name ?? s.id, s.color);
  // Local re-render so renames take effect even when WS is closed (post-stop).
  redrawSummaries(speakers.list().map((sp) => ({ id: sp.id, name: sp.name, color: sp.color })));
});
```

Add the import at the top of `app.ts`:

```typescript
import { redrawSummaries, resetSummaryCache } from "./summary.js";
```

In the place that resets state for a new session (search for `speakers.reset` or "reset speakers panel internal state"), call `resetSummaryCache()` too.

- [ ] **Step 3: Add .spkref CSS**

Append to `src/renderer/style.css`:

```css
/* Inline speaker token in rolling/final summary text. Color comes from
   the inline style attribute (matches the speaker pill color). */
.spkref {
  font-weight: 600;
  /* color set via inline style for per-speaker hue */
}
```

- [ ] **Step 4: Build and manually verify**

```bash
cd /Users/nickcason/dev/cairn && npx tsc && npx tsc -p tsconfig.renderer.json
```

Then launch Cairn, record a 90-second clip, rename a speaker via the speakers panel, and verify the rolling summary card text updates in place with the new colored name.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/summary.ts src/renderer/app.ts src/renderer/style.css
git commit -m "feat(renderer): summary cache + colored speaker tokens + redraw on rename"
```

---

## Task 4: Bake substitutions in at save time

**Files:**
- Modify: `src/renderer/app.ts` (preprocess eventsLog before saveSession)

- [ ] **Step 1: Add a preprocessor function near `finalizeSession`**

In `src/renderer/app.ts`, just above `async function finalizeSession()`:

```typescript
import { substituteSpeakerVariants } from "./speaker-substitute.js";

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
```

- [ ] **Step 2: Use it in finalizeSession**

In `src/renderer/app.ts`, replace the line `const dir = await window.cairn.saveSession(meetingName, eventsLog);` inside `finalizeSession` with:

```typescript
const baked = bakeNamesIntoEvents(eventsLog, speakers.list().map((s) => ({ id: s.id, name: s.name })));
const dir = await window.cairn.saveSession(meetingName, baked);
savedSessionDir = dir;
```

Add a module-level `let savedSessionDir: string | null = null;` near the top of `app.ts` (used by Task 5).

- [ ] **Step 3: Build and verify**

```bash
npx tsc -p tsconfig.renderer.json
```

Run a 30-second recording with a manual rename mid-session, stop, then `cat ~/Documents/Cairn/<latest>/transcript.jsonl | grep rolling_summary | head -2`. Confirm the bullets contain the user-assigned name, not the bare SID.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/app.ts
git commit -m "feat(renderer): bake user-assigned names into saved transcript.jsonl"
```

---

## Task 5: Re-save on post-stop rename

**Files:**
- Modify: `src/renderer/app.ts`

- [ ] **Step 1: Track session state and re-save on rename when stopped**

In `src/renderer/app.ts`, near the existing state vars at the top, add:

```typescript
let sessionState: "idle" | "recording" | "stopped" = "idle";
```

Update sessionState in the WS message handler: when receiving an `ack` of `start`, set to `"recording"`; in `finalizeSession`, after the save, set to `"stopped"`. When user hits Start (search for `$start.onclick`), set back to `"idle"` then `"recording"`.

Modify the `SpeakersPanel` onChange callback (Task 3 step 2) to also re-save when stopped:

```typescript
const speakers = new SpeakersPanel(document.getElementById("speakers")!, (s) => {
  ws?.rename(s.id, s.name ?? s.id, s.color);
  redrawSummaries(speakers.list().map((sp) => ({ id: sp.id, name: sp.name, color: sp.color })));
  if (sessionState === "stopped" && savedSessionDir) {
    // WS is closed; rewrite the saved file in place by re-calling saveSession
    // with the baked events. The IPC handler already overwrites the file.
    const baked = bakeNamesIntoEvents(eventsLog, speakers.list().map((sp) => ({ id: sp.id, name: sp.name })));
    void window.cairn.saveSession(meetingName, baked);
  }
});
```

- [ ] **Step 2: Build**

```bash
npx tsc -p tsconfig.renderer.json
```

- [ ] **Step 3: Manual verify**

Record 30 seconds, stop, wait for final summary, then rename a speaker via the panel. Open `~/Documents/Cairn/<latest>/transcript.jsonl` and confirm the final_summary line contains the new name.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/app.ts
git commit -m "feat(renderer): re-save transcript.jsonl on post-stop rename"
```

---

## Task 6: Transcript row polish — timestamps + animations + reduced-motion

**Files:**
- Modify: `src/renderer/transcript.ts`
- Modify: `src/renderer/style.css`

- [ ] **Step 1: Render timestamp in transcript row + emit `fresh` class on new finals**

In `src/renderer/transcript.ts`, find the `final(m, speakerLabel)` method (around line 63). Add a `sessionStartMs` field that tracks the first final's `t_start_ms`, and modify the row HTML insertion to include a right-aligned timestamp.

Add as a class field:

```typescript
private sessionStartMs: number | null = null;
```

In the same file, add a helper at top-level (or inside the class as a static):

```typescript
function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
```

In the place where new transcript rows are created (search for `document.createElement("div")` inside the `final` method or its helpers), once the row is constructed, ensure a `<span class="ts">` element is appended after the text element. The display text uses `mmss(m.t_start_ms - this.sessionStartMs)`.

Set the start anchor on the first final:

```typescript
if (this.sessionStartMs == null) this.sessionStartMs = m.t_start_ms;
```

Right after the row is appended to the DOM, add the fresh class for the accent rail:

```typescript
row.classList.add("fresh");
window.setTimeout(() => row.classList.add("fade-rail"), 1100);
window.setTimeout(() => row.classList.remove("fresh", "fade-rail"), 1900);
```

In `applySpeaker(speakerId, name, color)` (around line 124), trigger a relabel-pulse on every affected row:

```typescript
this.el.querySelectorAll<HTMLElement>(`.line .spk[data-spk="${speakerId}"]`).forEach((spk) => {
  const row = spk.closest<HTMLElement>(".line");
  spk.style.background = color + "33";
  spk.style.color = color;
  spk.textContent = name ?? speakerId;
  if (row) {
    row.classList.remove("relabel-pulse", "relabel-anim", "relabel-settle");
    void row.offsetWidth;
    row.classList.add("relabel-pulse", "relabel-anim");
    window.setTimeout(() => {
      row.classList.remove("relabel-anim");
      row.classList.add("relabel-settle");
    }, 380);
    window.setTimeout(() => {
      row.classList.remove("relabel-pulse", "relabel-settle");
    }, 900);
  }
});
```

For the split path (search for `splitLine` or `transcript_split` handling): wrap the new-row insertion so each new row gets the `fresh` class as in Step 1 above.

- [ ] **Step 2: Add CSS animations**

Append to `src/renderer/style.css`:

```css
/* ---- Transcript row Lively+ polish ---- */
.line {
  position: relative;
  opacity: 0;
  transform: translateY(10px);
  transition:
    opacity 320ms ease-out,
    transform 380ms cubic-bezier(0.16, 1.0, 0.3, 1),
    background-color 350ms ease-out;
}
.line.in,
.line { /* default-in once added — see JS toggling below */ }
.line { opacity: 1; transform: translateY(0); }

/* Soft accent rail on fresh rows */
.line::before {
  content: "";
  position: absolute;
  left: -10px; top: 6px; bottom: 6px;
  width: 2px;
  border-radius: 2px;
  background: var(--row-accent, transparent);
  opacity: 0;
  transition: opacity 700ms ease-out 200ms;
}
.line.fresh::before { opacity: 0.55; }
.line.fresh.fade-rail::before { opacity: 0; }

.line.relabel-pulse {
  animation: pulseTint 700ms ease-out 1;
}
@keyframes pulseTint {
  0%   { background-color: rgba(86,211,100,0); }
  25%  { background-color: rgba(86,211,100,0.10); }
  100% { background-color: rgba(86,211,100,0); }
}

.line .spk {
  transition:
    background-color 320ms ease-out,
    color 320ms ease-out,
    transform 220ms cubic-bezier(0.2, 0.7, 0.3, 1.4),
    box-shadow 360ms ease-out;
}
.line.relabel-anim .spk {
  transform: scale(1.10);
  box-shadow: 0 0 0 4px rgba(86,211,100,0.12), 0 0 14px rgba(86,211,100,0.25);
}
.line.relabel-settle .spk {
  transform: scale(1.0);
  box-shadow: 0 0 0 0 rgba(86,211,100,0);
}

/* Right-aligned timestamp */
.line .ts {
  color: #6e7681;
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  min-width: 42px;
  text-align: right;
  opacity: 0.55;
  margin-left: 10px;
}

@media (prefers-reduced-motion: reduce) {
  .line, .line .spk, .line::before {
    transition: none !important;
    animation: none !important;
  }
  .line { opacity: 1; transform: none; }
}
```

Set the per-row accent color when the row is created (in transcript.ts):

```typescript
row.style.setProperty("--row-accent", speakerLabel.color || "#79c0ff");
```

- [ ] **Step 3: Build and visually verify**

```bash
npx tsc -p tsconfig.renderer.json
```

Launch Cairn against the YouTube fixture (`scripts/cairn-loop.sh --duration 90`). Watch:
- New rows arrive with a soft slide-up + accent rail.
- A relabel (auth-pass) fires the pulse + pill scale.
- Timestamps render right-aligned, dimmed.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/transcript.ts src/renderer/style.css
git commit -m "feat(renderer): timestamps + spring slide-in + relabel pulse + accent rail on transcript rows"
```

---

## Task 7: Svc — _apply_canonical_substitute_retro helper + tests

**Files (on node4 at `/home/nick/cairn-svc/`):**
- Create: `tests/test_canonical_substitute_retro.py`
- Modify: `cairn_svc/server.py`

- [ ] **Step 1: SSH to node4 and write a failing test**

```bash
ssh node4 'cd /home/nick/cairn-svc && cat > tests/test_canonical_substitute_retro.py' <<'EOF'
import asyncio
import pytest
from cairn_svc.session import Session


@pytest.mark.asyncio
async def test_canonical_substitute_retro_rewrites_rolling_and_final():
    from cairn_svc.server import _apply_canonical_substitute_retro

    session = Session(session_id="t1", meeting_name="t")
    # Two stored rolling entries, one mentions S1
    session.add_rolling_entry(
        window_start_s=0.0, window_end_s=120.0,
        bullets=["S1 introduces scaling laws.", "S2 mentions Anthropic."],
        merged_from_failed_prior=False,
    )
    session.add_rolling_entry(
        window_start_s=120.0, window_end_s=240.0,
        bullets=["Speaker 1 talks about Baidu.", "S2 agrees."],
        merged_from_failed_prior=False,
    )
    # Cached final referencing S1
    session.set_final_summary({
        "type": "final_summary", "ok": True,
        "tldr": "S1 led the discussion with S2.",
        "speakers": [
            {"speaker": "S1", "contributions": ["talks about scaling"]},
            {"speaker": "S2", "contributions": ["mentions Anthropic"]},
        ],
        "decisions": [], "action_items": [], "truncated": False,
        "model": "test", "generated_at": 0.0,
    })

    emitted = []
    async def emit(msg): emitted.append(msg)

    await _apply_canonical_substitute_retro(session, emit, src="S1", target="S2")

    # rolling_summary_replace per affected entry
    replaces = [m for m in emitted if m["type"] == "rolling_summary_replace"]
    assert len(replaces) == 2
    assert all(r["reason"] == "merge" for r in replaces)
    assert "S2 introduces scaling laws." in replaces[0]["bullets"]
    assert "S2 talks about Baidu." in replaces[1]["bullets"]

    # final_summary re-emitted with substitutions applied
    finals = [m for m in emitted if m["type"] == "final_summary"]
    assert len(finals) == 1
    f = finals[0]
    assert f["tldr"] == "S2 led the discussion with S2."
    assert f["speakers"][0]["speaker"] == "S2"


@pytest.mark.asyncio
async def test_canonical_substitute_retro_no_op_when_sid_absent():
    from cairn_svc.server import _apply_canonical_substitute_retro

    session = Session(session_id="t2", meeting_name="t")
    session.add_rolling_entry(
        window_start_s=0.0, window_end_s=120.0,
        bullets=["S2 talks alone."],
        merged_from_failed_prior=False,
    )
    emitted = []
    async def emit(msg): emitted.append(msg)
    await _apply_canonical_substitute_retro(session, emit, src="S5", target="S2")
    assert emitted == []
EOF
```

- [ ] **Step 2: Run test to verify it fails**

```bash
ssh node4 'cd /home/nick/cairn-svc && pytest tests/test_canonical_substitute_retro.py -v'
```

Expected: FAIL with `ImportError: cannot import name '_apply_canonical_substitute_retro'`.

- [ ] **Step 3: Implement the helper in server.py**

```bash
ssh node4 'cd /home/nick/cairn-svc && grep -n "^async def _apply_rename_retro" cairn_svc/server.py'
```

Note the line number (around 499). Append a new function immediately after `_apply_rename_retro` ends (find the next `def` or `async def` and insert before it). Use this implementation:

```python
async def _apply_canonical_substitute_retro(
    session: "Session",
    emit: "Callable[[dict], Awaitable[None]]",
    *,
    src: str,
    target: str,
) -> None:
    """Substitute every variant of ``src`` SID with ``target`` in every
    stored rolling summary's bullets and in the cached final summary.
    Re-emits ``rolling_summary_replace`` per affected entry and
    ``final_summary`` if the final has been cached. No-op if ``src`` does
    not appear anywhere.

    This handles svc-internal merges (e.g. S1->S2) so historical recap
    text and the final summary stay canonical post-merge.
    """
    import time as _time
    from .summarize import substitute_speaker_variants

    if src == target:
        return

    affected: list[int] = []
    for entry in session.rolling_entries_all():
        before = list(entry["bullets"])
        rewritten = [substitute_speaker_variants(b, src, target) for b in before]
        if rewritten != before:
            entry["bullets"] = rewritten
            affected.append(entry["idx"])
    for idx in affected:
        e = session.rolling_entries_all()[idx]
        await emit({
            "type": "rolling_summary_replace",
            "idx": idx,
            "bullets": list(e["bullets"]),
            "generated_at": _time.time(),
            "reason": "merge",
        })

    final = session.get_final_summary()
    if final is not None:
        new_final = dict(final)
        new_final["tldr"] = substitute_speaker_variants(new_final.get("tldr", ""), src, target)
        new_speakers = []
        any_change = (new_final["tldr"] != final.get("tldr", ""))
        for blk in new_final.get("speakers", []):
            sp = substitute_speaker_variants(blk.get("speaker", ""), src, target)
            contribs = [substitute_speaker_variants(c, src, target) for c in blk.get("contributions", [])]
            if sp != blk.get("speaker", "") or contribs != blk.get("contributions", []):
                any_change = True
            new_speakers.append({**blk, "speaker": sp, "contributions": contribs})
        new_final["speakers"] = new_speakers
        decisions = [substitute_speaker_variants(d, src, target) for d in new_final.get("decisions", [])]
        if decisions != new_final.get("decisions", []):
            any_change = True
        new_final["decisions"] = decisions
        actions = []
        for a in new_final.get("action_items", []):
            new_a = {
                **a,
                "assignee": substitute_speaker_variants(a.get("assignee", ""), src, target),
                "item": substitute_speaker_variants(a.get("item", ""), src, target),
            }
            if new_a["assignee"] != a.get("assignee", "") or new_a["item"] != a.get("item", ""):
                any_change = True
            actions.append(new_a)
        new_final["action_items"] = actions
        if any_change or affected:
            new_final["generated_at"] = _time.time()
            session.set_final_summary(new_final)
            await emit(new_final)
```

(Use whatever editor you prefer; `vi /home/nick/cairn-svc/cairn_svc/server.py` then `:%s/...`. Or use the Edit tool over ssh by copying the file local, editing, scp back.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
ssh node4 'cd /home/nick/cairn-svc && pytest tests/test_canonical_substitute_retro.py -v'
```

Expected: PASS, both tests pass.

- [ ] **Step 5: Commit on node4**

```bash
ssh node4 'cd /home/nick/cairn-svc && git add tests/test_canonical_substitute_retro.py cairn_svc/server.py && git commit -m "feat(svc): _apply_canonical_substitute_retro for internal merges"'
```

---

## Task 8: Svc — wire helper into merge call sites + restart svc

**Files (on node4):**
- Modify: `cairn_svc/server.py` — call `_apply_canonical_substitute_retro` after every `session.merge_stable(...)`

- [ ] **Step 1: Find all merge_stable call sites**

```bash
ssh node4 'cd /home/nick/cairn-svc && grep -nE "merge_stable\(|session\.merge_stable" cairn_svc/server.py'
```

Expected: 1-2 hits. The known ones are in `_run_authoritative_pass` (orphan-merge) and the rename merge path. Note each line.

- [ ] **Step 2: Add the helper call after each merge**

For each call site, insert immediately after the `session.merge_stable(src=X, dst=Y)` line:

```python
await _apply_canonical_substitute_retro(session, emit_fn_in_scope, src=X, target=Y)
```

Where `emit_fn_in_scope` is whatever emit callable is in the surrounding scope (`_emit_msg` in the receive-loop paths, or whatever the existing `_apply_rename_retro` uses in the same function). Match the existing pattern. Note the keyword is `target=` (matching the helper's signature), not `dst=`.

- [ ] **Step 3: Run the full svc test suite**

```bash
ssh node4 'cd /home/nick/cairn-svc && pytest -x -q'
```

Expected: all tests pass (the existing 119 + 2 new = 121).

- [ ] **Step 4: Commit + restart svc**

```bash
ssh node4 'cd /home/nick/cairn-svc && git add cairn_svc/server.py && git commit -m "feat(svc): wire canonical-substitute retro into merge call sites" && sudo systemctl restart cairn-svc'
```

Verify svc is healthy:

```bash
ssh node4 'sudo systemctl status cairn-svc | head -10'
```

---

## Task 9: E2E manual verification

**Files:** none modified.

- [ ] **Step 1: Run a 5-minute test against the YouTube fixture**

```bash
cd /Users/nickcason/dev/cairn && scripts/cairn-loop.sh --duration 300 --out /tmp/cairn-test-runs
```

- [ ] **Step 2: While recording, rename two speakers**

After ~60s of recording, click the speakers panel and rename `S1 → "Lex"` and `S2 → "Dario"`. Observe:
- Transcript rows: pill text + color crossfades, brief glow + scale.
- Rolling summaries: existing cards re-render with colored "Lex" / "Dario" tokens.
- New rows: arrive with spring slide-in + accent rail.

- [ ] **Step 3: After stop + final summary lands, rename a third speaker**

If S3 appears, rename `S3 → "Guest"`. Observe:
- Final summary text on screen updates immediately with colored "Guest" tokens.
- `cat ~/Documents/Cairn/<latest>/transcript.jsonl | grep final_summary` contains "Guest" baked in.

- [ ] **Step 4: Verify no S1 leak in final summary**

```bash
grep -E '\\bS[1-9]\\b' ~/Documents/Cairn/<latest>/transcript.jsonl | grep final_summary | head -5
```

Expected: empty (no bare SIDs surviving in the final_summary line). If non-empty, the merge happened but the canonical retro didn't fire — investigate svc logs (`ssh node4 'sudo journalctl -u cairn-svc -n 200 | grep -i merge'`).

- [ ] **Step 5: Verify reduced-motion behavior**

In macOS System Settings → Accessibility → Display → Reduce Motion, toggle it on and re-launch Cairn briefly. Verify rows pop in instead of sliding.

- [ ] **Step 6: No commit needed (verification only).**

---

## Self-review checklist (run before handoff)

- [ ] Spec coverage: every requirement in the spec has a task. (Goal 1: leak fix → Tasks 7-8. Goal 2: rename works post-stop → Tasks 3+5. Goal 3: color coding → Tasks 1-3. Goal 4: row polish → Task 6.)
- [ ] No placeholders or TBDs in any step.
- [ ] Type names consistent: `SpeakerInfo`, `redrawSummaries`, `bakeNamesIntoEvents`, `_apply_canonical_substitute_retro` are referenced exactly the same in every task.
- [ ] Each task ends with a commit step.
- [ ] Each TDD task has the test BEFORE the implementation.
