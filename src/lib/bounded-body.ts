/** Maximum number of response-body bytes that may be retained for an error. */
export const BOUNDED_BODY_MAX_BYTES = 65_536;

/** Default wall-clock and continuous-silence deadlines. */
export const BOUNDED_BODY_TIMEOUT_MS = 5_000;

export interface BoundedBodyOptions {
	/** Abort the read with this signal. Its reason is rethrown by identity. */
	signal?: AbortSignal;
	/**
	 * Reject the returned promise with TypeError on malformed or truncated UTF-8
	 * instead of replacing invalid bytes, including during timeout-path flushes.
	 * Reader cancellation and lock release still run. Defaults to false.
	 */
	fatalUtf8?: boolean;
	/**
	 * Byte ceiling for retained body data. Defaults to BOUNDED_BODY_MAX_BYTES (64 KiB),
	 * which suits error bodies; callers materializing whole success payloads (e.g. a
	 * non-streaming upstream JSON completion) pass a larger explicit budget.
	 */
	maxBytes?: number;
	/** Total wall-clock deadline. Exposed for focused tests. */
	totalTimeoutMs?: number;
	/** Deadline between non-empty raw chunks. Exposed for focused tests. */
	inactivityTimeoutMs?: number;
	/** Deadline for the first non-empty raw chunk. Defaults to inactivityTimeoutMs. */
	firstByteTimeoutMs?: number;
}

export interface BoundedBodyResult {
	/** UTF-8 text retained from the response. Empty when the size limit was exceeded. */
	text: string;
	/** True when EOF was not observed. */
	truncated: boolean;
	/** True for either total-deadline or inactivity-deadline expiry. */
	timedOut: boolean;
	/** Distinguishes the wall-clock deadline from an inactivity deadline. */
	totalTimedOut: boolean;
	/** True only when continuous inactivity caused the timeout. */
	inactivityTimedOut: boolean;
	/** True when the body was observed to exceed the byte cap. */
	oversized: boolean;
	/** False means callers should use a status-only fallback, not `text`. */
	displaySafe: boolean;
}

export interface BoundedBytesOptions {
	/** Abort the read with this signal. Its reason is rethrown by identity. */
	signal?: AbortSignal;
	/** Maximum number of raw bytes retained from the response body. */
	maxBytes: number;
}

export interface BoundedBytesResult {
	/**
	 * Exact raw bytes retained from the response. Empty when the cap was exceeded.
	 *
	 * This is a view over internal storage, so `bytes.buffer.byteLength` can exceed
	 * `bytes.byteLength`. Consumers must honor the view's byteOffset and byteLength
	 * instead of reading or transferring the backing buffer directly.
	 */
	bytes: Uint8Array<ArrayBuffer>;
	/** True when the body was observed to exceed the byte cap. */
	oversized: boolean;
}

const TOTAL_TIMEOUT = Symbol("bounded body total timeout");
const INACTIVITY_TIMEOUT = Symbol("bounded body inactivity timeout");

/**
 * Test-only instrumentation: how many times the retained buffer was reallocated
 * during the most recent read. The accumulator grows geometrically, so this is
 * logarithmic in the body size and independent of how many chunks the peer sends.
 * The per-chunk array it replaced retained one object per chunk instead, which a
 * fragmenting peer can inflate far past the payload ceiling — a property no
 * correctness assertion can see, which is why it is observable here.
 */
let bufferGrowthsForTests = 0;
export function boundedBodyBufferGrowthsForTests(): number {
	return bufferGrowthsForTests;
}

function timeoutPromise(ms: number, value: symbol): { promise: Promise<symbol>; clear: () => void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const promise = new Promise<symbol>((resolve) => {
		timer = setTimeout(() => resolve(value), Math.max(0, ms));
	});
	return {
		promise,
		clear: () => {
			if (timer !== undefined) clearTimeout(timer);
		},
	};
}

function cancelWithoutWaiting(reader: ReadableStreamDefaultReader<Uint8Array>, reason?: unknown): void {
	// A hostile/broken stream may reject or never settle cancel(). Neither should
	// escape as an unhandled rejection or extend this primitive's own deadline.
	try {
		void reader.cancel(reason).catch(() => undefined);
	} catch {
		// Some stream implementations throw synchronously from cancel().
	}
}

