# 350.115 — Router: Permanent Native-Model-ID Reservation (work-phase 32)

Date: 2026-06-27
Branch: dev
Work phase: harden finding **#6 (Medium-high)** — the bare-`gpt-*` routing fix (commit `698bbba`) works
for today's config but relies on ordering + a hard-coded prefix list, so future native slugs
(`codex-*`, future `o5-*`, a live Codex catalog id) can still be captured by Cursor's static `models`.

> Status: **PLAN**. C2/C3-class (routing invariant; no destructive surface). Builds on the already-shipped
> ordering fix, makes the invariant explicit and future-proof.

---

## 1. Easy explanation

opencodex must never accidentally send a plain OpenAI/Codex model (like `gpt-5.5`) to Cursor. The
current fix checks a short list of prefixes (`gpt-`, `o1-`, `o3-`, `o4-`) before Cursor's model list.
That's correct now, but a new native model name that isn't in that list could still slip through to
Cursor. The fix makes a permanent rule: **bare native OpenAI/Codex slugs are reserved** — Cursor can
advertise `cursor/gpt-5.5`, but it can never *own* the bare `gpt-5.5`. If no native OpenAI provider is
configured, return a clear routing error instead of silently falling through to Cursor.

## 2. Pre-write evidence

### Current opencodex — prefix-list + ordering
```11:30:src/router.ts
const MODEL_PROVIDER_PATTERNS: Array<{ providerNames: string[]; prefixes: string[] }> = [
  { providerNames: ["anthropic"], prefixes: ["claude-", …] },
  { providerNames: ["openai", "chatgpt", "openai-apikey"], prefixes: ["gpt-", "o1-", "o3-", "o4-"] },
  { providerNames: ["groq"], prefixes: ["llama-", "mixtral-", "gemma-"] },
];
```
```86:107:src/router.ts
const patternRoute = routeByKnownModelPattern(config, modelId);
if (patternRoute) return patternRoute;
…
for (const [provName, prov] of Object.entries(config.providers)) {
  if (prov.models && … (prov.models as string[]).includes(modelId)) { return { … }; }
}
```
- Explicit `cursor/<model>` is handled first (`router.ts:68-84`) — correct, keep.
- `routeByKnownModelPattern` runs before provider `models` matching (`:86-87`) — this is the `698bbba`
  fix. But it only reserves the four hard-coded prefixes; an unmatched bare native id falls to provider
  `models` (`:99-107`) and can be captured by Cursor's static list, then ultimately `defaultProvider`
  (`:112-119`).
- Reasoning-effort routing tests confirm `gpt-5.5 → openai` and `cursor/gpt-5.5 → cursor` already pass
  (`tests/router.test.ts`).

### GPT Pro review recommendation (#6)
- Reserve native bare ids via the live Codex catalog + a broader native pattern, e.g.
  `/^(gpt-|o[0-9]+-|codex-)/`, and add a `codex-*` reservation. If no native provider is configured,
  **error** rather than fall through to Cursor/default.

## 3. Decision

Replace prefix-only reservation with a `isReservedNativeOpenAiBareId(id, config)` check that combines
(a) the live/static native OpenAI/Codex slug set and (b) a broadened regex
`/^(gpt-|o[0-9]+-|codex-)/`. Run it **before** any provider default/`models` matching. If it matches and
no native provider exists, throw a clear error (do not fall through to Cursor or default).

## 4. Diff-level plan

### MODIFY `src/router.ts`
```ts
// Broadened native pattern: gpt-*, o<N>-* (o1/o3/o4/future o5…), codex-*.
const NATIVE_OPENAI_BARE_RE = /^(gpt-|o[0-9]+-|codex-)/;

function nativeOpenAiSlugs(config: OcxConfig): Set<string> {
  // union of configured openai/chatgpt provider model lists + known Codex catalog ids
  …
}
function isReservedNativeOpenAiBareId(id: string, config: OcxConfig): boolean {
  return NATIVE_OPENAI_BARE_RE.test(id) || nativeOpenAiSlugs(config).has(id);
}
function findConfiguredNativeOpenAiProvider(config: OcxConfig): [string, OcxProviderConfig] | undefined {
  return Object.entries(config.providers).find(
    ([name]) => ["openai","chatgpt","openai-apikey"].some(p => name === p || name.startsWith(`${p}-`)));
}
```
In `routeModel`, after the explicit `<provider>/<model>` block and before provider default/`models`:
```ts
if (isReservedNativeOpenAiBareId(modelId, config)) {
  const native = findConfiguredNativeOpenAiProvider(config);
  if (native) {
    const [provName, prov] = native;
    return { providerName: provName, provider: routedProviderConfig(provName, prov), modelId };
  }
  // No native provider configured: do NOT fall through to Cursor/default for a reserved bare id.
  throw new Error(
    `native OpenAI/Codex provider is not configured for reserved model '${modelId}'; ` +
    `use 'cursor/${modelId}' to force Cursor.`);
}
```
- Keep `routeByKnownModelPattern` for the non-reserved provider families (anthropic/groq) and the
  existing `cursor/<model>` explicit path unchanged.

## 5. Verification plan (non-destructive)
- extend `tests/router.test.ts`:
  - `defaultProvider:"cursor"` + Cursor `models` lists `gpt-5.5` → bare `gpt-5.5` still routes to OpenAI.
  - bare `o1-preview`, `o3-mini`, `codex-foo`, synthetic `o5-x` route to native OpenAI/Codex (not Cursor).
  - explicit `cursor/gpt-5.5` still routes to Cursor (strip prefix).
  - reserved bare id + **no** native provider configured → **throws** the clear routing error (not
    routed to Cursor/default).
  - non-reserved bare id with no pattern match → still falls through to default (no behavior change).
- `bun test tests/router.test.ts` → green; `bun x tsc --noEmit` → exit 0.

## 6. Out of scope
- `/v1/models` catalog row composition (bare native + `cursor/*` namespaced rows) — verified in `118`
  test map; the existing 7-row exposure is a user setting and is not changed here.
- Live `GetUsableModels` wiring for the native slug set — static seed is acceptable; live wiring is a
  separate item (noted in `108`).

## 7. Cross-references
- GPT Pro review 260627 — finding **#6 (Medium-high)**.
- `96` (routing+stream RCA) · commit `698bbba` (ordering fix this hardens) · `118` (index).
