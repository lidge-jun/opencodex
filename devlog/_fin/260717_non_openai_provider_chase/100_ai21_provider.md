# WP10 — AI21 Jamba provider

## Goal and dependency

Add AI21's documented Jamba Chat Completions endpoint as a keyed OpenAI-chat-compatible preset.

## Diff map

| Action | Path | Before | After |
|---|---|---|---|
| MODIFY | `src/providers/registry.ts` | no `ai21` row | keyed preset at `https://api.ai21.com/studio/v1`, `jamba-large`/`jamba-mini` fallback, current context/input hints |
| MODIFY | `tests/provider-registry-parity.test.ts` | provider absent | assert provider derivation and static fallback cloning |
| NEW | `tests/ai21-provider.test.ts` | no AI21 stream/tool fixture | text stream, `[DONE]`, final usage, function calling, `n=1` stream constraint, auth/error redaction |
| MODIFY | `README.md`, `README.ko.md`, `README.zh-CN.md`, `docs/README.md` | no AI21 | add Jamba Chat Completions scope, not Maestro/RAG claims |

## Contract details

- The adapter base URL is `https://api.ai21.com/studio/v1`; existing OpenAI-chat appends `/chat/completions` exactly once.
- Current public aliases are rechecked in P. Dated aliases are preferred only when the project intentionally wants frozen behavior.
- Streaming forces `n=1` if Codex or configuration introduces another value; the branch requires an activation test.
- Maestro, Conversational RAG, embeddings, and self-hosted vLLM are out.

## Activation scenarios

- Stream chunks ending with `data: [DONE]` produce one OCX terminal event and final usage.
- A tool call is emitted and replayed with AI21's documented function schema.
- `stream:true,n>1` is normalized or rejected according to the audited policy without changing non-AI21 providers.
- 401/403/422 bodies surface safe classifications without raw body leakage.

## Verification

```bash
bun test tests/ai21-provider.test.ts tests/provider-registry-parity.test.ts tests/openai-chat-eof.test.ts
bun run typecheck
```

## Terminal outcomes

- `DONE`: registry, stream/tool/error fixtures, docs, and authenticated smoke pass.
- `NOOP`: official API no longer supports the required compatibility shape at implementation time.
- `NEEDS_HUMAN`: no AI21 key.
- `BLOCKED`: tool use cannot support a Codex round trip.
