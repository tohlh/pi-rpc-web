# pi-rpc-web — Web UI extension for pi — SHARED CONTRACT

Repository: <https://github.com/tohlh/pi-rpc-web>

A pi extension that serves a beautiful web interface for pi. Zero runtime npm
dependencies: Node built-ins only on the server, vanilla JS/CSS (no build step)
in the browser.

## File ownership (do not touch the other owner's files)

- **Backend owns**: `src/**` , `test/**`, `package.json`, `tsconfig.json`, `README.md`
- **Frontend owns**: `ui/index.html`, `ui/css/*.css`, `ui/js/*.js`
- **Shared read-only**: this file.

## Launch model: headless outer host

`pi --mode rpc --no-session --rpc-web` is the default supported launch for
localhost-only access. `pi --mode rpc --no-session --rpc-web --rpc-web-lan`
enables authenticated trusted-LAN access. The extension registers boolean
`--rpc-web` and `--rpc-web-lan` flags (`pi.registerFlag`). On `session_start`:

- `--rpc-web` is required; `--rpc-web-lan` alone does nothing.
- The host must be in rpc mode. Outside rpc mode nothing is served and stderr
  prints the required launch command.
- `startServer()` from `src/server.ts` starts an HTTP + WebSocket server on env
  `PI_WEB_PORT` or 7690, falling back to an ephemeral port when the port is
  busy (the fallback is stated on stderr).
- Flag matrix:
  - `--rpc-web` → bind **127.0.0.1 only**, no authentication screen.
  - `--rpc-web --rpc-web-lan` → bind IPv4 **0.0.0.0 only**, require LAN PIN
    login before protected HTTP pages or any WebSocket upgrade.
- All startup URLs, PINs, warnings, and startup errors are printed to
  **stderr** only. stdout belongs to the outer host's RPC protocol and stays
  valid JSONL at all times; no web-server chatter may ever reach it.
- There is **no `/web` command** and no interactive start/stop: the server's
  lifecycle is exactly the session lifecycle.

### Shutdown behavior

- `session_shutdown` (quit, reload, session switch) closes the listener and
  stops it idempotently.
- A best-effort `process.once("exit")` cleanup covers hosts that terminate
  without emitting `session_shutdown`.
- Both documented host shutdown signals — `SIGTERM` and `SIGINT` — end the
  process cleanly and leave the port refusing new connections. This is covered
  by `test/headless-smoke.mjs` and `test/lan-smoke.mjs`.
- Child RPC processes are killed on socket close (SIGTERM → SIGKILL after 3 s).

## Architecture

1. `src/extension.ts` registers `--rpc-web` and `--rpc-web-lan`, starts the
   server on `session_start` (rpc mode only), prints localhost or LAN startup
   details to stderr, and stops it on `session_shutdown`. Idempotent on both
   paths.
2. `src/server.ts`: `http.createServer` serving static files from `ui/` with
   correct MIME types, plus LAN auth gating in `--rpc-web --rpc-web-lan` mode and
   a WebSocket endpoint at any path (upgrade request). Hand-rolled RFC6455
   server-side WebSocket (handshake with SHA-1 accept key, frame parse/encode,
   masking, fragmentation, ping/pong). No `ws` pkg.
3. `src/lan-auth.ts`: process-local six-digit PIN auth, public `/login`,
   opaque browser-session cookies, direct-peer lockouts, and auth checks for
   protected HTTP routes and every WebSocket upgrade.
4. Per browser WebSocket connection the server lazily spawns
   `pi --mode rpc --no-session` (resolved from PATH or env `PI_BIN`) as a child
   process and pipes JSONL both ways. Strict framing: split records on `\n`
   only, strip a trailing `\r`, use `StringDecoder` for UTF-8 chunk boundaries
   (see rpc.md).

## LAN authentication contract

This section applies only when the host is launched with both `--rpc-web` and
`--rpc-web-lan`.

- LAN transport is plain HTTP and must stay on trusted local networks only.
  Public internet exposure and public port-forwarding are unsupported.
