// Checklist: "Paste 50 KB into a pane: arrives in order."
// A pwsh pane runs a reader that consumes raw console input until ENDMARK, then prints byte count, line count, whether the
// numbered lines were strictly in order, how many bracketed-paste markers it saw, and a SHA-256.  The 50 KB goes in through
// xterm's own paste handler (a synthetic ClipboardEvent on its textarea: paste -> onData -> pty_write), NOT the system clipboard.
import { createHash } from "node:crypto";
import { main, boot, d, step, launchWorkspace, waitModels, mapPwsh, write, pasteInto, CR, sleep, shotPath } from "./w1a-lib.mjs";

const LINES = 1100;
const mk = (n) => `L${String(n).padStart(5, "0")} ` + "abcdefghijklmnopqrstuvwxyz0123456789".repeat(1).slice(0, 36) + ` #${(n * 7919) % 10007}`;
const payloadLines = Array.from({ length: LINES }, (_, i) => mk(i + 1));
const payload = payloadLines.join("\n") + "\n";
const expectedBytes = Buffer.byteLength(payloadLines.join("\n") + "\n", "utf8");
const expectedSha = createHash("sha256").update(payloadLines.join("\n") + "\n", "utf8").digest("hex").toUpperCase();

const READER = [
  "$sb=[Text.StringBuilder]::new(); $esc=0;",
  "while(($l=[Console]::In.ReadLine()) -ne 'ENDMARK'){ if($l -match ([char]27 + '\\[20[01]~')){$esc++; $l=$l -replace ([char]27 + '\\[20[01]~'),''}; [void]$sb.Append($l).Append(\"`n\") };",
  "$t=$sb.ToString(); $b=[Text.Encoding]::UTF8.GetBytes($t); $prev=0; $ok=$true; foreach($x in ($t -split \"`n\")){ if($x -match '^L(\\d+) '){ $n=[int]$Matches[1]; if($n -ne $prev+1){$ok=$false}; $prev=$n } };",
  "$h=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($b)).Replace('-','');",
  "\"RECV|bytes=$($b.Length)|lines=$prev|order=$ok|escmarkers=$esc|sha=$h|END\"",
].join(" ");

main("paste-50k", async (r) => {
  const c = await boot({ width: 2000, height: 1100 });
  const { page } = c;
  step("pwsh pane + reader");
  await launchWorkspace(page, { vendors: ["pwsh"] });
  const [mid] = await waitModels(page, 1);
  await d.waitForText(page, mid, /PS [^\n]*>/, { timeoutMs: 30000 });
  await mapPwsh(page, [mid]);
  r.evidence.payload = { bytes: expectedBytes, lines: LINES, sha: expectedSha };
  r.check("payload is at least 50 KiB", expectedBytes >= 51200 && expectedBytes <= 60000, expectedBytes);
  await write(page, mid, READER + CR);
  await sleep(2500);
  step("paste via xterm's paste handler");
  const t0 = Date.now();
  await pasteInto(page, 0, payload);
  await sleep(500);
  await write(page, mid, "ENDMARK" + CR);
  let line = null;
  while (Date.now() - t0 < 120000) {
    const txt = (await d.tail(page, mid, 65536)).join("\n").replace(/\s+/g, "");
    const m = /RECV\|bytes=(\d+)\|lines=(\d+)\|order=(\w+)\|escmarkers=(\d+)\|sha=([0-9A-F]+)\|END/.exec(txt);
    if (m) { line = { bytes: Number(m[1]), lines: Number(m[2]), order: m[3], esc: Number(m[4]), sha: m[5] }; break; }
    await sleep(500);
  }
  r.evidence.elapsedMs = Date.now() - t0;
  r.evidence.received = line;
  r.shot(await d.shotWindow(page, shotPath("paste-50k")));
  r.check("pwsh printed its RECV summary", !!line, line);
  if (line) {
    r.check("byte count matches exactly", line.bytes === expectedBytes, { got: line.bytes, want: expectedBytes });
    r.check("all numbered lines arrived strictly in order, none missing", line.order === "True" && line.lines === LINES, { order: line.order, lines: line.lines });
    r.check("SHA-256 of what pwsh received equals the payload's", line.sha === expectedSha, { got: line.sha, want: expectedSha });
    r.evidence.bracketedPasteMarkersSeenByReader = line.esc;
  }

  // ---- case B: the 50 KB lands at the PSReadLine prompt (bracketed paste ON), as valid pwsh statements ----
  step("case B: paste at the PSReadLine prompt");
  const BN = 900;
  const bItems = Array.from({ length: BN }, (_, i) => `L${String(i + 1).padStart(5, "0")} abcdefghijklmnopqrstuvwxyz0123456789 #${((i + 1) * 104729) % 10007}`);
  const bPayload = bItems.map((t) => `$s.Add('${t}')`).join("\n") + "\n";
  const bBytes = Buffer.byteLength(bPayload, "utf8");
  const bSha = createHash("sha256").update(bItems.join("\n"), "utf8").digest("hex").toUpperCase();
  r.check("case B payload is at least 50 KiB", bBytes >= 51200, bBytes);
  await write(page, mid, "$s=[Collections.Generic.List[string]]::new()" + CR);
  await sleep(1500);
  const t1 = Date.now();
  await pasteInto(page, 0, bPayload);
  await sleep(4000);
  await write(page, mid, CR);
  await sleep(3000);
  await write(page, mid, '$j=$s -join "`n"; "RECV2|count=$($s.Count)|sha=" + [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($j))).Replace("-","") + "|END"' + CR);
  let l2 = null;
  while (Date.now() - t1 < 120000) {
    const txt = (await d.tail(page, mid, 65536)).join("\n").replace(/\s+/g, "");
    const m = /RECV2\|count=(\d+)\|sha=([0-9A-F]+)\|END/.exec(txt);
    if (m) { l2 = { count: Number(m[1]), sha: m[2] }; break; }
    await sleep(500);
  }
  r.evidence.caseB = { bytes: bBytes, items: BN, received: l2, elapsedMs: Date.now() - t1 };
  r.shot(await d.shotWindow(page, shotPath("paste-50k-B")));
  r.check("case B: every pasted statement ran, in order, byte-exact (count and SHA-256 of the collected strings)", !!l2 && l2.count === BN && l2.sha === bSha, { l2, want: { count: BN, sha: bSha } });
  return c;
});
