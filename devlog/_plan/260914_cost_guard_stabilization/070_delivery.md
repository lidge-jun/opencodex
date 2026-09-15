# 070 — wp7: delivery

## Shape

wp2 and wp3 ship together as one pull request against `dev`: they are one policy —
hold a live binding for cache, release it only on real evidence — and splitting
them would land a default flip whose main remaining hole is still open. wp4, wp5
and wp6 follow as separate pull requests, each independently revertible.

## Verification

Local suite, typecheck, install and GUI build are not run, by explicit instruction.
The pull request states that plainly in its Verification section. The only proof is
hosted CI at the exact final head SHA; a green run against an earlier commit is not
evidence for the head that gets merged.

Pushes use `--no-verify`. Merges into `dev` are squash merges under the
single-maintainer dev integration policy in `MAINTAINERS.md`, with the merge
commit and the exact-head CI run recorded.

## Issue linkage

`Closes #4546` for the pull request carrying wp2 and wp3. Because pull requests
here target `dev` rather than the default branch, GitHub will not auto-close it;
the issue is closed by hand once the change is on `dev`, naming the merge commit.

## Documentation

The configuration reference and every locale translation change in the same pull
request as the behaviour, because a default documented in eight languages is wrong
in eight languages the moment the code lands. `structure/` ownership docs for the
affected invariants change with them.

## 2.55.0 release record

| field | value |
| --- | --- |
| product snapshot | `62f02223a0` on `dev` |
| preview SHA | `7bdd1b29b5` (`2.55.0-preview.20260914`) |
| stable SHA | `1cc89cf88c` (`2.55.0`) |
| dev next | `2.56.0` (#4618) |
| preview push CI | run 34833399886, success |
| preview service lifecycle | run 34833399853, success |
| preview dry-run / publish | 34834321705 / 34834502951, both success |
| main push CI | run 34835022788, success |
| main service lifecycle | run 34835022762, success |
| main dry-run / publish | 34836327017 / 34836498588, both success |
| registry: preview | verified, `registry.npmjs.org/@bitkyc08%2Fopencodex/2.55.0-preview.20260914` returns 200 |
| registry: stable | **pending** -- the version endpoint still returns 404 |

The preview and stable trees are byte-identical apart from `package.json.version`;
`git diff origin/preview origin/main -- . ':!package.json'` is empty.

**The stable registry line is the honest part.** The publish job reported success, its
post-publish registry smoke passed on the runner, and the `v2.55.0` tag and GitHub Release point
at `1cc89cf88c`. Fifteen minutes later the registry version endpoint still answers 404 and
`dist-tags.latest` still reads `2.54.0`, while the preview published minutes earlier answers 200.
So the receipt exists and availability is unconfirmed, which is `registryVerification: pending` --
not a missing package. Do not re-run the publish: a second dispatch against the same version is
the failure mode the bounded-read path exists to prevent. Recover the observation, then announce.

What this release does not claim: the PRD's RG2 set is not complete. The durable cross-restart
reservation ledger, V2 child first placement, the minimum quota/cache domain contract, the
transient half-open probe lease, combo hops on the shared budget, Cursor's inner retries and the
sends-per-logical-request surfacing all remain open, so #4546 stays open too.
