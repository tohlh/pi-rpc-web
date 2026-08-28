/**
 * Per-WebSocket-connection bridge to a `pi --mode rpc` child process.
 *
 * - Strict JSONL framing on the child's stdout/stdin: split ONLY on `\n`,
 *   strip a trailing `\r`, decode UTF-8 chunk boundaries via StringDecoder.
 * - Child stdout lines are forwarded verbatim to the browser socket.
 * - Non-hello, non-meta socket messages are forwarded verbatim to stdin.
 * - Meta actions (`sessions.list`, `ping`) are answered locally.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import {
	readdir,
	readFile,
	rmdir,
	rename as renameFile,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

/** Options accepted in the hello handshake. */
export interface HelloOptions {
	cwd?: string;
	session?: string;
	sessionDir?: string;
	name?: string;
	provider?: string;
	model?: string;
	thinking?: string;
	extraArgs?: string[];
}

export interface SessionSummary {
	path: string;
	mtimeMs: number;
	size: number;
	sessionId: string;
	name: string | null;
	firstPrompt: string | null;
	messageCount: number;
	cwd: string | null;
	/** Whether the session's project folder still exists on disk. */
	cwdExists?: boolean;
}

export interface SessionListResult {
	project?: string;
	/** Flat listing (present only for a project-scoped query). */
	sessions?: SessionSummary[];
	projects?: Array<{ project: string; sessions: SessionSummary[] }>;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SESSION_CAP = 200;

/** Resolve the pi home directory (~/.pi by default; PI_HOME/PI_DIR override). */
export function piHome(): string {
	const env = process.env.PI_HOME ?? process.env.PI_DIR;
	if (env && isAbsolute(env)) return resolve(env);
	return join(homedir(), ".pi");
}

function sessionsRoot(): string {
	return join(piHome(), "agent", "sessions");
}

/** Encode an absolute project path into its session-directory name.
 * pi encodes `/Users/me/proj` as `--Users-me-proj--` (leading `/` dropped).
 */
export function encodeProjectDir(project: string): string {
	return `--${project.replace(/^\/+/, "").replaceAll("/", "-")}--`;
}

export interface BridgeHooks {
	/** Send a JSON object to the browser as one text frame. */
	send(obj: Record<string, unknown>): void;
}

export class Bridge {
	private hooks: BridgeHooks;
	private hello: HelloOptions | null = null;
	private child: ChildProcess | null = null;
	private stdoutDecoder = new StringDecoder("utf8");
	private stdoutBuf = "";
	private stderrTail = "";
	private killTimer: ReturnType<typeof setTimeout> | null = null;
	private closed = false;
	/** Set while a hello reply is pending on a just-spawned child. */
	private helloAckPending = false;
	private helloAckTimer: ReturnType<typeof setTimeout> | null = null;
	private helloAck: (() => void) | null = null;
	/** Whether child stdout is paused for socket backpressure. */
	private stdoutPaused = false;

	constructor(hooks: BridgeHooks) {
		this.hooks = hooks;
	}

	/** Handle one raw text frame from the browser. */
	handleClientMessage(raw: string): void {
		if (this.closed) return;
		let msg: unknown;
		try {
			msg = JSON.parse(raw);
		} catch {
			// Not JSON: if a child exists, let pi report the parse error via its
			// normal response channel; otherwise surface it ourselves.
			if (this.ensureChild()) {
				this.forwardRaw(raw);
			} else {
				this.hooks.send({
					type: "error",
					error: "invalid JSON message and no child process running",
				});
			}
			return;
		}
		if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
			this.hooks.send({ type: "error", error: "message must be a JSON object" });
			return;
		}
		const obj = msg as Record<string, unknown>;

