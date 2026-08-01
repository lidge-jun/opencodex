# 020 — WP2: auto resolution — CLI env, effective-mode endpoint, sticky manual

Depends on WP1 (detector) and WP1b (migration — the resolver must not read a config
the migration has not yet normalized). Contract from `000`/`001`; audit fold-backs
from `002` — the feedback loop, the admission-key axis, and three-state intent.

## What the resolver answers (exactly one question)

**Does the proxy-mode dummy marker (`ANTHROPIC_AUTH_TOKEN=opencodex-proxy`) get
injected?** That is the whole of it — and because that is narrower than "how will
Claude authenticate", the field is named **`markerMode`**, not `effectiveAuthMode`
(002 R2-1). Native passthrough additionally requires an `sk-ant-` credential on the
incoming request (`claude-messages.ts:85-96`), which no launch-time flag can promise.

The admission-key axis is SEPARATE and unchanged: when `config.apiKeys` is non-empty,
`buildClaudeEnv` injects `config.apiKeys[0].key` as `ANTHROPIC_AUTH_TOKEN` regardless
of mode (pre-existing behaviour, `cli/claude.ts:55-57`, documented at `:50-54`). The
GET payload exposes both axes (`admissionKeyActive`) so the GUI never presents
"subscription" as "no token anywhere".

## NEW — `src/claude/auth-mode.ts`

One resolver shared by the CLI and the management API, so launch-time and the GUI can
never disagree:

```ts
import type { OcxConfig } from "../types";
import { detectClaudeAuth, type AuthDetectResult, type AuthSourceId } from "./auth-detect";

export type MarkerMode = "proxy" | "subscription";

export interface ResolvedAuthMode {
  /** Does the owned dummy marker get injected. NOT a claim about native auth. */
  markerMode: MarkerMode;
  /** Why: manual override, or which auto path resolved. */
  origin: "manual" | "auto-present" | "auto-absent" | "auto-unknown";
  /** The detector source that proved presence (origin auto-present only). */
  foundBy?: AuthSourceId;
  detection: AuthDetectResult;
}

/**
 * The ONLY writer of the effective mode. Manual authMode is read, never written here:
 * an explicit "proxy"/"subscription" bypasses the detector forever (c-sticky), and the
 * auto logic cannot "helpfully" rewrite it when auth appears or disappears.
 *
 * auto-unknown resolves to subscription: the historical default, because flipping a
 * subscriber into proxy mode on a failed read is the F1 failure.
 */
export function resolveClaudeAuthMode(config: OcxConfig, detection: AuthDetectResult): ResolvedAuthMode {
  if (config.claudeCode?.authMode === "proxy") {
    return { markerMode: "proxy", origin: "manual", detection };
  }
  if (config.claudeCode?.authMode === "subscription") {
    // Literal "subscription" (002 §3): an explicit choice must survive auth flips too.
    return { markerMode: "subscription", origin: "manual", detection };
  }
  switch (detection.presence) {
    case "present": return { markerMode: "subscription", origin: "auto-present", foundBy: detection.foundBy, detection };
    case "absent": return { markerMode: "proxy", origin: "auto-absent", detection };
    case "unknown": return { markerMode: "subscription", origin: "auto-unknown", detection };
  }
}
```

### Config shape — three-state intent, literal strings

The audit's simpler alternative wins over the boolean: `authMode?: "proxy" |
"subscription"` — unset = auto. Literal `"subscription"` is self-describing and
backward-safe: old readers map any non-"proxy" value to "subscription" anyway
(`agent-settings-routes.ts:615-617`), so an old proxy reading a new config keeps the
user's explicit choice instead of silently dropping it. Widen the type in
`src/types.ts` and add the enum to `configSchema` in `src/config.ts`.

## MODIFY — `src/cli/claude.ts` (`buildClaudeEnv`)

**Ordering is the whole fix** (002 R2-1). `setDefault` preserves any non-empty
existing value, so a stale marker left in the base env would otherwise SUPPRESS the
admission key at `:55-57` and then be deleted by a naive cleanup — leaving the child
with no token at all. The owned dummy is therefore stripped FIRST, before anything
reads or writes `ANTHROPIC_AUTH_TOKEN`:

```ts
// 1. Strip our own dummy from the inherited env. It is opencodex state, never user
//    auth, and it must not shadow a real admission key (002 R2-1).
if (env.ANTHROPIC_AUTH_TOKEN === PROXY_MARKER) delete env.ANTHROPIC_AUTH_TOKEN;

// 2. Admission key (pre-existing behaviour, untouched by this unit).
if ((config.apiKeys?.length ?? 0) > 0) setDefault("ANTHROPIC_AUTH_TOKEN", config.apiKeys![0].key);

