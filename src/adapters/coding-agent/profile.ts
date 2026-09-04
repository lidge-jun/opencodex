import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

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
  family: "codebuddy" | "qoder";
  /** Region; drives the vendor's own region switch and keeps credentials deterministic. */
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
  /** Official credential environment variable consumed by the CLI. */
  tokenEnv: string;
  /** Install command surfaced when the CLI is missing (§二十六). */
  installHint: string;
  /** Official documentation for the automation surface. */
  documentationUrl: string;
}

/** Test seam: report the resolved path of a candidate executable, or undefined. */
export type WhichFn = (candidate: string) => string | undefined;

const binaryCache = new Map<string, string>();

/** Reset the discovery cache (tests, or an explicit provider re-check). */
export function clearCodingAgentBinaryCache(): void {
  binaryCache.clear();
}

/** Default PATH scan: return the first existing executable path for a candidate name. */
export function whichFromPath(candidate: string): string | undefined {
  const pathVar = process.env.PATH ?? "";
  if (!pathVar) return undefined;
  const extensions = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const full = join(dir, `${candidate}${ext}`);
      try {
        if (existsSync(full)) return full;
      } catch {
        // An unreadable PATH entry must not abort discovery; skip it.
      }
    }
  }
  return undefined;
}

/**
 * Discover the CLI executable BEFORE a request is sent (§二十六), so a missing CLI is a clear
 * pre-flight error rather than a mid-turn ENOENT. Only positive hits are cached (§三十): a CLI
 * installed after startup is found on the next turn instead of being masked by a cached negative.
 */
export function resolveCodingAgentBinary(
  profile: CodingAgentProviderProfile,
  which: WhichFn = whichFromPath,
): string | undefined {
  for (const candidate of profile.binaryCandidates) {
    const cacheKey = `${profile.providerId}:${candidate}`;
    const cached = binaryCache.get(cacheKey);
    if (cached) return cached;
    const resolved = which(candidate);
    if (resolved) {
      binaryCache.set(cacheKey, resolved);
      return resolved;
    }
  }
  return undefined;
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
