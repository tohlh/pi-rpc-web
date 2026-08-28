// DOM harness: runs the REAL frontend (ui/js/main.js) inside jsdom against a
// live server, then simulates the user flows: session pick (cold respawn),
// streaming switch confirmation (Keep working / Abort & switch).
//
// Session rows are fixtures: outgoing `sessions.list` meta calls are answered
// locally with two deterministic sessions so row rendering + click behavior
// are exercised through the real renderList/renderSessionRow code paths.
import { JSDOM } from "jsdom";
import { fileURLToPath } from "node:url";
import { startServer } from "../src/server.ts";
import { RpcSocket } from "../ui/js/ws.js";

const UI = fileURLToPath(new URL("../ui", import.meta.url));
const html = (await import("node:fs")).readFileSync(`${UI}/index.html`, "utf8");

const server = await startServer({ port: 0 });
const dom = new JSDOM(html.replace(/<script[^>]*><\/script>/, ""), {
  url: `${server.url}/`,
  pretendToBeVisual: true,
  runScripts: "outside-only",
});

const { window } = dom;
const errors = [];
window.addEventListener("error", (e) =>
  errors.push("window.onerror: " + e.message),
);
console.error = (...a) => {
  errors.push("console.error: " + a.map(String).join(" ").slice(0, 300));
};
process.on("unhandledRejection", (e) =>
  errors.push(
    "unhandledRejection: " +
      ((e && (e.stack || e.message)) || String(e)).slice(0, 500),
  ),
);

// --- instrumentation: record RPC command types + force reconnects BEFORE the
// real app imports ws.js and instantiates its socket.
const sentRpcTypes = [];
let forceReconnectCalls = 0;
/** ordered log of interesting actions (abort fired vs reconnect started) */
const actionLog = [];

const origRequest = RpcSocket.prototype.request;
RpcSocket.prototype.request = function (cmd, opts) {
  if (cmd && typeof cmd.type === "string") sentRpcTypes.push(cmd.type);
  return origRequest.call(this, cmd, opts);
};
const origFire = RpcSocket.prototype.fire;
RpcSocket.prototype.fire = function (cmd) {
  if (cmd && typeof cmd.type === "string") actionLog.push("fire:" + cmd.type);
  return origFire.call(this, cmd);
};
const origForceReconnect = RpcSocket.prototype.forceReconnect;
RpcSocket.prototype.forceReconnect = function () {
  forceReconnectCalls++;
  actionLog.push("forceReconnect");
  return origForceReconnect.call(this);
};

// --- fixture sessions answered instead of hitting the server listing
const FIXTURE_SESSIONS = [
  {
    path: "/tmp/pi-fixture-proj/sess-a.jsonl",
    name: "fixture alpha",
    firstPrompt: null,
    messageCount: 3,
    cwd: "/tmp/pi-fixture-proj",
    cwdExists: true,
    mtimeMs: Date.now() - 60_000,
  },
  {
    path: "/tmp/pi-fixture-proj/sess-b.jsonl",
    name: "fixture beta",
    firstPrompt: null,
    messageCount: 3,
    cwd: "/tmp/pi-fixture-proj",
    cwdExists: true,
    mtimeMs: Date.now() - 30_000,
  },
];
function metaReply(id, ok, data) {
  const ws = sockets.at(-1);
  if (!ws) return false;
  ws.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({
        type: "meta",
        id,
        ok,
        ...(ok ? { data } : { error: "fixture" }),
      }),
    }),
  );
  return true;
}

// --- globals the frontend modules expect at import time
globalThis.document = window.document;
globalThis.window = window;
// Trace every WebSocket the app creates
const RealWS = globalThis.WebSocket;
const sockets = [];
/** every outgoing hello frame, in order — proves where a reconnect lands */
const hellos = [];
globalThis.WebSocket = class extends RealWS {
  constructor(url) {
    console.log("[trace] new WS ->", url);
    super(url);
    sockets.push(this);
    this.addEventListener("open", () => console.log("[trace] open"));
    this.addEventListener("close", (e) => console.log("[trace] close", e.code));
    this.addEventListener("error", () => console.log("[trace] error"));
    this.addEventListener("message", (e) =>
      console.log("[trace] <=", String(e.data).slice(0, 80)),
    );
    const origSend = this.send.bind(this);
    this.send = (d) => {
      console.log("[trace] =>", String(d).slice(0, 80));
      // Answer sidebar listings (and stub destructive deletes) locally so the
      // flow is deterministic; everything else goes to the live server.
      try {
        const msg = JSON.parse(d);
        if (msg.type === "hello") hellos.push(msg);
        if (msg.type === "meta" && msg.action === "sessions.list" && msg.id) {
          return metaReply(msg.id, true, {
            projects: [
              { project: "/tmp/pi-fixture-proj", sessions: FIXTURE_SESSIONS },
            ],
          });
        }
        if (msg.type === "meta" && msg.action === "sessions.delete" && msg.id) {
          return metaReply(msg.id, true, {});
        }
      } catch {
        /* fall through: forward raw frame */
      }
      return origSend(d);
    };
  }
};
globalThis.location = window.location;
try {
  Object.defineProperty(globalThis, "navigator", {
    value: window.navigator,
    configurable: true,
  });
} catch {
  /* keep host navigator */
}
globalThis.Node = window.Node;
globalThis.HTMLElement = window.HTMLElement;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.ResizeObserver = window.ResizeObserver;

