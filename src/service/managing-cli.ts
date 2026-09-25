/**
 * Observe the two CLIs that can manage this runtime: the one baked into the preserved
 * service registration, and the `ocx` the PATH resolves today.
 *
 * Both answers feed `assessServiceTakeoverCompatibility`, which refuses a takeover when
 * either observation is unknown — a managing binary that cannot be named cannot be held to
 * the ownership-aware floor. `absent` is a trustworthy answer; `unknown` is not.
 *
 * The PATH lookup is an in-module directory scan rather than `where`/`which`: spawning a
 * shell builtin to find a binary makes the answer depend on the host's PATH handling, and
 * this module exists so the resolve/claim path is deterministic and testable. And the one
 * thing it must never do is spawn `process.execPath`: that binary is THIS CLI, and asking
 * it for its version under `ocx --version` semantics is the recursion #5418 closed. When
 * the located file IS this binary, its version is already known.
 */
import { existsSync, statSync } from "node:fs";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { delimiter, posix, win32 } from "node:path";
import { parseStrictSemver } from "../lib/strict-semver";
import { packageVersion } from "../lib/package-version";
import {
  registeredManagingCliInvocation,
  type ManagingCliObservation,
  type ManagingCliRole,
} from "./ownership-compatibility";
import type { ServiceInstallState } from "./state";

const VERSION_PROBE_TIMEOUT_MS = 5000;

export interface ManagingCliDeps {
  /** Environment to scan PATH/PATHEXT in. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Spawn seam. Defaults to `spawnSync`. */
  spawn?: typeof spawnSync;
  /** The running binary, for the never-spawn-yourself rule. Defaults to `process.execPath`. */
  execPath?: string;
  /** This binary's own version, for the self-observation shortcut. */
  ownVersion?: () => string;
  /** Filesystem existence seam. */
  exists?: (path: string) => boolean;
  /** Validate the selected candidate as a regular file. */
  isFile?: (path: string) => boolean;
  /** Host platform override for tests. */
  platform?: NodeJS.Platform;
}

/** The first strict-semver token in a `--version` line (`opencodex 2.61.0` → `2.61.0`). */
function versionFromOutput(stdout: string): string | null {
  for (const token of stdout.trim().split(/\s+/)) {
    if (parseStrictSemver(token)) return token;
  }
  return null;
}

function probeVersion(
  executable: string,
  args: readonly string[],
  deps: Required<Pick<ManagingCliDeps, "spawn" | "platform" | "env">>,
): ManagingCliObservation {
  const identity = [executable, ...args].join(" ");
  let result: SpawnSyncReturns<string>;
  try {
    const windowsShim =
      deps.platform === "win32" && /\.(cmd|bat)$/i.test(executable);
    if (windowsShim && [executable, ...args].some(part => /[&|<>^%!"()]/.test(part))) {
      return { status: "unknown", reason: "the selected Windows command shim invocation cannot be probed safely" };
    }
    result = deps.spawn(
      windowsShim ? (deps.env?.ComSpec ?? "cmd.exe") : executable,
      windowsShim ? ["/c", executable, ...args, "--version"] : [...args, "--version"],
      { timeout: VERSION_PROBE_TIMEOUT_MS, encoding: "utf8", stdio: "pipe", windowsHide: true },
    ) as SpawnSyncReturns<string>;
  } catch (error) {
    return {
      status: "unknown",
      reason: `${identity} --version could not run: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (result.error) {
    return {
      status: "unknown",
      reason: `${identity} --version did not finish: ${result.error.message}`,
    };
  }
  if (result.status !== 0) {
    return { status: "unknown", reason: `${identity} --version exited ${result.status ?? "without a code"}` };
  }
  const version = versionFromOutput(result.stdout ?? "");
  return version === null
    ? { status: "unknown", reason: `${identity} --version printed no semver` }
    : { status: "observed", version, identity };
}

/**
 * Where `ocx` resolves on PATH without spawning `where`/`which`.
 *
 * Returns the absolute candidate or null. On Windows every PATHEXT extension is tried (and
 * the bare name, for extensionless shims); elsewhere the bare name only.
 */
function findOcxOnPath(
  env: Record<string, string | undefined>,
  exists: (path: string) => boolean,
  platform: NodeJS.Platform,
): string | null {
  const pathValue = env.PATH ?? env.Path ?? env.path;
  if (!pathValue) return null;
  const pathApi = platform === "win32" ? win32 : posix;
  const extensions = platform === "win32"
    ? [...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(ext => /^\.[A-Za-z0-9]+$/.test(ext)), ""]
    : [""];
  for (const directory of pathValue.split(platform === "win32" ? ";" : delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = pathApi.join(directory, `ocx${extension}`);
      if (exists(candidate)) return pathApi.resolve(candidate);
    }
  }
  return null;
}

function observeServiceRegistration(
  state: ServiceInstallState | null,
  deps: Required<Pick<ManagingCliDeps, "spawn" | "platform" | "env">>,
): ManagingCliObservation {
  const invocation = registeredManagingCliInvocation(state);
  if (invocation.status !== "resolved") return invocation;
  return probeVersion(invocation.executable, invocation.args, deps);
}

function observePathCli(
  deps: Required<Pick<ManagingCliDeps, "spawn" | "platform" | "env" | "execPath" | "ownVersion" | "exists" | "isFile">>,
): ManagingCliObservation {
  const found = findOcxOnPath(deps.env, deps.exists, deps.platform);
  if (!found) return { status: "absent" };
  if (!deps.isFile(found)) {
    return { status: "unknown", reason: "the selected managing CLI is not a readable file" };
  }
  const self = (deps.platform === "win32" ? win32 : posix).resolve(deps.execPath);
  if (found === self || (deps.platform === "win32" && found.toLowerCase() === self.toLowerCase())) {
    // Never spawn ourselves for our own version: the answer is already in hand, and the
    // recursion that produced it is the #5418 regression.
    return { status: "observed", version: deps.ownVersion(), identity: found };
  }
  return probeVersion(found, [], deps);
}

/**
 * Both managing-CLI observations, for `assessServiceTakeoverCompatibility` and for the
 * revalidation `recordServiceOwner` runs inside its lock.
 */
export function observeManagingClis(
  state: ServiceInstallState | null,
  deps: ManagingCliDeps = {},
): Readonly<Record<ManagingCliRole, ManagingCliObservation>> {
  const resolved = {
    spawn: deps.spawn ?? spawnSync,
    platform: deps.platform ?? process.platform,
    env: deps.env ?? (process.env as Record<string, string | undefined>),
    execPath: deps.execPath ?? process.execPath,
    ownVersion: deps.ownVersion ?? packageVersion,
    exists: deps.exists ?? existsSync,
    isFile: deps.isFile ?? ((path: string) => {
      try { return statSync(path).isFile(); } catch { return false; }
    }),
  };
  return {
    "service-registration": observeServiceRegistration(state, resolved),
    path: observePathCli(resolved),
  };
}
