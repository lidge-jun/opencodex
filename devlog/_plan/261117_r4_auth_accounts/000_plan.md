# R4 auth/accounts lane: triage-to-merge round 2026-11-17

Base: `origin/dev` c36793a9336b70cfe5bc3b7f6e6f751e730fb6fc. Branch: `triage/r4-auth-accounts`. One lane PR to `dev`.
Every item below is already public as a pull request or issue; this note records the triage outcome only.
"Security review" below means the lane's internal independent review; verdicts are reported in the lane PR and the coordinator report.

## Classification

| Item | Class | Evidence | Reason |
|---|---|---|---|
| #8758 anthropic redirect refusal | CARRY | Fork PR: only gate jobs ran, `gates`/`test changed` never ran on head 052e91f32f. Security review PASS-WITH-NITS. | Sound three-line fix; needs repository CI. Carry with a stronger outcome test. |
| #8808 codex native-login identity fence | MERGE-READY (pending 040 check) | `gates` + `test changed` green on head 5a76b97368; `git merge-tree` with dev is clean. Security review PASS-WITH-NITS. | Correct as is; 41 commits behind dev, so 040 runs its focused suite on the merged tree. |
| #8802 vertex discovery destination authority | MERGE-READY (pending 040 check) | `gates` + `test changed` green on head 65db67235d; `git merge-tree` clean (plain `git apply` conflicts, three-way merge resolves). Security review PASS-WITH-NITS. | Correct as is; inference never read `baseUrl`, so only custom-gateway discovery changes. |
| #8806 link explicit-route owner authority | CARRY | Draft. Security review PASS-WITH-NITS. | Sound content; carried as its own commit. |
| #8814 chat dispatch caller restrictions | CARRY | Draft. | One-line guard plus route tests. |
| #8599 claude-cli paid usage | DEFER | Security review: safe, but admits paid extra usage once plan windows are exhausted. | Spend policy is an owner/product decision. |
| #8688 per-model compact windows | DEFER | Maintainer requested author changes 2026-11-15; reviewer found an unbounded `--settings` argv on Windows. | Author-owned revision pending; user-visible launch change outside auth. |
| #8826 CCA first-ban pause | DEFER | Draft, `intake: hygiene-blocked`; reviewers ask for an owner policy decision. | Default account-eligibility change needs an owner decision. |
| issue #8752 | DEFER | Same decision as #8826; appeal URL projection is a separate design. | Owner policy decision. |

## Work-phase map

1. wp1 (this doc set): roadmap only.
2. wp2: `010` carry #8758, `020` carry #8814, `030` carry #8806, one commit each in that order, each with a regression test that fails before the source change.
3. wp3: `040` verify the MERGE-READY pair on the merged tree, run the lane gates, open the lane PR, observe required checks, report.

## Constraints

- Co-authored-by trailer for each carried author; PR body lists `Supersedes #N`.
- Auth surfaces trigger the `unsponsored_surface` hygiene check; `maintainer-sponsored` is the coordinator's call.
- Temporary HOME/OPENCODEX_HOME for every runtime check. Security notes stay in `.tmp/`.

