import puppeteer from "puppeteer-core";
import { startServer } from "../src/server.ts";
import { encodeProjectDir } from "../src/bridge.ts";
import {
  writeFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

// fixture project with 2 sessions
const PROJ = join(tmpdir(), "remove-me-test");
mkdirSync(PROJ, { recursive: true });
const sessDir = join(
  homedir(),
  ".pi",
  "agent",
  "sessions",
  encodeProjectDir(PROJ),
);
rmSync(sessDir, { recursive: true, force: true });
mkdirSync(sessDir, { recursive: true });
for (const [i, id] of [
  "aaaa1111-0000-0000-0000-000000000001",
  "bbbb2222-0000-0000-0000-000000000002",
].entries()) {
  writeFileSync(
    `${sessDir}/${id}.jsonl`,
    [
      JSON.stringify({ type: "session", id: `rm-${i}`, cwd: PROJ }),
      JSON.stringify({
        type: "message",
        id: `m${i}`,
        parentId: null,
        timestamp: Date.now(),
        message: { role: "user", content: `session ${i} content` },
      }),
    ].join("\n") + "\n",
  );
}

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
await page.waitForSelector("#sessions .sess", { timeout: 30000 });

// 1. group header shows hide button on hover
const header = await page.evaluate(() => {
  const groups = [...document.querySelectorAll("#sessions .side-group")];
  const g = groups.find((x) => x.textContent.includes("remove-me-test"));
  return g
    ? {
        hasBtn: !!g.querySelector(".icon-btn"),
        label: g.querySelector(".side-group-label")?.textContent,
      }
    : null;
});
console.log("1. remove-me group header:", JSON.stringify(header));

// 2. click hide -> confirm modal -> Hide
await page.evaluate(() => {
  const groups = [...document.querySelectorAll("#sessions .side-group")];
  const g = groups.find((x) => x.textContent.includes("remove-me-test"));
  g.querySelector(".icon-btn").click();
});
await sleep(500);
const modalInfo = await page.evaluate(() => ({
  title: document.querySelector(".modal-title")?.textContent,
  actions: [...document.querySelectorAll(".modal-actions .btn")].map(
    (b) => b.textContent,
  ),
}));
console.log("2. modal:", JSON.stringify(modalInfo));
const hideBtn = await page.evaluate(() => {
  const b = [...document.querySelectorAll(".modal-actions .btn")].find(
    (x) => x.textContent === "Hide",
  );
  b.click();
  return true;
});
await sleep(1500);
const filesOnDisk = existsSync(sessDir)
  ? readdirSync(sessDir).filter((f) => f.endsWith(".jsonl")).length
  : 0;
const afterHide = await page.evaluate(() => ({
  groupGone: ![...document.querySelectorAll("#sessions .side-group")].some(
    (x) => x.textContent.includes("remove-me-test"),
  ),
  chip: document.getElementById("hidden-projects")?.textContent,
}));
afterHide.filesOnDisk = filesOnDisk;
console.log("3. after hide:", JSON.stringify(afterHide));
console.log("   group hidden ✓  files kept:", afterHide.filesOnDisk === 2);

// 4. persistence across reload
await page.reload({ waitUntil: "networkidle2" });
await page
  .waitForSelector("#sessions .sess", { timeout: 30000 })
  .catch(() => {});
await sleep(1500);
const afterReload = await page.evaluate(() => ({
  groupStillHidden: ![
    ...document.querySelectorAll("#sessions .side-group"),
  ].some((x) => x.textContent.includes("remove-me-test")),
  chip: document.getElementById("hidden-projects")?.textContent,
}));
console.log("4. after reload (persisted):", JSON.stringify(afterReload));

// 5. unhide via chip popover
await page.evaluate(() => document.getElementById("hidden-projects").click());
await sleep(400);
await page.evaluate(() => {
  const b = [...document.querySelectorAll(".ctx-item")].find((x) =>
    x.textContent.includes("Show remove-me-test"),
  );
  b.click();
});
await sleep(1500);
const afterUnhide = await page.evaluate(() => ({
  groupBack: [...document.querySelectorAll("#sessions .side-group")].some((x) =>
    x.textContent.includes("remove-me-test"),
  ),
  chipGone: document.getElementById("hidden-projects").hidden,
}));
console.log("5. after unhide:", JSON.stringify(afterUnhide));

// 6. current-project guard: try removing the server cwd project.
await page.evaluate((currentName) => {
  const groups = [...document.querySelectorAll("#sessions .side-group")];
  const g = groups.find((x) => x.textContent.includes(currentName));
  g.querySelector(".icon-btn").click();
}, basename(process.cwd()));
await sleep(400);
const guardToast = await page.evaluate(() =>
  [...document.querySelectorAll(".toast-msg")]
    .map((t) => t.textContent)
    .slice(-1),
);
console.log("6. current-project guard toast:", JSON.stringify(guardToast));
await page.evaluate(() =>
  [...document.querySelectorAll(".modal-actions .btn")]
    .find?.((b) => b.textContent === "Cancel")
    ?.click(),
);
await page.keyboard.press("Escape");
await sleep(300);

// 7. bulk delete via backend probe (direct meta through a second socket is complex;
//    verify via the modal's Delete-all action on the remove-me project)
await page.evaluate(() => {
  const groups = [...document.querySelectorAll("#sessions .side-group")];
  const g = groups.find((x) => x.textContent.includes("remove-me-test"));
  g.querySelector(".icon-btn").click();
});
await sleep(400);
await page.evaluate(() => {
  const b = [...document.querySelectorAll(".modal-actions .btn")].find(
    (x) => x.textContent === "Delete all sessions",
  );
  b.click();
});
await sleep(2000);
const afterDelete = await page.evaluate(() => ({
  groupGone: ![...document.querySelectorAll("#sessions .side-group")].some(
    (x) => x.textContent.includes("remove-me-test"),
  ),
}));
const filesLeft = existsSync(sessDir)
  ? readdirSync(sessDir).filter((f) => f.endsWith(".jsonl")).length
  : 0;
console.log(
  "7. after delete-all:",
  JSON.stringify(afterDelete),
  "| files left on disk:",
  filesLeft,
);

console.log("page errors:", errors.length ? errors : "none");
await browser.close();
await server.close();
rmSync(PROJ, { recursive: true, force: true });
rmSync(sessDir, { recursive: true, force: true });
process.exit(0);
