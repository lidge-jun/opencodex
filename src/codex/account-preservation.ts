import type { OcxConfig } from "../types";
import { MAIN_CODEX_ACCOUNT_ID, isSelectableCodexPoolAccount } from "./account-id";
import { getCodexAccountCredential } from "./account-store";
import { codexAccountPriorityLookup } from "./account-priority";
import { MIN_ACCOUNT_PRIORITY, MAX_ACCOUNT_PRIORITY } from "./pool-rotation";
import { codexLoginIdentity, getSignedInCodexIdentity, sameCodexLogin } from "./signed-in-identity";

/** Resolve current rows afresh: a pool replacement must not inherit the prior login's role. */
export function signedInCodexAccountIds(config: OcxConfig): ReadonlySet<string> {
  const ids = new Set([MAIN_CODEX_ACCOUNT_ID]);
  const main = getSignedInCodexIdentity();
  if (!main) return ids;
  for (const account of config.codexAccounts ?? []) {
    if (!isSelectableCodexPoolAccount(account)) continue;
    const credential = getCodexAccountCredential(account.id);
    if (sameCodexLogin(main, codexLoginIdentity(credential?.chatgptAccountId, account.email))) ids.add(account.id);
  }
  return ids;
}

/** Two disjoint bands, preserving custom order inside each; never writes the stored priorities. */
export function codexSelectionPriorityLookup(config: OcxConfig): (id: string) => number {
  const priority = codexAccountPriorityLookup(config);
  if (config.codexPreserveSignedInAccount !== true) return priority;
  const reserved = signedInCodexAccountIds(config);
  const band = MAX_ACCOUNT_PRIORITY - MIN_ACCOUNT_PRIORITY + 1;
  return id => priority(id) - (reserved.has(id) ? band : 0);
}
