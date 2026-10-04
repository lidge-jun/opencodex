/**
 * The install/repair preflight over the data-plane credential, plus the retry command it
 * names. Split out of `guards.ts` so the guard module stops importing `diagnostics`.
 *
 * Direction of the remaining edge is deliberate: this module asks `guards` for
 * `assertNotAdminToken` and `diagnostics` for the install verdict, and neither imports it back.
 */
import { loadConfig } from "../config";
import { isLoopbackHostname } from "../codex/loopback-target";
import { readServiceApiTokenState, serviceApiTokenFilePath } from "../lib/service-secrets";
import { diagnoseService } from "./diagnostics";
import type { ServiceDiagnostic } from "./diagnostics";
import { assertNotAdminToken } from "./guards";

/**
 * The `ocx` command a user should rerun for the service state they actually have.
 *
 * `installed` alone is not enough: `repairService()` refuses a Task-Scheduler-plus-WinSW
 * conflict outright, so recommending repair there names a command guaranteed to fail.
 * Install IS the valid conflict recovery, because `installWindows` removes the native
 * backend first. Exported so the guard tests the real selector rather than a copy of it.
 */
export function serviceRetryCommand(
  diag: Pick<ServiceDiagnostic, "installed" | "conflict"> = diagnoseService(),
): string {
  return diag.installed && !diag.conflict ? "ocx service repair" : "ocx service install";
}

/**
 * Preflight for `service install` / `service repair` on the data-plane credential.
 *
 * It used to DEMAND `OPENCODEX_API_AUTH_TOKEN` for a non-loopback hostname, and it threw
 * even when `~/.opencodex/service-api-token` already held a perfectly good token. That is
 * the defect behind the incident this unit exists to close (#4236): an operator exported the
 * ADMIN token as OPENCODEX_API_AUTH_TOKEN because `install` asked for a token, the hub then
 * crash-looped on `assertNotAdminToken`, and `service repair` asked for the same env var
 * again — so the only remembered way to make the command proceed was the thing that broke it.
 *
 * Nobody should have to export a token by hand to run a hub. {@link writeServiceApiTokenFile}
 * provisions one, so the only conditions left that install cannot fix are an admin-token
 * collision in the environment and a token file that exists but cannot be used.
 */
export function assertServiceAuthEnvironment(): void {
  const config = loadConfig();
  // Both collision checks come BEFORE the loopback short-circuit, because the launch wrapper
  // exports the token file unconditionally (`buildServiceShellCommand` cats it whenever it
  // exists, whatever the hostname): a management token in either source fences the whole
  // management plane closed at boot, even on a loopback install that needs no admission
  // secret. Returning early is what let that broken state through.
  const present = process.env.OPENCODEX_API_AUTH_TOKEN?.trim();
  if (present) assertNotAdminToken(present);
  const state = readServiceApiTokenState();
  // An existing FILE holding the admin token is the incident shape itself, and the first round
  // only checked the env var — so install/repair reused it and the hub crash-looped at boot.
  // On a machine connected to a hub this same file holds that hub's issued client key, which
  // is never a management token, so the check is a no-op there.
  if (state.kind === "present") assertNotAdminToken(state.token, process.env, "file");
  if (isLoopbackHostname(config.hostname)) return;
  if (present) return;
  // Absent is fine — install/repair generates one below. `unsafe` is not: the writer refuses
  // to replace a path it cannot vouch for, so say so here, where the operator can still act,
  // instead of failing mid-install. Reached from `service repair` as well as `install`, so
  // name a command that can actually succeed (see serviceRetryCommand).
  if (state.kind !== "unsafe") return;
  const diag = diagnoseService();
  throw new Error(
    `The data-plane token file cannot be used (${state.reason}): ${serviceApiTokenFilePath()}. `
      + `Move it aside, then rerun \`${serviceRetryCommand(diag)}\`; the service provisions a `
      + "fresh owner-only token and needs nothing from the environment.",
  );
}