		if (obj.type === "hello") {
			this.handleHello(obj);
			return;
		}
		if (obj.type === "meta") {
			void this.handleMeta(obj);
			return;
		}
		if (this.hello === null) {
			this.hooks.send({
				type: "hello",
				ok: false,
				error: "first message must be a hello",
			});
			return;
		}
		// RPC passthrough: forward verbatim, spawning the child on demand.
		if (!this.ensureChild()) {
			// ensureChild already emitted a spawn-error event; also answer the
			// passthrough so correlated client requests do not hang until timeout.
			const id = obj.id;
			if (typeof id === "string" || typeof id === "number") {
				this.hooks.send({
					type: "response",
					id,
					success: false,
					error: "agent process is not running",
				});
			}
			return;
		}
		this.forwardRaw(raw);
	}

	// ------------------------------------------------------------------ hello

	private handleHello(msg: Record<string, unknown>): void {
		if (typeof msg.cwd !== "undefined" && typeof msg.cwd !== "string") {
			this.hooks.send({
				type: "hello",
				ok: false,
				error: "hello.cwd must be a string",
			});
			return;
		}
		for (const key of [
			"session",
			"sessionDir",
			"name",
			"provider",
			"model",
			"thinking",
		] as const) {
			const v = msg[key];
			if (typeof v !== "undefined" && v !== null && typeof v !== "string") {
				this.hooks.send({
					type: "hello",
					ok: false,
					error: `hello.${key} must be a string`,
				});
				return;
			}
		}
		if (
			typeof msg.extraArgs !== "undefined" &&
			msg.extraArgs !== null &&
			(!Array.isArray(msg.extraArgs) ||
				msg.extraArgs.some((a) => typeof a !== "string"))
		) {
			this.hooks.send({
				type: "hello",
				ok: false,
				error: "hello.extraArgs must be an array of strings",
			});
			return;
		}
		const extraArgs = Array.isArray(msg.extraArgs)
			? (msg.extraArgs as string[])
			: undefined;
		// A child must never itself run in browser-hosting mode recursively.
		// Reject current flags and removed legacy spellings before touching
		// this.hello so no recursive browser host can spawn.
		const browserHostFlags = [
			"--rpc-web-lan",
			"--rpc-web",
			"--remote-lan",
			"--remote",
		];
		const forbidden = extraArgs
			?.map((arg) =>
				browserHostFlags.find((flag) => arg === flag || arg.startsWith(`${flag}=`)),
			)
			.find((flag) => typeof flag === "string");
		if (forbidden) {
			this.hooks.send({
				type: "hello",
				ok: false,
				error: `child extraArgs may not include ${forbidden}`,
			});
			return;
		}
		const prev = this.hello;
		this.hello = {
			cwd: strOrNull(msg.cwd),
			session: strOrNull(msg.session),
			sessionDir: strOrNull(msg.sessionDir),
			name: strOrNull(msg.name),
			provider: strOrNull(msg.provider),
			model: strOrNull(msg.model),
			thinking: strOrNull(msg.thinking),
			extraArgs,
		};
		// If a child already runs with identical options, just confirm. A new
		// hello with different options replaces the options used for respawn.
		if (this.child && this.child.exitCode === null) {
			this.hooks.send({ type: "hello", ok: true, pid: this.child.pid ?? null });
			return;
		}
		void prev; // options replaced above
		if (this.spawnChild()) {
			// Spawn errors (e.g. ENOENT) arrive asynchronously via the 'error'
			// event, so defer the success reply until the child proves alive
			// (first stdout data) or a short grace period elapses.
			this.ackHelloWhenAlive();
		} else {
			this.hello = prev;
			this.hooks.send({
				type: "hello",
				ok: false,
				error: `failed to spawn ${piBinary()} --mode rpc`,
			});
		}
	}

	// ------------------------------------------------------------------ child

	private buildArgs(hello: HelloOptions): string[] {
		const args: string[] = ["--mode", "rpc"];
		if (hello.session) args.push("--session", hello.session);
		if (hello.sessionDir) args.push("--session-dir", hello.sessionDir);
		if (hello.name) args.push("-n", hello.name);
		if (hello.provider) args.push("--provider", hello.provider);
		if (hello.model) args.push("--model", hello.model);
		if (hello.thinking) args.push("--thinking", hello.thinking);
		for (const extra of hello.extraArgs ?? []) args.push(extra);
		return args;
	}

