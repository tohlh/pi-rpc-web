/* Composer: auto-growing textarea, Enter/Shift+Enter, image attachments
 * (picker + paste + drag-drop -> base64 ImageContent), slash-command
 * autocomplete from get_commands, steer/follow-up mode chip while streaming,
 * Stop -> abort, pending queue chips from queue_update.
 */

import { el, qs, truncate } from "./util.js";

let app = null;
let ta = null;
let hintEl = null;
let sendBtn = null;
let stopBtn = null;
let attachBtn = null;
let fileInput = null;
let thumbsEl = null;
let modeChip = null;
let acEl = null;

let images = []; // {data: base64, mimeType, fileName}
let mode = "steer"; // 'steer' | 'followUp'

let acOpen = false;
let acItems = [];
let acIndex = 0;

export function init(a) {
  app = a;
  ta = qs("#input");
  hintEl = qs("#input-hint");
  sendBtn = qs("#btn-send");
  stopBtn = qs("#btn-stop");
  attachBtn = qs("#btn-attach");
  fileInput = qs("#file-input");
  thumbsEl = qs("#attachments");
  modeChip = qs("#mode-chip");
  acEl = qs("#autocomplete");

  ta.addEventListener("keydown", onKeyDown);
  ta.setAttribute("aria-controls", "autocomplete");
  ta.setAttribute("aria-autocomplete", "list");
  ta.addEventListener("input", () => {
    autosize();
    syncHint();
    updateAC();
    updateSendState();
  });
  ta.addEventListener("paste", onPaste);

  attachBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    addFiles([...fileInput.files]);
    fileInput.value = "";
  });

  sendBtn.addEventListener("click", send);
  stopBtn.addEventListener("click", doAbort);

  // Project gate: until a project/session is chosen, hide the composer so the
  // landing page stays focused on choosing a project.
  const area = qs("#composer-area");
  const gate = qs("#composer");
  gate.addEventListener("click", () => {
    if (!app.state.projectChosen) app.emit("open-project-picker");
  });
  ta.addEventListener("focus", () => {
    if (!app.state.projectChosen) app.emit("open-project-picker");
  });
  app.on("state", syncGate);

  function syncGate() {
    const chosen = !!app.state.projectChosen;
    ta.readOnly = !chosen;
    area.hidden = !chosen;
    gate.classList.toggle("gated", !chosen);
    const hint = chosen
      ? "Message pi\u2026"
      : "Pick a project to start chatting\u2026";
    ta.placeholder = hint;
    hintEl.textContent = hint;
    syncHint();
  }
  syncGate();
  modeChip.addEventListener("click", () => {
    mode = mode === "steer" ? "followUp" : "steer";
    renderChip();
  });

  // Drag & drop images onto the composer.
  area.addEventListener("dragover", (e) => {
    if ([...(e.dataTransfer?.types || [])].includes("Files")) {
      e.preventDefault();
      area.classList.add("dragging");
    }
  });
  area.addEventListener("dragleave", () => area.classList.remove("dragging"));
  area.addEventListener("drop", (e) => {
    e.preventDefault();
    area.classList.remove("dragging");
    addFiles([...(e.dataTransfer?.files || [])]);
  });

  app.on("stream", updateSendState);
  app.on("queue", renderQueue);
  app.on("editor-text", (text) => setText(text));

  autosize();
  updateSendState();
  renderChip();
}

/* ------------------------------------------------------------------ */
/* Sending                                                             */
/* ------------------------------------------------------------------ */

async function send() {
  const text = ta.value.trim();
  if (!text && !images.length) return;
  if (!app.state.ready) return;
  if (!app.state.projectChosen) {
    app.toast(
      "Pick a project first \u2014 use + New chat in the sidebar",
      "warning",
    );
    app.emit("open-project-picker");
    return;
  }

  let cmd;
  if (app.state.isStreaming) {
    // Agent busy: queue via streamingBehavior (rpc.md "prompt").
    cmd = { type: "prompt", message: text, streamingBehavior: mode };
  } else {
    cmd = { type: "prompt", message: text };
  }
  if (images.length) {
    cmd.images = images.map((i) => ({
      type: "image",
      data: i.data,
      mimeType: i.mimeType,
    }));
  }

  // Fire-and-forget: the prompt response only arrives when the whole turn
  // completes, so correlating it would time out (and risk double-send) on
  // long turns. RPC failures still surface via the global rpc-error handler
  // because the frame carries an id.
  if (!app.socket.fire(cmd)) {
    app.toast("Not connected", "error");
    return;
  }
  clearComposer();
  ta.focus();
}