/**
 * Consume the original response body as raw bytes under a strict memory ceiling.
 *
 * The caller owns any wall-clock deadline through `signal`, which lets one budget
 * cover both response headers and body consumption. No decoding, cloning, or teeing
 * occurs, so arbitrary upstream bytes remain unchanged.
 */
export async function readBoundedResponseBytes(
	response: Response,
	options: BoundedBytesOptions,
): Promise<BoundedBytesResult> {
	const signal = options.signal;
	if (signal?.aborted) throw signal.reason;

	const body = response.body;
	if (!body) return { bytes: new Uint8Array(0), oversized: false };

	const reader = body.getReader();
	const maxBytes = options.maxBytes;
	let retained = new Uint8Array(Math.min(maxBytes, 64 * 1024));
	let retainedBytes = 0;
	let mustCancel = false;
	let cancelReason: unknown;

	let rejectForAbort: ((reason: unknown) => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectForAbort = reject;
	});
	const onAbort = () => rejectForAbort?.(signal?.reason);
	signal?.addEventListener("abort", onAbort, { once: true });
	// Close the narrow race between the preflight check and listener install.
	if (signal?.aborted) onAbort();

	try {
		while (true) {
			const read = reader.read();
			// Observe a late read rejection when abort/cancellation wins the race.
			void read.catch(() => undefined);
			const outcome = await Promise.race([read, aborted]);
			if (signal?.aborted) {
				mustCancel = true;
				cancelReason = signal.reason;
				throw signal.reason;
			}

			const { value, done } = outcome;
			if (done) {
				return { bytes: retained.subarray(0, retainedBytes), oversized: false };
			}
			if (!value || value.byteLength === 0) continue;

			if (value.byteLength > maxBytes - retainedBytes) {
				mustCancel = true;
				cancelReason = new DOMException("Response body size limit reached", "QuotaExceededError");
				retained = new Uint8Array(0);
				retainedBytes = 0;
				return { bytes: retained, oversized: true };
			}

			if (retainedBytes + value.byteLength > retained.length) {
				const grown = new Uint8Array(
					Math.min(maxBytes, Math.max(retained.length * 2, retainedBytes + value.byteLength)),
				);
				grown.set(retained.subarray(0, retainedBytes));
				retained = grown;
			}
			retained.set(value, retainedBytes);
			retainedBytes += value.byteLength;
		}
	} catch (error) {
		mustCancel = true;
		cancelReason = error;
		throw error;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		if (mustCancel) cancelWithoutWaiting(reader, cancelReason);
		try {
			reader.releaseLock();
		} catch {
			// A pending read can keep the lock briefly while cancel settles.
		}
	}
}

function decodeUtf8(chunks: readonly Uint8Array[], fatal: boolean): string {
	const decoder = new TextDecoder("utf-8", { fatal });
	let text = "";
	for (const chunk of chunks) text += decoder.decode(chunk, { stream: true });
	// Flush an incomplete trailing UTF-8 sequence deterministically.
	text += decoder.decode();
	return text;
}

/**
 * Consume the original response body under strict memory and time bounds.
 *
 * This deliberately calls `getReader()` on `response.body`: it never clones or
 * tees the response. Once an over-limit byte is observed, all retained raw data
 * is discarded so an untrusted prefix can never become a client-facing error.
 */