	/**
	 * Ensure a live child exists (lazy spawn / respawn after exit).
	 * Returns true when a live child is available for writing.
	 */
	private ensureChild(): boolean {
		if (this.child && this.child.exitCode === null && !this.child.killed)
			return true;
		if (this.hello === null) return false;
		return this.spawnChild();
	}

	/** Reply hello ok:true once the child shows signs of life (or after a grace period). */
	private ackHelloWhenAlive(): void {
		this.helloAckPending = true;
		const ack = (): void => {
			if (!this.helloAckPending) return;
			this.clearHelloAck();
			this.hooks.send({ type: "hello", ok: true, pid: this.child?.pid ?? null });
		};
		this.helloAck = ack;
		this.helloAckTimer = setTimeout(ack, 500);
		this.helloAckTimer.unref?.();
	}

	private clearHelloAck(): void {
		this.helloAckPending = false;
		this.helloAck = null;
		if (this.helloAckTimer !== null) {
			clearTimeout(this.helloAckTimer);
			this.helloAckTimer = null;
		}
	}

	private spawnChild(): boolean {
		if (this.hello === null) return false;
		this.killChildInternal(false); // clean up any zombie first
		const bin = piBinary();
		let child: ChildProcess;
		try {
			child = spawn(bin, this.buildArgs(this.hello), {
				cwd: this.hello.cwd || undefined,
				env: process.env,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (err) {
			this.emitSpawnError(errMessage(err));
			return false;
		}
		if (child.stdin) child.stdin.on("error", () => {}); // EPIPE during teardown
		this.stdoutDecoder = new StringDecoder("utf8");
		this.stdoutBuf = "";
		if (this.stdoutPaused) child.stdout?.pause();
		let sawStdout = false;
		child.stdout?.on("data", (chunk: Buffer) => {
			if (!sawStdout) {
				sawStdout = true;
				this.helloAck?.(); // child is alive: settle a pending hello reply
			}
			this.onChildStdout(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-8192);
		});
		child.on("error", (err: Error) => {
			if (this.child === child) this.child = null;
			if (this.helloAckPending) {
				// The just-spawned child never came up: fail the pending hello.
				this.clearHelloAck();
				this.hooks.send({ type: "hello", ok: false, error: err.message });
			}
			this.emitSpawnError(err.message);
		});
		child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
			if (this.child === child) this.child = null;
			if (this.killTimer !== null) {
				clearTimeout(this.killTimer);
				this.killTimer = null;
			}
			this.flushStdoutRemainder();
			this.hooks.send({
				type: "child",
				event: "exit",
				code: code ?? null,
				signal: signal ?? null,
				// Abnormal exits are almost always an extension crash; include
				// the stderr tail so the browser banner/toast can say why.
				stderr: code
					? this.stderrTail.split("\n").slice(-6).join("\n").slice(-1000) ||
						undefined
					: undefined,
			});
		});
		this.child = child;
		return true;
	}

	/** Backpressure: stop reading child stdout while the socket drains. */
	pauseChild(): void {
		this.stdoutPaused = true;
		this.child?.stdout?.pause();
	}

	resumeChild(): void {
		this.stdoutPaused = false;
		this.child?.stdout?.resume();
	}

	private emitSpawnError(error: string): void {
		this.hooks.send({
			type: "child",
			event: "spawn-error",
			error,
			stderr: this.stderrTail || undefined,
		});
	}

	private onChildStdout(chunk: Buffer): void {
		this.stdoutBuf += this.stdoutDecoder.write(chunk);
		let idx: number;
		while ((idx = this.stdoutBuf.indexOf("\n")) !== -1) {
			let line = this.stdoutBuf.slice(0, idx);
			this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			this.deliverChildLine(line);
		}
	}

	private flushStdoutRemainder(): void {
		const tail = this.stdoutBuf + this.stdoutDecoder.end();
		this.stdoutBuf = "";
		if (tail.length === 0) return;
		const line = tail.endsWith("\r") ? tail.slice(0, -1) : tail;
		if (line.length > 0) this.deliverChildLine(line);
	}

	private deliverChildLine(line: string): void {
		// SAFETY: `__raw__` is an internal envelope unwrapped by unwrapOutgoing()
		// before the frame reaches any client; Record<string, unknown> is only the
		// hooks.send() parameter type, never a real payload shape.
		this.hooks.send({ type: "__raw__", line } as unknown as Record<
			string,
			unknown
		>);
	}

	private forwardRaw(raw: string): void {
		const child = this.child;
		const stdin = child?.stdin;
		if (!stdin || child.exitCode !== null || stdin.destroyed) {
			// Pipe already gone but 'exit' may not have fired yet: tell the
			// frontend so it can respawn-and-retry instead of waiting on a reply.
			this.hooks.send({ type: "child", event: "exit", code: null, signal: null });
			return;
		}
		this.trackSessionState(raw);
		// Verbatim passthrough: exactly one JSONL record per WS message.
		try {
			stdin.write(raw.replace(/\r$/, "") + "\n");
		} catch {
			this.hooks.send({ type: "child", event: "exit", code: null, signal: null });
		}
	}

	/**
	 * Keep the respawn options in sync with session navigation. If the child
	 * dies after a switch/new-session, respawning resumes the conversation
	 * the browser was actually looking at — not the one from the last hello.
	 */
	private trackSessionState(raw: string): void {
		if (this.hello === null) return;
		let msg: unknown;
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}
		if (msg === null || typeof msg !== "object") return;
		const obj = msg as Record<string, unknown>;
		if (obj.type === "new_session") {
			this.hello.session = undefined;
		} else if (
			obj.type === "switch_session" &&
			typeof obj.sessionPath === "string" &&
			obj.sessionPath.length > 0
		) {
			this.hello.session = obj.sessionPath;
		} else if (obj.type === "fork" && typeof obj.entryId === "string") {
			// Fork replaces the session file; resolved path is unknown here, but
			// dropping the stale pointer avoids resuming the pre-fork session.
			this.hello.session = undefined;
		}
	}

