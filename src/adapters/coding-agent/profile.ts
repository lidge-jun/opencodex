import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";

/**
 * One region-isolated official coding-agent CLI target (§三十一).
 *
 * A profile is the ONLY place a family encodes its per-region differences (binary, credential env
 * var, canonical destination, install hint). Adapters stay profile-driven so there is no scattered
 * `if (provider === "codebuddy-cn")` branching, and so a family's Global and CN variants share one
 * adapter and one parser (§十三).
 */
export interface CodingAgentProviderProfile {
  /** Canonical OpenCodex provider id this profile serves. */
  providerId: string;
  /** Vendor family; selects the arg/env builder in the family adapter. */
  family: "claude" | "codebuddy" | "qoder";
  /**
   * Region; drives the vendor's own region switch and keeps credentials deterministic.
   * A family with a single destination carries `global`.
   */
  region: "global" | "cn";
  /** Human label for diagnostics/error copy (never sent upstream). */
  label: string;
  /**
   * Canonical upstream destination and region identity. The CLI performs the real transport, but
   * this host selects the profile and fails closed when overridden, so a region-scoped credential is
   * never handed to an unexpected environment (§十六).
   */
  canonicalBaseUrl: string;
  /** Executable names to resolve on PATH, in preference order. */
  binaryCandidates: readonly string[];
  /**
   * Official credential environment variable consumed by the CLI.
   *
   * Omitted when the CLI owns its own sign-in (Claude Code reads the operator's `claude` session),
   * where the adapter neither requires nor injects a key and has no secret to redact.
   */
  tokenEnv?: string;
  /** Install command surfaced when the CLI is missing (§二十六). */
  installHint: string;
  /** Official documentation for the automation surface. */
  documentationUrl: string;
}

/** Test seam: report the resolved path of a candidate executable, or undefined. */
export type WhichFn = (candidate: string) => string | undefined;

/** Test seams for {@link whichFromPath}; production reads the live process environment. */
export interface PathLookupDeps {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
}

/**
 * Windows extension order inside ONE PATH directory. A native image comes before a batch
 * dispatcher with the same stem, matching the system's own PATHEXT order (.EXE before .BAT/.CMD).
 * A `.cmd` re-parses argv through cmd.exe and whatever it forwards to, and a vendor dispatcher
 * that hops through PowerShell drops empty-string arguments (#7518).
 */
const WINDOWS_PATH_EXTENSIONS = [".exe", ".cmd", ".bat", ""] as const;

/** A `.cmd`/`.bat` target: launched through cmd.exe rather than as a native image. */
export function isBatchDispatcher(path: string): boolean {
  return /\.(?:cmd|bat)$/i.test(path);
}

const binaryCache = new Map<string, string>();

/** Reset the discovery cache (tests, or an explicit provider re-check). */
export function clearCodingAgentBinaryCache(): void {
  binaryCache.clear();
}

/**
 * Default PATH scan: return the first existing executable path for a candidate name.
 *
 * PATH order owns the choice between directories: an earlier directory wins even when a later one
 * holds a native build of the same name. Only inside the winning directory does a same-stem `.exe`
 * beat the `.cmd` beside it.
 */
export function whichFromPath(candidate: string, deps: PathLookupDeps = {}): string | undefined {
  const platform = deps.platform ?? process.platform;
  const exists = deps.exists ?? existsSync;
  const pathApi = platform === "win32" ? win32 : posix;
  const pathVar = (deps.env ?? process.env).PATH ?? "";
  if (!pathVar) return undefined;
  const extensions = platform === "win32" ? WINDOWS_PATH_EXTENSIONS : [""];
  for (const dir of pathVar.split(pathApi.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const full = pathApi.join(dir, `${candidate}${ext}`);
      try {
        if (exists(full)) return full;
      } catch {
        // An unreadable PATH entry must not abort discovery; skip it.
      }
    }
  }
  return undefined;
}

/**
 * Discover the CLI executable BEFORE a request is sent (§二十六), so a missing CLI is a clear
 * pre-flight error rather than a mid-turn ENOENT.
 *
 * Candidates are the profile's own names for one CLI, in preference order. The first native hit
 * wins, so a vendor layout that puts a `qodercn.cmd` dispatcher and the real `qoderclicn.exe` on
 * PATH launches the executable (#7518). When every hit is a batch dispatcher, the first one is
 * returned and the turn decides whether it can carry the arguments.
 *
 * Only native hits are cached (§三十). A miss or a dispatcher-only result is resolved again on the
 * next turn, so a CLI or native build installed after startup is picked up without a restart.
 */
export function resolveCodingAgentBinary(
  profile: CodingAgentProviderProfile,
  which: WhichFn = whichFromPath,
): string | undefined {
  const cached = binaryCache.get(profile.providerId);
  if (cached) return cached;
  let dispatcher: string | undefined;
  for (const candidate of profile.binaryCandidates) {
    const resolved = which(candidate);
    if (!resolved) continue;
    if (!isBatchDispatcher(resolved)) {
      binaryCache.set(profile.providerId, resolved);
      return resolved;
    }
    dispatcher ??= resolved;
  }
  return dispatcher;
}

/**
 * Resolve the profile whose canonical base URL matches the provider's configured destination.
 * Returns undefined for any other host, so the adapter fails closed rather than sending a
 * region-scoped credential to an unknown environment (§十六).
 */
export function resolveProfileByBaseUrl(
  profiles: readonly CodingAgentProviderProfile[],
  baseUrl: string | undefined,
): CodingAgentProviderProfile | undefined {
  if (!baseUrl) return undefined;
  const normalized = baseUrl.replace(/\/+$/, "").toLowerCase();
  return profiles.find(profile => normalized === profile.canonicalBaseUrl.toLowerCase());
}
