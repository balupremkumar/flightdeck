// Sample frames from the recorded walkthrough so the result is REVIEWED, not
// assumed. A demo that ships unwatched is how the last reel drifted.
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const video = "file://" + path.join(__dirname, "out", "flightdeck-walkthrough.webm").replace(/\\/g, "/");
const stamps = process.argv.slice(2).map(Number);

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto("http://localhost:1420/demo/_player.html", { waitUntil: "load" });
await p.waitForFunction(() => {
  const v = document.getElementById("v");
  return v && v.readyState >= 2;
}, null, { timeout: 30000 });

const dur = await p.evaluate(() => document.getElementById("v").duration);
console.log("duration:", dur.toFixed(1), "s");

for (const t of stamps) {
  await p.evaluate((t) => new Promise((res) => {
    const v = document.getElementById("v");
    v.onseeked = () => res();
    v.currentTime = t;
  }), t);
  await p.waitForTimeout(320);
  await p.locator("#v").screenshot({ path: path.join(__dirname, "..", "e2e-shots", `frame-${t}.png`) });
  console.log("captured", t + "s");
}
await b.close();
