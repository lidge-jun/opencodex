import { ConfigMutationLockError } from "../config";
import { CLIENT_RESTART_REBIND_WAIT_MS } from "../lib/system-restart-contract";

export type ClientRollbackAttempt = "published" | "busy" | "refused";

export function retryableClientRollbackLock(error: unknown): boolean {
  if (error && typeof error === "object" && "code" in error && error.code === "client_lifecycle_busy") return true;
  const cause = error instanceof ConfigMutationLockError ? error.cause : undefined;
  const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

/** Each busy attempt must close its unpublished listener before this helper may yield. */
export async function retryClientRollback(
  attempt: (remainingMs: number) => Promise<ClientRollbackAttempt>,
  io: { now?: () => number; sleep?: (ms: number) => Promise<unknown>; budgetMs?: number } = {},
): Promise<boolean> {
  const now = io.now ?? (() => performance.now());
  const deadline = now() + (io.budgetMs ?? CLIENT_RESTART_REBIND_WAIT_MS);
  while (now() < deadline) {
    const result = await attempt(Math.max(0, deadline - now()));
    if (result === "published") return true;
    if (result !== "busy") return false;
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    await (io.sleep ?? Bun.sleep)(Math.min(50, remaining));
  }
  return false;
}
