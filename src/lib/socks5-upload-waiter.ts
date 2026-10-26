type Answered = { kind: "answered" };
type Interruption = { value: Answered } | { error: unknown };

/**
 * One head observer and abort listener for a serial upload, not one Promise.race
 * reaction per chunk. Only the current read/drain resolver is retained; clearing it
 * lets completed read results go before a slow peer answers. The response owner
 * still reports head failures, while cancellation keeps the caller's exact reason.
 */
export function createUploadWaiter(head: Promise<unknown>, signal: AbortSignal) {
  let interruption: Interruption | undefined;
  let pending: {
    resolve: (value: Answered) => void;
    reject: (error: unknown) => void;
  } | undefined;
  const interrupt = (outcome: Interruption) => {
    interruption ??= outcome;
    if ("error" in interruption) pending?.reject(interruption.error);
    else pending?.resolve(interruption.value);
  };
  const answered = () => interrupt({ value: { kind: "answered" } });
  void head.then(answered, answered);
  const onAbort = () => interrupt({
    error: signal.reason === undefined ? new Error("The operation was aborted") : signal.reason,
  });
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });

  return {
    async wait<T>(operation: () => Promise<T>): Promise<T | Answered> {
      try {
        return await new Promise<T | Answered>((resolve, reject) => {
          pending = { resolve, reject };
          if (interruption) {
            interrupt(interruption);
            return;
          }
          // Both outcomes stay observed when an early head/abort wins instead.
          void operation().then(resolve, reject);
        });
      } finally {
        pending = undefined;
      }
    },
    dispose(): void {
      pending = undefined;
      signal.removeEventListener("abort", onAbort);
    },
  };
}
