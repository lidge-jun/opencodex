/**
 * Bundled Bun runtime resolution.
 *
 * opencodex ships the Bun runtime via the `bun` npm dependency (esbuild-style:
 * a tiny main package + platform-specific `@oven/bun-*` optionalDependencies,
 * finalized by the package's own postinstall `node install.js`). The npm `bin`
 * launcher (bin/ocx.mjs) and the durable service/shim integrations both need a
 * stable path to that binary. This module is the single source of truth.
 *
 * In a from-source dev checkout the `bun` dependency may be absent; callers fall
 * back to `process.execPath` (which is itself Bun when run via `bun src/cli/index.ts`).
 */
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRealBunBinary } from "./bun-binary-validator.mjs";

export { isRealBunBinary };

const require = createRequire(import.meta.url);

const BUN_OVERRIDE_ENV = "OPENCODEX_BUN_PATH";

/**
 * Env marker stamped by whichever launcher selected the Bun binary, then read back
 * inside the launched process.
 *
 * Provenance has to travel with the launch because it cannot be recovered afterwards:
 * resolving it at report time answers "what would this shell pick now", not "what was
 * this service started with", and those differ exactly when the answer matters.
 */
export const BUN_RUNTIME_SOURCE_ENV = "OCX_BUN_RUNTIME_SOURCE";

/**
 * The binary the marker was minted for. Stamped beside the source so a reader can tell
 * whether a marker still describes the process holding it, without re-deriving the
 * selection from an environment that may no longer contain it.
 */
export const BUN_RUNTIME_PATH_ENV = "OCX_BUN_RUNTIME_PATH";

export type BunRuntimeSource = "override" | "bundled" | "process";

/** The only provenance values any surface may accept off the wire or out of the env. */
export const BUN_RUNTIME_SOURCES: readonly BunRuntimeSource[] = ["override", "bundled", "process"];

export type DurableBunRuntime = {
  path: string;
  source: BunRuntimeSource;
  overrideEnv: typeof BUN_OVERRIDE_ENV;
};

/**
 * The provenance this process was launched with, or `undefined` when nothing
 * trustworthy is recorded.
 *
 * Deliberately never falls back to `durableBunRuntime()`. A service installed before
 * the marker existed has no provenance, and guessing one from the current environment
 * would report a confident wrong answer — "unknown" is the honest result and callers
 * are expected to say so. Values outside the allowlist are treated as absent rather
 * than passed through.
 */
export function reportedBunRuntimeSource(
  env: NodeJS.ProcessEnv = process.env,
): BunRuntimeSource | undefined {
  const raw = env[BUN_RUNTIME_SOURCE_ENV]?.trim();
  const source = BUN_RUNTIME_SOURCES.find(candidate => candidate === raw);
  if (!source) return undefined;
  // Source and binary are a PAIR: without a recorded path that names THIS
  // executable, the marker describes some other launch and must not be
  // reported (a bare OCX_BUN_RUNTIME_SOURCE inherited from an unrelated
  // parent would otherwise claim a confident wrong origin).
  const recordedPath = env[BUN_RUNTIME_PATH_ENV]?.trim();
  if (!recordedPath || !samePath(recordedPath, process.execPath)) return undefined;
  return source;
}

/** Env pair a launcher stamps for the binary it just selected. */
export function bunRuntimeProvenanceEnv(runtime: DurableBunRuntime): Record<string, string> {
  return { [BUN_RUNTIME_SOURCE_ENV]: runtime.source, [BUN_RUNTIME_PATH_ENV]: runtime.path };
}

