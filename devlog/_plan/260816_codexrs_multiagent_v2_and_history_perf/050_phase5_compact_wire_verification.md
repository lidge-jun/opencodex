# Phase 5 — /v1/responses/compact wire-fidelity verification

Closes G8. Independent of every other phase.

> **A-phase amendment (round 1).** The reviewer flagged that this doc deferred its
> central decision ("two possible outcomes") and labelled Guardian handling
> "investigate, likely no-op" — asking B to design the phase. Both decisions are now
> settled in the doc, with the investigation moved to a P-phase precondition whose
> answer is written down before B starts. Upstream anchors corrected:
> `compact.rs:35` is `fn path()`, not `CompactRequest::new`.

## Why

`002_upstream_history_perf_evidence.md` established the history rework is local except
for a narrow proxy-visible surface. `b9ba969f3` ("Enable remote compaction for Amazon
Bedrock") widens the set of configurations issuing `POST /v1/responses/compact`, so more
traffic reaches an endpoint opencodex already implements.

Upstream request contract — `CompactionInput`, `codex-rs/codex-api/src/common.rs:26`:
`model`, `input`, `instructions`, `tools`, `parallel_tool_calls`, `reasoning`,
`service_tier`, `prompt_cache_key`, `text`.

Endpoint anchors (corrected): `fn path() -> "responses/compact"` at
`codex-rs/codex-api/src/endpoint/compact.rs:35`; the sending function is
`compact_input` at `compact.rs:71`, which serializes `&CompactionInput` into the body.

`4bd5b9fd0` changes which items stay adjacent inside the existing `input` array — no new
field, but observable body content.

## Current state (verified this session)

| Location | Fact |
| --- | --- |
| `src/server/index.ts:1074` | `/v1/responses/compact` POST branch (the `:1071` line is its comment) |
| `src/server/responses/compact.ts:267` | `handleResponsesCompact` — native forward or routed conversion |
| `src/server/responses/compact.ts:401` | explicitly DROPS top-level `reasoning` before forwarding |
| `src/server/responses/compact.ts:656-716` | routed models converted to v2 summarization |
| `src/responses/compaction.ts:56-123` | v1 retention: ~20k tokens ≈ 80k chars, newest-first |
| `tests/responses-compaction-routing.test.ts:139,437,557,639` | existing routing/auth/fallback coverage |

## P-phase precondition (settle BEFORE building)

One question must be answered and its answer written into this doc as an amendment:
**is the `compact.ts:401` reasoning drop deliberate?**

```bash
cd /Users/jun/.codex/worktrees/e80c/opencodex
sed -n '390,410p' src/server/responses/compact.ts        # read the surrounding rationale
git log -S'reasoning' --oneline -- src/server/responses/compact.ts | head
rg -n 'reasoning' devlog/_fin --glob '*compact*' | head    # prior devlog rationale (-n, never -r: -r means replace)
```

The decision rule is fixed in advance, so B is not designing:

- **Evidence of a deliberate reason** (a comment, commit message, or devlog explaining a
  provider rejecting `reasoning` on compact) → **keep the drop**, add a citing comment at
  `:401`, and assert the drop in the test so it is intentional rather than incidental.
- **No such evidence** → treat it as incidental: forward `reasoning` on the native path
  where `CompactionInput` carries it, keep dropping it for targets that reject it, and
  cover both branches.

Record the finding and which branch was taken. Do not change behavior before it is
recorded — compaction runs on the user's full context and a wrong change is expensive.

## Change 1 — field-fidelity regression (ADD to `tests/responses-compaction-routing.test.ts`)

Send a compact request carrying every `CompactionInput` field with a distinguishable
value; assert on the captured upstream body:

```ts
const body = {
  model: "gpt-5.6-sol",
  input: [/* ... incl. an image item followed by its resize notice ... */],
  instructions: "SENTINEL_INSTRUCTIONS",
  tools: [{ type: "function", name: "sentinel_tool", parameters: {} }],
  parallel_tool_calls: true,
  reasoning: { effort: "medium" },
  service_tier: "priority",
  prompt_cache_key: "SENTINEL_CACHE_KEY",
  text: { format: { type: "text" } },
};
```

Each field is asserted as forwarded verbatim OR deliberately transformed with the
transformation asserted explicitly. No field may vanish without a named reason. The
resulting table is this phase's deliverable and gets appended to this doc.

## Change 2 — resize-notice adjacency (ADD test)

Per `4bd5b9fd0`, an image item and its resize notice must stay adjacent through
opencodex's compact handling. Assert the relative order of those two items end-to-end.

## Change 3 — Guardian opaque-blob passthrough (settled: regression only)

`c2bcb9a26` lets a Guardian review session start from the parent's encrypted compaction
response item, which then traverses opencodex as ordinary `input[]` content. The relevant
opencodex behavior already exists: `src/adapters/openai-responses.ts:141` converts
opencodex `ocx1:` compaction items to plain messages while leaving genuine OpenAI opaque
blobs alone.

Decision (not an investigation): **add a regression asserting a genuine OpenAI opaque
compaction blob survives the passthrough sanitizer byte-identical**, in
`tests/openai-responses-passthrough.test.ts`. Expected production change: none. If the
regression fails, that is a real defect and this phase fixes it.

## Verification

```bash
bun install                     # REQUIRED FIRST: this worktree has no node_modules
bun test tests/responses-compaction-routing.test.ts tests/responses-compaction.test.ts tests/openai-responses-passthrough.test.ts
bun x tsc --noEmit
```

**Verifier receipts (recorded 2026-08-16).** In this worktree the test command exits `1`
(`0 pass, 3 fail`, `Cannot find module 'zod/v4'`) and `bun x tsc --noEmit` exits `1`
(`TS2688: bun-types`). Environmental — `node_modules/` absent. B runs `bun install` and
re-records real exit codes. `package.json:41` defines `"test": "bun scripts/test.ts"`.

Target observation: these suites exercise `src/server/responses/compact.ts` and
`src/adapters/openai-responses.ts` directly.

## Accept criteria

1. Every `CompactionInput` field is forwarded verbatim or has a documented, asserted
   transformation — recorded as a table in this doc.
2. Image/resize-notice adjacency is preserved.
3. The `reasoning` drop is recorded as deliberate-and-cited or fixed, per the
   precondition's decision rule.
4. A genuine OpenAI opaque compaction blob survives passthrough byte-identical.

## Out of scope

Implementing native compaction ourselves; changing the v1 retention budget
(`compaction.ts:56-123`); Bedrock-specific provider work.

## Terminal note

If every assertion passes with no production change, the honest outcome is **NOOP** —
recorded with the evidence table that proves it, not skipped.
