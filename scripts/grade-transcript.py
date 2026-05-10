#!/usr/bin/env python3
"""grade-transcript.py — score a Cairn transcript for cross-speaker bleed
and speaker-attribution accuracy, using word-level alignment when words
are present in the snapshot, falling back to time-overlap otherwise.

Usage:
    grade-transcript.py --transcript run.json --reference dario-reference.json --out grade.json

Word-level algorithm (preferred):
  - For each Cairn final, look up each word's t_start_ms in the reference's
    [t_start_ms, t_end_ms) partition and assign that word a ground-truth
    speaker.
  - A final is "bleed" if its words map to >= 2 distinct ground-truth
    speakers (after a small noise-tolerance threshold to allow a single
    misaligned word at the boundary).
  - Speaker accuracy is the per-word fraction whose Cairn-attributed
    speaker (mapped via inferred Cairn-id → ref-speaker majority) matches
    the word's ground-truth speaker.

Time-only fallback (when words missing from snapshot):
  - Per-final overlap with reference entries; bleed if >= 2 ref speakers
    overlap by > MIN_OVERLAP_MS.
"""
import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

MIN_OVERLAP_MS = 50
# Minority-speaker words must be at least this many AND total this duration
# to flag a final as bleed. Default flags any cross-speaker presence; raise
# via flags if you want to ignore single-word boundary artifacts.
WORD_BLEED_MIN_MINORITY = 1
WORD_BLEED_MIN_DURATION_MS = 0


def load_transcript(path: str) -> list[dict]:
    text = Path(path).read_text().strip()
    if not text:
        return []
    if text[0] == "[":
        return json.loads(text)
    rows: list[dict] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        rows.append(json.loads(line))
    return rows


def overlap_ms(a_start, a_end, b_start, b_end) -> int:
    return max(0, min(a_end, b_end) - max(a_start, b_start))


def reference_entries(reference: dict) -> list[dict]:
    """Return the list of reference entries, accepting both schemas:
    - lex-style `entries: [{speaker, t_start_sec, t_end_sec, ...}]`
    - youtube-style `turns:   [{speaker, t_start_sec, t_end_sec, ...}]`
    """
    if "entries" in reference:
        return reference["entries"]
    if "turns" in reference:
        return reference["turns"]
    return []


def is_turn_only_reference(reference: dict) -> bool:
    """Turn-only references carry synthetic per-turn speaker ids and lack
    real identities — speaker_accuracy is meaningless and should be skipped.
    Heuristic: source flag, or all speaker labels are unique (1:1 with rows)."""
    if reference.get("source") == "youtube-auto-captions":
        return True
    es = reference_entries(reference)
    if not es:
        return False
    speakers = [e.get("speaker") for e in es]
    return len(set(speakers)) == len(speakers)


def normalize_reference(reference: dict) -> list[dict]:
    """Convert reference entries to absolute Cairn-timeline ms (subtract
    anchor_sec)."""
    anchor_ms = int(reference.get("anchor_sec", 0) * 1000)
    out = []
    for e in reference_entries(reference):
        out.append({
            "speaker": e["speaker"],
            "t_start_ms": int(e["t_start_sec"] * 1000) - anchor_ms,
            "t_end_ms": int(e["t_end_sec"] * 1000) - anchor_ms,
        })
    out.sort(key=lambda e: e["t_start_ms"])
    return out


def ref_speaker_for_time(t_ms: int, ref_entries: list[dict]) -> str | None:
    """Find the reference speaker whose [t_start_ms, t_end_ms) range
    contains t_ms. Returns None if t_ms is outside all ranges."""
    for e in ref_entries:
        if e["t_start_ms"] <= t_ms < e["t_end_ms"]:
            return e["speaker"]
    return None


