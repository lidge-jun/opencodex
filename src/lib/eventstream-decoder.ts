/**
 * `application/vnd.amazon.eventstream` decoder.
 *
 * Ported from jawcode `packages/ai/src/providers/aws-eventstream.ts` (verbatim logic).
 * Foundational dependency for AWS-eventstream providers: kiro (CodeWhisperer
 * GenerateAssistantResponse) and amazon-bedrock (Converse). Self-contained — only
 * uses Buffer / DataView / TextDecoder (Bun + Node compatible).
 *
 * Wire format (all integers big-endian):
 *
 *   [total length     u32]
 *   [headers length   u32]
 *   [prelude CRC32    u32]   <- CRC over the first 8 bytes
 *   [headers          headers_length]
 *   [payload          total_length - headers_length - 16]
 *   [message CRC32    u32]   <- CRC over the entire message minus the trailing 4 bytes
 *
 * Headers: a sequence of `[name_len u8][name utf8][value_type u8][value …]`.
 */

const PRELUDE_LEN = 8;
const PRELUDE_CRC_LEN = 4;
const MESSAGE_CRC_LEN = 4;
const HEADER_BLOCK_OFFSET = PRELUDE_LEN + PRELUDE_CRC_LEN;
const MIN_MESSAGE_LEN = HEADER_BLOCK_OFFSET + MESSAGE_CRC_LEN;
const MAX_MESSAGE_LEN = 16 * 1024 * 1024;
const MAX_HEADERS_LEN = 128 * 1024;

export interface EventStreamMessage {
	/** Header casing is preserved verbatim (e.g. `:event-type`, `:message-type`). */
	headers: Record<string, string>;
	payload: Uint8Array;
}

/** CRC32 (IEEE / zlib polynomial 0xEDB88320), matches `@aws-crypto/crc32`. */
const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[i] = c >>> 0;
	}
	return t;
})();

