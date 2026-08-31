# 260829 — Green-PR merge train

Eight rebased pull requests reached a fully green test matrix on `dev@e546c160b` and are
candidates to land. This unit records why each one is safe to merge, the order the merges
must happen in, and the two integration designs that have to be built before their PRs can
land at all.

## Why this needs a written analysis rather than eight merge clicks

The eight diffs are not independent. Five pairs touch the same file, and three of those
pairs touch `src/config.ts` — the shared config parser every provider path reads. Merging
in arrival order would produce conflicts that a later merge resolves blindly, which is the
failure mode that produced the #2850 → #2851 follow-up: a merge that looked clean and
needed a security repair one hour later.

A second reason is drift. `dev` moved from `e546c160b` to `8d1dc1f5d` while this set was
being prepared (#2861, #2862, #2865, #2868, #2869). Every green result recorded earlier
belongs to the head that produced it, not to the head the merge will land on.

## Regression-impact inventory

Source files each PR touches, ignoring docs and tests:

| PR | Subject | `src/` surface |
|---|---|---|
| #2365 | usage cache metrics | `usage/summary.ts` |
| #2429 | `test:changed` local check | `AGENTS.md` only |
| #1756 | Grok per-model reasoning effort | `grok/{catalog,effort,inject,models}.ts`, `server/index.ts` |
| #2050 | combo routing strategies | `combos/*`, `cli/*`, `providers/quota*.ts`, `router.ts`, `types/config.ts` |
| #2827 | trusted Responses request id | `server/index.ts`, `server/request-log.ts` |
| #2364 | Vercel AI Gateway routing | `adapters/openai-chat.ts`, `config.ts`, `providers/vercel-gateway-routing.ts`, `server/auth-cors.ts`, `types.ts`, `types/provider.ts` |
| #2712 | xAI `x_search` opt-in | `adapters/{openai-responses,xai-web-search}.ts`, `config.ts`, `server/auth-cors.ts`, `server/responses/core.ts`, `types/provider.ts` |
| #2854 | blocked-model redirection | `config.ts`, `lib/shadow-call.ts`, `router.ts`, `types/config.ts` |

## Overlap matrix

Computed by intersecting the `src/` file sets, not by reading titles:

```
#1756 x #2827   src/server/index.ts
#2050 x #2854   src/router.ts, src/types/config.ts
#2364 x #2712   src/config.ts, src/server/auth-cors.ts, src/types/provider.ts
#2364 x #2854   src/config.ts
#2712 x #2854   src/config.ts
```

Collision degree per PR: `#2854=3`, `#2364=2`, `#2712=2`, `#1756=1`, `#2050=1`,
`#2827=1`, `#2365=0`, `#2429=0`.

## Derived merge order

Ascending collision degree, so each merge lands against the largest possible amount of
already-settled `dev`, and the diff most likely to conflict resolves last against a tree
that already contains everything it must coexist with:

```
#2365 -> #2429 -> #1756 -> #2050 -> #2827 -> #2364 -> #2712 -> #2854
```

`#2854` merging last is the load-bearing part of this order. It touches `config.ts`
alongside both #2364 and #2712, and `router.ts` alongside #2050 — it is the only PR that
collides with more than one other cluster, so it is the only one whose conflicts are
cheaper to resolve once rather than three times.

Waves, because `dev` CI is the gate and a wave is the smallest useful unit to verify:

- **Wave A** — `#2365`, `#2429`, `#1756`: zero or single collisions, no shared config surface.
- **Wave B** — `#2050`, `#2827`: single collisions each.
- **Wave C** — `#2364`, `#2712`, `#2854`: the `config.ts` / `auth-cors.ts` cluster.

**Corrected after audit.** An earlier draft claimed wave B's collisions were "already
settled by wave A". They are not: `#2050` collides with `#2854`, which is in wave C, and
`#2827` collides with `#1756` in wave A. Only `#2827`'s is settled by A. `#2050` is placed
in B because its one collision partner merges later, so `#2854` absorbs the resolution —
which is the same reason `#2854` is last.

## Per-merge mechanics (added after audit)

Merge order alone does not make a later PR land against settled `dev`; it only decides who
resolves the conflict. All eight heads currently share merge base `e546c160b`, and `dev` is
already five commits past it, so each merge must carry its own freshness step:

1. Rebase the PR onto the then-current `dev`.
2. Push and let CI run on that exact head.
3. Merge only on a green technical matrix.
4. Re-read `dev` CI before starting the next merge.

Skipping step 1 would also drift heads past the repository's ten-commit readiness
allowance as the train advances, so the freshness step is a gate requirement and not only
a correctness preference.

#2429 and #2827 cannot enter their wave until the two designs below are built.

## What this unit does not cover

Five rebased PRs are excluded because CI found real defects in them, not stale-base
artifacts: #2716 (display name leaks into the opencode selector), #2351 (management route
not declared in the registry), #2213 (xAI wire defaults), #2496 (residual failures), and
#1829 (macOS launcher flake, unrelated to its own diff). They stay open.
