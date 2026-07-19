// Records demo/reel.html to demo/out/flightdeck-demo.webm via headless Chromium.
// Usage: npm run record  (from this demo/ directory)

import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "out");
fs.mkdirSync(outDir, { recursive: true });

const reelPath = path.join(__dirname, "reel.html");
const reelUrl = "file://" + reelPath.replace(/\\/g, "/");

const WIDTH = 1280;
const HEIGHT = 720;
const SAFETY_TIMEOUT_MS = 120_000; // reel should finish well under this

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    recordVideo: { dir: outDir, size: { width: WIDTH, height: HEIGHT } },
  });
  const page = await context.newPage();

  page.on("console", (msg) => console.log("[page]", msg.type(), msg.text()));
  page.on("pageerror", (err) => console.error("[pageerror]", err));

  console.log("Loading reel:", reelUrl);
  await page.goto(reelUrl);

  console.log("Waiting for window.REEL_DONE...");
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("REEL_DONE never resolved")), 110_000);
        window.REEL_DONE.then(() => {
          clearTimeout(t);
          resolve();
        });
      })
  );
  console.log("Reel finished. Padding on hold frame...");
  await page.waitForTimeout(2000);

  await context.close();
  await browser.close();

  const recordedPath = await page.video().path();
  const finalPath = path.join(outDir, "flightdeck-demo.webm");
  fs.renameSync(recordedPath, finalPath);
  console.log("Saved:", finalPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
