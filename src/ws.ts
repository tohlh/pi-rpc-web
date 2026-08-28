/**
 * Minimal hand-rolled RFC 6455 server-side WebSocket implementation.
 *
 * Zero dependencies: uses only node:crypto and node net sockets.
 * Plain-JS-compatible TypeScript (type annotations only) so it can run
 * directly under Node's type stripping (--experimental-strip-types /
 * unflagged in Node >= 22.18).
 */
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

/** The RFC 6455 magic GUID used in the Sec-WebSocket-Accept computation. */
export const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Maximum size (bytes) of a single reassembled message. Larger messages fail the connection with 1009. */
export const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** Compute the Sec-WebSocket-Accept value for a client handshake key. */
export function computeAcceptKey(clientKey: string): string {
	return createHash("sha1").update(clientKey + WS_GUID).digest("base64");
}

export interface WebSocketHandlers {
	/** A complete data message arrived. `isText` distinguishes text (UTF-8 validated) from binary. */
	onMessage?: (data: Buffer, isText: boolean) => void;
	/** The close handshake completed (we received or sent a close frame). */
	onClose?: (code: number, reason: string) => void;
	/** A protocol-level or socket error occurred; the connection is being torn down. */
	onError?: (err: Error) => void;
}

interface FrameHeader {
	fin: boolean;
	opcode: number;
	masked: boolean;
	maskKey: Buffer | null;
	payloadLength: number;
	headerLength: number;
}

function parseFrameHeader(buf: Buffer, offset: number): FrameHeader | null {
	if (buf.length - offset < 2) return null;
	const first = buf[offset]!;
	const second = buf[offset + 1]!;
	const fin = (first & 0x80) !== 0;
	const opcode = first & 0x0f;
	const masked = (second & 0x80) !== 0;
	let len = second & 0x7f;
	let headerLength = 2;
	if (len === 126) {
		if (buf.length - offset < 4) return null;
		len = buf.readUInt16BE(offset + 2);
		headerLength = 4;
	} else if (len === 127) {
		if (buf.length - offset < 10) return null;
		const big = buf.readBigUInt64BE(offset + 2);
		if (big > BigInt(MAX_MESSAGE_BYTES)) {
			return { fin, opcode, masked, maskKey: null, payloadLength: -1, headerLength: 10 };
		}
		len = Number(big);
		headerLength = 10;
	}
	if (!masked || len < 0) {
		return { fin, opcode, masked, maskKey: null, payloadLength: len, headerLength };
	}
	if (buf.length - offset < headerLength + 4) return null;
	const maskKey = buf.subarray(offset + headerLength, offset + headerLength + 4);
	return { fin, opcode, masked, maskKey, payloadLength: len, headerLength: headerLength + 4 };
}

function unmask(payload: Buffer, maskKey: Buffer): void {
	for (let i = 0; i < payload.length; i++) {
		payload[i] = payload[i]! ^ maskKey[i & 3]!;
	}
}

/**
 * Attempt to perform a WebSocket server handshake on an upgraded socket.
 * Writes the 101 response on success (returns true), or a 400 response on
 * failure (returns false, socket left for the caller to destroy).
 */
export function tryUpgradeSocket(req: IncomingMessage, socket: Socket): boolean {
	const method = req.method ?? "";
	const upgrade = String(req.headers.upgrade ?? "").toLowerCase();
	const key = req.headers["sec-websocket-key"];
	const version = req.headers["sec-websocket-version"];
	const connection = String(req.headers.connection ?? "").toLowerCase();
	if (
		method !== "GET" ||
		upgrade !== "websocket" ||
		typeof key !== "string" ||
		key.trim() === "" ||
		!connection.split(",").map((s) => s.trim()).includes("upgrade") ||
		String(version ?? "") !== "13"
	) {
		socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
		return false;
	}
	const accept = computeAcceptKey(key.trim());
	socket.write(
		"HTTP/1.1 101 Switching Protocols\r\n" +
			"Upgrade: websocket\r\n" +
			"Connection: Upgrade\r\n" +
			`Sec-WebSocket-Accept: ${accept}\r\n` +
			"\r\n",
	);
	return true;
}

/**
 * A server-side WebSocket connection wrapping a TCP socket.
 *
 * Handles frame decoding (client frames must be masked), fragmentation,
 * ping/pong, the closing handshake, and enforces a max message size.
 */