// 3. Detection reads the SAME base env the launch will use, so the two can never
//    disagree; then the dummy goes back only if nothing else claimed the slot.
// Injected deps spread FIRST; the env binding is applied LAST so a test fake can
// never silently break the "detection sees the launch env" invariant (002 R3-3).
// The injection type is Omit<Partial<AuthDetectDeps>, "env"> so this is also a
// compile-time guarantee, not just an ordering convention.
const detection = detectClaudeAuth({
  ...defaultAuthDetectDeps(),
  ...(deps?.authDetect ?? {}),
  env: () => base,
});
const resolved = resolveClaudeAuthMode(config, detection);
if (!env.ANTHROPIC_AUTH_TOKEN && resolved.markerMode === "proxy") {
  env.ANTHROPIC_AUTH_TOKEN = PROXY_MARKER;
}
if (resolved.origin === "auto-unknown") {
  console.error("⚠ Claude auth could not be verified; keeping subscription behaviour. Set the auth mode explicitly in the GUI to override.");
}
```

Step 1 uses `base`'s value, and step 3's detection also reads `base` — so S5 sees the
user's real exports while the dummy is excluded by the detector's own rule. The two
mechanisms agree by construction instead of by comment.

`buildClaudeEnv` gains an optional trailing `deps` parameter (defaults to real IO) so
tests inject the detector without touching the real home — same pattern as
`contextWindows`.

The F4 invariant is untouched: `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` still ships
only when an AUTH_TOKEN exists. Under auto→subscription with no admission key that
is now genuinely never — previously a stale marker could have satisfied it. With an
admission key configured the flag DOES ship, which is correct: opencodex really does
own authentication on that deployment (002 §2).

## MODIFY — GET `/api/claude-code` (`agent-settings-routes.ts:605-640`)

`authMode` stops coercing absent → `"subscription"`: absent now means auto, and the
coercion is exactly what silently killed auto on every save (002 §3).

```ts
const detection = detectClaudeAuth(defaultAuthDetectDeps());
const resolved = resolveClaudeAuthMode(config, detection);
// ...
authMode: config.claudeCode?.authMode ?? "auto",
markerMode: resolved.markerMode,
authModeOrigin: resolved.origin,
...(resolved.foundBy ? { authFoundBy: resolved.foundBy } : {}),
authDetectionUnknown: detection.presence === "unknown",
// The SEPARATE admission axis (002 §2): with an admission key configured a token is
// injected regardless of mode, so the GUI must never present subscription as
// "no token anywhere".
admissionKeyActive: (config.apiKeys?.length ?? 0) > 0,
// Daemon-side detection cannot see a key exported only in the user's terminal
// (002 R2-4). The GUI labels its badge accordingly.
detectionScope: "daemon",
```

PUT accepts all three intents: `"proxy"` stores `"proxy"`, `"subscription"` stores
the literal `"subscription"`, and `"auto"` DELETES the key — the return-to-auto path
the current two-option select cannot express. Validation widens to
`"auto" | "proxy" | "subscription"`; anything else still 400s.

> The system-env / launchctl work moved to its own work-phase (WP3b, doc `035`) after
> round 2 judged WP2 too broad. Its semantics (snapshot + documented refresh points)
> are settled in `002` R2-4.

## TESTS

`tests/claude-auth-mode.test.ts` (NEW):

- auto + present → subscription; auto + absent → proxy; auto + unknown → subscription
  with origin auto-unknown;
- **c-sticky**: manual proxy survives presence flips (present→absent→present) — same
  result every time; manual explicit subscription likewise;
- **the feedback loop (002 §1)**: base env carrying
  `ANTHROPIC_AUTH_TOKEN=opencodex-proxy` with auth now PRESENT → the marker is
  deleted, the mode resolves subscription, and no host flag ships;
- **admission axis (002 §2)**: detected credential + `config.apiKeys` → markerMode
  subscription AND the admission token still injected AND the host flag present;
- **R2-1 ordering**: stale marker + `config.apiKeys` + detected auth → the admission
  key IS injected (the dummy must not have suppressed it) and the dummy is gone;
- **c-253**: `buildClaudeEnv` under auto→subscription emits NO
  `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`; under auto→absent it emits the proxy token
  AND the flag;
- **F5**: env carrying `ANTHROPIC_API_KEY` resolves present, and
  `ANTHROPIC_AUTH_TOKEN` stays unset;
- GET returns `authMode: "auto"` for an unset key (NO coercion) plus
  `markerMode` / `authModeOrigin` / `admissionKeyActive`;
- PUT `"subscription"` stores the literal, `"auto"` deletes the key, `"proxy"`
  unchanged, invalid values still 400 — the 260720 round-trip contract survives as a
  superset;
- **the auto-kill regression (002 §3)**: GET(auto) → PUT that changes only an
  unrelated field → the stored intent is still auto;
  (system-env / launchctl coverage moves to WP3b.)

## Verification (C)

| Command | Expected |
|---------|----------|
| `bun test tests/claude-auth-mode.test.ts tests/claude-auth-detect.test.ts tests/claude-cli.test.ts` | pass |
| `bun x tsc --noEmit` | clean |
