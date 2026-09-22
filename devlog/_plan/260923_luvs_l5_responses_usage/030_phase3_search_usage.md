# wp4: #5562 and #5556

## #5562 (head `6ea3a95c21`)

Skip `76aa665e64`, `7e826dc089` (on dev in `b7351ddef3`), `65c3477dd2` (merge), and
`421ba780ae`, `6b122cd2f0`, `6ea3a95c21`: open #5549 carries the sandbox-cleanup helper,
`createTestCaseLifecycle` and their tests (its `ef5c002220` and `8dc4050fad`). The key-failover
fixture adoption in `6b122cd2f0` imports that helper, so it cannot land here without applying the
helper twice; it is dropped from this lane and reported to the maintainer for a follow-up after
#5549.

1. `git cherry-pick -x 7f45883fb5 c4fa8c8d8f`.
2. `git cherry-pick -x 8d46989165 3f3fdf17f4`. Once the two already-landed commits are skipped,
   both apply cleanly (dry run on `a4bdc03054`): `request-prepare.ts` keeps dev's caller-principal
   block from #5575 and gains only the early combo intersection and shadow marker.
4. `git cherry-pick -x 973a4ac702 bb49c9f582`, then a follow-up commit (luvs01 co-author) adapts
   `tests/web-search/web-search-passthrough-bridge.test.ts` (the `clientPrincipalId: "loopback"`
   expectation) to dev's documented rule that keyless callers get no bridged replay: configure an
   inbound API key, assert the derived principal, keep a keyless miss control.
5. `ae52669293`: cherry-pick.
6. Keep dev's `src/web-search/executor.ts`, `tests/web-search/web-search-sidecar-429.test.ts`, the
   negative controls in `tests/web-search/web-search-bridge-replay.test.ts`, and the single
   physical-send budget wording in `structure/runtime.md` and `structure/providers-and-adapters.md`.

## #5556 (head `d3589638a8`)

1. `git cherry-pick -x 0f0ef96ea3 83514c382f`.
2. `138069331f` reimplemented: in `src/cli/access.ts` treat `attributionSince` as valid only when
   it round-trips through `new Date(value).toISOString()`; add a malformed-but-parseable case
   (for example `"0"`) next to the invalid-string case in `tests/cli/cli-dto-fidelity.test.ts`.
3. `git cherry-pick -x 5563577fc2 c8a9d1a75e 823a7d2d9f 22ee516602 1a8d5f7ded 2241d03f44 ddfef1320b`.
4. Omit `96602cd13d` (merge of `41ec40f7e3`, already an ancestor of dev) and `d3589638a8`
   (screenshot asset only; the PR description links the existing capture).

Cap check: `gui/src/pages/Models.tsx` at most 2,792.
