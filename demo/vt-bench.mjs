import { chromium } from "playwright";
import fs from "node:fs";

const mock = fs.readFileSync("mock-tauri.js", "utf8");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await page.addInitScript(mock);
const client = await page.context().newCDPSession(page);
await client.send("Network.enable");
await client.send("Page.enable");
await client.send("Emulation.setVirtualTimePolicy", { policy: "pause" });
const navPromise = page.goto("http://localhost:1420", { waitUntil: "load" });
async function advance(ms) {
  await client.send("Emulation.setVirtualTimePolicy", { policy: "advance", budget: ms });
  await new Promise(r => setTimeout(r, 30));
}
for (let i=0;i<10;i++) await advance(200);
await navPromise;
console.log("nav done");

const t0 = Date.now();
const N = 30;
for (let i=0;i<N;i++){
  await advance(1000/60);
  const { data } = await client.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`bench-${i}.png`, Buffer.from(data, "base64"));
}
const t1 = Date.now();
console.log("avg ms/frame:", ((t1-t0)/N).toFixed(1), "total for", N, "frames:", t1-t0, "ms");
const size = fs.statSync("bench-0.png").size;
console.log("frame size bytes:", size);
await browser.close();
