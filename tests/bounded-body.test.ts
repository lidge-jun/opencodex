import { describe, expect, test } from "bun:test";
import {
	BOUNDED_BODY_MAX_BYTES,
	readBoundedResponseBody,
} from "../src/lib/bounded-body";

const encoder = new TextEncoder();

function responseFromChunks(...chunks: Uint8Array[]): Response {
	let index = 0;
	return new Response(new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index < chunks.length) controller.enqueue(chunks[index++]);
			else controller.close();
		},
	}));
}

describe("readBoundedResponseBody", () => {
	test("reads multiple chunks and flushes split UTF-8", async () => {
		const bytes = encoder.encode("alpha 한글 🌍");
		const response = responseFromChunks(bytes.subarray(0, 8), bytes.subarray(8, 11), bytes.subarray(11));

		expect(await readBoundedResponseBody(response)).toEqual({
			text: "alpha 한글 🌍",
			truncated: false,
			timedOut: false,
			totalTimedOut: false,
			inactivityTimedOut: false,
			oversized: false,
			displaySafe: true,
		});
	});

	test("empty chunks do not reset the inactivity deadline", async () => {
		let timer: ReturnType<typeof setInterval> | undefined;
		let cancelled = false;
		const response = new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				timer = setInterval(() => controller.enqueue(new Uint8Array()), 3);
			},
			cancel() {
				cancelled = true;
				if (timer) clearInterval(timer);
			},
		}));

		const result = await readBoundedResponseBody(response, { totalTimeoutMs: 100, inactivityTimeoutMs: 15 });
		expect(result.inactivityTimedOut).toBe(true);
		expect(result.totalTimedOut).toBe(false);
		expect(cancelled).toBe(true);
	});

	test("a partial body followed by silence times out and flushes UTF-8", async () => {
		const response = new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([0xe2, 0x82]));
			},
		}));
		const result = await readBoundedResponseBody(response, { totalTimeoutMs: 100, inactivityTimeoutMs: 15 });
		expect(result.text).toBe("�");
		expect(result.truncated).toBe(true);
		expect(result.inactivityTimedOut).toBe(true);
		expect(result.displaySafe).toBe(false);
	});

	test("continuous non-empty trickle still hits the total deadline", async () => {
		let timer: ReturnType<typeof setInterval> | undefined;
		const response = new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				timer = setInterval(() => controller.enqueue(encoder.encode("x")), 4);
			},
			cancel() {
				if (timer) clearInterval(timer);
			},
		}));

		const result = await readBoundedResponseBody(response, { totalTimeoutMs: 25, inactivityTimeoutMs: 15 });
		expect(result.totalTimedOut).toBe(true);
		expect(result.inactivityTimedOut).toBe(false);
		expect(result.text.length).toBeGreaterThan(0);
		expect(result.displaySafe).toBe(false);
	});

	test("accepts exactly the cap when EOF follows", async () => {
		const response = responseFromChunks(new Uint8Array(BOUNDED_BODY_MAX_BYTES).fill(0x61));
		const result = await readBoundedResponseBody(response);
		expect(result.text.length).toBe(BOUNDED_BODY_MAX_BYTES);
		expect(result.truncated).toBe(false);
		expect(result.oversized).toBe(false);
	});

	test("one oversized chunk is discarded and cancels the reader", async () => {
		let cancelled = false;
		const response = new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(BOUNDED_BODY_MAX_BYTES + 1).fill(0x61));
			},
			cancel() { cancelled = true; },
		}));
		const result = await readBoundedResponseBody(response);
		expect(result.text).toBe("");
		expect(result.oversized).toBe(true);
		expect(result.displaySafe).toBe(false);
		expect(cancelled).toBe(true);
	});

	test("parent abort rejects with the exact reason object", async () => {
		const controller = new AbortController();
		const reason = { code: "parent-stopped" };
		const response = new Response(new ReadableStream<Uint8Array>({}));
		const reading = readBoundedResponseBody(response, {
			signal: controller.signal,
			totalTimeoutMs: 100,
			inactivityTimeoutMs: 100,
		});
		controller.abort(reason);
		try {
			await reading;
			expect.unreachable("read should reject");
		} catch (error) {
			expect(error).toBe(reason);
		}
	});

	test("parent abort wins when EOF settles in the same turn", async () => {
		const parent = new AbortController();
		const reason = new Error("same-turn cancel");
		const response = new Response(new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.close();
				parent.abort(reason);
			},
		}));

		let caught: unknown;
		try {
			await readBoundedResponseBody(response, {
				signal: parent.signal,
				totalTimeoutMs: 100,
				inactivityTimeoutMs: 100,
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBe(reason);
	});

	test("cancel rejection is observed rather than becoming unhandled", async () => {
		const unhandled: unknown[] = [];
		const listener = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", listener);
		try {
			const response = new Response(new ReadableStream<Uint8Array>({
				cancel() { return Promise.reject(new Error("cancel failed")); },
			}));
			const result = await readBoundedResponseBody(response, { totalTimeoutMs: 10, inactivityTimeoutMs: 10 });
			expect(result.timedOut).toBe(true);
			await new Promise(resolve => setTimeout(resolve, 0));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", listener);
		}
	});

	test("consumes the original response body without cloning", async () => {
		const response = responseFromChunks(encoder.encode("original"));
		let cloneCalls = 0;
		response.clone = () => {
			cloneCalls++;
			throw new Error("must not clone");
		};

		const result = await readBoundedResponseBody(response);
		expect(result.text).toBe("original");
		expect(response.bodyUsed).toBe(true);
		expect(cloneCalls).toBe(0);
	});
});
