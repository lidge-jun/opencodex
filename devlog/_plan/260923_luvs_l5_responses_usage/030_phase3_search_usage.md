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
3. `git cherry-pick -x 973a4ac702 bb49c9f582`, then a follow-up commit (luvs01 co-author) adapts
   `tests/web-search/web-search-passthrough-bridge.test.ts` (the `clientPrincipalId: "loopback"`
   expectation) to dev's documented rule that keyless callers get no bridged replay: configure an
   inbound API key, assert the derived principal, keep a keyless miss control.
4. `ae52669293`: cherry-pick.
5. Keep dev's `src/web-search/executor.ts`, `tests/web-search/web-search-sidecar-429.test.ts`, the
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

## Amendments after review (wp4 P)

- #5562 `3f3fdf17f4`: drop its early combo intersection hunk in
  `src/server/responses/request-prepare.ts`. It sampled a combo target with `routeModel` before
  dispatch, so the decision could follow a different pick than the one sent and could advance
  round-robin or random state. Dev's #4129 rule stays: a shadow call rewritten to a combo enters
  the combo and carries `shadowCallIntercepted`. The test
  `a combo whose first target intersects the source still routes as a combo` keeps dev's
  assertions. The combo-child isolation marker and its tests remain.
- #5562 `bb49c9f582` follow-up: the bridge replay test configures an inbound API key, derives the
  principal with `resolveContextPrincipal`, passes the full loopback admission, and adds a keyless
  miss control.
- #5556 `138069331f` follow-up: accept `attributionSince` only in canonical
  `toISOString()` form; positive fixtures use `.000Z`; malformed cases include `"0"`.
- #5556 selector encoding: `encodePersistedRequestedModel` must stay idempotent because rows are
  normalized again on read, so a literal selector equal to another selector's encoded form
  aliases it. Document the limitation in the code comment and pin it with a test; a digest column
  would remove it and is reported to the maintainer.

## Outcome (wp4)

#5562: seven commits carried; follow-ups `fix(responses): keep combo shadow interception on the
dispatch pick` and `test(web-search): bind repaired-leg replay to a keyed caller principal`.
`421ba780ae`, `6b122cd2f0` and `6ea3a95c21` stay with #5549.
#5556: ten commits carried; follow-ups `fix(cli): accept only an ISO-8601 UTC attributionSince`
and `docs(usage): state the aliasing limit of the idempotent selector encoding`. The screenshot
commit is not carried; the PR links the existing capture.
Local checks: NOT RUN. Static gate passed; hosted CI verifies in wp5.
