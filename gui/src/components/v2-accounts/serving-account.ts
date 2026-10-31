import type { CodexAccountEntry } from "../codex-account-pool-types";
import type { CodexAccountModeState } from "../../codex-multi-state";

/**
 * Which account a request lands on, as far as the dashboard can tell without asking the
 * router: Direct mode always uses the main login; Pool mode starts new sessions on the
 * selected account, which is the main login when nothing else is selected.
 * Returns null when no account can be named honestly (everything paused or locked).
 */
export function servingAccount(
  accounts: readonly CodexAccountEntry[],
  activeId: string | null,
  mode: CodexAccountModeState | null,
): CodexAccountEntry | null {
  const main = accounts.find(account => account.isMain);
  const mainUsable = main && !main.paused
    && !(main.mainAccountHardLock?.enabled === true && main.mainAccountHardLock.state === "blocked");
  if (mode === "direct") return main ?? null;
  if (activeId && activeId !== "__main__") {
    const pooled = accounts.find(account => !account.isMain && account.id === activeId);
    if (pooled && !pooled.paused) return pooled;
  }
  return mainUsable ? main : null;
}
