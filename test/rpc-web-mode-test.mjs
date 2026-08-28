/**
 * RPC-web lifecycle tests for the headless extension entrypoint.
 *
 * Run: node --experimental-strip-types test/rpc-web-mode-test.mjs
 */
import assert from "node:assert/strict";
import extension from "../src/extension.ts";

process.env.PI_WEB_PORT = "0"; // ephemeral port for the test run

function createExtension(flagNames = ["rpc-web"]) {
	const enabledFlags = new Set(flagNames);
	const registrations = {
		flags: new Map(),
		commands: new Map(),
		events: new Map(),
	};
	const pi = {
		registerFlag(name, options) {
			registrations.flags.set(name, options);
		},
		registerCommand(name, options) {
			registrations.commands.set(name, options);
		},
		on(name, handler) {
			registrations.events.set(name, handler);
		},
		getFlag(name) {
			return enabledFlags.has(name);
		},
	};
	extension(pi);
	const onStart = registrations.events.get("session_start");
	const onShutdown = registrations.events.get("session_shutdown");
	assert.equal(
		typeof onStart,
		"function",
		"session_start handler must be registered",
	);
	assert.equal(
		typeof onShutdown,
		"function",
		"session_shutdown handler must be registered",
	);
	return { enabledFlags, registrations, onStart, onShutdown };
}

async function captureOutput(fn) {
	const stdout = [];
	const stderr = [];
	const originalStdout = process.stdout.write;
	const originalStderr = process.stderr.write;
	process.stdout.write = (chunk) => {
		stdout.push(String(chunk));
		return true;
	};
	process.stderr.write = (chunk) => {
		stderr.push(String(chunk));
		return true;
	};
	try {
		await fn();
	} finally {
		process.stdout.write = originalStdout;
		process.stderr.write = originalStderr;
	}
	return { stdout: stdout.join(""), stderr: stderr.join("") };
}

function parseLanPort(stderr) {
	const urlMatch = stderr.match(/http:\/\/(?:\d{1,3}\.){3}\d{1,3}:(\d+)/);
	if (urlMatch) return Number(urlMatch[1]);
	const fallbackMatch = stderr.match(/listening on port (\d+)/);
	if (fallbackMatch) return Number(fallbackMatch[1]);
	return null;
}

function parsePin(stderr) {
	const pinLine = stderr
		.split("\n")
		.find((line) => /^Login PIN: \d{3} \d{3}$/.test(line));
	assert.ok(pinLine, `missing Login PIN line in: ${JSON.stringify(stderr)}`);
	return pinLine
		.match(/(\d{3}) (\d{3})/)
		.slice(1)
		.join("");
}

const local = createExtension(["rpc-web"]);

assert.equal(
	local.registrations.flags.has("rpc-web"),
	true,
	"--rpc-web flag must be registered",
);
assert.equal(
	local.registrations.flags.has("rpc-web-lan"),
	true,
	"--rpc-web-lan flag must be registered",
);
assert.equal(local.registrations.flags.get("rpc-web")?.type, "boolean");
assert.equal(local.registrations.flags.get("rpc-web")?.default, false);
assert.equal(local.registrations.flags.get("rpc-web-lan")?.type, "boolean");
assert.equal(local.registrations.flags.get("rpc-web-lan")?.default, false);
assert.equal(local.registrations.flags.has("remote"), false);
assert.equal(local.registrations.flags.has("remote-lan"), false);
assert.equal(
	local.registrations.commands.has("web"),
	false,
	"/web command must be gone",
);

