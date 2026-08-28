/**
 * pi-rpc-web — headless RPC browser server for pi.
 *
 * Usage:
 *   pi --mode rpc --no-session --rpc-web
 *   pi --mode rpc --no-session --rpc-web --rpc-web-lan
 *
 * Registers the `--rpc-web` and `--rpc-web-lan` flags. With `--rpc-web` set,
 * session_start starts a browser server on PI_WEB_PORT or 7690, falling back
 * to an ephemeral port when busy; the URL is printed to stderr so it never
 * corrupts the JSONL RPC stream on stdout. `--rpc-web` alone stays localhost
 * only (127.0.0.1). `--rpc-web --rpc-web-lan` binds IPv4 0.0.0.0 and prints
 * LAN login details to stderr. session_shutdown stops the server.
 */
import { networkInterfaces } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { startServer, type RunningServer } from "./server.ts";

const DEFAULT_PORT = 7690;

const state = { running: null as RunningServer | null, starting: false };

export default function extension(pi: ExtensionAPI): void {
	pi.registerFlag("rpc-web", {
		description: "Start the pi-rpc-web headless browser server",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("rpc-web-lan", {
		description: "Expose pi-rpc-web to the local network with PIN login",
		type: "boolean",
		default: false,
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!pi.getFlag("rpc-web")) return;
		if (ctx.mode !== "rpc") {
			process.stderr.write(
				"pi-rpc-web: --rpc-web requires --mode rpc; run: pi --mode rpc --no-session --rpc-web\n",
			);
			return;
		}
		const lan = pi.getFlag("rpc-web-lan") === true;
		await startRpcWebServer(lan);
	});

	// The server is session-scoped: shut it down when the session ends
	// (quit, reload, session switch). Idempotent.
	pi.on("session_shutdown", async () => {
		await stopRemoteServer();
	});

	// Best-effort cleanup if the process exits without a session_shutdown.
	const cleanup = (): void => {
		const server = state.running;
		state.running = null;
		if (server) void server.close().catch(() => {});
	};
	process.once("exit", cleanup);
}

async function startRpcWebServer(lan: boolean): Promise<void> {
	if (state.running || state.starting) return;
	state.starting = true;
	try {
		const envPort = parsePort(process.env.PI_WEB_PORT);
		const requested = envPort ?? DEFAULT_PORT;
		let server: RunningServer;
		let fellBack = false;
		try {
			server = await startServer(startOptions(requested, lan));
		} catch (err) {
			if (!isAddrInUse(err)) throw err;
			server = await startServer(startOptions(0, lan));
			fellBack = true;
		}
		state.running = server;
		process.stderr.write(formatStartupMessage(server, requested, fellBack, lan));
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		process.stderr.write(`pi-rpc-web failed to start: ${detail}\n`);
	} finally {
		state.starting = false;
	}
}

function startOptions(port: number, lan: boolean) {
	return lan
		? { port, host: "0.0.0.0", lanAuth: true as const }
		: { port, host: "127.0.0.1" };
}

function formatStartupMessage(
	server: RunningServer,
	requestedPort: number,
	fellBack: boolean,
	lan: boolean,
): string {
	if (!lan) {
		const message = fellBack
			? `pi-rpc-web: port ${requestedPort} busy — serving at ${server.url} (ephemeral)`
			: `pi-rpc-web serving at ${server.url}`;
		return `${message}\n`;
	}
	if (!server.authPin) throw new Error("LAN server started without auth PIN");
	const busySuffix = fellBack
		? ` (requested port ${requestedPort} was busy)`
		: "";
	const urls = lanUrls(server.port);
	if (urls.length === 0) {
		return (
			`pi-rpc-web LAN server${busySuffix} listening on port ${server.port}; ` +
			`no active LAN IPv4 address detected\n` +
			`Login PIN: ${formatPin(server.authPin)}\n`
		);
	}
	return (
		`pi-rpc-web LAN server${busySuffix}:\n` +
		`${urls.map((url) => `  ${url}`).join("\n")}\n` +
		`Login PIN: ${formatPin(server.authPin)}\n`
	);
}

function lanUrls(port: number): string[] {
	const urls: string[] = [];
	const seen = new Set<string>();
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.internal) continue;
			const family = String(entry.family);
			if (family !== "IPv4" && family !== "4") continue;
			if (seen.has(entry.address)) continue;
			seen.add(entry.address);
			urls.push(`http://${entry.address}:${port}`);
		}
	}
	return urls;
}

function formatPin(pin: string): string {
	return `${pin.slice(0, 3)} ${pin.slice(3)}`;
}

async function stopRemoteServer(): Promise<void> {
	const server = state.running;
	state.running = null;
	if (!server) return;
	await server.close().catch(() => {});
}

/** PI_WEB_PORT parser; 0 selects an ephemeral port. Invalid values are ignored. */
function parsePort(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const port = Number.parseInt(value, 10);
	return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : undefined;
}

function isAddrInUse(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		(err as { code?: unknown }).code === "EADDRINUSE"
	);
}
