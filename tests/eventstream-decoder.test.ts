import { describe, expect, test } from "bun:test";
import { crc32, decodeEventStream, decodeMessage, encodeMessage } from "../src/lib/eventstream-decoder";

const enc = new TextEncoder();
const dec = new TextDecoder();

function streamOf(...frames: Uint8Array[]): ReadableStream<Uint8Array> {
	// Concatenate then re-slice at awkward boundaries to exercise chunk splitting.
	const joined = Buffer.concat(frames.map(f => Buffer.from(f)));
	const chunks: Uint8Array[] = [];
	for (let i = 0; i < joined.length; i += 7) chunks.push(joined.subarray(i, Math.min(i + 7, joined.length)));
	let i = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i < chunks.length) controller.enqueue(chunks[i++]);
			else controller.close();
		},
	});
}

function streamChunks(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	let i = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i < chunks.length) controller.enqueue(chunks[i++]);
			else controller.close();
		},
	});
}

function refreshMessageCrc(frame: Uint8Array): Uint8Array {
	const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
	const total = dv.getUint32(0, false);
	dv.setUint32(total - 4, crc32(frame.subarray(0, total - 4)), false);
	return frame;
}

function refreshPreludeAndMessageCrc(frame: Uint8Array): Uint8Array {
	const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
	dv.setUint32(8, crc32(frame.subarray(0, 8)), false);
	return refreshMessageCrc(frame);
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
	for await (const _ of decodeEventStream(stream)) {
		// drain
	}
}

describe("eventstream-decoder", () => {
	test("decodeMessage round-trips headers + payload", () => {
		const frame = encodeMessage({ ":event-type": "assistantResponseEvent", ":message-type": "event" }, enc.encode("hi"));
		const msg = decodeMessage(frame);
		expect(msg.headers[":event-type"]).toBe("assistantResponseEvent");
		expect(msg.headers[":message-type"]).toBe("event");
		expect(dec.decode(msg.payload)).toBe("hi");
	});

	test("message CRC mismatch throws", () => {
		const frame = encodeMessage({ ":event-type": "x" }, enc.encode("body"));
		frame[frame.length - 5] ^= 0xff; // corrupt last payload byte before trailing CRC
		expect(() => decodeMessage(frame)).toThrow(/CRC mismatch/);
	});

	test("prelude CRC mismatch throws", () => {
		const frame = encodeMessage({ ":event-type": "x" }, enc.encode("body"));
		frame[4] ^= 0xff; // corrupt headers-length (inside prelude) without fixing prelude CRC
		expect(() => decodeMessage(frame)).toThrow(/CRC mismatch/);
	});

	test("headers length beyond payload boundary throws controlled framing error", () => {
		const frame = encodeMessage({ "x": "abc" }, enc.encode("body"));
		const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
		dv.setUint32(4, dv.getUint32(0, false), false);
		expect(() => decodeMessage(refreshPreludeAndMessageCrc(frame))).toThrow(/headers length exceeds/);
	});

	test("advertised oversized header block fails before buffering the full frame", async () => {
		const prelude = new Uint8Array(12);
		const view = new DataView(prelude.buffer);
		view.setUint32(0, 256 * 1024, false);
		view.setUint32(4, 128 * 1024 + 1, false);
		view.setUint32(8, crc32(prelude.subarray(0, 8)), false);
		await expect(drain(streamChunks(prelude))).rejects.toThrow(/headers length .* exceeds maximum/);
	});

	test("truncated string header throws controlled header error", () => {
		const frame = encodeMessage({ "x": "abc" }, enc.encode("body"));
		const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
		dv.setUint16(15, 10, false); // after nameLen(12), name(13), type(14)
		expect(() => decodeMessage(refreshMessageCrc(frame))).toThrow(/truncated header string value/);
	});

	test("advertised oversized frame fails before buffering indefinitely", async () => {
		const prelude = new Uint8Array(4);
		new DataView(prelude.buffer).setUint32(0, 16 * 1024 * 1024 + 1, false);
		await expect(drain(streamChunks(prelude))).rejects.toThrow(/exceeds maximum/);
	});

	test("decodeEventStream yields multiple frames across chunk boundaries", async () => {
		const f1 = encodeMessage({ ":event-type": "a" }, enc.encode('{"content":"foo"}'));
		const f2 = encodeMessage({ ":event-type": "b" }, enc.encode('{"name":"bash","toolUseId":"t1"}'));
		const out: string[] = [];
		for await (const m of decodeEventStream(streamOf(f1, f2))) {
			out.push(`${m.headers[":event-type"]}:${dec.decode(m.payload)}`);
		}
		expect(out).toEqual(['a:{"content":"foo"}', 'b:{"name":"bash","toolUseId":"t1"}']);
	});

	test("single frame decodes when split at every byte boundary", async () => {
		const frame = encodeMessage({ ":event-type": "split" }, enc.encode("payload"));
		for (let split = 1; split < frame.length; split++) {
			const out: string[] = [];
			for await (const msg of decodeEventStream(streamChunks(frame.subarray(0, split), frame.subarray(split)))) {
				out.push(`${msg.headers[":event-type"]}:${dec.decode(msg.payload)}`);
			}
			expect(out).toEqual(["split:payload"]);
		}
	});

	test("crc32 matches a known vector (zlib of 'hello')", () => {
		// zlib.crc32("hello") = 0x3610a686
		expect(crc32(enc.encode("hello")) >>> 0).toBe(0x3610a686);
	});

	test("cancels the underlying reader on early consumer termination (no orphaned read)", async () => {
		let cancelled = false;
		let pulls = 0;
		const frame = encodeMessage({ ":message-type": "event" }, enc.encode("one"));
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls++;
				if (pulls === 1) { controller.enqueue(frame); return; }
				// Never resolve further: a read after the first frame stays pending until cancel().
			},
			cancel() { cancelled = true; },
		});

		const gen = decodeEventStream(stream);
		const first = await gen.next();
		expect(first.done).toBe(false);
		// Consumer stops early (e.g. web-search loop break / turn abort) → generator.return runs finally.
		await gen.return(undefined as never);
		expect(cancelled).toBe(true);
	});

	test("clean completion still yields every frame and closes normally", async () => {
		const f1 = encodeMessage({ ":message-type": "event" }, enc.encode("a"));
		const f2 = encodeMessage({ ":message-type": "event" }, enc.encode("b"));
		const out: string[] = [];
		for await (const msg of decodeEventStream(streamOf(f1, f2))) out.push(dec.decode(msg.payload));
		expect(out).toEqual(["a", "b"]);
	});
});
