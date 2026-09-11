# 031 — wp3 live inventory after #3190

Captured after `origin/dev` = `88c427522` (#3190).

| PR | mergeable (live) | review | Disposition |
| --- | --- | --- | --- |
| #3196 | was MERGEABLE before 3190, now UNKNOWN until rebase | REVIEW_REQUIRED | **SURVIVOR** — maintainer carry of #3142, default-off `maxUpstreamBodyBytes`. gates failed only on the 091 home-path citation that #3197 already fixed. Rebase onto current `dev`, exact-head CI, admin merge, then close #3142 with credit. |
| #3142 | CONFLICTING earlier / UNKNOWN now | CHANGES_REQUESTED | CLOSE after #3196 lands (superseded carry). Do not merge both. |
| #3061 | UNKNOWN | CHANGES_REQUESTED | DEFER — parked, macos/ci red |
| #2986 | UNKNOWN | CHANGES_REQUESTED | DEFER — do not merge with #2083 |
| #2877 | UNKNOWN | CHANGES_REQUESTED | DEFER |
| #2805 | UNKNOWN | REVIEW_REQUIRED | DEFER CONFLICTING |
| #2783 | UNKNOWN | CHANGES_REQUESTED | DEFER |
| #2527 | UNKNOWN | CHANGES_REQUESTED | DEFER |
| #2366 | UNKNOWN | CHANGES_REQUESTED | DEFER |
| #2083 | UNKNOWN | APPROVED | DEFER — pair with #2986 |

Filter result: one survivor (#3196). Not a security-boundary PR (Responses body ceiling, opt-in, no auth/credential/workflow/release/dependency install).
