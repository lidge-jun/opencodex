# 002 — PR triage and contributor attribution (32 open at the cutoff)

Live count at the cutoff, verified with `gh pr list --state open --limit 200`:
**32** open PRs — `557, 581, 811, 812, 947, 978, 985, 997, 999, 1002, 1008,
1010, 1036, 1039, 1047, 1056, 1085, 1092, 1093, 1095, 1096, 1109, 1111, 1114,
1115, 1119, 1121, 1122, 1124, 1126, 1130, 1131`. The tables below also carry
**#1129**, which merged during triage (`e9d957bf6`) and is listed only to record
that it needs no action; it is not counted in the 32.

Two sol-medium lanes fetched every PR head, read the real diff, checked
mergeability against live `dev`, and recorded the **commit author identity** —
that identity is what the stack's `Co-authored-by:` trailers must use.
Snapshot: `.snapshot_prs.json`.

## Attribution table (identity used in stack commits)

Email addresses are redacted here as `<email from PR head>`: this devlog is a
public directory and `bun run privacy:scan` fails the build on a committed
contributor address. The **real** identity used for each `Co-authored-by:`
trailer is read at implementation time from the contributor's own commits:

```
git fetch origin pull/<n>/head:pr-<n>
git log -1 --format='%an <%ae>' pr-<n>
```

That keeps attribution exact in git history — where it belongs and where GitHub
renders it — without publishing addresses in a documentation file.

