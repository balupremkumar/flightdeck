// _qa-frames.mjs — copy specific already-rendered frames (by frame number, or
// by "scene:offset") into e2e-shots/showcase-qa/ for visual review. Unlike
// the old _frames.mjs (which seeks a .webm through a <video> element), the
// showcase pipeline keeps every source PNG on disk, so QA just copies the
// exact frame that was captured — no re-encode, no seek approximation.
//
// Usage: node _qa-frames.mjs frame-000090 worktrees:30 attention:150 review:0
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRAMES_DIR = path.join(__dirname, "out", "frames-hero");
const QA_DIR = path.join(__dirname, "..", "e2e-shots", "showcase-qa");
fs.mkdirSync(QA_DIR, { recursive: true });

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "out", "manifest.json"), "utf8"));

function resolveFrame(spec) {
  if (/^frame-\d+$/.test(spec)) return parseInt(spec.slice(6), 10);
  const m = /^([a-zA-Z]+):(-?\d+)$/.exec(spec);
  if (m) {
    const b = manifest.bookmarks[m[1]];
    if (!b) throw new Error(`unknown scene bookmark: ${m[1]}`);
    const off = parseInt(m[2], 10);
    return off < 0 ? b.end + off : b.start + off;
  }
  throw new Error(`bad frame spec: ${spec} (use frame-NNNNNN or scene:offset)`);
}

const specs = process.argv.slice(2);
if (specs.length === 0) {
  console.log("scenes:", Object.entries(manifest.bookmarks).map(([k, v]) => `${k} [${v.start}-${v.end}] (${((v.end - v.start) / 60).toFixed(1)}s)`).join("\n"));
  process.exit(0);
}

for (const spec of specs) {
  const n = resolveFrame(spec);
  const src = path.join(FRAMES_DIR, `frame-${String(n).padStart(6, "0")}.png`);
  if (!fs.existsSync(src)) { console.warn("missing:", src); continue; }
  const dest = path.join(QA_DIR, `${spec.replace(":", "-")}--frame-${String(n).padStart(6, "0")}.png`);
  fs.copyFileSync(src, dest);
  console.log("copied:", dest);
}