// --- load the real app
try {
  await import(`${UI}/js/main.js`);
} catch (e) {
  console.log("MAIN.JS IMPORT THREW:", e.stack || e.message);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(desc, fn, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (fn()) return true;
    } catch {
      /* keep waiting */
    }
    await sleep(100);
  }
  console.log(`FAIL: ${desc} (timed out)`);
  return false;
}

const doc = window.document;
const $ = (s) => doc.querySelector(s);

const failures = [];
function assert(cond, label) {
  console.log((cond ? "PASS" : "FAIL") + ": " + label);
  if (!cond) failures.push(label);
}

// --- 1. initial snapshot rendered against the live server
await waitFor("initial snapshot rendered", () => {
  const ph = $("#chat-empty");
  return (
    $("#stream").children.length > 0 ||
    (ph && !ph.hidden && /No messages yet|Pick a project/.test(ph.textContent))
  );
});

// --- 2. two fixture session rows render through the real sidebar renderer
const okList = await waitFor(
  "fixture sessions listed in sidebar",
  () => $("#sessions").querySelectorAll(".sess").length === 2,
);
assert(okList, "two fixture session rows render");

// Touch browsers synthesize mouseenter before click. The autocomplete item must
// remain connected so the subsequent click can complete the command selection.
const commandInput = $("#input");
commandInput.value = "/";
commandInput.dispatchEvent(new window.Event("input", { bubbles: true }));
const commandsOpened = await waitFor(
  "slash-command autocomplete opens",
  () => !!$("#autocomplete .ac-item"),
);
assert(commandsOpened, "slash-command autocomplete lists commands and skills");
const commandItem = $("#autocomplete .ac-item");
commandItem?.dispatchEvent(new window.MouseEvent("mouseenter"));
assert(commandItem?.isConnected, "autocomplete item survives pointer hover");
commandItem?.click();
assert(
  /^\/.+\s$/.test(commandInput.value),
  "clicking an autocomplete item fills the command",
);
commandInput.value = "";
commandInput.dispatchEvent(new window.Event("input", { bubbles: true }));

/** Deliver a fake agent/child event to the socket over the current WS. */
function pushEvent(ev) {
  const ws = sockets.at(-1);
  if (!ws) throw new Error("no websocket yet");
  ws.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(ev) }));
}

/** Wait for an outgoing hello frame beyond `baseline` (captured before the
 * triggering click — respawn hellos can land within milliseconds) and return it. */
async function waitForHello(baseline, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (hellos.length > baseline) return hellos[hellos.length - 1];
    await sleep(50);
  }
  return null;
}

// --- 3. cold switch while idle: click non-current row -> one reconnect,
//        never switch_session
{
  sentRpcTypes.length = 0;
  actionLog.length = 0;
  const beforeCalls = forceReconnectCalls;
  const targetRow = $("#sessions .sess:not(.current) .sess-main");
  assert(!!targetRow, "a non-current .sess row exists to click");
  const helloBaseline = hellos.length;
  targetRow?.click();
  await sleep(50);
  assert(
    sentRpcTypes.includes("switch_session") === false,
    "idle switch sends no switch_session",
  );
  assert(
    forceReconnectCalls - beforeCalls === 1,
    "idle switch performs exactly one forceReconnect",
  );
  assert(
    doc.querySelectorAll(".modal-backdrop").length === 0,
    "idle switch opens no confirmation modal",
  );
  const targetPath = targetRow.closest(".sess").dataset.path;
  const targetCwd = FIXTURE_SESSIONS.find((s) => s.path === targetPath)?.cwd;
  const hello = await waitForHello(helloBaseline);
  assert(
    !!hello && hello.session === targetPath && hello.cwd === targetCwd,
    `reconnect hello targets the selected session (session=${targetPath}, cwd=${targetCwd})`,
  );
}