export function crc32(bytes: Uint8Array, seed = 0): number {
	let c = (seed ^ 0xffffffff) >>> 0;
	for (let i = 0; i < bytes.length; i++) c = (CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0;
	return (c ^ 0xffffffff) >>> 0;
}

/**
 * Decode a single, fully buffered eventstream message. Throws if the framing is
 * malformed or either CRC mismatches.
 */
export function decodeMessage(frame: Uint8Array): EventStreamMessage {
	if (frame.length < MIN_MESSAGE_LEN) throw new Error("eventstream: frame too short");
	const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
	const total = view.getUint32(0, false);
	if (total !== frame.length) throw new Error(`eventstream: framed length ${total} != buffer ${frame.length}`);
	if (total > MAX_MESSAGE_LEN) throw new Error(`eventstream: total length ${total} exceeds maximum`);
	const headersLen = view.getUint32(4, false);
	const preludeCrc = view.getUint32(8, false);
	const computedPreludeCrc = crc32(frame.subarray(0, PRELUDE_LEN));
	if (computedPreludeCrc !== preludeCrc) throw new Error("eventstream: prelude CRC mismatch");
	if (headersLen > MAX_HEADERS_LEN) throw new Error(`eventstream: headers length ${headersLen} exceeds maximum`);
	if (headersLen > total - MIN_MESSAGE_LEN) throw new Error("eventstream: headers length exceeds frame payload");
	const msgCrc = view.getUint32(total - MESSAGE_CRC_LEN, false);
	const computedMsgCrc = crc32(frame.subarray(0, total - MESSAGE_CRC_LEN));
	if (computedMsgCrc !== msgCrc) throw new Error("eventstream: message CRC mismatch");

	const headersBytes = frame.subarray(HEADER_BLOCK_OFFSET, HEADER_BLOCK_OFFSET + headersLen);
	const payload = frame.subarray(HEADER_BLOCK_OFFSET + headersLen, total - MESSAGE_CRC_LEN);
	return { headers: parseHeaders(headersBytes), payload };
}

function parseHeaders(buf: Uint8Array): Record<string, string> {
	const out: Record<string, string> = {};
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	const decoder = new TextDecoder();
	let p = 0;
	const need = (n: number, label: string) => {
		if (p + n > buf.length) throw new Error(`eventstream: truncated header ${label}`);
	};
	while (p < buf.length) {
		need(1, "name length");
		const nameLen = view.getUint8(p);
		p += 1;
		need(nameLen, "name");
		const name = decoder.decode(buf.subarray(p, p + nameLen));
		p += nameLen;
		need(1, "type");
		const type = view.getUint8(p);
		p += 1;
		switch (type) {
			case 0: // bool true
				out[name] = "true";
				break;
			case 1: // bool false
				out[name] = "false";
				break;
			case 2: // byte
				need(1, "byte value");
				out[name] = String(view.getInt8(p));
				p += 1;
				break;
			case 3: // short
				need(2, "short value");
				out[name] = String(view.getInt16(p, false));
				p += 2;
				break;
			case 4: // integer
				need(4, "integer value");
				out[name] = String(view.getInt32(p, false));
				p += 4;
				break;
			case 5: // long — decimal string to avoid precision loss
				need(8, "long value");
				out[name] = bigIntFromBytes(buf.subarray(p, p + 8)).toString();
				p += 8;
				break;
			case 6: {
				// byte array — base64 for safe transport
				need(2, "byte-array length");
				const len = view.getUint16(p, false);
				p += 2;
				need(len, "byte-array value");
				out[name] = Buffer.from(buf.buffer, buf.byteOffset + p, len).toString("base64");
				p += len;
				break;
			}
			case 7: {
				// string
				need(2, "string length");
				const len = view.getUint16(p, false);
				p += 2;
				need(len, "string value");
				out[name] = decoder.decode(buf.subarray(p, p + len));
				p += len;
				break;
			}
			case 8: // timestamp (ms since epoch as i64)
				need(8, "timestamp value");
				out[name] = new Date(Number(bigIntFromBytes(buf.subarray(p, p + 8)))).toISOString();
				p += 8;
				break;
			case 9: {
				// uuid
				need(16, "uuid value");
				const u = buf.subarray(p, p + 16);
				const hex: string[] = [];
				for (let i = 0; i < 16; i++) hex.push(u[i].toString(16).padStart(2, "0"));
				out[name] =
					`${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
				p += 16;
				break;
			}
			default:
				throw new Error(`eventstream: unknown header value type ${type}`);
		}
	}
	return out;
}

function bigIntFromBytes(b: Uint8Array): bigint {
	let v = 0n;
	for (let i = 0; i < b.length; i++) v = (v << 8n) | BigInt(b[i]);
	// sign-extend (two's complement)
	if (b.length === 8 && b[0] & 0x80) v -= 1n << 64n;
	return v;
}

/**
 * Async generator that consumes a `ReadableStream<Uint8Array>` (a fetch response
 * body) and yields fully-framed messages, handling arbitrary chunk boundaries.
 */
export async function* decodeEventStream(source: ReadableStream<Uint8Array>): AsyncGenerator<EventStreamMessage> {
	const reader = source.getReader();
	let buf: Uint8Array = new Uint8Array(0);
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (value && value.length > 0) buf = buf.length === 0 ? value : Buffer.concat([buf, value]);
			let offset = 0;
			while (buf.length - offset >= 4) {
				const dv = new DataView(buf.buffer, buf.byteOffset + offset, buf.length - offset);
				const total = dv.getUint32(0, false);
				if (total < MIN_MESSAGE_LEN) throw new Error(`eventstream: total length ${total} below minimum`);
				if (total > MAX_MESSAGE_LEN) throw new Error(`eventstream: total length ${total} exceeds maximum`);
				if (buf.length - offset >= HEADER_BLOCK_OFFSET) {
					const headersLen = dv.getUint32(4, false);
					const preludeCrc = dv.getUint32(8, false);
					const computedPreludeCrc = crc32(buf.subarray(offset, offset + PRELUDE_LEN));
					if (computedPreludeCrc !== preludeCrc) throw new Error("eventstream: prelude CRC mismatch");
					if (headersLen > MAX_HEADERS_LEN) throw new Error(`eventstream: headers length ${headersLen} exceeds maximum`);
				}
				if (buf.length - offset < total) break;
				const frame = buf.subarray(offset, offset + total);
				yield decodeMessage(frame);
				offset += total;
			}
			if (offset > 0) buf = buf.slice(offset);
			if (buf.length > MAX_MESSAGE_LEN) throw new Error(`eventstream: buffered frame exceeds maximum ${MAX_MESSAGE_LEN}`);
			if (done) break;
		}
		if (buf.length > 0) throw new Error("eventstream: truncated message at end of stream");
	} finally {
		// Early termination (consumer break/return, turn abort, or an HTTP/2 mid-body reset) can leave
		// an in-flight `reader.read()` pending when this generator's `finally` runs. Releasing the lock
		// does NOT settle that orphaned read — Bun then surfaces it as an off-path
		// `unhandledRejection: TypeError: null is not an object` that no caller try/catch can intercept.
		// Cancel first (settles the pending read + closes the body), then release. On a clean `done`
		// finish the read is already settled, so cancel() is a harmless no-op.
		try {
			await reader.cancel();
		} catch {
			/* body already errored/closed — nothing to cancel */
		}
		try {
			reader.releaseLock();
		} catch {
			/* lock already released by cancel() on some runtimes */
		}
	}
}

/** Build a single eventstream frame (string headers only) — used by tests and fixtures. */
export function encodeMessage(headers: Record<string, string>, payload: Uint8Array): Uint8Array {
	const enc = new TextEncoder();
	const headerParts: Uint8Array[] = [];
	for (const [name, value] of Object.entries(headers)) {
		const nameBytes = enc.encode(name);
		const valueBytes = enc.encode(value);
		const head = new Uint8Array(1 + nameBytes.length + 1 + 2);
		const hv = new DataView(head.buffer);
		hv.setUint8(0, nameBytes.length);
		head.set(nameBytes, 1);
		hv.setUint8(1 + nameBytes.length, 7); // string type
		hv.setUint16(1 + nameBytes.length + 1, valueBytes.length, false);
		headerParts.push(head, valueBytes);
	}
	const headersBytes = Buffer.concat(headerParts.map(p => Buffer.from(p)));
	const total = HEADER_BLOCK_OFFSET + headersBytes.length + payload.length + MESSAGE_CRC_LEN;
	const frame = new Uint8Array(total);
	const dv = new DataView(frame.buffer);
	dv.setUint32(0, total, false);
	dv.setUint32(4, headersBytes.length, false);
	dv.setUint32(8, crc32(frame.subarray(0, PRELUDE_LEN)), false);
	frame.set(headersBytes, HEADER_BLOCK_OFFSET);
	frame.set(payload, HEADER_BLOCK_OFFSET + headersBytes.length);
	dv.setUint32(total - MESSAGE_CRC_LEN, crc32(frame.subarray(0, total - MESSAGE_CRC_LEN)), false);
	return frame;
}
