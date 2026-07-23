/**
 * Bun runtime stream-capability gate for the Windows SSE passthrough path (#314).
 *
 * The eager bounded relay (src/server/relay-eager.ts) uses a JS async producer
 * loop — the exact shape of the Bun#32111 use-after-free (fixed upstream by Bun
 * PR #32120, merged 2026-06-21). No RELEASED Bun version is proven to carry
 * that fix yet, so `MIN_FIXED_BUN_VERSION` is null: every runtime is
 * "known-bad" until a bundle-bump commit sets it. Config `streamMode` can force
 * either path (persisted in config.json because Windows services do not
 * inherit shell env — see devlog/_plan/260723_win_mem_safestream/001).
 *
 * Prerelease conservatism: a version carrying a prerelease suffix (e.g.
 * `1.4.0-canary.3`) is NEVER treated as fixed even when its numeric triple
 * reaches the threshold — canaries are exactly the OPENCODEX_BUN_PATH audience
 * and may predate the fix commit.
 */

/**
 * Bump in the SAME commit that bumps package.json's bundled Bun to a version
 * verified to include Bun PR #32120. null = no released version is known-fixed.
 */
export const MIN_FIXED_BUN_VERSION: string | null = null;

export type StreamMode = "auto" | "legacy-tee" | "eager-relay";

export const STREAM_MODES: readonly StreamMode[] = ["auto", "legacy-tee", "eager-relay"];

export function isStreamMode(value: unknown): value is StreamMode {
  return typeof value === "string" && (STREAM_MODES as readonly string[]).includes(value);
}

/** Numeric [major, minor, patch] triple, or null for unparseable input. */
export function parseBunVersion(version: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Compare two version strings numerically; null when either is unparseable. */
export function compareBunVersions(a: string, b: string): number | null {
  const pa = parseBunVersion(a);
  const pb = parseBunVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return pa[i]! - pb[i]!;
  }
  return 0;
}

function hasPrereleaseSuffix(version: string): boolean {
  return /^\d+\.\d+\.\d+-/.test(version.trim());
}

/**
 * True only when `version` is proven to carry the Bun#32120 async-pull cancel
 * fix. Conservative: unknown, unparseable, prerelease, or no threshold → false.
 */
export function bunHasAsyncPullCancelFix(
  version: string,
  minFixed: string | null = MIN_FIXED_BUN_VERSION,
): boolean {
  if (!minFixed) return false;
  if (hasPrereleaseSuffix(version)) return false;
  const cmp = compareBunVersions(version, minFixed);
  return cmp !== null && cmp >= 0;
}

export type EagerRelayDecision = {
  useEagerRelay: boolean;
  reason: "config-legacy" | "config-eager" | "auto-fixed-runtime" | "auto-known-bad";
};

/**
 * Decide the win32 SSE client-path shape. `version`/`minFixed` are injectable
 * for tests. Non-win32 callers never consult this (their default path is
 * unchanged); the caller owns the platform check.
 */
export function decideEagerRelay(
  mode: StreamMode,
  version: string = Bun.version,
  minFixed: string | null = MIN_FIXED_BUN_VERSION,
): EagerRelayDecision {
  if (mode === "legacy-tee") return { useEagerRelay: false, reason: "config-legacy" };
  if (mode === "eager-relay") return { useEagerRelay: true, reason: "config-eager" };
  return bunHasAsyncPullCancelFix(version, minFixed)
    ? { useEagerRelay: true, reason: "auto-fixed-runtime" }
    : { useEagerRelay: false, reason: "auto-known-bad" };
}
