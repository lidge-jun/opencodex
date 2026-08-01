# 001 — Roadmap: make the DeepSeek Responses wire actually reachable and inbound-correct

## Objective

DeepSeek V4 Flash is already defaulted to the Responses wire by `e743660fc`, but the
wire is unreachable (wrong path), inbound-blind (applies to Claude Code and Chat
clients that never asked for it), and stateful (forwards parameters a stateless
upstream does not accept). Close all three so that:

- Codex → DeepSeek V4 Flash rides the native Responses API with zero translation hops.
- Claude Code and OpenAI-compatible clients keep the mature Chat Completions path.
- No stateful parameter reaches a stateless upstream.

## Constraints

- Bun-native TypeScript. `bun run typecheck` and `bun run test` must stay green.
- The worktree carries unrelated RSS-retention work; it is out of scope and untouched.
- `fish2lab/DSCodex` is read-only reference. Its clone is gitignored; no code is copied.
- No `deepseek-v4-pro` Responses wiring — upstream says not supported yet.

## Work-phase map (dependency-ordered, PHASE-SPLIT-01)

The order is forced by the dependency chain, not by effort:

1. **Phase 1 (`010`) — endpoint contract.** Nothing else is observable until the URL
   is right; a correct inbound decision that routes to a 404 is still broken. This
   phase makes the Responses wire reachable.
2. **Phase 2 (`020`) — inbound-aware wire selection.** Builds on a reachable wire and
   decides *who* gets it. Requires phase 1 to be verifiable end-to-end.
3. **Phase 3 (`030`) — stateless request sanitisation.** Applies to the requests that
   phase 2 routes onto the Responses wire, so it consumes both prior phases.

## Success criteria

| id | scenario | expected evidence |
|---|---|---|
| C1 | DeepSeek Responses URL resolves to `https://api.deepseek.com/responses` | unit test asserting built URL |
| C2 | Responses inbound + V4 Flash → `openai-responses` | unit test on resolver |
| C3 | Anthropic inbound + V4 Flash → `openai-chat` | unit test on resolver |
| C4 | Chat inbound + V4 Flash → `openai-chat` | unit test on resolver |
| C5 | Stateful params dropped for stateless upstream | unit test on built body |
| C6 | No regression | `bun run typecheck` + `bun run test` green |

## Out of scope

`src/server/relay.ts`, `src/server/relay-eager.ts`, `tests/relay-eager.test.ts`,
`tests/sse-failed-tail.test.ts`, `tests/sse-inspector-bounds.test.ts`,
`devlog/_plan/260731_macos_rss_retention/**`. GUI surfacing of the wire choice.
Any `deepseek-v4-pro` change.
