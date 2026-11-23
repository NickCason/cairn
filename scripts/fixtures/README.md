# Reference fixtures

The grader (`scripts/grade-transcript.py`) scores a Cairn run against a reference transcript of the same audio.
The references are other people's published transcripts and captions, so they are not committed; build them locally:

- `dario-reference.json`: `python3 scripts/build-reference.py` (from the episode's published transcript page)
- `dario-reference-v2.json`: `python3 scripts/build-reference-v2.py --whisper <verbose_json> --slice-anchor-sec <sec> --out scripts/fixtures/dario-reference-v2.json`
- other episodes: `python3 scripts/build-reference-yt.py` from the video's auto-caption VTT (turn boundaries only, no speakers)

`scripts/cairn-loop.sh` reads `REFERENCE` (default `scripts/fixtures/dario-reference-v2.json`).