export async function readBoundedResponseBody(
	response: Response,
	options: BoundedBodyOptions = {},
): Promise<BoundedBodyResult> {
	const signal = options.signal;
	if (signal?.aborted) throw signal.reason;

	const body = response.body;
	if (!body) {
		return {
			text: "",
			truncated: false,
			timedOut: false,
			totalTimedOut: false,
			inactivityTimedOut: false,
			oversized: false,
			displaySafe: true,
		};
	}

	const reader = body.getReader();
	const maxBytes = options.maxBytes ?? BOUNDED_BODY_MAX_BYTES;
	// Geometrically growing single buffer: per-chunk arrays would retain one object per
	// transport chunk, which a hostile peer could inflate into metadata amplification far
	// beyond the payload ceiling on large budgets.
	let retained = new Uint8Array(Math.min(maxBytes, 64 * 1024));
	let retainedBytes = 0;
	bufferGrowthsForTests = 0;
	let mustCancel = false;
	let cancelReason: unknown;
	const total = timeoutPromise(options.totalTimeoutMs ?? BOUNDED_BODY_TIMEOUT_MS, TOTAL_TIMEOUT);
	let inactivity = timeoutPromise(
		options.firstByteTimeoutMs ?? options.inactivityTimeoutMs ?? BOUNDED_BODY_TIMEOUT_MS,
		INACTIVITY_TIMEOUT,
	);

	let rejectForAbort: ((reason: unknown) => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectForAbort = reject;
	});
	const onAbort = () => rejectForAbort?.(signal?.reason);
	signal?.addEventListener("abort", onAbort, { once: true });
	// Close the narrow race between the preflight check and listener install.
	if (signal?.aborted) onAbort();

	try {
		while (true) {
			// Attach a rejection handler before racing. If a deadline wins and
			// cancellation later rejects this read, it remains observed.
			const read = reader.read();
			void read.catch(() => undefined);
			const outcome = await Promise.race([read, total.promise, inactivity.promise, aborted]);
			// Cancellation owns the body lifetime even when EOF/readability settles in
			// the same turn. Promise.race otherwise lets array order hide the abort.
			if (signal?.aborted) {
				mustCancel = true;
				cancelReason = signal.reason;
				throw signal.reason;
			}

			if (outcome === TOTAL_TIMEOUT || outcome === INACTIVITY_TIMEOUT) {
				mustCancel = true;
				cancelReason = new DOMException(
					outcome === TOTAL_TIMEOUT ? "Error body total timeout" : "Error body inactivity timeout",
					"TimeoutError",
				);
				return {
					text: decodeUtf8([retained.subarray(0, retainedBytes)], options.fatalUtf8 === true),
					truncated: true,
					timedOut: true,
					totalTimedOut: outcome === TOTAL_TIMEOUT,
					inactivityTimedOut: outcome === INACTIVITY_TIMEOUT,
					oversized: false,
					displaySafe: false,
				};
			}

			const { value, done } = outcome as ReadableStreamReadResult<Uint8Array>;
			if (done) {
				return {
					text: decodeUtf8([retained.subarray(0, retainedBytes)], options.fatalUtf8 === true),
					truncated: false,
					timedOut: false,
					totalTimedOut: false,
					inactivityTimedOut: false,
					oversized: false,
					displaySafe: true,
				};
			}

			if (!value || value.byteLength === 0) continue;

			inactivity.clear();
			inactivity = timeoutPromise(
				options.inactivityTimeoutMs ?? BOUNDED_BODY_TIMEOUT_MS,
				INACTIVITY_TIMEOUT,
			);

			if (value.byteLength > maxBytes - retainedBytes) {
				mustCancel = true;
				cancelReason = new DOMException("Error body size limit reached", "QuotaExceededError");
				retained = new Uint8Array(0);
				retainedBytes = 0;
				return {
					text: "",
					truncated: true,
					timedOut: false,
					totalTimedOut: false,
					inactivityTimedOut: false,
					oversized: true,
					displaySafe: false,
				};
			}

			if (retainedBytes + value.byteLength > retained.length) {
				const grown = new Uint8Array(
					Math.min(maxBytes, Math.max(retained.length * 2, retainedBytes + value.byteLength)),
				);
				grown.set(retained.subarray(0, retainedBytes));
				retained = grown;
				bufferGrowthsForTests += 1;
			}
			retained.set(value, retainedBytes);
			retainedBytes += value.byteLength;
		}
	} catch (error) {
		mustCancel = true;
		cancelReason = error;
		throw error;
	} finally {
		total.clear();
		inactivity.clear();
		signal?.removeEventListener("abort", onAbort);
		if (mustCancel) cancelWithoutWaiting(reader, cancelReason);
		try {
			reader.releaseLock();
		} catch {
			// A pending read can keep the lock briefly while cancel settles.
		}
	}
}