- The listener binds IPv4 `0.0.0.0` only. Human-readable LAN URLs may be shown
  from detected non-internal IPv4 interfaces, but clients may still connect via
  `127.0.0.1:<port>` on the host itself.
- The server generates one six-digit decimal PIN for the host process
  lifetime. Input normalization strips ASCII whitespace, so `123456` and
  `123 456` are equivalent. The PIN is reusable until process restart and is
  never persisted or placed in URLs.
- `GET /login` is public and returns HTML for the login form.
- `POST /login` is public and accepts only
  `application/x-www-form-urlencoded`. On a correct PIN it returns `303 See
  Other` to `/` and sets cookie
  `pi_rpc_web_session=<64-hex>; HttpOnly; SameSite=Strict; Path=/` with no
  persistent expiry. The cookie intentionally omits `Secure` because LAN mode
  is plain HTTP.
- Unauthenticated requests to protected HTTP routes redirect with `303 See
  Other` to `/login` before any static content is served.
- Every unauthenticated WebSocket upgrade is rejected with `401 Unauthorized`
  before any `Bridge` instance or child RPC process is created.
- Browser authorization is process-local and memory-only. Restarting the host
  invalidates every prior browser session, even if a client sends an old
  cookie.
- Five consecutive failed PIN attempts from one direct peer address cause a
  30-second lockout for that peer. Forwarded-IP headers are ignored.

### Per-WebSocket child ownership

- Each browser WebSocket owns its own agent child for the lifetime of that
  connection; children are never shared between sockets.
- The same session file may be opened by multiple tabs simultaneously: each
  tab spawns an independent child against the same `.jsonl`. **No writer lease
  is enforced** and concurrent writes are not reconciled — last writer wins on
  disk. Clients accept this; the product does not arbitrate.
- On child exit the socket stays open; the next passthrough message respawns
  with the current hello options.

### Cold navigation (browser session navigation)

- Every session switch terminates the current agent child and reconnects into
  the target session via hello `{session, cwd}` — a fresh child cold-resumes
  the conversation. The browser **never sends `switch_session`** for session
  navigation; in-process session switching is avoided entirely so third-party
  extensions cannot be tripped by stale state. `new_session` clears
  `hello.session`; respawn after a crash resumes whatever the browser is
  actually viewing.
- Removed synchronization actions: there is **no `session.watch` /
  `session.sizes`** meta action, no terminal↔web live sync, no TUI file
  watchers, no active-session file reloads, and no legacy
  `PI_REMOTE_AUTO_SYNC` environment variable. The web UI is the sole writer surface this extension
  provides.

### Recursive flag rejection

Child RPC processes must never inherit or accept `--rpc-web` or `--rpc-web-lan`.
Before any passthrough message reaches a child, its `extraArgs` are inspected:
any arg equal to `--rpc-web`, starting with `--rpc-web=`, equal to
`--rpc-web-lan`, or starting with `--rpc-web-lan=` is rejected with an error
reply (`{type:"hello", ok:false, error:"child extraArgs may not include --rpc-web"}` or
`{type:"hello", ok:false, error:"child extraArgs may not include --rpc-web-lan"}`)
and nothing is spawned. Removed legacy spellings `--remote` and `--remote-lan`
are also rejected defensively but are not registered launch aliases. The base
args themselves never contain any browser-hosting flag.

## WebSocket protocol (browser ⇄ server)

Every message is a JSON object, one per WS text frame.

### Browser → server

- Hello (first message, required before forwarding):
  `{type:"hello", cwd?, session?, sessionDir?, name?, provider?, model?, thinking?, extraArgs?: string[]}`
  Server spawns the child accordingly:
  base args `["--mode","rpc","--no-session"]`, plus spawn with `cwd` option;
  `--session <path|id>` when `session`; `--session-dir` when `sessionDir`;
  `-n <name>` when `name`; `--provider`/`--model`/`--thinking` when set;
  `extraArgs` appended verbatim (minus rejected flags, see above). Reply
  `{type:"hello", ok:true, pid}` or `{type:"hello", ok:false, error}`.
  Because spawn failures (e.g. bad `PI_BIN`) surface asynchronously, an
  `ok:true` reply may be deferred until the child's first stdout data (or
  ~500 ms); a spawn error before that yields `ok:false`.
