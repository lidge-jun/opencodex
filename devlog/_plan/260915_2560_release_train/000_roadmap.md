# 2.56.0 release train — roadmap

Status: open. Opened 2026-09-15.

## What this unit covers

Everything between the `v2.55.0` tip on `main` (`1cc89cf88c`) and the `dev` tip that becomes
2.56.0, plus the release promotion itself. The range is small in commit count and large in blast
radius: three of the seven commits are facade splits of the hottest files in the project
(`bridge.ts` #4672, `server/index.ts` #4675, `server/responses/core.ts` #4677), each landed as a
behaviour-preserving refactor. A refactor that claims to change nothing is exactly the change a
release audit should not take on faith.

## Constraint that shapes the whole unit

No local full suite, typecheck or build. Hosted CI at an exact head SHA is the only accepted
evidence for "this tree passes". Source reading and single focused test files are the local
instruments. Every claim below therefore names either a CI run at a SHA or a specific file read.

## Work phases

| Phase | Doc | Outcome |
| --- | --- | --- |
| wp1 | this file | Roadmap locked; implementation starts in wp2. |
| wp2 | `10_land_4683.md` | #4683 rebased onto the dev tip, CI green at its exact head, squash-merged. |
| wp3 | `20_regression_audit.md` | Every commit in the range audited by a dispatched subagent; findings triaged. |
| wp4 | `30_release.md` | 2.56.0 promoted to `main`, release workflow green, publish verified. |

wp2 and wp3 are independent and run concurrently: the audit reads committed objects, the landing
work touches the working tree. wp4 depends on both.

## Completion criteria

1. #4683 squash-merged into `dev` with Cross-platform CI success at its exact head SHA.
2. Every commit in `v2.55.0..` the post-merge `dev` tip audited, with each REGRESSION or RISK
   finding fixed or explicitly accepted with a stated reason.
3. 2.56.0 on `main` with hosted CI green at the promotion head and a successful publish.
4. No local full suite, typecheck or build was run anywhere in this unit.
