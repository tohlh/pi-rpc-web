/* Sidebar: new chat, session listing (meta sessions.list), cold-respawn
 * session switching with confirm-while-busy, rename via set_session_name
 * (current session only), "open in new tab" cold-resume via hello
 * `session` param.
 */

import { el, qs, relTime, basename } from "./util.js";
import { openModal, inputModal } from "./dialogs.js";

let app = null;
let listEl = null;
let currentProject = null; // cwd string of the running agent
let knownProjects = []; // [{ project, sessions }] from the last listing
// Projects hidden from the sidebar (view-only; session files stay on disk).
const HIDDEN_KEY = "pi-rpc-web.hidden-projects";
const LEGACY_HIDDEN_KEY = "pi-remote.hidden-projects";
const hiddenProjects = new Set(
  (() => {
    try {
      const stored =
        localStorage.getItem(HIDDEN_KEY) ??
        localStorage.getItem(LEGACY_HIDDEN_KEY) ??
        "[]";
      const v = JSON.parse(stored);
      const projects = Array.isArray(v)
        ? v.filter((x) => typeof x === "string")
        : [];
      if (localStorage.getItem(HIDDEN_KEY) === null && projects.length) {
        localStorage.setItem(HIDDEN_KEY, JSON.stringify(projects));
      }
      return projects;
    } catch {
      return [];
    }
  })(),
);

function persistHidden() {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hiddenProjects]));
  } catch {
    /* storage unavailable */
  }
}
// Temporary section for a newly-added project ("New project…" flow): shows
// the brand-new session at the top until its file exists on disk (first
// message) or the user switches away. Never applies to existing projects.
let tempNewProject = null;
let tempSessionPath = null;

export function init(a) {
  app = a;
  listEl = qs("#sessions");
  qs("#btn-new").addEventListener("click", openNewChatMenu);
  qs("#btn-refresh-sessions").addEventListener("click", refresh);
  const hiddenChip = document.getElementById("hidden-projects");
  if (hiddenChip) {
    hiddenChip.addEventListener("click", () => openHiddenPopover(hiddenChip));
  }
  qs("#sidebar-backdrop").addEventListener("click", closeMobile);
  document.addEventListener("keydown", (e) => {
    if (
      e.key === "Escape" &&
      document.body.classList.contains("sidebar-open")
    ) {
      closeMobile();
    }
  });
  app.on("state", highlightCurrent);
  app.on("stream", updateWorkingIndicator);
  app.on("open-project-picker", () => openNewChatPicker());
  app.on("conn", () => {
    updateWorkingIndicator();
    loadProjectInfo();
  });
}

export function closeMobile() {
  document.body.classList.remove("sidebar-open");
  const menu = document.getElementById("btn-menu");
  if (menu) menu.setAttribute("aria-expanded", "false");
}

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

function normalizeSessions(data) {
  // Defensive: contract allows a flat array or grouped-by-project shapes.
  // NOTE: check grouped `projects` BEFORE flat `sessions` — a grouped reply
  // may carry an (empty) top-level sessions array that must not shadow it.
  let rows = [];
  if (Array.isArray(data)) {
    rows = data;
  } else if (data && Array.isArray(data.projects)) {
    for (const p of data.projects) {
      const proj = p && (p.project ?? p.cwd ?? "");
      for (const s of p.sessions || [])
        rows.push({ ...s, project: s.project || proj });
    }
  } else if (data && Array.isArray(data.sessions)) {
    rows = data.sessions.map((s) => ({
      ...s,
      project: s.project || s.cwd || "",
    }));
  }
  return rows.filter((s) => s && typeof s.path === "string");
}

export async function refresh() {
  let data;
  try {
    data = await app.meta("sessions.list");
  } catch {
    return; // silent: sidebar is secondary
  }
  knownProjects = Array.isArray(data.projects)
    ? data.projects.map((p) => ({ project: p.project, sessions: p.sessions }))
    : [];
  renderList(normalizeSessions(data));
  updateProjectLine();
  updateHiddenChip();
}

/** Which project folder the running agent is rooted in. */
async function loadProjectInfo() {
  try {
    const info = await app.meta("project.info");
    currentProject = info && info.cwd ? info.cwd : null;
  } catch {
    currentProject = null;
  }
  app.state.projectPath = currentProject;
  app.emit("project");
  updateProjectLine();
}

