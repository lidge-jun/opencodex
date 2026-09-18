import { execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { getConfigDir, loadConfig } from "../config";
import { readServiceApiTokenState, serviceApiTokenFilePath } from "../lib/service-secrets";
import { tokenCollidesWithAdmin } from "../lib/admin-secrets";
import { randomBytes } from "node:crypto";
import { hardenSecretDir, hardenSecretPath } from "../lib/windows-secret-acl";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { isTestHomeGuardArmed } from "../lib/test-home-guard";
import { diagnoseService } from "./diagnostics";
import type { ServiceDiagnostic } from "./diagnostics";
import { currentCodexHome, currentOpenCodexHome, normalizePathForCompare, readServiceInstallState } from "./state";
import { win32 } from "node:path";

/**
 * The service was installed under a different CODEX_HOME/OPENCODEX_HOME, so this process may not
 * touch it. Distinct from "stop failed": the manager was never even contacted, which means the
 * installed service is still live and shared state (native Codex config, the Grok fence) must be
 * left alone — tearing it down would strip config out from under a running service.
 */
export class ServiceOwnershipError extends Error {
  readonly code = "service-ownership-mismatch" as const;
}

export function isServiceOwnershipError(err: unknown): err is ServiceOwnershipError {
  return err instanceof ServiceOwnershipError;
}

/**
 * True when no installed service exists, or the installed one belongs to THIS
 * CODEX_HOME/OPENCODEX_HOME. Callers use it to decide whether they may tear down shared state
 * (native Codex config, the Grok fence) that a foreign service would still be relying on.
 */
export function serviceEnvironmentOwnedHere(): boolean {
  try {
    assertServiceEnvironmentMatchesInstall();
    return true;
  } catch (err) {
    if (isServiceOwnershipError(err)) return false;
    return true; // unrelated failure: fall back to the previous behavior rather than wedging
  }
}

export function assertServiceEnvironmentMatchesInstall(): void {
  const state = readServiceInstallState();
  if (!state) return;
  const actualCodexHome = currentCodexHome();
  const expected = normalizePathForCompare(state.codexHome);
  const actual = normalizePathForCompare(actualCodexHome);
  if (expected !== actual) {
    throw new ServiceOwnershipError(
      `Service was installed with CODEX_HOME=${state.codexHome}, but current CODEX_HOME=${actualCodexHome}. ` +
        "Run the service command from the same Codex home so native Codex restore updates the correct config.",
    );
  }
  const expectedOpenCodexHome = normalizePathForCompare(state.opencodexHome);
  const actualOpenCodexHome = normalizePathForCompare(currentOpenCodexHome());
  if (expectedOpenCodexHome !== actualOpenCodexHome) {
    throw new ServiceOwnershipError(
      `Service was installed with OPENCODEX_HOME=${state.opencodexHome}, but current OPENCODEX_HOME=${currentOpenCodexHome()}. ` +
        "Run the service command from the same OpenCodex home so service state and secrets match.",
    );
  }
}

function isLoopbackHostname(hostname: string | undefined): boolean {
  const normalized = (hostname ?? "127.0.0.1").trim().toLowerCase();
  return normalized === "" || normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

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
 * Refuse a management (admin) token as the data-plane secret.
 *
 * The service exports the contents of the service token file as
 * `OPENCODEX_API_AUTH_TOKEN` before starting the proxy. When that value is the admin
 * token, the server treats the management credential as a data-plane admission secret
 * and fails the ENTIRE management plane closed at boot, so every `/api/*` request
 * returns 503 — even on a loopback install that never needed a data-plane secret.
 * Exporting the admin token in the CLI cannot recover it, because the fence is decided
 * server-side at startup (#2696).
 *
 * Nothing in this codebase puts an admin token in that env var; it arrives from the
 * installing shell. This function is the chokepoint that should refuse it rather than
 * writing a file that produces a broken service. Comparison is the same helper doctor
 * uses: minted `ocx_admin_…` prefix, or byte-equal to configuredAdminToken (env or file).
 *
 * `source` selects the remedy, not the rule. The token can also arrive from an EXISTING
 * `service-api-token` that install/repair reuses, and there `unset` is meaningless advice —
 * the fix is to delete the file so a data-plane token is generated.
 */
export function assertNotAdminToken(
  token: string,
  env: NodeJS.ProcessEnv = process.env,
  source: "env" | "file" = "env",
): void {
  if (!tokenCollidesWithAdmin(token, env)) return;
  if (source === "file") {
    // The file branch of `writeServiceApiTokenFile` used to skip this check entirely, so a
    // hand-pasted admin token already on disk (pre-#2696, or the exact #4236 incident) was
    // silently reused: `ocx status` said `present (file)` and the hub crash-looped at boot.
    // The remedy is NOT `unset` -- there is nothing in the environment to unset.
    throw new Error(
      `${serviceApiTokenFilePath()} holds a management (admin) token, not a data-plane token. `
        + "The service exports that file as the data-plane secret, which fences the whole management "
        + "API closed and makes every ocx management command fail with 503, so the hub crash-loops at "
        + `boot. Delete the file (rm ${serviceApiTokenFilePath()}), then rerun \`ocx service repair\` `
        + "(or `ocx service install` when the service is not installed yet): a fresh owner-only "
        + "data-plane token is generated and nothing needs to be exported by hand.",
    );
  }
  throw new Error(
    "OPENCODEX_API_AUTH_TOKEN holds a management (admin) token. The service exports it "
      + "as the data-plane secret, which fences the whole management API closed and makes "
      + "every ocx management command fail with 503. Run `unset OPENCODEX_API_AUTH_TOKEN` "
      + "and rerun: nothing needs to be exported by hand, because the service provisions "
      + `its own owner-only data-plane token at ${serviceApiTokenFilePath()}.`,
  );
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

/** How the data-plane token the service will export was obtained. */
export type ServiceApiTokenOrigin = "env" | "file" | "generated";

export interface ProvisionedServiceApiToken {
  path: string;
  origin: ServiceApiTokenOrigin;
}

function persistServiceApiToken(token: string): string {
  const path = serviceApiTokenFilePath();
  const dir = getConfigDir();
  recordOwnedConfigPath(dir, path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") hardenSecretDir(dir, { required: true });
  writeFileSync(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  if (process.platform === "win32") hardenSecretPath(path, { required: true });
  return path;
}

/**
 * Put a usable data-plane token on disk for the service to read at launch, and say where.
 *
 * EVERY backend funnels through here — launchd, systemd, the Windows scheduler wrapper and
 * WinSW native — because the launch wrapper's only source of the secret is this file
 * (`buildServiceShellCommand` cats it into the environment; WinSW reads it through
 * `OCX_API_TOKEN_FILE`). One chokepoint is also what makes the admin-token refusal
 * unskippable (#2696).
 *
 * Precedence, in order:
 *  1. `OPENCODEX_API_AUTH_TOKEN` from the installing shell — still refused outright when it is
 *     an admin token. An operator who deliberately exports a key keeps full control of it.
 *  2. An existing owner-only `service-api-token`. Reusing it is what makes `repair`, a
 *     reinstall and a restart idempotent; regenerating would silently invalidate every client
 *     key-exchange already performed against the old value.
 *  3. 32 fresh random bytes, hex. This is the branch that removes the manual step: a hub
 *     install on a non-loopback hostname provisions its own secret.
 *
 * A loopback install with no env token gets nothing: admission is not required there, so
 * creating a credential would be inventing a secret nobody asked for — and on a machine
 * connected to a hub the same file holds that hub's issued client key, which must not be
 * overwritten by a local install.
 *
 * The PATH is logged; the value never is, and never reaches argv, a unit file or a plist.
 */
export function writeServiceApiTokenFile(): ProvisionedServiceApiToken | null {
  const token = process.env.OPENCODEX_API_AUTH_TOKEN?.trim();
  if (token) {
    // Last line of defence: every install/repair path funnels through here, so a
    // collision cannot reach disk regardless of which caller ran (#2696).
    assertNotAdminToken(token);
    const path = persistServiceApiToken(token);
    console.log(`🔐 Data-plane token taken from OPENCODEX_API_AUTH_TOKEN and stored at ${path} (owner-only).`);
    return { path, origin: "env" };
  }
  if (isLoopbackHostname(loadConfig().hostname)) return null;
  const existing = readServiceApiTokenState();
  if (existing.kind === "present") {
    // The collision check is NOT only for the env branch. A file that already holds the admin
    // token -- hand-pasted before #2696, or written by the very incident this unit closes --
    // was silently accepted here, so `ocx status` reported `present (file)` and the hub
    // crash-looped at boot with no command pointing at the cause.
    const path = serviceApiTokenFilePath();
    assertNotAdminToken(existing.token, process.env, "file");
    // `readServiceApiTokenState` accepts any bounded regular file, so a reused token may well
    // be group- or world-readable. Tighten it on the way through rather than claiming
    // "owner-only" about a mode nobody checked; best-effort, since a non-owner cannot chmod
    // and failing the install over it would be worse than the loose mode.
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
    if (process.platform === "win32") hardenSecretPath(path, { required: false });
    // No log line: repair/restart hit this on every run and an unconditional notice about a
    // credential file trains operators to ignore the one that matters.
    return { path, origin: "file" };
  }
  if (existing.kind === "unsafe") throw new Error(`${existing.reason}: ${serviceApiTokenFilePath()}`);
  const path = persistServiceApiToken(randomBytes(32).toString("hex"));
  console.log(`🔐 Provisioned an owner-only data-plane token at ${path}; nothing needs to be exported by hand.`);
  console.log("   Remote machines get their own per-client key — run 'ocx hub invite' instead of copying this file.");
  return { path, origin: "generated" };
}

export function sh(cmd: string): string {
  assertLiveServiceManagerAllowed(cmd);
  return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Service-manager invocations that only observe. Everything else changes a job that
 * launchd or the systemd user manager is running right now.
 */
const READ_ONLY_SERVICE_MANAGER = new RegExp(
  "^(?:launchctl\\s+(?:list|print|print-disabled|blame|managerpid|manageruid)\\b"
  + "|systemctl\\s+(?:--user\\s+)?(?:show|show-environment|status|is-active|is-enabled|is-failed|cat|list-units|list-unit-files|--version)\\b)",
);

const SERVICE_MANAGER_COMMAND = /^(?:launchctl|systemctl)\b/;

/**
 * Refuse to mutate a live service manager from an armed test process.
 *
 * The test preload isolates HOME, OPENCODEX_HOME and CODEX_HOME, and that is enough for
 * anything addressed by path. It is not enough here. `systemctl --user stop
 * opencodex-proxy.service` is addressed by job NAME and talks to the user manager that is
 * already running, so it stops the proxy the developer is actually using no matter what
 * HOME says. `launchctl bootout gui/<uid>/com.opencodex.proxy` has the same shape.
 *
 * Windows already had this guard: `querySchtasks` refuses every non-query call while the
 * test-home guard is armed, after a partially-faked test replaced a real scheduled task
 * with a launcher inside a temporary test home. macOS and Linux were left without the
 * equivalent, which means the person most likely to run this suite - someone running
 * opencodex on the machine they are developing it on - is the person it can disrupt.
 *
 * Read-only verbs stay allowed: probing what the manager reports is the whole point of
 * the diagnostics, and observation cannot take a service down.
 */
export function assertLiveServiceManagerAllowed(command: string): void {
  if (!isTestHomeGuardArmed()) return;
  const trimmed = command.trim();
  if (!SERVICE_MANAGER_COMMAND.test(trimmed)) return;
  if (READ_ONLY_SERVICE_MANAGER.test(trimmed)) return;
  throw new Error(
    `refusing to run \`${trimmed}\` from an armed test process: launchd and the systemd user `
    + "manager address a job by name, not by HOME, so this reaches the service the developer is "
    + "actually running. Inject the service operation instead of calling the live manager.",
  );
}
