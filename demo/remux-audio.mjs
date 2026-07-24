// remux-audio.mjs — recompose the score from the existing manifest.json and
// remux it onto the already-rendered video streams, without re-running the
// (slow) browser capture. Used to pick up a music.mjs fix after the video
// itself already rendered correctly.
//
// Run from demo/:
//   node remux-audio.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { composeScore, writeWav } from "./lib/music.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "out");
const manifest = JSON.parse(fs.readFileSync(path.join(OUT, "manifest.json"), "utf8"));

function ffmpeg(args, label) {
  console.log("ffmpeg:", label);
  execFileSync(ffmpegPath, args, { stdio: "inherit" });
}

const score = composeScore(manifest);
const wavPath = path.join(OUT, "score.wav");
writeWav(wavPath, score.pcm, score.sampleRate);
console.log("score.wav <-", score.seconds.toFixed(1) + "s",
  `bed ${score.stats.padBedRmsDbfs.toFixed(1)}dBFS RMS, peak ${score.stats.mixPeakDbfs.toFixed(1)}dBFS`);
for (const e of score.events) console.log("  cue:", e.name, "@", e.atSec.toFixed(2) + "s");

const mp4 = path.join(OUT, "flightdeck-showcase.mp4");
const webm = path.join(OUT, "flightdeck-showcase.webm");
const mp4Tmp = path.join(OUT, "_remux.mp4");
const webmTmp = path.join(OUT, "_remux.webm");

ffmpeg(
  ["-y", "-i", mp4, "-i", wavPath, "-map", "0:v:0", "-map", "1:a:0",
   "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", mp4Tmp],
  "remux .mp4 + aac score",
);
ffmpeg(
  ["-y", "-i", webm, "-i", wavPath, "-map", "0:v:0", "-map", "1:a:0",
   "-c:v", "copy", "-c:a", "libopus", "-b:a", "128k", "-shortest", webmTmp],
  "remux .webm + opus score",
);

fs.renameSync(mp4Tmp, mp4);
fs.renameSync(webmTmp, webm);
console.log("done. Replaced audio in", mp4, "and", webm);
