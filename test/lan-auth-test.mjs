import assert from "node:assert/strict";
import { createServer } from "node:http";
import net from "node:net";
import { createLanAuth } from "../src/lan-auth.ts";

function startHarness(auth) {
	const server = createServer((req, res) => {
		void (async () => {
			if (await auth.gateHttp(req, res)) return;
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("protected");
		})();
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			resolve({
				url: `http://127.0.0.1:${port}`,
				close: () => new Promise((done) => server.close(done)),
			});
		});
	});
}

async function postLogin(url, body, headers = {}) {
	return fetch(`${url}/login`, {
		method: "POST",
		redirect: "manual",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			...headers,
		},
		body,
	});
}

async function rawRequest(
	urlString,
	{ method = "GET", path = "/", headers = {}, body = "" } = {},
) {
	const url = new URL(urlString);
	const socket = net.createConnection({
		host: url.hostname,
		port: Number(url.port),
	});
	const lines = [
		`${method} ${path} HTTP/1.1`,
		`Host: ${url.host}`,
		"Connection: close",
	];
	for (const [name, value] of Object.entries(headers))
		lines.push(`${name}: ${value}`);
	lines.push("", body);
	const request = lines.join("\r\n");

	return await new Promise((resolve, reject) => {
		const chunks = [];
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(request));
		socket.on("data", (chunk) => chunks.push(chunk));
		socket.on("error", reject);
		socket.on("end", () => {
			const response = chunks.join("");
			const [head, rawBody = ""] = response.split("\r\n\r\n");
			const [statusLine, ...headerLines] = head.split("\r\n");
			const status = Number(statusLine.split(" ")[1]);
			const parsedHeaders = new Map();
			for (const line of headerLines) {
				const index = line.indexOf(":");
				if (index === -1) continue;
				parsedHeaders.set(
					line.slice(0, index).toLowerCase(),
					line.slice(index + 1).trim(),
				);
			}
			resolve({ status, headers: parsedHeaders, body: rawBody });
		});
	});
}

const now = 1_000;
const auth = createLanAuth({
	pin: "012345",
	now: () => now,
	sessionId: () => "ab".repeat(32),
});
assert.equal(auth.pin, "012345");
assert.equal(auth.displayPin, "012 345");

const main = await startHarness(auth);
try {
	const initial = await fetch(`${main.url}/login`, { redirect: "manual" });
	assert.equal(initial.status, 200);
	assert.match(initial.headers.get("content-type") ?? "", /text\/html/);
	const initialHtml = await initial.text();
	assert.match(initialHtml, /class="brand-mark"/);
	assert.match(initialHtml, /pi<span[^>]*>·rpc·web<\/span>/);
	assert.match(initialHtml, /RPC WEB ACCESS/);
	assert.match(initialHtml, /class="feedback info"/);
	assert.doesNotMatch(initialHtml, /role="alert"/);
	assert.match(
		initialHtml,
		/<label[^>]*for="pin"[^>]*>\s*Access PIN\s*<\/label>/i,
	);
	assert.doesNotMatch(initialHtml, /012345/);

	const redirected = await fetch(`${main.url}/`, { redirect: "manual" });
	assert.equal(redirected.status, 303);
	assert.equal(redirected.headers.get("location"), "/login");

	const invalid = await postLogin(main.url, "pin=999999");
	assert.equal(invalid.status, 401);
	const invalidHtml = await invalid.text();
	assert.match(invalidHtml, /class="feedback error"/);
	assert.match(invalidHtml, /role="alert"/);
	assert.match(invalidHtml, /Invalid PIN/);
	assert.doesNotMatch(invalidHtml, /999999/);

	const goodPin = await postLogin(main.url, "pin=012+345");
	assert.equal(goodPin.status, 303);
	assert.equal(goodPin.headers.get("location"), "/");
	const cookies = goodPin.headers.getSetCookie();
	assert.equal(cookies.length, 1);
	const sessionCookie = cookies[0];
	assert.match(
		sessionCookie,
		/^pi_rpc_web_session=abababababababababababababababababababababababababababababababab;/,
	);
	assert.match(sessionCookie, /; HttpOnly;/);
	assert.match(sessionCookie, /; SameSite=Strict;/);
	assert.match(sessionCookie, /; Path=\/$/);
	assert.doesNotMatch(sessionCookie, /Max-Age=/i);
	assert.doesNotMatch(sessionCookie, /Expires=/i);
	assert.doesNotMatch(sessionCookie, /Secure/i);

	const authed = await fetch(`${main.url}/`, {
		redirect: "manual",
		headers: { cookie: sessionCookie },
	});
	assert.equal(authed.status, 200);
	assert.equal(await authed.text(), "protected");

	const unknownCookie = await fetch(`${main.url}/`, {
		redirect: "manual",
		headers: { cookie: "pi_rpc_web_session=unknown" },
	});
	assert.equal(unknownCookie.status, 303);
	assert.equal(unknownCookie.headers.get("location"), "/login");

	const malformedCookie = await fetch(`${main.url}/`, {
		redirect: "manual",
		headers: { cookie: "pi_rpc_web_session" },
	});
	assert.equal(malformedCookie.status, 303);
	assert.equal(malformedCookie.headers.get("location"), "/login");

	auth.clear();
	const cleared = await fetch(`${main.url}/`, {
		redirect: "manual",
		headers: { cookie: sessionCookie },
	});
	assert.equal(cleared.status, 303);
	assert.equal(cleared.headers.get("location"), "/login");
} finally {
	await main.close();
}

