# 060 — Phase 7: GitHub Copilot Responses normalization (#1110, PR #1111)

Credit: **Simon** (`Simon <email from PR head>`), PR #1111 and issue
#1110. Adoption: **adapted** — the provider fix is kept, one unrelated commit
is dropped.

## Defect (verified on `dev` = e9d957bf6)

The `github-copilot` provider entry (`src/providers/registry.ts:2043`) declares
`adapter: "openai-chat"` but pins every inbound wire to Responses through
`modelWireDefaults` (`:2060`) — its models reject `/chat/completions` for real
Codex-agent traffic. So Copilot responses reach the Responses relay, which
composes only the generic image/id/snapshot repairs. No Copilot-specific
normalization exists, and Codex clients receive Copilot's dialect: non-canonical
ids, provider-only encrypted/obfuscation fields, and tool-call frames that never
form a valid Responses lifecycle.

## Why adapted

#1111's provider repair is sound: it keeps raw upstream frames for inspection
and continuation while normalizing only the Codex-facing relay. The single
merge conflict against `dev` comes from commit `6247d3932`, which edits an
unrelated CI permission assertion (now `tests/ci-workflows.test.ts:4399`).
Dropping that one commit removes the conflict without touching the fix.

## Change

Paths below are the contributor's actual files, read from `gh pr diff 1111`
against `dev` = `e9d957bf6`.

| Path | Op | Content |
|------|----|---------|
| `src/server/github-copilot-responses-repair.ts` | ADOPT (NEW, +338) | Provider-scoped client-facing block rewrite: stable response/item ids, strip Copilot-only encrypted/obfuscation fields, buffer tool input until the authoritative function/custom `.done` payload, then emit canonical lifecycle blocks |
| `src/server/responses/core.ts` | MODIFY (+33/−~4) | Compose the Copilot rewrite with the existing generic rewrites at the relay rewrite composition point (located by symbol — phases 050/070/130 also edit this file), on both the eager and tee paths, under the existing translator budget |
| `src/server/sse-payload-rewrite.ts` | MODIFY (+39/−~32) | Rewrite hook shape the Copilot repair plugs into |
| `src/server/relay.ts` | MODIFY (+28) | Wire the rewrite through the relay path |
| `tests/github-copilot-sse-rewrite.test.ts` | ADOPT (NEW, +281) | Provider-dialect fixtures: id normalization, field stripping, tool-call reconstruction |
| `tests/github-copilot-stream-contract.test.ts` | ADOPT (NEW, +248) | Endpoint-level stream contract |
| `tests/sse-payload-rewrite.test.ts`, `tests/sse-inspector-bounds.test.ts`, `tests/passthrough-abort.test.ts` | MODIFY (+34/+37/+11) | Supporting coverage. **Conflict note:** phase 010 already changed `sse-inspector-bounds.test.ts`; this phase rebases onto that result rather than reverting it |
| `tests/ci-workflows.test.ts` | UNTOUCHED | Commit `6247d3932` is dropped; this file must show **no diff** in the phase |

Raw upstream frames stay untouched for diagnostics and continuation — the
rewrite is client-facing only. That boundary is what keeps request-log fidelity
intact.

## Execution

Cherry-pick the PR's commits except `6247d3932`, resolving against current
`dev`. If the range does not apply cleanly, reimplement the module from the
contributor's design and keep the `Co-authored-by: Simon` trailer.

## Verification

- `bun test tests/github-copilot-*.test.ts`
- `bun run typecheck`
- `bun run privacy:scan`

Live Copilot traffic is not available in this environment; the tests are
fixture-driven and the PR says so instead of claiming live verification.

## PR

Stack 06, base = stack 05 head. `Closes #1110`. Credits Simon and names the
dropped CI commit explicitly.
