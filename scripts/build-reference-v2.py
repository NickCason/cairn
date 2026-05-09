#!/usr/bin/env python3
"""build-reference-v2.py — produce a precise (word-aligned) reference
fixture from whisper word-level output + lexfridman.com per-turn text.

The lexfridman.com page lists timestamps every paragraph (~30 s
granularity) which produces 5-10 s drift when used naively. We re-anchor
each turn's start to the actual audio by fuzzy-matching the first few
words of the turn against a whisper word stream over the same audio.

Inputs:
  --whisper PATH       speaches/whisper verbose_json output (word-level)
  --turns PATH         existing dario-reference.json (for the per-turn
                       text + speaker — we only re-derive the timestamps)
  --slice-anchor-sec   YouTube-absolute time of slice second 0
                       (we sliced from t=194s, so 194)
  --out PATH           output JSON path

Output mirrors the v1 reference shape with:
  - t_start_sec re-anchored from whisper word starts (in YouTube
    absolute time = slice_anchor + whisper word start)
  - t_end_sec = next entry's t_start_sec (last = +30 s)
  - anchor_sec = the original v1 anchor_sec (carried through unchanged)

Usage:
  build-reference-v2.py \\
    --whisper /tmp/cairn-tier1/whisper-output.json \\
    --turns scripts/fixtures/dario-reference.json \\
    --slice-anchor-sec 194 \\
    --out scripts/fixtures/dario-reference-v2.json
"""
import argparse
import json
import re
import sys
from pathlib import Path


def normalize(s: str) -> list[str]:
    """Lowercase + strip non-alphanum to compare words across sources."""
    return [w for w in re.split(r"[^a-z0-9']+", s.lower()) if w]


def find_phrase_start(
    needle_words: list[str],
    haystack_words: list[dict],
    haystack_start_idx: int,
    max_search_window: int = 4000,
) -> int | None:
    """Find the index in haystack_words where needle_words first matches.

    Slides a window of len(needle_words) over haystack and accepts the
    first window whose normalized words match >=70% of the needle.
    Searches forward only; haystack_start_idx is the lower bound.
    """
    if not needle_words:
        return None
    n = len(needle_words)
    # Compare just the first 3-5 words for robust matching.
    needle_head = needle_words[: min(5, n)]
    end = min(len(haystack_words), haystack_start_idx + max_search_window)
    best_idx = None
    best_score = 0.0
    for i in range(haystack_start_idx, max(haystack_start_idx + 1, end - len(needle_head) + 1)):
        window = haystack_words[i : i + len(needle_head)]
        if not window:
            break
        window_norm = []
        for w in window:
            norm = normalize(w["word"])
            if norm:
                window_norm.append(norm[0])
        if len(window_norm) < len(needle_head):
            continue
        matches = sum(1 for a, b in zip(needle_head, window_norm) if a == b)
        score = matches / len(needle_head)
        if score > best_score:
            best_score = score
            best_idx = i
            if score == 1.0:
                break
    if best_score >= 0.6:
        return best_idx
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--whisper", required=True)
    ap.add_argument("--turns", required=True)
    ap.add_argument("--slice-anchor-sec", type=float, default=194.0,
                    help="YouTube-absolute time corresponding to whisper slice second 0")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    whisper = json.loads(Path(args.whisper).read_text())
    words = whisper.get("words", [])
    if not words:
        print("ERROR: whisper output has no words", file=sys.stderr)
        return 2
    print(f"Whisper: {len(words)} words; duration = {whisper.get('duration', 0):.1f} s",
          file=sys.stderr)

    turns_doc = json.loads(Path(args.turns).read_text())
    src_entries = turns_doc.get("entries", [])
    print(f"Turns: {len(src_entries)} entries", file=sys.stderr)

    # Only align entries whose v1 timestamp falls inside the whisper slice.
    slice_t0 = args.slice_anchor_sec
    slice_t1 = args.slice_anchor_sec + (whisper.get("duration") or 0)
    in_slice = [e for e in src_entries if slice_t0 <= e["t_start_sec"] <= slice_t1]
    print(f"Entries within whisper slice [{slice_t0:.0f}, {slice_t1:.0f}]s: "
          f"{len(in_slice)}", file=sys.stderr)

    out_entries = []
    cursor = 0  # haystack search start
    skipped = 0
    SEARCH_WINDOW_SEC = 20  # ± this many seconds around the v1 timestamp
    for e in in_slice:
        needle = normalize(e["text"])[:8]
        if not needle:
            skipped += 1
            continue
        # Constrain search to within ±SEARCH_WINDOW_SEC of v1 timestamp to
        # avoid matching coincidentally-similar early phrases.
        v1_slice_sec = e["t_start_sec"] - args.slice_anchor_sec
        win_start_sec = max(0, v1_slice_sec - SEARCH_WINDOW_SEC)
        win_end_sec = v1_slice_sec + SEARCH_WINDOW_SEC
        # Find the haystack range corresponding to this time window.
        lo, hi = 0, len(words)
        for i, w in enumerate(words):
            if w["start"] >= win_start_sec:
                lo = i
                break
        for i in range(lo, len(words)):
            if words[i]["start"] > win_end_sec:
                hi = i
                break
        local_idx = find_phrase_start(needle, words[lo:hi], 0,
                                       max_search_window=hi - lo)
        idx = lo + local_idx if local_idx is not None else None
        if idx is None:
            skipped += 1
            continue
        slice_sec = words[idx]["start"]
        out_entries.append({
            "speaker": e["speaker"],
            "t_start_sec": args.slice_anchor_sec + slice_sec,
            "text": e["text"],
            "_alignment": "v2-aligned",
            "_slice_sec": slice_sec,
            "_v1_t_start_sec": e["t_start_sec"],
            "_drift_sec": (args.slice_anchor_sec + slice_sec) - e["t_start_sec"],
        })
        cursor = idx + 1

    # Compute t_end_sec from next entry start.
    out_entries.sort(key=lambda x: x["t_start_sec"])
    for i in range(len(out_entries) - 1):
        out_entries[i]["t_end_sec"] = out_entries[i + 1]["t_start_sec"]
    if out_entries:
        # Final entry: 30 s tail
        out_entries[-1]["t_end_sec"] = out_entries[-1]["t_start_sec"] + 30.0

    out = {
        "url": turns_doc.get("url", ""),
        "anchor_sec": turns_doc.get("anchor_sec", 0),
        "entries": out_entries,
        "_meta": {
            "whisper_duration_sec": whisper.get("duration"),
            "slice_anchor_sec": args.slice_anchor_sec,
            "v1_turns": len(src_entries),
            "v2_aligned": len([e for e in out_entries if e.get("_alignment") == "v2-aligned"]),
            "v1_fallback": skipped,
        },
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out, indent=2))
    print(f"Wrote {len(out_entries)} entries to {args.out}", file=sys.stderr)
    print(f"Aligned: {out['_meta']['v2_aligned']}, fallback: {skipped}", file=sys.stderr)

    # Print drift histogram for the aligned entries.
    drifts = [e["_drift_sec"] for e in out_entries if "_drift_sec" in e]
    if drifts:
        drifts.sort()
        n = len(drifts)
        print(f"Drift stats over {n} aligned turns:", file=sys.stderr)
        print(f"  min={drifts[0]:+.2f}s  median={drifts[n//2]:+.2f}s  "
              f"max={drifts[-1]:+.2f}s", file=sys.stderr)
        big = [d for d in drifts if abs(d) > 5]
        print(f"  |drift|>5s: {len(big)}/{n}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
