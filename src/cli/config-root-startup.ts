import { getConfigDir, hardenConfigDir, withConfigDirHardeningSettled } from "../config/paths";
import { WindowsSecretAclSettleTimeoutError, windowsSecretAclApplies } from "../lib/windows-secret-acl";
import { skipsCodexShimAutoRestore } from "./preflight-exemptions";

/**
 * Wait once, before a CLI command does its first write, for the optional config-root ACL flight
 * (#7815). On Windows, loadConfig() starts an unawaited icacls harden of the config root, and its
 * inheritance work can drop a grant a concurrent writer just applied. Admitted writers already
 * wait for it themselves; this covers the synchronous writers a CLI command reaches before them.
 *
 * Skipped where waiting would itself be the side effect or the delay matters:
 * - the commands skipsCodexShimAutoRestore exempts from preflight repair (read-only, hot-path
 *   and validate-first commands). Adding a command there also removes this wait for it;
 * - every "internal" helper and every hidden "__*" helper, launched by other processes under their
 *   own budgets (startup health, tray start/restart/host, version refresh, the GUI update worker);
 * - "start", the long-lived server, and "ensure", which the Windows Codex shim runs before every
 *   launch to start it: the wait would run before Bun.serve and spend up to one ACL deadline of
 *   fixed budgets (update-restart marker, ensure readiness, Desktop cold start, service start
 *   timeouts, each Codex launch). The server's synchronous writers are documented residual.
 *
 * Bounded by one ACL deadline, which also drains timed-out icacls children. A timeout lets the
 * command proceed: writers that admit through withConfigDirHardeningSettled still refuse alone.
 */
export async function settleConfigRootForCli(command: string | undefined, args: readonly string[]): Promise<void> {
  if (!windowsSecretAclApplies()) return;
  if (command === undefined || command === "start" || command === "ensure" || command === "internal"
    || command.startsWith("__") || skipsCodexShimAutoRestore(command, [...args])) return;
  hardenConfigDir();
  try {
    await withConfigDirHardeningSettled(getConfigDir(), () => undefined);
  } catch (error) {
    if (!(error instanceof WindowsSecretAclSettleTimeoutError)) throw error;
  }
}