def grade_word_level(transcript: list[dict], ref_entries: list[dict], turn_only: bool = False) -> dict:
    """Word-level grading. Requires `words` field on each Cairn final.

    When `turn_only=True`, the reference's per-turn speaker ids are synthetic
    (one id per turn) and identity-based speaker accuracy is meaningless.
    Bleed remains correctly defined as boundary-crossing, but the
    speaker_accuracy / mapping / misattributions blocks are omitted.
    """
    bleed_finals: list[dict] = []
    gradeable_finals = 0
    off_script_finals = 0
    word_total = 0
    word_off_script = 0
    word_speakers: list[tuple[str, str]] = []  # (cairn_speaker_id, ref_speaker)

    for f in transcript:
        if "type" in f and f["type"] != "transcript_final":
            continue
        words = f.get("words")
        if not words:
            continue
        # Use word midpoint as the lookup time; less brittle than start-only.
        per_word_speakers: list[str | None] = []
        for w in words:
            mid = (int(w["t_start_ms"]) + int(w["t_end_ms"])) // 2
            per_word_speakers.append(ref_speaker_for_time(mid, ref_entries))
        known = [s for s in per_word_speakers if s is not None]
        word_total += len(words)
        word_off_script += sum(1 for s in per_word_speakers if s is None)
        if not known:
            off_script_finals += 1
            continue
        gradeable_finals += 1
        # Count distinct ref speakers in this final, optionally filtering
        # out single-word boundary jitter via thresholds.
        sp_count = Counter(known)
        majority = sp_count.most_common(1)[0][0]
        minority_count = sum(c for s, c in sp_count.items() if s != majority)
        # Compute total duration of minority-speaker words.
        minority_dur = 0
        for w, sp in zip(words, per_word_speakers):
            if sp is not None and sp != majority:
                minority_dur += int(w["t_end_ms"]) - int(w["t_start_ms"])
        is_bleed = (
            len(sp_count) >= 2
            and minority_count >= WORD_BLEED_MIN_MINORITY
            and minority_dur >= WORD_BLEED_MIN_DURATION_MS
        )
        if is_bleed:
            bleed_finals.append({
                "seq": f.get("seq"),
                "text": f.get("text"),
                "cairn_speaker": f.get("speaker_id"),
                "ref_speakers": sorted(sp_count.keys()),
                "ref_speaker_breakdown": dict(sp_count),
                "t_start_ms": f.get("t_start_ms"),
                "t_end_ms": f.get("t_end_ms"),
            })
        # Accumulate per-word (cairn_speaker, ref_speaker) for accuracy.
        cs = f.get("speaker_id", "")
        for s in known:
            word_speakers.append((cs, s))

    if turn_only:
        return {
            "summary": {
                "mode": "word-level (turn-only)",
                "total_finals": len(transcript),
                "gradeable_finals": gradeable_finals,
                "bleed_finals": len(bleed_finals),
                "off_script_finals": off_script_finals,
                "bleed_rate": round(len(bleed_finals) / gradeable_finals if gradeable_finals else 0.0, 4),
                "word_total": word_total,
                "word_off_script": word_off_script,
            },
            "bleeds": bleed_finals,
        }

    # Infer Cairn-speaker → ref-speaker mapping by majority vote on words.
    cs_to_ref = defaultdict(Counter)
    for cs, rs in word_speakers:
        cs_to_ref[cs][rs] += 1
    mapping: dict[str, str] = {
        cs: votes.most_common(1)[0][0] for cs, votes in cs_to_ref.items()
    }

    # Word-level accuracy: per word, does Cairn's mapped speaker match the
    # word's ground-truth speaker?
    correct = 0
    incorrect = 0
    misattributions: list[dict] = []
    for f in transcript:
        if "type" in f and f["type"] != "transcript_final":
            continue
        words = f.get("words")
        if not words:
            continue
        cs = f.get("speaker_id", "")
        expected = mapping.get(cs, cs)
        per_word_correct = 0
        per_word_incorrect = 0
        for w in words:
            mid = (int(w["t_start_ms"]) + int(w["t_end_ms"])) // 2
            actual = ref_speaker_for_time(mid, ref_entries)
            if actual is None:
                continue
            if actual == expected:
                correct += 1
                per_word_correct += 1
            else:
                incorrect += 1
                per_word_incorrect += 1
        if per_word_incorrect > 0 and per_word_incorrect >= per_word_correct:
            # The MAJORITY of words in this final disagree with the
            # row's attribution — likely a true misattribution.
            misattributions.append({
                "seq": f.get("seq"),
                "cairn_speaker": cs,
                "mapped_to": expected,
                "correct_words": per_word_correct,
                "wrong_words": per_word_incorrect,
                "text": f.get("text"),
            })

    word_accuracy = correct / (correct + incorrect) if (correct + incorrect) else 0.0

    return {
        "summary": {
            "mode": "word-level",
            "total_finals": len(transcript),
            "gradeable_finals": gradeable_finals,
            "bleed_finals": len(bleed_finals),
            "off_script_finals": off_script_finals,
            "bleed_rate": round(len(bleed_finals) / gradeable_finals if gradeable_finals else 0.0, 4),
            "word_total": word_total,
            "word_off_script": word_off_script,
            "word_accuracy": round(word_accuracy, 4),
            "speaker_mapping": mapping,
        },
        "bleeds": bleed_finals,
        "misattributions": misattributions,
    }


def grade_time_only(transcript: list[dict], ref_entries: list[dict]) -> dict:
    """Fallback: per-final time overlap (legacy)."""
    bleed_finals: list[dict] = []
    gradeable = 0
    off_script = 0
    for f in transcript:
        if "type" in f and f["type"] != "transcript_final":
            continue
        t0 = int(f.get("t_start_ms", 0))
        t1 = int(f.get("t_end_ms", 0))
        speakers = set()
        for r in ref_entries:
            if overlap_ms(t0, t1, r["t_start_ms"], r["t_end_ms"]) > MIN_OVERLAP_MS:
                speakers.add(r["speaker"])
        if not speakers:
            off_script += 1
            continue
        gradeable += 1
        if len(speakers) >= 2:
            bleed_finals.append({
                "seq": f.get("seq"),
                "text": f.get("text"),
                "cairn_speaker": f.get("speaker_id"),
                "ref_speakers": sorted(speakers),
                "t_start_ms": t0,
                "t_end_ms": t1,
            })
    return {
        "summary": {
            "mode": "time-only",
            "total_finals": len(transcript),
            "gradeable_finals": gradeable,
            "bleed_finals": len(bleed_finals),
            "off_script_finals": off_script,
            "bleed_rate": round(len(bleed_finals) / gradeable if gradeable else 0.0, 4),
        },
        "bleeds": bleed_finals,
    }


