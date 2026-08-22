import { describe, expect, test } from "bun:test";
import {
	BOUNDED_BODY_MAX_BYTES,
	boundedBodyBufferGrowthsForTests,
	readBoundedResponseBytes,
	readBoundedResponseBody,
} from "../src/lib/bounded-body";
import { UPSTREAM_JSON_BODY_READ_OPTIONS } from "../src/server/responses/core";
import { readBoundedJsonRequestBody } from "../src/server/request-decompress";

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
	test("the bounded JSON caller allows a full total deadline for its first byte", () => {
		expect(UPSTREAM_JSON_BODY_READ_OPTIONS.firstByteTimeoutMs)
			.toBe(UPSTREAM_JSON_BODY_READ_OPTIONS.totalTimeoutMs);
	});

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

	test("allows the first byte to arrive after the inter-chunk inactivity deadline", async () => {
		const response = new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				setTimeout(() => {
					controller.enqueue(encoder.encode("first byte"));
					controller.close();
				}, 30);
			},
		}));

		const result = await readBoundedResponseBody(response, {
			totalTimeoutMs: 100,
			inactivityTimeoutMs: 15,
			firstByteTimeoutMs: 60,
		});

		expect(result.text).toBe("first byte");
		expect(result.truncated).toBe(false);
		expect(result.inactivityTimedOut).toBe(false);
	});

	test("times out when the first byte misses its dedicated deadline", async () => {
		const response = new Response(new ReadableStream<Uint8Array>({}));

		const result = await readBoundedResponseBody(response, {
			totalTimeoutMs: 100,
			inactivityTimeoutMs: 60,
			firstByteTimeoutMs: 15,
		});

		expect(result.inactivityTimedOut).toBe(true);
		expect(result.totalTimedOut).toBe(false);
	});

	test("keeps the inter-chunk inactivity deadline after the first byte", async () => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const response = new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("first"));
				timer = setTimeout(() => controller.enqueue(encoder.encode("late")), 30);
			},
			cancel() {
				if (timer) clearTimeout(timer);
			},
		}));

		const result = await readBoundedResponseBody(response, {
			totalTimeoutMs: 100,
			inactivityTimeoutMs: 15,
			firstByteTimeoutMs: 60,
		});

		expect(result.text).toBe("first");
		expect(result.truncated).toBe(true);
		expect(result.inactivityTimedOut).toBe(true);
	});

	test("uses the inactivity deadline for the first byte by default", async () => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const response = new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				timer = setTimeout(() => controller.enqueue(encoder.encode("late")), 30);
			},
			cancel() {
				if (timer) clearTimeout(timer);
			},
		}));

		const result = await readBoundedResponseBody(response, {
			totalTimeoutMs: 100,
			inactivityTimeoutMs: 15,
		});

		expect(result.inactivityTimedOut).toBe(true);
		expect(result.totalTimedOut).toBe(false);
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

	/**
	 * The `maxBytes` option exists so one caller — the non-streaming upstream JSON
	 * read in responses/core.ts — can accept a whole completion (32 MiB ceiling)
	 * while the other eight callers keep the 64 KiB error-body default. Without
	 * these three tests the option was mutation-surviving: ignoring `maxBytes`
	 * entirely left the suite green, because the only oversize test used a body
	 * that exceeds BOTH ceilings.
	 */
	describe("an explicit maxBytes budget", () => {
		const CUSTOM_CAP = BOUNDED_BODY_MAX_BYTES * 4;

		test("accepts a body larger than the default but within the custom cap", async () => {
			const size = BOUNDED_BODY_MAX_BYTES * 2;
			const response = responseFromChunks(new Uint8Array(size).fill(0x61));

			const result = await readBoundedResponseBody(response, { maxBytes: CUSTOM_CAP });

			expect(result.text.length).toBe(size);
			expect(result.oversized).toBe(false);
			expect(result.truncated).toBe(false);
			expect(result.displaySafe).toBe(true);
		});

		test("accepts exactly the custom cap", async () => {
			const response = responseFromChunks(new Uint8Array(CUSTOM_CAP).fill(0x61));

			const result = await readBoundedResponseBody(response, { maxBytes: CUSTOM_CAP });

			expect(result.text.length).toBe(CUSTOM_CAP);
			expect(result.oversized).toBe(false);
		});

		test("rejects one byte past the custom cap and discards the prefix", async () => {
			const response = responseFromChunks(new Uint8Array(CUSTOM_CAP + 1).fill(0x61));

			const result = await readBoundedResponseBody(response, { maxBytes: CUSTOM_CAP });

			expect(result.text).toBe("");
			expect(result.oversized).toBe(true);
			expect(result.displaySafe).toBe(false);
		});

		test("a highly fragmented body under the cap is reassembled exactly", async () => {
			// Guards the geometric single-buffer accumulation: the previous per-chunk
			// array retained one object per transport chunk, which a peer can inflate
			// far beyond the payload ceiling. Correctness here is the observable part —
			// 20k one-byte chunks must still decode to exactly their content.
			const chunkCount = 20_000;
			const chunks = Array.from({ length: chunkCount }, () => new Uint8Array([0x61]));
			const response = responseFromChunks(...chunks);

			const result = await readBoundedResponseBody(response, { maxBytes: CUSTOM_CAP });

			expect(result.text.length).toBe(chunkCount);
			expect(result.text).toBe("a".repeat(chunkCount));
			expect(result.oversized).toBe(false);
		});

		test("retention is logarithmic in the body, not linear in the chunk count", async () => {
			// Growth accounting for the single buffer: it doubles a handful of times no
			// matter how the peer fragments the body. This catches an exact-fit
			// reallocation mutation; the per-chunk ARRAY shape is caught structurally in
			// the test below, because that implementation never touches this counter.
			const fine = Array.from({ length: 20_000 }, () => new Uint8Array([0x61]));
			await readBoundedResponseBody(responseFromChunks(...fine), { maxBytes: CUSTOM_CAP });
			const fineGrowths = boundedBodyBufferGrowthsForTests();

			const coarse = [new Uint8Array(20_000).fill(0x61)];
			await readBoundedResponseBody(responseFromChunks(...coarse), { maxBytes: CUSTOM_CAP });
			const coarseGrowths = boundedBodyBufferGrowthsForTests();

			// 20k one-byte chunks fit inside the 64 KiB seed: no growth at all, and the
			// same body delivered as one chunk behaves identically.
			expect(fineGrowths).toBe(coarseGrowths);
			expect(fineGrowths).toBeLessThanOrEqual(2);

			// Past the seed, growth stays logarithmic: doubling from 64 KiB to 256 KiB is
			// two reallocations no matter how the peer fragments it.
			const big = Array.from({ length: 256 }, () => new Uint8Array(1024).fill(0x61));
			await readBoundedResponseBody(responseFromChunks(...big), { maxBytes: CUSTOM_CAP });
			expect(boundedBodyBufferGrowthsForTests()).toBeLessThanOrEqual(4);
		});

		test("the accumulator never retains one object per transport chunk", async () => {
			// The retained-object shape is the actual security property and no behavioral
			// assertion can see it: a `Uint8Array[]` of chunks reassembles byte-identically
			// while holding one reference per chunk, which a fragmenting peer inflates far
			// past the payload ceiling. It also never increments the growth counter above,
			// so that test alone cannot catch it. Pin the shape, the same instrument this
			// repository uses for the relay retention rule and the star-consent guard.
			const source = (await Bun.file(new URL("../src/lib/bounded-body.ts", import.meta.url)).text())
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/(^|[^:])\/\/.*$/gm, "$1");

			// No per-chunk collection: the reader must accumulate into one buffer.
			expect(source).not.toMatch(/chunks\s*\.\s*push\s*\(/);
			expect(source).not.toMatch(/const\s+chunks\s*:\s*Uint8Array\[\]/);
			// And that buffer must be the geometric one this module documents.
			expect(source).toMatch(/let\s+retained\s*=\s*new\s+Uint8Array\(/);
			expect(source).toMatch(/retained\.set\(value,\s*retainedBytes\)/);
		});
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

	test("an already-aborted signal still settles the original response body", async () => {
		let cancelReason: unknown;
		const body = new ReadableStream<Uint8Array>({
			pull() { return new Promise<never>(() => {}); },
			cancel(reason) { cancelReason = reason; },
		}, { highWaterMark: 0 });
		const response = new Response(body);
		const controller = new AbortController();
		const reason = { code: "already-stopped" };
		controller.abort(reason);

		let caught: unknown;
		try {
			await readBoundedResponseBody(response, { signal: controller.signal });
		} catch (error) {
			caught = error;
		}
		await Promise.resolve();

		expect(caught).toBe(reason);
		expect(cancelReason).toBe(reason);
		expect(body.locked).toBe(false);
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

	test("reads arbitrary response bytes exactly through the raw primitive", async () => {
		const expected = new Uint8Array([0x00, 0xff, 0x80, 0xc3, 0x28]);
		const response = responseFromChunks(expected.subarray(0, 2), expected.subarray(2));

		const result = await readBoundedResponseBytes(response, { maxBytes: expected.byteLength });

		expect(result.oversized).toBe(false);
		expect(Array.from(result.bytes)).toEqual(Array.from(expected));
	});

	test("raw byte reads discard the prefix and cancel without draining the stream", async () => {
		let cancelled = false;
		let tailPulled = false;
		const chunks = [new Uint8Array(3), new Uint8Array(3), new Uint8Array([0x7f]), new Uint8Array([0x7e])];
		const response = new Response(new ReadableStream<Uint8Array>({
			pull(controller) {
				const chunk = chunks.shift();
				if (!chunk) return controller.close();
				if (chunk.byteLength === 1 && chunk[0] === 0x7e) tailPulled = true;
				controller.enqueue(chunk);
			},
			cancel() { cancelled = true; },
		}));

		const result = await readBoundedResponseBytes(response, { maxBytes: 5 });

		expect(result.oversized).toBe(true);
		expect(result.bytes.byteLength).toBe(0);
		expect(cancelled).toBe(true);
		// WHATWG streams may prefetch one queued chunk, but cancellation must stop further draining.
		expect(tailPulled).toBe(false);
	});

	test("raw byte reads preserve the parent abort reason and cancel the stream", async () => {
		const parent = new AbortController();
		const reason = { code: "client-stopped" };
		let cancelled = false;
		const response = new Response(new ReadableStream<Uint8Array>({
			cancel() { cancelled = true; },
		}));
		const reading = readBoundedResponseBytes(response, { maxBytes: 5, signal: parent.signal });
		parent.abort(reason);

		let caught: unknown;
		try { await reading; } catch (error) { caught = error; }
		expect(caught).toBe(reason);
		expect(cancelled).toBe(true);
	});

	test("raw byte cancellation rejection is observed", async () => {
		const unhandled: unknown[] = [];
		const listener = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", listener);
		try {
			// Bun's test runner fails a test on a real unhandled rejection even when a
			// process listener is installed. Prove the pinned runtime's event path in an
			// isolated process, then keep this process clean for the negative assertion.
			const control = Bun.spawnSync({
				cmd: [
					process.execPath,
					"-e",
					'process.on("unhandledRejection", () => console.log("observed"));'
						+ 'void Promise.reject(new Error("control"));setTimeout(() => {}, 10);',
				],
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(control.exitCode).toBe(0);
			expect(new TextDecoder().decode(control.stdout)).toContain("observed");

			let cancelCalls = 0;
			const response = new Response(new ReadableStream<Uint8Array>({
				start(controller) { controller.enqueue(new Uint8Array(6)); },
				cancel() {
					cancelCalls++;
					return Promise.reject(new Error("cancel failed"));
				},
			}));
			const result = await readBoundedResponseBytes(response, { maxBytes: 5 });
			expect(result.oversized).toBe(true);
			await new Promise(resolve => setTimeout(resolve, 10));
			expect(cancelCalls).toBe(1);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", listener);
		}
	});
});

describe("readBoundedJsonRequestBody", () => {
	test("an explicit deadline signal bounds request ingestion independently of req.signal", async () => {
		let cancelled = false;
		const request = new Request("http://localhost/import", {
			method: "POST",
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encoder.encode('{"partial":'));
				},
				cancel() { cancelled = true; },
			}),
			duplex: "half",
		} as RequestInit & { duplex: "half" });
		const deadline = new AbortController();
		const reading = readBoundedJsonRequestBody(request, 1024, undefined, { signal: deadline.signal });

		deadline.abort(new DOMException("deadline", "TimeoutError"));

		await expect(reading).rejects.toMatchObject({ name: "TimeoutError" });
		expect(request.signal.aborted).toBe(false);
		expect(cancelled).toBe(true);
	});
});
