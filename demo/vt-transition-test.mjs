import { chromium } from "playwright";
import fs from "node:fs";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 800, height: 200 }, deviceScaleFactor: 1 });
const client = await page.context().newCDPSession(page);
await client.send("Page.enable");
await client.send("Emulation.setVirtualTimePolicy", { policy: "pause" });
const navPromise = page.goto("data:text/html,<div id='box' style='width:40px;height:40px;background:red;position:absolute;left:0;top:0;transition:left 2s linear;'></div>");
async function advance(ms) {
  await client.send("Emulation.setVirtualTimePolicy", { policy: "advance", budget: ms });
  await new Promise(r => setTimeout(r, 25));
}
for (let i=0;i<5;i++) await advance(200);
await navPromise;

// Trigger the transition
await page.evaluate(() => { document.getElementById('box').style.left = '600px'; });
await advance(16); // let it register

// Sample positions every ~333ms of virtual time (6 samples over 2s)
for (let i=0;i<7;i++){
  await advance(333);
  const left = await page.evaluate(() => {
    const b = document.getElementById('box').getBoundingClientRect();
    return b.left;
  });
  console.log("t~"+(i*333)+"ms left=", left.toFixed(1));
}
await browser.close();