def auto_calibrate_anchor(transcript: list[dict], reference: dict) -> float:
    """Detect the per-run anchor offset between Cairn's recording-time and
    the reference's t_start_sec timeline. Returns the anchor_sec to use.

    Strategy: for each Cairn final with words, find the reference entry
    whose first 4 words are the closest fuzzy match to the Cairn final's
    first 4 words. The cairn t_start_ms - reference t_start_sec*1000 of
    that pair is the offset. Take the median across pairs.
    """
    import re

    def norm_words(s: str, n: int = 4) -> list[str]:
        toks = [w for w in re.split(r"[^a-z0-9']+", (s or "").lower()) if w]
        return toks[:n]

    ref_entries = reference_entries(reference)
    pairs: list[float] = []  # offsets in seconds: cairn_time - (ref_time - anchor)
    used_ref = set()
    for f in transcript:
        if "type" in f and f["type"] != "transcript_final":
            continue
        cw = norm_words(f.get("text", ""), 4)
        if len(cw) < 3:
            continue
        cairn_t = int(f.get("t_start_ms", 0)) / 1000.0
        # Find best-matching reference entry not already used.
        best_score, best_idx = 0, -1
        for i, e in enumerate(ref_entries):
            if i in used_ref:
                continue
            rw = norm_words(e.get("text", ""), 4)
            if not rw:
                continue
            score = sum(1 for a, b in zip(cw, rw) if a == b)
            if score > best_score:
                best_score = score
                best_idx = i
        if best_score < 3 or best_idx < 0:
            continue
        used_ref.add(best_idx)
        ref_t = float(ref_entries[best_idx]["t_start_sec"])
        # offset such that cairn_t = ref_t - anchor → anchor = ref_t - cairn_t
        pairs.append(ref_t - cairn_t)
        if len(pairs) >= 5:
            break  # 5 pairs is plenty for median
    if not pairs:
        return float(reference.get("anchor_sec", 0))
    pairs.sort()
    median = pairs[len(pairs) // 2]
    return median


def grade(transcript: list[dict], reference: dict, anchor_sec: float | None = None) -> dict:
    if anchor_sec is not None:
        reference = {**reference, "anchor_sec": anchor_sec}
    ref_entries = normalize_reference(reference)
    has_words = any(
        bool(f.get("words"))
        for f in transcript
        if "type" not in f or f.get("type") == "transcript_final"
    )
    turn_only = is_turn_only_reference(reference)
    if has_words:
        return grade_word_level(transcript, ref_entries, turn_only=turn_only)
    return grade_time_only(transcript, ref_entries)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--transcript", required=True)
    ap.add_argument("--reference", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--anchor-sec", type=float, default=None,
                    help="Override reference anchor_sec. Default auto-calibrates by matching the first few finals to reference turns.")
    ap.add_argument("--no-auto-anchor", action="store_true",
                    help="Disable auto-calibration (use reference's anchor_sec verbatim).")
    args = ap.parse_args()

    transcript = load_transcript(args.transcript)
    reference = json.loads(Path(args.reference).read_text())
    anchor = args.anchor_sec
    if anchor is None and not args.no_auto_anchor:
        anchor = auto_calibrate_anchor(transcript, reference)
        original = float(reference.get("anchor_sec", 0))
        if abs(anchor - original) > 0.05:
            print(f"[auto-anchor] {original:.2f} → {anchor:.2f} (drift={anchor - original:+.2f}s)",
                  file=sys.stderr)
    result = grade(transcript, reference, anchor_sec=anchor)
    Path(args.out).write_text(json.dumps(result, indent=2))

    s = result["summary"]
    if s["mode"] == "word-level":
        print(
            f"[word-level] Bleed: {s['bleed_finals']}/{s['gradeable_finals']} = "
            f"{s['bleed_rate'] * 100:.1f}%; "
            f"Speaker accuracy: {s['word_accuracy'] * 100:.1f}% "
            f"({s['word_total'] - s['word_off_script']} on-script words); "
            f"off-script finals: {s['off_script_finals']}; "
            f"mapping: {s['speaker_mapping']}"
        )
    elif s["mode"] == "word-level (turn-only)":
        print(
            f"[word-level/turn-only] Bleed: {s['bleed_finals']}/{s['gradeable_finals']} = "
            f"{s['bleed_rate'] * 100:.1f}%; "
            f"on-script words: {s['word_total'] - s['word_off_script']}; "
            f"off-script finals: {s['off_script_finals']}"
        )
    else:
        print(
            f"[time-only] Bleed rate: {s['bleed_rate'] * 100:.1f}% "
            f"({s['bleed_finals']}/{s['gradeable_finals']} gradeable); "
            f"off-script: {s['off_script_finals']}; total: {s['total_finals']}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
