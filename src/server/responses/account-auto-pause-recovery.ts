import type { ResponsesSendBudget } from "./request-send-budget";

const moves = new WeakMap<object, number>();
/** One same-provider credential move, funded by the existing recovery owner. */
export async function recoverAutoPausedAccount<T>(options: {
  requestKey: object;
  remaining?: number;
  reserve: ResponsesSendBudget["reserveCredentialHop"];
  refresh: () => Promise<boolean>;
  refetch: () => Promise<T>;
  setPermit: (permit: ResponsesSendBudget["pendingHopPermit"]) => void;
}): Promise<T | undefined> {
  const count = moves.get(options.requestKey) ?? 0;
  if (count >= 3 || options.remaining !== undefined && options.remaining <= 0) return;
  const hop = options.reserve("auth-recovery", "account-auto-pause", true);
  if (!hop.allowed) return;
  try {
    if (!await options.refresh()) return;
    moves.set(options.requestKey, count + 1);
    options.setPermit(hop.permit);
    return await options.refetch();
  } finally {
    options.setPermit(undefined);
    hop.permit?.release();
  }
}
