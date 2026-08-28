/* Bootstrap: app state store, event router, snapshot on hello, banner
 * (disconnected / child exited), RPC error toasts, copy-button delegation.
 */

import { el, qs, truncate, fmtTokens } from "./util.js";
import { RpcSocket } from "./ws.js";
import * as render from "./render.js";
import * as composer from "./composer.js";
import * as sidebar from "./sidebar.js";
import * as header from "./header.js";
import * as dialogs from "./dialogs.js";

/* ------------------------------------------------------------------ */
/* State + pub/sub                                                     */
/* ------------------------------------------------------------------ */

const listeners = new Map();

const state = {
  ready: false,
  projectChosen: false,
  projectPath: null,
  isStreaming: false,
  isCompacting: false,
  model: null,
  thinkingLevel: "medium",
  thinkingLevels: [],
  messages: [],
  models: [],
  commands: [],
  stats: null,
  queue: { steering: [], followUp: [] },
  sessionFile: null,
  sessionId: null,
  sessionName: null,
  childDown: false,
};

function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, []);
  listeners.get(type).push(fn);
}

function emit(type, payload) {
  for (const fn of [...(listeners.get(type) || [])]) {
    try {
      fn(payload);
    } catch (err) {
      console.error("[app]", type, err);
    }
  }
}

const socket = new RpcSocket();

const app = {
  state,
  on,
  emit,
  socket,
  request: (cmd, opts) => socket.request(cmd, opts),
  meta: (action, params) => socket.meta(action, params),
  toast: dialogs.toast,
  snapshot,
};

/* ------------------------------------------------------------------ */
/* Banner                                                              */
/* ------------------------------------------------------------------ */

let bannerAction = null;
let autoRestartTimer = 0;

function showBanner(text, action) {
  const b = qs("#banner");
  if (!text) {
    b.hidden = true;
    b.replaceChildren();
    bannerAction = null;
    return;
  }
  bannerAction = action || null;
  b.replaceChildren(
    el("span", { class: "banner-text" }, text),
    action
      ? el(
          "button",
          {
            type: "button",
            class: "btn small",
            onclick: () => {
              if (bannerAction) bannerAction.fn();
            },
          },
          action.label,
        )
      : null,
  );
  b.hidden = false;
  b.className = "banner" + (action ? " actionable" : "");
}

function restartChild() {
  clearTimeout(autoRestartTimer);
  showBanner(null);
  state.childDown = false;
  // Any passthrough message respawns the child with the same hello options.
  // The server now answers with success:false when respawn fails (and emits
  // spawn-error), so this cannot hang until the full request timeout.
  socket
    .request({ type: "get_state" }, { timeoutMs: 15000 })
    .then(() => snapshot())
    .catch(() => {
      /* banner already reflects the failure via spawn-error */
    });
}

/* ------------------------------------------------------------------ */
/* Snapshot                                                            */
/* ------------------------------------------------------------------ */

let snapshotSeq = 0;

async function snapshot() {
  const seq = ++snapshotSeq;
  try {
    const [st, msgs, models, levels, commands, stats] = await Promise.all([
      socket.request({ type: "get_state" }),
      socket.request({ type: "get_messages" }),
      socket.request({ type: "get_available_models" }),
      socket.request({ type: "get_available_thinking_levels" }),
      socket.request({ type: "get_commands" }),
      socket.request({ type: "get_session_stats" }),
    ]);
    if (seq !== snapshotSeq) return; // a newer snapshot superseded this one

    Object.assign(state, {
      model: st.model ?? null,
      thinkingLevel: st.thinkingLevel ?? state.thinkingLevel,
      isStreaming: !!st.isStreaming,
      isCompacting: !!st.isCompacting,
      sessionFile: st.sessionFile ?? null,
      sessionId: st.sessionId ?? null,
      sessionName: st.sessionName ?? null,
      messages: Array.isArray(msgs.messages) ? msgs.messages : [],
      models: Array.isArray(models.models) ? models.models : [],
      thinkingLevels: Array.isArray(levels.levels) ? levels.levels : ["off"],
      commands: Array.isArray(commands.commands) ? commands.commands : [],
      stats: stats ?? null,
    });

    render.resetLive();
    render.renderAll(state.messages);
    if (!state.projectChosen) {
      render.chatPlaceholder(
        "Pick a project to start chatting\u2026 (sidebar \u2192 + New chat)",
      );
    }
    emit("state");
    emit("stream");
    emit("stats");
  } catch (err) {
    if (seq === snapshotSeq)
      app.toast(`Snapshot failed: ${err.message}`, "error");
  }
}

