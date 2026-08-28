// Minimal probe: run ONLY ui/js/ws.js in Node against a live server.
import { startServer } from "../src/server.ts";

const server = await startServer({ port: 0 });

// minimal browser globals ws.js touches
globalThis.location = { protocol: "http:", host: new URL(server.url).host };
const { RpcSocket } = await import("../ui/js/ws.js");
const s = new RpcSocket();

s.on("connecting", () => console.log("probe: connecting…"));
s.on("hello-ok", (m) => console.log("probe: hello-ok", JSON.stringify(m)));
s.on("hello-fail", (m) => console.log("probe: hello-fail", JSON.stringify(m)));
s.on("disconnected", () => console.log("probe: disconnected"));

s.configure({ cwd: "/tmp/pi-rpc-web-driver" });
s.connect();

try {
  const st = await s.request({ type: "get_state" }, { timeoutMs: 10000 });
  console.log("probe: get_state ok, sessionFile =", st.sessionFile);
} catch (e) {
  console.log("probe: get_state FAILED:", e.message);
}

await new Promise((r) => setTimeout(r, 500));
process.exit(0);
