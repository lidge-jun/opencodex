# 260910 post-2.49 round 2 — two-lane stacked delivery

## Context

Round 1 (`devlog/_plan/260909_post249_scope_cleanup/`) landed 17 PRs and closed
16 issues; `origin/dev` closed at `cd813d3d9`. Three issues were left open by
decision: #3978 (deferred until the compaction status contract settles), #3506
(direction comment only — translation fidelity, not a proxy-side progress
cutoff), #2495 (feasibility study says it needs its own cycle).

The user chose **two lanes instead of eight**: two managed worktrees, each
publishing a stack of PRs on `dev`, merged under main-session control.

## Scope

Nine deliverables: eight issues plus one contributor PR to land.

| Lane | Order | Issue | One line |
|---|---|---|---|
| A | 1 | #4129 | shadowCallIntercept on a combo runs one attempt, never enters the failover loop |
| A | 2 | #4148 | mid-conversation Claude `role: system` messages are hoisted into `instructions`, breaking the cache prefix |
| A | 3 | #4141 | after `ocx update` the launchd job never comes back (legacy `unload`, strict load-failure check) |
| B | 1 | #3666 | no way to filter free models in the Dashboard catalog |
| B | 2 | #4075 | "model sync failed" does not explain the model-discovery dependency |
| B | 3 | #3859 | stored account emails are unconditionally masked, with no operator opt-out |
| B | 4 | #1711 | zero-credit models/combos are still offered as selectable catalog entries |
| B | 5 | #4038 | Logs conflates first-token latency with delivery speed; no decode-rate metric |
| — | — | #4147 | contributor PR #4153 already carries the confirmed ZCode schema; review and land it |

## Honest statement of what "no judgment needed" means here

The round-1 selection criterion was "the fix is mechanical and the maintainer
does not have to decide anything". The research pass found that **five of the
eight carry a decision** the maintainer has to own, so the criterion is restated
rather than pretended:

- **Truly mechanical, no fork:** #4129, #3666, #4075. The research reports mark
  no blocking policy choice, and the defaults recorded in each doc are fail-closed
  and obvious.
- **A recorded scope decision, taken in the plan and stated in the PR body:**
  #4148 (all in-messages system messages become developer items, not only the
  mid-conversation ones) and #4141 (auto-`bootout` instead of today's hint-only
  throw — this **kills the live gui job**, which is the intended repair but is a
  product choice, not a mechanical one).
- **Asked the maintainer before the lane starts:** #1711 (a custom catalog field
  cannot grey out the native Codex picker), #4038 (a prior PR for the same metric
  was closed as an unreliable estimate), #3859 (a persisted unmask discloses PII
  on a remote-bound management surface).

The three asked items sit at the **top** of the Lane B stack, so any of them can
be dropped without restacking the rest.

## Out of scope

- The live-proxy incident and `src/service.ts` test isolation: PR #4152 owns that,
  driven by a separate task. No lane may run `ocx service`, `ocx start/stop/restart`,
  `launchctl`, or `systemctl`.
- Live-probe issues: #3782, #3765, #3719, #4143, #4126, #3781, #3775, #3433,
  #3522, #3661, #3506.
- Policy issues needing their own interview: #3630, #2730, #3729, #2511, #3377,
  #4079, #4024, #3417, #3898, #4055, #3705.

## Constraints carried from the user

1. **Never run the local product suite**, `bun test`, `bun install`,
   `bun run typecheck`, `bun run build`, or lint. Exact-head remote CI is the
   only gate. Skipped local checks are labelled NOT RUN in the PR body. This
   overrides the PR-ready gate in `AGENTS.md` for this round.
2. Push with `--no-verify`.
3. A cancelled CI run is never passing evidence.
4. Merge order and rebase timing belong to the main session.
5. Subagents are `xai/grok-4.6` and verify only; lane worker threads run
   `anthropic/claude-opus-5`.
6. No heartbeat automations. The main session polls.

## Terminal outcome

DONE when every delivered issue and #4147 is closed against a merged `dev` commit
with exact-head CI evidence, and `110_delivery_record.md` records the round.
Dropping an asked item on the maintainer's instruction is a recorded decision,
not a failure.
