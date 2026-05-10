# Cairn 1-hour performance: 3-speaker vs 2-speaker

**Date:** 2026-05-10  
**Build:** Mac client commit `5bb463f` (polish suite installed via `npm run install-app`); cairn-svc commit `cab44f2` on node4 (streaming-defers + tiered auth pass + resummary kick on relabel).

Two back-to-back 1-hour live runs against YouTube playback in Safari, recorded by Cairn.app and graded post-hoc against committed reference fixtures. Same Mac, same svc, same model (`qwen2.5:7b-instruct-q4_K_M`), same network — only the audio source differs.

## Run identities

| Run | Source | Speakers | Reference | Recorded |
|---|---|---|---|---|
| **Diamandis ep 220** | `youtube.com/watch?v=RSNuB9pj9P8&t=296s` | 3 (Diamandis + Musk + Blundin) | `diamandis-220-reference.json` (turn-only, 1585 turns, no identities) | 60.0 min |
| **Lex/Dario** | `youtube.com/watch?v=ugvHCXCOmm4&t=194s` | 2 (Fridman + Amodei) | `dario-reference-v2.json` (whisper-aligned, 32 entries with names) | 60.0 min |

Saved sessions:
- `/tmp/cairn-test-runs/run-20260510-005304-saved-session/transcript.jsonl` (Diamandis)
- `/tmp/cairn-test-runs/lex-dario-1hr-saved-session/transcript.jsonl` (Lex/Dario)

## Headline numbers

| Metric | 3-speaker (Diamandis) | 2-speaker (Lex/Dario) |
|---|---|---|
| **Bleed rate** | 12.1% (132 / 1090) | **1.5%** (2 / 134) |
| **Speaker accuracy** | n/a (turn-only fixture) | **98.7%** (2,279 on-script words) |
| Off-script finals (past reference window) | 50 | 479 |
| Transcript finals | 1,077 | 899 |
| Auto-anchor drift | -4.90s | -1.16s |

> **Why the bleed rates aren't directly comparable.** The Diamandis fixture is YouTube auto-caption-derived, so every `>>` boundary is treated as a unique speaker turn (synthetic per-turn ids). A long correctly-attributed Cairn final that spans 2-3 short backchannel `>>` boundaries counts as bled even when it's perfectly on the right speaker. The Lex/Dario fixture has 2 actual identities, so bleed only counts true cross-speaker mis-attribution. Compare these numbers within their own fixture's history, not across.

## Speaker dynamics

| Metric | 3-speaker | 2-speaker |
|---|---|---|
| `speaker_assigned` events | 14 | 6 |
| Unique SIDs assigned | 8 (S1-S8) | 3 (S1-S3) |
| `speaker_merge` events | 3 (S3→S2, S1→S5, S7→S5) | 0 |
| `speaker_relabel` events | 1,254 | 832 |
| Rows post-relabel — dominant SIDs | S5 (537), S2 (317), S4 (124) | S1 (710), S2 (98) |
| Rows stuck on S? after stop | 96 / 1,077 (9%) | 90 / 899 (10%) |
| Rows stuck on a stray (single-row) SID | S6×2 + S8×1 = 3 | S3×1 |

**Read:** the auth pass minted 8 unique SIDs across the 3-speaker hour and consolidated to 3 dominant SIDs (S5, S2, S4) plus a couple of strays. For the 2-speaker hour, 3 SIDs minted, 2 dominant (S1=Dario at 710 rows, S2=Lex at 98 rows — Dario speaks much more in the conversation), one stray. No spurious-speaker explosion in either run.

## S?→canonical relabel latency

| Metric | 3-speaker | 2-speaker |
|---|---|---|
| Median | 24.8s | 20.4s |
| p90 | 580.1s | 595.2s |
| p99 | 939.2s | 957.0s |
| Max | 972.5s | 985.9s |
| % of S? finals eventually relabeled | 91% | 90% |

The median lines up with the tiered auth-pass design (refresh every 30s). The long tail is dominated by a small population of rows that the refresh-pass classification didn't confidently match; these waited up to ~10 min for the next establishing pass to mint or reassign. ~10% of rows (the tail) never got relabeled before the recording stopped — these are the residual `S?` rows in the saved transcripts.

## Rolling summary cleanup (the resummary-on-relabel fix)

| Metric | 3-speaker | 2-speaker |
|---|---|---|
| `rolling_summary` (initial) | 18 | 23 |
| `rolling_summary_replace` events | 89 | 40 |
| Replace reasons | edit×65, merge×1, rename×23 | edit×40 |
| Rolling summaries still containing `S?` | **0 / 18** | **0 / 23** |

