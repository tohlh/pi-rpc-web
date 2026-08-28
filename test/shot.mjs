// Visual harness: opens the real UI in headless Chrome against a live server
// and captures screenshots of key states for visual inspection.
// Usage: node --experimental-strip-types test/shot.mjs [outPrefix]
import puppeteer from "puppeteer-core";
import { startServer } from "../src/server.ts";
import fs from "node:fs";

const PREFIX = process.argv[2] || "ui";
const OUT = "/tmp/pi-rpc-web-shots";
fs.mkdirSync(OUT, { recursive: true });

const server = await startServer({ port: 0 });
console.log("server:", server.url);

const browser = await puppeteer.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--window-size=1440,900"],
  defaultViewport: { width: 1440, height: 900 },
});

const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error")
    errors.push("console.error: " + m.text().slice(0, 200));
});
await page.goto(server.url, { waitUntil: "networkidle2" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(name) {
  await page.screenshot({ path: `${OUT}/${PREFIX}-${name}.png` });
  console.log(`shot: ${PREFIX}-${name}.png`);
}

// 1. initial load — wait for sessions to render
await page
  .waitForSelector("#sessions .sess", { timeout: 30000 })
  .catch(() => {});
await sleep(1500);
await shot("01-initial");

// 2. hover a session row (actions reveal)
const row = await page.$("#sessions .sess");
if (row) await row.hover();
await sleep(400);
await shot("02-row-hover");

// 3. right-click context menu
if (row) {
  await row.click({ button: "right" });
  await sleep(400);
  await shot("03-context-menu");
  await page.keyboard.press("Escape");
  await sleep(300);
}

// 4. model popover
await page
  .click("#btn-model")
  .catch((e) => errors.push("btn-model: " + e.message));
await sleep(500);
await shot("04-model-popover");
await page.keyboard.press("Escape");

// 5. thinking popover
await page
  .click("#btn-thinking")
  .catch((e) => errors.push("btn-thinking: " + e.message));
await sleep(500);
await shot("05-thinking-popover");
await page.keyboard.press("Escape");

// 6. composer focus + slash command autocomplete
await page.click("#input");
await page.type("#input", "/");
await sleep(600);
await shot("06-slash-autocomplete");
await page.keyboard.press("Escape");

// 7. open a session with messages — chat stream rendering
const rows = await page.$$("#sessions .sess .sess-main");
for (const r of rows) {
  const label = await r.evaluate((el) => el.textContent);
  if (label && label.includes("PRD")) {
    await r.click();
    break;
  }
}
await page
  .waitForFunction(() => document.querySelectorAll("#stream .msg").length > 3, {
    timeout: 30000,
  })
  .catch(() => {});
await sleep(2000);
await shot("07-session-open");

// 8b. new chat project picker
await page.click("#btn-new");
await sleep(500);
await shot("09-newchat-menu");
// outside click should close the new chat menu
await page.mouse.click(700, 400);
await sleep(400);
const menuGone = await page.evaluate(
  () => !document.querySelector(".ctx-menu"),
);
console.log("new chat menu closed on outside click:", menuGone);
await shot("10-newchat-dismissed");
await sleep(200);

// 8. narrow viewport (mobile-ish)
await page.setViewport({ width: 420, height: 800 });
await sleep(500);
await shot("07-narrow");
await page.setViewport({ width: 1440, height: 900 });

console.log("page errors:", errors.length ? errors : "none");
await browser.close();
await server.close();
process.exit(0);
