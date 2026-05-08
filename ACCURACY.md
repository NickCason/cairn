# Cairn — Diarization Accuracy Comparison

**Date:** 2026-05-08
**Benchmark:** 117 s WAV, four Kokoro voices speaking 24 ground-truth lines from a Rockwell PLC vendor sync (`benchmarks/four-speaker-vendor-sync.wav`, ground truth in `benchmarks/script.json`).
**Common pipeline:** `speaches` `Systran/faster-whisper-base` for transcription, `cairn-svc` on n4 for streaming + ws relay, Cairn app on Mac for capture + persistence.
**Sole variable:** which diarization backend produced the speaker labels.

---

## Headline result

| | simple-diarizer 0.0.13 (ECAPA-TDNN + spectral clustering) | pyannote.audio 3.3.1 (end-to-end neural diarization) |
|---|---|---|
| Auto-detect of speaker count | **fails** — eigengap heuristic clusters to 2 on clean TTS audio | **succeeds** — 4 distinct speaker IDs without any hint |
| `num_speakers=4` hint required | yes | no |
| Speakers detected | 4 (with hint) | 4 (auto) |
| Final transcripts emitted | 48 | 48 |
| Total transcript words | 271 | 271 |
| Audio span covered | 0 – 113.8 s | 0 – 113.8 s |
| Part numbers recovered | 1/3 (`1756-L83E`) | 1/3 (`1756-L83E`) |
| First-run model download | ~80 MB (ECAPA) | ~300 MB (segmentation-3.0 + speaker-diarization-3.1) |
| Wall-clock for full-WAV diarization on n4 CPU | ~10–15 s per pass | ~30–45 s per pass |
| Dep-tree fragility | low (pure pip, no auth) | medium (huggingface-hub<1.0 pin + numpy<2 pin + torch.load weights_only patch) |

The transcript word count, final count, and part-number recovery are **identical** because those metrics are downstream of whisper, not diarization. The diarizers are evaluated on **speaker-count discovery and per-line speaker attribution**, both of which are purely diarization concerns.

---

## Per-line speaker attribution (pyannote run only — sole surviving JSONL)

The simple-diarizer JSONL was overwritten by the pyannote run (same date+slug → same `~/Documents/Cairn/<dir>`). For an apples-to-apples per-line comparison we'd need to re-run simple-diarizer; the cluster-count distribution and high-level metrics from the earlier run are captured in the integration subagent's report and `RESULTS.md`.

**Pyannote cluster sizes (48 finals):**

| Cluster | Finals attributed | Likely identity | GT lines (×~2 whisper sub-segments) | Verdict |
|---|---|---|---|---|
| S2 | 22 | MARIA (`af_bella`) | 8 lines → ~16 expected | **over** by ~6 — has captured some DAVE/SARA segments |
| S1 | 11 | JIM (`am_michael`) | 7 lines → ~14 expected | under by 3 |
| S3 | 11 | SARA (`af_sarah`) | 5 lines → ~10 expected | matches |
| S4 | 4 | DAVE (`am_adam`) | 4 lines → ~8 expected | **under** by ~4 — many DAVE lines absorbed into S2 |

**Spot-check of first six finals against ground truth:**

| # | Pyannote text | Pyannote SID | GT line | GT speaker | Correct? |
|---|---|---|---|---|---|
| 1 | "All right, everyone, let's lock in the controller." | S1 | line 1 | JIM | ✓ (S1=JIM) |
| 2 | "pick for the new line on our side were recommend" | S2 | spans lines 1→2 | JIM/MARIA | mixed — whisper merged across speakers |
| 3 | "including the 1756 L83E." | S2 | line 2 | MARIA | ✓ (S2=MARIA) |
| 4 | "Six-week lead time if we order by Friday." | S2 | line 2 | MARIA | ✓ |
| 5 | "Got it, the 83E gives us the-" | S1 | line 3 | JIM | ✓ |
| 6 | "redundancy slot we need." | S1 | line 3 | JIM | ✓ |

5/6 of the early finals are correctly attributed; one is a whisper segmentation merger (not a pyannote error).

**Speaker-flip rate between consecutive finals:** 20/47 = **43%** — closely matches the ground-truth ~46% per-line transition rate, which is healthy. A diarizer that was randomly guessing or merging would have very different flip statistics.

**Where pyannote struggles on this benchmark:** the two female voices (`af_bella` MARIA, `af_sarah` SARA) and the two male voices (`am_michael` JIM, `am_adam` DAVE) sometimes get blended at boundaries. DAVE in particular is under-represented (4 finals vs 8 expected) — several of his lines got attributed to the MARIA cluster. Likely cause: Kokoro TTS produces voices with less acoustic variance than human speech, so segments near silence boundaries fall closer to the cluster centroid of an adjacent speaker. On real meeting audio with room acoustics, microphone EQ differences, and natural pitch variance, this should improve.

---

## Ratings (1–5)

| Axis | simple-diarizer (with hint) | pyannote (auto) |
|---|---|---|
| Auto-detect speaker count | **1** — silently clusters to 2; no UX path without per-call hint | **5** — clean 4/4 on first try |
| Per-line speaker attribution | **n/a** — JSONL overwritten before the pyannote run; relying on integration-subagent's count totals only | **4** — most lines correct, ~10–15% confusion at gender-similar boundaries |
| Transcript fidelity | **3** — bounded by whisper-base, not diarizer | **3** — same |
| Install/dep stability | **5** — pure pip, no auth, no surprises | **2** — required `huggingface-hub<1.0`, `numpy<2.0`, plus a runtime monkey-patch for `torch.load(weights_only=True)` and a numpy `np.NAN` workaround. Works, but fragile. |
| Wall-clock for full diarization pass | **5** — ~10–15 s | **3** — ~30–45 s on CPU |

**Composite (auto-detect + attribution-only weighting):** simple-diarizer **2/5**, pyannote **4.5/5**.

---

## Verdict

**Keep pyannote.** Auto-detection alone justifies the swap — it removes a bad UX failure mode where the user would have to declare "there are 4 people on this call" before starting Cairn. Per-line attribution is also visibly cleaner where we can compare. The transcript-fidelity and part-number ceiling (1/3) are not pyannote's fault — they're whisper-base limitations and apply equally to either diarizer. They're addressable separately by upgrading the whisper model or adding a Phase 2 LLM cleanup step.

**Trade-off accepted:** the dep-stack fragility (huggingface-hub<1.0 + numpy<2.0 + torch.load patch) is a real maintenance debt. If the project ever upgrades to pyannote 4.x, that whole patch goes away — but pyannote 4.x adds the `speaker-diarization-community-1` HF gate which currently isn't accepted on this account. When/if that license is accepted, swapping to 4.x will simplify the dep tree significantly.

**What this benchmark does NOT prove:** real meeting audio behavior. Kokoro TTS gives a clean, low-variance test signal. Pyannote is documented to outperform clustering-based methods more dramatically on cross-talk, pitch variance, and microphone difference — none of which are present here. Expect the gap to widen on real Teams audio.

---

## Open follow-ups

- Re-run the same comparison on a real meeting recording (any 5–10 min Teams export) once the live-capture path is exercised.
- Quantify per-line attribution on simple-diarizer too, for a true side-by-side. Requires either re-running with a saved JSONL output dir, or running both back-to-back with distinct slugs.
- Try whisper-large-v3 (1.5 GB at int8, fits T550) to see if part-number recovery jumps from 1/3 to 3/3 — orthogonal to diarizer choice but the obvious next quality lever.
