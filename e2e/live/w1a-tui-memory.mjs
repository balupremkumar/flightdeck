// Checklist: "Run vim, lazygit or htop in a pane for 10 minutes: Flightdeck memory stays flat."
// No lazygit/htop here; Git for Windows ships a real vim. Two pwsh panes:
//   pane 1: real vim on a 5000-line file, scrolled (G / gg) and :redraw! every 30 s so it keeps repainting the alt screen.
//   pane 2: a pwsh loop that redraws the alternate screen (ESC[?1049h, cursor addressing, ESC[?1049l) about 20 times a second.
// Canary process-tree private bytes and working set are sampled every 30 s for 10 minutes.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { main, boot, d, step, launchWorkspace, waitModels, mapPwsh, write, CR, ESC, sleep, shotPath, tree, treeBrief, OUT, SCRATCH, health, fgNoteTree } from "./w1a-lib.mjs";

const MINUTES = Number(process.env.FD_TUI_MINUTES ?? 10);
const VIM = "C:\\Program Files\\Git\\usr\\bin\\vim.exe";

main("tui-memory", async (r) => {
  const c = await boot({ width: 2200, height: 1100 });
  const { page } = c;
  step("two pwsh panes");
  await launchWorkspace(page, { vendors: ["pwsh", "pwsh"] });
  const mids = await waitModels(page, 2);
  await d.waitForText(page, mids[0], /PS [^\n]*>/, { timeoutMs: 30000 });
  await d.waitForText(page, mids[1], /PS [^\n]*>/, { timeoutMs: 30000 });
  const map = await mapPwsh(page, mids);
  r.check("both pwsh panes mapped to ptys", Object.keys(map).length === 2, map);
  const [vimM, loopM] = mids;
  const file = path.join(SCRATCH, "tui-5000.txt").replace(/\\/g, "/");

  const base = tree();
  r.evidence.baseline = treeBrief(base);

  step("start vim in pane 1");
  await write(page, vimM, `1..5000 | % { "line $_ the quick brown fox jumps over the lazy dog" } | Set-Content '${file}'; & '${VIM}' -u NONE -N '${file}'${CR}`);
  await sleep(4000);
  const vimTail = (await d.tail(page, vimM)).join("\n");
  r.evidence.vimTail = vimTail.slice(-400);
  const vimUp = (await health(page)).some((p) => /vim/i.test(p.procName ?? ""));
  r.check("vim is running in pane 1 (live process name)", vimUp, (await health(page)).map((p) => p.procName));

  step("start alt-screen redraw loop in pane 2");
  const loop = `$e=[char]27; $end=(Get-Date).AddMinutes(${MINUTES + 3}); [Console]::Out.Write("$e[?1049h$e[2J"); $i=0; while((Get-Date) -lt $end){ $i++; $s="$e[H"; 1..28 | % { $s += "$e[$_;1H" + ("row $_ frame $i " + ("#" * (($i+$_) % 70))) + "$e[K" }; [Console]::Out.Write($s); Start-Sleep -Milliseconds 50 }; [Console]::Out.Write("$e[?1049l"); "loop done frames=$i"${CR}`;
  await write(page, loopM, loop);
  await sleep(3000);
  r.shot(await d.shotWindow(page, shotPath("tui-memory-start")));
  const seq0 = await d.tail(page, loopM).then(() => d.tailSeq(page, loopM));
  await sleep(1000);
  const seq1 = await d.tailSeq(page, loopM);
  r.check("redraw loop is producing output (ring seq advancing)", seq1 > seq0, { seq0, seq1 });

  step(`sample every 30 s for ${MINUTES} min`);
  const series = [];
  const t0 = Date.now();
  let n = 0;
  while (Date.now() - t0 < MINUTES * 60000) {
    const t = tree();
    const web = t.rows.filter((x) => /msedgewebview2/i.test(x.name));
    const app = t.rows.find((x) => x.pid === d.canaryPid());
    series.push({ tMin: +((Date.now() - t0) / 60000).toFixed(2), privMB: t.privMB, wsMB: t.wsMB, procs: t.count,
      appPrivMB: Math.round(app.priv / 1048576), webPrivMB: Math.round(web.reduce((a, x) => a + x.priv, 0) / 1048576) });
    console.log(`[tui] ${JSON.stringify(series[series.length - 1])}`);
    fgNoteTree();
    // keep vim repainting
    n++;
    await write(page, vimM, n % 2 ? "G" : "gg");
    if (n % 4 === 0) await write(page, vimM, ":redraw!" + CR);
    await sleep(Math.max(0, 30000 - 1500));
  }
  r.evidence.series = series;
  writeFileSync(path.join(OUT, "w1a-tui-memory-series.json"), JSON.stringify(series, null, 2));
  const early = series.slice(2, 6).map((s) => s.privMB);                // after 1 min warm-up
  const late = series.slice(-4).map((s) => s.privMB);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const growthMB = Math.round(mean(late) - mean(early)), growthPct = Math.round(((mean(late) - mean(early)) / mean(early)) * 1000) / 10;
  const peak = Math.max(...series.map((s) => s.privMB));
  r.evidence.summary = { firstPrivMB: series[0].privMB, lastPrivMB: series[series.length - 1].privMB, peakPrivMB: peak, earlyMeanMB: Math.round(mean(early)), lateMeanMB: Math.round(mean(late)), growthMB, growthPct, webFirst: series[0].webPrivMB, webLast: series[series.length - 1].webPrivMB };
  r.check("private bytes growth bounded (late mean vs early mean < 15% and < 150 MB)", growthPct < 15 && growthMB < 150, r.evidence.summary);
  r.shot(await d.shotWindow(page, shotPath("tui-memory-end")));
  r.evidence.endTailVim = (await d.tail(page, vimM)).slice(-3);
  return c;
});
