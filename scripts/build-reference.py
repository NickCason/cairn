#!/usr/bin/env python3
"""Builds scripts/fixtures/dario-reference.json from
https://lexfridman.com/dario-amodei-transcript.

The page renders speaker turns as <p> elements; each turn typically has
a leading speaker name + a parenthetical timestamp like '(00:03:14)'.
We parse those into a JSON file with absolute-time entries.
"""
import argparse
import json
import re
import sys
from pathlib import Path
from urllib.request import urlopen, Request

URL = "https://lexfridman.com/dario-amodei-transcript"
ANCHOR_SEC = 194  # YouTube ?t=194s — when Cairn recording starts

TIMESTAMP_RE = re.compile(r"\((\d{1,2}):(\d{2}):(\d{2})\)")


def fetch_html(url: str) -> str:
    req = Request(url, headers={"User-Agent": "Mozilla/5.0 (cairn-loop)"})
    with urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", errors="replace")


def parse_entries(html: str) -> list[dict]:
    """Extract (speaker, t_start_sec, text) tuples from the transcript HTML.

    The Lex Fridman transcript page uses a structure like:
      <div class="ts-segment">
        <span class="ts-name">Speaker Name</span>
        <span class="ts-timestamp"><a href="...?t=NNN">(HH:MM:SS)</a></span>
        <span class="ts-text">...</span>
      </div>

    Some segments have empty ts-name spans (continuation of the previous
    speaker's block broken across multiple paragraphs). We carry the last
    known speaker forward for those.
    """
    segments = re.findall(
        r'<div[^>]*class="ts-segment"[^>]*>(.*?)</div>',
        html, flags=re.S | re.I,
    )
    entries: list[dict] = []
    last_speaker = ""
    for seg in segments:
        # Speaker name
        m_name = re.search(
            r'<span[^>]*class="ts-name"[^>]*>(.*?)</span>', seg, re.S | re.I
        )
        if m_name:
            raw = re.sub(r"<[^>]+>", "", m_name.group(1)).strip()
            if raw:
                last_speaker = raw
        speaker = last_speaker

        # Timestamp — prefer the ?t= param (seconds), fall back to (HH:MM:SS)
        m_tsec = re.search(r'[?&]t=(\d+)', seg, re.I)
        if m_tsec:
            t_sec = int(m_tsec.group(1))
        else:
            m_ts = TIMESTAMP_RE.search(seg)
            if not m_ts:
                continue
            h, mn, s = (int(x) for x in m_ts.groups())
            t_sec = h * 3600 + mn * 60 + s

        # Text
        m_text = re.search(
            r'<span[^>]*class="ts-text"[^>]*>(.*?)</span>', seg, re.S | re.I
        )
        if not m_text:
            continue
        text = re.sub(r"<[^>]+>", "", m_text.group(1))
        text = re.sub(r"&#\d+;|&amp;|&lt;|&gt;|&quot;|&#8217;|&#8220;|&#8221;|&#038;",
                      lambda m: {
                          "&amp;": "&", "&lt;": "<", "&gt;": ">",
                          "&quot;": '"', "&#8217;": "'", "&#8220;": "“",
                          "&#8221;": "”", "&#038;": "&",
                      }.get(m.group(0), ""), text)
        text = re.sub(r"\s+", " ", text).strip()
        if not text or not speaker:
            continue
        entries.append({
            "speaker": speaker,
            "t_start_sec": float(t_sec),
            "text": text,
        })

    entries.sort(key=lambda e: e["t_start_sec"])
    for i in range(len(entries) - 1):
        entries[i]["t_end_sec"] = entries[i + 1]["t_start_sec"]
    if entries:
        entries[-1]["t_end_sec"] = entries[-1]["t_start_sec"] + 30.0
    return entries


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=URL)
    ap.add_argument("--anchor-sec", type=int, default=ANCHOR_SEC)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    html = fetch_html(args.url)
    entries = parse_entries(html)
    if len(entries) < 5:
        print(
            f"ERROR: only {len(entries)} entries parsed; HTML structure may "
            "have changed. Inspect the HTML manually and adjust parse_entries.",
            file=sys.stderr,
        )
        return 2

    out = {
        "url": args.url,
        "anchor_sec": args.anchor_sec,
        "entries": entries,
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out, indent=2))
    print(f"wrote {len(entries)} entries to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
