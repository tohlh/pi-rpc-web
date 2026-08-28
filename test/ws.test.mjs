/**
 * Raw-TCP tests for the hand-rolled RFC 6455 WebSocket layer in src/ws.ts.
 * Runs standalone with plain `node` (Node >= 22.18: TS type stripping is on).
 */
import assert from "node:assert/strict";
import net from "node:net";
import { createServer } from "node:http";
import { once } from "node:events";
import { tryUpgradeSocket, WebSocketConnection } from "../src/ws.ts";

const results = [];

function record(name, fn) {
  return fn()
    .then(() => {
      results.push(["PASS", name]);
      console.log(`PASS ${name}`);
    })
    .catch((err) => {
      results.push(["FAIL", name]);
      console.error(`FAIL ${name}:`, err?.message ?? err);
    });
}

// ---------------------------------------------------------------- server setup

/** Minimal WS echo server: accepts upgrades on a raw http server, echoes text messages. */
async function startEchoServer() {
  const http = createServer();
  const sockets = new Set();
  http.on("upgrade", (req, socket) => {
    if (!tryUpgradeSocket(req, socket)) {
      socket.destroy();
      return;
    }
    const conn = new WebSocketConnection(socket, {
      onMessage(data, isText) {
        if (isText) conn.sendText(data.toString("utf8"));
      },
    });
    sockets.add(conn);
    socket.on("close", () => sockets.delete(conn));
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address();
  return {
    port,
    close: async () => {
      for (const s of sockets) s.terminate();
      await new Promise((resolve) => http.close(resolve));
    },
  };
}

// ------------------------------------------------------------- client helpers

function connectRaw(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => resolve(socket));
    socket.on("error", reject);
  });
}

function rawRequest(port, key) {
  return (
    `GET /ws HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${port}\r\n` +
    `Upgrade: websocket\r\n` +
    `Connection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${key}\r\n` +
    `Sec-WebSocket-Version: 13\r\n` +
    `\r\n`
  );
}

/** Read the HTTP upgrade response head; resolve { headers } and leave body bytes buffered via callback events. */
function readHandshake(socket) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      socket.removeListener("data", onData);
      socket.removeListener("error", reject);
      const head = buf.subarray(0, idx).toString("latin1");
      const rest = buf.subarray(idx + 4);
      const lines = head.split("\r\n");
      const statusLine = lines[0] ?? "";
      const headers = {};
      for (const line of lines.slice(1)) {
        const i = line.indexOf(":");
        if (i > 0)
          headers[line.slice(0, i).trim().toLowerCase()] = line
            .slice(i + 1)
            .trim();
      }
      resolve({ statusLine, headers, rest });
    };
    socket.once("error", reject);
    socket.on("data", onData);
  });
}

function maskPayload(payload, maskKey) {
  const out = Buffer.from(payload);
  for (let i = 0; i < out.length; i++) out[i] ^= maskKey[i & 3];
  return out;
}

function randomMask() {
  return Buffer.from([
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256),
  ]);
}

/** Build one masked client frame. */
export function clientFrame(opcode, payload, fin = true) {
  payload = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = randomMask();
  const masked = maskPayload(payload, mask);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, mask, masked]);
}

/** Frame reader over a raw socket: yields decoded server frames (unmasked). */
function createFrameReader(socket, initial = Buffer.alloc(0)) {
  const queue = [];
  let notify = null;
  let buf = Buffer.from(initial);

  function tryParse() {
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      len = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length < offset + maskLen + len) return null;
    let payload = buf.subarray(offset + maskLen, offset + maskLen + len);
    if (masked)
      payload = maskPayload(payload, buf.subarray(offset, offset + 4));
    buf = buf.subarray(offset + maskLen + len);
    return { fin, opcode, payload: Buffer.from(payload) };
  }

  function pump() {
    let frame;
    while ((frame = tryParse()) !== null) queue.push(frame);
    while (queue.length > 0 && notify) {
      const n = notify;
      notify = null;
      n(queue.shift());
    }
  }

  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    pump();
  });

  return function next(timeoutMs = 3000) {
    if (queue.length > 0) return Promise.resolve(queue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for frame")),
        timeoutMs,
      );
      notify = (frame) => {
        clearTimeout(timer);
        resolve(frame);
      };
    });
  };
}

// ------------------------------------------------------------------- the tests

const server = await startEchoServer();

