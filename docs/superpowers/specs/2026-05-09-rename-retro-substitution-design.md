# Speaker-rename retroactive substitution, LLM-output sanity pass, and empty-speaker eviction

**Status:** approved 2026-05-09
**Owner:** Nick / Claude

## Problem

The `Speaker.rename` control already updates `Session._name_for_stable`, so future prompts render that speaker by name. Two problems remain:

1. **Already-emitted summaries keep the old labels.** The rolling recaps emitted before the rename still contain `S1`/`S2`/etc., so the user sees stale labels in the panel and the next rolling-summary prompt feeds those stale labels back to the LLM as prior context — which is exactly what produced the "S1 mentions… leading Dario to share…" bullet in the 2026-05-09 Lex/Dario run (summary #1 generated 10:29:07, after `S1→Lex` rename at 10:26:45).

2. **The LLM occasionally leaks raw labels into freshly-generated summaries** even when a `SPEAKER LABELS:` block is in the system prompt. The same run shows summary #1's first bullet using `S1` and `Dario` interchangeably. There is currently no post-generation check; whatever the LLM emits is stored and re-served as context.

## Goals

- A rename retroactively rewrites every stored summary so the user-facing UI and the LLM's prior-recap context both show the chosen name.
- Every freshly-generated rolling- or final-summary is sanitized before storage/emit so any stray bare labels are replaced with the current name mapping.
- No duplication of substitution logic — one helper, three call sites.

## Non-goals

- Re-running summaries through the LLM after rename. Substitution is deterministic and cheaper.
- Tracking full rename history (multi-step rename A→B→C). The handler tracks **only the immediately previous name** for a sid. When the user renames `S1` from `Lex` to `Lex Fridman`, the handler substitutes (a) bare-label variants of `S1` → `Lex Fridman`, and (b) the previous name `Lex` → `Lex Fridman` using a `\b`-anchored regex so it does not bleed into substrings (e.g. `Alex`, `Plexor`). Aliases older than one step are not tracked.
- Generic-pattern matching like `"voice 1"` or `"#1"`. Out of scope per design discussion.

## Design

### 1. Variant helper — `cairn_svc/summarize.py::substitute_speaker_variants`

```python
def substitute_speaker_variants(text: str, sid: str, name: str) -> str
```

Replaces every variant of the speaker reference for `sid` with `name`. `sid` is expected in the form `S<digits>` (or `P<digits>`). The function derives the digit suffix and matches:

| Variant family | Examples for `S1` |
| --- | --- |
| Stable id | `S1`, `s1`, `P1`, `p1` |
| With separator | `S 1`, `s 1`, `P 1`, `p 1` |
| Word forms | `Speaker 1`, `speaker 1`, `Speaker1`, `speaker1`, `speaker_1`, `Speaker_1` |
| Person forms | `Person 1`, `person 1`, `Person1`, `person1`, `person_1`, `Person_1` |
| Abbreviated | `Spkr 1`, `spkr 1`, `Spkr1`, `spkr1`, `spkr_1` |

Constraints:
- Word-boundary anchored: `S1` does not match inside `S10`, `S100`, or `S1A`.
- Digit-exact: `S1` does not match `Speaker 10` or `Person 11`.
- Case for the prefix is matched case-insensitively; case of the supplied `name` is preserved verbatim.
- The replacement is not applied recursively, so it cannot loop.

Implementation: build a single compiled regex with alternation across all variants for the given digit, scoped by `\b` boundaries. Apply with `re.sub`.

### 2. Retroactive rewrite on rename — `cairn_svc/server.py` rename handler

Where the handler currently does `session.set_name(sid, name); log.info("rename %s -> %s", sid, name)`:

1. Read the previous name (`prev = session._name_for_stable.get(sid)`) before mutating.
2. Apply the rename to `_name_for_stable`.
3. Build a per-bullet rewrite that runs in this order:
   - `substitute_speaker_variants(text, sid, name)` — bare-label variants → new name.
   - If `prev` exists and `prev != name`, `re.sub(r"\b" + re.escape(prev) + r"\b", name, text)` — old name → new name, word-boundary anchored.
4. Walk `summarizer._entries` (list of `dict` with `bullets: list[str]`). For each entry, rewrite every bullet, replace the entry, and re-emit `RollingSummaryMsg` with the same `idx`, `window_start_s`, `window_end_s`, the rewritten bullets, and the entry's existing `merged_from_failed_prior`.
5. If the session has a cached final summary (`summarizer._final` — added if missing), apply the same rewrite to `tldr` and to each `speakers[].contributions[*]` string. Re-emit `FinalSummaryMsg` with the rewritten payload.
6. Order: rewrite in-place first, then re-emit. The `_emit_msg` helper already swallows `RuntimeError` on closed-WS, so a rename after stop is harmless.

The session-stored bullets must be rewritten so the next rolling-summary prompt includes the corrected text via `build_rolling_prompt`'s `prior_entries` parameter.

### 3. LLM-output sanity pass at every summary generation

After each successful `LLMClient.chat_json` for a rolling summary in `_summary_handler`:

1. Build `name_map = {sid: name for sid, name in session._name_for_stable.items() if name}`.
2. For each `(sid, name)` in `name_map`, run `substitute_speaker_variants` over every freshly-generated bullet string.
3. Store the sanitized version in `summarizer._entries` and emit it.

Do the same after the final-summary call: substitute in `tldr` and `speakers[].contributions[*]`.

This is the safety net — catches LLM leaks like the 2026-05-09 run where summary #1's first bullet used `S1` despite a SPEAKER LABELS header.

### 4. Client side

The renderer keys `rolling_summary` by `idx`. Verify in `src/renderer/summary.ts` and `src/renderer/transcript.ts` that re-receiving the same `idx` overwrites in place; add the handler if missing. `final_summary` is rendered fresh on each receive, so no client change needed for that path.

## Testing

- **`test_substitute_speaker_variants`** — variant matrix per the table above. Negative cases: `S10` not matched when substituting `S1`; `S1A` not matched; substring `subspeaker 1text` not matched.
- **`test_rename_rewrites_stored_rolling_entries`** — seed `summarizer._entries` with bullets containing `S1` and `Speaker 1`, call rename, assert entries rewritten and `RollingSummaryMsg` emitted per entry with same `idx`.
- **`test_rename_rewrites_final_summary`** — seed final summary, rename, assert `tldr` and `speakers[].contributions[]` rewritten and `FinalSummaryMsg` re-emitted.
- **`test_summary_sanity_pass_substitutes_leaked_label`** — feed a fake LLM response with a `S1` reference while `_name_for_stable['S1'] = 'Lex'`; assert the stored/emitted bullet contains `Lex` and not `S1`.
- **`test_summary_sanity_pass_no_op_when_no_names`** — same setup with empty `_name_for_stable`; assert no substitution happens.

## File touches

| File | Change |
| --- | --- |
| `cairn_svc/summarize.py` | Add `substitute_speaker_variants`. |
| `cairn_svc/server.py` | Update rename handler to call helper + walk `summarizer._entries`/`_final` and re-emit. Update `_summary_handler` to apply sanity pass before store/emit. |
| `cairn_svc/protocol.py` | No new message types; reuse `RollingSummaryMsg` and `FinalSummaryMsg`. |
| `tests/test_summarize.py` | Helper unit tests. |
| `tests/test_authoritative.py` or new `tests/test_rename.py` | Rename-rewrite + sanity-pass tests. |
| `src/renderer/summary.ts` | Verify idx-keyed update; add if missing. |

### 5. Empty-speaker eviction in `_orphan_sweep`

The 2026-05-09 Lex/Dario run ended with `S3` visible in the sidebar despite zero ledger lines. `_orphan_sweep` flagged it as an orphan but skipped the merge because no other auth centroid was above `min_cos=0.5` — likely because `S3`'s centroid was a noise/silence artefact pointing in a random direction.

When the orphan has **zero finals AND zero seconds of ledger speech**, no real text depends on the merge target — the eviction is purely cosmetic. In that case the cosine floor is too strict.

Change `_orphan_sweep` so when an orphan has both `counts[sid] == 0` and `speech_s.get(sid, 0.0) == 0.0`:

1. Pick the highest-cosine non-orphan target ignoring `min_cos`. The merge target only inherits an empty centroid; nothing is misattributed.
2. If at least one non-orphan target exists, perform the merge and emit `speaker_merge` as today.
3. If there are zero non-orphan targets in the entire session (pathological — rename-only solo session), skip; nothing useful to do.

Test cases:
- Empty orphan with neighbors all below `min_cos` (e.g. cos 0.2): still merged to the closest neighbor; `speaker_merge` emitted; `_auth_centroids` and `_centroids` cleaned.
- Empty orphan with one neighbor above and one below `min_cos`: picks the above-floor neighbor (same as current behaviour).
- Non-empty orphan with all neighbors below floor: still skipped (existing safety preserved — preserves real cameos).

## Out of scope (explicit)

- Persisting summaries to disk before stop.
- Renaming via right-click in the UI (assumed already works; this work is downstream of the existing rename control).
- Stripping markdown fences from sanity-pass results (already handled by `_strip_json_fence` upstream).