- RPC passthrough: any other message is forwarded verbatim (one JSON line) to
  child stdin. Clients use the standard RPC protocol ids for correlation
  (see rpc.md): prompt/steer/follow_up/abort/new_session/get_state/get_messages/
  set_model/cycle_model/get_available_models/set_thinking_level/
  get_available_thinking_levels/compact/set_auto_compaction/set_auto_retry/
  bash/abort_bash/switch_session/fork/clone/get_fork_messages/get_entries/
  get_tree/get_session_stats/export_html/set_session_name/get_commands.
  (`switch_session` remains available as a raw RPC verb but the frontend does
  not use it for navigation — see "Cold navigation".)

### Server → browser

- Every line of child stdout is forwarded verbatim as a WS text message
  (responses `"type":"response"`, events `agent_start`, `message_update`,
  `tool_execution_*`, `extension_ui_request`, `queue_update`, etc.).
  Backpressure: when a socket's write buffer exceeds 1 MiB the child's
  stdout is paused until it drains below 256 KiB; connections past a 16 MiB
  hard cap are terminated.
- If a passthrough message cannot be written because no child could be
  spawned, the server also answers `{type:"response", id, success:false}`
  (when the frame carries an id) so correlated requests fail fast instead of
  timing out; a `{type:"child", event:"spawn-error"}` accompanies it.
- Meta replies: `{type:"meta", id, ok:true, data}` / `{type:"meta", id, ok:false, error}`
- Child lifecycle: `{type:"child", event:"exit"|"error"|"spawn-error", code?, signal?, error?, stderr?}`
  Abnormal exits include the last ~6 lines of the child's stderr (`stderr`)
  for diagnosability. Respawn options track the browser's current view:
  `new_session` clears `hello.session`, and cold navigation re-hellos with the
  target session, so a post-crash respawn resumes the conversation the browser
  is viewing.

### Meta actions (browser → server, answered with `type:"meta"`)