function updateProjectLine() {
  const el2 = document.getElementById("project-line");
  if (!el2) return;
  const name = currentProject ? basename(currentProject) : "\u2026";
  el2.textContent = name;
  el2.title = currentProject || "";
  el2.hidden = !currentProject;
}

/** New chat = pick a project, then cold-start a fresh agent there. */
function openNewChatMenu(e) {
  if (e && e.preventDefault) e.preventDefault();
  closeMobile();
  closeContextMenu();
  closeNewChatMenu();
  const menu = el("div", {
    class: "ctx-menu",
    role: "menu",
    "aria-label": "New chat in project",
  });
  menu.append(el("div", { class: "ctx-group" }, "NEW CHAT IN"));
  const projects = [];
  if (currentProject) projects.push(currentProject);
  for (const cwd of rememberedProjects()) {
    if (!projects.includes(cwd)) projects.push(cwd);
  }
  for (const p of knownProjects) {
    if (p.project && !projects.includes(p.project)) projects.push(p.project);
  }
  if (!projects.length) projects.push(null); // unknown: default cwd
  for (const proj of projects) {
    menu.append(
      el(
        "button",
        {
          type: "button",
          class: "ctx-item",
          role: "menuitem",
          title: proj || "",
          onclick: () => {
            closeNewChatMenu();
            startChatIn(proj);
          },
        },
        proj ? basename(proj) : "default",
      ),
    );
  }
  menu.append(el("div", { class: "ctx-sep" }));
  menu.append(
    el(
      "button",
      {
        type: "button",
        class: "ctx-item",
        role: "menuitem",
        onclick: () => {
          closeNewChatMenu();
          promptNewProject();
        },
      },
      "New project\u2026",
    ),
  );
  document.body.append(menu);
  newChatMenuEl = menu;
  const r = menu.getBoundingClientRect();
  const anchor = e.currentTarget.getBoundingClientRect();
  const x = Math.min(anchor.left, window.innerWidth - r.width - 8);
  const y = Math.min(anchor.bottom + 6, window.innerHeight - r.height - 8);
  menu.style.left = Math.max(8, x) + "px";
  menu.style.top = Math.max(8, y) + "px";
  setTimeout(() => {
    document.addEventListener("pointerdown", onCtxDocPointer, true);
    document.addEventListener("keydown", onCtxKey, true);
    window.addEventListener("resize", closeNewChatMenu);
    window.addEventListener("scroll", closeNewChatMenu, true);
  }, 0);
}

let newChatMenuEl = null;
function closeNewChatMenu() {
  if (!newChatMenuEl) return;
  newChatMenuEl.remove();
  newChatMenuEl = null;
  document.removeEventListener("pointerdown", onCtxDocPointer, true);
  document.removeEventListener("keydown", onCtxKey, true);
  window.removeEventListener("resize", closeNewChatMenu);
  window.removeEventListener("scroll", closeNewChatMenu, true);
}

const CUSTOM_PROJECTS_KEY = "pi-rpc-web.custom-projects";
const LEGACY_CUSTOM_PROJECTS_KEY = "pi-remote.custom-projects";

