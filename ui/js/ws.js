/* WebSocket transport: hello handshake, RPC/meta request correlation,
 * exponential-backoff reconnect, child-lifecycle + agent event fan-out.
 *
 * Outgoing frames are JSON objects, one per text frame:
 *   {type:"hello", ...options}          -> {type:"hello", ok:true|false}
 *   {id, type:"<rpc-command>", ...}     -> {type:"response", id, success, data?, error?}
 *   {type:"meta", id, action, ...}      -> {type:"meta", id, ok, data?, error?}
 *   raw passthrough (e.g. extension_ui_response) is sent verbatim.
 */

const MAX_BACKOFF_MS = 15000;
const BASE_BACKOFF_MS = 500;

export class RpcSocket {
  constructor() {
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map(); // rpc response correlation
    this.metaPending = new Map(); // meta reply correlation
    this.handlers = new Map();
    this.helloOptions = {};
    this.attempt = 0;
    this.manualClose = false;
    this.reconnectTimer = null;
    this.everConnected = false;
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) {
    const list = this.handlers.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  emit(type, payload) {
    for (const fn of [...(this.handlers.get(type) || [])]) {
      try {
        fn(payload);
      } catch (err) {
        console.error("[socket handler]", type, err);
      }
    }
  }

  /** Set options merged into the hello frame (session, cwd, model…). */
  configure(options) {
    // Merge over previous options: respawn/delete flows tweak individual
    // keys (e.g. session) while keeping boot-time params like provider/model.
    this.helloOptions = { ...this.helloOptions, ...options };
  }

  connect() {
    this.manualClose = false;
    clearTimeout(this.reconnectTimer);
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/`;
    this.emit("connecting");
    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      // Hello must be the first message before anything is forwarded.
      this._send({ type: "hello", ...this.helloOptions });
    };
    ws.onmessage = (ev) => this._onMessage(ev);
    ws.onclose = () => {
      this._failAllPending("Connection closed");
      this.ws = null;
      this.emit("disconnected");
      if (!this.manualClose) this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* close event always follows */
    };
  }

  scheduleReconnect() {
    const delay = Math.min(
      MAX_BACKOFF_MS,
      BASE_BACKOFF_MS * 2 ** this.attempt++,
    );
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.emit("reconnect-scheduled", { delay, attempt: this.attempt });
  }

  forceReconnect() {
    if (this.ws) {
      this.manualClose = true;
      try {
        this.ws.close();
      } catch {
        /* noop */
      }
      this.ws = null;
    }
    clearTimeout(this.reconnectTimer);
    this.connect();
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  /** Send an RPC command; resolves with `data` on success. */
  request(cmd, { timeoutMs = 180000 } = {}) {
    return this._correlate(this.pending, { ...cmd }, timeoutMs);
  }

  /** Send a meta action; resolves with `data`. */
  meta(action, params = {}, { timeoutMs = 30000 } = {}) {
    return this._correlate(
      this.metaPending,
      { type: "meta", action, ...params },
      timeoutMs,
    );
  }

  /** Raw passthrough frame without local correlation (extension_ui_response). */
  raw(obj) {
    this._send(obj);
  }

  /**
   * Fire-and-forget RPC send with an id (so success:false responses still
   * surface via the global 'rpc-error' handler) but no local correlation.
   * Used for `prompt`, whose response only arrives when the whole turn ends.
   * Returns false when the socket is not open.
   */
  fire(cmd) {
    const msg = { ...cmd, id: `q${this.nextId++}` };
    return this._send(msg);
  }

  _correlate(store, msg, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected"));
        return;
      }
      const id = `q${this.nextId++}`;
      msg.id = id;
      const entry = {
        resolve,
        reject,
        timer: setTimeout(() => {
          store.delete(id);
          reject(new Error("Request timed out"));
        }, timeoutMs),
      };
      store.set(id, entry);
      if (!this._send(msg)) {
        store.delete(id);
        clearTimeout(entry.timer);
        reject(new Error("Not connected"));
      }
    });
  }

  _failAllPending(reason) {
    this._failAllRpcPending(reason);
    for (const [, e] of this.metaPending) {
      clearTimeout(e.timer);
      e.reject(new Error(reason));
    }
    this.metaPending.clear();
  }

  /** Reject only RPC-correlated requests; meta actions don't need the child. */
  _failAllRpcPending(reason) {
    for (const [, e] of this.pending) {
      clearTimeout(e.timer);
      e.reject(new Error(reason));
    }
    this.pending.clear();
  }

  _onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    switch (msg.type) {
      case "hello": {
        if (msg.ok) {
          this.everConnected = true;
          this.emit("hello-ok", msg);
        } else {
          this.emit("hello-fail", msg);
          // Hard failure (spawn error etc.) — stop hammering; user can retry
          // from the banner. Close so onclose doesn't loop reconnects.
          this.manualClose = true;
          try {
            this.ws?.close();
          } catch {
            /* noop */
          }
        }
        break;
      }
      case "meta": {
        const e = this.metaPending.get(msg.id);
        if (e) {
          this.metaPending.delete(msg.id);
          clearTimeout(e.timer);
          if (msg.ok) e.resolve(msg.data);
          else e.reject(new Error(msg.error || "Meta request failed"));
        } else {
          console.warn("[meta] unmatched reply", msg.id);
        }
        break;
      }
      case "response": {
        const e = msg.id == null ? null : this.pending.get(msg.id);
        if (msg.success === false) this.emit("rpc-error", msg);
        if (e) {
          this.pending.delete(msg.id);
          clearTimeout(e.timer);
          if (msg.success === false)
            e.reject(
              new Error(msg.error || `${msg.command || "command"} failed`),
            );
          else e.resolve(msg.data === undefined ? {} : msg.data);
        }
        break;
      }
      case "child": {
        // A dead child will never answer in-flight commands — fail them now
        // so callers surface errors instead of hanging until timeout.
        if (msg.event === "exit" || msg.event === "spawn-error") {
          this._failAllRpcPending(
            msg.event === "exit"
              ? `Agent process exited${msg.code == null ? "" : ` (code ${msg.code})`}`
              : "Agent failed to start",
          );
        }
        this.emit("child", msg);
        break;
      }
      default:
        // Agent events: agent_start/end/settled, message_*, tool_execution_*,
        // queue_update, compaction_*, auto_retry_*, extension_ui_request, …
        this.emit("event", msg);
    }
  }
}