async function refreshStats() {
  try {
    const stats = await socket.request({ type: "get_session_stats" });
    state.stats = stats ?? null;
    emit("stats");
  } catch {
    /* non-fatal */
  }
}

/* ------------------------------------------------------------------ */
/* Event router                                                        */
/* ------------------------------------------------------------------ */

socket.on("event", handleEvent);

function handleEvent(ev) {
  switch (ev.type) {
    case "agent_start":
      state.isStreaming = true;
      emit("stream");
      break;

    case "agent_end":
      // willRetry / queued continuations keep us streaming until settled.
      break;

    case "agent_settled":
      state.isStreaming = false;
      state.isCompacting = false;
      emit("stream");
      refreshStats();
      break;

    case "message_start":
      render.beginMessage(ev.message);
      break;

    case "message_update": {
      if (ev.usage && ev.usage.output) {
        // Light live feedback only; authoritative totals come from stats.
        emit("usage", ev.usage);
      }
      render.applyDelta(ev);
      break;
    }

    case "message_end":
      render.endMessage(ev.message);
      if (
        ev.message?.stopReason === "error" &&
        /image data you provided does not represent a valid image/i.test(
          ev.message.errorMessage || "",
        )
      ) {
        render.systemNotice(
          "This session contains an invalid image in its history. Start a clean chat before uploading again; the existing session remains saved in the sidebar.",
          "error",
          [
            {
              label: "Start clean chat",
              onClick: () => sidebar.startCleanChat(),
            },
          ],
        );
      }
      break;

    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      render.toolEvent(ev);
      break;

    case "queue_update":
      state.queue = {
        steering: Array.isArray(ev.steering) ? ev.steering : [],
        followUp: Array.isArray(ev.followUp) ? ev.followUp : [],
      };
      emit("queue");
      break;

    case "compaction_start":
      state.isCompacting = true;
      emit("stream");
      render.systemNotice(
        `Compacting context (${ev.reason || "manual"})\u2026`,
        "busy",
      );
      break;

    case "compaction_end": {
      state.isCompacting = false;
      emit("stream");
      let text;
      let kind;
      if (ev.aborted) {
        text = "Compaction aborted";
        kind = "warn";
      } else if (ev.result) {
        text = `Context compacted \u00b7 ${fmtTokens(ev.result.tokensBefore)} \u2192 ~${fmtTokens(ev.result.estimatedTokensAfter)} tokens`;
        kind = "ok";
      } else {
        text = `Compaction failed${ev.errorMessage ? `: ${truncate(ev.errorMessage, 200)}` : ""}`;
        kind = "error";
      }
      render.systemNotice(text, kind);
      refreshStats();
      break;
    }

    case "auto_retry_start":
      render.systemNotice(
        `Transient error \u2014 retrying (${ev.attempt}/${ev.maxAttempts}) in ${Math.round((ev.delayMs || 0) / 1000)}s` +
          (ev.errorMessage ? ` \u00b7 ${truncate(ev.errorMessage, 140)}` : ""),
        "warn",
      );
      break;

    case "auto_retry_end":
      render.systemNotice(
        ev.success
          ? `Retry succeeded (attempt ${ev.attempt})`
          : `Retry failed after ${ev.attempt} attempts${ev.finalError ? `: ${truncate(ev.finalError, 160)}` : ""}`,
        ev.success ? "ok" : "error",
      );
      break;

    case "summarization_retry_scheduled":
      render.systemNotice(
        `Summarization retry scheduled (${ev.attempt}/${ev.maxAttempts})`,
        "warn",
      );
      break;

    case "extension_error":
      app.toast(
        `Extension error (${ev.event}): ${truncate(ev.error, 200)}`,
        "error",
      );
      break;

    case "extension_ui_request":
      dialogs.handleExtensionUI(ev);
      break;

    default:
      // turn_start/turn_end, bash_execution_update (direct RPC bash), etc.
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Socket lifecycle                                                    */
/* ------------------------------------------------------------------ */

socket.on("hello-ok", async () => {
  state.ready = true;
  state.childDown = false;
  showBanner(null);
  emit("conn");
  await snapshot();
  sidebar.refresh();
});

socket.on("connecting", () => {
  render.chatPlaceholder("Connecting\u2026");
});

socket.on("hello-fail", (msg) => {
  state.ready = false;
  emit("conn");
  showBanner(
    `Could not start agent: ${truncate(msg.error || "unknown error", 200)}`,
    { label: "Retry", fn: () => socket.forceReconnect() },
  );
});

socket.on("disconnected", () => {
  state.ready = false;
  state.isStreaming = false;
  emit("conn");
  emit("stream");
  showBanner("Connection lost \u2014 reconnecting\u2026");
});

socket.on("reconnect-scheduled", () => {
  /* banner already shown */
});

socket.on("child", (msg) => {
  if (msg.event === "exit") {
    state.childDown = true;
    const why =
      msg.code == null
        ? msg.signal
          ? `signal ${msg.signal}`
          : ""
        : `code ${msg.code}`;
    showBanner(`Agent process exited${why ? ` (${why})` : ""} — restarting…`, {
      label: "Restart now",
      fn: restartChild,
    });
    // Auto-recover: in-flight requests were already failed by the socket
    // layer; bring a fresh child up and resnapshot without user action.
    clearTimeout(autoRestartTimer);
    autoRestartTimer = setTimeout(restartChild, 800);
  } else if (msg.event === "spawn-error") {
    state.childDown = true;
    showBanner(
      `Agent failed to start: ${truncate(msg.error || "unknown error", 200)}`,
      { label: "Retry", fn: restartChild },
    );
  } else if (msg.event === "error") {
    app.toast(`Agent stream error: ${truncate(msg.error || "", 200)}`, "error");
  }
});

socket.on("rpc-error", (res) => {
  app.toast(
    `${res.command || "Request"} failed: ${res.error || "unknown error"}`,
    "error",
  );
});

// Tab becoming visible again: reconnect immediately instead of waiting out
// the backoff timer.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !state.ready && socket.ws === null) {
    clearTimeout(socket.reconnectTimer);
    socket.connect();
  }
});