	// ------------------------------------------------------------------- meta

	private async handleMeta(msg: Record<string, unknown>): Promise<void> {
		const id = typeof msg.id === "string" ? msg.id : undefined;
		if (id === undefined) return; // nothing to correlate against; drop silently
		const action = typeof msg.action === "string" ? msg.action : "";
		try {
			switch (action) {
				case "ping":
					this.metaOk(id, { pong: true });
					break;
				case "sessions.list": {
					const project =
						typeof msg.project === "string" && msg.project ? msg.project : undefined;
					const data = await listSessions(project);
					this.metaOk(id, data);
					break;
				}
				case "sessions.delete": {
					const target = typeof msg.path === "string" ? msg.path : "";
					await deleteSessionFile(target);
					this.metaOk(id, { deleted: target });
					break;
				}
				case "sessions.deleteProject": {
					const proj = typeof msg.project === "string" ? msg.project : "";
					const removed = await deleteProjectSessions(proj);
					this.metaOk(id, { removed, project: proj });
					break;
				}
				case "sessions.rename": {
					const rPath = typeof msg.path === "string" ? msg.path : "";
					const rName = typeof msg.name === "string" ? msg.name : "";
					await renameSessionFile(rPath, rName);
					this.metaOk(id, { renamed: rPath, name: rName.trim().slice(0, 120) });
					break;
				}
				case "project.check": {
					let cwd = typeof msg.cwd === "string" ? msg.cwd.trim() : "";
					// Users naturally type ~/projects/foo — expand it.
					if (cwd.startsWith("~/") || cwd === "~") {
						cwd = join(homedir(), cwd.slice(1));
					}
					if (!cwd || !isAbsolute(cwd)) {
						throw new Error(
							"enter an absolute folder path (e.g. /Users/you/code/my-app)",
						);
					}
					const info = await stat(resolve(cwd));
					if (!info.isDirectory()) throw new Error("not a folder");
					this.metaOk(id, { cwd: resolve(cwd) });
					break;
				}
				case "project.info": {
					// The cwd the agent child runs in (what "new chat" targets).
					const cwd = this.hello?.cwd ?? process.cwd();
					this.metaOk(id, { cwd });
					break;
				}
				default:
					this.metaErr(id, `unknown meta action: ${action || "(none)"}`);
			}
		} catch (err) {
			this.metaErr(id, errMessage(err));
		}
	}