- `{type:"meta", id, action:"sessions.list", project?: string}`
  Scan `$PI_HOMEor ~/.pi/agent/sessions/<encoded-project-dir>/*.jsonl` (one
  level; encoded dir = project absolute path with `/` replaced by `-`, wrapped
  in `--...--`). If `project` given encode it, else return ALL projects grouped.
  For each file return `{path, mtimeMs, size, sessionId (uuid from filename),
  name (from header jsonl line if present), firstPrompt (first user message
  text, ≤120 chars), messageCount (approx: count lines, streamed with a 20000-line cap per file), cwd}` sorted by mtime
  desc, cap 200. Header line is JSON containing e.g. `id`,`cwd`; entry lines
  have `.type`. Be defensive: skip unparseable lines. Each summary also
  carries `cwdExists` (boolean): whether the session's project folder still
  exists on disk (stat'd once per unique cwd).
- `{type:"meta", id, action:"sessions.delete", path}` → `{data:{deleted}}`
  Permanently delete one session file. Server validates strictly: absolute
  path, inside `~/.pi/agent/sessions/<encoded-project>/`, exactly two path
  segments, `.jsonl` extension — anything else is refused.
- `{type:"meta", id, action:"sessions.rename", path, name}` → `{data:{renamed, name}}`
  Rename any session by rewriting the `name` field of its jsonl header line.
  Same strict validation as delete; empty name clears it; atomic write via
  temp file; files >64MB refused.
- `{type:"meta", id, action:"ping"}` → `{data:{pong:true}}`
- `{type:"meta", id, action:"project.info"}` → `{data:{cwd}}`
  The project folder the agent child is rooted in (what "new chat" targets).
- `{type:"meta", id, action:"project.check", cwd}` → `{data:{cwd}}`
  Validate an absolute folder path exists and is a directory (for the
  "New project…" picker flow). Refuses relative paths and non-directories.

### Extension UI dialog handling (frontend responsibility)

Child emits `extension_ui_request` (methods select/confirm/input/editor +
fire-and-forget notify/setStatus/setWidget/setTitle/set_editor_text). Frontend
renders modals/toasts and sends back `extension_ui_response` frames — these
passthrough to child stdin like any RPC message.

## Frontend requirements (ui/)

Single-page app, no framework, no build step, ES modules. Must be genuinely
beautiful: dark theme (deep neutral background ~#101014 range, one restrained
accent, generous spacing, subtle borders, rounded corners, soft shadows,
system font stack for prose + monospace for code), light-theme via
`prefers-color-scheme` optional. Smooth micro-transitions. Responsive down to
~380px (sidebar becomes overlay).

Layout:

- Left sidebar (collapsible): New chat button; Sessions section listing
  meta `sessions.list` with relative time + name/first prompt. Rows from a
  project other than the current one carry a badge naming that folder; rows
  whose project folder no longer exists are dimmed with a red "folder missing"
  badge and offer a delete (trash) action — clicking them opens the
  delete confirmation instead of attempting a doomed respawn.
  **Switching strategy**: EVERY switch terminates the current agent process
  and cold-resumes into the target via reconnect + hello `{session, cwd}`
  (pi persists each turn to disk, so nothing in-flight is lost). No confirm
  modal for switching; deletion keeps a confirm dialog. Full management on
  every row: hover icons (rename / open-in-new-tab / delete) and right-click
  context menu (Open, Open in new tab, Rename…, Delete…). Current session:
  rename via RPC `set_session_name`; others via meta `sessions.rename`.
  Deleting the currently-open session stops its agent and starts a new chat.
  The current row shows a pulsing dot while that agent is streaming. The live
  session is pinned per project group until named ("New session"). Abandoning
  an empty session (switching away with 0 messages) deletes its file and drops
  it from the list. Until a project/session is explicitly chosen (picker,
  session row, or ?session= cold resume), the composer is gated: readOnly
  input, blocked sends with a toast, and interacting with it opens the
  project picker — stray messages can never create sessions in arbitrary
  folders. Projects can also be REMOVED from the sidebar: hover a project
  group header (or right-click it) → "Hide project" (view-only, files stay;
  persisted in localStorage) or "Delete all sessions" (bulk-deletes every
  .jsonl of that project via meta sessions.deleteProject — strict validation
  applies). The current project cannot be removed. A "N hidden projects"
  chip at the sidebar bottom opens a popover to unhide them. The sidebar shows
  the active project folder, and "New chat" opens a project picker (current
  project highlighted, plus other known projects from session history) — each
  cold-starts a fresh agent rooted there.
- Header bar: current model name (click → popover with `get_available_models`,
  searchable, grouped by provider, sets model via `set_model`), thinking-level
  selector (`get_available_thinking_levels` / `set_thinking_level`), context
  usage meter + token/cost totals (poll `get_session_stats` after turns), and
  status dot for streaming state.
- Main stream: renders `get_messages` history on connect and then applies live
  events. User messages right-aligned bubbles; assistant messages full-width.
  Thinking blocks rendered as collapsed `<details>` ("Thinking…" + duration)
  styled distinctly. Tool calls as cards: tool name, one-line args summary,
  status icon (spinner running / ✓ / ✗ error), expandable body with streamed
  `tool_execution_update.partialResult` content (monospace, max-height scroll);
  final result replaces partial on `tool_execution_end`. Markdown renderer
  supporting: headings, bold/italic/inline code, fenced code blocks (language
  label, copy button), unordered/ordered lists, blockquotes, links, tables
  (best effort), horizontal rules. Escape HTML by default.
- Streaming: assemble `message_update.assistantMessageEvent` deltas
  (text_start/delta/end, thinking_*, toolcall_*) keyed by `contentIndex`;
  treat `message_end.message` as authoritative replacement. Auto-scroll unless
  user scrolled up (show "jump to latest" pill).
- Composer: auto-growing textarea (Enter=send, Shift+Enter=newline), attach
  image button (file picker + paste) → base64 ImageContent in `prompt.images`,
  Stop button while streaming (sends `abort`), disabled send while child busy
  but offering "steer"/"follow-up" toggle chip when `isStreaming` (uses
  `streamingBehavior`). Slash-command autocomplete popup fed by
  `get_commands` (filter as you type, Enter/Tab completes, shows description +
  source badge). Pending queue chips from `queue_update` with ability to show
  counts.
- Dialogs: `extension_ui_request` select/confirm/input/editor → accessible
  modal (Esc = cancel → send `cancelled:true`); notify → toast (info/warning/
  error styling); setStatus → status area in header/footer; setTitle →
  document.title; set_editor_text → fills composer.
- Connection handling: reconnect with backoff on socket close, re-hello,
  refetch state/messages. Show banner when disconnected / child exited.
  When the agent child exits or fails to spawn, all in-flight RPC requests
  are rejected immediately (no silent hangs) and the UI auto-restarts the
  child, then resnapshots.
- Errors: RPC `success:false` responses surface as toasts.

State snapshot on connect/hello: send `get_state`, `get_messages`,
`get_available_models`, `get_available_thinking_levels`, `get_commands`,
`get_session_stats`.

## Testing / verification

- `npm run typecheck` = `tsc --noEmit` (frontend JS excluded).
- `npm test` runs, in order: `test/ws.test.mjs`,
  `test/lan-auth-test.mjs` (via `node --experimental-strip-types`),
  `test/server-auth-test.mjs` (via `node --experimental-strip-types`),
  `test/e2e.mjs`, `test/rpc-web-mode-test.mjs` (via
  `node --experimental-strip-types`), `test/headless-smoke.mjs`, and
  `test/lan-smoke.mjs`.
- `test/e2e.mjs` (Node ≥22, uses global WebSocket client): starts server on an
  ephemeral port, connects, sends hello, then exercises: ping meta,
  sessions.list, get_state, get_commands, get_available_models,
  set_thinking_level round-trip, and asserts streaming event passthrough shape
  by issuing a real `prompt "Reply with exactly OK"` ONLY if env
  `PI_RPC_WEB_E2E_LLM=1` (skip otherwise — CI-safe). Print PASS/FAIL summary.
- Backend unit-ish test `test/ws.test.mjs` exercising the hand-rolled WS layer
  with a raw TCP client (masking, fragmented message, ping/pong).
- `test/rpc-web-mode-test.mjs` covers extension lifecycle: `--rpc-web` /
  `--rpc-web-lan` registration, absence of `/web`, URL-or-LAN-details on stderr
  exactly once in rpc mode, non-rpc refusal, and shutdown closing the listener.
- `test/headless-smoke.mjs` is a process-level smoke test of the full launch
  `pi --mode rpc --no-session --rpc-web -e src/extension.ts`: waits for the
  URL on stderr, fetches `/` (HTML), asserts every complete stdout line parses
  as JSON, then verifies clean exit on both `SIGTERM` and `SIGINT` plus
  refusal of new HTTP connections afterwards.
- `test/lan-smoke.mjs` is a process-level smoke test of the full launch
  `pi --mode rpc --no-session --rpc-web --rpc-web-lan -e src/extension.ts`:
  waits for stderr PIN/port details, asserts unauthenticated `/` redirects to
  `/login`, logs in with the real PIN, verifies authenticated `/` HTML,
  requires unauthenticated raw WebSocket upgrade `401`, verifies restart
  invalidates the old browser cookie, and then verifies clean exit on both
  `SIGTERM` and `SIGINT` plus refusal of new HTTP connections afterwards.

## README.md

Install (`pi install` / manual copy to extensions folder / `-e src/extension.ts`),
usage (`pi --mode rpc --no-session --rpc-web` and
`pi --mode rpc --no-session --rpc-web --rpc-web-lan`, `PI_WEB_PORT`, `PI_BIN`),
LAN PIN/session semantics, multi-tab same-session semantics (independent
children, unreconciled writes), feature list, security notes (localhost-only by
default, trusted-LAN only with `--rpc-web-lan`), screenshots placeholder.