/* ------------------------------------------------------------------ */
/* Global delegation                                                   */
/* ------------------------------------------------------------------ */

document.addEventListener("click", (e) => {
  const btn = e.target.closest?.(".copy-btn");
  if (!btn) return;
  const block = btn.closest(".code-block");
  const code = block ? block.querySelector("code") : null;
  const text = code ? code.textContent : "";
  const done = () => {
    btn.textContent = "Copied!";
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = "Copy";
      btn.classList.remove("copied");
    }, 1200);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(text)
      .then(done, () => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
});

function fallbackCopy(text, done) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.append(ta);
  ta.select();
  try {
    document.execCommand("copy");
    done();
  } catch {
    /* noop */
  }
  ta.remove();
}

/* ------------------------------------------------------------------ */
/* Working bar (chat dialogue)                                         */
/* ------------------------------------------------------------------ */

function updateWorkingBar() {
  const bar = document.getElementById("working-bar");
  if (!bar) return;
  const label = bar.querySelector(".wb-label");
  const web = !!state.isStreaming && !!state.ready;
  if (!web) {
    bar.hidden = true;
    return;
  }
  if (label) label.textContent = "pi is working\u2026";
  bar.hidden = false;
}
app.on("stream", updateWorkingBar);
app.on("conn", updateWorkingBar);

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

render.init(app);
header.init(app);
composer.init(app);
sidebar.init(app);
dialogs.init(app);

// Hello options from the URL (?session=… for cold resume from the sidebar).
const params = new URLSearchParams(location.search);
const helloOptions = {};
for (const k of [
  "cwd",
  "session",
  "sessionDir",
  "name",
  "provider",
  "model",
  "thinking",
]) {
  const v = params.get(k);
  if (v) helloOptions[k] = v;
}
if (helloOptions.session) {
  document.title = "pi \u00b7 resuming session";
}
socket.configure(helloOptions);
// Composer stays gated until the user explicitly picks a project/session,
// so a stray message can never create a session in an arbitrary folder.
state.projectChosen = Boolean(helloOptions.session || helloOptions.cwd);
socket.connect();
