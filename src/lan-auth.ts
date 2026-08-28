import { randomBytes, randomInt } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface LanAuthOptions {
  pin?: string;
  now?: () => number;
  sessionId?: () => string;
}

export interface LanAuth {
  readonly pin: string;
  readonly displayPin: string;
  gateHttp(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  isAuthorized(req: IncomingMessage): boolean;
  clear(): void;
}

const COOKIE_NAME = "pi_rpc_web_session";
const MAX_LOGIN_BODY_BYTES = 4096;
const LOCKOUT_FAILURES = 5;
const LOCKOUT_MS = 30_000;
const SESSION_ID_PATTERN = /^[0-9a-f]{64}$/;
const PIN_PATTERN = /^\d{6}$/;
const ASCII_WHITESPACE_PATTERN = /[\t\n\f\r ]/g;
const HEX_PAIR_PATTERN = /^[0-9a-fA-F]{2}$/;

interface ThrottleRecord {
  failures: number;
  lockedUntil: number;
}

export function createLanAuth(options: LanAuthOptions = {}): LanAuth {
  const pin = options.pin ?? randomInt(1_000_000).toString().padStart(6, "0");
  if (!PIN_PATTERN.test(pin))
    throw new Error("LAN PIN must be exactly six digits");
  const makeSessionId =
    options.sessionId ?? (() => randomBytes(32).toString("hex"));
  const now = options.now ?? Date.now;
  const sessionIds = new Set<string>();
  const throttles = new Map<string, ThrottleRecord>();
  const displayPin = `${pin.slice(0, 3)} ${pin.slice(3)}`;

  function isAuthorized(req: IncomingMessage): boolean {
    const sessionId = parseSessionCookie(req);
    return sessionId !== null && sessionIds.has(sessionId);
  }

  async function gateHttp(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      respondText(res, 400, "bad request");
      return true;
    }
    if (pathname === "/login" && req.method === "GET") {
      renderLogin(res, 200);
      return true;
    }
    if (pathname === "/login" && req.method === "POST") {
      await handleLogin(req, res);
      return true;
    }
    if (pathname === "/login") {
      renderLogin(res, 405, "Use the login form to submit the server PIN.", {
        Allow: "GET, POST",
      });
      return true;
    }
    if (isAuthorized(req)) return false;
    redirectToLogin(res);
    return true;
  }

  async function handleLogin(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!isFormPost(req)) {
      renderLogin(res, 415, "Submit the login form to continue.");
      return;
    }

    const peer = peerAddress(req);
    const currentTime = now();
    let lock = throttles.get(peer);
    if (
      lock !== undefined &&
      lock.lockedUntil > 0 &&
      lock.lockedUntil <= currentTime
    ) {
      throttles.delete(peer);
      lock = undefined;
    }
    const lockedUntil = lock?.lockedUntil ?? 0;
    const isLocked = lockedUntil > currentTime;

    const body = await readBody(req, res);
    if (body === null) return;
    if (isLocked) {
      const waitSeconds = Math.ceil((lockedUntil - now()) / 1000);
      renderLogin(
        res,
        429,
        `Too many attempts. Wait ${waitSeconds} seconds and try again.`,
      );
      return;
    }
    if (hasMalformedFormEncoding(body)) {
      renderLogin(res, 400, "Invalid login request.");
      return;
    }

    const submitted = new URLSearchParams(body).get("pin");
    if (submitted === null) {
      renderLogin(res, 400, "Enter the six-digit PIN.");
      return;
    }

    const normalizedPin = submitted.replace(ASCII_WHITESPACE_PATTERN, "");
    if (normalizedPin !== pin) {
      registerFailure(peer, now(), throttles);
      renderLogin(res, 401, "Invalid PIN. Try again.");
      return;
    }

    let sessionId: string;
    try {
      sessionId = makeSessionId();
    } catch {
      renderLogin(res, 500, "Login unavailable. Try again.");
      return;
    }
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      renderLogin(res, 500, "Login unavailable. Try again.");
      return;
    }

    throttles.delete(peer);
    sessionIds.add(sessionId);
    res.writeHead(303, {
      "Cache-Control": "no-store",
      Location: "/",
      "Set-Cookie": `${COOKIE_NAME}=${sessionId}; HttpOnly; SameSite=Strict; Path=/`,
    });
    res.end();
  }

  return {
    pin,
    displayPin,
    gateHttp,
    isAuthorized,
    clear() {
      sessionIds.clear();
      throttles.clear();
    },
  };
}

function parseSessionCookie(req: IncomingMessage): string | null {
  const cookieHeader = req.headers.cookie;
  if (typeof cookieHeader !== "string") return null;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const name = trimmed.slice(0, separator).trim();
    if (name !== COOKIE_NAME) continue;
    return trimmed.slice(separator + 1).trim();
  }
  return null;
}

