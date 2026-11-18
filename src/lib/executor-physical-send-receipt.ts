export const EXECUTOR_PHYSICAL_SEND_RECEIPT = Symbol("executor physical send receipt");
const receiptExecutors = new WeakSet<typeof globalThis.fetch>();

export function markPhysicalSendReceiptExecutor<T extends typeof globalThis.fetch>(executor: T): T {
  receiptExecutors.add(executor);
  return executor;
}

/** Use the executor's final admission when it owns the transport's remaining guards. */
export function fetchWithPhysicalSendReceipt(
  executor: typeof globalThis.fetch,
  input: Parameters<typeof globalThis.fetch>[0],
  init: RequestInit | undefined,
  receipt: () => void,
): Promise<Response> {
  if (receiptExecutors.has(executor)) {
    return executor(input, { ...init, [EXECUTOR_PHYSICAL_SEND_RECEIPT]: receipt } as RequestInit);
  }
  receipt();
  return executor(input, init);
}
