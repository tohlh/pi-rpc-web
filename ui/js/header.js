/* Header: session title, connection/status dot, model picker popover
 * (searchable, grouped by provider -> set_model), thinking-level selector
 * (get_available_thinking_levels / set_thinking_level), context usage bar,
 * token + cost totals, mobile hamburger.
 */

import { el, qs, fmtTokens, fmtCost, basename } from "./util.js";

let app = null;
let els = {};

let popEl = null; // open popover node
let popAnchor = null;
const MOBILE_QUERY = "(max-width: 600px)";

export function init(a) {
  app = a;
  els = {
    title: qs("#session-title"),
    dot: qs("#conn-dot"),
    menu: qs("#btn-menu"),
    modelBtn: qs("#btn-model"),
    thinkBtn: qs("#btn-thinking"),
    ctxFill: qs("#ctx-fill"),
    ctxPct: qs("#ctx-pct"),
    ctxWrap: qs("#ctx-wrap"),
    stats: qs("#stats"),
    tok: qs("#tok-total"),
    cost: qs("#cost-total"),
  };

  els.menu.addEventListener("click", () => {
    const open = document.body.classList.toggle("sidebar-open");
    els.menu.setAttribute("aria-expanded", String(open));
    if (open) {
      const first = document.getElementById("btn-new");
      if (first) first.focus();
    }
  });

  els.modelBtn.addEventListener("click", () => openModelPopover());
  els.thinkBtn.addEventListener("click", () => openThinkingPopover());

  app.on("state", renderAll);
  app.on("project", renderProject);
  app.on("stats", renderStats);
  app.on("stream", renderDot);
  app.on("conn", renderDot);
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function renderProject() {
  const st = app.state;
  if (!st.projectChosen) {
    els.title.textContent = "pi-rpc-web";
    els.title.title = "";
    return;
  }
  els.title.textContent = st.projectPath
    ? basename(st.projectPath)
    : "pi-rpc-web";
  els.title.title = st.projectPath || "";
}

function renderAll() {
  const st = app.state;
  renderProject();

  if (st.model) {
    els.modelBtn.textContent = st.model.name || st.model.id || "model";
    els.modelBtn.title =
      `${st.model.provider}/${st.model.id}` +
      (st.model.contextWindow
        ? ` \u00b7 ${fmtTokens(st.model.contextWindow)} context`
        : "");
  } else {
    els.modelBtn.textContent = "Select model";
    els.modelBtn.title = "";
  }

  const level = st.thinkingLevel || "off";
  els.thinkBtn.textContent = `thinking: ${level}`;
  els.thinkBtn.hidden = (st.thinkingLevels || []).length === 0;

  renderStats();
  renderDot();
}

function renderStats() {
  const s = app.state.stats;
  const usage = s && s.contextUsage;
  if (usage && usage.percent != null) {
    const pct = Math.max(0, Math.min(100, Number(usage.percent)));
    els.ctxFill.style.width = pct + "%";
    els.ctxWrap.className = pct > 90 ? "crit" : pct > 75 ? "warn" : "";
    els.ctxPct.textContent = Math.round(pct) + "%";
  } else {
    els.ctxFill.style.width = "0%";
    els.ctxPct.textContent = "\u2014";
    els.ctxWrap.className = "";
  }
  const tokens = s && s.tokens ? s.tokens : null;
  els.tok.textContent = tokens ? fmtTokens(tokens.total) + " tok" : "";
  els.cost.textContent = s && s.cost != null ? fmtCost(s.cost) : "";

  els.stats.title = tokens
    ? `Tokens \u2014 in: ${fmtTokens(tokens.input)} \u00b7 out: ${fmtTokens(tokens.output)}` +
      `\u00b7 cache read: ${fmtTokens(tokens.cacheRead)}\nCost total: ${fmtCost(s.cost)}` +
      (usage
        ? `\nContext: ${fmtTokens(usage.tokens)} / ${fmtTokens(usage.contextWindow)} (${usage.percent}%)`
        : "")
    : "Session statistics";
}

function renderDot() {
  const st = app.state;
  let cls = "dot idle";
  let label = "Idle";
  if (!st.ready) {
    cls = "dot down";
    label = "Disconnected";
  } else if (st.isCompacting) {
    cls = "dot live";
    label = "Compacting\u2026";
  } else if (st.isStreaming) {
    cls = "dot live";
    label = "Streaming\u2026";
  }
  els.dot.className = cls;
  els.dot.title = label;
  els.dot.setAttribute("aria-label", label);
}

/* ------------------------------------------------------------------ */
/* Popovers                                                            */
/* ------------------------------------------------------------------ */

function closePopover() {
  if (!popEl) return;
  popEl.remove();
  popEl = null;
  popAnchor = null;
  document.removeEventListener("pointerdown", onDocPointer, true);
  document.removeEventListener("keydown", onDocKey, true);
}

function onDocPointer(e) {
  if (
    popEl &&
    !popEl.contains(e.target) &&
    e.target !== popAnchor &&
    !popAnchor.contains(e.target)
  ) {
    closePopover();
  }
}

function onDocKey(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closePopover();
    if (popAnchor) popAnchor.focus();
  } else if (e.key === "Tab") {
    closePopover();
  }
}

