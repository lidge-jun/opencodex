# 142 — kiro token-usage accounting (heuristic sidecar)

## Problem (root cause, verified)
- Codex relies on `response.completed.usage.{input_tokens,output_tokens,total_tokens}` to track
  the context window and trigger **auto-compact** (`model_auto_compact_token_limit`).
- The kiro adapter emits `yield { type: "done" }` with **no usage** (`src/adapters/kiro.ts:297`).
- `src/bridge.ts:356` builds `response.completed` with `usage: responsesUsage(event.usage)`;
  `responsesUsage(undefined)` → `{input_tokens:0, output_tokens:0, total_tokens:0}` (bridge.ts:12-13).
- CodeWhisperer `GenerateAssistantResponse` provides **no reliable usage**. jawcode parses a `usage`
  number but its consumer does nothing (`case "usage": break;`, jawcode kiro.ts:746) → Usage stays 0.
- Net effect: with kiro, Codex shows 0 token usage and **never auto-compacts** → context overflow.

## 2026-06-29 correction — nested accumulation regression
- The v1 fix made Kiro usage non-zero, but it estimated `input_tokens` from the **entire serialized
  Kiro payload body**. That payload intentionally includes full `conversationState.history`.
- Codex stores `TokenUsageInfo.total_token_usage` by **adding every response's last usage**
  (`TokenUsageInfo::append_last_usage()` in codex-rs `protocol/src/protocol.rs`), while its active
  context check uses `last_token_usage.total_tokens` plus local post-model items
  (`core/src/context_manager/history.rs`).
- Therefore a stateless provider adapter must not report the full Kiro history body as each
  response's additive usage. Doing so re-adds old user/assistant/tool history every turn and produces
  the user-visible "nested usage keeps stacking" symptom.
- Kiro upstream payload construction remains unchanged: full history is still sent to CodeWhisperer.
  Only the usage number reported back to Codex is changed to a current-turn delta.

## Goal
Add a heuristic token-estimation **sidecar** so kiro emits non-zero, reasonable usage and Codex's
usage display + auto-compact work. Prefer any real CW usage number if the stream ever provides one.

## Research grounding (web)
- Rule of thumb: 1 token ≈ 4 chars (English prose), ≈ 0.75 words.
- Empirical model ratios (~±10%): GPT chars/3.6, Claude chars/3.5, Gemini chars/3.8.
- Code / JSON / non-English consume MORE tokens per char (lower chars-per-token).
- Codex traffic is code/JSON/tool-arg heavy → use a **conservative 3.5 chars/token** for kiro text
  models so we slightly over-count rather than under-count (under-counting delays auto-compact →
  context overflow, the worse failure).

## Kiro models (all TEXT LLMs — sidecar applies to all)
`kiro-auto, claude-opus-4.8/4.7/4.6, claude-sonnet-4.6/4.5, claude-haiku-4.5, deepseek-3.2,
minimax-m2.5, glm-5, qwen3-coder-next` — all text models; the char heuristic applies uniformly.

## Design

### New module `src/lib/token-estimate.ts` (sidecar, reusable + testable)
- `charsPerToken(modelId?: string): number` — model-aware ratio; kiro text models → 3.5,
  generic default → 4.
- `estimateTokens(text: string, modelId?: string): number = max(0, ceil(len / charsPerToken))`.
- Pure, dependency-free (no tokenizer dep added).

### Wire into `src/adapters/kiro.ts`
- `createKiroAdapter` is created **per request** (`server.ts:440` → fresh factory each call), so a
  closure variable is race-free.
- `buildRequest`: build the full Kiro payload exactly as before, but estimate reported `inputTokens`
  from the current-turn suffix only:
  - include user/developer/tool-result messages after the last assistant message;
  - do **not** count old assistant output/tool-call args as new input;
  - count system prompt + tool definitions only on the first model turn, so stable prompt overhead is
    not re-added forever in Codex's additive session usage.
  Store `inputTokens` + `modelId` in per-request closure vars.
- `parseKiroStream(response, modelId?, inputTokens?)`: accumulate output chars from `text_delta` +
  `tool_call_delta.arguments`; on terminal `done`, emit
  `done{usage:{inputTokens: inputTokens ?? 0, outputTokens: estimateTokens(accumulatedOutput, modelId)}}`.
  Params are optional (default ratio + 0 input) so the generator stays usable standalone.
- **Both call sites forward closure values** — `parseStream` AND `parseResponse` (kiro.ts:341, the
  web-search sidecar path) must pass `modelId`+`inputTokens`, else web-search emits zero usage
  (Backend audit fix #2).
- (Optional) if a real CW `usage` number appears, prefer it. v1: heuristic only; CW currently sends none.

> Superseded note: the earlier audit statement "per-turn input_tokens == cumulative context size
> because full history is re-sent each turn" was wrong for Codex's additive `total_token_usage`.
> Full history still matters for Kiro upstream context, but the value emitted in
> `response.completed.usage` must be a current-turn delta to avoid repeated old-history addition.

## Slices (single PABCD pass, 2 build steps)
1. **Estimator** `src/lib/token-estimate.ts` + `tests/token-estimate.test.ts`
   (ratios, ceil, empty string, model-aware, monotonicity).
2. **Wiring** kiro adapter input estimate + output accumulation + `done{usage}`; extend
   `tests/kiro-adapter.test.ts` to assert `done` carries non-zero input/output tokens.

## Verification
- `bun test tests/token-estimate.test.ts tests/kiro-adapter.test.ts` green.
- `bun test tests/` full suite no regression.
- `bun x tsc --noEmit` → 0.
- Regression added: `tests/kiro-adapter.test.ts` now proves old history remains in the Kiro request
  body while `done.usage.inputTokens` stays stable for the same latest user input, and proves
  tool-result follow-ups do not re-count prior assistant tool-call args.
- Self-served live check (optional): drive the adapter and assert the `done` event usage is non-zero
  (→ bridge emits non-zero `response.completed.usage` → Codex auto-compact engages).
- Backend read-only verification at A (plan) and B (build).

## Commits (atomic, no push)
- `feat(kiro): add heuristic token-estimate sidecar (src/lib/token-estimate.ts)`
- `feat(kiro): emit estimated usage so Codex usage + auto-compact work`
- `fix(kiro): report current-turn usage instead of full history body`
- devlog commits per phase (`git add -f`, devlog/ is gitignored).
