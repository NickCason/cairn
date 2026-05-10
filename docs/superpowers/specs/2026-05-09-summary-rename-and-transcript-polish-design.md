# Speaker substitution + transcript polish

**Date:** 2026-05-09
**Scope:** Five linked changes — (1) leak fix for stale SIDs in summaries after svc-internal merges, (2) timestamps + Lively+ animations on transcript rows, (3) live retroactive update of rolling AND final summaries on user rename (works post-final-summary, where the current path breaks), (4) color-coded speaker name tokens in rolling + final summaries, (5) saved transcript.jsonl gets canonical SIDs and user-assigned names baked in.

## Goals

1. **No stale SIDs surface to the user.** When `S1→S2` merges internally, prior rolling summaries and the cached final summary stop saying "S1 mentions…" and start saying "S2 mentions…". Saved files agree.
2. **Renames update everything, anywhere in the lifecycle.** Whether a rename happens during recording or after the final summary screen has been drawn, every visible mention of that speaker — transcript rows, rolling summaries, final summary — updates immediately. Saved files agree.
3. **Speaker tokens are color-coded** in rolling and final summary text, matching the speaker tag color in transcript rows. Inline mentions ("…as S2 mentioned earlier…") are colored too, not just leading tokens.
4. **Transcript rows feel alive without being noisy.** New rows arrive with a polished spring slide-in. Relabels pulse softly and the pill recolors with a brief glow. Splits expand the host row and reveal new rows. Right-aligned `mm:ss` timestamps.

## Architecture

```
                  ┌────────────────────────────────────────────┐
   user rename ──▶│ SpeakersPanel (registry: id → {name, color})│
                  └────────────────────────────────────────────┘
                                │
                                ├─▶ ws.rename(id, name, color)  ─▶  svc records in
                                │                                    _name_for_stable
                                │                                    (used for FUTURE
                                │                                    LLM prompts only)
                                │
                                └─▶ renderer.substitutionPass()
                                      │
                                      ├─▶ summary panes: walk all
                                      │     stored rolling+final
                                      │     payloads; re-render
                                      │     bullets/text fields
                                      │     with current registry
                                      │
                                      ├─▶ transcript rows: cross-fade
                                      │     pill background + color +
                                      │     text via existing
                                      │     applySpeaker(id,name,color)
                                      │
                                      └─▶ saved file: rewrite affected
                                            jsonl lines in place

   svc-internal merge (S1→S2)
                                │
                                ├─▶ _apply_canonical_substitute_retro(
                                │     sid=S1, target=S2)
                                │       walks stored rolling bullets,
                                │       substitutes variants,
                                │       emits rolling_summary_replace
                                │       per affected entry; if final
                                │       cached, rewrites + re-emits
                                │
                                └─▶ client receives replace events
                                      and renders normally
```

**Key principle (reaffirmed):** The svc never receives, infers, or invents speaker identities. Names exist only in the client's `SpeakersPanel` and (mirrored, for future LLM prompts) in `Session._name_for_stable`. The svc's emit path uses **canonical SIDs only** (post-merge); the client overlays names + colors at render time.

## Components

### Svc — leak fix (cairn_svc/server.py + summarize.py)

A new helper `_apply_canonical_substitute_retro(session, emit, *, src, target)` mirrors the existing `_apply_rename_retro` pattern but for internal merges:

- Substitute every variant of `src` SID with `target` SID in every stored rolling entry's bullets (using `substitute_speaker_variants` already in `summarize.py`).
- Re-emit `rolling_summary_replace` per affected entry with `reason: "merge"`.
- If `session.get_final_summary()` is non-None, run the same substitution over its text fields and emit a fresh `final_summary` payload.

