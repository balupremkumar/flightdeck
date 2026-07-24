// demo/lib/music.mjs — generative, rights-clean score for the showcase video.
//
// Pure synthesis, no samples, no loops, nothing downloaded: everything here
// is additive/subtractive DSP written by hand and rendered straight to PCM.
// The score is scene-synced, not just "background music" — it reads the
// ACTUAL scene bookmarks the render produced (out/manifest.json, frame
// indices at 60fps) and keys every musical event (chord change, pulse
// entrance, riser, peak, strip-back, resolve) to those exact timestamps, so
// a re-render with different scene timing re-syncs the score automatically
// rather than drifting out of sync with a hand-tuned cue sheet.
//
// Structure (dark ambient bed, Dm-Bb-F-C loop — i-VI-III-VII in D natural
// minor, a stock moody progression):
//   title      Dm   pad only
//   worktrees  Bb   pad only
//   grid       F    pulse enters
//   attention  C    riser lifts into it
//   review     Dm   pulse at peak intensity (merge beat)
//   board      Bb   pulse still at peak
//   themes     F    pulse tapers
//   livedemo   C    pulse stripped back to pad only
//   endcard    Dm   resolves to tonic, gentle low-pass fade over the tail
//
// Mix target: pad bed ~-24 dBFS RMS, final mix peak <= -6 dBFS (soft-limited
// as a safety net, never hard-clipped), 1s fade-in, 3s fade-out.
import fs from "node:fs";

export const SR = 44100;

// ---------------------------------------------------------------------------
// DSP helpers
// ---------------------------------------------------------------------------
function onePoleLP(x, cutoffHz, sr = SR) {
  const dt = 1 / sr;
  const rc = 1 / (2 * Math.PI * Math.max(1, cutoffHz));
  const a = dt / (rc + dt);
  const y = new Float64Array(x.length);
  let prev = 0;
  for (let i = 0; i < x.length; i++) { prev += a * (x[i] - prev); y[i] = prev; }
  return y;
}
// Cheap bandpass = lowpass(hi) - lowpass(lo).
function bandpass(x, loHz, hiHz, sr = SR) {
  const lo = onePoleLP(x, loHz, sr);
  const hi = onePoleLP(x, hiHz, sr);
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = hi[i] - lo[i];
  return y;
}
function rmsDbNonSilent(x) {
  let sum = 0, n = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (Math.abs(v) < 1e-6) continue; // ignore silent regions when measuring bed level
    sum += v * v; n++;
  }
  const rms = Math.sqrt(sum / Math.max(1, n));
  return 20 * Math.log10(Math.max(rms, 1e-9));
}
function peakDb(x) {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  return 20 * Math.log10(Math.max(m, 1e-9));
}
function dbToLin(db) { return Math.pow(10, db / 20); }
function seededRand(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// ---------------------------------------------------------------------------
// Chords — close-voiced triads + octave top note, low-mid register so the
// bed sits under the pulse without masking it.
// ---------------------------------------------------------------------------
const CHORDS = {
  Dm: [146.83, 174.61, 220.00, 293.66], // D3 F3 A3 D4
  Bb: [116.54, 146.83, 174.61, 233.08], // Bb2 D3 F3 Bb3
  F: [87.31, 110.00, 130.81, 174.61],   // F2 A2 C3 F3
  C: [130.81, 164.81, 196.00, 261.63],  // C3 E3 G3 C4
};

// QA on the first render caught a real defect here: adjacent segments'
// fade windows were each anchored to their OWN start/end independently
// ([segEnd-cf, segEnd] fading OUT, [segStart, segStart+cf] fading IN on the
// next one) — touching at the shared boundary but never overlapping, so
// both were near-zero on either side of it. Measured directly with an
// ffmpeg loudness sweep: two ~0.5s stretches of near-total silence
// (-65dB, -61dB) right at scene-transition boundaries. Fixed by sharing a
// single crossfade window of width `cf` CENTRED on each boundary between
// the two segments meeting there, with complementary raised-cosine curves
// (fadeIn(x) + fadeOut(x) = 1 exactly), so the outgoing and incoming chord
// sum to constant gain through the whole transition — a real crossfade,
// not two ramps that happen to both hit zero at the same instant.
function segmentGain(tArr, segStart, segEnd, isFirst, isLast, cf) {
  const half = cf / 2;
  const n = tArr.length;
  const g = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = tArr[i];
    if (!isFirst && t < segStart - half) { g[i] = 0; continue; }
    if (!isLast && t > segEnd + half) { g[i] = 0; continue; }
    let gi = 1;
    if (!isFirst && t < segStart + half) {
      const x = (t - (segStart - half)) / cf; // 0..1 across the shared window
      gi *= 0.5 - 0.5 * Math.cos(Math.PI * x);
    }
    if (!isLast && t > segEnd - half) {
      const x = (t - (segEnd - half)) / cf;
      gi *= 1 - (0.5 - 0.5 * Math.cos(Math.PI * x));
    }
    g[i] = gi;
  }
  return g;
}

