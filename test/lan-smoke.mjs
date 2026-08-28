/**
 * Process-level LAN smoke test for the authenticated RPC-web server launch:
 *   pi --mode rpc --no-session --rpc-web --rpc-web-lan -e src/extension.ts
 *
 * Run: node test/lan-smoke.mjs
 *
 * For SIGTERM and SIGINT this spawns a real pi host with LAN auth enabled,
 * keeps stdin open for the whole run, incrementally validates every complete
 * nonblank stdout line as JSON, logs in through the real HTTP flow, verifies
 * unauthorized HTTP and WebSocket requests are rejected, then confirms the
 * process exits cleanly and leaves the port refusing new connections.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect } from "node:net";

const extensionPath = new URL("../src/extension.ts", import.meta.url).pathname;

const firstCookie = await smokeTest("SIGTERM");
await smokeTest("SIGINT", firstCookie);

console.log("lan-smoke: all assertions passed");

async function smokeTest(signal, priorCookie = null) {
	const child = spawn(
		"pi",
		[
			"--mode",
			"rpc",
			"--no-session",
			"--rpc-web",
			"--rpc-web-lan",
			"-e",
			extensionPath,
		],
		{
			env: { ...process.env, PI_WEB_PORT: "0" },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);

	let stdoutBuffer = "";
	let stdoutParseError = null;
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdoutBuffer += chunk;
		let newlineIndex;
		while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
			const line = stdoutBuffer.slice(0, newlineIndex);
			stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
			if (line.trim().length === 0) continue;
			try {
				JSON.parse(line);
			} catch (err) {
				stdoutParseError ??= new Error(`stdout line is not valid JSON: ${line}`, {
					cause: err,
				});
			}
		}
	});

	const { port, pin } = await waitForLanStartup(
		child,
		15_000,
		() => stdoutParseError,
	);
	assert.equal(stdoutParseError, null, stdoutParseError?.message);

	const baseUrl = `http://127.0.0.1:${port}`;

	let res = await fetch(`${baseUrl}/`, { redirect: "manual" });
	assert.equal(res.status, 303, "unauthenticated GET / must redirect to /login");
	assert.equal(res.headers.get("location"), "/login");

	res = await fetch(`${baseUrl}/login`, { redirect: "manual" });
	assert.equal(res.status, 200, "GET /login must succeed");
	assert.match(res.headers.get("content-type") ?? "", /text\/html/);
	const loginHtml = await res.text();
	assert.match(loginHtml, /Authorize browser/);
	assert.match(loginHtml, /id="pin"/);

	if (priorCookie) {
		const stale = await fetch(`${baseUrl}/`, {
			redirect: "manual",
			headers: { cookie: priorCookie },
		});
		assert.equal(
			stale.status,
			303,
			"session cookie from a previous process must be rejected after restart",
		);
		assert.equal(stale.headers.get("location"), "/login");
	}

	const login = await fetch(`${baseUrl}/login`, {
		method: "POST",
		redirect: "manual",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({ pin }).toString(),
	});
	assert.equal(
		login.status,
		303,
		"POST /login with the server PIN must redirect",
	);
	assert.equal(login.headers.get("location"), "/");
	const setCookie =
		login.headers.get("set-cookie") ?? login.headers.getSetCookie()?.[0] ?? "";
	assert.match(
		setCookie,
		/^pi_rpc_web_session=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\//i,
		"login must set an HttpOnly session cookie",
	);
	const cookie = setCookie.split(";", 1)[0];
	assert.ok(cookie, "login must provide a session cookie");

	const home = await fetch(`${baseUrl}/`, {
		redirect: "manual",
		headers: { cookie },
	});
	assert.equal(home.status, 200, "authenticated GET / must return the app HTML");
	assert.match(home.headers.get("content-type") ?? "", /text\/html/);
	const html = await home.text();
	assert.match(html, /id="app"/);
	assert.match(html, /js\/main\.js/);

	const upgrade = await rawWebSocketUpgrade(port);
	assert.match(upgrade, /^HTTP\/1\.1 401 Unauthorized\r\n/);

	assert.equal(stdoutParseError, null, stdoutParseError?.message);
	child.kill(signal);
	const code = await exitCode(child, 10_000);
	assert.ok(
		code === 0 || child.signalCode === signal,
		`expected clean ${signal} exit, got code=${code} signal=${child.signalCode}`,
	);
	assert.equal(stdoutParseError, null, stdoutParseError?.message);
	await waitForConnectionRefusal(baseUrl, 5_000);

	return cookie;
}

function waitForLanStartup(child, timeoutMs, getStdoutParseError) {
	return new Promise((resolve, reject) => {
		let stderr = "";
		let settled = false;
		child.stderr.setEncoding("utf8");
		const timer = setTimeout(() => {
			finish(
				reject,
				new Error(`LAN startup details not found within ${timeoutMs}ms: ${stderr}`),
			);
		}, timeoutMs);
		const onData = (chunk) => {
			stderr += chunk;
			const stdoutParseError = getStdoutParseError();
			if (stdoutParseError) {
				finish(reject, stdoutParseError);
				return;
			}
			const pinMatch = stderr.match(/^Login PIN: (\d{3}) (\d{3})$/m);
			const portMatch =
				stderr.match(/http:\/\/(?:\d{1,3}\.){3}\d{1,3}:(\d+)/) ??
				stderr.match(/listening on port (\d+)/);
			if (!pinMatch || !portMatch) return;
			finish(resolve, {
				port: Number(portMatch[1]),
				pin: `${pinMatch[1]}${pinMatch[2]}`,
				stderr,
			});
		};
		const onExit = (code, signal) => {
			finish(
				reject,
				new Error(
					`pi exited before LAN startup completed (code=${code}, signal=${signal}): ${stderr}`,
				),
			);
		};
		function finish(done, value) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.stderr.off("data", onData);
			child.removeListener("exit", onExit);
			done(value);
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

async function rawWebSocketUpgrade(port) {
	return new Promise((resolve, reject) => {
		const socket = connect({ host: "127.0.0.1", port });
		let response = "";
		let settled = false;
		const timer = setTimeout(() => {
			finish(reject, new Error("timed out waiting for raw WebSocket response"));
			socket.destroy();
		}, 5_000);
		socket.setEncoding("utf8");
		socket.on("connect", () => {
			socket.write(
				[
					"GET /ws HTTP/1.1",
					`Host: 127.0.0.1:${port}`,
					"Connection: Upgrade",
					"Upgrade: websocket",
					"Sec-WebSocket-Version: 13",
					"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
					"",
					"",
				].join("\r\n"),
			);
		});
		socket.on("data", (chunk) => {
			response += chunk;
			if (response.includes("\r\n\r\n")) {
				finish(resolve, response);
				socket.end();
			}
		});
		socket.on("end", () => finish(resolve, response));
		socket.on("error", (err) => finish(reject, err));
		function finish(done, value) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			done(value);
		}
	});
}

async function waitForConnectionRefusal(url, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let lastError = null;
	while (Date.now() < deadline) {
		try {
			await fetch(`${url}/`);
			await sleep(100);
		} catch (err) {
			const code = err?.code ?? err?.cause?.code;
			if (code === "ECONNREFUSED" || code === "ECONNRESET") return;
			lastError = err;
			await sleep(100);
		}
	}
	throw (
		lastError ??
		new Error(`listener still accepted connections after ${timeoutMs}ms`)
	);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