function rememberedProjects() {
  try {
    const stored =
      localStorage.getItem(CUSTOM_PROJECTS_KEY) ??
      localStorage.getItem(LEGACY_CUSTOM_PROJECTS_KEY) ??
      "[]";
    const v = JSON.parse(stored);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function rememberProject(cwd) {
  const list = rememberedProjects();
  if (!list.includes(cwd)) {
    list.unshift(cwd);
    try {
      localStorage.setItem(
        CUSTOM_PROJECTS_KEY,
        JSON.stringify(list.slice(0, 12)),
      );
    } catch {
      /* storage unavailable: fine */
    }
  }
}

/** Type a folder path anywhere on the machine, validate, then chat there. */
function promptNewProject() {
  inputModal({
    title: "New project",
    placeholder: "/absolute/path/to/project",
    onSubmit: async (raw) => {
      const cwd = raw.trim();
      if (!cwd) return;
      try {
        await app.meta("project.check", { cwd });
        rememberProject(cwd);
        app.toast(`New chat in ${basename(cwd)}`, "info");
        startChatIn(cwd, { isNewProject: true });
      } catch (err) {
        app.toast(err.message, "error");
      }
    },
  });
}

/** Cold-start a brand-new session rooted at `cwd` (null = server default). */
/**
 * Abandoning a session that never got a message discards it: the file is
 * deleted (if it exists) so empty sessions never clutter the sidebar.
 */
export function discardIfEmpty() {
  if (!app.state.sessionFile) return;
  if (app.state.messages.length > 0) return;
  app
    .meta("sessions.delete", { path: app.state.sessionFile })
    .then(() => refresh())
    .catch(() => {
      /* file may not exist yet — that's fine */
    });
}

function startChatIn(cwd, { isNewProject = false } = {}) {
  discardIfEmpty();
  app.state.projectChosen = true;
  tempNewProject = isNewProject ? cwd || currentProject || true : null;
  tempSessionPath = null;
  const opts = { session: null };
  if (cwd) opts.cwd = cwd;
  app.socket.configure(opts);
  app.socket.forceReconnect();
}

/** Start a clean session in the current project after unrecoverable history errors. */
export function startCleanChat() {
  startChatIn(currentProject);
}

/** Open the new-chat project picker (used by the gated composer too). */
export function openNewChatPicker(anchor) {
  const target = anchor || document.getElementById("btn-new");
  openNewChatMenu({ preventDefault() {}, currentTarget: target });
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function iconBtn(label, svgPath, onClick) {
  const b = el("button", {
    type: "button",
    class: "icon-btn small",
    "aria-label": label,
    title: label,
  });
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(NS, "path");
  // svgPath is a static constant (ICONS below), never user input.
  p.setAttribute("d", svgPath);
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", "1.5");
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  svg.append(p);
  b.append(svg);
  b.addEventListener("click", onClick);
  return b;
}

const ICONS = {
  pen: "M9.7 2.8l3.5 3.5-6.9 6.9-4 .5.5-4 6.9-6.9zM11.2 1.3a1.6 1.6 0 0 1 2.3 0l1.2 1.2a1.6 1.6 0 0 1 0 2.3l-.9.9-3.5-3.5.9-.9z",
  ext: "M6.5 3.5h-2a1.5 1.5 0 0 0-1.5 1.5v6.5A1.5 1.5 0 0 0 4.5 13H11a1.5 1.5 0 0 0 1.5-1.5v-2M9.5 2.5h4v4M13 3 8.5 7.5",
  trash:
    "M3 4.5h10M6.5 4.5V3.2c0-.4.3-.7.7-.7h1.6c.4 0 .7.3.7.7v1.3M4.5 4.5l.6 8.1c0 .7.6 1.2 1.3 1.2h3.2c.7 0 1.3-.5 1.3-1.2l.6-8.1M6.6 7v4.2M9.4 7v4.2",
  x: "M4 4l8 8M12 4l-8 8",
};

/**
 * The session the user is currently viewing — ALWAYS shown pinned at the top
 * of the sidebar, even when its file doesn't exist on disk yet (brand-new
 * chats are only persisted on first message). This is how the user knows
 * which conversation they're on.
 */
function liveSessionEntry() {
  if (!tempNewProject || !app.state.sessionFile) return null;
  tempSessionPath = app.state.sessionFile;
  return {
    path: app.state.sessionFile,
    name: app.state.sessionName || null,
    firstPrompt: null,
    messageCount: app.state.messages.length,
    project: tempNewProject === true ? currentProject || "" : tempNewProject,
    cwd: tempNewProject === true ? currentProject || null : tempNewProject,
    mtimeMs: Date.now(),
    synthetic: true,
  };
}

function renderList(sessions) {
  listEl.textContent = "";

  const live = liveSessionEntry();
  // The temporary section ends once the session is a normal listed one
  // (file written after the first message) or the user switched away.
  if (
    tempNewProject &&
    (sessions.some((s) => s.path === tempSessionPath) ||
      (tempSessionPath && app.state.sessionFile !== tempSessionPath))
  ) {
    tempNewProject = null;
    tempSessionPath = null;
  }

  // Drop rows duplicating the live session, and empty non-current sessions
  // (header-only files left behind by abandoned chats).
  const rows = sessions.filter(
    (s) =>
      s.path !== live?.path &&
      !(s.messageCount <= 1 && s.path !== app.state.sessionFile),
  );

  // The live (temp new-project) row is merged INTO its project group so it
  // appears exactly where it will live once the session file hits disk —
  // no jumping from a pinned spot at the top.
  const groups = new Map();
  for (const s of rows) {
    const key = s.project || s.cwd || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  if (live) {
    const key = live.project || live.cwd || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(live);
  }

  if (!groups.size) {
    listEl.append(el("div", { class: "side-empty" }, "No sessions yet"));
    return;
  }

  for (const [proj, items] of [...groups.entries()].sort((x, y) =>
    x[0].localeCompare(y[0]),
  )) {
    if (hiddenProjects.has(proj)) continue; // user removed this project
    const isTemp = !!live && proj === (live.project || live.cwd);
    const header = el("div", {
      class: "side-group" + (isTemp ? " side-group-temp" : ""),
    });
    header.append(
      el(
        "span",
        { class: "side-group-label" },
        (basename(proj) || "Other") + (isTemp ? "  \u2726" : ""),
      ),
    );
    header.append(
      iconBtn("Hide project", ICONS.x, () =>
        confirmRemoveProject(proj, items.length, false),
      ),
    );
    header.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openProjectMenu(e, proj, items.length);
    });
    listEl.append(header);
    items.sort((x, y) => (Number(y.mtimeMs) || 0) - (Number(x.mtimeMs) || 0));
    for (const s of items) {
      renderSessionRow(s);
    }
  }
}

/** Render one session row (the pinned live session or a listed one). */
function renderSessionRow(s, { pinned = false } = {}) {
  {
    const current =
      pinned || (app.state.sessionFile && s.path === app.state.sessionFile);
    const missing = s.cwdExists === false; // project folder gone from disk
    const main = el(
      "button",
      {
        type: "button",
        class: "sess-main" + (missing ? " unavailable" : ""),
        title: rowTitle(s, missing),
        onclick: () => pick(s),
      },
      el(
        "span",
        { class: "sess-name" },
        s.synthetic && !s.name && !s.messageCount
          ? "New session"
          : s.name || s.firstPrompt || "Untitled session",
      ),
      el(
        "span",
        { class: "sess-meta" },
        relTime(s.mtimeMs) +
          (s.messageCount ? ` \u00b7 ~${s.messageCount} lines` : ""),
      ),
    );
    main.dataset.path = s.path;

    if (missing) {
      main.append(
        el("span", { class: "sess-badge missing" }, "folder missing"),
      );
    }

    const actions = el("div", { class: "sess-actions" });
    // Full management on every row: rename, open-in-new-tab, delete.
    actions.append(
      iconBtn("Rename session", ICONS.pen, () => renameSession(s)),
    );
    actions.append(
      iconBtn("Open in new tab", ICONS.ext, () => openColdResume(s)),
    );
    actions.append(
      iconBtn("Delete session", ICONS.trash, () => confirmDelete(s)),
    );

    const row = el("div", { class: "sess" + (current ? " current" : "") });
    row.dataset.path = s.path;
    row.addEventListener("contextmenu", (e) => openContextMenu(e, s));
    row.append(main, actions);
    listEl.append(row);
  }
}

/** Tooltip text explaining what clicking this row will do (and why). */
function rowTitle(s, missing) {
  if (missing) {
    return `Project folder no longer exists (${s.cwd || "unknown"}) — cannot be resumed. Click for delete options.`;
  }
  return s.cwd ? `${s.path} (${s.cwd})` : s.path;
}

function highlightCurrent() {
  const cur = app.state.sessionFile;
  for (const row of listEl.querySelectorAll(".sess")) {
    row.classList.toggle("current", !!cur && row.dataset.path === cur);
  }
  updateWorkingIndicator();
}

/** Working dot reflects only the active child: streaming right now. */
function updateWorkingIndicator() {
  const working = !!app.state.ready && !!app.state.isStreaming;
  for (const row of listEl.querySelectorAll(".sess.current")) {
    row.classList.toggle("working", working);
  }
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

/** Cold-resume a session in a new tab via a same-origin anchor click. */
function openColdResume(s) {
  const url = new URL("/?", location.origin);
  url.searchParams.set("session", s.path);
  if (url.origin !== location.origin) return; // defense in depth
  const a = el("a", { href: url.href, target: "_blank", rel: "noopener" });
  document.body.append(a);
  a.click();
  a.remove();
}

/* Session switching strategy:
 *
 * EVERY selection is a cold respawn: reconnect with hello {session, cwd} so
 * the server kills the current child and spawns a fresh one rooted at the
 * target session's project. This avoids stale-extension crashes on swap and
 * works uniformly across projects. If the current child is still streaming
 * or compacting, the user confirms first (abort + respawn or keep working).
 */

/** Confirm before aborting an in-flight response, then cold-resume into
 * `session`. Idle switches respawn immediately without any modal. */
async function confirmAndRespawnInto(session) {
  if (!app.state.isStreaming && !app.state.isCompacting) {
    respawnInto(session);
    return;
  }
  let modal;
  modal = openModal({
    title: "Switch sessions?",
    body: el(
      "div",
      { class: "modal-text" },
      "The current response is still running. Abort it and switch sessions?",
    ),
    actions: [
      { label: "Keep working", kind: "ghost", onClick: () => modal.cancel() },
      {
        label: "Abort & switch",
        kind: "danger",
        onClick: () => {
          modal.close();
          app.socket.fire({ type: "abort" });
          respawnInto(session);
        },
      },
    ],
  });
}

/** Cold-resume into session `s`: fresh connection + fresh child. */
function respawnInto(s) {
  app.state.projectChosen = true;
  const opts = { session: s.path };
  if (s.cwd) opts.cwd = s.cwd;
  app.socket.configure(opts);
  app.socket.forceReconnect();
}

/**
 * Confirm, then permanently delete a session file. Deleting the session that
 * is currently open ends its agent and starts a fresh chat.
 */
function confirmDelete(s) {
  const isCurrent = !!app.state.sessionFile && s.path === app.state.sessionFile;
  let m;
  m = openModal({
    title: "Delete session?",
    body: el(
      "div",
      { class: "modal-text" },
      el("strong", null, s.name || s.firstPrompt || "Untitled session"),
      el("div", { class: "modal-sub" }, s.path),
      el(
        "p",
        { class: "modal-sub warn-text" },
        isCurrent
          ? "This is the session you have open — deleting it stops the agent and starts a new chat. The file is deleted permanently."
          : "Its project folder no longer exists, so it cannot be resumed.",
      ),
      el("p", { class: "modal-sub warn-text" }, "This cannot be undone."),
    ),
    actions: [
      { label: "Keep", kind: "ghost", onClick: () => m.cancel() },
      {
        label: "Delete",
        kind: "danger",
        onClick: async () => {
          m.close();
          try {
            await app.meta("sessions.delete", { path: s.path });
            app.toast("Session deleted", "info");
            if (isCurrent) {
              // Drop the pointer to the deleted session; a fresh child with a
              // clean hello starts a new chat.
              app.socket.configure({ session: null });
              app.socket.forceReconnect();
            } else {
              refresh();
            }
          } catch (err) {
            app.toast(`Delete failed: ${err.message}`, "error");
          }
        },
      },
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Project removal (hide / delete)                                     */
/* ------------------------------------------------------------------ */

function updateHiddenChip() {
  const chip = document.getElementById("hidden-projects");
  if (!chip) return;
  const n = hiddenProjects.size;
  chip.hidden = n === 0;
  chip.textContent = `\u25CF ${n} hidden project${n === 1 ? "" : "s"}`;
}

function unhideProject(proj) {
  hiddenProjects.delete(proj);
  persistHidden();
  refresh();
}

function openHiddenPopover(anchorEl) {
  closeNewChatMenu();
  closeContextMenu();
  const menu = el("div", {
    class: "ctx-menu",
    role: "menu",
    "aria-label": "Hidden projects",
  });
  menu.append(el("div", { class: "ctx-group" }, "HIDDEN PROJECTS"));
  if (!hiddenProjects.size) {
    menu.append(
      el("div", { class: "ctx-item", style: "opacity:.6" }, "Nothing hidden"),
    );
  }
  for (const proj of hiddenProjects) {
    menu.append(
      el(
        "button",
        {
          type: "button",
          class: "ctx-item",
          role: "menuitem",
          title: proj,
          onclick: () => {
            closeNewChatMenu();
            unhideProject(proj);
          },
        },
        `\u2713 Show ${basename(proj)}`,
      ),
    );
  }
  document.body.append(menu);
  positionMenu(menu, anchorEl);
  armMenuDismiss(closeNewChatMenu);
}

function openProjectMenu(e, proj, sessionCount) {
  closeNewChatMenu();
  closeContextMenu();
  const isCurrent = currentProject && proj === currentProject;
  const menu = el("div", {
    class: "ctx-menu",
    role: "menu",
    "aria-label": "Project actions",
  });
  menu.append(
    ctxItem("Hide from sidebar", () =>
      confirmRemoveProject(proj, sessionCount, false),
    ),
    ctxItem(
      "Delete all sessions\u2026",
      () => confirmRemoveProject(proj, sessionCount, true),
      true,
    ),
  );
  document.body.append(menu);
  positionMenu(menu, e.currentTarget || e.target);
  armMenuDismiss(closeNewChatMenu);
  if (isCurrent) {
    // visual cue only; the confirm modal explains the constraint
  }
}

function positionMenu(menu, anchorEl) {
  const r = menu.getBoundingClientRect();
  const a =
    anchorEl && anchorEl.getBoundingClientRect
      ? anchorEl.getBoundingClientRect()
      : { left: 12, bottom: 12 };
  let x = Math.min(a.left, window.innerWidth - r.width - 8);
  let y = Math.min(a.bottom + 6, window.innerHeight - r.height - 8);
  menu.style.left = Math.max(8, x) + "px";
  menu.style.top = Math.max(8, y) + "px";
}

function armMenuDismiss(closeFn) {
  setTimeout(() => {
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (!menuContains(e.target)) closeFn();
      },
      true,
    );
    document.addEventListener("keydown", menuEsc, true);
    window.addEventListener("resize", closeFn);
    window.addEventListener("scroll", closeFn, true);
  }, 0);
}

function menuContains(target) {
  return (
    (newChatMenuEl && newChatMenuEl.contains(target)) ||
    (ctxMenuEl && ctxMenuEl.contains(target)) ||
    (hiddenMenuEl && hiddenMenuEl.contains(target))
  );
}

function menuEsc(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeNewChatMenu();
    closeContextMenu();
    closeHiddenMenu();
  }
}

let hiddenMenuEl = null;
function closeHiddenMenu() {
  if (!hiddenMenuEl) return;
  hiddenMenuEl.remove();
  hiddenMenuEl = null;
  document.removeEventListener("pointerdown", onCtxDocPointer, true);
  document.removeEventListener("keydown", onCtxKey, true);
}

/**
 * Confirm removal of a project from the sidebar.
 * mode false = hide (view-only, files stay); mode true = delete all sessions.
 */
function confirmRemoveProject(proj, sessionCount, deleteMode) {
  if (currentProject && proj === currentProject) {
    app.toast(
      "This is the active project — switch to another chat first",
      "warning",
    );
    return;
  }
  let m;
  m = openModal({
    title: deleteMode ? "Delete project sessions?" : "Hide project?",
    body: el(
      "div",
      { class: "modal-text" },
      el("strong", null, basename(proj)),
      el("div", { class: "modal-sub" }, proj),
      el(
        "p",
        { class: "modal-sub warn-text" },
        deleteMode
          ? `All ${sessionCount} session file${sessionCount === 1 ? "" : "s"} in this project will be deleted permanently — this cannot be undone.`
          : "Sessions stay on disk; the project is just removed from this list. You can restore it later via the hidden-projects chip.",
      ),
    ),
    actions: [
      { label: "Cancel", kind: "ghost", onClick: () => m.cancel() },
      {
        label: "Hide",
        kind: "primary",
        onClick: async () => {
          m.close();
          hiddenProjects.add(proj);
          persistHidden();
          refresh();
        },
      },
      ...(sessionCount > 0
        ? [
            {
              label: "Delete all sessions",
              kind: "danger",
              onClick: async () => {
                m.close();
                try {
                  const r = await app.meta("sessions.deleteProject", {
                    project: proj,
                  });
                  app.toast(
                    `Deleted ${r && r.removed != null ? r.removed : sessionCount} session${r && r.removed === 1 ? "" : "s"}`,
                    "info",
                  );
                  refresh();
                } catch (err) {
                  app.toast(err.message, "error");
                }
              },
            },
          ]
        : []),
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Right-click context menu                                            */
/* ------------------------------------------------------------------ */

let ctxMenuEl = null;

function closeContextMenu() {
  if (!ctxMenuEl) return;
  ctxMenuEl.remove();
  ctxMenuEl = null;
  document.removeEventListener("pointerdown", onCtxDocPointer, true);
  document.removeEventListener("keydown", onCtxKey, true);
  window.removeEventListener("resize", closeContextMenu);
  window.removeEventListener("scroll", closeContextMenu, true);
}

function onCtxDocPointer(e) {
  if (newChatMenuEl && !newChatMenuEl.contains(e.target)) closeNewChatMenu();
  if (ctxMenuEl && !ctxMenuEl.contains(e.target)) closeContextMenu();
}

function onCtxKey(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeNewChatMenu();
    closeContextMenu();
  }
}

function ctxItem(label, onClick, danger) {
  return el(
    "button",
    {
      type: "button",
      class: "ctx-item" + (danger ? " danger" : ""),
      role: "menuitem",
      onclick: () => {
        closeContextMenu();
        onClick();
      },
    },
    label,
  );
}

function openContextMenu(e, s) {
  e.preventDefault();
  closeMobile();
  closeContextMenu();

  const isCurrent = !!app.state.sessionFile && s.path === app.state.sessionFile;
  const menu = el("div", {
    class: "ctx-menu",
    role: "menu",
    "aria-label": "Session actions",
  });
  menu.append(
    ctxItem(
      isCurrent ? "\u2713 Current session" : "Open",
      () => pick(s),
      false,
    ),
    ctxItem("Open in new tab", () => openColdResume(s)),
    ctxItem("Rename\u2026", () => renameSession(s)),
    ctxItem("Delete\u2026", () => confirmDelete(s), true),
  );
  document.body.append(menu);
  ctxMenuEl = menu;

  // Position within the viewport.
  const r = menu.getBoundingClientRect();
  let x = Math.min(e.clientX, window.innerWidth - r.width - 8);
  let y = Math.min(e.clientY, window.innerHeight - r.height - 8);
  menu.style.left = Math.max(8, x) + "px";
  menu.style.top = Math.max(8, y) + "px";

  setTimeout(() => {
    document.addEventListener("pointerdown", onCtxDocPointer, true);
    document.addEventListener("keydown", onCtxKey, true);
    window.addEventListener("resize", closeContextMenu);
    window.addEventListener("scroll", closeContextMenu, true);
  }, 0);
}

async function pick(s) {
  closeMobile();
  if (app.state.sessionFile && s.path === app.state.sessionFile) return;
  discardIfEmpty();
  if (s.cwdExists === false) {
    // Project folder is gone: the child could never start there. Offer the
    // delete flow instead of a doomed respawn.
    confirmDelete(s);
    return;
  }
  // Every selection is the only same-tab navigation entrypoint: it always
  // terminates the current agent process and starts a fresh one rooted in
  // the target session (pi persists each turn to disk, so nothing in-flight
  // is lost). Streaming/compacting switches confirm first via modal.
  await confirmAndRespawnInto(s);
}

/** Rename any session. Current session goes through RPC; others via file header. */
function renameSession(s) {
  inputModal({
    title: "Rename session",
    value: s.name || "",
    placeholder: "Session name",
    onSubmit: async (name) => {
      const trimmed = name.trim();
      try {
        if (app.state.sessionFile && s.path === app.state.sessionFile) {
          await app.request({ type: "set_session_name", name: trimmed });
          await app.snapshot();
        } else {
          await app.meta("sessions.rename", { path: s.path, name: trimmed });
          refresh();
        }
        app.toast(trimmed ? "Session renamed" : "Name cleared", "info");
      } catch (err) {
        app.toast(err.message, "error");
      }
    },
  });
}