// Detuned, slow-attach pad voice for one chord segment, one stereo channel
// (call twice with different seeds for L/R so the bed has real width).
function renderPadChannel(nSamples, tArr, segments, cf, seed) {
  const rand = seededRand(seed);
  const out = new Float64Array(nSamples);
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    const freqs = CHORDS[seg.chord];
    const g = segmentGain(tArr, seg.start, seg.end, s === 0, s === segments.length - 1, cf);
    for (const f0 of freqs) {
      // Two detuned oscillators per note (+/- a few cents) — the classic
      // "chorused" pad thickness — plus a soft triangle-ish harmonic via a
      // clipped sine for a little more body than a bare sine would give.
      const detuneCents = (rand() - 0.5) * 10;
      const f1 = f0 * Math.pow(2, detuneCents / 1200);
      const detuneCents2 = (rand() - 0.5) * 10;
      const f2 = f0 * Math.pow(2, detuneCents2 / 1200);
      const phase1 = rand() * Math.PI * 2, phase2 = rand() * Math.PI * 2;
      for (let i = 0; i < nSamples; i++) {
        const gi = g[i];
        if (gi <= 0) continue;
        const t = tArr[i];
        let v = Math.sin(2 * Math.PI * f1 * t + phase1) * 0.6 + Math.sin(2 * Math.PI * f2 * t + phase2) * 0.4;
        // gentle soft-saturation for a touch of harmonic warmth, not grit
        v = Math.tanh(v * 0.8) * 0.9;
        out[i] += v * gi * 0.16;
      }
    }
  }
  return onePoleLP(out, 950);
}

function renderKickHit(nSamples, sr) {
  const buf = new Float64Array(nSamples);
  for (let i = 0; i < nSamples; i++) {
    const t = i / sr;
    const freq = 150 * Math.exp(-t / 0.045) + 42;
    const env = Math.exp(-t / 0.11);
    buf[i] = Math.sin(2 * Math.PI * freq * t) * env;
  }
  return onePoleLP(buf, 1400, sr);
}

// Pulse envelope over the whole track — 0 before the grid scene, ramping in,
// full through review/board (peak intensity, incl. the merge beat), tapering
// through themes, silent again by the live-demo beat.
function pulseEnvelopeAt(t, cues) {
  const { gridStart, attentionStart, reviewStart, boardEnd, themesStart, livedemoStart } = cues;
  if (t < gridStart) return 0;
  if (t < gridStart + 1.0) return (t - gridStart) / 1.0 * 0.55; // enters at grid
  if (t < attentionStart) return 0.55;
  if (t < reviewStart) return 0.55 + 0.35 * Math.min(1, (t - attentionStart) / Math.max(0.1, reviewStart - attentionStart)); // lift into attention
  if (t < boardEnd) return 1.0; // peak through review/merge and board
  if (t < livedemoStart) return Math.max(0, 1.0 - (t - boardEnd) / Math.max(0.1, livedemoStart - boardEnd)); // taper through themes
  return 0; // stripped back for the demo-URL beat and resolved endcard
}

function renderPulseChannel(nSamples, tArr, cues, bpm, phaseOffsetBeats) {
  const out = new Float64Array(nSamples);
  const beatSec = 60 / bpm;
  const hit = renderKickHit(Math.round(0.25 * SR), SR);
  const start = cues.gridStart + phaseOffsetBeats * beatSec;
  for (let bt = start; bt < cues.livedemoStart + beatSec; bt += beatSec) {
    const g = pulseEnvelopeAt(bt, cues);
    if (g <= 0.001) continue;
    const i0 = Math.round(bt * SR);
    for (let k = 0; k < hit.length && i0 + k < nSamples; k++) {
      if (i0 + k < 0) continue;
      out[i0 + k] += hit[k] * g;
    }
  }
  return out;
}

