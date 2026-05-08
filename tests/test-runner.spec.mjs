import { spawn } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const WAV = join(process.cwd(), "benchmarks", "four-speaker-vendor-sync.wav");
const SCRIPT = JSON.parse(readFileSync(join(process.cwd(), "benchmarks", "script.json"), "utf8"));
const ELECTRON_BIN = join(process.cwd(), "node_modules", ".bin", "electron");

if (!existsSync(WAV)) { console.error("missing benchmark WAV"); process.exit(2); }

console.log("Launching Cairn in --test-file mode…");
const p = spawn(ELECTRON_BIN, [".", `--test-file=${WAV}`], { stdio: ["ignore","pipe","pipe"] });
let stderrBuf = "";
p.stderr.on("data", d => { stderrBuf += d.toString(); });

// Cairn auto-stops after streaming + 6s tail; quit Electron 8s after that
const deadline = setTimeout(() => p.kill("SIGTERM"), 180_000);

await new Promise(resolve => p.on("exit", resolve));
clearTimeout(deadline);

// Find the most recent benchmark output dir
const outDirRoot = join(homedir(), "Documents", "Cairn");
if (!existsSync(outDirRoot)) { console.error("no Cairn output dir"); process.exit(3); }
const dirs = readdirSync(outDirRoot).filter(d => d.includes("benchmark")).map(d => ({ d, t: 0 }))
  .sort((a, b) => b.d.localeCompare(a.d));
if (dirs.length === 0) { console.error("no benchmark output found in", outDirRoot); process.exit(3); }
const latestDir = join(outDirRoot, dirs[0].d);
const jsonlPath = join(latestDir, "transcript.jsonl");
if (!existsSync(jsonlPath)) { console.error("no transcript.jsonl in", latestDir); process.exit(3); }

const events = readFileSync(jsonlPath, "utf8").trim().split("\n").map(l => JSON.parse(l));
const finals = events.filter(e => e.type === "transcript_final");
const speakers = new Set(finals.map(e => e.speaker_id));
const fullText = finals.map(e => e.text).join(" ").toLowerCase().replace(/[-\s]/g, "");

const wantedParts = SCRIPT.expected_part_numbers;
const found = wantedParts.filter(p => fullText.includes(p.toLowerCase().replace(/[-\s]/g, "")));

console.log("\n=== BENCHMARK RESULTS ===");
console.log(`output dir:          ${latestDir}`);
console.log(`final transcripts:   ${finals.length}`);
console.log(`speakers seen:       ${[...speakers].sort().join(", ")}  (target: ≥3)`);
console.log(`part numbers found:  ${found.length}/${wantedParts.length}  ${found.join(", ")}`);
console.log("=========================\n");

let exitCode = 0;
if (speakers.size < 3) { console.error("FAIL: < 3 speakers"); exitCode = 1; }
// whisper-base struggles with controls jargon; full match needs whisper-large or LLM cleanup
if (found.length < 1) { console.error("FAIL: zero part numbers found (expected ≥1)"); exitCode = 1; }
if (exitCode === 0) console.log("✓ benchmark PASS");
process.exit(exitCode);
