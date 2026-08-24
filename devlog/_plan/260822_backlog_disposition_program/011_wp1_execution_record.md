# 011 — WP1 execution record: four merged, one held

Work-phase 1 closed with **four of five** PRs on `origin/dev` and one held on
reproduced test evidence.

## Merged

| PR | Author | Merge commit | Review verdict |
|----|--------|--------------|----------------|
| #2309 kiro parallel permission | `Ingwannu` | `b96af222b` | PASS |
| #2339 google signature order | `luvs01` | `f26c7b5d2` | PASS |
| #2335 tool-choice linear time | `luvs01` | `25324f839` | GO-WITH-FIXES (blockers=0) |
| #2313 reasoning replay scoping | `olddonkey` | `f96d9efd2` | PASS |
| (wp0 roadmap, PR #2369) | — | `5921c20df` | docs-only |

Each was reviewed by an independent read-only lane on `openrouter/stealth-ox-alpha`
at high reasoning effort. Two lanes produced **falsifiable** regression evidence rather
than diff-reading:

- **#2339**: reverting only the `src/adapters/google.ts` hunk makes exactly one test
  fail — `streaming signatures only attach to function calls that follow them in the
  same frame`, expected `[undefined, SIGNATURE]`, received `[SIGNATURE, ...]`.
- **#2313**: five separate mutations of the fix each turn the suite red, including
  dropping the serving identity from the memo key (the exact cross-conversation
  leakage shape), which fails 2 tests. A baseline diff proves all 11 new integration
  tests are genuinely new coverage, none tautological.
- **#2335**: the perf test was adversarially falsified before being trusted — the old
  path produces ~65k proxy catalog reads at n=256 versus 512 for the new one, so the
  `size * 2` bound genuinely discriminates O(n²) from O(n).

## Held: #2359

The review lane returned **FAIL**, and the main agent reproduced it independently on
the merged tree:

```
$ bun test tests/provider-live-models.test.ts
(fail) opencode-free live discovery exposes big-pickle plus -free ids
  [ "big-pickle", - "deepseek-v4-flash-free", "hy3-free", ... ]
  at tests/provider-live-models.test.ts:163
 7 pass, 1 fail
```

A live probe of `GET https://opencode.ai/zen/v1/models` shows
`deepseek-v4-flash-free` is **still advertised**, so excluding it hides a model the
gateway is currently serving. This is the same error class the author already
self-corrected once inside this PR: `d587a4b4` added `opencode-go/grok-4.6` to the
exclusion set and `e5c83067` retracted it after finding grok-4.6 live.

Evidence posted to the PR (comment `5379495549`) with the failing assertion, the live
probe, the author's own precedent, and two non-blocking follow-ups. The two
`opencode-go` exclusions in the same PR are correct and land as soon as the Zen entry
is resolved.

## Correction to `001`: `dev` IS protected

`001` recorded "dev protection = 404 not protected" from
`GET /repos/.../branches/dev/protection`. That endpoint reports only **classic branch
protection**. The push was rejected:

```
remote: - Changes must be made through a pull request.
 ! [remote rejected]     dev -> dev (push declined due to repository rule violations)
```

`GET /repos/lidge-jun/opencodex/rulesets` shows four **active rulesets**, and
`GET /repos/.../rules/branches/dev` shows `deletion`, `non_fast_forward`, and
`pull_request` rules from ruleset `20763889` ("Protect dev"). Every later work-phase
lands through a pull request with admin merge — which is also better practice, since it
closes each PR and credits its author. The repository's security configuration was not
weakened to force a direct push.

## Incident: a reset dropped an unpushed commit

While preparing the merge I ran `git reset --hard origin/dev` on the shared checkout,
which discarded the unpushed wp0 devlog commit `eb3c97476`. Detected immediately with
`git merge-base --is-ancestor` (returned LOST), confirmed the object still existed via
`git cat-file -t`, and restored all 12 documents by cherry-pick (`d2f0aab86`, finally
`d374bb893` on the PR branch). No work was lost.

The lesson is recorded rather than quietly fixed: a `--hard` reset on a shared checkout
carrying unpushed work is exactly the destructive-command class that deserves a
reachability check *before* it runs, not after.

## Verification

Local, focused only — full suites are not run on this machine:

```
bun x tsc --noEmit                      TSC=0
bun test <9 suites covering every changed file>
                                        339 pass / 0 fail / 1578 expect()
```

Suites: `kiro-adapter`, `google-signature-history-roundtrip`,
`tool-choice-performance`, `types-barrel-identity`, `reasoning-replay-identity`,
`request-log-conversation`, `responses-opaque-blob-recovery`,
`provider-live-models`, `codex-catalog`.

The full suite runs on remote host `lidge` against the merged head `5921c20df` as a
trailing job, observed rather than blocking; its result and the exact-head CI check are
recorded at the end of the program, not per phase.

