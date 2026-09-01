# wp1 — Regression audit of the promotion delta

## Question this phase answers

Does `origin/main...origin/dev` contain anything a 2.38.0 user would experience as
breakage? Green CI is necessary and not sufficient: the suite proves the tests that exist
still pass, not that a behavior change is safe.

## Method

Five read-only `gpt-5.6-sol` lanes at `high` effort, dispatched in parallel with disjoint
file scopes so no two lanes audit the same diff.

| Lane | Scope | Focus commits |
|------|-------|---------------|
| A | `src/responses/`, `src/server/responses/`, `src/router.ts`, `src/routing/`, `src/adapters/`, `src/vision/` | `9af3a7beb` modalities image input, `e9d198a3c` private-metadata strip, `5c0c13194` unreadable MESSAGE reply, `a0d386b49` web_search_call query, `5f0b39048` spill byte cap, `42ad9c44d` burst window, `b46164e78` dated-variant fold, `a3656a92c` cursor eof retry |
| B | `src/oauth/`, `src/codex/`, `src/config/` | the eight-commit Anthropic refresh-intent stack, `a73a4c998` WHAM-401 refresh-before-quarantine, `6123be31f` session_meta by thread id |
| C | `src/cli/`, `src/service.ts`, `src/update/`, `src/lib/` | `0ef04e640` start-shadowing, `330470e74` typed stop outcome, `91b2c4e19` terminal conflict resolve, `71bd7bec6` version bump |
| D | `gui/`, `docs-site/` | `0db8066c0` logs filter, `b6e53d8eb` restore focus, the brand-mark series, `2a90cdaa9` conflicted-config overwrite |
| E | `.github/workflows/` + npm/CI forensics | the stale preview tag and the exact dispatch shape |

Lane A owns the riskiest surface. The dated-variant fold now folds in both directions and
at both widths — a mis-fold there collides two model ids and routes a request to the wrong
model, which no test would necessarily catch. The spill byte cap introduces eviction into
a directory an in-flight response reads from; eviction that outruns a reader loses response
bytes. The burst-window change converts an `unknown` into an `exhausted`, and a false
`exhausted` parks a healthy provider.

Lane B owns the highest-consequence surface. Eight commits reshape when the Anthropic
refresh-intent marker is written, preserved, and cleared. The failure mode that matters is
not a crash: it is a valid credential deleted or masked, so the user is silently logged out
and must re-auth. `a41b7995c` (adopt newer disk credentials before cleanup) and
`e476acd43` (keep post-commit cleanup from masking a durable credential) are the two
commits whose interaction decides this.

Lane C also produces a mechanical determination the release depends on: whether the
Service lifecycle gate is armed. Answer already measured — it is.

## Acceptance

Every lane returns `VERDICT: PASS` or `VERDICT: FAIL` with per-finding severity and
file:line citations. Blocker findings are independently verified against the source
before they change the plan; a lane's assertion is a hypothesis until the main session
reads the same lines. A confirmed blocker becomes a new work phase ahead of wp2 and the
promotion waits.

## What would make this phase fail honestly

A lane that reports `PASS` with no evidence of what it read is not a pass. A lane that
times out is a failed dispatch, not a silent approval, and gets re-spawned once with the
failure folded into the packet.