function syncHint() {
  hintEl.hidden = ta.value.length > 0;
}

function clearComposer() {
  ta.value = "";
  autosize();
  syncHint();
  clearImages();
  hideAC();
}

async function doAbort() {
  if (!app.state.ready) return; // avoid a spurious "Not connected" toast
  try {
    await app.request({ type: "abort" }, { timeoutMs: 10000 });
  } catch (err) {
    app.toast(err.message, "error");
  }
}

function updateSendState() {
  const streaming = !!app.state.isStreaming;
  stopBtn.hidden = !streaming;
  sendBtn.hidden = streaming;
  modeChip.hidden = !streaming;
  sendBtn.disabled = !app.state.ready || (!ta.value.trim() && !images.length);
  sendBtn.setAttribute(
    "aria-label",
    streaming ? "Queue message" : "Send message",
  );
}

function renderChip() {
  if (mode === "steer") {
    modeChip.innerHTML = "&#9654; Steer";
    modeChip.title =
      "Queued: delivered after current tool calls finish (before the next model call)";
  } else {
    modeChip.innerHTML = "&#9193; Follow-up";
    modeChip.title = "Queued: delivered only when the agent finishes";
  }
}

export function setText(text) {
  ta.value = String(text ?? "");
  autosize();
  syncHint();
  updateSendState();
  hideAC();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

/* ------------------------------------------------------------------ */
/* Keyboard                                                            */
/* ------------------------------------------------------------------ */

function onKeyDown(e) {
  if (acOpen) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      acIndex = (acIndex + 1) % acItems.length;
      renderAC();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      acIndex = (acIndex - 1 + acItems.length) % acItems.length;
      renderAC();
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      completeAC(acItems[acIndex]);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      hideAC();
      return;
    }
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
}

/* ------------------------------------------------------------------ */
/* Slash-command autocomplete                                          */
/* ------------------------------------------------------------------ */

function updateAC() {
  const v = ta.value;
  if (v.startsWith("/") && !/\s/.test(v.slice(1))) {
    const q = v.slice(1).toLowerCase();
    acItems = (app.state.commands || [])
      .filter((c) => c.name && c.name.toLowerCase().includes(q))
      .slice(0, 12);
  } else {
    acItems = [];
  }
  if (!acItems.length) {
    hideAC();
    return;
  }
  acIndex = Math.min(acIndex, acItems.length - 1);
  renderAC();
}

const SRC_LABEL = { extension: "ext", prompt: "template", skill: "skill" };

function renderAC() {
  acEl.textContent = "";
  acEl.hidden = false;
  acOpen = true;
  ta.setAttribute("aria-expanded", "true");
  ta.setAttribute("aria-activedescendant", `ac-opt-${acIndex}`);
  acItems.forEach((c, i) => {
    const item = el(
      "button",
      {
        type: "button",
        id: `ac-opt-${i}`,
        class: "ac-item" + (i === acIndex ? " sel" : ""),
        role: "option",
        "aria-selected": String(i === acIndex),
        onmouseenter: () => selectACItem(i),
        onclick: () => completeAC(c),
      },
      el("span", { class: "ac-name" }, "/" + c.name),
      c.description
        ? el("span", { class: "ac-desc" }, truncate(c.description, 72))
        : null,
      el(
        "span",
        { class: `ac-src src-${c.source || "extension"}` },
        SRC_LABEL[c.source] || c.source || "ext",
      ),
    );
    acEl.append(item);
  });
}

function selectACItem(index) {
  acIndex = index;
  const items = [...acEl.querySelectorAll(".ac-item")];
  items.forEach((item, i) => {
    const selected = i === index;
    item.classList.toggle("sel", selected);
    item.setAttribute("aria-selected", String(selected));
  });
  ta.setAttribute("aria-activedescendant", `ac-opt-${index}`);
}

function completeAC(c) {
  if (!c) return;
  ta.value = "/" + c.name + " ";
  hideAC();
  autosize();
  syncHint();
  updateSendState();
  ta.focus();
}

function hideAC() {
  acOpen = false;
  acItems = [];
  acEl.hidden = true;
  acEl.textContent = "";
  ta.setAttribute("aria-expanded", "false");
  ta.removeAttribute("aria-activedescendant");
}