// --- 4. streaming switch: modal gates the reconnect until user decides
{
  sentRpcTypes.length = 0;
  actionLog.length = 0;
  const beforeCalls = forceReconnectCalls;
  pushEvent({ type: "agent_start" });

  const targetRow = $("#sessions .sess:not(.current) .sess-main");
  targetRow?.click();
  await sleep(50);

  const modal = [...doc.querySelectorAll(".modal-title")].find((t) =>
    /Switch sessions\?/.test(t.textContent),
  );
  assert(!!modal, "streaming switch opens the confirm modal");
  assert(
    forceReconnectCalls === beforeCalls,
    "no reconnect occurs before modal interaction",
  );

  // Keep working: preserve connection, no abort, no reconnect.
  const keepBtn = [...doc.querySelectorAll(".modal-actions .btn")].find(
    (b) => b.textContent === "Keep working",
  );
  assert(!!keepBtn, "'Keep working' action present");
  keepBtn?.click();
  await waitFor(
    "modal removed after 'Keep working'",
    () => doc.querySelectorAll(".modal-backdrop").length === 0,
    1000,
  );
  assert(
    doc.querySelectorAll(".modal-backdrop").length === 0,
    "'Keep working' closes the modal",
  );
  assert(
    actionLog.includes("fire:abort") === false,
    "'Keep working' fires no abort",
  );
  assert(
    forceReconnectCalls === beforeCalls,
    "'Keep working' preserves the connection",
  );

  // Re-pick, then Abort & switch: abort fired, then exactly one reconnect.
  // Re-arm streaming first: a hello failure from an earlier reconnect closes
  // the socket and main.js's 'disconnected' handler clears isStreaming.
  pushEvent({ type: "agent_start" });
  $("#sessions .sess:not(.current) .sess-main").click();
  await sleep(50);
  const abortBtn = [...doc.querySelectorAll(".modal-actions .btn")].find(
    (b) => b.textContent === "Abort & switch",
  );
  assert(!!abortBtn, "'Abort & switch' action present");
  const abortTargetPath = doc.querySelector("#sessions .sess:not(.current)")
    .dataset.path;
  const abortTargetCwd = FIXTURE_SESSIONS.find(
    (s) => s.path === abortTargetPath,
  )?.cwd;
  const abortHelloBaseline = hellos.length;
  abortBtn?.click();
  await sleep(50);
  assert(
    sentRpcTypes.includes("switch_session") === false,
    "streaming switch sends no switch_session",
  );
  const abortIdx = actionLog.indexOf("fire:abort");
  const reconIdx = actionLog.indexOf("forceReconnect");
  assert(
    abortIdx !== -1 && reconIdx !== -1 && reconIdx > abortIdx,
    "'Abort & switch' records abort before one reconnect",
  );
  assert(
    forceReconnectCalls - beforeCalls === 1,
    "streaming switch performs exactly one forceReconnect",
  );
  const hello = await waitForHello(abortHelloBaseline);
  assert(
    !!hello &&
      hello.session === abortTargetPath &&
      hello.cwd === abortTargetCwd,
    `post-abort reconnect hello targets the selected session (session=${abortTargetPath}, cwd=${abortTargetCwd})`,
  );
}

// --- 5. New chat flow: #btn-new -> pick a project -> cold new-session
//        reconnect (hello session=null rooted at the chosen cwd)
{
  sentRpcTypes.length = 0;
  actionLog.length = 0;
  const beforeCalls = forceReconnectCalls;
  const fixtureProject = "/tmp/pi-fixture-proj";

  $("#btn-new").click();
  await waitFor("new-chat menu opens", () => doc.querySelector(".ctx-item"));
  const item = [...doc.querySelectorAll(".ctx-item")].find(
    (b) => b.title === fixtureProject,
  );
  assert(!!item, "new-chat menu lists the fixture project");
  const newChatHelloBaseline = hellos.length;
  item?.click();
  await sleep(50);
  assert(
    doc.querySelectorAll(".ctx-menu").length === 0,
    "picking a project closes the new-chat menu",
  );
  assert(
    sentRpcTypes.includes("switch_session") === false,
    "new chat sends no switch_session",
  );
  assert(
    forceReconnectCalls - beforeCalls === 1,
    "new chat performs exactly one forceReconnect",
  );
  const hello = await waitForHello(newChatHelloBaseline);
  assert(
    !!hello && hello.session === null && hello.cwd === fixtureProject,
    `new chat hello starts a cold new session at the chosen project (session===null, cwd=${fixtureProject})`,
  );
}

// --- summary
console.log("\nerrors:", errors.length ? errors.slice(0, 10) : "none");
if (failures.length) {
  console.log(`\n=== ui-harness FAILED (${failures.length} assertions) ===`);
  process.exitCode = 1;
} else {
  console.log("\n=== ui-harness passed ===");
}
wsCleanup();
async function wsCleanup() {
  try {
    window.close();
  } catch {}
  await server.close();
  process.exit(process.exitCode || 0);
}
