import { accessSync, constants, statSync } from "node:fs";
import { posix } from "node:path";
import { codexExecInvocation } from "./exec-invocation";
import type { SpawnInvocation } from "../lib/win-exec";
import { macCodexAppBundleFor, realpathOrNull } from "./mac-app-bundle";
import {
  untrustedChatgptBundleReason,
  untrustedChatgptBundleReasonAsync,
} from "../chatgpt/app-server-shim/bundle-trust";

/**
 * macOS execution-boundary trust for a resolved Codex target.
 *
 * Discovery and the resolver memo answer "which command would we run"; they are
 * deliberately exec-free and never prove trust. Every actual spawn/exec of a
 * Codex binary goes through this module instead: on darwin the command is
 * resolved with real execvp semantics (empty PATH segment = spawn cwd,
 * relative PATH entries resolve against that cwd, a slash in the command makes
 * it cwd/absolute-relative and PATH is skipped), classified by the shared
 * known-Codex-bundle classifier, and — when the lexical or canonical path sits
 * inside a ChatGPT.app or Codex.app bundle at any location — checked by the shared
 * signature/ownership policy before the same canonical target is returned for
 * execution. Anything else, including binaries inside third-party app bundles,
 * is passed through to the shared launcher unchanged.
 *
 * The check is one-shot per invocation and deliberately not memoized:
 * directory-service group membership, signature state, and directory-entry
 * ownership can change between resolve and exec, so a cached "trusted" answer
 * would invent a trust lifetime the platform does not provide.
 */
export class CodexExecTrustError extends Error {
  readonly reason: string;
  readonly code = "CODEX_EXEC_UNTRUSTED";
  constructor(reason: string) {
    super("untrusted Codex exec target: " + reason);
    this.name = "CodexExecTrustError";
    this.reason = reason;
  }
}

/** Default execvp search path on darwin when the spawn env carries no PATH (_CS_PATH). */
const DARWIN_DEFAULT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export interface CodexExecBoundaryDeps {
  /** Spawn environment; PATH resolution uses exactly this list. */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Working directory the spawn will use; empty/relative PATH segments resolve against it. */
  cwd?: string;
  /** Existence probe: win32 passthrough PATH resolution and POSIX EACCES classification. */
  exists?: (path: string) => boolean;
  /** POSIX spawnability predicate: regular file + X_OK. */
  executable?: (path: string) => boolean;
  /** Canonicalizer; returns null when the path cannot be resolved. */
  realpath?: (path: string) => string | null;
  macBundleTrustReason?: (bundleRoot: string, binary: string) => string | null;
}

export interface CodexExecBoundaryAsyncDeps extends Omit<CodexExecBoundaryDeps, "macBundleTrustReason"> {
  signal?: AbortSignal;
  /**
   * Async twin of the sync trust check. It MUST honor the forwarded signal:
   * once aborted it settles promptly, and any children it owns (dscl/codesign)
   * are killed and reaped before it settles - the boundary awaits it, so a
   * check that ignores the signal stalls the caller; one that abandons its
   * children leaks processes.
   */
  macBundleTrustReasonAsync?: (bundleRoot: string, binary: string, signal?: AbortSignal) => Promise<string | null>;
}

