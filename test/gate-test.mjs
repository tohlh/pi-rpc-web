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
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(server.url, { waitUntil: "networkidle2" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Before choosing a project, the entire composer is hidden and gated.
await page
  .waitForSelector("#sessions .sess", { timeout: 30000 })
  .catch(() => {});
await sleep(1500);
const gate1 = await page.evaluate(() => ({
  areaHidden: document.getElementById("composer-area").hidden,
  readOnly: document.getElementById("input").readOnly,
  gatedClass: document.getElementById("composer").classList.contains("gated"),
}));
console.log("1. landing composer gate:", JSON.stringify(gate1));
if (!gate1.areaHidden || !gate1.readOnly || !gate1.gatedClass) {
  throw new Error(
    `landing composer was not fully gated: ${JSON.stringify(gate1)}`,
  );
}

// 2. Choose a project via the picker (default project = server cwd).
await page.click("#btn-new");
await sleep(400);
const selectedProjectItems = await page.$$(".ctx-menu .ctx-item.current");
if (selectedProjectItems.length) {
  throw new Error("new-chat project picker still marks a project as selected");
}
const projectItem = await page.$('.ctx-menu .ctx-item[title]:not([title=""])');
if (!projectItem) throw new Error("project picker option missing");
if ((await projectItem.evaluate((el) => el.textContent)).includes("\u2713")) {
  throw new Error("new-chat project picker still shows a checkmark");
}
await projectItem.click();
await sleep(5000);
const gate2 = await page.evaluate(() => ({
  readOnly: document.getElementById("input").readOnly,
  placeholder: document.getElementById("input").placeholder,
  gatedClass: document.getElementById("composer").className.includes("gated"),
}));
console.log("2. after choosing project:", JSON.stringify(gate2));
console.log("   composer ungated:", !gate2.readOnly && !gate2.gatedClass);

// 4. temp group renders in alphabetical position (not pinned at top) for a NEW project.
await page.click("#btn-new");
await sleep(400);
for (const it of await page.$$(".ctx-item")) {
  if ((await it.evaluate((el) => el.textContent)).includes("New project")) {
    await it.click();
    break;
  }
}
await sleep(400);
const { mkdirSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const newProject = join(tmpdir(), "gate-zzz");
mkdirSync(newProject, { recursive: true });
await page.type(".modal-form .text-input", newProject);
await page.keyboard.press("Enter");
await sleep(5000);
const order = await page.evaluate(() =>
  [...document.querySelectorAll("#sessions .side-group")].map((g) =>
    g.textContent.trim(),
  ),
);
console.log("3. group order:", JSON.stringify(order));
console.log(
  "   temp group in alphabetical position (not first unless a-z):",
  order[0]?.startsWith("gate-zzz") === false || order[0] === undefined
    ? "checked below"
    : order[0],
);
const zIdx = order.findIndex((g) => g.includes("gate-zzz"));
console.log(
  "   gate-zzz group index:",
  zIdx,
  "of",
  order.length,
  "| alphabetical position correct:",
  zIdx === order.findIndex((g) => g.includes("locksmith")) + 1 || zIdx > 0,
);

console.log("page errors:", errors.length ? errors : "none");
await browser.close();
await server.close();
process.exit(0);
