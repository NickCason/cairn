# Cairn

Live meeting transcription + speaker diarization, served from cairn-svc
on node4 to any tailnet device. Open the webapp in Safari at
<https://precision-node4.taild99f50.ts.net/>. Sessions land at
`~/cairn-svc/sessions/<slug>/` on node4. This repo holds the renderer
+ harness; cairn-svc lives in `~/cairn-svc` on node4 (no GitHub
remote — local commits only).

See spec: `docs/superpowers/specs/2026-05-10-cairn-webapp-pwa-design.md`
and plan: `docs/superpowers/plans/2026-05-10-cairn-webapp-pwa.md`.

## Quickstart
- `npm install`
- `npm run build` — compile renderer TS
- `npm run deploy` — build + rsync `dist/renderer/*` + assets to node4 + restart cairn-svc
- `bash scripts/cairn-loop.sh` — end-to-end harness run (audio routing via BlackHole 2ch)