/** Same contract as workspace-executable's candidate check: regular file and executable bit. */
function executableTarget(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function spawnError(command: string, code: "ENOENT" | "EACCES"): Error {
  return Object.assign(new Error("spawn " + command + " " + code), { code });
}

/** Non-executability alone must not masquerade as "not found"; existence is probed separately. */
function existsTarget(path: string, deps: CodexExecBoundaryDeps): boolean {
  if (deps.exists) { try { return deps.exists(path); } catch { return false; } }
  try { statSync(path); return true; } catch { return false; }
}

/** execvp-style PATH resolution: first executable regular file wins; empty segment means cwd. */
function resolveDarwinExecPath(command: string, deps: CodexExecBoundaryDeps): { path: string } | { error: Error } {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const executable = deps.executable ?? executableTarget;
  const dirOf = (segment: string): string =>
    segment === "" ? cwd : segment.startsWith("/") ? segment : posix.resolve(cwd, segment);
  if (command.includes("/")) {
    const candidate = dirOf(command);
    if (executable(candidate)) return { path: candidate };
    return { error: spawnError(command, existsTarget(candidate, deps) ? "EACCES" : "ENOENT") };
  }
  const pathValue = env.PATH === undefined ? DARWIN_DEFAULT_PATH : env.PATH;
  let denied = false;
  for (const segment of pathValue.split(":")) {
    const candidate = dirOf(segment) + "/" + command;
    if (executable(candidate)) return { path: candidate };
    if (existsTarget(candidate, deps)) denied = true;
  }
  return { error: spawnError(command, denied ? "EACCES" : "ENOENT") };
}

/**
 * Canonical (bundleRoot, binary) pair when the resolved path classifies into a
 * known Codex desktop bundle, else null. The pair is always consistent:
 * both halves are canonicalized together so a symlinked HOME or a PATH alias
 * cannot split the containment check, and a bundle member that cannot be
 * canonicalized refuses rather than escaping the known-bundle classification.
 */
function darwinBundleTarget(resolved: string, deps: CodexExecBoundaryDeps): { bundle: string; binary: string } | null {
  const realpath = deps.realpath ?? realpathOrNull;
  const bundle = macCodexAppBundleFor(resolved, { env: deps.env, platform: deps.platform, realpath });
  if (!bundle) return null;
  const binary = realpath(resolved);
  if (binary === null) throw new CodexExecTrustError("cannot canonicalize the app-bundle exec target");
  const canonicalBundle = realpath(bundle);
  if (canonicalBundle === null) throw new CodexExecTrustError("cannot canonicalize the app bundle");
  if (!binary.startsWith(canonicalBundle + "/Contents/")) {
    throw new CodexExecTrustError("the app-bundle exec target is outside bundle Contents");
  }
  return { bundle: canonicalBundle, binary };
}

/** Classification of this exact validated invocation, not a reusable trust grant. */
interface ValidatedCodexExecTarget {
  readonly invocation: SpawnInvocation;
  readonly macAppBundle: boolean;
}

export function validatedCodexExecTarget(
  command: string,
  args: readonly string[],
  deps: CodexExecBoundaryDeps = {},
): ValidatedCodexExecTarget {
  if ((deps.platform ?? process.platform) !== "darwin") {
    return { invocation: codexExecInvocation(command, args, deps.platform ?? process.platform, { env: deps.env, exists: deps.exists }), macAppBundle: false };
  }
  const resolved = resolveDarwinExecPath(command, deps);
  if ("error" in resolved) throw resolved.error;
  const target = darwinBundleTarget(resolved.path, deps);
  if (target) {
    const reason = (deps.macBundleTrustReason ?? untrustedChatgptBundleReason)(target.bundle, target.binary);
    if (reason) throw new CodexExecTrustError(reason);
    return { invocation: { file: target.binary, args: [...args], options: {} }, macAppBundle: true };
  }
  return { invocation: { file: resolved.path, args: [...args], options: {} }, macAppBundle: false };
}

export async function validatedCodexExecTargetAsync(
  command: string,
  args: readonly string[],
  deps: CodexExecBoundaryAsyncDeps = {},
): Promise<ValidatedCodexExecTarget> {
  deps.signal?.throwIfAborted();
  if ((deps.platform ?? process.platform) !== "darwin") {
    return { invocation: codexExecInvocation(command, args, deps.platform ?? process.platform, { env: deps.env, exists: deps.exists }), macAppBundle: false };
  }
  const resolved = resolveDarwinExecPath(command, deps);
  if ("error" in resolved) throw resolved.error;
  const target = darwinBundleTarget(resolved.path, deps);
  if (target) {
    const reason = await (deps.macBundleTrustReasonAsync
      ? deps.macBundleTrustReasonAsync(target.bundle, target.binary, deps.signal)
      : untrustedChatgptBundleReasonAsync(target.bundle, target.binary, undefined, deps.signal));
    if (reason) throw new CodexExecTrustError(reason);
    deps.signal?.throwIfAborted();
    return { invocation: { file: target.binary, args: [...args], options: {} }, macAppBundle: true };
  }
  deps.signal?.throwIfAborted();
  return { invocation: { file: resolved.path, args: [...args], options: {} }, macAppBundle: false };
}

export function validatedCodexExecInvocation(
  command: string, args: readonly string[], deps: CodexExecBoundaryDeps = {},
): SpawnInvocation {
  return validatedCodexExecTarget(command, args, deps).invocation;
}

export async function validatedCodexExecInvocationAsync(
  command: string, args: readonly string[], deps: CodexExecBoundaryAsyncDeps = {},
): Promise<SpawnInvocation> {
  const target = await validatedCodexExecTargetAsync(command, args, deps);
  deps.signal?.throwIfAborted();
  return target.invocation;
}

/** Assert a single already-located executable; returns the canonical target to exec. */
export function assertCodexExecTargetTrusted(command: string, deps: CodexExecBoundaryDeps = {}): string {
  return validatedCodexExecInvocation(command, [], deps).file;
}

export async function assertCodexExecTargetTrustedAsync(
  command: string,
  deps: CodexExecBoundaryAsyncDeps = {},
): Promise<string> {
  return (await validatedCodexExecInvocationAsync(command, [], deps)).file;
}
