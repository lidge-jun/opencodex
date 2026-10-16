# 050 — #1587: routed first-turn catalog ignores `defer_loading`

Rank 4. The only candidate with a hard measurement.

## Failure mechanism

`buildTools()` (`src/responses/parser.ts:155`) never reads Codex's
`defer_loading` flag. `pushFn` (:163) and the namespace flattener (:195-207)
copy every tool's full `parameters` into `OcxTool`, and the flag is not on the
type — so it is gone by parse time.

The routed adapters then serialize all of it:

| Adapter | Site |
|---|---|
| chat | `src/adapters/openai-chat.ts:1197` |
| anthropic | `src/adapters/anthropic.ts:740` |
| google | `src/adapters/google.ts:270` |

Non-OpenAI chat/Anthropic/Google additionally inject a `tool-catalog-nudge`
listing every flattened wire name in the system prompt
(`openai-chat.ts:636`).

**The native path is asymmetric on purpose.** `openai-responses.ts:406`
preserves `defer_loading` and strips it only when a `tool_search_output`
actually loads the tool, so the ChatGPT backend keeps deferred schemas out of
the prompt. Chat and Anthropic wires have no server-side deferral, so the same
bytes land in billed context.

## Measured, on a real captured catalog

A lane ran this tree's actual `parseRequest` against a Codex Desktop catalog
captured from a session rollout:

| Sample | Deferred | Catalog bytes | After parse |
|---|---|---|---|
| 2026-08-12 rollout | 8 of 8 tools | 32,927 / 34,404 = **95.7%** | all 8 emitted with full schemas, 32,887 bytes (~8.2k tokens), **zero** defer flags surviving |
| second sample | 4 namespaces / 10 tools | — | 24,227 bytes (~6.1k tokens) |

## State the goal in bytes, not in the headline ratio

The issue title says 3-5x. Both lanes independently flagged that this number
does not survive scrutiny: the thread compares **three different tokenizers**
(OpenAI 21,081 vs Kimi 62,319 vs Claude 98,402), and the Opus row additionally
carried a repo `AGENTS.md`.

The mechanism is real and measured; the multiplier is not a clean
apples-to-apples figure. Success criteria should therefore be
**"deferred tools contribute no schema bytes to the routed catalog"**, verified
in serialized bytes we control — not "routed matches native within N%".

## Fix shape

1. Add `deferred?: boolean` to `OcxTool` and set it in `buildTools`
   (`parser.ts:155-241`, both `pushFn` and the namespace path).
2. Clear it where `loadedToolSpecs` promotes a tool (`parser.ts:691-706`, which
   already tracks `loadedFromToolSearch`).
3. In the three adapters, emit a **name + one-line description stub with empty
   `parameters`/`input_schema`** for deferred tools instead of the full schema.

**The constraint that makes this delicate:** `parser.ts:633` requires exact
wire names stay listed, or the model guesses names. So the stub must keep the
name and drop only the schema. A model may still call a stubbed tool with wrong
arguments before `tool_search` loads it — the `tool_search` round-trip
(`parser.ts:626-654`) has to be the recovery path, not an optional extra.

**Files:** `src/responses/parser.ts`, `src/types.ts`,
`src/adapters/openai-chat.ts`, `src/adapters/anthropic.ts`,
`src/adapters/google.ts`, plus conformance tests.

**Note on the split program — corrected.** `OcxTool` moves in **WP1 (#2019)**,
not WP1b: #2019's diff creates `src/types/tools.ts` and relocates `OcxTool`
there (verified: `git show origin/codex/split-wp1-types:src/types/tools.ts`
contains `interface OcxTool`). #2023 moves the accounts/config/provider/request
clusters. So the `deferred` field lands in `src/types/tools.ts` once **#2019**
is in, one PR earlier than this doc first said.

**Bigger collision this doc originally missed.** The split trio is not the only
moving code on this surface. Live overlaps on #1587's exact files:

| PR | Overlaps |
|---|---|
| **#1934** | `parser.ts`, `types.ts`, **and all three adapters** — #1587's entire surface |
| #2040 | `parser.ts` |
| #2115 | the three adapters |

`#1934` is the real hazard, not the split. The 070 roadmap already schedules it
in phase B precisely because it overlaps. **#1587 should be planned after
#1934 lands**, or the two will conflict across five files.

The original framing — "only #1587 collides, and only with the split" — was a
consequence of checking against the split branches and nothing else.

## The test that currently pins the wrong behavior

`tests/responses-tool-conformance.test.ts` **asserts** that namespace children
are flattened into top-level tools (`github.search` becomes top-level). The
correct regression is the opposite shape and must be added alongside an amended
version of that one.

Red today, green after: a `defer_loading: true` namespace with fat MCP schemas
plus `exec`/`tool_search` → `toolsToChatFormat`/`toolsToAnthropicFormat` must
not include those children's schemas, while still listing their exact
namespaced wire names; serialized catalog bytes stay near the compact size; and
a `tool_search_output` promoting one restores its full schema on the next turn.

## Verification

```
bun test tests/responses-tool-conformance.test.ts tests/responses-parser.test.ts
bun x tsc --noEmit
```

## Risk

Real product risk in both directions. Strip too much and routed models lose
plugin visibility — the #1522/#1529 class, which is why the flattening was
added in the first place (2026-06-19, `6998fcaad`, so chat models could call
MCP tools). Strip too little and nothing improves.

**Do not** re-stamp `supports_search_tool=false` as a shortcut: `fcbef381e`
showed that regresses `exec.description` from 96,699 to 258,929 chars. That is
a different expansion and would make the problem worse while appearing to
address it.
