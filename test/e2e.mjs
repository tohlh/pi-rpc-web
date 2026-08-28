/**
 * End-to-end test per CONTRACT.md:
 * starts the server on an ephemeral port, connects with the Node global
 * WebSocket client, performs the hello handshake, then exercises ping,
 * sessions.list, get_state, get_commands, get_available_models and a
 * set_thinking_level round-trip through the pi --mode rpc child.
 *
 * The real-LLM prompt test only runs when PI_RPC_WEB_E2E_LLM=1 (CI-safe).
 */
import assert from "node:assert/strict";
import { startServer } from "../src/server.ts";

const results = [];
function record(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push(["PASS", name]);
      console.log(`PASS ${name}`);
    })
    .catch((err) => {
      results.push(["FAIL", name]);
      console.error(`FAIL ${name}:`, err?.message ?? err);
    });
}

const server = await startServer({ port: 0 });
console.log(`e2e server on ${server.url}`);

const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
await onceOpen(ws);

let nextId = 1;
const inbox = [];

ws.onmessage = (event) => {
  let msg;
  try {
    msg = JSON.parse(
      typeof event.data === "string" ? event.data : event.data.toString("utf8"),
    );
  } catch {
    return;
  }
  inbox.push(msg);
};

async function openSocketInbox() {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  await onceOpen(socket);
  const messages = [];
  socket.onmessage = (event) => {
    try {
      messages.push(
        JSON.parse(
          typeof event.data === "string"
            ? event.data
            : event.data.toString("utf8"),
        ),
      );
    } catch {}
  };
  return { socket, messages };
}

function onceOpen(socket) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out connecting")), 5000);
    socket.onopen = () => {
      clearTimeout(t);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(t);
      reject(new Error("socket error while connecting"));
    };
  });
}

function send(obj) {
  ws.send(JSON.stringify(obj));
}

