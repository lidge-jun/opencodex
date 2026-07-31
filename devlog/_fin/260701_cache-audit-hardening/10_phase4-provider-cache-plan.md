# Phase 4 Provider Cache Hardening Plan

## Part 1: Easy Explanation

The next implementation pass makes native Anthropic caching behave like the current official Anthropic recommendation for multi-turn conversations. opencodex already caches stable system/tool prefixes; this pass adds the missing moving conversation-history breakpoint by sending top-level `cache_control` only to native Anthropic API requests. OpenAI/ChatGPT, Gemini/Antigravity, Kimi, and Anthropic-compatible gateways such as Umans stay conservative: preserve and display cache telemetry, but do not inject unproven provider-specific fields. Tests will prove request shape and raw pass-through behavior before any runtime claim is made.

## Part 2: Diff-Level Plan

### MODIFY: `src/adapters/anthropic.ts`

Before:

```ts
const EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" } as const;
```

After:

```ts
const EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" } as const;
```

No constant change.

Before, in `buildRequest`:

```ts
const body: Record<string, unknown> = {
  model: parsed.modelId,
  messages,
  stream: parsed.stream,
  max_tokens: parsed.options.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
};
```

After:

```ts
const body: Record<string, unknown> = {
  model: parsed.modelId,
  messages,
  stream: parsed.stream,
  max_tokens: parsed.options.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
};
if (usesNativeAnthropicEndpoint(provider)) body.cache_control = EPHEMERAL_CACHE_CONTROL;
```

Rationale:

- Official Anthropic docs recommend top-level automatic caching for multi-turn conversations.
- Existing explicit breakpoints remain and consume two slots at most; automatic caching uses one additional slot.
- Default 5-minute TTL avoids the extra 1-hour write premium.
- Anthropic-compatible gateways are not assumed to support this root field.

Add helper near `withPromptCache`:

```ts
function usesNativeAnthropicEndpoint(provider: OcxProviderConfig): boolean {
  try {
    return new URL(provider.baseUrl).hostname === "api.anthropic.com";
  } catch {
    return false;
  }
}
```

### MODIFY: `tests/adapter-usage.test.ts`

Add assertions to existing Anthropic request-shape tests:

- API-key Anthropic request body has `cache_control: { type: "ephemeral" }`.
- OAuth Anthropic request body has `cache_control: { type: "ephemeral" }` while the Claude Code identity system block remains unmarked.
- Tool cache-control test also confirms top-level automatic cache control exists.

Extend Umans-compatible coverage in `tests/umans-provider.test.ts`:

- `body.cache_control` is absent for Umans.
- Existing system/tool block-level cache markers remain valid.
- No Anthropic OAuth beta header is added for Umans.

### MODIFY: `tests/openai-responses-passthrough.test.ts`

Add a raw passthrough test:

```ts
test("preserves prompt_cache_retention in the raw Responses passthrough body", () => {
  // build passthrough request with _rawBody.prompt_cache_retention = "24h"
  // assert JSON.parse(request.body).prompt_cache_retention === "24h"
});
```

Rationale:

- OpenAI official docs expose `prompt_cache_retention`.
- opencodex should not parse/validate it yet, but must not drop it on raw Responses passthrough.

### MODIFY: `devlog/_plan/260701_cache-audit-hardening/01_cache-surface-audit.md`

Append a "Phase 4 outcome" section after implementation:

- Native Anthropic now sends both explicit block breakpoints and top-level automatic caching.
- Umans remains block-level-only until top-level support is proven.
- OpenAI Responses pass-through preserves `prompt_cache_retention`.
- Kimi/OpenAI-compatible chat remains usage-only.
- Google/Antigravity remains implicit usage-only.

### NEW: none

No new runtime modules or config are needed for this pass.

## Test Matrix

Run:

```bash
bun test tests/adapter-usage.test.ts tests/openai-responses-passthrough.test.ts tests/umans-provider.test.ts tests/google-antigravity-wire.test.ts tests/usage-log.test.ts tests/usage-summary.test.ts
bun x tsc --noEmit
```

## Multi-PABCD Slice Map

### Cycle 1: Research / plan / parity audit

Deliverables:

- `02_provider-cache-parity-audit.md`
- `10_phase4-provider-cache-plan.md`

Verification:

- Plan audit by independent employee.
- No runtime change.

### Cycle 2: Anthropic automatic cache + OpenAI retention preservation tests

Deliverables:

- `src/adapters/anthropic.ts`
- `tests/adapter-usage.test.ts`
- `tests/openai-responses-passthrough.test.ts`
- optional `tests/umans-provider.test.ts` assertions if needed
- updated `01_cache-surface-audit.md`

Verification:

- Targeted tests and `bun x tsc --noEmit`.
- Independent read-only verification.

### Cycle 3: Telemetry precision follow-up, only if Cycle 2 shows a gap

Potential deliverables:

- Split Anthropic cache read vs write token fields in internal usage/logs.
- Dashboard display update for read/write distinction.

This is intentionally not implemented in Cycle 2 because it changes public log shape and requires a separate contract decision.