export class WebSocketConnection {
	readonly socket: Socket;
	private handlers: WebSocketHandlers;
	private buffer: Buffer = Buffer.alloc(0);
	private closedByPeer = false;
	private closeSent = false;
	private failing = false; // a close we initiated; stop parsing buffered frames
	private destroyed = false;

	// Fragmentation assembly state
	private fragOpcode = -1;
	private fragChunks: Buffer[] = [];
	private fragBytes = 0;

	private utf8Decoder = new TextDecoder("utf-8", { fatal: true });

	constructor(socket: Socket, handlers: WebSocketHandlers = {}) {
		this.socket = socket;
		this.handlers = handlers;
		socket.on("data", (chunk: Buffer) => this.onData(chunk));
		socket.on("error", (err: Error) => this.fail(err));
		socket.on("close", () => this.destroy());
	}

	get isOpen(): boolean {
		return !this.destroyed && !this.socket.destroyed && this.socket.writable;
	}

	/** Feed bytes captured before/around wiring (e.g. the upgrade `head`). */
	feed(chunk: Buffer): void {
		if (!this.destroyed) this.onData(chunk);
	}

	private onData(chunk: Buffer): void {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		while (true) {
			const header = parseFrameHeader(this.buffer, 0);
			if (header === null) break; // need more bytes
			if (header.payloadLength === -1 || header.payloadLength > MAX_MESSAGE_BYTES) {
				this.buffer = Buffer.alloc(0); // discard the offending frame + backlog
				this.close(1009, "message too big");
				break;
			}
			if (this.buffer.length < header.headerLength + header.payloadLength) break;
			const frame = this.buffer.subarray(0, header.headerLength + header.payloadLength);
			this.buffer = this.buffer.subarray(header.headerLength + header.payloadLength);
			this.handleFrame(header, frame);
			if (this.destroyed || this.closedByPeer || this.failing) break;
		}
	}

	private handleFrame(header: FrameHeader, frame: Buffer): void {
		const payloadStart = header.headerLength;
		const rawPayload = frame.subarray(payloadStart);

		// Control frames: must not be fragmented, payload <= 125 bytes.
		if (header.opcode >= 0x8) {
			if (!header.fin || rawPayload.length > 125) {
				this.close(1002, "protocol error");
				return;
			}
			if (!header.masked) {
				// RFC 6455 §5.1: ALL client frames must be masked.
				this.close(1002, "client frames must be masked");
				return;
			}
			const payload = this.unmaskedCopy(rawPayload, header.maskKey!);
			switch (header.opcode) {
				case OP_PING:
					this.sendFrame(OP_PONG, payload);
					break;
				case OP_PONG:
					// Unsolicited pongs are ignored.
					break;
				case OP_CLOSE: {
					this.closedByPeer = true;
					let code = 1005;
					let reason = "";
					if (payload.length >= 2) {
						code = payload.readUInt16BE(0);
						reason = safeUtf8(payload.subarray(2));
					} else if (payload.length === 1) {
						code = 1002;
					}
					if (!this.closeSent) {
						// Echo the close handshake back.
						this.sendCloseRaw(code === 1005 ? 1000 : code, "");
					}
					this.handlers.onClose?.(code, reason);
					this.destroy();
					break;
				}
				default:
					this.close(1002, "unknown control opcode");
			}
			return;
		}

		// Data frames
		if (!header.masked) {
			// Clients MUST mask; treat unmasked client frames as a protocol error.
			this.close(1002, "client frames must be masked");
			return;
		}
		if ((header.opcode !== OP_CONT) === (this.fragOpcode !== -1)) {
			// New data frame while fragmented message is in progress, or a
			// continuation without a started message.
			this.close(1002, "invalid fragmentation");
			return;
		}
		const maskKey = header.maskKey;
		if (!maskKey) {
			this.close(1002, "client frames must be masked");
			return;
		}
		const payload = this.unmaskedCopy(rawPayload, maskKey);
		if (header.opcode !== OP_CONT) {
			this.fragOpcode = header.opcode;
			this.fragChunks = [payload];
			this.fragBytes = payload.length;
		} else {
			this.fragChunks.push(payload);
			this.fragBytes += payload.length;
		}
		if (this.fragBytes > MAX_MESSAGE_BYTES) {
			this.close(1009, "message too big");
			return;
		}
		if (!header.fin) return;

		const opcode = this.fragOpcode;
		const data =
			this.fragChunks.length === 1 ? this.fragChunks[0]! : Buffer.concat(this.fragChunks, this.fragBytes);
		this.fragOpcode = -1;
		this.fragChunks = [];
		this.fragBytes = 0;

		if (opcode === OP_TEXT) {
			try {
				this.utf8Decoder.decode(data); // fatal mode throws on invalid UTF-8
				this.utf8Decoder.decode(Buffer.alloc(0)); // flush
			} catch {
				this.close(1007, "invalid UTF-8 in text frame");
				return;
			}
		}
		if (opcode === OP_TEXT || opcode === OP_BINARY) {
			this.handlers.onMessage?.(data, opcode === OP_TEXT);
		} else {
			this.close(1002, "unknown data opcode");
		}
	}