Trigger: anywhere `session.merge_stable(src=…, dst=…)` is called (currently `_run_authoritative_pass`'s orphan-merge path and the existing rename merge path). Both call sites get one extra `await _apply_canonical_substitute_retro(…)` after the merge.

The existing `_apply_rename_retro` stays put — it handles user renames and remains the saved-file truth source while the WS is alive.

This is the entirety of the leak fix on the svc side.

### Svc — post-stop renames (cairn_svc/server.py)

Today the WS receive loop `break`s out of the `Stop` handler after the final summary lands, then the connection closes and any subsequent `speaker_rename` is silently dropped. Two paths considered:

- **Keep WS alive post-stop** for control messages only (rename, edit). The diar/auth/transcribe/summary tasks already cancel; the receive loop continues but rejects audio frames. Adds ~30 lines of state-handling.
- **Let WS close as it does today**; the client owns post-stop UX entirely. The renderer maintains its own substitution pass and (because the WS is closed) rewrites the saved transcript.jsonl in place when the user renames.

We choose **the second path**. It's simpler, aligns with the anonymity rule (server's job is bounded by the recording session), and produces the same UX on the live screen because the client already has to do its own substitution pass for #2 / #3 / #4 below. We accept that the rename round-trip to svc no longer happens post-stop — the LLM future-prompt context becomes irrelevant after stop anyway.

### Client — summary substitution + color coding (src/renderer/summary.ts)

Add `substituteSpeakerVariants(text, sid, name)` mirroring the svc's regex (variants: `S1`, `s1`, `P1`, `Speaker 1`, `Speaker_1`, `Person 1`, `Spkr_1`, etc.; word-boundary anchored, digit-exact, case-insensitive prefix). One TS function, ~15 lines.

Render pipeline change:

- `handleRollingSummary`, `handleRollingReplace`, `handleFinalSummary` no longer escape and emit raw text. Each bullet (and tldr / contributions / decisions / action_items) goes through `renderWithSpeakerTokens(text, registry)` which:
  1. HTML-escapes the input first.
  2. For each `(sid, name?, color)` in the registry:
     - Replace every variant of `sid` (S1, s1, P1, Speaker 1, Speaker_1, Spkr_1, …) with `<span class="spkref" data-spk="${sid}" style="color:${color}; font-weight:600">${name ?? sid}</span>`. Word-boundary anchored, digit-exact, case-insensitive prefix — same as svc's `substitute_speaker_variants`.
     - If `name` is set, also wrap bare occurrences of `name` (word-boundary, exact case-insensitive) in the same colored span. Server may already have substituted SID→name in transit; this wraps those occurrences. If a span already wraps the text (server pre-substituted and client added a span; we then double-process), the inner-text replace is a no-op because the SID won't appear inside the span's name text. Idempotent.
  3. Return safe HTML.
- We keep a typed cache of the latest rolling + final payloads (`RollingSummary[]`, `FinalSummary | null`) so a rename can re-render without server help.

`SpeakersPanel.onChange` (already invoked on rename) calls a new `redrawSummaries()` which iterates the cache and re-runs the render pipeline against the panel-side `el.innerHTML`. No ws round-trip required.

### Client — saved file bake-in (src/main.ts or wherever transcript.jsonl is written)

- Live writes already substitute, because the server's `rolling_summary_replace` (during recording) already runs `_sanitize_label_leaks` server-side. Files-on-disk during the recording stay accurate.
- **New**: on rename **post-stop** (when no WS is available), the renderer reads the saved `transcript.jsonl`, substitutes affected lines (rolling_summary, rolling_summary_replace, final_summary), and writes back atomically. Best-effort — log on failure but don't block the UI re-render.

Limit: this only runs for the active session's saved file (the path is known; renderer holds it). Older sessions are not retroactively fixed — that's outside scope.

### Client — transcript row polish (src/renderer/transcript.ts + style.css)

Adds the **Lively+** style approved in the brainstorm:

