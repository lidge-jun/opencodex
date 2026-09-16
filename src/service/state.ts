import { accessSync, chmodSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";
import { expandUserPath, getConfigDir } from "../config";
import { resolveCodexHomeDir, type CodexHomeDeps } from "../codex/home";
import { durableBunRuntime, type BunRuntimeSource, type DurableBunRuntime } from "../lib/bun-runtime";
import { WINSW_SHA256, WINSW_VERSION } from "../lib/winsw";
import { hardenSecretPath } from "../lib/windows-secret-acl";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { isProtectedHomeUnderTest, isTestHomeGuardArmed } from "../lib/test-home-guard";

/**
 * Written only by the launchd plist and the systemd unit. `OCX_SERVICE=1` cannot stand in
 * for it: `ocx claude` and `ocx opencode` set that on the proxies they spawn to borrow its
 * routing-preservation meaning, so a proxy carrying it is not necessarily the managed job.
 */
export const SERVICE_MANAGED_ENV = "OCX_SERVICE_MANAGED";

export const LABEL = "com.opencodex.proxy";
export const TASK = "opencodex-proxy";

// This module lives one level below the original src/service.ts, so path-relative
// lookups anchored at that file's directory go through this constant instead.
export const serviceSourceDir = dirname(import.meta.dir);

export type ServiceBackend = "scheduler" | "native";

export function cliEntry(runtime: DurableBunRuntime = durableBunRuntime()): { bun: string; bunRuntimeSource: BunRuntimeSource; cli: string } {
  // Bake the bundled Bun (manager-owned global package directory, survives `ocx update`) rather than
  // a transient system Bun, so launchd/systemd/schtasks keep resolving even if a
  // standalone Bun is later removed. The CLI entry lives at src/cli/index.ts.
  //
  // Path and provenance come from ONE resolution so the marker can never describe a
  // different binary than the one actually baked.
  return { bun: runtime.path, bunRuntimeSource: runtime.source, cli: join(serviceSourceDir, "cli", "index.ts") };
}

/**
 * The stable `ocx` launcher to bake into a systemd unit, or null to fall back to the
 * Bun + CLI pair.
 *
 * `cliEntry()` resolves both of its paths from `import.meta.dir`, so they point INSIDE
 * the installed package tree. Under a version manager that tree is a versioned directory:
 * `~/.local/share/mise/installs/npm-opencodex/2.35.0/...`. An upgrade installs 2.36.0 and
 * deletes 2.35.0, after which the unit's `exec <old-bun> <old-cli>` cannot resolve, and
 * `Restart=on-failure` turns that into a restart loop (#2898). The shim in
 * `~/.local/share/mise/shims/ocx` survives the upgrade and dispatches to whatever version
 * is current, so it is the durable thing to name.
 *
 * Deliberately LEXICAL. Resolving the symlink would write the versioned target back into
 * the unit and reintroduce the bug — the indirection is the entire point.
 *
 * Only an absolute path is accepted. A bare `ocx` would be re-resolved through `PATH` on
 * every restart, which turns a service definition into a PATH-hijacking surface; naming
 * one validated absolute file keeps the target fixed at install time.
 *
 * The RECORDED launcher wins over a fresh PATH walk. `ocx service repair` runs from
 * whatever shell the operator (or `ocx update`, or a tray helper) happened to have, and a
 * context without `ocx` on `PATH` used to resolve null here — rewriting a working
 * launcher-form plist into the version-pinned Bun + CLI pair and then booting the healthy
 * job out to load it (#4236, defect 1g). A launcher that is still an executable file is
 * the thing the installed service already runs, so repair must keep naming it; only a
 * recorded launcher that has disappeared falls through to discovery.
 *
 * That preference is NOT macOS-only: `installSystemd` resolves this same function, so a
 * Linux `ocx service repair` from a PATH-less context keeps the `ExecStart` the unit
 * already has instead of rewriting it to the version-pinned pair — the #2898 shape this
 * function exists to avoid. The failure mode it prevents is milder there (systemd
 * `daemon-reload` + `restart` does not evict-then-maybe-nothing the way launchd did), but
 * the rewrite was the same, so the behavior is deliberately shared rather than branched.
 */
export function stableLauncherEntry(deps: {
  env?: NodeJS.ProcessEnv;
  isExecutableFile?: (path: string) => boolean;
  pathDelimiter?: string;
  state?: ServiceInstallState | null;
} = {}): string | null {
  const env = deps.env ?? process.env;
  const isExecutableFile = deps.isExecutableFile ?? ((path: string): boolean => {
    try {
      if (!statSync(path).isFile()) return false;
      accessSync(path, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  const recorded = (deps.state === undefined ? readServiceInstallState() : deps.state)?.launcherPath;
  if (recorded && isAbsolute(recorded) && isExecutableFile(recorded)) return recorded;
  const entries = (env.PATH ?? "").split(deps.pathDelimiter ?? delimiter);
  for (const entry of entries) {
    if (!entry || !isAbsolute(entry)) continue;
    const candidate = join(entry, "ocx");
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

export function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

export function logPath(): string {
  return join(getConfigDir(), "service.log");
}

export function serviceLogPath(): string {
  return logPath();
}

export function windowsServiceScriptPath(): string {
  return join(getConfigDir(), "opencodex-service.cmd");
}

export function windowsLauncherVbsPath(): string {
  return join(getConfigDir(), "opencodex-service-launcher.vbs");
}

export function windowsTaskXmlPath(): string {
  return join(getConfigDir(), "opencodex-service-task.xml");
}

export function serviceStatePath(): string {
  return join(getConfigDir(), "service-state.json");
}

function defaultOpenCodexHome(): string {
  return resolve(join(homedir(), ".opencodex"));
}

export function serviceStatePathsForOpenCodexHome(opencodexHome: string): string[] {
  const paths = [join(opencodexHome, "service-state.json")];
  const defaultPath = join(defaultOpenCodexHome(), "service-state.json");
  if (normalizePathForCompare(defaultPath) !== normalizePathForCompare(paths[0])) paths.push(defaultPath);
  return paths;
}

export function serviceStatePaths(): string[] {
  const paths = serviceStatePathsForOpenCodexHome(currentOpenCodexHome());
  if (!isTestHomeGuardArmed()) return paths;
  /*
   * Under an armed test process the legacy default-home entry IS the developer's real
   * `~/.opencodex/service-state.json`. It is there so an install made before
   * OPENCODEX_HOME was set can still be found, but it means a test whose OPENCODEX_HOME
   * points at a sandbox still writes their live install state — observed while building
   * the launchd repair coverage: one case replaced the real record's codexHome and
   * opencodexHome with temp-directory paths. Drop it rather than deny the write, so the
   * sandbox path keeps working and the real one is simply not in the list.
   *
   * The predicate is the guard's own, not a local `resolve()` compare: the guard
   * canonicalizes through `realpath`, and on macOS a sandbox under `/var/folders/...`
   * resolves to `/private/var/folders/...`, so two spellings of one directory must not
   * decide this.
   */
  return paths.filter(path => !isProtectedHomeUnderTest(dirname(path)));
}

/**
 * The state paths a WRITE may use. Same list, but an empty one is an error instead of a
 * silent no-op.
 *
 * With OPENCODEX_HOME unset under an armed test process, `currentOpenCodexHome()` falls
 * back to the real `~/.opencodex` (`os.homedir()` ignores `$HOME`), the filter above then
 * removes every candidate, and `writeServiceInstallState` wrote NOTHING while reporting
 * success — a test asserting on install state would read the previous run's record, or
 * none. Fail the way `assertNotRealHomeUnderTest` does, naming the fix.
 */
function serviceStateWritePaths(): string[] {
  const paths = serviceStatePaths();
  if (paths.length > 0) return paths;
  throw new Error(
    "refusing to write service install state with no writable state path: every candidate "
    + "resolved to the real OpenCodex home and was filtered out. Point OPENCODEX_HOME at a "
    + "temp directory for this test (the preload does it for every invocation; something "
    + "deleted the variable without restoring it).",
  );
}

export function currentCodexHome(deps: CodexHomeDeps = {}): string {
  // Service ownership must identify the same home as the runtime. In WSL an
  // unset CODEX_HOME can resolve to the single Windows Desktop home rather than
  // Linux ~/.codex; recording the fallback here creates a false foreign owner.
  return resolveCodexHomeDir(deps);
}

export function currentCodexSqliteHomeAbsolute(target: "native" | "windows" = "native"): string | undefined {
  const raw = process.env.CODEX_SQLITE_HOME?.trim();
  if (!raw) return undefined;
  const expanded = expandUserPath(raw);
  // Service artifacts can be rendered by cross-platform tests and repair tooling, so an
  // already-absolute path for the TARGET platform is preserved rather than re-anchored
  // against the writing host. `resolve()` is host-relative in both directions: on a POSIX
  // host it turns `C:\data` into `<cwd>/C:\data`, and on a Windows host it turns `/tmp/x`
  // into `D:\tmp\x` — neither is a path the target can use. A relative value still resolves,
  // because a service unit has no meaningful working directory.
  //
  // CODEX_HOME and OPENCODEX_HOME are carried through literally, so without this the same
  // generated file disagreed with itself about two variables holding the same kind of value.
  if (target === "windows") {
    return win32.isAbsolute(expanded) ? win32.normalize(expanded) : resolve(expanded);
  }
  return posix.isAbsolute(expanded) ? posix.normalize(expanded) : resolve(expanded);
}

export function currentOpenCodexHome(): string {
  // getConfigDir() already resolves OPENCODEX_HOME with ~ expansion; keep the
  // install-state comparison on the same normalization or `~/...` values falsely
  // fail the environment-match check depending on cwd.
  return getConfigDir();
}

export function normalizePathForCompare(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export interface ServiceInstallState {
  version: 1 | 2;
  codexHome: string;
  opencodexHome: string;
  /** Baked at install; lets status flag paths gone stale after npm prefix/nvm moves. */
  bunPath?: string;
  cliPath?: string;
  /**
   * launchd and systemd. The stable `ocx` launcher the service definition actually invokes,
   * when one was found. Present means `bunPath`/`cliPath` are provenance for the install,
   * NOT what the service runs — so staleness must be judged against THIS path instead. A version-manager
   * upgrade replaces the directory those two point into while the launcher survives, and
   * checking the old pair would report a stale service that is in fact healthy.
   */
  launcherPath?: string;
  /** v2: which Windows backend was chosen at install; absent (v1/legacy) means scheduler. */
  backend?: ServiceBackend;
  winswVersion?: string;
  winswSha256?: string;
}

export function parseServiceInstallState(value: unknown): ServiceInstallState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (state.version !== 1 && state.version !== 2) return null;
  if (typeof state.codexHome !== "string" || state.codexHome.length === 0) return null;
  if (typeof state.opencodexHome !== "string" || state.opencodexHome.length === 0) return null;
  for (const key of ["bunPath", "cliPath", "launcherPath", "winswVersion", "winswSha256"] as const) {
    if (state[key] !== undefined && (typeof state[key] !== "string" || state[key].length === 0)) return null;
  }
  if (state.version === 1) {
    if (state.backend !== undefined) return null;
  } else if (state.backend !== "scheduler" && state.backend !== "native") {
    return null;
  }
  return state as unknown as ServiceInstallState;
}

export function writeServiceInstallState(backend: ServiceBackend = "scheduler", launcherPath?: string | null): void {
  const { bun, cli } = cliEntry();
  const state: ServiceInstallState = {
    version: 2,
    codexHome: currentCodexHome(),
    opencodexHome: currentOpenCodexHome(),
    bunPath: bun,
    cliPath: cli,
    ...(launcherPath ? { launcherPath } : {}),
    backend,
    ...(backend === "native" ? { winswVersion: WINSW_VERSION, winswSha256: WINSW_SHA256 } : {}),
  };
  for (const path of serviceStateWritePaths()) {
    const dir = dirname(path);
    recordOwnedConfigPath(getConfigDir(), path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
    if (process.platform === "win32") hardenSecretPath(path, { required: true });
  }
}

export function readServiceInstallState(): ServiceInstallState | null {
  for (const path of serviceStatePaths()) {
    try {
      const parsed = parseServiceInstallState(JSON.parse(readFileSync(path, "utf8")));
      if (parsed) return parsed;
    } catch {
      /* try the next known state path */
    }
  }
  return null;
}

/** What ONE state path said. Absent, unreadable and invalid are different answers. */
export type ServiceStateEvidence =
  | { readonly path: string; readonly kind: "absent" }
  | { readonly path: string; readonly kind: "unreadable"; readonly reason: string }
  | { readonly path: string; readonly kind: "invalid" }
  | { readonly path: string; readonly kind: "valid"; readonly state: ServiceInstallState };

/**
 * Every state path, with what each one said.
 *
 * `readServiceInstallState` returns the FIRST path that parsed and discards the
 * rest, so a valid mirror beside a corrupt one reads as clean. That is the right
 * behavior for callers that just need the install state; it is the wrong input
 * for deciding ownership, where a disagreement between mirrors is exactly the
 * evidence that matters.
 */
export function inspectServiceStateEvidence(
  paths: readonly string[] = serviceStatePaths(),
): readonly ServiceStateEvidence[] {
  return paths.map((path): ServiceStateEvidence => {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
      // ENOENT is an answer. EACCES, ENOTDIR and the rest are a failure to ask,
      // and collapsing them into absence is how a locked-down state file would
      // become permission to write.
      if (code === "ENOENT") return { path, kind: "absent" };
      return { path, kind: "unreadable", reason: code || String(error) };
    }
    let parsed: ServiceInstallState | null;
    try {
      parsed = parseServiceInstallState(JSON.parse(raw));
    } catch {
      return { path, kind: "invalid" };
    }
    return parsed ? { path, kind: "valid", state: parsed } : { path, kind: "invalid" };
  });
}

/** The homes this process is actually using, for comparison against a claim. */
export function currentServiceHomes(deps: CodexHomeDeps = {}): { codexHome: string; opencodexHome: string } {
  return { codexHome: currentCodexHome(deps), opencodexHome: currentOpenCodexHome() };
}

export function serviceHomeMatches(a: string, b: string): boolean {
  return normalizePathForCompare(a) === normalizePathForCompare(b);
}

/** Single accessor for backend-sensitive service code — v1/legacy state maps to scheduler. */
export function readServiceBackend(): ServiceBackend {
  return readServiceInstallState()?.backend === "native" ? "native" : "scheduler";
}

/**
 * The `ocx` argv that refreshes an already-installed service after an update.
 *
 * `repair` discovers the installed backend itself. A healthy Windows scheduler task only
 * gets refreshed assets plus a restart; a stale live definition is re-registered and may
 * require elevation. `install` always reaches `/create`, so using repair here avoids an
 * unnecessary admin prompt for the common healthy update path.
 *
 * The historical export name is kept for callers outside this module.
 */
export function serviceReinstallArgs(): string[] {
  return ["service", "repair"];
}

/** The `ocx` argv that registers a service from scratch, preserving the chosen backend. */
export function serviceInstallArgs(): string[] {
  return readServiceBackend() === "native" ? ["service", "install", "--native"] : ["service", "install"];
}
