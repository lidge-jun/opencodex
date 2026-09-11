import { readAccount, accountProfile } from "./accounts";
import { desktopAccountBusy, desktopStatus } from "./desktop";
import { runNativeOAuth } from "./native-oauth";

const refreshes = new Map<string, Promise<void>>();
const refreshed = new Map<string, number>();
export const accountRuntimeBusy = (id: string) => refreshes.has(id) || desktopAccountBusy(id);
export const invalidateAccountRefresh = (id: string) => refreshed.delete(id);
/** Refresh belongs to the official host, never a proxy OAuth/API implementation. */
export async function refreshAccount(id: string): Promise<void> {
  if ((refreshed.get(id) ?? 0) > Date.now()) return;
  const pending = refreshes.get(id); if (pending) return pending;
  if (desktopAccountBusy(id)) return; // Do not mutate a profile used by a running turn.
  const account = readAccount(id);
  if (!account.subjectHash) throw new Error("account_login_required");
  const status = desktopStatus(id);
  if (!status.connected) throw new Error("account_login_required");
  const promise = (async () => {
    let identity: string | undefined;
    let nativeError: string | undefined;
    try { await runNativeOAuth({ runtime: status.runtime, profileHome: accountProfile(id), mode: "refresh",
      expectedSubjectHash: account.subjectHash, signal: AbortSignal.timeout(30_000), onEvent: event => {
        if (event.type === "authenticated") identity = event.subjectHash;
        if (event.type === "error") nativeError = event.code;
      } }); } catch (error) {
      if (nativeError === "account_identity_mismatch") throw new Error(nativeError);
      throw error;
    }
    if (identity !== account.subjectHash) throw new Error("account_identity_mismatch");
    refreshed.set(id, Date.now() + 60_000);
  })();
  refreshes.set(id, promise);
  try { await promise; } finally { refreshes.delete(id); }
}
