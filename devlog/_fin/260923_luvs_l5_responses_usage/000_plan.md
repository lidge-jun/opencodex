# L5 luvs01 bundle: Responses continuation, retry and usage boundaries

Lane L5 of the luvs01 contributor-PR bundling. Eight open originals become one branch,
`codex/260923-luvs-l5-responses-usage`, cut from `origin/dev` at `a4bdc03054`, with ordered
attributable commits and one pull request to `dev`. Landing is decided by the maintainer; this
unit never merges.

## Constraints

- Local verification is not run in this lane (no test, typecheck, build, install, CLI or service
  commands). Hosted exact-head CI is the verifier; every report says "local checks: NOT RUN".
- Push only `HEAD:codex/260923-luvs-l5-responses-usage`. Never write to contributor branches, to
  `stack/*` branches, or to `dev`.
- `tests/fixtures/file-size-baseline.json` caps never move up. Overflow moves byte for byte to a
  sibling file registered in `scripts/test-layout/layout.json` `explicit` and
  `tests/fixtures/test-layout-expected.json`.
- Security-sensitive review notes stay in scratch space, never in this directory.

## Dispositions (pinned heads, re-checked 2026-09-23)

| Original | Head | Disposition | Evidence |
|---|---|---|---|
| #5474 cursor replay bound | `f4eab495c3` | ALREADY ON DEV (index) + DROP (cutoff) | The constant-time replacement index landed in `74490eee36` (#5507), which says it partially carries #5474. The remaining 4,096-message cutoff can begin inside a user turn, and its new test expects the initiating user root to vanish; #5507 deferred it for that reason. |
| #5305 usage.jsonl size cap | `fa7f53fee3` | DROP | Unconditional 64 MiB rotation and legacy-ledger deletion contradict the documented opt-in `usageLedgerMaxBytes` retention (`src/usage/ledger-retention.ts`, configuration reference). Readers only read `usage.jsonl`, so rotated rows disappear from totals. |
| #5434 OAuth rotation attribution | `f6778bfb70` | CHERRY-PICK | Both commits apply cleanly; `hasEligibleGenericOAuthFailoverTarget` is absent from dev. |
| #5560 continuation boundaries | `2ec0cd12f5` | REIMPLEMENT (net) + CHERRY-PICK | Final tree merges cleanly. The xAI empty-catalog selector part is already on dev in `b20acc79d2` (#5376); the first two commits are combined into their net change. The other nine commits carry in order. |
| #5542 tool normalization | `b57d7c5da0` | REIMPLEMENT (selective) | The four native-Responses commits are on dev in `53654291cd` (#5508). The five tool-normalization commits carry, with ADR-0097 renamed to ADR-0099 and dev's newer #5508 docs/tests kept on the three conflicts. |
| #5553 retry/compaction/account | `67c4f579e4` | REIMPLEMENT (selective) | `35fb727ddf` and `940b318292` are on dev in `b7351ddef3` (#5575), which widened the replacement fence. Fifteen commits carry; the retry conflicts keep dev's side. |
| #5562 search replay boundaries | `6ea3a95c21` | REIMPLEMENT (selective) | `76aa665e64` and `7e826dc089` are on dev in `b7351ddef3` (#5575). Combo isolation and terminal repair carry. Dev's caller-principal and single send-budget contracts are kept. `421ba780ae` and the lifecycle helper from `6b122cd2f0` are carried by open #5549 (another lane); the key-failover fixture adoption that depends on that helper is dropped from this lane and handed back to the maintainer. |
| #5556 usage observation | `d3589638a8` | CHERRY-PICK + REIMPLEMENT (one hunk) | Ten commits carry. The attribution-timestamp check is tightened to the producer's canonical ISO form. The merge-only commit and the screenshot-only commit are omitted. |

## Commit ledger for the dropped originals

| Commit | Disposition | Reason |
|---|---|---|
| #5474 `49a9c15988` | ALREADY ON DEV (index) + DROP (cutoff) | `entryIndex` replacement is in `74490eee36`; the raw 4,096-message cutoff is dropped. |
| #5474 `68f74eb844` | DROP | The test asserts that the initiating user root disappears. |
| #5474 `f4eab495c3` | DROP | Merge from dev; no own change. |
| #5305 `fa7f53fee3` | DROP | Conflicts with the opt-in ledger retention contract. |

