# 000 — Claude Code tier labels and inclusive Anthropic usage: Plan

## Objective

Two independent Claude-surface defects, delivered in one bundle PR into `dev`:

1. **#6926 — `/model` shows the OCX alias.** Claude Code 2.1.296 (binary read from
   `@anthropic-ai/claude-code-darwin-arm64@2.1.296`) builds a tier row (Opus, Sonnet, Fable,
   Haiku) as `label: ANTHROPIC_DEFAULT_<TIER>_MODEL_NAME ?? <first-party display name> ?? <id>`
   (function `xs(e,r,n,s)`). Gateway rows already use `display_name`
   (`label: AT(s.display_name ?? "") || AT(s.id)`), so the discovery path is correct. OpenCodex
   sets `ANTHROPIC_DEFAULT_<TIER>_MODEL=ocx-claude-native--gpt-6.1-sol` but never the paired
   `_NAME`, and an `ocx-claude-*` alias is not a first-party id, so the row prints the alias.
   The alias stays the submitted id (owner constraint on #6926); only the label changes.
2. **#6566 carry — inclusive Anthropic usage.** `usageFromAnthropicShape`
   (`src/adapters/coding-agent/protocol.ts`) reports Anthropic's cache-exclusive
   `input_tokens` as `inputTokens`. OpenCodex's contract is inclusive
   (`normalizeCostTokens` returns `null` when `cacheRead + cacheWrite > input`), so a Claude
   CLI / CodeBuddy / Qoder turn with 12 fresh, 150,000 cache-read and 4,000 cache-write tokens
   loses its cost estimate. Carry only that fix from #6566 (Co-authored-by: Foodcel).

#6532 needs no code: its fixes are ancestors of the base (`0455845834`, `26dd8cf657`,
`33125e62d2`); it stays open for live multi-account acceptance (NEEDS_HUMAN).

## Loop-spec

- Loop archetype: verifier-defined (hosted CI on the exact head + independent review).
- Write scope: `src/claude/context-windows.ts`, `src/cli/claude.ts`, `src/server/system-env.ts`,
  `src/server/system-env-shell.ts`, `src/adapters/coding-agent/protocol.ts`, their tests,
  `docs-site/src/content/docs/guides/claude-code.md`.
- Out of scope: Claude intercept settings / NO_PROXY (#6938), GUI manual-env block, #6566 usage
  admission and stable replay, Desktop 3P hashed aliases.
- Bounds: no local test runs (lane packet); static checks only; one push.

## Work-phase map

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| 1 | 010_phase1.md | tier labels + inclusive usage | — |

## Accept criteria

- An alias tier slot is paired with its `_NAME` label in the launch env, launchd and the shell
  file; a user-set slot or `_NAME` always wins; a native session drops a label it strips the slot for.
- Anthropic-shaped usage is inclusive; partial folds keep fresh input counted once.
- Regression tests for both; hosted CI green on the exact head; independent review clean.

