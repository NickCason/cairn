#!/usr/bin/env python3
"""grade-transcript.py — score a Cairn transcript for cross-speaker bleed.

Usage:
    grade-transcript.py --transcript run.json --reference dario-reference.json --out grade.json

Algorithm:
  - Convert reference entries to absolute Cairn-timeline ms (subtract
    anchor_sec).
  - For each Cairn final, compute the set of distinct reference speakers
    whose entries overlap the final by > MIN_OVERLAP_MS.
  - "off-script" if no reference overlap; excluded from the bleed-rate
    denominator.
  - "gradeable" otherwise; "bleed" if >= 2 distinct reference speakers.
  - bleed_rate = bleed_finals / gradeable_finals (0.0 if gradeable == 0).
"""
import argparse
import json
import sys
from pathlib import Path

MIN_OVERLAP_MS = 50


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


def grade(transcript: list[dict], reference: dict) -> dict:
    anchor_ms = int(reference.get("anchor_sec", 0) * 1000)
    ref_entries = []
    for e in reference["entries"]:
        ref_entries.append({
            "speaker": e["speaker"],
            "t_start_ms": int(e["t_start_sec"] * 1000) - anchor_ms,
            "t_end_ms": int(e["t_end_sec"] * 1000) - anchor_ms,
        })

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

    bleed_count = len(bleed_finals)
    bleed_rate = (bleed_count / gradeable) if gradeable else 0.0

    return {
        "summary": {
            "total_finals": len(transcript),
            "gradeable_finals": gradeable,
            "bleed_finals": bleed_count,
            "off_script_finals": off_script,
            "bleed_rate": round(bleed_rate, 4),
        },
        "bleeds": bleed_finals,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--transcript", required=True)
    ap.add_argument("--reference", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    transcript = load_transcript(args.transcript)
    reference = json.loads(Path(args.reference).read_text())
    result = grade(transcript, reference)
    Path(args.out).write_text(json.dumps(result, indent=2))

    s = result["summary"]
    print(
        f"Bleed rate: {s['bleed_rate'] * 100:.1f}% "
        f"({s['bleed_finals']}/{s['gradeable_finals']} gradeable); "
        f"off-script: {s['off_script_finals']}; total: {s['total_finals']}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
