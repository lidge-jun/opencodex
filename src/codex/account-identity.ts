import type { OcxConfig } from "../types";
import { codexLoginIdentity as identity, codexTokenIdentity, type CodexLoginIdentity } from "./signed-in-identity";
import { MAIN_CODEX_ACCOUNT_ID, isSelectableCodexPoolAccount } from "./account-id";
import type { CodexTokenReadResult } from "./auth-collision";
import { getCodexAccountCredential } from "./account-store";

/** Match existing entries from an already-owned main observation, without exposing identity fields. */
export function linkedCodexAccountIds(config: OcxConfig, selectedId: string, main: CodexTokenReadResult | { status: "api-key-only" }): string[] | undefined {
  // Unknown main identity must not produce a successful but incomplete pause.
  if (main.status === "unreadable" || main.status === "invalid") return undefined;
  const identities = new Map<string, CodexLoginIdentity | undefined>();
  if (main.status === "ok") {
    const selected = codexTokenIdentity(main.tokens);
    if (selected === null) return undefined;
    identities.set(MAIN_CODEX_ACCOUNT_ID, selected);
  }
  for (const account of config.codexAccounts ?? []) {
    if (!isSelectableCodexPoolAccount(account)) continue;
    const credential = getCodexAccountCredential(account.id);
    identities.set(account.id, identity(credential?.chatgptAccountId, account.email));
  }
  const selected = identities.get(selectedId);
  // Missing identity evidence never links unrelated logins, including members of one workspace.
  if (!selected) return [selectedId];
  return [selectedId, ...[...identities].flatMap(([id, candidate]) => (
    id !== selectedId && candidate?.accountId === selected.accountId && candidate.email === selected.email
      ? [id] : []
  ))];
}