await record("handshake accept key", async () => {
  const socket = await connectRaw(server.port);
  try {
    // RFC 6455 section 1.3 example key -> known accept value.
    socket.write(rawRequest(server.port, "dGhlIHNhbXBsZSBub25jZQ=="));
    const { statusLine, headers } = await readHandshake(socket);
    assert.match(statusLine, /101 Switching Protocols/);
    assert.equal(headers.upgrade, "websocket");
    assert.equal(
      headers["sec-websocket-accept"],
      "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
    );
  } finally {
    socket.destroy();
  }
});

await record("masked text frame echo", async () => {
  const socket = await connectRaw(server.port);
  try {
    socket.write(rawRequest(server.port, "c2FtcGxlLWtleS0xMjM0NQ=="));
    const { rest } = await readHandshake(socket);
    const next = createFrameReader(socket, rest);
    socket.write(clientFrame(0x1, "Hello, pi-rpc-web!"));
    const frame = await next();
    assert.equal(frame.opcode, 0x1, "echo should be a text frame");
    assert.equal(finOf(frame), true);
    assert.equal(frame.payload.toString("utf8"), "Hello, pi-rpc-web!");
  } finally {
    socket.destroy();
  }
});

await record("fragmented message reassembled", async () => {
  const socket = await connectRaw(server.port);
  try {
    socket.write(rawRequest(server.port, "ZnJhZ21lbnRzLXRlc3Q="));
    const { rest } = await readHandshake(socket);
    const next = createFrameReader(socket, rest);
    // text frag (fin=0), two continuations, final continuation.
    socket.write(clientFrame(0x1, "Hel", false));
    socket.write(clientFrame(0x0, "lo pi ", false));
    socket.write(clientFrame(0x0, "fragmen", false));
    socket.write(clientFrame(0x0, "ts", true));
    const frame = await next();
    assert.equal(frame.opcode, 0x1);
    assert.equal(frame.payload.toString("utf8"), "Hello pi fragments");
  } finally {
    socket.destroy();
  }
});

await record("ping answered by pong with same payload", async () => {
  const socket = await connectRaw(server.port);
  try {
    socket.write(rawRequest(server.port, "cGluZy1wb25nLXRlc3Q="));
    const { rest } = await readHandshake(socket);
    const next = createFrameReader(socket, rest);
    socket.write(clientFrame(0x9, "heartbeat"));
    const frame = await next();
    assert.equal(frame.opcode, 0xa, "expected pong opcode");
    assert.equal(frame.payload.toString("utf8"), "heartbeat");
  } finally {
    socket.destroy();
  }
});

await record("close handshake echoed", async () => {
  const socket = await connectRaw(server.port);
  try {
    socket.write(rawRequest(server.port, "Y2xvc2UtaGFuZHNoYWs="));
    const { rest } = await readHandshake(socket);
    const next = createFrameReader(socket, rest);
    const closeBody = Buffer.alloc(2);
    closeBody.writeUInt16BE(1000);
    socket.write(clientFrame(0x8, closeBody));
    const frame = await next();
    assert.equal(frame.opcode, 0x8, "server should reply with a close frame");
    assert.equal(frame.payload.readUInt16BE(0), 1000);
    const ended = once(socket, "close", { signal: AbortSignal.timeout(3000) });
    await ended;
  } finally {
    socket.destroy();
  }
});

await record("oversized message rejected with 1009", async () => {
  const socket = await connectRaw(server.port);
  try {
    socket.write(rawRequest(server.port, "b3ZlcnNpemUtdGVzdA=="));
    const { rest } = await readHandshake(socket);
    const next = createFrameReader(socket, rest);
    // Declare a huge payload length but send no payload bytes.
    const header = Buffer.alloc(10);
    header[0] = 0x81; // FIN + text
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(2 * 1024 * 1024 + 1), 2);
    socket.write(header);
    socket.write(randomMask());
    const frame = await next();
    assert.equal(frame.opcode, 0x8, "expected close frame");
    assert.equal(frame.payload.readUInt16BE(0), 1009);
  } finally {
    socket.destroy();
  }
});

await record("unmasked client frame rejected with 1002", async () => {
  const socket = await connectRaw(server.port);
  try {
    socket.write(rawRequest(server.port, "dW5tYXNrZWQtdGVzdA=="));
    const { rest } = await readHandshake(socket);
    const next = createFrameReader(socket, rest);
    const payload = Buffer.from("bare");
    const header = Buffer.from([0x81, payload.length]); // no mask bit
    socket.write(Buffer.concat([header, payload]));
    const frame = await next();
    assert.equal(frame.opcode, 0x8);
    assert.equal(frame.payload.readUInt16BE(0), 1002);
  } finally {
    socket.destroy();
  }
});

await server.close();

const failed = results.filter(([status]) => status === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed > 0 ? 1 : 0);

function finOf(frame) {
  return frame.fin;
}