## Transitive provenance

| Carrier | Source PRs and authors |
|---|---|
| #5474 | contributor fork PR #348 (luvs01) |
| #5560 | #5350 (Yeonwoo Choi / twoimo), #5420 (maosisheng, Cursor co-author), `82a5f6da81` (Epinephrine), `aac783fe8d` (Devin AI, Epinephrine co-author) |
| #5542 | #5508 (already on dev; itself carried #5479, #5470, #5492 by luvs01), #5230 (kosta), #5352 (Flowershangfromthebranches), `7cbbf44f6c` (Epinephrine), `19a2005e41` (Devin AI) |
| #5553 | #5446, #5423, #5415 (luvs01), compaction identity and scoped quota series (Epinephrine, Devin AI) |
| #5562 | #5480, #5365 (luvs01), `973a4ac702` (Devin AI, Epinephrine co-author) |
| #5556 | #5358, #5283, #5275, #5255 (luvs01) |

Cherry-picked commits keep their authors and gain `-x` source trailers. Reimplemented commits
carry `Co-authored-by` trailers for every source author.

## Work-phase map

| Phase | Doc | Content |
|---|---|---|
| wp1 | this file | roadmap (docs only) |
| wp2 | `010_phase1_small_units.md` | #5434 |
| wp3 | `020_phase2_responses_sequence.md` | #5560, #5542, #5553 on the shared dispatch file |
| wp4 | `030_phase3_search_usage.md` | #5562, #5556 |
| wp5 | `040_phase4_pr_ci_review.md` | push, PR, review waves, exact-head CI, security verdict |
| wp6 | `050_phase5_close_originals.md` | close superseded originals with credit |

## Shared files

- `src/server/responses/passthrough-dispatch.ts`: #5560 (error mapping near the custom-tool
  admission), #5542 (native-control authorization), #5553 (OpenCode Go reset exception), #5434
  (OAuth budget-denial attribution). Disjoint hunks, applied in wp2 then wp3 order.
- `structure/transports/responses.md`: every carrier except #5562 edits a separate paragraph;
  union the paragraphs and keep dev's #5575 status table.
- `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`: additive
  entries only.
- Capped files touched: `src/server/responses/core.ts` (210/210, one-line re-export kept),
  `tests/responses/responses-compaction-routing.test.ts` (2776 cap, carry reaches 2772),
  `tests/server/server-auth.test.ts` (shrinks), `tests/providers/cursor/cursor-blob.test.ts`
  (net zero), `tests/responses/openai-responses-passthrough.test.ts` (net zero after extraction),
  `gui/src/pages/Models.tsx` (2792 cap, carry reaches 2783).

## Cross-lane seams

`src/server/responses/request-prepare.ts`, `passthrough-delivery.ts`, `src/codex/auth-context.ts`,
`src/server/responses/compact.ts`, `core-codex-account.ts`, `src/usage/log.ts`,
`src/bridge/sse.ts`, `structure/ops/docs-and-release.md`, and both test-layout registries.
`src/responses/parser.ts` and `src/responses/plaintext-v2-agent-messages.ts` are not touched (the
#5542 hunk on the latter is already on dev). `421ba780ae` and the whole of `6b122cd2f0`/
`6ea3a95c21` depend on the sandbox-cleanup helper that open #5549 carries; they stay out of this
lane so no change is applied twice.

## Re-pin: #5553 moved (2026-09-23)

#5553's head moved from `67c4f579e4` to `cc466ed9c0` by fast-forward. The four new commits are not
carried by this lane: `f732aa4689` and `6e6bd22f3b` are the whole of #5307, which lane L2 carries in
#5600 (`c448a49794`); `7aaf9594ec` is the Kiro part of #5310, which belongs to lane L7; `cc466ed9c0`
adds tests and structure notes for those two carries. The merge of `a077087b74` is already on dev.
Every earlier #5553 commit is carried as planned.