/* ------------------------------------------------------------------ */
/* Images                                                              */
/* ------------------------------------------------------------------ */

async function detectSupportedImageMime(file) {
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  const ascii = String.fromCharCode(...bytes);
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) {
    return "image/gif";
  }
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

function readBlobData(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const comma = dataUrl.indexOf(",");
      if (comma < 0) reject(new Error("Invalid image data"));
      else resolve(dataUrl.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error || new Error("Read failed"));
    reader.readAsDataURL(blob);
  });
}

async function transcodeImageToJpeg(file) {
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("Browser could not decode image"));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }

  const maxEdge = 4096;
  const scale = Math.min(
    1,
    maxEdge / Math.max(image.naturalWidth, image.naturalHeight),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image conversion is unavailable");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("Image conversion failed");
  return dataUrl.slice(comma + 1);
}

async function normalizeImageOnServer(file) {
  const response = await fetch("/api/image/normalize", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Pi-Rpc-Web-Image": "1",
    },
    body: file,
  });
  if (!response.ok) throw new Error("Server could not convert image");
  const jpeg = await response.blob();
  if ((await detectSupportedImageMime(jpeg)) !== "image/jpeg") {
    throw new Error("Server returned invalid image data");
  }
  return readBlobData(jpeg);
}

async function prepareImage(file) {
  let data;
  try {
    data = await transcodeImageToJpeg(file);
  } catch {
    data = await normalizeImageOnServer(file);
  }
  return {
    data,
    mimeType: "image/jpeg",
    fileName: file.name,
  };
}

function addFiles(files) {
  for (const f of files) {
    const looksLikeImage =
      f &&
      (f.type.startsWith("image/") ||
        /\.(?:avif|bmp|heic|heif|jpe?g|png|gif|tiff?|webp|svg)$/i.test(f.name));
    if (!looksLikeImage) continue;
    if (f.size > 12 * 1024 * 1024) {
      app.toast(`"${f.name}" is too large (max 12 MB)`, "warning");
      continue;
    }
    prepareImage(f)
      .then((image) => {
        images.push(image);
        renderThumbs();
        updateSendState();
      })
      .catch(() => {
        app.toast(
          `Could not convert "${f.name}". Use JPEG, PNG, GIF, or WebP.`,
          "error",
        );
      });
  }
}

function onPaste(e) {
  const files = [...(e.clipboardData?.files || [])].filter((f) =>
    f.type.startsWith("image/"),
  );
  if (files.length) {
    e.preventDefault();
    addFiles(files);
  }
}

function renderThumbs() {
  thumbsEl.textContent = "";
  thumbsEl.hidden = images.length === 0;
  images.forEach((img, i) => {
    const thumb = el(
      "div",
      { class: "attach-thumb" },
      el("img", {
        src: `data:${img.mimeType};base64,${img.data}`,
        alt: img.fileName || "image",
      }),
      el(
        "button",
        {
          type: "button",
          class: "attach-remove",
          "aria-label": `Remove ${img.fileName || "image"}`,
          onclick: () => {
            images.splice(i, 1);
            renderThumbs();
            updateSendState();
          },
        },
        "\u00d7",
      ),
    );
    thumbsEl.append(thumb);
  });
}

function clearImages() {
  images = [];
  renderThumbs();
  updateSendState();
}

/* ------------------------------------------------------------------ */
/* Queue chips                                                         */
/* ------------------------------------------------------------------ */

function renderQueue() {
  const box = qs("#queue-chips");
  box.textContent = "";
  const q = app.state.queue || {};
  const items = [
    ...(q.steering || []).map((t) => ({ t, kind: "steer" })),
    ...(q.followUp || []).map((t) => ({ t, kind: "follow-up" })),
  ];
  if (!items.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  items.slice(0, 4).forEach((it) => {
    box.append(
      el(
        "span",
        { class: `queue-chip ${it.kind}` },
        el(
          "span",
          { class: "queue-kind" },
          it.kind === "steer" ? "\u25b8 steer" : "\u23ed follow-up",
        ),
        " " + truncate(it.t, 60),
      ),
    );
  });
  if (items.length > 4) {
    box.append(
      el("span", { class: "queue-chip more" }, `+${items.length - 4} queued`),
    );
  }
}

/* ------------------------------------------------------------------ */

function autosize() {
  ta.style.height = "auto";
  ta.style.height =
    Math.min(ta.scrollHeight, Math.round(window.innerHeight * 0.4)) + "px";
}
