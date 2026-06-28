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

	test("decodeEventStream yields multiple frames across chunk boundaries", async () => {
		const f1 = encodeMessage({ ":event-type": "a" }, enc.encode('{"content":"foo"}'));
		const f2 = encodeMessage({ ":event-type": "b" }, enc.encode('{"name":"bash","toolUseId":"t1"}'));
		const out: string[] = [];
		for await (const m of decodeEventStream(streamOf(f1, f2))) {
			out.push(`${m.headers[":event-type"]}:${dec.decode(m.payload)}`);
		}
		expect(out).toEqual(['a:{"content":"foo"}', 'b:{"name":"bash","toolUseId":"t1"}']);
	});

	test("crc32 matches a known vector (zlib of 'hello')", () => {
		// zlib.crc32("hello") = 0x3610a686
		expect(crc32(enc.encode("hello")) >>> 0).toBe(0x3610a686);
	});
});