	private metaOk(id: string, data: unknown): void {
		this.hooks.send({ type: "meta", id, ok: true, data });
	}

	private metaErr(id: string, error: string): void {
		this.hooks.send({ type: "meta", id, ok: false, error });
	}

	// ---------------------------------------------------------------- cleanup

	/** Kill the child gracefully (SIGTERM), escalating to SIGKILL after 3s. */
	private killChildInternal(graceful: boolean): void {
		const child = this.child;
		this.child = null;
		if (this.killTimer !== null) {
			clearTimeout(this.killTimer);
			this.killTimer = null;
		}
		if (!child || child.exitCode !== null) return;
		try {
			if (graceful) child.kill("SIGTERM");
			else child.kill("SIGKILL");
		} catch {
			/* already dead */
		}
		if (graceful) {
			this.killTimer = setTimeout(() => {
				try {
					if (child.exitCode === null) child.kill("SIGKILL");
				} catch {
					/* ignore */
				}
			}, 3000);
			this.killTimer.unref?.();
		}
	}

	/** Called when the WebSocket closes: tear everything down. */
	close(): void {
		this.closed = true;
		this.killChildInternal(true);
	}
}

// ------------------------------------------------------------- raw forwarding

/**
 * The bridge needs to deliver child stdout lines verbatim (not re-serialized),
 * while meta/hello/child messages go through JSON.stringify. The server layer
 * recognizes the internal `__raw__` marker and unwraps it before sending.
 */
export function unwrapOutgoing(msg: Record<string, unknown>): string {
	const raw = msg as { type?: string; line?: unknown };
	if (raw.type === "__raw__" && typeof raw.line === "string") return raw.line;
	return JSON.stringify(msg);
}

function piBinary(): string {
	return process.env.PI_BIN || "pi";
}

function strOrNull(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// -------------------------------------------------------------- sessions.list

/** List sessions for one encoded project dir, or all projects when unspecified. */
export async function listSessions(
	project?: string,
): Promise<SessionListResult> {
	const root = sessionsRoot();
	if (project !== undefined) {
		const dir = join(root, encodeProjectDir(resolve(project)));
		const sessions = await scanSessionDir(dir);
		sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
		return { project, sessions: sessions.slice(0, SESSION_CAP) };
	}
	let dirs: string[] = [];
	try {
		dirs = await readdir(root);
	} catch {
		return { projects: [] };
	}
	const projects: Array<{ project: string; sessions: SessionSummary[] }> = [];
	for (const entry of dirs) {
		if (!(entry.startsWith("--") && entry.endsWith("--"))) continue;
		const full = join(root, entry);
		try {
			if (!(await stat(full)).isDirectory()) continue;
		} catch {
			continue;
		}
		const sessions = await scanSessionDir(full);
		sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
		if (sessions.length === 0) continue;
		const projectName = dominantCwd(sessions) ?? entry.slice(2, -2);
		projects.push({
			project: projectName,
			sessions: sessions.slice(0, SESSION_CAP),
		});
	}
	projects.sort((a, b) => latestMtime(b.sessions) - latestMtime(a.sessions));
	// Grouped shape only: do NOT emit a top-level `sessions` array here — the
	// browser treats a present `sessions` key as a flat listing, which would
	// shadow the grouped data.
	return { projects };
}

function latestMtime(sessions: SessionSummary[]): number {
	return sessions.length > 0 ? sessions[0]!.mtimeMs : 0;
}

function dominantCwd(sessions: SessionSummary[]): string | null {
	for (const s of sessions) if (s.cwd) return s.cwd;
	return null;
}

async function scanSessionDir(dir: string): Promise<SessionSummary[]> {
	let names: string[] = [];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const summaries: SessionSummary[] = [];
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		const full = join(dir, name);
		try {
			const info = await stat(full);
			if (!info.isFile()) continue;
			summaries.push(await summarizeSessionFile(full, info.size, info.mtimeMs));
		} catch {
			// File vanished or unreadable between listing and stat: skip.
		}
	}
	await annotateCwdExists(summaries);
	return summaries;
}

