import { restoreCodexAccountEgressBinding } from "../../src/codex/account-egress-runtime";
import { listCodexAccountIds } from "../../src/codex/account-store";
import { getConfigPath } from "../../src/config";

/**
 * Pool fixtures written before account routes existed store credentials without a config row, and
 * production refuses to send a stored pool credential its config does not list. This binds, for the
 * current config home, a routing config whose pool rows are exactly the live stored accounts (plus
 * `extraIds`, for credentials a test passes without storing them), none with a route: the state a
 * running server has for unrouted pool accounts. A tombstoned account loses its row, as on deletion.
 * Call it after the test home is in place; a binding for another home is ignored.
 */
const registeredIds = new Set<string>();

/** A pool account a test passes as a credential without storing it; it gets a row in every binding. */
export function registerCodexPoolRowForTests(accountId: string): string {
  registeredIds.add(accountId);
  return accountId;
}

export function bindStoredCodexPoolRoutingForTests(extraIds: readonly string[] = []): void {
  const config = {
    providers: {},
    get codexAccounts() {
      return [...new Set([...listCodexAccountIds(), ...extraIds, ...registeredIds])].map(id => ({ id, email: "", isMain: false }));
    },
  };
  restoreCodexAccountEgressBinding({ config: config as never, configPath: getConfigPath(), degraded: false });
}
