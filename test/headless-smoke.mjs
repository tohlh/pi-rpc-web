/**
 * Process-level smoke test for the headless RPC-web server launch:
 *   pi --mode rpc --no-session --rpc-web -e src/extension.ts
 *
 * Run: node test/headless-smoke.mjs
 *
 * For each documented shutdown signal (SIGTERM and SIGINT) this spawns a real
 * pi process with the extension loaded, waits for the URL on stderr, verifies
 * GET / serves HTML, verifies every complete stdout line is valid JSON (the
 * RPC JSONL contract must hold even while the web server runs), then signals
 * the host and verifies a clean exit plus that new HTTP connections are
 * refused. stdin stays open for the whole run: closing it would end rpc mode
 * before we exercise anything.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const extensionPath = new URL("../src/extension.ts", import.meta.url).pathname;

await smokeTest("SIGTERM");
await smokeTest("SIGINT");

console.log("headless-smoke: all assertions passed");

async function smokeTest(signal) {
	const child = spawn(
		"pi",
		["--mode", "rpc", "--no-session", "--rpc-web", "-e", extensionPath],
		{
			env: { ...process.env, PI_WEB_PORT: "0" },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);

	let stdoutBuffer = "";
	const stdoutLines = [];
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdoutBuffer += chunk;
		let newlineIndex;
		while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
			const line = stdoutBuffer.slice(0, newlineIndex);
			stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
			stdoutLines.push(line);
			assert.doesNotThrow(
				() => JSON.parse(line),
				`stdout line is not valid JSON: ${line}`,
			);
		}
	});

	const stderr = await waitForStderrUrl(child, 15_000);
	const match = stderr.match(/http:\/\/127\.0\.0\.1:(\d+)/);
	assert.ok(match, `stderr must contain a 127.0.0.1 URL, got: ${stderr}`);
	const url = `http://127.0.0.1:${match[1]}`;

	const res = await fetch(`${url}/`);
	assert.equal(res.status, 200, "GET / must return 200");
	const contentType = res.headers.get("content-type") ?? "";
	assert.match(contentType, /text\/html/, "GET / must return HTML");

	// stdin stays open here — pi --mode rpc exits when its stdin closes.

	child.kill(signal);
	const code = await exitCode(child, 10_000);
	assert.ok(
		code === 0 || child.signalCode === signal,
		`expected clean ${signal} exit, got code=${code} signal=${child.signalCode}`,
	);

	// The listener must be gone: connection refused/reset, not served.
	await assert.rejects(
		() => fetch(`${url}/`),
		(err) => {
			const code = err?.code ?? err?.cause?.code;
			return code === "ECONNREFUSED" || code === "ECONNRESET";
		},
		"listener must refuse new connections after shutdown signal",
	);
}

/** Resolve once stderr contains the serving URL; reject on timeout or early exit. */
function waitForStderrUrl(child, timeoutMs) {
	return new Promise((resolve, reject) => {
		let collected = "";
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`no URL on stderr within ${timeoutMs}ms: ${collected}`));
		}, timeoutMs);
		const onData = (chunk) => {
			collected += chunk;
			if (/http:\/\/127\.0\.0\.1:\d+/.test(collected)) {
				cleanup();
				resolve(collected);
			}
		};
		const onExit = (code, signal) => {
			cleanup();
			reject(
				new Error(
					`pi exited before serving (code=${code}, signal=${signal}): ${collected}`,
				),
			);
		};
		function cleanup() {
			clearTimeout(timer);
			child.stderr.off("data", onData);
			child.removeListener("exit", onExit);
		}
		child.stderr.on("data", onData);
		child.once("exit", onExit);
	});
}

function exitCode(child, timeoutMs) {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve(child.exitCode);
	}
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`process did not exit within ${timeoutMs}ms`));
		}, timeoutMs);
		child.once("exit", (code) => {
			clearTimeout(timer);
			resolve(code);
		});
	});
}