| PR | GitHub login | Credit as | Commit identity for `Co-authored-by:` |
|----|--------------|-----------|----------------------------------------|
| 1131, 1130, 1039 | `luvs01` | luvs01 | `luvs01 <email from PR head>` |
| 1124, 1121, 1114, 811 | `Ingwannu` | ingwannu | `Ingwannu <email from PR head>` |
| 1126, 1036 | `ZachDreamZ` | NexusCore | `Agent59353 <email from PR head>` (#1126) |
| 1122 | `giulioleone097` | Giulio Leone | `Giulio Leone <email from PR head>` |
| 1115, 1111 | `Simon-Opopeee` | Simon | `Simon <email from PR head>` |
| 1109, 1085 | `n3wr1ch` | n3wr1ch | `n3wr1ch <email from PR head>` |
| 1096 | `chrisae9` | Chris Alves | `chrisae9 <email from PR head>` |
| 1095, 1047 | `baileyh8` | Bailey | `baileyh8 <email from PR head>` |
| 1093 | `yamashirotakashi` | Takashi Yamashiro | `Takashi Yamashiro <email from PR head>` |
| 1092 | `eachann1024` | Eachann | `关俊江 <email from PR head>` |
| 1056, 947 | `WZBbiao` | biao | `WZBbiao <email from PR head>` |
| 1010 | `harryzhou2000` | Harry Zhou | `HarryZhou <email from PR head>` |
| 1002 | `hanjianjun` | hanjianjun | `hanjianjun <email from PR head>` |
| 999, 997 | `Yuxin-Qiao` | Yuxin Qiao | `Yuxin Qiao <email from PR head>` |
| 985, 978 | `DevMello` | Pranav Yerramaneni | `devmello <email from PR head>` |
| 812 | `theQuert` | Quert | `theQuert <email from PR head>` |
| 581 | `letr1n1ty` | k0 | `letr1n1ty <email from PR head>` |

`#1036`'s head commits carry a maintainer-adjacent committer identity; the
PR author `ZachDreamZ` (NexusCore) is credited, since authorship of the idea
and the patch is what the attribution is for.

## Adopt near-verbatim (merge-clean, right code path, tested)

| PR | Contributor | Subject | Phase | Note |
|----|-------------|---------|-------|------|
| 1114 | ingwannu | Bounded translated SSE inspection (#1112) | 010 | Reuses the existing byte-bounded inspector; small and correctly layered |
| 1124 | ingwannu | Skip empty native-profile stage sweeps (#1120) | 020 | Skips locking only when both stage locations are provably absent; uncertainty stays fail-closed |
| 1130 | luvs01 | Native-main ACL timeout retry | 030 | Fail-closed with coded errors and one bounded retry |
| 1115 | Simon | Bounded oversized rollout inspection | 040 | fd/path re-stat checks, chunk-safe UTF-8, malformed/truncated cases |
| 997 | Yuxin Qiao | Isolate usage-log fixtures from the real home | 150 | Scratch-home isolation with explicit target/content assertions |
| 999 | Yuxin Qiao | Document the Desktop remote allowlist limit (#241) | 150 | Docs-only, accurate, merge-clean |

## Adopt adapted (idea correct, packaging narrowed)

| PR | Contributor | Keep | Drop | Phase |
|----|-------------|------|------|-------|
| 1122 | Giulio Leone | Anthropic client-facing selector captured before the upstream rewrite in `applyFinalRouteRequestNormalization`, then used in the bridge and passthrough JSON/SSE builders (anchors located by symbol in `src/server/responses/core.ts`, not by line — four phases edit that file) | Generalizing response identity and catalog lifecycle to every provider; the hidden compatibility alias rows | 050 |
| 1111 | Simon | `src/server/github-copilot-responses-repair.ts` (+338) with its `src/server/relay.ts`, `src/server/responses/core.ts`, and `src/server/sse-payload-rewrite.ts` wiring, plus `tests/github-copilot-sse-rewrite.test.ts` and `tests/github-copilot-stream-contract.test.ts` | Commit `6247d3932` — the `tests/ci-workflows.test.ts` permission assertion that causes the only merge conflict | 060 |
| 1047 | Bailey | The new `syncRawBodyImageDescriptions` (added after `renderDescription`, `src/vision/index.ts:269`) and its calls at the end of `describeImagesInPlace` (`:347`) and `stripImagesInPlace` (`:453`) | Its `descriptions.length === 0` early return and its raw-part fallback when a description is missing — both leave images in `_rawBody` | 080 |
| 978 | Pranav Yerramaneni | Adapter gate at `src/adapters/google.ts:343-360` | Nothing; add the missing provider-wide positive case and correct the docs | 090 |
| 985 | Pranav Yerramaneni | `parseTextFormat` replacing the boolean `detectStructuredOutput` (`src/responses/parser.ts:671`), `options.textFormat` on `src/types.ts`, and the new `response_format` mapping in `src/adapters/openai-chat.ts` (no such handling exists on dev) | Its `textFormat.schema !== undefined` guard, which drops a schema-less `json_schema` entirely | 100 |
| 1036 | NexusCore | Translator and tests | Provenance derived from pre-filter `request.tools` (`src/adapters/cursor/live-transport.ts:543-560`) — derive from the final catalog | 110 |
| 1126 | NexusCore | Empty-delta replay preservation (`src/bridge.ts:826,1558`) | Persisted chain-of-thought cache, exit hooks, global counters — the memory-only privacy contract stays | 120 |
| 1093 | Takashi Yamashiro | Ordinary-attempt recording, explicit empty arrays (`src/usage/log.ts:323`) | Ingress-span persistence: any admitted client could forge a regex-shaped "guard-issued" span | 130 |
| 1092 | Eachann | Effort-picker fail-closed fix (`gui/src/combo-workspace-data.ts:12`) | Catalog fallback synthesis, copy redesign, `imageInput`, locale churn | 140 |
| 1085 | n3wr1ch | Pi loopback placeholder and no-key UX (`src/clients/config-export.ts:704,948`) | Combo/direct-mode filtering and generalized export-contract changes | 140 |

## Reimplement (defect real, patch unusable as written)

| PR | Contributor | Why | Phase |
|----|-------------|-----|-------|
| 947 | biao | Darwin predicate idea is sound but the branch conflicts with dev and its tests use fixed `settle()` waits (`tests/relay-eager.test.ts:269-284`). Port `requiresEagerRewriteRelay()` onto current transport code with deterministic waits | 070 |
| 1095 | Bailey | Unsafe: a five-second idle gap after opened items finish is not proof no later item arrives, so it can synthesize `response.completed` and truncate a slow valid response. Correct approach needs authoritative EOF/`[DONE]` | deferred to 070 follow-up, not landed |
| 1056 | biao | 54 files with backup, convergence, multi-agent-pin, and incomplete GUI problems (`src/codex/catalog/sync.ts:498-503`, `src/codex/convergence.ts:194-207`) | deferred |

## Defer (out of scope, reason recorded)

| PR | Contributor | Reason |
|----|-------------|--------|
| 1131 | luvs01 | Strong C4 lifecycle/auth patch, 30 files — needs maintainer security review as its own unit, not a stack slice |
| 1121 | ingwannu | Duplicate of #1122; #1122 covers native passthrough metadata and alias collisions that #1121 misses |
| 1109 | n3wr1ch | OMP feature program across runtime, GUI, docs, localization, credential destinations |
| 1096 | Chris Alves | First slice of an unfinished account-picker feature (#425) |
| 1039 | luvs01 | Circuit-breaker feature program needing its own contract cycle |
| 1010 | Harry Zhou | Cost-overlay feature program, actively reviewed elsewhere |
| 1002 | hanjianjun | Vision-reasoning feature, conflicting, UI/localization-heavy |
| 812 | Quert | Provider onboarding with an external authorization gate |
| 811 | ingwannu | 15k-line E2EE/release/platform program, CI red and conflicting |
| 581 | k0 | 8k-line zh-TW localization program, stale and conflicting |
| 557, 1008 | JUN (maintainer) | Already in flight and maintainer-owned; deliberately untouched |
| 1129, 1119 | JUN (maintainer) | #1129 already merged as `e9d957bf6`; #1119 is the maintainer's own contract-test PR |

## Duplicate resolution

`#1122` beats `#1121` (both target #1117): #1122 also covers native passthrough
response metadata and deterministic alias collisions. `#1121`'s author
(ingwannu) is credited in the phase-050 PR anyway — they filed a correct
independent diagnosis of the same defect.

## Coverage

6 adopt-verbatim, 10 adopt-adapted, 3 reimplement (1 **planned for** phase 070,
2 deferred), 13 defer. Total **32** open PRs, every one accounted for, plus the
already-merged #1129 recorded for completeness.

Nothing in this document is landed at the time of writing — it is a roadmap.
Landed state is recorded only in `170_dispositions.md`, with commit evidence.
