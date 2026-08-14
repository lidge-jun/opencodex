---
title: "M0-1: Responses input admission gate"
phase: "010"
depends: []
consumes: []
branch: codex/m0-1-input-admission
closes: "(split from #1412)"
---

# 010 — M0-1: Model-aware input admission gate

## Thesis

Reject oversized requests BEFORE upstream dispatch. A 1.3M-token request that exceeds
the model's context window should never reach the provider — it wastes bandwidth, holds
a turn slot, and the provider will reject it anyway with a less useful error.

## Current state

- `src/server/responses/core.ts:1843` has `acquireUpstreamHostAdmission` — per-host
  circuit breaker, not size-based
- `src/server/responses/core.ts:680` returns 413 for translator buffer overflow
  (post-translation, not pre-dispatch)
- `src/types.ts:1340` has `contextWindow` and `modelContextWindows` on OcxProviderConfig
- `src/types.ts:1347` has `modelMaxInputTokens` on OcxProviderConfig
- No code path compares request input size against model context window before dispatch

## File change map

### NEW: src/server/responses/input-admission.ts

Purpose: Pre-dispatch input size estimation and admission gate.

```ts
export interface InputAdmissionResult {
  admitted: boolean;
  estimatedTokens: number;
  contextWindow: number | null;
  reason?: string;
}

/**
 * Estimate token count from a parsed Responses request and compare
 * against the model's advertised context window.
 * 
 * Token estimation: count characters / 4 as a rough upper bound,
 * with base64 image data counted at its decoded byte size / 750.
 * This is intentionally conservative (overestimates) — better to
 * reject a request that's close than to let a too-large one through.
 */
export function estimateInputTokens(parsed: OcxParsedRequest): number;

/**
 * Resolve the effective context window for a provider+model pair.
 * Priority: modelContextWindows[model] > contextWindow > null.
 */
export function resolveContextWindow(
  provider: OcxProviderConfig,
  model: string,
): number | null;

/**
 * Check whether the estimated input fits within the model's context window.
 * Returns admitted:true if no context window is known (fail-open for unconfigured models).
 */
export function checkInputAdmission(
  parsed: OcxParsedRequest,
  provider: OcxProviderConfig,
  model: string,
): InputAdmissionResult;
```

### MODIFY: src/server/responses/core.ts

Location: Inside `handleResponsesInner`, after route resolution and before
`acquireUpstreamHostAdmission` (around line 1840).

```diff
+ // Pre-dispatch input admission: reject requests whose estimated token count
+ // exceeds the resolved model context window.
+ const admission = checkInputAdmission(parsed, providerConfig, resolvedModel);
+ if (!admission.admitted) {
+   return formatErrorResponse(413, "request_too_large",
+     `Estimated input (~${admission.estimatedTokens} tokens) exceeds the model context window (${admission.contextWindow} tokens). `
+     + `Reduce the conversation size or choose a model with a larger context window.`,
+     { estimated_tokens: admission.estimatedTokens, context_window: admission.contextWindow });
+ }
```

### NEW: tests/input-admission.test.ts

Test cases:
1. Request within context window → admitted
2. Request exceeding context window → 413 with token estimates
3. No context window configured → admitted (fail-open)
4. Base64 image data counted at reduced rate
5. Tool results included in estimate
6. `modelMaxInputTokens` caps below context window
7. Edge: exactly at boundary → admitted
8. Edge: 1 token over → rejected

## Activation scenario

A Codex turn with 500k tokens of conversation history targeting a model with a
128k context window hits `checkInputAdmission` → returns `admitted: false` →
413 response returned to client before any upstream fetch.

## Scope boundary

IN: New admission module + core.ts insertion point + test file
OUT: Changing existing translator buffer limits, modifying provider configs,
     adding UI for admission settings