/**
 * Child environment for a proxy started with `process.execPath` — the runtime this
 * process is already using.
 *
 * These launchers re-exec the current runtime rather than resolving a binary, so the
 * provenance to report is whatever launched THIS process. Without this the marker would
 * be silently dropped on `ocx ensure`, GUI start, restart, and update-relaunch, and the
 * service would report an unknown origin it actually knows.
 *
 * An inherited marker is carried forward only when the binary it was minted for is the
 * one about to be re-executed. Inheritance travels down a process tree, so a marker can
 * outlive its binary — something started under a marked process but running a different
 * Bun would otherwise relaunch the daemon with a provenance contradicting the binary
 * actually serving it. The check compares the recorded path rather than re-deriving the
 * selection, because a service installed with a shell-local override keeps neither that
 * shell nor its `OPENCODEX_BUN_PATH`, and re-deriving would demote a correct `override`
 * to `process` on its first relaunch.
 */
export function withProcessRuntimeProvenance(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return { ...env, ...bunRuntimeProvenanceEnv(currentRuntimeProvenance(env)) };
}

/**
 * Provenance for `process.execPath`: the inherited claim when it was minted for this
 * exact executable, otherwise what this executable actually is.
 */
function currentRuntimeProvenance(env: NodeJS.ProcessEnv): DurableBunRuntime {
  const recorded = recordedCurrentRuntime(env);
  if (recorded) return recorded;
  // No marker that describes this binary: report what is running. One resolution
  // supplies both halves so the pair can never disagree.
  const runtime = unmarkedDurableBunRuntime();
  return samePath(runtime.path, process.execPath)
    ? runtime
    : { path: process.execPath, source: "process", overrideEnv: BUN_OVERRIDE_ENV };
}

function recordedCurrentRuntime(env: NodeJS.ProcessEnv): DurableBunRuntime | null {
  const source = reportedBunRuntimeSource(env);
  const path = env[BUN_RUNTIME_PATH_ENV]?.trim();
  if (!source || !path || !samePath(path, process.execPath)) return null;
  return { path, source, overrideEnv: BUN_OVERRIDE_ENV };
}

/**
 * Same file, allowing for the aliases a path can pick up between launch and relaunch:
 * symlinks/junctions, mapped drives, and Windows case differences. Falls back to a
 * lexical comparison when a path cannot be resolved (it may be gone).
 */
function samePath(left: string, right: string): boolean {
  const canonical = (value: string): string => {
    let resolved = value;
    try { resolved = realpathSync(value); } catch { /* keep the literal path */ }
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return canonical(left) === canonical(right);
}

/**
 * Absolute path to the bundled Bun binary, or null if the `bun` dependency is
 * not installed/resolvable (or only the un-downloaded placeholder is present).
 * The npm `bun` package ships the binary as `bin/bun.exe` on every platform;
 * we also probe `bin/bun` for forward compatibility.
 */
export function bundledBunPath(): string | null {
  try {
    const bunDir = dirname(require.resolve("bun/package.json"));
    for (const name of ["bun.exe", "bun"]) {
      const p = join(bunDir, "bin", name);
      if (isRealBunBinary(p)) return p;
    }
    return null;
  } catch {
    return null;
  }
}

function unmarkedDurableBunRuntime(): DurableBunRuntime {
  const bundled = bundledBunPath();
  if (bundled) return { path: bundled, source: "bundled", overrideEnv: BUN_OVERRIDE_ENV };
  return { path: process.execPath, source: "process", overrideEnv: BUN_OVERRIDE_ENV };
}

export function durableBunRuntime(): DurableBunRuntime {
  // A durable artifact must use the runtime selected BEFORE Bun auto-loaded a
  // project dotenv. The Node launcher and owned service/shim launchers stamp the
  // selected source/path pair; it is accepted only when it names this exact
  // running executable. Re-reading OPENCODEX_BUN_PATH here would let a project
  // `.env` persist an arbitrary executable into a shim or service.
  return recordedCurrentRuntime(process.env) ?? unmarkedDurableBunRuntime();
}

/**
 * Bun path to bake into durable artifacts (launchd/systemd/Task Scheduler and
 * the Codex auto-start shim). Prefer the bundled binary — it lives under the
 * npm global prefix and survives across `ocx update` — and fall back to the
 * current runtime, which is Bun when launched normally.
 */
export function durableBunPath(): string {
  return durableBunRuntime().path;
}
