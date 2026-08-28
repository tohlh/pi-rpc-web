import assert from "node:assert/strict";
import net from "node:net";
import { startServer } from "../src/server.ts";

function onceEvent(emitter, eventName, timeoutMs = 5000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`timed out waiting for ${eventName}`));
		}, timeoutMs);
		const onEvent = (...args) => {
			cleanup();
			resolve(args);
		};
		const onError = (error) => {
			cleanup();
			reject(error);
		};
		const cleanup = () => {
			clearTimeout(timer);
			emitter.removeListener(eventName, onEvent);
			emitter.removeListener("error", onError);
		};
		emitter.once(eventName, onEvent);
		emitter.once("error", onError);
	});
}

async function postLogin(url, body) {
	return fetch(`${url}/login`, {
		method: "POST",
		redirect: "manual",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
		},
		body,
	});
}

async function readResponseHead(socket) {
	let buffered = Buffer.alloc(0);
	for (;;) {
		const [chunk] = await onceEvent(socket, "data");
		buffered = Buffer.concat([buffered, chunk]);
		const endOfHead = buffered.indexOf("\r\n\r\n");
		if (endOfHead === -1) continue;
		const head = buffered.subarray(0, endOfHead).toString("latin1");
		const [statusLine, ...headerLines] = head.split("\r\n");
		const headers = new Map();
		for (const line of headerLines) {
			const separator = line.indexOf(":");
			if (separator === -1) continue;
			headers.set(
				line.slice(0, separator).trim().toLowerCase(),
				line.slice(separator + 1).trim(),
			);
		}
		return { statusLine, headers };
	}
}

async function rawUpgrade(urlString, cookie) {
	const url = new URL(urlString);
	const socket = net.createConnection({
		host: url.hostname,
		port: Number(url.port),
	});
	await onceEvent(socket, "connect");
	const lines = [
		`GET /ws HTTP/1.1`,
		`Host: ${url.host}`,
		"Upgrade: websocket",
		"Connection: Upgrade",
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
		"Sec-WebSocket-Version: 13",
	];
	if (cookie) lines.push(`Cookie: ${cookie}`);
	lines.push("", "");
	socket.write(lines.join("\r\n"));
	const response = await readResponseHead(socket);
	return { socket, ...response };
}

async function expectHttpRefused(urlString) {
	await assert.rejects(fetch(`${urlString}/`, { redirect: "manual" }), (error) =>
		/fetch failed|ECONNREFUSED/i.test(String(error)),
	);
}

const authedServer = await startServer({
	port: 0,
	host: "127.0.0.1",
	lanAuth: {
		pin: "123456",
		sessionId: () => "cd".repeat(32),
	},
});

assert.equal(authedServer.authPin, "123456");

let authedSocket = null;
try {
	const redirected = await fetch(`${authedServer.url}/`, { redirect: "manual" });
	assert.equal(redirected.status, 303);
	assert.equal(redirected.headers.get("location"), "/login");

	const loginPage = await fetch(`${authedServer.url}/login`, {
		redirect: "manual",
	});
	assert.equal(loginPage.status, 200);
	assert.match(loginPage.headers.get("content-type") ?? "", /text\/html/i);
	const loginHtml = await loginPage.text();
	assert.match(loginHtml, /pi-rpc-web login/i);

	const login = await postLogin(authedServer.url, "pin=123456");
	assert.equal(login.status, 303);
	assert.equal(login.headers.get("location"), "/");
	const sessionCookie = login.headers.getSetCookie()[0] ?? "";
	assert.match(sessionCookie, /^pi_rpc_web_session=cd(?:cd){31};/);

	const home = await fetch(`${authedServer.url}/`, {
		redirect: "manual",
		headers: { cookie: sessionCookie },
	});
	assert.equal(home.status, 200);
	assert.match(home.headers.get("content-type") ?? "", /text\/html/i);
	const homeHtml = await home.text();
	assert.match(homeHtml, /<div id="app">/i);
	assert.doesNotMatch(homeHtml, /pi-rpc-web login/i);

	const rejectedUpgrade = await rawUpgrade(authedServer.url);
	assert.match(rejectedUpgrade.statusLine, /401 Unauthorized/);
	assert.equal(rejectedUpgrade.headers.get("connection"), "close");
	assert.doesNotMatch(rejectedUpgrade.statusLine, /101 Switching Protocols/);
	await onceEvent(rejectedUpgrade.socket, "end");

	authedSocket = await rawUpgrade(authedServer.url, sessionCookie);
	assert.match(authedSocket.statusLine, /101 Switching Protocols/);
	assert.equal(authedSocket.headers.get("upgrade"), "websocket");

	const closePromise = onceEvent(authedSocket.socket, "close");
	await authedServer.close();
	await closePromise;
	await expectHttpRefused(authedServer.url);
} finally {
	authedSocket?.socket.destroy();
}

const localServer = await startServer({
	port: 0,
	host: "127.0.0.1",
});
try {
	const localHome = await fetch(`${localServer.url}/`, { redirect: "manual" });
	assert.equal(localHome.status, 200);
	const localUpgrade = await rawUpgrade(localServer.url);
	assert.match(localUpgrade.statusLine, /101 Switching Protocols/);
	localUpgrade.socket.destroy();
} finally {
	await localServer.close();
}

console.log("server-auth-test: all assertions passed");