function peerAddress(req: IncomingMessage): string {
  const remoteAddress = req.socket.remoteAddress ?? "";
  return remoteAddress.startsWith("::ffff:")
    ? remoteAddress.slice(7)
    : remoteAddress;
}

function isFormPost(req: IncomingMessage): boolean {
  const header = req.headers["content-type"];
  if (typeof header !== "string") return false;
  const contentType = header.split(";", 1)[0];
  return (
    contentType !== undefined &&
    contentType.trim().toLowerCase() === "application/x-www-form-urlencoded"
  );
}

async function readBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<string | null> {
  const contentLength = req.headers["content-length"];
  if (typeof contentLength === "string") {
    const declaredLength = Number.parseInt(contentLength, 10);
    if (!Number.isFinite(declaredLength) || declaredLength < 0) {
      renderLogin(res, 400, "Invalid login request.");
      return null;
    }
    if (declaredLength > MAX_LOGIN_BODY_BYTES) {
      req.resume();
      renderLogin(res, 413, "Login request too large.");
      return null;
    }
  }

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      total += buffer.length;
      if (total > MAX_LOGIN_BODY_BYTES) {
        req.resume();
        renderLogin(res, 413, "Login request too large.");
        return null;
      }
      chunks.push(buffer);
    }
  } catch {
    renderLogin(res, 400, "Invalid login request.");
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    renderLogin(res, 400, "Invalid login request.");
    return null;
  }
}

function hasMalformedFormEncoding(body: string): boolean {
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== "%") continue;
    const pair = body.slice(index + 1, index + 3);
    if (!HEX_PAIR_PATTERN.test(pair)) return true;
    index += 2;
  }
  return false;
}

function registerFailure(
  peer: string,
  timestamp: number,
  throttles: Map<string, ThrottleRecord>,
): void {
  const existing = throttles.get(peer);
  const failures = (existing?.failures ?? 0) + 1;
  const lockedUntil = failures >= LOCKOUT_FAILURES ? timestamp + LOCKOUT_MS : 0;
  throttles.set(peer, { failures, lockedUntil });
}

function redirectToLogin(res: ServerResponse): void {
  res.writeHead(303, {
    "Cache-Control": "no-store",
    Location: "/login",
  });
  res.end();
}

function respondText(
  res: ServerResponse,
  status: number,
  message: string,
): void {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
  });
  res.end(`${message}\n`);
}

