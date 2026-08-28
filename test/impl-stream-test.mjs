import puppeteer from "puppeteer-core";
import { startServer } from "../src/server.ts";
const server = await startServer({ port: 0 });
const browser = await puppeteer.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new",
  args: ["--no-sandbox"],
  defaultViewport: { width: 1440, height: 900 },
});
const page = await browser.newPage();
await page.goto(server.url, { waitUntil: "networkidle2" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await page.waitForSelector("#sessions .sess", { timeout: 30000 });
await page.click("#input");
await page.type("#input", "Reply with exactly OK");
await page.keyboard.press("Enter");
// poll during streaming
let sawBar = false,
  sawDot = false,
  barLabel = "";
for (let i = 0; i < 40; i++) {
  await sleep(500);
  const st = await page.evaluate(() => ({
    bar: !document.getElementById("working-bar").hidden,
    label: document.querySelector("#working-bar .wb-label")?.textContent,
    dots: document.querySelectorAll(".sess.current.working").length,
    streaming: !document.getElementById("btn-stop").hidden,
  }));
  if (st.streaming) {
    sawBar = sawBar || st.bar;
    sawDot = sawDot || st.dots > 0;
    if (st.bar) barLabel = st.label;
  }
  if (!st.streaming && i > 2) break;
}
console.log(JSON.stringify({ sawBar, sawDot, barLabel }));
await page.screenshot({ path: "/tmp/pi-rpc-web-shots/impl-streaming.png" });
await browser.close();
server.close();
