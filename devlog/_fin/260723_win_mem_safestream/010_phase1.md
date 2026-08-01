# 010 — WP1: Runtime stream-capability gate + persisted stream-mode setting

Depends: none. Consumes: 001 §4-§5.

## MODIFY / NEW map

### NEW src/lib/bun-stream-caps.ts

Runtime capability gate for the eager relay. Pure, version-injectable.

```ts
/**
 * Bun runtime stream-capability gate for the Windows SSE passthrough path.
 *
 * The eager bounded relay (relay-eager.ts) uses a JS async producer loop — the
 * exact shape of the Bun#32111 use-after-free (fixed by PR #32120, merged
 * 2026-06-21). No RELEASED Bun version is proven to carry that fix yet, so the
 * min-fixed constant is null: every runtime is "known-bad" until a bundle-bump
 * commit sets it. Config `streamMode` can force either path.
 */

/** Bump in the SAME commit that bumps package.json's bundled Bun to a version
 *  verified to include Bun PR #32120. null = no released version is known-fixed. */
export const MIN_FIXED_BUN_VERSION: string | null = null;

export type StreamMode = "auto" | "legacy-tee" | "eager-relay";

export function parseBunVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareBunVersions(a: string, b: string): number | null {
  const pa = parseBunVersion(a); const pb = parseBunVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) { if (pa[i]! !== pb[i]!) return pa[i]! - pb[i]!; }
  return 0;
}

/** True when `version` is proven to carry the #32120 fix. Conservative: unknown → false. */
export function bunHasAsyncPullCancelFix(version: string, minFixed: string | null = MIN_FIXED_BUN_VERSION): boolean {
  if (!minFixed) return false;
  const cmp = compareBunVersions(version, minFixed);
  return cmp !== null && cmp >= 0;
}

export type EagerRelayDecision = {
  useEagerRelay: boolean;
  reason: "config-legacy" | "config-eager" | "auto-fixed-runtime" | "auto-known-bad";
};

/**
 * Decide the win32 SSE client-path shape. platform/version injectable for tests.
 * Non-win32 callers never consult this (their default path is unchanged).
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
```

### MODIFY src/types.ts (OcxConfig, after `fastMode?: boolean;` ~:447)

```ts
  /**
   * Windows SSE passthrough stream shape (#314 mitigation).
   * "auto" (default): eager bounded relay only on runtimes proven to carry the
   * Bun#32111 fix (none today → legacy tee). "eager-relay": force the new relay
   * (accepts #32111 crash risk on 1.3.14). "legacy-tee": pin the tee path.
   * Persisted in config.json because Windows services do not inherit shell env.
   */
  streamMode?: "auto" | "legacy-tee" | "eager-relay";
```

Zod/validation (WP1-P re-verify, tree e3a059c6): `configSchema` lives at
src/config.ts:437 (`z.object({...}).passthrough()`); add
`streamMode: z.enum(["auto", "legacy-tee", "eager-relay"]).optional(),` next to
`multiAgentGuidanceEnabled` (:444). passthrough() would tolerate the key
untyped, but the explicit enum rejects invalid persisted values instead of
silently carrying them.

### MODIFY src/server/management/config-routes.ts (WP1-P re-verify)

Surface: `/api/settings` GET (:76) + PUT (:129) — server-global fit (fastMode
precedent is Claude-scoped on /api/claude-code). Audit round 1 dispositions:

- GET adds `streamMode: config.streamMode ?? "auto"`.
- PUT contract (blocker 1 FOLDED): relax to "each field optional, at least one
  required, validated when present" — `codexAutoStart` boolean when present,
  `streamMode` in the 3-value enum when present; empty body → 400. Legacy
  codexAutoStart-only PUT keeps working (GUI always sends it). streamMode-only
  PUT works (WP4/WP5 user docs depend on it). 400 message:
  `streamMode must be auto, legacy-tee, or eager-relay`.
- Write: `delete config.streamMode` for "auto" (file precedent
  config-routes.ts:238-250), else assign; saveConfig; echo effective
  `streamMode` in the PUT response (GET/PUT symmetry).
- Docstring: stream-shape change applies to NEW turns only, no restart
  (config object is shared by reference — verified index.ts:153/:247/:421).

Load-side resilience (blocker 2 FOLDED): use
`streamMode: z.enum(["auto","legacy-tee","eager-relay"]).optional().catch(undefined)`
in configSchema, so a hand-edited typo (e.g. "legacy_tee") degrades to
auto-with-console-warning instead of failing the whole parse and nuking the
user config via the repair path (config.ts:662-670 backs up + defaults on
double parse failure). Add a `warnInvalidStreamMode` console.warn when the raw
key exists but is invalid (checked in loadConfig after parse, comparing
parsed.streamMode presence vs result).

Prerelease edge (low, FOLDED): parseBunVersion strips prerelease tags, so
`1.4.0-canary.x` would compare >= minFixed `1.4.0`. Conservative posture:
`bunHasAsyncPullCancelFix` returns false when the version string contains a
prerelease suffix (`-`) — canaries are exactly the OPENCODEX_BUN_PATH audience
and may predate the fix commit. Documented in the module docstring.

## Activation scenarios (C-ACTIVATION-GROUNDING-01)

- decide("auto", "1.3.14", null) → {false, "auto-known-bad"} (today's default).
- decide("auto", "1.4.0", "1.4.0") → {true, "auto-fixed-runtime"} (future bump).
- decide("eager-relay", "1.3.14", null) → {true, "config-eager"} (brave opt-in).
- decide("legacy-tee", "9.9.9", "1.4.0") → {false, "config-legacy"} (pin).
- parse garbage version → null → conservative false.

## TESTS — NEW tests/bun-stream-caps.test.ts

Cases (blocker 3 FOLDED — new file tests/bun-stream-caps.test.ts + settings
route cases in a new tests/settings-stream-mode.test.ts):
- five activation scenarios + compareBunVersions ordering +
  parseBunVersion("1.3.14-canary.1") → [1,3,14];
- prerelease conservatism: bunHasAsyncPullCancelFix("1.4.0-canary.1","1.4.0") → false;
- schema resilience: configSchema parse with streamMode "bogus" → success with
  streamMode undefined (catch), valid values round-trip;
- persistence round-trip: PUT "eager-relay" → persisted + survives loadConfig;
  PUT "auto" → key absent from written config.json;
- GET /api/settings returns streamMode "auto" default;
- PUT accepts all three values, rejects "bogus" with 400;
- legacy regression: codexAutoStart-only PUT still 200; empty-body PUT → 400.

## Verification (C)

- bun x tsc --noEmit → exit 0
- bun test tests/bun-stream-caps.test.ts → pass
- bun run test full suite → pass (config surface touched)
- bun run privacy:scan → pass
