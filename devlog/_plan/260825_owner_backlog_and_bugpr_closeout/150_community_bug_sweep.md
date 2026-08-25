# 150 — community bug sweep

The plan's DONE criterion was zero `lidge-jun` issues and every bug PR terminal. Both were met
partway through. The request behind the plan was broader — no outstanding bugs — so the loop
continued into the `bug`-labelled community backlog rather than stopping at its own inventory.

Sixteen open, three left. Final `dev` at `87179e86a`: 15037 pass / 16 skip / 0 fail, typecheck
and `privacy:scan` green.

## Six were already fixed by this same run

| Issue | Fixed by | Verified |
|---|---|---|
| #2499 Windows catalog-state latency | #2580 (`342911fec7`) | ancestry + 51 pass |
| #2545 Antigravity thought_signature | #2577 (`4d3d2716e`) | ancestry + 150 pass |
| #2210 Cursor stall timeout | `994e5ba87` | ancestry + 252 pass |
| #2156 Muse Spark mid-tool-call | `1a15d6292` + `08cc2ac89` | ancestry + 54 pass |
| #2300 Cursor slowness | #2307 | ancestry + falsification |
| #2509 stale pool account (core) | #2515 | ancestry + falsification |

Each was checked with `git merge-base --is-ancestor` **and** a covering test run before closing.
Closing on a report that something was fixed is how a backlog acquires issues that were never
actually resolved.

## What the sweep found on its own

**#2458 — the reported cause was one layer off.** A 502 on an undeclared `get_video_duration`
tool call looked like a bridge problem. The real defect was that Chat Completions silently
discarded `video_url` (`src/chat/inbound.ts:56`), so the model reasoned about a video it had
never received, and the bridge refused the resulting call. OpenCodex was rejecting a symptom of
its own dropped input.

**#2509 — a second half nobody had noticed.** #2515 fixed selection to preview per candidate
quota scope and #2623 added the entitlement filter, but the encrypted-recovery path got the
scope and not the filter. Same stale-selection class, one layer over.

**#2459 — the health check was the worst part.** A bare npm reinstall under a live proxy leaves
`/healthz` answering 200 while every `/v1/responses` fails. A lying health check is worse than
an honest failure, because every supervisor believes it.

**A load flake, not a defect.** One full-suite failure at exactly 5003 ms — Bun's default 5s
timeout — on a case that starts a real server while its neighbours declare `SERVER_BUDGET_MS`.
It passed 3/3 in isolation on two machines. Fixed as a budget, not chased as a bug.

## Three left open, each for a stated reason

**#2221 — native main token refresh.** The safe-looking half is not separable. A refresh rotates
the grant, `atomicWriteFile` has no compare-and-swap against an external writer, and the Codex
CLI writes the same `auth.json`. Refreshing without a crash-safe publisher can strand the login:
the current behavior fails one request, the naive fix can cost the credential. #2497 proposes a
publisher and is itself held under security review with a rename-before-link crash window. This
needs a designed protocol, not a smaller patch.

**#1527 — Cursor large-context.** Both mechanisms behind the reported symptoms changed: rate
limits are excluded from transport retry, and checkpoint continuation replaced full-history
replay — which was the credible differentiator in the reporter's own proxy-vs-direct comparison.
The residual claim needs a matched live probe, which only the reporter can run.

**#1419 — macOS SIGTRAP.** The reported offsets symbolicate to Bun's own crash handler and
nothing past it; the frames that would name the faulting subsystem are absent, and no upstream
release establishes that 1.4.0 fixes that signature. The runtime is pinned so it cannot regress;
the crash is unproven. Recorded alongside it: `ocx gui` starts an unref'd detached process, so a
native crash there strands the proxy with no supervisor, unlike an installed service.

## The pattern worth keeping

Four of these closed as "already fixed" and three as "not fixable here, here is why". Neither is
a failure to do work. A backlog that only ever accepts code changes as outcomes accumulates
issues nobody can close, and closes issues nobody actually verified.
