#!/usr/bin/env python3
"""
Build a turn-only reference fixture from a YouTube auto-caption VTT.

YouTube auto-captions provide:
  - word-level timestamps (<HH:MM:SS.mmm><c> word</c> format)
  - turn boundaries (`>>` at the start of a cue marks a speaker change)
  - NO speaker identities

The output fixture mirrors the lex-style schema in shape but omits speaker
names. Each turn carries a synthetic id (T0, T1, ...) so the grader can
detect bleed via boundary-crossing without inferring speaker identity.

Output schema:
  {
    "video_url": str,
    "source": "youtube-auto-captions",
    "n_speakers": int,        # informational only; not used for grading
    "turns": [
      {
        "idx": int,           # turn index
        "speaker": "T<idx>",  # synthetic per-turn id (no identity)
        "t_start_sec": float,
        "t_end_sec": float,
        "text": str,
        "words": [{"w": str, "t_start_sec": float, "t_end_sec": float}, ...]
      },
      ...
    ]
  }

Usage:
  scripts/build-reference-yt.py \
    --vtt path/to/episode.en-orig.vtt \
    --video-url https://www.youtube.com/watch?v=XXXX \
    --t-start 296 \
    --n-speakers 3 \
    --out scripts/fixtures/diamandis-220-reference.json
"""
from __future__ import annotations
import argparse
import json
import re
import sys
from pathlib import Path

TS_RE = re.compile(r'^(\d{2}):(\d{2}):(\d{2})\.(\d{3}) --> (\d{2}):(\d{2}):(\d{2})\.(\d{3})')
WORD_TS_RE = re.compile(r'<(\d{2}):(\d{2}):(\d{2})\.(\d{3})>')
SPEAKER_CHANGE_RE = re.compile(r'^(?:&gt;&gt;|>>)\s*')


def ts_to_sec(h: int, m: int, s: int, ms: int) -> float:
    return h * 3600 + m * 60 + s + ms / 1000.0


def parse_word_run(content: str, cue_start: float, cue_end: float) -> list[dict]:
    """Parse a single content line into [{w, t_start_sec, t_end_sec}, ...].

    The first word starts at cue_start. Each <HH:MM:SS.mmm> tag inside the
    string marks the START of the next word. The last word ends at cue_end.
    """
    text = SPEAKER_CHANGE_RE.sub('', content)
    text = text.replace('<c>', '').replace('</c>', '')
    text = text.replace('&amp;', '&').replace('&gt;', '>').replace('&lt;', '<').replace('&quot;', '"').replace('&#39;', "'")
    parts = []
    cursor = 0
    starts: list[float] = [cue_start]
    chunks: list[str] = []
    for m in WORD_TS_RE.finditer(text):
        chunks.append(text[cursor:m.start()])
        starts.append(ts_to_sec(int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4))))
        cursor = m.end()
    chunks.append(text[cursor:])
    if len(starts) != len(chunks):
        return []
    words: list[dict] = []
    for i, (chunk, start) in enumerate(zip(chunks, starts)):
        chunk = chunk.strip()
        if not chunk:
            continue
        end = starts[i + 1] if (i + 1) < len(starts) else cue_end
        for w in chunk.split():
            words.append({'w': w, 't_start_sec': start, 't_end_sec': end})
            start = end
    return words


