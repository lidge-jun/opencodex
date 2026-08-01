# WP9 — Cohere compatibility provider

## Goal and dependency

Add Cohere through its official OpenAI Compatibility API without importing Cohere-native SDK abstractions.

## Diff map

| Action | Path | Before | After |
|---|---|---|---|
| MODIFY | `src/providers/registry.ts` | no `cohere` row | keyed `openai-chat` preset at `https://api.cohere.ai/compatibility/v1`, dashboard URL, audited fallback models |
| MODIFY | `tests/provider-registry-parity.test.ts` | no Cohere derivation | assert registry→key login→management preset parity |
| NEW | `tests/cohere-provider.test.ts` | no compatibility fixture | stream text/tools, usage, tool-choice behavior, auth redaction, and parameter support |
| MODIFY | `README.md`, `README.ko.md`, `README.zh-CN.md`, `docs/README.md` | no Cohere | advertise only capabilities proven by compatibility fixtures |

## Contract details

- Initial candidate fallback is `command-a-plus-05-2026`; P must reopen the official model list and choose stable aliases before B.
- Cohere-native citations, rerank, connectors, and RAG parameters are out. This phase owns Chat Completions compatibility only.
- Do not claim Responses API support.
- Any unsupported OpenAI parameter is handled by an explicit model/provider list only after a captured 4xx fixture.

## Activation scenarios

- Standard text stream terminates cleanly and usage maps to OCX totals.
- A function call round trip preserves tool id/name/JSON arguments and tool result role.
- An unsupported parameter fixture proves the exact field removed; unrelated providers retain it.
- A model-list failure falls back to the audited seed without inventing capabilities.

## Verification

```bash
bun test tests/cohere-provider.test.ts tests/provider-registry-parity.test.ts tests/openai-chat-parallel-stream.test.ts
bun run typecheck
```

## Terminal outcomes

- `DONE`: official current model seed, compatibility fixtures, and authenticated smoke pass.
- `NOOP`: current custom-provider flow is chosen intentionally and a first-class preset has no product value; requires user approval.
- `NEEDS_HUMAN`: no Cohere API key.
- `BLOCKED`: compatibility API lacks the tool/stream behavior required by Codex.