- **Timestamps**: a right-aligned `<span class="ts">mm:ss</span>` in each row, dimmed, tabular-nums. Computed as `t_start_ms - sessionStartMs`. Hidden if width-cramped (`@media`).
- **Spring slide-in** on new rows: `translateY(10px) → 0` with `cubic-bezier(0.16, 1.0, 0.3, 1)` over 380ms; opacity 0→1 over 320ms.
- **Accent rail** on fresh rows: 2px left edge, color = speaker's color, fades out 700ms after arrival.
- **Relabel pulse**: 700ms background tint pulse + pill `transform: scale(1.10)` + soft glow ring. Settles to scale 1 / no shadow.
- **Split animation**: when `transcript_split` arrives, the host row container expands `max-height` and inserts the new rows with their own slide-in.
- **Rename crossfade**: pill `background-color` + `color` transition over 320ms; `transform: scale(1.06)` for 240ms then back to 1.

CSS-only animations except the split one (needs a brief JS step to insert rows into the expanding host). All transitions respect `prefers-reduced-motion: reduce`.

## Data flow

| Event | Server emits | Client does |
|---|---|---|
| New rolling summary | `rolling_summary` (bullets use canonical SIDs) | Cache + render via `renderWithSpeakerTokens` |
| Internal merge (S1→S2) | `rolling_summary_replace`(s) with substituted bullets, `final_summary` if cached | Update cache + re-render |
| Auth-pass edit | `rolling_summary_replace` (LLM re-run) | Update cache + re-render |
| Final summary | `final_summary` | Cache + render |
| User rename (during) | `speaker_rename` ← client | (server records; emits replace events for past) → client cache update + render |
| User rename (post-stop) | (WS closed; nothing) | client cache update + render + rewrite saved jsonl |

## Testing

- **Unit (svc):** new test for `_apply_canonical_substitute_retro` covers the merge case the existing rename-retro tests don't. Use the existing test fixtures and substitution helpers; add ~30 lines.
- **Unit (client TS):** `substituteSpeakerVariants` test against the same variant set as svc (S1/s1/P1/Speaker 1/Spkr_1, word-boundary, digit-exact). ~10 cases.
- **E2E (manual via harness):** run a 20-min recording against `diamandis-220-reference.json` and verify (a) no S1 leak after a forced merge, (b) renaming post-final updates rolling + final + saved file, (c) animations look right.

## Out of scope

- Animations on rolling/final summary cards beyond the existing `.changed` class (current behavior preserved).
- Older sessions' saved files don't get retroactive bake-in.
- Server keeping WS alive post-stop — explicitly rejected above.

## Risks

- **Rewriting saved file in-place** has crash-window risk. Mitigation: write to `transcript.jsonl.tmp`, fsync, atomic rename. Acceptable for a personal app.
- **Color contrast** for some speaker palette colors against the dark background may be low for small text. Use the existing pill-color set (`#79c0ff`, `#e3b341`, `#56d364`, etc.) — proven to work in transcript rows. If readability suffers in a specific summary context, we can darken the bg slightly behind colored text spans (`background: rgba(0,0,0,0.15)`) at render time.

## Files touched

- `cairn_svc/server.py` — add `_apply_canonical_substitute_retro` calls at merge sites.
- `cairn_svc/summarize.py` — extract a shared substitution helper if needed; otherwise no change (existing helper is reused).
- `src/renderer/summary.ts` — new render pipeline; add `substituteSpeakerVariants`, `renderWithSpeakerTokens`, `redrawSummaries`, summary cache.
- `src/renderer/transcript.ts` — timestamps, accent rail, relabel pulse, rename crossfade.
- `src/renderer/style.css` — animations + .spkref + .ts styles.
- `src/renderer/app.ts` — wire `redrawSummaries()` to `SpeakersPanel.onChange`.
- `src/main.ts` and/or the renderer process that owns the JSONL writer — post-stop rename rewrite of transcript.jsonl. (Path is held by whichever module currently writes the file; identified during implementation. Atomic write via `${path}.tmp` + rename.)
- New tests as listed above.
