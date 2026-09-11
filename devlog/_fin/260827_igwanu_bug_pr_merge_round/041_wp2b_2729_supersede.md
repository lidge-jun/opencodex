# 041 — #2729 superseded by #2769, and what the blocker actually was

#2729's diagnosis was right and its review was right, and the two facts compose
into something neither states alone.

## The defect #2729 fixed

Internal `response.failed` envelopes carry the classified `{type, code, message}`
but no numeric status, so every classified failure was flattened into a retryable
`overloaded_error`. A Cursor plan/quota 429 reached Claude Code as "Repeated 529
Overloaded errors". Deriving the status from the classified payload is correct.

## The blocker: the derivation only helps if the classification wins

`httpStatusFromTerminalError` recognized a structured server class for exactly one
code pair — `server_error` + `server_is_overloaded` — and let everything else fall
through to message inference. Reproduced against `origin/dev`:

```
{type:"server_error", code:"upstream_server_error",
 message:"upstream stream produced malformed tool call arguments"}  ->  400
```

Claude Code receives `invalid_request_error` and stops retrying a retryable
upstream failure. That is #2729's own inversion, one layer down: it fixed masking
at the envelope boundary while the status function kept masking underneath.

`classifyError` assigns `upstream_server_error` to **every** 5xx it observes, so
the class is authoritative about blame.

## What I got wrong, and what caught it

My first fix returned a blanket 502 for any structured server class. Nine focused
suites passed — 210/0 — and it was still wrong.

Exact-head CI failed `test 1/4` and `test 4/4`. The cause:
`tests/web-search-timeout-contract.test.ts` asserts `status: 504` for a stalled
routed body, because a stall genuinely **is** a gateway timeout. A blanket 502
flattens 504 and 503 into a less specific status, discarding information the log
surface and the retry policy both read.

The classification is authoritative about **blame**, not about which server status
fits. So the override narrowed to the single verdict that both blames the caller
and stops the retry: **400 only**. 429, 499, 401 and 403 are left alone — each is
a signal the caller routes on, and overriding them trades one misreport for
another.

Final differential against `origin/dev` — exactly two cases move:

| case | before | after |
|---|---|---|
| `upstream_server_error` + "malformed" | 400 | **502** |
| `upstream_server_error` + "invalid request" | 400 | **502** |
| web-search stall | 504 | 504 |
| "temporarily unavailable" | 503 | 503 |
| rate-limit text under server class | 429 | 429 |
| client close under server class | 499 | 499 |
| cyber-policy by message | 400 | 400 |
| auth / permission text under server class | 401 / 403 | 401 / 403 |
| real `invalid_request_error` | 400 | 400 |
| `proxy_error` / no message | 500 / 502 | 500 / 502 |

## The transferable finding

**Nine green focused suites did not catch a defect that one CI shard caught
immediately.** The focused suites covered the function I changed; the failure was
in a suite that consumes it. Scoping tests to the changed file is exactly how a
blast-radius defect hides — the previous round's lesson was that green checks are
not health, and this is its sharper form: green *targeted* checks are not health
either, because you chose the targets.

What made it cheap to recover was the differential probe. Enumerating every arm
before and after, against unpatched `dev`, turns "did I break something" from a
hope into a table.

## Evidence

```
remote full suite (ocx-run e2769b on lidge)   15349 pass / 0 fail, rc=0
nine consuming focused suites                  210 pass / 0 fail
bun x tsc --noEmit                             exit 0
mutation oracle (revert fix, keep test)        45 pass / 1 fail
mutation oracle (with fix)                     46 pass / 0 fail
```

One macOS CI failure remains **unattributed**:
`CL-07 task effectiveness producer > inactivity timeout is bounded for trusted
route executors`, a wall-clock test in `src/lab/`. It failed once at `2483f4047`
(15352 pass / 1 fail) and passed on re-run (15353 / 0).

An earlier draft called it pre-existing flakiness on two claims, and the final
auditor disproved both:

- "references nothing in the changed path" — false. The import chain is
  `tests/lab-fabric-task.test.ts` -> `src/lab/index.ts` ->
  `observe/from-conformance.ts` -> `conformance/executor.ts` ->
  `src/claude/outbound.ts` -> `src/lib/errors.ts`. That does not prove causation,
  but it removes the argument I was leaning on.
- "a clean dev merge failed the same day on another macOS timing test" — false.
  `d1def682d` failed on **Linux** `test 2/4`, in `shutdown-launcher.test.ts`.

Neither failure reproduces locally (5/5 and 47/0 at both the PR head and clean
`dev`), so it is not proven a regression either. The honest label is
**unattributed**, and it is recorded that way on purpose: "it was flaky" is the
claim this repository's standing gates exist to distrust, and I reached for it
with two facts that did not hold.

## Then the arm itself turned out not to fire

The final audit also found that #2729's `failed_precondition` branch did not
trigger on the shape it exists to catch. It sat **after** the overload keywords in
both `classifyCursorError` and `inferHttpStatusFromAdapterMessage`, and a
plan-gated rejection normally reads `failed_precondition: model unavailable for
this plan` — which matches `unavailable` first:

```
classifyCursorError            -> "Cursor server overloaded"
inferHttpStatusFromAdapterMessage -> 503
```

So clients retried a deterministic rejection that can never succeed. The original
test covered only `"Cursor Connect error failed_precondition: Error"`, which
carries no competing keyword, and 25/25 passed straight over the defect.

Fixed by moving the check ahead of the overload keywords in both functions: the
explicit gRPC status is a structured backend signal, while `unavailable` and
`temporarily` beside it are inference over free text.

Differential against `origin/dev`: **the whole failed-precondition class moves to
400**, not a single case. Constructible inputs that change:

```
failed_precondition + "unavailable"    503 -> 400
failed_precondition + "temporarily"    503 -> 400
"failed precondition" + "overloaded"   503 -> 400
bare failed_precondition               502 -> 400
```

The non-precondition controls are unchanged: real overload 503, authentication
401, rate limit 429, timeout 504, invalid request 400.

(An earlier draft said "exactly one case moves". That was the sample I happened to
probe, not the size of the change — the correct framing is a class, and describing
a class by one member is how a differential stops being evidence.)

**This is the third time in one PR that a fix was correct in principle and wrong
in precedence** — the envelope masking, my blanket 502, and now this. The pattern
is the same each time: a new rule was added without checking what already ran
before it. A keyword table is an ordered program, not a set.
## The approval gate is not satisfiable here, and that is correct

#2769 cannot be merged by me. GitHub refuses the review outright:

```
failed to create review: GraphQL: Review Can not approve your own pull request
```

The four Ingwannu PRs earlier in this round were approvable because `Ingwannu`
authored them and `lidge-jun` approved — two different maintainers. Here I both
authored the branch and hold the only maintainer session, so `MAINTAINERS.md`
§"Authors do not approve their own pull requests" bites, and it is enforced by
the platform rather than by discipline.

That is the correct outcome. The alternative — a maintainer writing a fix to an
error-classification path and merging it on their own say-so — is exactly what
the rule exists to prevent, and the fact that the fix is well-evidenced does not
change who checked it. The evidence is posted on the PR as a comment so a second
maintainer can act on it.

**Disposition: #2729 CLOSED-SUPERSEDED by #2769; #2769 is NEEDS_HUMAN (non-author
approval).** As of head `16cb875b8`: 211 pass / 0 fail across the ten affected
suites, `tsc` exit 0, mutation oracle held, and the precedence defect above fixed
with its own regression. An earlier draft claimed approval was the *only* missing
gate while that defect was still open — it was not, and the claim is corrected
here rather than quietly dropped.