This is the resummary-kick win. Every saved rolling summary in both runs has clean canonical SIDs — no `S?` survives in any bullet text.

The 3-speaker run also generated `rename` replaces (23 of them) — those reflect speaker renames the test harness doesn't trigger, so they likely came from the orphan-merge path. The 2-speaker run had only `edit` replaces because no merges fired.

## Final summary

**3-speaker:** ❌ **Final summary did not reach the client.** The svc generated it (the LLM `chat completion` for the final landed at 01:56:01 PDT, ~3 min after Stop), but the WS connection raced against the close-on-stop sequence — the emit fell through `_emit_msg`'s `RuntimeError: WS already closed` silent path. The client's 150s post-stop wait timed out before any `final_summary` event arrived.

**2-speaker:** ✅ **Final summary delivered cleanly.** 97-char tldr, 1 speaker block per speaker, 1 decision, 2 action items.

```json
{
  "ok": true,
  "tldr": "(...)",
  "speakers": [
    {"speaker": "S1", "contributions": ["..."]},
    {"speaker": "S2", "contributions": ["...", "..."]}
  ],
  "decisions": ["..."],
  "action_items": [{"...": "..."}, {"...": "..."}]
}
```

The race condition shows up only when the final-summary LLM call takes long enough to bump against the WS-close. With 3 speakers + more relabels, the drain queue is busier and the final's LLM call completes later. With 2 speakers it completes earlier.

## Cost of the tiered auth pass

Auth-pass log lines from the Diamandis 1-hr run (sampled):

```
diar(periodic):  window=[3570,3600]s  runtime=6.58s  new=4   total=1396
auth_diar(stop/establishing):  tail=[3078,3606]s  runtime=89.20s  labels=5  minted=2
```

Refresh passes (every 30s on a 90s window) cost ~5-7s of pyannote each. Establishing passes (every 10 min, full session at the time) cost up to 89s on the full hour. CPU duty cycle stays well under 50% for diarization.

## What this run validates

1. **Streaming-defers + tiered auth pass scales to 1 hour.** No spawn-then-merge explosion, no centroid drift, no collapse of speakers into one ID.
2. **Resummary-on-relabel works.** Every rolling summary in both 1-hour runs ended up with clean canonical SIDs. The note_edit + summary_queue.put kick reliably triggers `process_pending_edits`.
3. **2-speaker accuracy is at the prior best.** 1.5% bleed / 98.7% speaker accuracy on a 1-hour run is on par with the 10-min Tier-3 result (3.8% / 99.3%) and the 20-min run (4.4% / 96.4%) — better, in fact, on bleed.
4. **Polish suite is bundled into Cairn.app** (timestamps, animations, color-coded summary tokens) — though this report doesn't measure UX directly.

## Open issues surfaced by this run

### A. Final-summary delivery race (3-speaker case)

The svc closes its WS as soon as the summary queue's `final` item completes, but the `final_summary` emit and the WS-close are not coordinated. With long establishing-pass + queued resummaries, the final's LLM call lands close to or after the WS-close moment, and the emit silently fails. Fix paths:

- Block the WS-close until `_emit_msg` for the final_summary returns.
- Increase `CAIRN_SUMMARY_FINAL_DRAIN_S` to give more headroom.
- Send the final_summary BEFORE the AckMsg(stop) — guaranteeing it goes out before the client tears down.

The 3-speaker case isn't pathological; it's just slower. Same race could fire on any sufficiently-long session.

### B. ~10% of finals stuck on S?

Both runs left ~9-10% of rows on `S?` even after stop. These are rows the refresh pass couldn't classify confidently AND the establishing pass didn't pick up either. Possible: the refresh pass's 90s window doesn't catch every row's centroid moment.

Fix paths:
- Widen the refresh window to 120-150s.
- After stop, run a final classify-only sweep over the full session to relabel any remaining S? rows against the canonical centroid set.

### C. Long-tail S?→canonical latency

p90 at ~580s and p99 at ~940s suggest a small population of rows wait until the next establishing pass to get relabeled. Same root cause as B. Same fixes.

## Suggested next steps

1. **Fix the final-summary delivery race** — small svc change in the Stop handler ordering. High value (fixes the 3-speaker missing-summary).
2. **Post-stop classify-only sweep** — run a single full-session classify pass at stop time using the canonical centroid set. Should drive the residual-S? rate to near-zero.
3. **Re-run both 1-hour fixtures** to confirm A and B are fixed and the headline numbers hold.

---

*Report generated automatically post-test. Raw data preserved in `/tmp/cairn-test-runs/`.*
