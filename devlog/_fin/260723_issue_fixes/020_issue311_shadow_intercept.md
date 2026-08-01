# 020 — WP2: #311 shadow intercept source-model set

## Design

Replace the single `gpt-5.4-mini` literal with a source-model prefix set. Verified
source: issue #311 reports Codex 0.145.0 shadow model is `gpt-5.6-luna`. We include
`gpt-5.4-mini` (older Codex clients still in the wild) and `gpt-5.6-luna`.
`gpt-5.6-terra` is NOT included — no capture evidence it is used as a helper model
(triage: binary adjacency alone is weak). Optional config override `sourceModels`
gives users a lever if upstream rotates again.

## MODIFY src/server/responses.ts (:949-963)

```ts
// before
  const _sci = config.shadowCallIntercept;
  if (_sci?.enabled && _sci.model && parsed.modelId.startsWith("gpt-5.4-mini")) {
// after
  const _sci = config.shadowCallIntercept;
  if (_sci?.enabled && _sci.model && isShadowSourceModel(parsed.modelId, _sci.sourceModels)) {
```

Add near the handler (module scope):

```ts
/** Codex client hard-coded helper/shadow models: 0.145.0 uses gpt-5.6-luna; older clients gpt-5.4-mini. */
const DEFAULT_SHADOW_SOURCE_MODELS = ["gpt-5.4-mini", "gpt-5.6-luna"] as const;

export function isShadowSourceModel(modelId: string, configured?: unknown): boolean {
  // Slash-prefixed ids (openai/gpt-5.6-luna) are deliberate routed requests, never
  // client shadow calls — hard-exclude them regardless of configured prefixes
  // (audit finding 6: without this guard the invariant was accidental).
  if (modelId.includes("/")) return false;
  // config.ts top-level parse is .passthrough(): shadowCallIntercept fields arrive
  // unvalidated from disk, so harden against non-string entries (audit finding 4).
  const configuredStrings = Array.isArray(configured)
    ? configured.filter((v): v is string => typeof v === "string" && v.trim() !== "")
    : [];
  const prefixes = configuredStrings.length > 0 ? configuredStrings : DEFAULT_SHADOW_SOURCE_MODELS;
  return prefixes.some(prefix => modelId.startsWith(prefix.trim()));
}
```

Also update the stale inline comment ("hard-coded gpt-5.4-mini helper calls" →
"hard-coded helper calls (gpt-5.4-mini, gpt-5.6-luna on 0.145.0+)").

## MODIFY src/types.ts (:484-494)

- Doc comment: describe helper-call redirect generically, naming both defaults.
- Field additions:

```ts
  shadowCallIntercept?: {
    /** When true, requests for known shadow/helper source models are rewritten to the configured model. */
    enabled?: boolean;
    /** Replacement model id (e.g. "gpt-5.5"). */
    model?: string;
    /** Optional override of intercepted source-model prefixes (default: gpt-5.4-mini, gpt-5.6-luna). */
    sourceModels?: string[];
  };
```

## Tests — NEW file tests/responses-shadow-intercept.test.ts (audit finding 5:
existing response test files own parser/adapter/combo concerns; request-level
coverage is required, unit-only matcher tests are insufficient)

Two layers:

1. **Matcher unit tests** (exported `isShadowSourceModel`):

| Case | Expect |
|------|--------|
| `gpt-5.4-mini` | true |
| `gpt-5.4-mini-2026-01` | true (prefix) |
| `gpt-5.6-luna` | true (the #311 regression) |
| `gpt-5.6-terra` | false |
| `gpt-5.5` | false |
| `openai/gpt-5.6-luna` | false (explicit slash guard) |
| `openai/gpt-5.6-luna` with configured `["openai/gpt-5.6-luna"]` | still false (guard precedes overrides) |
| configured `sourceModels: ["custom-helper"]` | only `custom-helper*` true |
| configured `[1, "", "x"]` (malformed persisted config) | no throw; behaves as `["x"]` |
| configured `[]` | defaults apply |

2. **Request-level regression** (the behavior #311 reports): drive the responses
   request path with `shadowCallIntercept: { enabled: true, model: "gpt-5.5" }` and a
   `gpt-5.6-luna` request body; capture the outgoing/routed body and assert (a) model
   rewritten to `gpt-5.5`, (b) `reasoning.effort` forced to `"low"`, (c) a
   `gpt-5.6-terra` request passes through unrewritten. Reuse the lightest existing
   server-test harness pattern (B phase inspects tests/e2e-style/ and
   tests/helpers/ for the established mock-upstream fixture before writing a new one).

Pre-fix: the `gpt-5.6-luna` case fails on af973e54.

## Config plumbing check

`src/providers/openai-tiers.ts:106,124-125,168` only touch `shadowCallIntercept.model`
(legacy id rewrite + selected-id matching) — unaffected by `sourceModels`. Verify no
config schema validator rejects the new optional field: config.ts:425 top-level parse
is `.passthrough()`, so the field survives load but arrives UNVALIDATED — hence the
`unknown`-typed hardening in the matcher above (audit finding 4).
