# 010 — WP1: green-and-ready merges

Five PRs whose base is `dev`, whose CI is green, and against which no reviewer has
requested changes. Each is small enough to verify individually.

## Merge order (dependency-ordered)

```
#2359  catalog exclusions        (no shared surface)
#2309  kiro parallel permission  (adapter-local + docs)
#2339  google signature order    (adapter-local)
#2335  tool-choice linear time   (SHARED: src/types/tools.ts) <- last of the small set
#2313  reasoning replay scoping  (SHARED: responses core)     <- largest, own verification
```

#2335 and #2313 touch shared surfaces, so they land after the adapter-local trio and
each gets its own full verification. WP3 (#2316) re-verifies its pre-written doc against
the tree **after** #2335 lands, because both edit `src/types/tools.ts` /
`src/server/responses/collaboration.ts`.

## Per-PR file change map (verified against the PR heads)

### #2359 — `fix(catalog): exclude uncallable OpenCode Go and Zen models`
Head `d587a4b4`. 12+/0-, 2 files. Closes #2330.

- MODIFY `src/codex/catalog/parsing.ts` — four slugs appended to
  `ROUTED_MODEL_COMPATIBILITY_EXCLUSIONS`: `opencode-go/grok-4.6`,
  `opencode-go/mimo-v2-omni`, `opencode-go/mimo-v2-pro`,
  `opencode-free/deepseek-v4-flash-free`. `hy3-preview` retained.
- MODIFY `tests/codex-catalog.test.ts` — four `shouldExposeRoutedModel(...) === false`
  assertions plus a positive control (`opencode-go/glm-5.2` stays exposed).

Matches the maintainer triage exactly: exclusion-set edit only, augmentation contract
(Ox Alpha, `deepseek-v4-flash-vision-exp`) untouched.
Verifier: `bun test tests/codex-catalog.test.ts`.

### #2309 — `fix(kiro): accept Codex parallel tool permission`
Head `1d5d935b`. 63+/4-, 4 files. Addresses #2308 (priority 72).

Treats client `parallel_tool_calls: true` as permission, not a wire requirement: Kiro
stays serialized and advertises no parallel capability, but no longer rejects the turn.
Includes the docs-site adapter reference update.
Verifier: the kiro adapter test file.

### #2339 — `fix(google): preserve streaming thought-signature order`
Head `e646ad6e`. 69+/10-, 2 files.

- MODIFY `src/adapters/google.ts:964` — `observeAntigravityReplay(...)` return value no
  longer feeds `pendingStreamThoughtSig`; observation may scan the whole frame, so it is
  used for replay-cache side effects only and the source-order loop keeps sole ownership
  of stream carry (it cannot pair backwards).
- MODIFY `tests/google-signature-history-roundtrip.test.ts` — extracts an `sseResponse`
  helper, adds an AI Studio provider fixture, and adds two tests: signatures attach only
  to function calls that FOLLOW them in the same frame, and cross-frame carry survives.
Verifier: `bun test tests/google-signature-history-roundtrip.test.ts`.

### #2335 — `perf(tools): resolve tool-choice catalogs in linear time`
Head `29acc673`. 184+/29-, 8 files. **Shared surface.**

- MODIFY `src/types/tools.ts` — new `createToolChoiceResolver(tools)` compiling one
  immutable catalog view (`candidatesByName`, `sourceCandidatesByName`,
  `identitiesByTool` WeakMap); `toolAllowedByChoiceFromIndex` extracted;
  `toolChoiceCandidates` / `toolAllowedByChoice` / `toolChoiceToolPredicate` re-expressed
  over it. Fails closed when catalog objects mutate after compile.
- MODIFY `src/adapters/anthropic.ts`, `src/adapters/command-code.ts`,
  `src/adapters/google.ts` — replace hand-rolled `Set` + `toolAllowedByChoice` filters
  with `toolChoiceToolPredicate` / the resolver.
- MODIFY `src/responses/parser.ts` — ambiguity check uses `resolver.candidateCount`.
- MODIFY `src/types.ts` — re-export `createToolChoiceResolver`.
- NEW `tests/tool-choice-performance.test.ts` — proves no quadratic candidate replay,
  that public lookups rebuild after a mutable caller mutates its catalog, and that a
  compiled resolver fails closed when its catalog objects change.
- MODIFY `tests/types-barrel-identity.test.ts` — barrel identity for the new export.
Verifier: `bun test tests/tool-choice-performance.test.ts tests/types-barrel-identity.test.ts`
plus the three adapter suites.

### #2313 — `fix(responses): scope reasoning replay by conversation and remember proven blob rejections`
Head `befb4df5`. 571+/11-, 8 files. **Shared surface, largest of the set.**

Two prior approvals from `Ingwannu` (2026-08-21 19:48 and 21:11) both predate the
current head, which was pushed 2026-08-22 03:55. Under the repository's review-readiness
contract a new push resets completion, so the stale approvals are **not** carried into
this merge as evidence. This unit verifies the head itself and records that verification
as the merge basis.

## Accept criteria

1. Each PR merges into `dev` with a squash commit whose message names the PR number.
2. `bun x tsc --noEmit` exits 0 after each merge.
3. The focused suite for each PR exits 0 against the merged tree.
4. Every merge commit is reachable from `origin/dev` by SHA.
5. #2330 closes when #2359 lands; #2308 is updated when #2309 lands.

## Out of scope

Rebasing any of these branches; touching the changes-requested set (WP2); any `main`
movement.