/**
 * Flag whether each session's project folder still exists (stat once per
 * unique cwd — folders repeat across a project's sessions).
 */
async function annotateCwdExists(summaries: SessionSummary[]): Promise<void> {
	const cache = new Map<string, boolean>();
	for (const s of summaries) {
		if (!s.cwd) continue;
		let exists = cache.get(s.cwd);
		if (exists === undefined) {
			try {
				exists = (await stat(s.cwd)).isDirectory();
			} catch {
				exists = false;
			}
			cache.set(s.cwd, exists);
		}
		s.cwdExists = exists;
	}
}

/** Stop scanning a session file after this many lines (approximate counts are fine). */
const MAX_SCAN_LINES = 20000;

async function summarizeSessionFile(
	path: string,
	size: number,
	mtimeMs: number,
): Promise<SessionSummary> {
	const summary: SessionSummary = {
		path,
		mtimeMs,
		size,
		sessionId: sessionIdFromName(path),
		name: null,
		firstPrompt: null,
		messageCount: 0,
		cwd: null,
	};
	// Stream line-by-line instead of loading whole files into memory; large
	// session archives must not blow the heap or the frontend's meta timeout.
	let stream: import("node:fs").ReadStream;
	try {
		stream = createReadStream(path, { encoding: "utf8" });
	} catch {
		return summary;
	}
	try {
		const rl = createInterface({ input: stream, crlfDelay: Infinity });
		let scanned = 0;
		let sawHeader = false;
		for await (const line of rl) {
			if (line.length === 0) continue;
			if (++scanned > MAX_SCAN_LINES) break;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue; // defensive: skip unparseable lines
			}
			if (parsed === null || typeof parsed !== "object") continue;
			const entry = parsed as Record<string, unknown>;
			summary.messageCount++;
			if (!sawHeader && entry.type === "session") {
				sawHeader = true;
				if (typeof entry.id === "string") summary.sessionId = entry.id;
				if (typeof entry.cwd === "string") summary.cwd = entry.cwd;
				if (typeof entry.name === "string" && entry.name) summary.name = entry.name;
				continue;
			}
			if (summary.firstPrompt === null && entry.type === "message") {
				const message = entry.message as Record<string, unknown> | undefined;
				if (message && message.role === "user") {
					summary.firstPrompt = extractUserText(message);
				}
			}
		}
	} catch {
		// Unreadable mid-scan: keep whatever was collected.
	}
	return summary;
}

// ------------------------------------------------------- sessions.delete/rename

/** Refuse to rewrite session files larger than this (rename rewrites bytes). */
const MAX_REWRITE_BYTES = 64 * 1024 * 1024;

interface ValidSessionPath {
	resolved: string;
}

/**
 * Validate a session-file path for destructive management operations.
 * Strictly limited to ~/.pi/agent/sessions/<encoded-project>/<file>.jsonl.
 */
function resolveSessionFilePath(path: string): ValidSessionPath {
	if (!path || !isAbsolute(path)) {
		throw new Error("session path must be absolute");
	}
	const resolved = resolve(path);
	const root = sessionsRoot();
	const relPath = relative(root, resolved);
	if (!relPath || relPath.startsWith("..") || isAbsolute(relPath)) {
		throw new Error("refusing to operate outside the sessions directory");
	}
	if (!resolved.endsWith(".jsonl")) {
		throw new Error("only .jsonl session files can be modified");
	}
	// Must be <encoded-project-dir>/<file>.jsonl — exactly two segments.
	const segments = relPath.split("/");
	const projectSegment = segments[0];
	if (
		segments.length !== 2 ||
		!projectSegment ||
		!projectSegment.startsWith("--") ||
		!projectSegment.endsWith("--")
	) {
		throw new Error("unexpected session layout; refusing to modify");
	}
	return { resolved };
}