function renderLogin(
  res: ServerResponse,
  status: number,
  message = "",
  extraHeaders: Record<string, string> = {},
): void {
  const tone = status === 429 ? "warning" : status >= 400 ? "error" : "info";
  const feedback =
    message || "Enter the six-digit PIN shown in the server terminal.";
  const alertAttribute = tone === "info" ? "" : ' role="alert"';
  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>pi-rpc-web login</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0b14;
      --surface: #12121f;
      --surface-2: #171728;
      --border: #262640;
      --border-strong: #34345a;
      --text: #e8e6f0;
      --text-dim: #9a96b0;
      --text-faint: #6f6b85;
      --accent: #00e5ff;
      --accent-strong: #5cf0ff;
      --accent-ink: #001318;
      --magenta: #ff2ec4;
      --err: #ff3860;
      --warn: #ffb020;
      --font: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas,
        "Liberation Mono", monospace;
    }
    * {
      box-sizing: border-box;
    }
    html {
      width: 100%;
      background: var(--bg);
    }
    body {
      margin: 0;
      width: 100%;
      min-height: 100vh;
      min-height: 100dvh;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      padding: max(16px, env(safe-area-inset-top)) 16px
        max(16px, env(safe-area-inset-bottom)) 16px;
      overflow-x: hidden;
      background:
        radial-gradient(circle at top, rgba(92, 240, 255, 0.1), transparent 40%),
        linear-gradient(180deg, #12121f 0%, #0b0b14 52%, #090910 100%);
      color: var(--text);
      font-family: var(--font);
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background:
        radial-gradient(circle at center, transparent 58%, rgba(5, 5, 12, 0.52) 100%),
        linear-gradient(180deg, rgba(255, 46, 196, 0.05), transparent 32%);
    }
    .scanlines {
      position: fixed;
      inset: 0;
      pointer-events: none;
      background: repeating-linear-gradient(
        to bottom,
        rgba(0, 0, 0, 0.12) 0px,
        rgba(0, 0, 0, 0.12) 1px,
        transparent 1px,
        transparent 3px
      );
      opacity: 0.65;
    }
    .login-panel {
      position: relative;
      width: min(100%, 420px);
      padding: 24px 24px 22px;
      background: linear-gradient(180deg, rgba(23, 23, 40, 0.98), rgba(11, 11, 20, 0.98));
      border: 2px solid var(--accent);
      box-shadow:
        4px 4px 0 0 var(--magenta),
        0 18px 36px rgba(0, 0, 0, 0.48);
    }
    .login-panel::before {
      content: "";
      position: absolute;
      inset: 8px;
      border: 1px solid rgba(92, 240, 255, 0.12);
      pointer-events: none;
    }
    .login-panel > * {
      position: relative;
      min-width: 0;
    }
    .brand-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 0 0 14px;
    }
    .brand-mark {
      display: inline-block;
      width: 14px;
      height: 14px;
      flex: none;
      background: var(--accent);
      box-shadow:
        0 0 10px rgba(0, 229, 255, 0.35),
        4px 4px 0 0 var(--magenta);
      image-rendering: pixelated;
    }
    .brand-mark::after {
      content: "";
      display: block;
      width: 4px;
      height: 4px;
      margin: 5px auto;
      background: var(--accent-ink);
    }
    .brand {
      display: inline-flex;
      align-items: center;
      color: var(--accent);
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .brand span {
      color: var(--text-faint);
      font-weight: 400;
    }
    .brand i {
      display: inline-block;
      width: 8px;
      height: 14px;
      margin-left: 6px;
      background: var(--accent);
      animation: brand-blink 1.1s steps(1) infinite;
    }
    @keyframes brand-blink {
      50% {
        opacity: 0;
      }
    }
    h1,
    p,
    label,
    button {
      overflow-wrap: anywhere;
    }
    .eyebrow {
      margin: 0 0 10px;
      color: var(--text-faint);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 1.75rem;
      line-height: 1.1;
      letter-spacing: 0.02em;
    }
    .lede {
      margin: 0 0 16px;
      color: var(--text-dim);
    }
    .feedback {
      margin: 0 0 18px;
      padding: 10px 12px;
      border: 2px solid var(--border-strong);
      background: rgba(0, 0, 0, 0.18);
      box-shadow: inset 4px 0 0 0 var(--accent);
      color: var(--accent-strong);
    }
    .feedback.error {
      border-color: var(--err);
      background: rgba(255, 56, 96, 0.1);
      box-shadow: inset 4px 0 0 0 var(--magenta);
      color: #ffd6e6;
    }
    .feedback.warning {
      border-color: var(--warn);
      background: rgba(255, 176, 32, 0.1);
      box-shadow: inset 4px 0 0 0 var(--warn);
      color: #ffe0a6;
    }
    form {
      display: grid;
      gap: 10px;
    }
    label {
      display: block;
      color: var(--text-faint);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.11em;
      text-transform: uppercase;
    }
    input,
    button {
      width: 100%;
      min-height: 48px;
      border-radius: 0;
      font: inherit;
    }
    input {
      padding: 12px 14px;
      border: 2px solid var(--border-strong);
      background: #090910;
      color: var(--text);
      caret-color: var(--accent);
      letter-spacing: 0.18em;
    }
    input:focus-visible,
    button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    button {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 12px 16px;
      border: 2px solid var(--accent);
      background: var(--accent);
      color: var(--accent-ink);
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      cursor: pointer;
      box-shadow: 4px 4px 0 0 var(--magenta);
    }
    button span {
      font-size: 1rem;
      line-height: 1;
    }
    .network-note {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      margin: 16px 0 0;
      color: var(--text-faint);
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .network-note span {
      color: var(--accent);
    }
    @media (max-width: 420px) {
      body {
        align-items: stretch;
        padding-inline: 14px;
      }
      .login-panel {
        align-self: center;
        padding: 22px 18px;
      }
      h1 {
        font-size: clamp(1.35rem, 8vw, 1.7rem);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      *,
      *::before,
      *::after {
        animation: none !important;
      }
    }
  </style>
</head>
<body>
  <div class="scanlines" aria-hidden="true"></div>
  <main class="login-panel">
    <header class="brand-row">
      <span class="brand-mark" aria-hidden="true"></span>
      <span class="brand">pi<span>·rpc·web</span><i aria-hidden="true"></i></span>
    </header>
    <p class="eyebrow">RPC WEB ACCESS // PIN REQUIRED</p>
    <h1>Authorize browser</h1>
    <p class="lede">Enter the six-digit PIN displayed by the pi-rpc-web server.</p>
    <p class="feedback ${tone}"${alertAttribute}>${escapeHtml(feedback)}</p>
    <form method="post" action="/login">
      <label for="pin">Access PIN</label>
      <input id="pin" name="pin" type="text" inputmode="numeric" autocomplete="one-time-code" enterkeyhint="done" maxlength="7" required autofocus>
      <button type="submit"><span aria-hidden="true">▸</span> Unlock pi-rpc-web</button>
    </form>
    <p class="network-note"><span aria-hidden="true">■</span> Trusted local network only</p>
  </main>
</body>
</html>`;
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "text/html; charset=utf-8",
    ...extraHeaders,
  });
  res.end(body);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
