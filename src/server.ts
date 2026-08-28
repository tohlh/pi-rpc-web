/**
 * HTTP server: static files from ui/ + WebSocket endpoint on any path.
 * The explicit caller controls the bind host; the default remains 127.0.0.1.
 * Zero runtime dependencies.
 */
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Bridge, unwrapOutgoing } from "./bridge.ts";
import { createLanAuth, type LanAuthOptions } from "./lan-auth.ts";
import { tryUpgradeSocket, WebSocketConnection } from "./ws.ts";

export interface StartServerOptions {
	/** Port to listen on; 0 picks an ephemeral port. */
	port?: number;
	/** Bind address; defaults to 127.0.0.1 (localhost only). */
	host?: string;
	/** Directory containing the static UI; defaults to <project>/ui. */
	uiDir?: string;
	lanAuth?: true | LanAuthOptions;
}

export interface RunningServer {
	port: number;
	url: string;
	host: string;
	authPin?: string;
	/** Graceful stop: closes all sockets (killing children) and the listener. */
	close(): Promise<void>;
}

const execFileAsync = promisify(execFile);
const MAX_IMAGE_UPLOAD_BYTES = 12 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".txt": "text/plain; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".wasm": "application/wasm",
};

function defaultUiDir(): string {
	return fileURLToPath(new URL("../ui/", import.meta.url));
}

/**
 * Start the pi-rpc-web server. Rejects with the underlying listen error
 * (e.g. EADDRINUSE) so callers can implement fallback behavior.
 */
export function startServer(
	options: StartServerOptions = {},
): Promise<RunningServer> {
	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? 7690;
	const uiDir = options.uiDir ?? defaultUiDir();
	const auth = options.lanAuth
		? createLanAuth(options.lanAuth === true ? undefined : options.lanAuth)
		: null;
	const connections = new Set<WebSocketConnection>();
	let closing = false;

	// Backpressure thresholds (bytes buffered in the socket's write path).
	const HIGH_WATER_BYTES = 1 << 20; // 1 MiB: pause child stdout
	const LOW_WATER_BYTES = 256 * 1024; // resume once drained below this
	const HARD_CAP_BYTES = 16 << 20; // 16 MiB: terminate the connection

	const server = createServer((req, res) => {
		void (async () => {
			if (auth && (await auth.gateHttp(req, res))) return;
			const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
			if (pathname === "/api/image/normalize") {
				await normalizeImageUpload(req, res);
				return;
			}
			await serveStatic(req, res, uiDir);
		})().catch(() => {
			if (!res.headersSent) plainText(res, 500, "internal server error");
			else res.destroy();
		});
	});

	server.on("upgrade", (req, rawSocket, head) => {
		const socket = rawSocket as Socket;
		if (auth && !auth.isAuthorized(req)) {
			socket.end(
				"HTTP/1.1 401 Unauthorized\r\n" +
					"Connection: close\r\n" +
					"Content-Length: 0\r\n\r\n",
			);
			return;
		}
		if (closing || !tryUpgradeSocket(req, socket)) {
			socket.destroy();
			return;
		}
		let paused = false;
		let conn: WebSocketConnection | null = null;
		const bridge = new Bridge({
			send(msg) {
				if (!(conn && conn.isOpen)) return;
				conn.sendText(unwrapOutgoing(msg));
				// Backpressure: a slow browser tab must not let the kernel socket
				// buffer grow without bound while the child keeps streaming.
				if (!paused && conn.socket.writableLength > HIGH_WATER_BYTES) {
					paused = true;
					bridge.pauseChild();
				}
				if (conn.socket.writableLength > HARD_CAP_BYTES) {
					conn.terminate(); // hopeless peer: drop it
				}
			},
		});
		socket.on("drain", () => {
			if (
				paused &&
				conn &&
				conn.isOpen &&
				conn.socket.writableLength < LOW_WATER_BYTES
			) {
				paused = false;
				bridge.resumeChild();
			}
		});
		conn = new WebSocketConnection(socket, {
			onMessage(data, isText) {
				if (!isText) return; // protocol is text frames only
				try {
					bridge.handleClientMessage(data.toString("utf8"));
				} catch {
					// Never let one bad message kill the connection loop.
				}
			},
			onClose() {
				bridge.close();
				connections.delete(conn!);
			},
		});
		connections.add(conn);
		if (head.length > 0) conn.feed(head);
	});

	return new Promise<RunningServer>((resolvePromise, rejectPromise) => {
		const onListenError = (err: Error): void => rejectPromise(err);
		server.once("error", onListenError);
		server.listen(port, host, () => {
			server.removeListener("error", onListenError);
			server.on("error", () => {}); // late errors must not crash the process
			const address = server.address();
			const actualPort =
				typeof address === "object" && address !== null ? address.port : port;
			resolvePromise({
				port: actualPort,
				host,
				url: `http://${host}:${actualPort}`,
				authPin: auth?.pin,
				async close() {
					closing = true;
					for (const conn of connections) conn.terminate();
					connections.clear();
					auth?.clear();
					await new Promise<void>((done) => server.close(() => done()));
				},
			});
		});
	});
}

