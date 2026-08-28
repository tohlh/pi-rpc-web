import puppeteer from "puppeteer-core";
import { startServer } from "../src/server.ts";
import { encodeProjectDir } from "../src/bridge.ts";
import { readdirSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const PROJ = join(tmpdir(), "pi-rpc-web-live-row-test");
rmSync(PROJ, { recursive: true, force: true });
mkdirSync(PROJ, { recursive: true });
const sessDir = join(
  homedir(),
  ".pi",
  "agent",
  "sessions",
  encodeProjectDir(PROJ),
);
rmSync(sessDir, { recursive: true, force: true });

const server = await startServer({ port: 0 });
const browser = await puppeteer.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new",
  args: ["--no-sandbox"],
  defaultViewport: { width: 1440, height: 900 },
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(server.url, { waitUntil: "networkidle2" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. New chat -> New project -> type path -> submit
await page
  .waitForSelector("#sessions .sess", { timeout: 30000 })
  .catch(() => {});
await page.click("#btn-new");
await sleep(400);
for (const it of await page.$$(".ctx-item")) {
  if ((await it.evaluate((el) => el.textContent)).includes("New project")) {
    await it.click();
    break;
  }
}
await sleep(400);
await page.type(".modal-form .text-input", PROJ);
await page.keyboard.press("Enter");
await sleep(5000); // reconnect + spawn

// 2. synthetic "New session" row should be pinned at top
const topRow = await page.evaluate(() => {
  const row = document.querySelector("#sessions .sess.current");
  return row
    ? {
        name: row.querySelector(".sess-name")?.textContent,
        path: row.dataset.path,
      }
    : null;
});
console.log("1. pinned row after new project:", JSON.stringify(topRow));
const tempGroup = await page.evaluate(() => {
  const g = document.querySelector(".side-group-temp");
  return g ? g.textContent : null;
});
console.log("   temp section header:", JSON.stringify(tempGroup));
console.log('   is "New session":', topRow?.name === "New session");

// 3. switch to an existing session from another project -> live row should vanish
//    and the empty session file must be deleted
const locksmithRow = await page.evaluate(() => {
  const rows = [...document.querySelectorAll("#sessions .sess")];
  const r = rows.find((x) => !x.classList.contains("current"));
  return r ? r.dataset.path : null;
});
console.log("2. switching away to:", locksmithRow?.split("/").pop());
if (locksmithRow) {
  await page.evaluate((p) => {
    const rows = [...document.querySelectorAll("#sessions .sess")];
    const r = rows.find((x) => x.dataset.path === p);
    r.querySelector(".sess-main").click();
    // cross-project: no modal, immediate respawn
  }, locksmithRow);
  await sleep(6000);
  const after = await page.evaluate(() => ({
    pinned: document.querySelector("#sessions .sess.current .sess-name")
      ?.textContent,
    liveRowGone: ![...document.querySelectorAll("#sessions .sess")].some((x) =>
      x.dataset.path?.includes("live-row-test"),
    ),
  }));
  console.log("3. after switching away:", JSON.stringify(after));
  const stillExists =
    existsSync(sessDir) &&
    readdirSync(sessDir).some((f) => f.endsWith(".jsonl"));
  console.log("4. empty session file deleted from disk:", !stillExists);
}

// 5. existing-project chat via picker should NOT create a temp section
await page.click("#btn-new");
await sleep(400);
for (const it of await page.$$(".ctx-item")) {
  const t = await it.evaluate((el) => el.textContent);
  if (t.includes("pi-remote")) {
    await it.click();
    break;
  }
}
await sleep(5000);
const noTemp = await page.evaluate(
  () => !document.querySelector(".side-group-temp"),
);
const pinnedNow = await page.evaluate(
  () =>
    document.querySelector("#sessions .sess.current .sess-name")?.textContent,
);
console.log(
  "5. existing-project chat: no temp section:",
  noTemp,
  "| pinned row:",
  JSON.stringify(pinnedNow),
);

console.log("page errors:", errors.length ? errors : "none");
await browser.close();
await server.close();
rmSync(PROJ, { recursive: true, force: true });
rmSync(sessDir, { recursive: true, force: true });
process.exit(0);