async function waitForMessage(messages, label, pred, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (pred(messages[i])) return messages[i];
  }
  while (Date.now() < deadline) {
    await sleep(50);
    for (let i = messages.length - 1; i >= 0; i--) {
      if (pred(messages[i])) return messages[i];
    }
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitFor(label, pred, timeoutMs = 30000) {
  return waitForMessage(inbox, label, pred, timeoutMs);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Send an RPC command and wait for its correlated response. */
async function rpc(command, extra = {}) {
  const id = `e2e-${nextId++}`;
  send({ id, type: command, ...extra });
  return waitFor(
    `${command} response`,
    (m) => m.type === "response" && m.id === id,
  );
}

async function assertHelloRejectedBeforeSpawn(extraArgs, expectedError) {
  const { socket, messages } = await openSocketInbox();
  try {
    socket.send(
      JSON.stringify({
        type: "hello",
        cwd: process.cwd(),
        extraArgs,
      }),
    );
    const reply = await waitForMessage(
      messages,
      "hello rejection",
      (m) => m.type === "hello",
      5000,
    );
    assert.deepEqual(reply, {
      type: "hello",
      ok: false,
      error: expectedError,
    });
    await sleep(250);
    assert.equal(
      messages.some((m) => m.type === "child"),
      false,
      `expected no child lifecycle events for ${JSON.stringify(extraArgs)}, got ${JSON.stringify(messages)}`,
    );
  } finally {
    socket.close();
  }
}

// ------------------------------------------------------------------- tests

await record("hello handshake spawns child", async () => {
  send({ type: "hello", cwd: process.cwd() });
  const reply = await waitFor("hello ack", (m) => m.type === "hello");
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.ok(
    Number.isInteger(reply.pid),
    `pid missing: ${JSON.stringify(reply)}`,
  );
});

await record("meta ping", async () => {
  send({ type: "meta", id: "m-ping", action: "ping" });
  const reply = await waitFor(
    "meta ping reply",
    (m) => m.type === "meta" && m.id === "m-ping",
  );
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.data, { pong: true });
});

await record("meta sessions.list", async () => {
  send({ type: "meta", id: "m-sessions", action: "sessions.list" });
  const reply = await waitFor(
    "sessions.list reply",
    (m) => m.type === "meta" && m.id === "m-sessions",
    15000,
  );
  assert.equal(reply.ok, true, JSON.stringify(reply).slice(0, 200));
  const data = reply.data ?? {};
  const projects = Array.isArray(data.projects) ? data.projects : [];
  assert.ok(
    projects.length > 0 || Array.isArray(data.sessions),
    "expected projects group or sessions list",
  );
  if (projects.length > 0) {
    const s = projects[0].sessions?.[0];
    if (s) {
      assert.equal(typeof s.path, "string");
      assert.equal(typeof s.mtimeMs, "number");
      assert.equal(typeof s.sessionId, "string");
    }
  }
});

await record("rpc get_state round-trips through child", async () => {
  const res = await rpc("get_state");
  assert.equal(res.command, "get_state");
  assert.equal(res.success, true, JSON.stringify(res).slice(0, 300));
  assert.ok(
    "sessionFile" in (res.data ?? {}),
    "expected sessionFile in state data",
  );
});

await record("rpc get_commands", async () => {
  const res = await rpc("get_commands");
  assert.equal(res.success, true, JSON.stringify(res).slice(0, 300));
  assert.ok(
    Array.isArray((res.data ?? {}).commands),
    "expected commands array",
  );
});

await record("rpc get_available_models", async () => {
  const res = await rpc("get_available_models");
  assert.equal(res.success, true, JSON.stringify(res).slice(0, 300));
  assert.ok(Array.isArray((res.data ?? {}).models), "expected models array");
});

await record("rpc set_thinking_level round-trip", async () => {
  const res = await rpc("set_thinking_level", { level: "medium" });
  assert.equal(res.command, "set_thinking_level");
  // Round-trip proven by correlated response; success depends on model support.
  assert.equal(
    typeof res.success,
    "boolean",
    `unexpected reply: ${JSON.stringify(res).slice(0, 300)}`,
  );
});

await record("hello rejects recursive --rpc-web flag", async () => {
  await assertHelloRejectedBeforeSpawn(
    ["--rpc-web"],
    "child extraArgs may not include --rpc-web",
  );
});

await record("hello rejects recursive --rpc-web-lan flags", async () => {
  await assertHelloRejectedBeforeSpawn(
    ["--rpc-web-lan"],
    "child extraArgs may not include --rpc-web-lan",
  );
  await assertHelloRejectedBeforeSpawn(
    ["--rpc-web-lan=true"],
    "child extraArgs may not include --rpc-web-lan",
  );
});

await record("hello rejects removed legacy browser-host flags", async () => {
  await assertHelloRejectedBeforeSpawn(
    ["--remote"],
    "child extraArgs may not include --remote",
  );
  await assertHelloRejectedBeforeSpawn(
    ["--remote-lan"],
    "child extraArgs may not include --remote-lan",
  );
});

await record(
  "removed meta actions session.watch/session.sizes fail",
  async () => {
    for (const action of ["session.watch", "session.sizes"]) {
      const id = `m-${action.replace(".", "-")}`;
      send({ type: "meta", id, action });
      const reply = await waitFor(
        `${action} reply`,
        (m) => m.type === "meta" && m.id === id,
        5000,
      );
      assert.equal(
        reply.ok,
        false,
        `${action} should fail: ${JSON.stringify(reply)}`,
      );
      assert.ok(
        String(reply.error ?? "").includes("unknown meta action"),
        `expected unknown meta action error, got: ${JSON.stringify(reply)}`,
      );
    }
  },
);

await record(
  "same session opens from two sockets with distinct children",
  async () => {
    send({ type: "meta", id: "m-list-shared", action: "sessions.list" });
    const listReply = await waitFor(
      "sessions.list reply",
      (m) => m.type === "meta" && m.id === "m-list-shared",
      15000,
    );
    assert.equal(listReply.ok, true, JSON.stringify(listReply).slice(0, 200));
    const data = listReply.data ?? {};
    let sessionPath = null;
    for (const p of Array.isArray(data.projects) ? data.projects : []) {
      const s = p.sessions?.[0];
      if (s?.path) {
        sessionPath = s.path;
        break;
      }
    }
    if (!sessionPath && Array.isArray(data.sessions)) {
      sessionPath = data.sessions[0]?.path ?? null;
    }
    assert.ok(sessionPath, "expected at least one existing session path");

    const a = await openSocketInbox();
    const b = await openSocketInbox();
    try {
      const helloBody = JSON.stringify({
        type: "hello",
        cwd: process.cwd(),
        session: sessionPath,
      });
      a.socket.send(helloBody);
      b.socket.send(helloBody);
      const ra = await waitForMessage(
        a.messages,
        "hello a",
        (m) => m.type === "hello",
        15000,
      );
      const rb = await waitForMessage(
        b.messages,
        "hello b",
        (m) => m.type === "hello",
        15000,
      );
      assert.equal(ra.ok, true, JSON.stringify(ra).slice(0, 300));
      assert.equal(rb.ok, true, JSON.stringify(rb).slice(0, 300));
      assert.ok(
        Number.isInteger(ra.pid) &&
          Number.isInteger(rb.pid) &&
          ra.pid !== rb.pid,
        `expected distinct child pids, got ${ra.pid} and ${rb.pid}`,
      );

      // Closing each socket tears down its bridge child; verify both exit.
      a.socket.close();
      b.socket.close();
      const alive = async (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const deadline = Date.now() + 10000;
      while (
        Date.now() < deadline &&
        ((await alive(ra.pid)) || (await alive(rb.pid)))
      ) {
        await sleep(100);
      }
      assert.equal(await alive(ra.pid), false, `child ${ra.pid} still alive`);
      assert.equal(await alive(rb.pid), false, `child ${rb.pid} still alive`);
    } catch (err) {
      a.socket.close();
      b.socket.close();
      throw err;
    }
  },
);

if (process.env.PI_RPC_WEB_E2E_LLM === "1") {
  await record("llm prompt streams events (PI_RPC_WEB_E2E_LLM=1)", async () => {
    const id = `e2e-${nextId++}`;
    send({ id, type: "prompt", message: "Reply with exactly OK" });
    const textPromise = waitFor(
      "assistant text",
      (m) =>
        m.type === "message_update" &&
        m.assistantMessageEvent?.type === "text_delta" &&
        typeof m.assistantMessageEvent.delta === "string",
      120000,
    );
    await waitFor(
      `${id} response`,
      (m) => m.type === "response" && m.id === id,
      60000,
    );
    const delta = await textPromise;
    assert.ok(delta.assistantMessageEvent.delta.length > 0);
    await waitFor("agent_settled", (m) => m.type === "agent_settled", 120000);
  });
} else {
  console.log("SKIP llm prompt test (set PI_RPC_WEB_E2E_LLM=1 to enable)");
}

// ------------------------------------------------------------------ cleanup

ws.close();
await sleep(200);
await server.close();

const failed = results.filter(([s]) => s === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed > 0 ? 1 : 0);