function openPopover(anchor, build) {
  if (popEl && popAnchor === anchor) {
    closePopover();
    return;
  }
  closePopover();
  const pop = el("div", {
    class: "popover",
    role: "dialog",
    "aria-label": "Options",
  });
  build(pop);
  document.body.append(pop);

  if (!window.matchMedia(MOBILE_QUERY).matches) {
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    let left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
    pop.style.left = `${left}px`;
    let top = r.bottom + 8;
    if (top + pop.offsetHeight > window.innerHeight - 8) {
      top = Math.max(8, r.top - pop.offsetHeight - 8);
    }
    pop.style.top = `${top}px`;
  }

  popEl = pop;
  popAnchor = anchor;
  pop.addEventListener("keydown", (e) => {
    // Arrow-key navigation between option buttons (Enter clicks natively).
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...pop.querySelectorAll("button.pop-item")];
    if (!items.length) return;
    e.preventDefault();
    const idx = items.indexOf(document.activeElement);
    const next =
      e.key === "ArrowDown"
        ? Math.min(items.length - 1, idx + 1)
        : Math.max(0, idx - 1);
    items[idx === -1 ? 0 : next].focus();
  });
  setTimeout(() => {
    document.addEventListener("pointerdown", onDocPointer, true);
    document.addEventListener("keydown", onDocKey, true);
    const firstInput = pop.querySelector("input");
    if (firstInput) firstInput.focus();
  }, 0);
}

function openModelPopover() {
  openPopover(els.modelBtn, (pop) => {
    const search = el("input", {
      class: "pop-search",
      type: "search",
      placeholder: "Search models\u2026",
      "aria-label": "Search models",
    });
    const list = el("div", { class: "pop-list", role: "listbox" });
    pop.append(search, list);

    const refill = () => {
      const q = search.value.trim().toLowerCase();
      list.textContent = "";
      const groups = new Map();
      for (const m of app.state.models || []) {
        const hay = `${m.provider} ${m.name || ""} ${m.id}`.toLowerCase();
        if (q && !hay.includes(q)) continue;
        if (!groups.has(m.provider || "?")) groups.set(m.provider || "?", []);
        groups.get(m.provider || "?").push(m);
      }
      if (!groups.size) {
        list.append(el("div", { class: "pop-empty" }, "No matching models"));
        return;
      }
      for (const [provider, models] of [...groups.entries()].sort((x, y) =>
        x[0].localeCompare(y[0]),
      )) {
        list.append(el("div", { class: "pop-group" }, provider));
        for (const m of models) {
          const current =
            app.state.model &&
            app.state.model.provider === m.provider &&
            app.state.model.id === m.id;
          const item = el(
            "button",
            {
              type: "button",
              class: "pop-item" + (current ? " current" : ""),
              role: "option",
              "aria-selected": String(!!current),
              onclick: async () => {
                closePopover();
                try {
                  const data = await app.request({
                    type: "set_model",
                    provider: m.provider,
                    modelId: m.id,
                  });
                  if (data && data.id) app.state.model = data;
                  app.emit("state");
                } catch (err) {
                  app.toast(err.message, "error");
                }
              },
            },
            el("span", { class: "pop-item-name" }, m.name || m.id),
            el(
              "span",
              { class: "pop-item-sub" },
              `${m.provider}/${m.id}${m.reasoning ? " \u00b7 reasoning" : ""}`,
            ),
          );
          list.append(item);
        }
      }
    };
    search.addEventListener("input", refill);
    refill();
  });
}

function openThinkingPopover() {
  const levels = app.state.thinkingLevels || [];
  if (!levels.length) return;
  openPopover(els.thinkBtn, (pop) => {
    const list = el("div", { class: "pop-list", role: "listbox" });
    for (const lvl of levels) {
      const current = (app.state.thinkingLevel || "off") === lvl;
      list.append(
        el(
          "button",
          {
            type: "button",
            class: "pop-item" + (current ? " current" : ""),
            role: "option",
            "aria-selected": String(current),
            onclick: async () => {
              closePopover();
              try {
                await app.request({ type: "set_thinking_level", level: lvl });
                app.state.thinkingLevel = lvl;
                app.emit("state");
              } catch (err) {
                app.toast(err.message, "error");
              }
            },
          },
          el("span", { class: "pop-item-name" }, lvl),
          current ? el("span", { class: "pop-check" }, "\u2713") : null,
        ),
      );
    }
    pop.append(list);
  });
}