// Riser: rising-frequency filtered noise, 2s ramp landing exactly at the
// attention-scene bookmark, then cut — the "lift into the attention beat."
function renderRiserChannel(nSamples, tArr, attentionStart, seed) {
  const rand = seededRand(seed);
  const dur = 2.0;
  const start = attentionStart - dur;
  const out = new Float64Array(nSamples);
  const i0 = Math.max(0, Math.round(start * SR));
  const i1 = Math.min(nSamples, Math.round(attentionStart * SR));
  const noise = new Float64Array(i1 - i0);
  for (let i = 0; i < noise.length; i++) noise[i] = rand() * 2 - 1;
  for (let i = 0; i < noise.length; i++) {
    const t = i / SR;
    const frac = t / dur; // 0..1 across the riser
    const centre = 220 + frac * 1800; // sweeps up
    const width = 260;
    // narrow-band single-sample bandpass approximation via local mixing is
    // overkill here; reuse the cheap two-pole bandpass on a short local
    // buffer would need per-sample-varying cutoff, so approximate with an
    // amplitude-modulated tone cluster instead — simpler and reliably
    // artifact-free for a 2s effect.
    void centre; void width;
  }
  // Swept bandpassed noise via a bank of 3 slowly-rising sine partials
  // amplitude-modulated by noise for texture — avoids a time-varying filter.
  for (let i = 0; i < noise.length; i++) {
    const t = i / SR;
    const frac = Math.min(1, t / dur);
    const env = frac * frac; // ease-in, builds toward the hit
    const f = 260 + frac * 1500;
    const n = noise[i];
    const tone = Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(2 * Math.PI * f * 1.5 * t);
    out[i0 + i] = tone * (0.15 + 0.85 * Math.abs(n)) * env * 0.5;
  }
  return onePoleLP(out, 4000);
}

/**
 * @param {{bookmarks: Record<string,{start:number,end:number}>, fps: number, totalFrames: number}} manifest
 * @returns {{ pcm: Int16Array, sampleRate: number, seconds: number, cues: object, events: Array<{name:string, atSec:number}> }}
 */
