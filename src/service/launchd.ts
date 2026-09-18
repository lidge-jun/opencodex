import { existsSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { assertNotRealLaunchAgentsUnderTest } from "../lib/test-home-guard";
import { sh } from "./guards";
import { plistPath } from "./state";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { BUN_RUNTIME_PATH_ENV, BUN_RUNTIME_SOURCE_ENV, durableBunRuntime, type DurableBunRuntime } from "../lib/bun-runtime";
import { serviceApiTokenFilePath } from "../lib/service-secrets";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { writeServiceApiTokenFile, assertLiveServiceManagerAllowed } from "./guards";
import { resolveServiceListenPort, buildServiceShellCommand, buildServiceLauncherShellCommand, installedServiceListenPort, resolvedProxyEnv } from "./health";
import { SERVICE_MANAGED_ENV, LABEL, cliEntry, stableLauncherEntry, logPath, serviceStatePath, currentCodexSqliteHomeAbsolute, type ServiceInstallState, writeServiceInstallState, readServiceInstallState } from "./state";
import { writeServiceDefinitionFile } from "./windows-ops";
import { readTextOrNull } from "./windows-taskxml";

function plistString(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Render the launchd plist. Mirrors `buildUnit`: when `deps.launcher` names a stable `ocx`
 * executable, the job execs that launcher instead of the package-local Bun + CLI pair, so a
 * version-manager upgrade (mise, asdf, nvm) that replaces the package directory is picked up
 * on the next launchd start instead of leaving the old build serving (#3464 — the macOS
 * counterpart of #2898). Discovery belongs to `installLaunchd()`; the default here is the
 * legacy pair so callers and tests stay hermetic.
 */
export function buildPlist(
  proxyEnv: { name: string; value: string }[] = resolvedProxyEnv(),
  deps: { launcher?: string | null; runtime?: DurableBunRuntime } = {},
): string {
  const runtime = deps.runtime ?? durableBunRuntime();
  const { bun, bunRuntimeSource, cli } = cliEntry(runtime);
  const launcher = deps.launcher ?? null;
  const log = logPath();
  const path = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const codexHome = process.env.CODEX_HOME?.trim();
  const codexSqliteHome = currentCodexSqliteHomeAbsolute();
  const opencodexHome = process.env.OPENCODEX_HOME?.trim();
  const envLines = [
    `    <key>OCX_SERVICE</key><string>1</string>`,
    // OCX_SERVICE alone cannot identify the managed job: `ocx claude` and `ocx opencode`
    // also set it on the proxies they spawn, to borrow its routing-preservation meaning
    // (src/cli/index.ts preserveRouting). Only the wrapper writes this second marker, so
    // the dashboard-stop refusal below can tell a real launchd job from an ordinary child.
    `    <key>${SERVICE_MANAGED_ENV}</key><string>1</string>`,
    ...(launcher ? [] : [
      `    <key>${BUN_RUNTIME_SOURCE_ENV}</key><string>${bunRuntimeSource}</string>`,
      `    <key>${BUN_RUNTIME_PATH_ENV}</key><string>${plistString(bun)}</string>`,
    ]),
    // A launcher resolves the current package's bundled Bun after every upgrade. Preserve
    // only a proof-bound shell override; baking a package-local path here would recreate
    // the version-manager pin that launcher mode exists to remove (same rule as buildUnit).
    launcher && runtime.source === "override"
      ? `    <key>${runtime.overrideEnv}</key><string>${plistString(runtime.path)}</string>`
      : null,
    `    <key>PATH</key><string>${plistString(path)}</string>`,
    codexHome ? `    <key>CODEX_HOME</key><string>${plistString(codexHome)}</string>` : null,
    codexSqliteHome ? `    <key>CODEX_SQLITE_HOME</key><string>${plistString(codexSqliteHome)}</string>` : null,
    opencodexHome ? `    <key>OPENCODEX_HOME</key><string>${plistString(opencodexHome)}</string>` : null,
    ...proxyEnv.map(({ name, value }) =>
      `    <key>${name}</key><string>${plistString(value)}</string>`),
  ].filter((line): line is string => Boolean(line)).join("\n");
  const command = launchdServiceCommand(launcher, runtime);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-lc</string>
    <string>${plistString(command)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
${envLines}
  </dict>
  <key>StandardOutPath</key><string>${plistString(log)}</string>
  <key>StandardErrorPath</key><string>${plistString(log)}</string>
</dict>
</plist>
`;
}

/**
 * The single `EnvironmentVariables` line {@link buildPlist} fills from the env of whatever
 * process happens to be repairing.
 */
const PLIST_PATH_ENTRY = /^(\s*<key>PATH<\/key><string>)([^\n]*)(<\/string>)$/m;

/**
 * The rendered plist with the PREVIOUS definition's `PATH` put back — or null when `PATH`
 * is not the only difference.
 *
 * `buildPlist` bakes `process.env.PATH`, and `ocx service repair` is run by whatever has a
 * shell: a tray helper, `ocx update`'s child, an ssh session, a cron job. Each of those
 * carries a DIFFERENT PATH from the login shell that installed the service, so comparing
 * whole-file bytes made the "nothing to repair" pre-check miss almost every time it
 * mattered: a healthy hub was evicted, and its PATH rewritten to the narrower one, purely
 * because of who asked (#4236, review finding 2).
 *
 * Reuse rather than ignore. A plist that differs only in PATH is not "equal" — dropping the
 * difference silently would let a repair report a no-op while launchd keeps a PATH the
 * operator has changed on purpose. Putting the previous value back makes the two files
 * genuinely identical, so the caller's ordinary byte comparison decides, and the PATH the
 * service already runs with is the one that survives.
 *
 * The caller applies this only when the live job is loaded from exactly the exec line this
 * install baked: that is the evidence that the running definition is the one on disk, which
 * is what makes keeping its PATH correct rather than a guess. Whenever anything ELSE about
 * the definition changed the plist is rewritten in full, PATH included, so a real
 * re-install still updates it.
 */
export function reusePreviousPlistPathVariable(previous: string, rendered: string): string | null {
  const prev = PLIST_PATH_ENTRY.exec(previous);
  const next = PLIST_PATH_ENTRY.exec(rendered);
  if (!prev || !next || prev[2] === next[2]) return null;
  // A function replacer, not a `$1` template: a PATH entry containing `$&` or `$1` would
  // otherwise be re-expanded into the file.
  const adopted = rendered.replace(PLIST_PATH_ENTRY, (_match, open: string, _value: string, close: string) =>
    `${open}${prev[2] ?? ""}${close}`);
  return adopted === previous ? adopted : null;
}

/**
 * The exec line {@link buildPlist} bakes, for the launcher and runtime a single install
 * already resolved. Shared so `installLaunchd` can verify the live job against the exact
 * string it just wrote instead of re-deriving it from install state that has not been
 * written yet (a fresh install has no state, so `expectedLaunchdCommand` would hand back
 * the Bun + CLI pair and call a correctly loaded launcher job stale).
 */
function launchdServiceCommand(
  launcher: string | null,
  runtime: DurableBunRuntime = durableBunRuntime(),
  port: number = resolveServiceListenPort(),
): string {
  if (launcher) return buildServiceLauncherShellCommand(launcher, port);
  const { bun, cli } = cliEntry(runtime);
  return buildServiceShellCommand(bun, cli, port);
}

/**
 * The exec line the installed launchd plist is expected to carry, derived from the recorded
 * install state rather than rediscovered: a launcher install runs the launcher, a legacy or
 * stateless install runs the Bun + CLI pair. `start` and `status` compare the live job
 * against this, so both must follow the launcher or a healthy launcher-backed job reads as
 * "an OLDER plist" (#3464). PATH is deliberately NOT re-walked here.
 */
export function expectedLaunchdCommand(
  port: number,
  deps: { state?: ServiceInstallState | null; entry?: { bun: string; cli: string } } = {},
): string {
  const state = deps.state === undefined ? readServiceInstallState() : deps.state;
  if (state?.launcherPath) return buildServiceLauncherShellCommand(state.launcherPath, port);
  const entry = deps.entry ?? cliEntry();
  return buildServiceShellCommand(entry.bun, entry.cli, port);
}

/**
 * The `--port <n>` actually baked into the installed launchd plist, or null when it
 * cannot be read. macOS only — named for launchd rather than "service" so no caller
 * assumes it covers systemd or the Windows wrapper.
 *
 * `start` needs this because it does NOT rewrite the plist: an install made under
 * OCX_BAKE_PORT, or any later config.port edit, would otherwise leave launchd serving
 * one port while the confirmation probes another, failing a healthy service.
 *
 * Anchored on the closing tag and matched LAST: the command also carries the Bun and
 * CLI paths, and a path containing the literal `start --port 9999` must not shadow
 * the real argument. buildPlist emits the command as the final ProgramArguments
 * string, and buildServiceShellCommand puts the port at the very end of it.
 */
export function launchdListenPort(deps: { readPlist?: () => string } = {}): number | null {
  try {
    const text = (deps.readPlist ?? (() => readFileSync(plistPath(), "utf8")))();
    const last = [...text.matchAll(/start --port (\d{1,5})\s*<\/string>/g)].at(-1);
    if (!last) return null;
    const n = Number(last[1]);
    return n > 0 && n <= 65535 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Run `launchctl` and report BOTH streams regardless of exit status.
 *
 * `launchctl load` writes "Load failed: <n>: <reason>" to stderr and exits 0 for
 * every already-bootstrapped job. `sh()` above is execSync, which throws only on a
 * non-zero exit, so install and start both reported success for a load that did
 * nothing — leaving launchd running the PREVIOUS plist while a freshly written one
 * sat unused on disk. That is the 2026-08-02 report: `ocx service` prints a
 * checkmark, `launchctl list` shows the job, and the port answers nothing.
 *
 * spawnSync, NOT execFileSync: execFileSync discards stderr when the child exits 0,
 * which is precisely this case — a runner built on it returns an empty stderr and
 * the guard below can never fire. Measured on macOS 27.0.
 */
export function runLaunchctl(
  args: string[],
  deps: { run?: typeof spawnSync } = {},
): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  const run = deps.run ?? spawnSync;
  // Only the real runner is guarded. Tests that inject a spawnSync stand-in are
  // exercising the parsing, not reaching launchd, and must keep working.
  if (run === spawnSync) assertLiveServiceManagerAllowed(`launchctl ${args.join(" ")}`);
  const result = run("/bin/launchctl", args, { encoding: "utf8", windowsHide: true });
  // `error` is set when the spawn itself failed (ENOENT off macOS) and `status` is
  // null for a signalled child; neither may be reported as success.
  if (result.error) {
    return { ok: false, stdout: "", stderr: String(result.error.message ?? ""), status: null };
  }
  return {
    ok: result.status === 0,
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim(),
    /*
     * The NUMBER, not just its zero-ness.
     *
     * `launchctl print` distinguishes "that domain does not exist" (112) from
     * "the domain answered and has no such service" (113), and an ownership
     * probe needs that difference: the second proves absence, the first only
     * proves we could not look. Collapsing both into `ok: false` forced callers
     * to parse stderr, which Apple does not treat as a stable interface.
     */
    status: result.status ?? null,
  };
}

/**
 * Whether launchctl output indicates the operation did not take. Needed because
 * `ok` alone is insufficient for the legacy `load`/`unload` subcommands, which
 * report failure on stderr while exiting 0. `bootstrap` exits 5, so for that path
 * this is belt-and-braces rather than the only signal.
 */
export function launchctlLoadFailed(stderr: string): boolean {
  return /\b(?:Load|Bootstrap) failed\b/i.test(stderr);
}

/** launchd domain target for the current user's GUI session. */
export function launchdGuiDomain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

/**
 * Whether launchd is running the job from the CURRENT plist. `launchctl list` only
 * proves domain membership — a job bootstrapped from an older plist stays listed
 * forever. `launchctl print` exposes the live `arguments`, which is the only way to
 * catch a load that silently no-op'd.
 */
export function launchdJobMatchesPlist(
  expectedCommand: string,
  deps: { run?: typeof runLaunchctl } = {},
): { loaded: boolean; matchesPlist: boolean } {
  const run = deps.run ?? runLaunchctl;
  const printed = run(["print", `${launchdGuiDomain()}/${LABEL}`]);
  if (!printed.ok) return { loaded: false, matchesPlist: false };
  // `print` writes the arguments block to stdout for a live job. Search both streams
  // anyway so a future launchctl that moves diagnostics between them cannot turn this
  // into a false negative — a false "stale" verdict would send users to `bootout` for
  // nothing.
  const printedText = `${printed.stdout}\n${printed.stderr}`;
  return { loaded: true, matchesPlist: printedText.includes(expectedCommand) };
}

/** `launchctl print`: the domain answered and holds no such service. */
const LAUNCHCTL_NO_SUCH_SERVICE = 113;

/** `launchctl print`: that domain does not exist at all (label-independent). */
const LAUNCHCTL_NO_SUCH_DOMAIN = 112;

/** `launchctl bootstrap`: something is already bootstrapped under that label. */
const LAUNCHCTL_BOOTSTRAP_BUSY = 5;

/** `launchctl bootout`: nothing was loaded under that label, i.e. already stopped. */
const LAUNCHCTL_BOOTOUT_NO_SUCH_PROCESS = 3;

/**
 * Every domain target an eviction has to cover.
 *
 * {@link probeLaunchdLoadState} asks `gui/<uid>` AND `user/<uid>` because the two domains
 * are independent and hold separate service sets, while every MUTATING verb in this file
 * addressed `gui/<uid>` alone. So a `user/`-domain registration of our Label used to:
 * survive `ocx service stop` (`bootout gui/<uid>/<label>` exits 3, "No such process", which
 * the stop path correctly reads as "nothing was loaded" — in the wrong domain); survive the
 * install cleanup whose whole job is evicting a live manager before new assets land, which
 * then installed over a serving job; and stay registered while `installLaunchd` bootstrapped
 * a SECOND registration of the same Label into `gui/`, leaving two KeepAlive jobs fighting
 * for one port.
 *
 * Both domains unconditionally rather than the one a probe reports: `bootout` against a
 * label a domain does not hold exits 3 and changes nothing, so enumerating first would buy
 * an extra round trip to learn what the verb itself already reports.
 */
export function launchdEvictionTargets(uid: number = process.getuid?.() ?? 0): string[] {
  return [`gui/${uid}/${LABEL}`, `user/${uid}/${LABEL}`];
}

/**
 * Whether a `bootout` exit status means "nothing of ours was loaded there" rather than a
 * failure. 3 is "No such process"; 113/112 answer for the service and the domain, and a
 * domain that does not exist cannot be holding a job of ours (a headless Mac has no `gui/`).
 */
export function launchctlBootoutBenign(status: number | null): boolean {
  return status === 0
    || status === LAUNCHCTL_BOOTOUT_NO_SUCH_PROCESS
    || status === LAUNCHCTL_NO_SUCH_SERVICE
    || status === LAUNCHCTL_NO_SUCH_DOMAIN;
}

/**
 * Four states, because three of them used to collapse into one bit.
 *
 * - `loaded-current` — a domain answers 0 and runs the command we expect.
 * - `loaded-stale` — a domain answers 0 but runs a different command (an older plist).
 * - `not-loaded` — every domain answered 112/113, which is proof of absence.
 * - `unknown` — launchctl could not be asked, or answered something undocumented. NOT
 *   evidence of a problem, and deliberately not a reason to recommend `ocx service
 *   repair`: that command evicts the job, so recommending it on a failed probe is how
 *   #4236 turned a healthy hub into an outage.
 */
export type LaunchdLoadState = "loaded-current" | "loaded-stale" | "not-loaded" | "unknown";

export interface LaunchdLoadProbe {
  state: LaunchdLoadState;
  /** The domain that answered, when one did. */
  domain?: string;
  /** Why the probe is `unknown`. Never carries plist contents or credentials. */
  detail?: string;
}

/**
 * Whether launchd is running our job, and from which plist — asked with `launchctl print`
 * in BOTH user domains.
 *
 * Replaces `launchctl list | grep <label>`, which enumerated the CALLER's bootstrap domain
 * (so a healthy `gui/$uid` job was invisible from ssh/cron), swallowed every exit code
 * through `|| true`, and matched the label unanchored anywhere on a line (so
 * `com.opencodex.proxy.helper` read as ours). `gui/` and `user/` are independent and hold
 * separate service sets — measured on macOS 27.0: the shipped agent answers 0 under
 * `gui/<uid>` and 113 under `user/<uid>` — so asking one leaves the other free to hold a
 * job this probe would then call absent (same reasoning as `inspectLaunchd`).
 */
export function probeLaunchdLoadState(deps: {
  launchctl?: typeof runLaunchctl;
  expectedCommand?: () => string;
  uid?: number;
} = {}): LaunchdLoadProbe {
  const run = deps.launchctl ?? runLaunchctl;
  const uid = deps.uid ?? process.getuid?.() ?? 0;
  for (const domain of [`gui/${uid}`, `user/${uid}`]) {
    const printed = run(["print", `${domain}/${LABEL}`]);
    if (printed.status === 0) {
      const expected = (deps.expectedCommand
        ?? (() => expectedLaunchdCommand(installedServiceListenPort())))();
      const printedText = `${printed.stdout}\n${printed.stderr}`;
      return {
        state: printedText.includes(expected) ? "loaded-current" : "loaded-stale",
        domain,
      };
    }
    if (printed.status === LAUNCHCTL_NO_SUCH_SERVICE) continue;
    // 112 is an answer ABOUT THE DOMAIN and is label-independent, so an unreachable
    // domain cannot be hiding a job of ours. A headless Mac has no GUI domain and no
    // installation either; calling that `unknown` would refuse every verdict on it.
    if (printed.status === LAUNCHCTL_NO_SUCH_DOMAIN) continue;
    return {
      state: "unknown",
      detail: printed.status === null
        ? `launchctl could not be run: ${printed.stderr || "spawn failed"}`
        : `launchctl print ${domain}/${LABEL} exited ${String(printed.status)}`,
    };
  }
  return { state: "not-loaded" };
}

/** Up to ~5 × 200 ms, the launchd twin of the Windows scheduler settle delays. */
const LAUNCHD_SETTLE_ATTEMPTS = 5;

const LAUNCHD_SETTLE_DELAY_MS = 200;

/**
 * Wait for a `bootout` to finish.
 *
 * `bootout` is asynchronous: it returns before the job has exited, so an immediate
 * re-registration races it and gets "Bootstrap failed: 5: Input/output error" — which is
 * exactly what made the old back-to-back retry useless (#4236, defect 1d). Bounded on
 * purpose: a genuinely wedged domain must reach the diagnosable throw rather than hang.
 *
 * Synchronous because `installLaunchd` is (`ServiceOps.install` / `repairLaunchd` are
 * `() => void`), so this uses `Bun.sleepSync` and exposes the seam for tests.
 */
function settleLaunchdEviction(
  run: typeof runLaunchctl,
  target: string,
  sleepSync: (ms: number) => void,
): void {
  for (let attempt = 0; attempt < LAUNCHD_SETTLE_ATTEMPTS; attempt += 1) {
    if (!run(["print", target]).ok) return;
    sleepSync(LAUNCHD_SETTLE_DELAY_MS);
  }
}

/**
 * What an install or repair actually DID to launchd.
 *
 * `reloaded: false` means the no-op path was taken — the plist on disk was already the
 * rendered one, the data token was unchanged, and the probe answered `loaded-current` — so
 * launchd was never asked for anything and the job is still the same process it was. That
 * is the right answer for `repair` (a repair of a healthy service must not be an outage)
 * and the WRONG one for `restart`, which is the verb an operator reaches for precisely when
 * they want a new process. Only `restart` acts on it; see {@link restartLaunchdJob}.
 */
export interface LaunchdInstallOutcome {
  reloaded: boolean;
}

/**
 * Deps follow {@link startLaunchd}: `launchctl` replaces the LAYER, returning a
 * {@link runLaunchctl} result, not a spawnSync result. Every one is optional so this stays
 * assignable to `ServiceOps.install` and `RepairServiceDeps.repairLaunchd`
 * (`() => void`), and so `platformOps` wires the same function the tests exercise.
 *
 * The seam is what makes the eviction below testable at all. The live-service-manager
 * guard refuses every mutating verb from an armed test process and `bootout` is not on
 * its read-only list, so a test reaching the real runner would fail closed on the guard
 * instead of exercising the sequence.
 *
 * `probe` is the TRI-STATE {@link probeLaunchdLoadState}, used twice and for opposite
 * reasons: once before touching launchd, to prove a repair has nothing to do, and once
 * after, because stderr cannot prove a load took. It is deliberately not the two-state
 * `launchdJobMatchesPlist`, which reports `loaded: false` for every non-zero
 * `launchctl print` — EPERM from a non-Aqua ssh/cron context, an unspawnable launchctl, an
 * undocumented status. With that one, a healthy serving hub read as "not loaded" in the
 * pre-check (so repair evicted it) and again in the verification (so the rollback evicted
 * it a second time and the error claimed "IS NOT RUNNING" about a job that was up). An
 * `unknown` probe is not evidence, so it refuses to evict instead.
 *
 * Protocol (#4236, defect 1). `ocx service repair` on darwin IS this function, and it
 * evicts the running job — a public proxy, a management ingress and a loopback listener on
 * a hub. So:
 *
 *  1. Ask launchd what it is running BEFORE writing anything. `unknown` throws without
 *     touching a file or a job; `loaded-current` plus an identical plist and an unchanged
 *     token file means there is nothing to repair, and a repair of a healthy service must
 *     never cause an outage.
 *  2. Keep the previous plist bytes (in memory and at `<plist>.prev`) before overwriting.
 *  3. `bootout` BOTH user domains, settle, then `bootstrap gui/$uid <plist>` — the verb
 *     that PAIRS with the bootout target. Legacy `load -w` is domain-implicit: it acts on
 *     the caller's own bootstrap domain, so from ssh/cron it deleted the gui-domain job and
 *     registered nothing (defect 1a).
 *  4. Success is `launchctl print` agreeing, never a stderr regex: measured on macOS 27.0,
 *     `load -w` over a bootstrapped job exits 0 with "Load failed: 5" and does nothing,
 *     and `bootstrap` exits 5 with "Bootstrap failed: 5" for the same condition.
 *  5. On terminal failure restore the previous plist, try to bootstrap it back, and throw
 *     an error that says what the probe actually found — down, or up on a different
 *     command — and names the manual remedy.
 *
 * Returns {@link LaunchdInstallOutcome} so the one caller that needs a RESTART rather than a
 * repair can tell the no-op path from a reload. See {@link restartLaunchdJob}.
 */
export function installLaunchd(deps: {
  launchctl?: typeof runLaunchctl;
  probe?: typeof probeLaunchdLoadState;
  sleepSync?: (ms: number) => void;
  /**
   * Where to write the plist. Only tests pass it: `os.homedir()` reads the password
   * database rather than `$HOME`, so the suite's HOME sandbox does NOT move
   * `plistPath()`, and a case without this seam rewrites the developer's live
   * `com.opencodex.proxy.plist`. `assertNotRealLaunchAgentsUnderTest` below makes that
   * refusal mechanical rather than a convention.
   */
  plistPath?: string;
} = {}): LaunchdInstallOutcome {
  const run = deps.launchctl ?? runLaunchctl;
  const probeLoadState = deps.probe ?? probeLaunchdLoadState;
  const sleepSync = deps.sleepSync ?? ((ms: number) => { Bun.sleepSync(ms); });
  const p = deps.plistPath ?? plistPath();
  const dir = dirname(p);
  assertNotRealLaunchAgentsUnderTest(dir);
  // Capture this BEFORE writing: the write below makes the plist exist unconditionally,
  // so a post-write existsSync would call every fresh install an "installed" service.
  const wasInstalled = existsSync(p);
  // The previous definition, kept for rollback. An eviction whose bootstrap fails used to
  // end with the new plist on disk, nothing in launchd, and nothing listening.
  const previousPlist = wasInstalled ? readTextOrNull(p) : null;
  // Resolve the launcher ONCE and hand the same value to the plist and to install state,
  // so the staleness diagnostic judges exactly what launchd runs.
  const launcher = stableLauncherEntry();
  // The command THIS install bakes, not the one install state remembers: on a fresh
  // install there is no state yet, and after a lost state file `expectedLaunchdCommand`
  // falls back to the Bun + CLI pair and would call a correct launcher job stale (#3464).
  const expectedCommand = launchdServiceCommand(launcher);
  const uid = process.getuid?.() ?? 0;
  const guiDomain = launchdGuiDomain();
  const guiTarget = `${guiDomain}/${LABEL}`;
  const evictionTargets = launchdEvictionTargets(uid);
  const probeLive = (): LaunchdLoadProbe => probeLoadState({ expectedCommand: () => expectedCommand });

  // Nothing has been written yet, deliberately: a probe that cannot answer must leave the
  // host exactly as it found it.
  let verdict = probeLive();
  if (verdict.state === "unknown") {
    throw new Error(
      `refusing to ${wasInstalled ? "repair" : "install"} ${LABEL}: launchd state could not be verified `
      + `— ${verdict.detail ?? "launchctl could not be asked"}.\n`
      + "The job may be RUNNING, and this command evicts it, so nothing was changed.\n"
      + `Check it with:\n  launchctl print ${guiTarget}\n  launchctl print user/${uid}/${LABEL}\n`
      + "A non-Aqua context (ssh, cron, a launchd daemon) cannot always reach gui/<uid>; re-run "
      + `'${wasInstalled ? "ocx service repair" : "ocx service install"}' from a GUI login session.`,
    );
  }

  let rendered = buildPlist(resolvedProxyEnv(), { launcher });
  if (previousPlist !== null && previousPlist !== rendered && verdict.state === "loaded-current") {
    // The live job runs exactly the exec line this install baked, so the definition on disk
    // IS the one launchd is running: keep the PATH it already carries instead of replacing
    // it with the repairing process's. See `reusePreviousPlistPathVariable`.
    const adopted = reusePreviousPlistPathVariable(previousPlist, rendered);
    if (adopted !== null) rendered = adopted;
  }
  // Whether launchd has to be handed NEW BYTES, which is what decides below whether a
  // `kickstart` can be trusted. `previousPlist === null` (a fresh install) counts: whatever
  // the label may hold did not come from a definition we can see.
  const renderedDiffers = previousPlist !== rendered;

  // ── Writes start here. ──
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  recordOwnedConfigPath(getConfigDir(), serviceStatePath());
  if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true });
  const tokenFile = serviceApiTokenFilePath();
  const previousToken = readTextOrNull(tokenFile);
  writeServiceApiTokenFile();
  // A rotated data token only reaches the job through a restart, so it is part of "is this
  // repair a no-op?" — the plist `cat`s this file at launch.
  const tokenUnchanged = readTextOrNull(tokenFile) === previousToken;

  if (!renderedDiffers && tokenUnchanged && verdict.state === "loaded-current") {
    // The plist is not rewritten and launchd is not touched; only the owner-only mode
    // is re-asserted, for a definition an older version may have left at 0644.
    try { chmodSync(p, 0o600); } catch { /* best-effort */ }
    // Install state is refreshed because it is what `expectedLaunchdCommand` reads, and
    // a repair that leaves it stale re-creates the false "OLDER plist" report.
    writeServiceInstallState("scheduler", launcher);
    console.log("ℹ️  service is already loaded from the current plist; nothing to do.");
    // The ONLY `reloaded: false` exit: the process launchd was running when this command
    // started is still running, same pid. `ocx service restart` turns that into a kickstart.
    return { reloaded: false };
  }

  if (previousPlist !== null) {
    // Best-effort: a backup we could not write must not stop the repair, but it is the
    // only thing that makes the rollback below able to restore bytes rather than guesses.
    //
    // `.plist.prev`, not `.prev.plist`: launchd globs `~/Library/LaunchAgents/*.plist` at
    // login, so a backup ending in `.plist` would be a second registration of the same
    // Label fighting the real one for the port.
    try { writeServiceDefinitionFile(`${p}.prev`, previousPlist, "utf8"); } catch { /* best-effort */ }
  }
  writeServiceDefinitionFile(p, rendered, "utf8");

  // This EVICTS the running job, and from here until the verification below nothing is
  // listening. `unload` is the legacy verb and does not evict a job bootstrapped into the
  // GUI domain — precisely the state that could not repair itself (#4141).
  //
  // Absence is fine: booting out a job that is not there exits 3 ("No such process"), and
  // a real failure is reported by the verification below with a better message than a raw
  // eviction error would carry.
  const evictEveryDomain = (): void => {
    for (const target of evictionTargets) {
      // Settle only where something was actually evicted. `bootout` is asynchronous, so a
      // job it DID remove needs waiting for; one it never held (exit 3) has nothing to
      // wait on, and probing it would only add a round trip per install.
      if (run(["bootout", target]).status === 0) settleLaunchdEviction(run, target, sleepSync);
    }
  };
  const evictThenBootstrap = (): { ok: boolean; stdout: string; stderr: string; status: number | null } => {
    evictEveryDomain();
    return run(["bootstrap", guiDomain, p]);
  };

  let loaded = evictThenBootstrap();
  verdict = probeLive();
  // `unknown` is excluded on purpose: a retry means another eviction, and a probe that
  // could not answer is not a reason to take the job down again.
  if (verdict.state === "not-loaded" || verdict.state === "loaded-stale") {
    // ONE retry. A bounded retry recovers the race; a loop would turn a wedged domain
    // into a hang instead of the diagnosable throw below.
    if (loaded.status === LAUNCHCTL_BOOTSTRAP_BUSY || launchctlLoadFailed(loaded.stderr)) {
      // "Bootstrap failed: 5: Input/output error" has TWO causes, measured on macOS 27.0
      // with a throwaway label, and they need opposite remedies:
      //
      //  - something is still bootstrapped under our label (the job re-registered, or it
      //    had not finished exiting). `kickstart -k` restarts what the domain holds without
      //    opening a second eviction window — but it restarts launchd's CACHED definition
      //    and does NOT re-read the plist, so it can only settle this when the rendered
      //    bytes are the ones already on disk. With new bytes it would restart the OLD
      //    definition, and since the exec line is unchanged whenever only
      //    `EnvironmentVariables` moved, the verification below would agree and install
      //    state would be written while launchd kept the stale environment. So: new bytes
      //    skip kickstart and go to the eviction, which is the only way to publish them.
      //  - the label is in the domain's DISABLED list, so `bootstrap` refuses it while
      //    `launchctl print` reports 113. This is the one thing the legacy `load -w` did
      //    that plain `bootstrap` does not: `-w` cleared that flag. `enable` is the modern
      //    spelling of it, and it is idempotent on a job that was never disabled — but it
      //    runs only here, so an ordinary repair does not quietly undo a deliberate
      //    `launchctl disable`.
      const kicked = renderedDiffers ? null : run(["kickstart", "-k", guiTarget]);
      if (kicked?.ok) verdict = probeLive();
      if (verdict.state !== "loaded-current") {
        run(["enable", guiTarget]);
        loaded = evictThenBootstrap();
        verdict = probeLive();
      }
    } else if (loaded.ok) {
      // Exit 0 while `print` disagrees: the load silently no-op'd. That IS worth evicting
      // again. A load that failed for any OTHER reason — a malformed plist, EPERM — is not
      // fixed by evicting a job, so it falls straight through to the throw and the
      // operator sees the real stderr instead of a delayed copy of it.
      loaded = evictThenBootstrap();
      verdict = probeLive();
    }
  }

  if (verdict.state === "unknown") {
    // The probe stopped answering between the pre-check and here. Do NOT evict again, do
    // NOT roll back (a rollback is another eviction) and do NOT claim the job is down: the
    // bytes we asked launchd to load are the ones on disk either way.
    if (!loaded.ok) {
      throw new Error(
        `launchctl could not bootstrap ${p}: ${loaded.stderr || "bootstrap reported failure"}\n`
        + `and the state of ${LABEL} could not be verified afterwards — ${verdict.detail ?? "launchctl could not be asked"}.\n`
        + "The job was NOT evicted again and the plist was left in place, so this says nothing about "
        + "whether it is running.\n"
        + `Check it with:\n  launchctl print ${guiTarget}\n  launchctl print user/${uid}/${LABEL}\n`
        + `and load it if it is absent:\n  launchctl bootstrap ${guiDomain} ${p}`,
      );
    }
    console.warn(
      `⚠️  launchctl accepted the bootstrap but the job state could not be verified — ${
        verdict.detail ?? "launchctl could not be asked"}. Check: launchctl print ${guiTarget}`,
    );
    writeServiceInstallState("scheduler", launcher);
    return { reloaded: true };
  }

  if (verdict.state !== "loaded-current") {
    // Do NOT write install state for a load that did not take: state describing an unused
    // plist is what made this failure invisible.
    let rolledBack: "restored" | "on-disk-only" | "none" = "none";
    if (previousPlist !== null) {
      try {
        writeServiceDefinitionFile(p, previousPlist, "utf8");
        evictEveryDomain();
        run(["bootstrap", guiDomain, p]);
        rolledBack = run(["print", guiTarget]).ok ? "restored" : "on-disk-only";
      } catch {
        rolledBack = "on-disk-only";
      }
    }
    // What the probe actually found, rather than one sentence for both outcomes: a
    // `loaded-stale` job IS running, and telling its operator "nothing is listening" sends
    // them to fix the wrong thing.
    const state = verdict.state === "loaded-stale"
      ? `is still loaded in ${verdict.domain ?? guiDomain} from a DIFFERENT command than the plist just written`
      : rolledBack === "restored"
        ? `was evicted from ${guiDomain}; the PREVIOUS plist was restored and re-bootstrapped`
        : `was evicted from ${guiDomain} and IS NOT RUNNING — nothing is listening`;
    throw new Error(
      `launchctl could not bootstrap ${p}: ${loaded.stderr || "bootstrap reported failure"}\n`
      + `The ${LABEL} job ${state}.\n`
      + (rolledBack === "on-disk-only"
        ? "The previous plist was restored on disk but could not be bootstrapped either.\n"
        : "")
      + `Recover manually with:\n  launchctl bootstrap ${guiDomain} ${p}\n`
      + `Inspect it with:\n  launchctl print ${guiTarget}\n  launchctl print-disabled ${guiDomain}\n`
      // macOS `service repair` delegates straight to installLaunchd, so this fires for
      // an already-installed service too; repair reloads it without re-registering.
      + `then re-run '${wasInstalled ? "ocx service repair" : "ocx service install"}'.`,
    );
  }
  writeServiceInstallState("scheduler", launcher);
  // The rollback copy has done its job: the new definition is verified loaded. Leaving it
  // behind makes the NEXT repair's backup ambiguous (which failure did it come from?) and
  // `uninstall` the only thing that ever cleaned it up.
  if (existsSync(`${p}.prev`)) { try { unlinkSync(`${p}.prev`); } catch { /* best-effort */ } }
  return { reloaded: true };
}

/**
 * Restart the loaded job IN PLACE — the `restart` half of `ocx service restart`.
 *
 * Only reached when {@link installLaunchd} reported `reloaded: false`, i.e. the plist is
 * already the current one and the probe proved the job is loaded from it. Nothing has to be
 * published, so this must NOT evict: `kickstart -k` restarts what the domain already holds
 * without opening an eviction window, which is the whole reason `restart` can be honest
 * about a healthy service while `repair` stays a no-op on it. `kickstart` restarts the
 * definition launchd has CACHED and does not re-read the plist — harmless here, and exactly
 * why the retry path inside `installLaunchd` may only use it for bytes already on disk.
 *
 * `launchctl print` answers about REGISTRATION, not liveness, so the verification asks the
 * same tri-state probe `installLaunchd` does: `loaded-current` is the restart confirmed,
 * `unknown` is not evidence of anything and only warns, and absence after a kick means the
 * job went away and KeepAlive did not bring it back — which throws, so the repair branch
 * reports it and still runs its serving check.
 *
 * Both deps are test seams, and the default runner is also refused by
 * `assertLiveServiceManagerAllowed`: `kickstart` is not a read-only verb, so an armed test
 * process that reached the real runner would fail closed rather than bounce the developer's
 * own hub.
 */
export function restartLaunchdJob(deps: {
  launchctl?: typeof runLaunchctl;
  probe?: typeof probeLaunchdLoadState;
  /** The exec line the live job must carry; defaults to the one an install would bake. */
  expectedCommand?: () => string;
} = {}): void {
  const run = deps.launchctl ?? runLaunchctl;
  const target = `${launchdGuiDomain()}/${LABEL}`;
  const expectedCommand = deps.expectedCommand
    ?? (() => launchdServiceCommand(stableLauncherEntry()));
  const kicked = run(["kickstart", "-k", target]);
  const verdict = (deps.probe ?? probeLaunchdLoadState)({ expectedCommand });
  if (!kicked.ok || verdict.state === "not-loaded" || verdict.state === "loaded-stale") {
    // Three different things to say, because they send the operator to three different
    // places: the job is gone, the job is up on an older definition, or the job is up and
    // `kickstart` refused — in which case the proxy is fine and only the restart failed.
    const state = verdict.state === "not-loaded"
      ? `is NOT loaded in ${launchdGuiDomain()} — nothing is listening`
      : verdict.state === "loaded-stale"
        ? "is loaded from a DIFFERENT command than the plist on disk"
        : "is still loaded, so it may be serving the process this restart failed to replace";
    throw new Error(
      `launchctl could not restart ${LABEL}: ${kicked.stderr || "kickstart reported failure"}\n`
      + `The ${LABEL} job ${state}.\n`
      + `Restart it manually with:\n  launchctl kickstart -k ${target}\n`
      + `Inspect it with:\n  launchctl print ${target}\n`
      + "and run 'ocx service repair' if it is absent.",
    );
  }
  if (verdict.state === "unknown") {
    console.warn(
      `⚠️  launchctl accepted the restart but the job state could not be verified — ${
        verdict.detail ?? "launchctl could not be asked"}. Check: launchctl print ${target}`,
    );
    return;
  }
  console.log(`ℹ️  service restarted (launchctl kickstart -k ${target}).`);
}

/**
 * Deps are named for the layer they replace, not for the process API: `launchctl`
 * returns a {@link runLaunchctl} result and `matches` a {@link launchdJobMatchesPlist}
 * result. Only `runLaunchctl` itself takes a spawnSync mock.
 *
 * Exported for the branch tests. Every parameter is optional, so this stays
 * assignable to `ServiceOps.start` (`() => void`) and `platformOps` wires the same
 * function the tests exercise.
 */
export function startLaunchd(deps: {
  launchctl?: typeof runLaunchctl;
  matches?: typeof launchdJobMatchesPlist;
} = {}): void {
  const run = deps.launchctl ?? runLaunchctl;
  const p = plistPath();
  const loaded = run(["load", "-w", p]);
  if (loaded.ok && !launchctlLoadFailed(loaded.stderr)) return;
  // `Load failed` on start is AMBIGUOUS in a way it is not on install: the job may
  // already be bootstrapped from THIS plist, which is a no-op rather than an error.
  // `install` can assume a stale job (it just rewrote the plist); `start` cannot, and
  // throwing here would break `ocx service start` on every healthy service.
  const live = (deps.matches ?? launchdJobMatchesPlist)(
    expectedLaunchdCommand(installedServiceListenPort()),
  );
  if (live.loaded && live.matchesPlist) {
    console.log("ℹ️  service was already loaded from the current plist; nothing to do.");
    return;
  }
  throw new Error(
    `launchctl could not load ${p}: ${loaded.stderr || "load reported failure"}\n`
    + (live.loaded
      ? `launchd is running an OLDER plist. Fix:\n  launchctl bootout ${launchdGuiDomain()}/${LABEL}\n  ocx service repair`
      : "The job is not loaded. Run 'ocx service repair' to reload it."),
  );
}

/**
 * Evict the job with the modern, domain-explicit verb, in EVERY domain that can hold it;
 * fall back to legacy `unload` only when `bootout` could not be run at all.
 *
 * `unload` cannot evict a job bootstrapped into the GUI domain (the same reason
 * `installLaunchd` stopped using it), so a stop built on it reported success while the
 * proxy kept serving. Exit 3 ("Boot-out failed: 3: No such process") is the not-loaded
 * case and is not a failure here.
 *
 * `gui/<uid>` alone was the remaining half of that bug: `probeLaunchdLoadState` reports a
 * `user/<uid>` job too, and against one of those this function exited 3 in the wrong domain
 * and returned as if it had stopped something. See {@link launchdEvictionTargets}.
 */
export function stopLaunchd(deps: { launchctl?: typeof runLaunchctl } = {}): void {
  const run = deps.launchctl ?? runLaunchctl;
  let spawnable = true;
  try {
    for (const target of launchdEvictionTargets()) {
      // Any real exit status is final — including 3, which only means the job was not
      // loaded THERE. `status: null` is "launchctl could not be spawned at all", and only
      // then is the legacy verb worth one attempt.
      if (run(["bootout", target]).status === null) spawnable = false;
    }
  } catch {
    // The armed-test guard refuses mutating verbs; retrying through `sh` would only hit it
    // again.
    return;
  }
  if (spawnable) return;
  try { sh(`launchctl unload "${plistPath()}"`); } catch { /* not loaded */ }
}

/**
 * Registration for `ocx service stop`'s "is anything installed?" guard, as a human string.
 * Empty means "no job of ours is loaded"; the tri-state lives in
 * {@link probeLaunchdLoadState}, which `diagnoseService` uses instead of this.
 */
export function statusLaunchd(deps: { probe?: typeof probeLaunchdLoadState } = {}): string {
  const probe = (deps.probe ?? probeLaunchdLoadState)();
  if (probe.state === "loaded-current") return `${LABEL} loaded in ${probe.domain ?? launchdGuiDomain()}`;
  if (probe.state === "loaded-stale") return `${LABEL} loaded in ${probe.domain ?? launchdGuiDomain()} from an OLDER plist`;
  if (probe.state === "unknown") return `${LABEL} state unknown: ${probe.detail ?? "launchctl could not be asked"}`;
  return "";
}

export function uninstallLaunchd(deps: { launchctl?: typeof runLaunchctl } = {}): void {
  const p = plistPath();
  // Same reason as `installLaunchd`: HOME isolation does not move this path, so without
  // the guard an armed test process deletes the developer's live plist.
  assertNotRealLaunchAgentsUnderTest(dirname(p));
  stopLaunchd(deps);
  if (existsSync(p)) unlinkSync(p);
  // The rollback copy is part of the installation, not a user file.
  if (existsSync(`${p}.prev`)) { try { unlinkSync(`${p}.prev`); } catch { /* best-effort */ } }
}
