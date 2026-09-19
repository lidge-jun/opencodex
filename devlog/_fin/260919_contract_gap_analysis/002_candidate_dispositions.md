# Keep bounded contract fixes and reuse existing authorities

The refreshed tree disproves several broad gaps from the supplied material. The candidates retained below address concrete residual behavior or narrowly defined maintainer/operator workflows. They do not justify a new universal runtime, a model-policy language, or a replacement test framework.

## Report themes

| Theme | Current evidence | Disposition |
| --- | --- | --- |
| A1 content decoding | `src/lib/socks5-fetch.ts:530` decodes gzip/deflate after #5070; pinned direct still returns raw bytes at `src/lib/pinned-http.ts:194` | T3 residual; reject original broad SOCKS defect |
| A1 no-body/cancellation parity | `src/lib/socks5-fetch.ts:512` omits 205; `pinned-http.ts:144` streams all 2xx; upload waits on body reader at `socks5-fetch.ts:577` | T1/T2 concrete residuals |
| A2 custom delta/done | Bridge fence/escape handling exists after #5070; routed restore at `responses-custom-tool-repair.ts:338` differs from completion at :363 | S1 residual; patch-envelope claim already covered |
| A3 isolated conformance skeleton | Existing fixture manifests and assertion-bound tests in `src/compatibility/manifest.ts:3` and `tests/codex-integration/compatibility-manifest.test.ts` | Extend focused fixtures in each issue; no duplicate framework |
| B1 schema loss | `google-tool-schema.ts:88,120` and `google-wire-compiler.ts:97` widen constraints without a report | G1 endpoint-profile/report-first proposal |
| B2 detailed tool capability | `src/compatibility/manifest.ts:3` already models passthrough/translated/degraded/unsupported; custom format is lowered at `custom-tool-compat.ts:187` | Existing #2358 follow-up: exact-route grammar fixture claims; no second ToolContract |
| B3 physical sends | Shared send budget and telemetry exist in `request-send-budget.ts:49`, `usage/log.ts:205` | Reject broad absence claim. R1 follows explicitly disclosed integration work in #5041 |
| B4 terminal diagnostics | `src/usage/log.ts:274`, analytics and #1217/#5056 already provide terminal/recovery facts | O1 export-only proposal; schema repair attribution included in G1 report path |
| B5 replay ownership | `continuation-ownership.ts:3` and `request-prepare.ts:916` enforce missing/expired-state refusal | Existing contract retained; R3 explicitly changes historical fresh-start behavior; compatibility review required |
| C1 writer topology | Public ledger contract explicitly scopes supported topology | R2 aligns already-public sibling and ledger topology contracts; no distributed-store roadmap |
| C2 key policy | Existing key identity and scoped hub usage; #5049 open | Reuse #5049, broader tenancy remains #95 |
| C3 standard observability | Durable facts and management JSON analytics exist | O1 bounded exporter; no new raw-content collection |
| C4 takeover/restore | Transactional snapshot/reconcile/recovery exists in `structure/clients/integrations.md:5` | O2 pure preview enhancement; reject missing rollback claim |

## Shared-conversation themes

| Theme | Current evidence | Disposition |
| --- | --- | --- |
| One static policy result | Repeated merges in `derive.ts:221,473`, `router.ts:300`, `model-hints.ts:105` | P1 parity-first resolver, live evidence kept separate |
| Registry-derived identity | `knownModelIdsForProvider` at `router.ts:107` enumerates only some identity maps | P2 classified decode-hint proposal; no current incident claimed |
| New provider/adapter registries | Existing authorities in `providers/derive.ts:290`, `adapters/registry.ts:71` | Already implemented; no new registry |
| Numeric universal precedence | Existing typed wire authority in `server/adapter-resolve.ts:7` | Reject; retain field-specific pins/opt-outs |
| Document authority | `scripts/structure-ssot.ts:31`, `structure/AGENTS.md:45` conflate review fan-out and normative ownership | V1 additive authority map |
| Contract tests versus source inspection | Lab guard is transitive and mutation-tested; structure checker validates real topology | Reject blanket replacement; D3 binds existing guarantee in index |
| Central hardened utilities | Must start from one proven shared contract, not general deduplication | Narrow stream/transport helpers in T3/S1 |
| Canonical history/projection | Replay storage and ownership already exist | No new session-event subsystem without a concrete client need |
| Executor/translator split | `src/adapters/base.ts:36` already supports build/transport/parse and stateful runTurn | Preserve interface; no forced universal executor rewrite |
| Embeddable core/package split | `src/index.ts:1` already exports runtime functions | Defer until a concrete embedding consumer/lifecycle contract exists; #2358 covers broader core work |

## Additional source-confirmed documentation gaps

- D1: HTTP/SSE SOCKS guidance contradicts `src/lib/proxy-env.ts:89` in two public reference pages.
- D2: `reference/configuration/server.md:27` incorrectly says data keys authorize management. Runtime and `server-management-auth.test.ts:780` prove separation.
- D3: `structure/overview.md:90` lacks the existing core/Lab guarantee in its stable invariant map.

## Duplicate and scope decisions

The current bodies of #2358, #3377, #5049, #95 and #4579 were read. #4579 is about receiver-owned execution authorization, not static catalog/routing metadata; it does not duplicate P1. #3377 owns modality/context declarations, not P2's decode-hint completeness. #2894 is the existing SOCKS support umbrella; T1/T2/D1 are bounded residuals after shipped transport support.

No competitor rankings, repository comparisons, review-model identity, personal browser state or raw user transcript are published.

## Public provenance review for residual state work

The exact body of public #5041 states that physical inner replays still need shared send-budget, pacing/fetch and physical-attempt integration. R1 tracks only that disclosed residual. Public #3188 explicitly allows a separately ported sibling; `src/lib/spend-reservation-ledger.ts:27` expressly excludes two live processes sharing a journal. R2 makes that already-published topology boundary actionable without a new bypass reproduction. R3 preserves task isolation and requests explicit full replay rather than continuing with insufficient history.