export function composeScore(manifest) {
  const fps = manifest.fps ?? 60;
  const sec = (frames) => frames / fps;
  const b = manifest.bookmarks;
  const totalSeconds = manifest.totalFrames / fps;

  const order = ["title", "worktrees", "grid", "attention", "review", "board", "themes", "livedemo", "endcard"];
  const chordOf = { title: "Dm", worktrees: "Bb", grid: "F", attention: "C", review: "Dm", board: "Bb", themes: "F", livedemo: "C", endcard: "Dm" };
  // Segments are made CONTIGUOUS (each one's end = the next one's start),
  // not scene.end -> scene.start as the raw bookmarks have it — there's a
  // real gap between those (the dip-to-dark transition between scenes eats
  // ~0.5s that belongs to neither scene's own frame range). With a gap, the
  // two adjacent crossfade windows in segmentGain() are centred at
  // different points and don't sum to 1 between them, leaving a residual
  // dip. Contiguous boundaries put both fades on the exact same shared
  // centre, so they're perfect complements throughout.
  const present = order.filter((k) => b[k]);
  const segments = present.map((k, idx, arr) => ({
    name: k,
    chord: chordOf[k],
    start: sec(b[k].start),
    end: idx === arr.length - 1 ? totalSeconds : sec(b[arr[idx + 1]].start),
  }));

  const cues = {
    gridStart: sec(b.grid.start),
    attentionStart: sec(b.attention.start),
    reviewStart: sec(b.review.start),
    boardEnd: sec(b.board.end),
    themesStart: sec(b.themes.start),
    livedemoStart: sec(b.livedemo ? b.livedemo.start : b.endcard.start),
    endcardStart: sec(b.endcard.start),
  };

  const nSamples = Math.ceil(totalSeconds * SR) + SR; // a little tail room, trimmed later
  const tArr = new Float64Array(nSamples);
  for (let i = 0; i < nSamples; i++) tArr[i] = i / SR;

  const padL = renderPadChannel(nSamples, tArr, segments, 0.8, 1);
  const padR = renderPadChannel(nSamples, tArr, segments, 0.8, 2);
  const BPM = 100;
  const pulseL = renderPulseChannel(nSamples, tArr, cues, BPM, 0);
  const pulseR = renderPulseChannel(nSamples, tArr, cues, BPM, 0.015); // hair of stereo offset
  const riserL = renderRiserChannel(nSamples, tArr, cues.attentionStart, 7);
  const riserR = renderRiserChannel(nSamples, tArr, cues.attentionStart, 8);

  // --- gain stage the pad to the requested -24 dBFS RMS bed level ---
  const padRmsNow = rmsDbNonSilent(Float64Array.from({ length: nSamples }, (_, i) => (padL[i] + padR[i]) / 2));
  const padGain = dbToLin(-24 - padRmsNow);

  // Kick hits ~-13 dBFS at peak envelope (g=1); riser ~-20 dBFS at its own peak.
  const kickGain = dbToLin(-13) / dbToLin(peakDb(pulseL));
  const riserGain = dbToLin(-20) / Math.max(1e-9, dbToLin(peakDb(riserL)));

  const mixL = new Float64Array(nSamples);
  const mixR = new Float64Array(nSamples);
  for (let i = 0; i < nSamples; i++) {
    mixL[i] = padL[i] * padGain + pulseL[i] * kickGain + riserL[i] * riserGain;
    mixR[i] = padR[i] * padGain + pulseR[i] * kickGain + riserR[i] * riserGain;
  }

  // --- fades: 1s in, 3s out; plus a gentle low-pass sweep over the last
  // 2.5s of the end card for the "resolve and tail out" close. ---
  const fadeIn = 1.0, fadeOut = 3.0;
  const trackEnd = totalSeconds; // trim the extra tail room after fades
  const trimSamples = Math.round(trackEnd * SR);
  let outL = mixL.subarray(0, trimSamples);
  let outR = mixR.subarray(0, trimSamples);

  // Low-pass sweep across the tail (applied before the amplitude fade so the
  // filter has clean signal to work with).
  const lpStart = Math.max(0, trackEnd - 2.5);
  const lpStartI = Math.round(lpStart * SR);
  {
    const tailL = onePoleLP(outL.subarray(lpStartI), 500);
    const tailR = onePoleLP(outR.subarray(lpStartI), 500);
    for (let i = 0; i < tailL.length; i++) {
      const frac = i / tailL.length; // 0..1 across the tail
      outL[lpStartI + i] = outL[lpStartI + i] * (1 - frac) + tailL[i] * frac;
      outR[lpStartI + i] = outR[lpStartI + i] * (1 - frac) + tailR[i] * frac;
    }
  }

  const finalL = new Float64Array(trimSamples);
  const finalR = new Float64Array(trimSamples);
  for (let i = 0; i < trimSamples; i++) {
    const t = i / SR;
    let g = 1;
    if (t < fadeIn) g *= 0.5 - 0.5 * Math.cos(Math.PI * (t / fadeIn));
    if (t > trackEnd - fadeOut) g *= Math.max(0, 0.5 + 0.5 * Math.cos(Math.PI * ((t - (trackEnd - fadeOut)) / fadeOut)));
    finalL[i] = outL[i] * g;
    finalR[i] = outR[i] * g;
  }

  // --- peak-limit to <= -6 dBFS, soft-knee safety net against any local
  // overshoot from the additive layers (never a hard clip). ---
  const peakNow = Math.max(peakDb(finalL), peakDb(finalR));
  const target = -6.5; // half a dB of headroom under the -6dBFS ceiling
  const limitGain = peakNow > target ? dbToLin(target - peakNow) : 1;
  const pcm = new Int16Array(trimSamples * 2);
  for (let i = 0; i < trimSamples; i++) {
    let l = finalL[i] * limitGain, r = finalR[i] * limitGain;
    l = Math.tanh(l * 1.05) / 1.05; // soft-knee, inert at these levels
    r = Math.tanh(r * 1.05) / 1.05;
    pcm[i * 2] = Math.max(-32768, Math.min(32767, Math.round(l * 32767)));
    pcm[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(r * 32767)));
  }

  // Measure straight off the actual delivered PCM (post fade, post limiter,
  // post soft-knee) so the reported numbers describe what's really in the
  // file, not an intermediate buffer. The bed-level window (padStart..) is
  // sampled inside a chord's steady region well clear of the fade-in and any
  // pulse/riser layer, so it reflects the pad alone even though the meters
  // run on the full mix.
  const pcmFloat = new Float64Array(trimSamples * 2);
  for (let i = 0; i < pcmFloat.length; i++) pcmFloat[i] = pcm[i] / 32767;
  const measuredPeak = peakDb(pcmFloat);
  // Bed-level window: pad-only, after the 1s fade-in, before the pulse
  // enters at the grid scene.
  const winStartSec = 2.0;
  const winEndSec = Math.min(cues.gridStart - 0.5, winStartSec + 4.0);
  const i0 = Math.max(0, Math.round(winStartSec * SR)) * 2;
  const i1 = Math.min(pcmFloat.length, Math.max(i0 + 2, Math.round(winEndSec * SR) * 2));
  const measuredPadRms = rmsDbNonSilent(pcmFloat.subarray(i0, i1));

  const events = [
    { name: "grid: pulse enters", atSec: cues.gridStart },
    { name: "attention: riser lands", atSec: cues.attentionStart },
    { name: "review: peak intensity", atSec: cues.reviewStart },
    { name: "themes: taper begins", atSec: cues.themesStart },
    { name: "livedemo: strip back to pad", atSec: cues.livedemoStart },
    { name: "endcard: resolve to Dm + low-pass tail", atSec: cues.endcardStart },
  ];

  return {
    pcm, sampleRate: SR, seconds: trackEnd, cues, events, segments,
    stats: { padBedRmsDbfs: measuredPadRms, mixPeakDbfs: measuredPeak },
  };
}

export function writeWav(filePath, pcm, sampleRate, channels = 2) {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], 44 + i * 2);
  fs.writeFileSync(filePath, buf);
}