def parse_vtt(vtt_text: str) -> list[dict]:
    """Return a list of cues with {start, end, content_line, is_turn_start, words}."""
    cues: list[dict] = []
    blocks = re.split(r'\n\s*\n', vtt_text)
    for block in blocks:
        lines = [ln for ln in block.splitlines() if ln.strip() != '']
        if not lines:
            continue
        ts_idx = None
        for i, ln in enumerate(lines):
            m = TS_RE.match(ln)
            if m:
                ts_idx = i
                break
        if ts_idx is None:
            continue
        m = TS_RE.match(lines[ts_idx])
        start = ts_to_sec(int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4)))
        end = ts_to_sec(int(m.group(5)), int(m.group(6)), int(m.group(7)), int(m.group(8)))
        if end - start < 0.05:
            continue
        # Real content line is the LAST line with embedded word timestamps;
        # if no such line, skip (transition cues without word timing).
        content = None
        for ln in reversed(lines[ts_idx + 1:]):
            if WORD_TS_RE.search(ln):
                content = ln
                break
        if content is None:
            continue
        is_turn_start = bool(SPEAKER_CHANGE_RE.match(content))
        words = parse_word_run(content, start, end)
        if not words:
            continue
        cues.append({
            'start': start,
            'end': end,
            'is_turn_start': is_turn_start,
            'words': words,
        })
    return cues


def cues_to_turns(cues: list[dict], t_start: float = 0.0) -> list[dict]:
    """Group consecutive cues into turns. A turn ends when the next cue's
    is_turn_start flag is True. Cues before t_start are discarded; the first
    surviving cue forces a turn start regardless of its flag."""
    turns: list[dict] = []
    current: dict | None = None
    started = False
    for cue in cues:
        if cue['end'] < t_start:
            continue
        if not started:
            current = {'words': []}
            current['t_start_sec'] = max(cue['start'], t_start)
            started = True
        elif cue['is_turn_start']:
            if current is not None and current['words']:
                turns.append(current)
            current = {'words': [], 't_start_sec': cue['start']}
        # Trim leading words that fall before t_start on the very first cue.
        ws = cue['words']
        if not turns and current is not None and not current['words']:
            ws = [w for w in ws if w['t_end_sec'] >= t_start]
        if current is not None:
            current['words'].extend(ws)
            current['t_end_sec'] = cue['end']
    if current is not None and current['words']:
        turns.append(current)
    out = []
    for i, t in enumerate(turns):
        text = ' '.join(w['w'] for w in t['words']).strip()
        if not text:
            continue
        out.append({
            'idx': len(out),
            'speaker': f'T{len(out)}',
            't_start_sec': round(t['words'][0]['t_start_sec'], 3),
            't_end_sec': round(t['words'][-1]['t_end_sec'], 3),
            'text': text,
            'words': [{'w': w['w'], 't_start_sec': round(w['t_start_sec'], 3), 't_end_sec': round(w['t_end_sec'], 3)} for w in t['words']],
        })
    return out


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument('--vtt', required=True, help='Path to YouTube auto-caption VTT (en-orig recommended)')
    p.add_argument('--video-url', required=True)
    p.add_argument('--t-start', type=float, default=0.0, help='Start the fixture at this video timestamp (seconds)')
    p.add_argument('--n-speakers', type=int, required=True, help='Informational; the fixture itself has no identities')
    p.add_argument('--out', required=True)
    args = p.parse_args()

    vtt_text = Path(args.vtt).read_text()
    cues = parse_vtt(vtt_text)
    if not cues:
        print('no cues parsed — VTT format unrecognized', file=sys.stderr)
        return 1
    turns = cues_to_turns(cues, t_start=args.t_start)
    if not turns:
        print('no turns produced — check --t-start', file=sys.stderr)
        return 1

    fixture = {
        'video_url': args.video_url,
        'source': 'youtube-auto-captions',
        'anchor_sec': args.t_start,
        'n_speakers': args.n_speakers,
        'turn_count': len(turns),
        'duration_sec': round(turns[-1]['t_end_sec'] - turns[0]['t_start_sec'], 3),
        'turns': turns,
    }
    Path(args.out).write_text(json.dumps(fixture, indent=2))
    print(f"wrote {args.out}")
    print(f"turns: {len(turns)}  span: {turns[0]['t_start_sec']:.1f}s..{turns[-1]['t_end_sec']:.1f}s  words: {sum(len(t['words']) for t in turns)}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