/** Delete a session file after strict validation. */
async function deleteSessionFile(path: string): Promise<void> {
	const { resolved } = resolveSessionFilePath(path);
	// Deleting an already-gone file is fine (abandoned empty sessions may
	// never have been written to disk).
	await unlink(resolved).catch((err: NodeJS.ErrnoException) => {
		if (err.code !== "ENOENT") throw err;
	});
}

/**
 * Bulk-delete every session file of one project. The project path is
 * validated by encoding it to its session directory and confirming it sits
 * directly under the sessions root; each file then goes through the same
 * strict per-file check. Returns the number of files removed.
 */
async function deleteProjectSessions(project: string): Promise<number> {
	if (!project || !isAbsolute(project)) {
		throw new Error("project path must be absolute");
	}
	const dir = join(sessionsRoot(), encodeProjectDir(resolve(project)));
	let info;
	try {
		info = await stat(dir);
	} catch {
		return 0; // nothing stored for this project
	}
	if (!info.isDirectory()) throw new Error("unexpected sessions layout");
	let names: string[] = [];
	try {
		names = await readdir(dir);
	} catch {
		return 0;
	}
	let removed = 0;
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		const full = join(dir, name);
		const { resolved } = resolveSessionFilePath(full);
		await unlink(resolved).catch(() => {});
		removed++;
	}
	// Drop the directory when it's empty (best effort).
	await rmdir(dir).catch(() => {});
	return removed;
}

/**
 * Rename a session by rewriting the `name` field in its jsonl header line.
 * The rest of the file is preserved byte-for-byte; the write is atomic via a
 * temp file + rename in the same directory.
 */
async function renameSessionFile(path: string, name: string): Promise<void> {
	const { resolved } = resolveSessionFilePath(path);
	const trimmed = name.trim().slice(0, 120);
	const buf = await readFile(resolved);
	if (buf.length > MAX_REWRITE_BYTES) {
		throw new Error("session file too large to rename in place");
	}
	const newlineIdx = buf.indexOf(0x0a); // first \n ends the header line
	let header: Record<string, unknown> | null = null;
	if (newlineIdx !== -1) {
		try {
			const parsed: unknown = JSON.parse(
				buf.subarray(0, newlineIdx).toString("utf8"),
			);
			if (
				parsed &&
				typeof parsed === "object" &&
				(parsed as Record<string, unknown>).type === "session"
			) {
				header = parsed as Record<string, unknown>;
			}
		} catch {
			// fall through: unparseable header
		}
	}
	if (!header) {
		throw new Error("could not parse session header; refusing to rename");
	}
	if (trimmed) header.name = trimmed;
	else delete header.name; // empty name clears it
	// SAFETY: header came from JSON.parse with an object-type check above.
	const head = Buffer.from(JSON.stringify(header) + "\n", "utf8");
	const out = Buffer.concat([head, buf.subarray(newlineIdx + 1)]);
	const tmp = `${resolved}.rename-tmp`;
	await writeFile(tmp, out);
	try {
		await renameFile(tmp, resolved);
	} catch (err) {
		await unlink(tmp).catch(() => {});
		throw err;
	}
}

function sessionIdFromName(path: string): string {
	const base = path.replaceAll("\\", "/").split("/").pop() ?? path;
	const match = UUID_RE.exec(base);
	return match ? match[0] : base.replace(/\.jsonl$/, "");
}

function extractUserText(message: Record<string, unknown>): string | null {
	const content = message.content;
	let text: string | null = null;
	if (typeof content === "string") {
		text = content;
	} else if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const block of content) {
			if (
				block &&
				typeof block === "object" &&
				(block as Record<string, unknown>).type === "text"
			) {
				const t = (block as Record<string, unknown>).text;
				if (typeof t === "string") parts.push(t);
			}
		}
		text = parts.length > 0 ? parts.join("\n") : null;
	}
	if (text === null) return null;
	const flat = text.replaceAll(/\s+/g, " ").trim();
	if (flat.length === 0) return null;
	return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
}
