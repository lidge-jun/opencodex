import { ConfigMutationLockError } from "../config";
import { CLIENT_RESTART_REBIND_WAIT_MS } from "../lib/system-restart-contract";

export type ClientRollbackAttempt = "published" | "busy" | "refused";

export function retryableClientRollbackLock(error: unknown): boolean {
  if (error && typeof error === "object" && "code" in error && error.code === "client_lifecycle_busy") return true;
  const cause = error instanceof ConfigMutationLockError ? error.cause : undefined;
  const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

/** Only transient contention is retried, up to the shared recovery deadline. A bind attempt closes its unpublished listener before yielding. */
export async function retryClientRollback<T extends ClientRollbackAttempt | "owned">(
  attempt: (remainingMs: number) => T | Promise<T>,
  io: { now?: () => number; sleep?: (ms: number) => Promise<unknown>; budgetMs?: number; deadline?: number } = {},
): Promise<T | "busy"> {
  const now = io.now ?? (() => performance.now());
  const deadline = io.deadline ?? now() + (io.budgetMs ?? CLIENT_RESTART_REBIND_WAIT_MS);
  while (now() < deadline) {
    const result = await attempt(Math.max(0, deadline - now()));
    if (result !== "busy") return result;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await (io.sleep ?? Bun.sleep)(Math.min(50, remaining));
  }
  return "busy";
}
