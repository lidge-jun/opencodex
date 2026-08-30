import type { GenerationContext } from "../lib/state-store-sweeper";
import { isCodexAccountGenerationLive } from "./account-store";

export type PoolQuota401Recovery =
  | { generation: number; disposition: "terminal" }
  | { generation: number; disposition: "spent"; retryAt: number };

const recoveryByAccount = new Map<string, PoolQuota401Recovery>();

export function getLivePoolQuota401Recovery(
  accountId: string,
  generation?: number,
): PoolQuota401Recovery | undefined {
  const state = recoveryByAccount.get(accountId);
  if (state && state.generation !== generation) {
    recoveryByAccount.delete(accountId);
    return undefined;
  }
  return state;
}

export function setPoolQuota401Recovery(accountId: string, state: PoolQuota401Recovery): void {
  if (!isCodexAccountGenerationLive(accountId, state.generation)) return;
  recoveryByAccount.set(accountId, state);
}

export function clearPoolQuota401Recovery(accountId: string, generation: number): void {
  if (recoveryByAccount.get(accountId)?.generation === generation) {
    recoveryByAccount.delete(accountId);
  }
}

export function prunePoolQuota401Recovery(liveAccountIds: ReadonlySet<string>): number {
  let removed = 0;
  for (const [accountId, state] of recoveryByAccount) {
    if (!liveAccountIds.has(accountId) || !isCodexAccountGenerationLive(accountId, state.generation)) {
      recoveryByAccount.delete(accountId);
      removed += 1;
    }
  }
  return removed;
}

export function reconcilePoolQuota401Recovery(context: GenerationContext): number {
  return prunePoolQuota401Recovery(context.codexAccountIds);
}

/** Test-only reset for process-local recovery hints. */
export function clearPoolQuota401RecoveryForTests(): void {
  recoveryByAccount.clear();
}
