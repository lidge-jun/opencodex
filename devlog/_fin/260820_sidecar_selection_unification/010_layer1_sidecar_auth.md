# 010 — Layer 1: shared sidecar auth module (wp2)

Branch: codex/sidecar-auth-slots (base: dev). PR bottom of stack, targets dev.

## New file: src/sidecar/auth.ts
```ts
export interface SidecarAuthState {
  isCodexAuth: boolean;      // ChatGPT LOGIN usable (not mere provider presence)
  isAnthropicAuth: boolean;  // enabled anthropic-adapter OAuth provider w/ active !needsReauth account
  anthropicProviderName?: string;
  anthropicProvider?: OcxProviderConfig;
}
export function resolveSidecarAuth(config: OcxConfig): SidecarAuthState
// isCodexAuth = listOpenAiForwardSidecarCandidates(config).length > 0
//   && ( isCodexAccountUsable(config, MAIN_CODEX_ACCOUNT_ID)          // live ~/.codex/auth.json token
//        || (config.codexAccounts ?? []).some(a =>
//              isSelectableCodexPoolAccount(a) && isCodexAccountUsable(config, a.id)) )
// (src/codex/account-usability.ts:17 — request-context-free, symmetric with Anthropic)
// isAnthropicAuth + provider = the shared predicate now duplicated in
//   findAnthropicSidecarProvider (web-search/index.ts:87) and findAnthropicVisionProvider (vision/index.ts:219)

export const AUTH_SLOT_MODELS = { codex: "gpt-5.6-luna", anthropic: "claude-haiku-4-5" } as const;
export function sidecarAuthSlots(auth: SidecarAuthState): Array<{ provider: string; id: string; slot: "codex" | "anthropic" }>
// codex slot when isCodexAuth; anthropic slot (provider = anthropicProviderName) when isAnthropicAuth
```

## Refactors (behavior-preserving)
- src/web-search/index.ts: findAnthropicSidecarProvider delegates to resolveSidecarAuth (keep export).
- src/vision/index.ts: findAnthropicVisionProvider delegates likewise.
- No caller behavior change in this layer.

## Tests: tests/sidecar-auth.test.ts
- isCodexAuth FALSE when forward provider exists but no live main token and no usable pool account (the B1 pin).
- isCodexAuth TRUE with live main token; TRUE with usable selectable pool credential only.
- isAnthropicAuth false when: disabled, wrong adapter, key auth, needsReauth active account, no account set.
- Slots: hidden/disabled Luna & Haiku still emitted when auth present (core #2188 invariant).
- Delegation equivalence for both find* helpers.

## Verify: bun x tsc --noEmit && bun test tests/sidecar-auth.test.ts tests/web-search.test.ts tests/vision-eligibility.test.ts

