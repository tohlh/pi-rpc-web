import puppeteer from "puppeteer-core";
import { startServer } from "../src/server.ts";

const server = await startServer({ port: 0 });
const browser = await puppeteer.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new",
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
await page.goto(server.url, { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 1500));
const heights = await page.evaluate(() => {
  for (const id of ["btn-stop", "mode-chip"])
    document.getElementById(id).removeAttribute("hidden");
  const g = (id) => document.getElementById(id).getBoundingClientRect().height;
  return { send: g("btn-send"), stop: g("btn-stop"), chip: g("mode-chip") };
});
console.log(JSON.stringify(heights));
// working bar visibility check
const wb = await page.evaluate(() => {
  const bar = document.getElementById("working-bar");
  return { exists: !!bar, hidden: bar.hidden };
});
console.log("working-bar:", JSON.stringify(wb));
// simulate external working: can't easily; just unhide and measure layout
await page.evaluate(() => {
  document.getElementById("working-bar").hidden = false;
});
await new Promise((r) => setTimeout(r, 100));
await page.screenshot({ path: "/tmp/pi-rpc-web-shots/impl-workingbar.png" });
console.log("errors:", errors?.length || 0);
async function done() {
  await browser.close();
  server.close();
}
done();
var errors;
