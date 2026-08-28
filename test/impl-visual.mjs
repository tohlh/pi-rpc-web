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
await new Promise((r) => setTimeout(r, 2500));
await page.evaluate(() => {
  document.getElementById("btn-stop").removeAttribute("hidden");
  document.getElementById("btn-send").setAttribute("hidden", "");
  document.getElementById("mode-chip").removeAttribute("hidden");
  document.getElementById("working-bar").hidden = false;
});
await new Promise((r) => setTimeout(r, 300));
await page.screenshot({ path: "/tmp/pi-rpc-web-shots/impl-working-state.png" });
const h = await page.evaluate(() => ({
  send: document.getElementById("btn-send").getBoundingClientRect().height,
  stop: document.getElementById("btn-stop").getBoundingClientRect().height,
  chip: document.getElementById("mode-chip").getBoundingClientRect().height,
}));
console.log("heights:", JSON.stringify(h));
await browser.close();
server.close();