const inputValidation = await startHarness(
	createLanAuth({
		pin: "012345",
		sessionId: () => "ab".repeat(32),
	}),
);
try {
	const badMethod = await fetch(`${inputValidation.url}/login`, {
		method: "PUT",
		redirect: "manual",
	});
	assert.equal(badMethod.status >= 400 && badMethod.status < 500, true);

	const badContentType = await fetch(`${inputValidation.url}/login`, {
		method: "POST",
		redirect: "manual",
		headers: { "content-type": "text/plain" },
		body: "pin=012345",
	});
	assert.equal(
		badContentType.status >= 400 && badContentType.status < 500,
		true,
	);

	const missingPin = await postLogin(inputValidation.url, "other=value");
	assert.equal(missingPin.status >= 400 && missingPin.status < 500, true);

	const malformedEncoding = await postLogin(inputValidation.url, "pin=%ZZ");
	assert.equal(
		malformedEncoding.status >= 400 && malformedEncoding.status < 500,
		true,
	);

	const tooLarge = await rawRequest(inputValidation.url, {
		method: "POST",
		path: "/login",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			"Content-Length": String(4097),
		},
		body: `pin=${"1".repeat(4093)}`,
	});
	assert.equal(tooLarge.status >= 400 && tooLarge.status < 500, true);
	const stillRunning = await fetch(`${inputValidation.url}/login`, {
		redirect: "manual",
	});
	assert.equal(stillRunning.status, 200);
} finally {
	await inputValidation.close();
}

let lockNow = 1_000;
const lockAuth = createLanAuth({
	pin: "012345",
	now: () => lockNow,
	sessionId: () => "ab".repeat(32),
});
const lockHarness = await startHarness(lockAuth);
try {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const response = await postLogin(lockHarness.url, "pin=999999");
		assert.equal(response.status, 401);
	}
	const lockedTooLarge = await rawRequest(lockHarness.url, {
		method: "POST",
		path: "/login",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			"Content-Length": String(4097),
		},
		body: `pin=${"1".repeat(4093)}`,
	});
	assert.equal(lockedTooLarge.status, 413);
	const locked = await postLogin(lockHarness.url, "pin=012345");
	assert.equal(locked.status, 429);
	const lockedHtml = await locked.text();
	assert.match(lockedHtml, /class="feedback warning"/);
	assert.match(lockedHtml, /role="alert"/);
	assert.match(lockedHtml, /30 seconds/i);

	lockNow += 30_001;
	const postExpiryBad = await postLogin(lockHarness.url, "pin=999999");
	assert.equal(postExpiryBad.status, 401);
	const postExpiryGood = await postLogin(lockHarness.url, "pin=012345");
	assert.equal(postExpiryGood.status, 303);
} finally {
	await lockHarness.close();
}

const resetAuth = createLanAuth({
	pin: "012345",
	sessionId: () => "ab".repeat(32),
});
const resetHarness = await startHarness(resetAuth);
try {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const response = await postLogin(resetHarness.url, "pin=999999");
		assert.equal(response.status, 401);
	}
	const success = await postLogin(resetHarness.url, "pin=012345");
	assert.equal(success.status, 303);
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const response = await postLogin(resetHarness.url, "pin=999999");
		assert.equal(response.status, 401);
	}
	const stillAllowed = await postLogin(resetHarness.url, "pin=012345");
	assert.equal(stillAllowed.status, 303);
} finally {
	await resetHarness.close();
}

assert.throws(
	() => createLanAuth({ pin: "12345" }),
	/LAN PIN must be exactly six digits/,
);

const invalidSessionAuth = createLanAuth({
	pin: "012345",
	sessionId: () => "not-valid",
});
const invalidSessionHarness = await startHarness(invalidSessionAuth);
try {
	const response = await postLogin(invalidSessionHarness.url, "pin=012345");
	assert.equal(response.status, 500);
	assert.equal(response.headers.getSetCookie().length, 0);
} finally {
	await invalidSessionHarness.close();
}

const throwingSessionAuth = createLanAuth({
	pin: "012345",
	sessionId: () => {
		throw new Error("boom");
	},
});
const throwingSessionHarness = await startHarness(throwingSessionAuth);
try {
	const response = await postLogin(throwingSessionHarness.url, "pin=012345");
	assert.equal(response.status, 500);
	assert.equal(response.headers.getSetCookie().length, 0);
} finally {
	await throwingSessionHarness.close();
}

console.log("lan-auth-test: all assertions passed");
