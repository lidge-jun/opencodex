# 260915 — the root workflow budget outlives the task it was sized for

## What happened

A Codex session spent several hours dispatching subagents. Every dispatch failed,
across three unrelated providers, with a 429 that reads as a provider rate limit.
The obvious readings were all wrong: not the model, not the account, not the
upstream. The refusal came from this proxy.

The reproduction is one line. With the same request body, a probe carrying the
long-running session id in `x-codex-parent-thread-id` was refused, and a probe
carrying a freshly invented root id was served. Restarting the proxy served both.
That is the whole diagnosis: the ceiling is per root, held in process memory, and
the session had reached it.

## Why the ceiling fired

`DEFAULT_WORKFLOW_BUDGET_POLICY` (`src/lib/workflow-budget.ts`) caps a root at 256
physical sends and 64 distinct children. `workflowSendCeilingReached` compares
`state.sends >= policy.maxPhysicalSends`, and `state.sends` is **cumulative for the
life of the process**. The root id is `x-codex-parent-thread-id`, which for Codex is
the session. So the cap is not a fan-out guard on a long session; it is an expiry.

The comment that justifies it says a per-request cap "cannot bound a fan-out that
sends once per child seven hundred times". That is a **burst** concern, and a burst
is bounded by a rate. A lifetime total cannot tell seven hundred sends in a minute
from two hundred and fifty-six sends spread over four hours, and it refuses both.
The second one is ordinary work.

Two things made it expensive to diagnose rather than merely annoying. The refusal
is a 429 that an operator reads as an upstream rate limit, so the first hours went
to providers and accounts. And there is no way out except restarting the proxy:
`resetWorkflowBudgetsForTest` exists, the name says who it is for, and
`workflowBudgetSnapshot` is never exposed, so the state that decided the refusal is
invisible from outside the process.

## The rule

> A root budget bounds a **rate**, and says so. A ceiling that fires is a local
> decision an operator can see, name and clear without restarting the proxy.

## Roadmap

| Doc | Work phase | Outcome |
| --- | --- | --- |
| `010_windowed_ceilings.md` | wfb | Sends and distinct children are counted over a bounded window, so a long session is never refused for work it did hours ago while a burst inside one window still is |
| `020_legible_refusal.md` | wfc | The refusal names the ceiling that fired, is marked as a proxy decision rather than an upstream one, and the root budget can be read and cleared through the management API |

## Write scope

Permitted: `src/lib/workflow-budget.ts`, the workflow call sites in
`src/server/responses/core.ts` and `src/server/index.ts`, the management read and
mutation surface under `src/server/management/`, `src/server/request-log.ts` for the
refusal provenance, their tests, and this unit.

## Verification posture

Local suite, typecheck, install and GUI build are **not run** for this unit by
explicit instruction. Proof is hosted CI at the exact final head SHA and nothing
else. Pushes use `--no-verify`.

## What would make this fail

Raising the numbers instead of fixing the shape. A bigger lifetime total is the
same defect further away: it still refuses a session for work it finished hours
ago, and it still cannot be seen or cleared. The window is the change; the numbers
are a consequence of it.


## Reproducing it

Both probes carry the same body and differ only in the root id. Against a proxy
whose process has been up long enough for a session to reach the ceiling:

```bash
BODY='{"model":"gpt-5.6-terra","input":[{"role":"user","content":[{"type":"input_text","text":"ok"}]}],"max_output_tokens":16,"stream":true}'

# the long-running session's own root: refused
curl -s -o /dev/null -w '%{http_code}\n' -N -X POST http://127.0.0.1:10100/v1/responses \
  -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
  -H "x-codex-parent-thread-id: <that session id>" -d "$BODY"

# any root the process has not seen: served
curl -s -o /dev/null -w '%{http_code}\n' -N -X POST http://127.0.0.1:10100/v1/responses \
  -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
  -H "x-codex-parent-thread-id: probe-$(date +%s)" -d "$BODY"
```

Two answers from one proxy, one body and one upstream, separated only by which
root the request claims. That is what rules out the provider, the account and the
model in a single step, and it is the check to run first the next time a fan-out
starts failing for no visible reason.

After a restart both return 200, which is the other half of the diagnosis: the
ceiling is process-memory only, so the evidence disappears the moment anyone tries
the obvious remedy.