let localUrl;
try {
	let stderr = (await captureOutput(() => local.onStart({}, { mode: "rpc" })))
		.stderr;
	const lines = stderr.split("\n").filter((line) => line.length > 0);
	assert.equal(
		lines.length,
		1,
		`expected one stderr line, got: ${JSON.stringify(stderr)}`,
	);
	assert.match(lines[0], /^pi-rpc-web serving at /);

	const match = lines[0].match(/http:\/\/127\.0\.0\.1:(\d+)/);
	assert.ok(match, `stderr line must contain a 127.0.0.1 URL: ${lines[0]}`);
	localUrl = `http://127.0.0.1:${match[1]}`;

	const res = await fetch(`${localUrl}/`);
	assert.equal(res.status, 200, "GET / must be served");
	assert.match(res.headers.get("content-type") ?? "", /text\/html/);

	stderr = (await captureOutput(() => local.onStart({}, { mode: "rpc" })))
		.stderr;
	assert.doesNotMatch(stderr, /pi-rpc-web serving at /);
	assert.equal((await fetch(`${localUrl}/`)).status, 200);

	stderr = (await captureOutput(() => local.onStart({}, { mode: "tui" })))
		.stderr;
	assert.match(stderr, /pi --mode rpc --no-session --rpc-web/);
} finally {
	await local.onShutdown();
}

await assert.rejects(
	() => fetch(`${localUrl}/`),
	(err) => {
		const code = err?.code ?? err?.cause?.code;
		return code === "ECONNREFUSED" || code === "ECONNRESET";
	},
	"listener must refuse/reset connections after session_shutdown",
);

const lanOnly = createExtension(["rpc-web-lan"]);
try {
	const { stdout, stderr } = await captureOutput(() =>
		lanOnly.onStart({}, { mode: "rpc" }),
	);
	assert.equal(stdout, "");
	assert.equal(stderr, "");
} finally {
	await lanOnly.onShutdown();
}

const legacyOnly = createExtension(["remote", "remote-lan"]);
try {
	const { stdout, stderr } = await captureOutput(() =>
		legacyOnly.onStart({}, { mode: "rpc" }),
	);
	assert.equal(stdout, "");
	assert.equal(stderr, "", "removed legacy flags must not launch the server");
} finally {
	await legacyOnly.onShutdown();
}

const lan = createExtension(["rpc-web", "rpc-web-lan"]);
try {
	const { stdout, stderr } = await captureOutput(() =>
		lan.onStart({}, { mode: "rpc" }),
	);
	assert.equal(stdout, "", "LAN startup must not write to stdout");
	assert.match(stderr, /pi-rpc-web LAN server:/);
	const pinMatches = stderr.match(/^Login PIN: \d{3} \d{3}$/gm) ?? [];
	assert.equal(
		pinMatches.length,
		1,
		`expected exactly one PIN line, got: ${JSON.stringify(stderr)}`,
	);
	const urlMatches = stderr.match(/^ {2}http:\/\/.+$/gm) ?? [];
	assert.ok(
		urlMatches.length >= 1 || /no active LAN IPv4 address detected/.test(stderr),
		`expected LAN URL lines or fallback, got: ${JSON.stringify(stderr)}`,
	);

	const port = parseLanPort(stderr);
	assert.ok(
		Number.isInteger(port),
		`could not parse LAN port from: ${JSON.stringify(stderr)}`,
	);
	const pin = parsePin(stderr);
	assert.doesNotMatch(
		stdout,
		/http:\/\//,
		"LAN startup must keep URLs off stdout",
	);
	assert.ok(!stdout.includes(pin), "LAN startup must keep PINs off stdout");

	const redirected = await fetch(`http://127.0.0.1:${port}/`, {
		redirect: "manual",
	});
	assert.equal(redirected.status, 303);
	assert.equal(redirected.headers.get("location"), "/login");

	const login = await fetch(`http://127.0.0.1:${port}/login`, {
		method: "POST",
		redirect: "manual",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
		},
		body: `pin=${pin}`,
	});
	assert.equal(login.status, 303);
	assert.equal(login.headers.get("location"), "/");
	const sessionCookie = login.headers.getSetCookie()[0] ?? "";
	assert.match(sessionCookie, /^pi_rpc_web_session=[0-9a-f]{64};/i);

	const home = await fetch(`http://127.0.0.1:${port}/`, {
		redirect: "manual",
		headers: { cookie: sessionCookie },
	});
	assert.equal(home.status, 200);
} finally {
	await lan.onShutdown();
}

console.log("rpc-web-mode-test: all assertions passed");
