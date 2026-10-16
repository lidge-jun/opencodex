# 041 — bd4 Batch D landing record: contributor-owned, all four carried

| Original | Rebase PR | Merge SHA | Author |
|---|---|---|---|
| #3138 service wait reporting | #3186 | `ea29e25b05cea7cefabad576e9dfe291e8d5daf0` | ntdatt812 |
| #3164 duplicate restore warning | #3187 | `d335570647ca0360e63745615901a10303042784` | x3M3x |
| #3144 explicit --port sibling | #3188 | `5ccf7c80016eddf66d297288488f1e1fd5022272` | olddonkey |
| #3121 alias overlay seed validation | #3189 | `5557772b7d6d11a560f9f910de350ab7cc855866` | Flowershangfromthebranches |

All four ancestors of `origin/dev`. All four rebased without conflicts.

## `CHANGES_REQUESTED` was stale on every one

The plan's Batch D method offered three outcomes: carry it, leave it for the author's design
judgment, or close it as superseded. In the event, **none of the four had an unresolved
review thread** — a GraphQL query for `isResolved == false` returned empty on all of them.
The badge was left over from review rounds the authors had already answered.

The only thing standing between these four fixes and `dev` was a rebase nobody had run.

## What each fix was

- **#3138** — `ocx service` reported the wait *budget* rather than elapsed time, so a probe
  settling in 2s of a 30s budget still claimed 30s.
- **#3164** — graceful shutdown already did the shared Codex/Grok teardown, then `ocx stop`
  and `ocx update` tried a second resume-history restore, so the warning appeared twice.
  Caller-side restore is preserved for deferred receipts and hard-kill, where the proxy
  never got to do it.
- **#3144** — `ocx start --port <n>` refused whenever a proxy was live, even on a *different*
  port. An explicit different port is an unambiguous request for a sibling. The refusal is
  narrowed, not removed.
- **#3121** — canonical seed validation counted user-owned alias overlays as canonical, so
  an operator with their own alias could no longer save unrelated provider changes.

## Focused verification

| PR | Suites | Result |
|---|---|---|
| #3186 | `service` | 193 pass, 0 fail |
| #3187 | `grok-lifecycle`, `process-control-graceful`, `update-stop-first` | 54 pass, 0 fail |
| #3188 | `cli-dispatch`, `cli-ready` | 91 pass, 0 fail |
| #3189 | `management-provider-validation` | 91 pass, 0 fail |

#3138's author reported 6 `service.test.ts` failures and believed they were pre-existing.
They did not reproduce at all here — that run was macOS, and those six are the
systemd-dependent cases `AGENTS.md` documents as environment-only. The author's read was
right.

## Count

**Open bug-labelled PRs: 0.** All 14 are closed — 4 merged directly, 10 rebase-carried.
Bug-labelled items: **14 → 9**, entirely issues now.

## What the PR half of this campaign actually cost

Fourteen bug PRs. Four merged as they stood. **Ten needed a rebase and nothing else.**

Of those ten, exactly **one** had a genuinely open review finding (#3003's prune ordering,
fixed here with a red-green regression) and exactly **one** hid a real defect behind a
trivial-looking conflict (#3148's connected-target launch path). The other eight were
waiting on a mechanical operation.

That ratio is the argument for the rebase service. A PR that reads `CONFLICTING` or
`CHANGES_REQUESTED` on the board looks like it is blocked on its author. Most of the time
it was blocked on a rebase, and the badge outlived the reason.

The two that were not mechanical are also the argument for running the suite after the
rebase rather than trusting a clean cherry-pick: neither would have shown up in the conflict
markers.

## Remaining: 9 bug issues

#3155 #3152 #3150 #3141 #3136 #2999 #2813 #1527 #1419 — Batch E (needs-info triage) and
Batch F (implementable). The target is 3 or fewer, so at least six of these must reach a
terminal state.
