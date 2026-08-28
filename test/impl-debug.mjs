import puppeteer from "puppeteer-core";
import { startServer } from "../src/server.ts";
const server = await startServer({ port: 0 });
const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new", args: ["--no-sandbox"], defaultViewport: { width: 1440, height: 900 },
});
const page = await browser.newPage();
await page.goto(server.url, { waitUntil: "networkidle2" });
await new Promise(r => setTimeout(r, 2000));
console.log(await page.evaluate(() => {
  const sc = document.getElementById("chat-scroll");
  const bar = document.getElementById("working-bar");
  bar.hidden = false;
  const s = getComputedStyle(sc), b = getComputedStyle(bar);
  return {
    scDisplay: s.display, scHeight: sc.getBoundingClientRect().height,
    barRect: bar.getBoundingClientRect().toJSON(),
    barMarginTop: b.marginTop, barPosition: b.position,
    streamH: document.getElementById("stream").getBoundingClientRect().height,
  };
}));
await browser.close(); server.close();