	private unmaskedCopy(payload: Buffer, maskKey: Buffer): Buffer {
		const out = Buffer.from(payload); // copy so subarrays of our buffer are released
		unmask(out, maskKey);
		return out;
	}

	/** Send a text message (single unfragmented frame). Returns false if the connection is not open. */
	sendText(text: string): boolean {
		return this.sendFrame(OP_TEXT, Buffer.from(text, "utf8"));
	}

	/** Send a binary message (single unfragmented frame). */
	sendBinary(data: Buffer): boolean {
		return this.sendFrame(OP_BINARY, data);
	}

	/** Send a ping with optional payload. */
	ping(payload: Buffer = Buffer.alloc(0)): boolean {
		return this.sendFrame(OP_PING, payload.subarray(0, 125));
	}

	/** Send a pong with optional payload. */
	pong(payload: Buffer = Buffer.alloc(0)): boolean {
		return this.sendFrame(OP_PONG, payload.subarray(0, 125));
	}

	/**
	 * Begin (or complete) the closing handshake. Sends a close frame and tears
	 * down the TCP socket shortly after, unless the peer already closed.
	 */
	close(code = 1000, reason = ""): void {
		if (this.destroyed || this.closeSent) return;
		this.closeSent = true;
		this.failing = true; // stop delivering frames already in the buffer
		if (this.isOpen) {
			this.sendCloseRaw(code, reason);
			// Give the peer a moment to echo the close, then drop the TCP conn.
			const timer = setTimeout(() => this.destroy(), 1000);
			timer.unref?.();
		} else {
			this.destroy();
		}
		if (this.closedByPeer) this.destroy();
	}

	/** Immediately destroy the underlying socket. */
	terminate(): void {
		this.destroy();
	}

	private sendCloseRaw(code: number, reason: string): void {
		const reasonBytes = Buffer.from(reason, "utf8").subarray(0, 123);
		const payload = Buffer.alloc(2 + reasonBytes.length);
		payload.writeUInt16BE(code & 0xffff, 0);
		reasonBytes.copy(payload, 2);
		try {
			this.socket.write(encodeFrame(OP_CLOSE, payload));
		} catch {
			/* socket already gone */
		}
	}

	private sendFrame(opcode: number, payload: Buffer): boolean {
		if (!this.isOpen) return false;
		try {
			this.socket.write(encodeFrame(opcode, payload));
			return true;
		} catch {
			return false;
		}
	}

	private fail(err: Error): void {
		this.handlers.onError?.(err);
		this.destroy();
	}

	private destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		if (!this.closeSent && !this.closedByPeer) {
			this.handlers.onClose?.(1006, "abnormal closure");
		}
		this.buffer = Buffer.alloc(0);
		this.fragChunks = [];
		try {
			this.socket.destroy();
		} catch {
			/* ignore */
		}
	}
}

/** Encode one server-to-client frame (unmasked, per RFC 6455). */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
	const length = payload.length;
	let header: Buffer;
	if (length < 126) {
		header = Buffer.from([0x80 | opcode, length]);
	} else if (length < 65536) {
		header = Buffer.alloc(4);
		header[0] = 0x80 | opcode;
		header[1] = 126;
		header.writeUInt16BE(length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x80 | opcode;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(length), 2);
	}
	return Buffer.concat([header, payload]);
}

function safeUtf8(buf: Buffer): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(buf);
	} catch {
		return "";
	}
}
