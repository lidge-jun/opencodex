# 120 — Per-issue verdicts

All 45 issues open at campaign start, classified by three independent analysts
working disjoint batches. Every verdict carries a `file:line` or commit
citation; "no landing found" verdicts name the searches performed.

## Closed as implemented

| Issue | Reporter | Implementation |
|---|---|---|
| #1572 | @brunoflma | `src/server/responses/policy-fallback.ts`, cd7ea8a88 + 457c33675 |
| #2288 | @mobaicloud | `src/client/connect.ts`, 91a4f6c40 |
| #3158 | @lidge-jun | eceb02d9d + 0d8147c20 |

## Closed into consolidated issues

| Issue | Reporter | Absorbed by | What was still missing |
|---|---|---|---|
| #695 | @luwei1990 | #3375 | session affinity, 401/403 rotation, health lifecycle |
| #1062 | @agentHits | #3375 | aggregate pool health, account-attributed usage |
| #1977 | @dbc-hbin | #3375 | durable one-shot warmup scheduling |
| #2275 | @luvs01 | #3375 | caller-stable operation id on the manual endpoint |
| #2344 | @Michael-Han0608 | #3376 | quota history retention |
| #2874 | @wonny-log | #3376 | reset-window pool ordering |
| #2969 | @terrytan95 | #3376 | reset-driven window activation (PR #2973 open) |
| #3268 | @turin-dev | #3377 | text-only model declaration |
| #3271 | @GoldenLoaf24h | #3377 | video processing mode passthrough |
| #3281 | @Simon-Opopeee | #3377 | context tier selection (PR #3282 open) |
| #3344 | @colthreepv | #3378 | `x-opencode-session` header |
| #3362 | @0disoft | #3378 | `indexed_web_access` sanitization |
| #2399 | @ncepuee | #3379 | journal entry deletion |
| #2748 | @areskts | #3379 | custom date/hour usage ranges |
| #3017 | @hayabusasxs | #3379 | account selector rename API |

Where an absorbed issue has an open implementation PR (#2973, #3282), the
closure comment says explicitly that the PR is not superseded.

## Left open — still valid, unimplemented

#95, #1213, #1416, #1533, #1711, #2279, #2358, #2455, #2495, #2511, #2730,
#2811, #2834, #2894, #3191, #3259, #3266, #3352, #3353, #3366 and the
needs-info set below. Each was verified against current `dev` rather than
assumed: for example #2894 (SOCKS5) is unimplemented because
`src/types/config.ts` defines only a global HTTP(S) proxy with no per-provider
override and no scheme validation.

## Left open — blocked on the reporter

#1527, #1782, #1811, #3245, #3255, #3279, #3320.

These were **not** closed. Each received a comment stating where the code
stands and naming the single artifact that would unblock it — a redacted
`UserId` element, a current reproduction, a failing request URL. Closing a
report because its author has not replied yet is how a project stops receiving
reports, and several of these are plausible defects whose evidence simply has
not arrived.

## Note on partial verdicts

Eleven issues were PARTIAL and eleven were closed, but several other PARTIAL
findings (#95, #1213, #1533, #2358, #2455, #2511, #2811, #2834, #3191, #3353)
were left open instead. The difference is whether the remainder belongs to a
cluster: a partial whose surviving scope stands alone stays as its own issue,
because folding a single coherent request into a consolidated one loses detail
without reducing count.
