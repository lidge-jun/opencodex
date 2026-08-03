/** Maximum number of response-body bytes that may be retained for an error. */
export const BOUNDED_BODY_MAX_BYTES = 65_536;

/** Default wall-clock and continuous-silence deadlines. */
export const BOUNDED_BODY_TIMEOUT_MS = 5_000;

export interface BoundedBodyOptions {
	/** Abort the read with this signal. Its reason is rethrown by identity. */
	signal?: AbortSignal;
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

const TOTAL_TIMEOUT = Symbol("bounded body total timeout");
const INACTIVITY_TIMEOUT = Symbol("bounded body inactivity timeout");

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

function decodeUtf8(chunks: readonly Uint8Array[]): string {
	const decoder = new TextDecoder();
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
	let mustCancel = false;
	let cancelReason: unknown;
	const total = timeoutPromise(options.totalTimeoutMs ?? BOUNDED_BODY_TIMEOUT_MS, TOTAL_TIMEOUT);
	let inactivity = timeoutPromise(
		options.inactivityTimeoutMs ?? BOUNDED_BODY_TIMEOUT_MS,
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
					text: decodeUtf8([retained.subarray(0, retainedBytes)]),
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
					text: decodeUtf8([retained.subarray(0, retainedBytes)]),
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