async function normalizeImageUpload(
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	if (req.method !== "POST") {
		res.writeHead(405, { Allow: "POST" });
		res.end();
		return;
	}
	if (
		req.headers["content-type"] !== "application/octet-stream" ||
		req.headers["x-pi-rpc-web-image"] !== "1"
	) {
		plainText(res, 415, "unsupported image upload");
		return;
	}

	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += data.length;
		if (size > MAX_IMAGE_UPLOAD_BYTES) {
			plainText(res, 413, "image is too large");
			return;
		}
		chunks.push(data);
	}
	if (size === 0) {
		plainText(res, 400, "empty image");
		return;
	}

	const dir = await mkdtemp(join(tmpdir(), "pi-rpc-web-image-"));
	const input = join(dir, "upload.img");
	const output = join(dir, "normalized.jpg");
	try {
		await writeFile(input, Buffer.concat(chunks));
		await execFileAsync(
			"/usr/bin/sips",
			[
				"-s",
				"format",
				"jpeg",
				"--resampleHeightWidthMax",
				"4096",
				input,
				"--out",
				output,
			],
			{ timeout: 30_000, maxBuffer: 64 * 1024 },
		);
		const jpeg = await readFile(output);
		if (
			jpeg.length < 3 ||
			jpeg[0] !== 0xff ||
			jpeg[1] !== 0xd8 ||
			jpeg[2] !== 0xff
		) {
			throw new Error("converter did not produce JPEG");
		}
		res.writeHead(200, {
			"Content-Type": "image/jpeg",
			"Content-Length": jpeg.length,
			"Cache-Control": "no-store",
		});
		res.end(jpeg);
	} catch {
		plainText(res, 415, "image format could not be converted");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function serveStatic(
	req: IncomingMessage,
	res: ServerResponse,
	uiRoot: string,
): Promise<void> {
	if (req.method !== "GET" && req.method !== "HEAD") {
		res.writeHead(405, { Allow: "GET, HEAD" });
		res.end();
		return;
	}
	let pathname: string;
	try {
		pathname = decodeURIComponent(
			new URL(req.url ?? "/", "http://localhost").pathname,
		);
	} catch {
		res.writeHead(400).end();
		return;
	}
	const resolved = resolveWithin(
		uiRoot,
		pathname === "/" ? "/index.html" : pathname,
	);
	if (resolved === null) {
		plainText(res, 404, "not found");
		return;
	}
	try {
		const info = await stat(resolved);
		if (!info.isFile()) {
			plainText(res, 404, "not found");
			return;
		}
	} catch {
		plainText(res, 404, "not found");
		return;
	}
	const mime =
		MIME_TYPES[extname(resolved).toLowerCase()] ?? "application/octet-stream";
	res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
	if (req.method === "HEAD") {
		res.end();
		return;
	}
	const stream = createReadStream(resolved);
	stream.on("error", () => {
		if (!res.headersSent) plainText(res, 500, "read error");
		else res.destroy();
	});
	stream.pipe(res);
}

/**
 * Resolve a URL path inside root, rejecting traversal attempts.
 * Returns an absolute filesystem path or null when unsafe/not found-shaped.
 */
export function resolveWithin(root: string, urlPath: string): string | null {
	if (urlPath.includes("\0")) return null;
	const clean = normalize(urlPath).replaceAll("\\", "/");
	const parts = clean
		.split("/")
		.filter((p) => p.length > 0 && p !== "." && p !== "..");
	if (parts.length === 0) return null;
	return `${root.replace(/[\\/]+$/, "")}/${parts.join("/")}`;
}

function plainText(res: ServerResponse, code: number, body: string): void {
	res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
	res.end(body + "\n");
}
