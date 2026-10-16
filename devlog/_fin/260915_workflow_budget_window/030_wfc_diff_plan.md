# 030 — wfc: the diff

Written after reading the code rather than from the sketch in 020, because two of
that sketch's assumptions turned out to be wrong.

## What the investigation changed

**The refusal never reaches the request log at all.** `runAdmittedHttpTurn`
returns `formatErrorResponse(429, ...)` before it calls `work()`, and every
`addFinalRequestLog` call in that file is inside `work`. There is no
`logCtx` at that point and nothing to mark. 020 assumed the row existed and
only lacked a field.

**The ceiling name does not survive onto the wire.** `formatErrorResponse`
runs `classifyError`, which rewrites any 429 to
`{ type: "rate_limit_error", code: "rate_limit_exceeded" }`. The
`workflow_budget_exhausted` string passed at the call site is discarded. So the
body an operator sees today is byte-identical in shape to a provider rate limit,
and the message is the only field that can carry anything.

That also means the message is wrong for three of the four denials: all four
reasons emit one sentence about a "concurrent-work limit", and only
`workflow-concurrency-exhausted` is actually that.

## The change

**Name the ceiling where the operator will read it.** Each `WorkflowDenial`
gets its own sentence, stating which ceiling fired and that this proxy made the
decision without contacting a provider. The wire status and type stay exactly as
they are — a client's retry behaviour must not change — so a response header
`x-opencodex-local-refusal: <reason>` carries the machine-readable name
alongside. An upstream 429 never sets it, which is the distinction 020 asked for.

**Record the refusal where the request log cannot go.** A refusal that parsed no
body, chose no model and contacted no provider is not a usage row, and forcing
one would put a fabricated model and provider into `usage.jsonl`. Instead
`src/lib/workflow-budget.ts` keeps a bounded ring of recent budget events —
every refusal and every operator clear, with the root, the ceiling, the counts at
the time and a timestamp. Every entry in it is by construction a local decision,
which is a stronger guarantee than a flag on a shared row.

Where a `logCtx` does exist — the pre-dispatch ceiling check in
`src/server/responses/core.ts` — the refusal additionally goes through
`markLocalRequestLogRefusal`, the same helper #4639 introduced, so the row that
does get written says `terminalSource: "synthetic"`.

**Expose and clear.** A new management module serves
`GET /api/workflow-budget` (tracked roots, or one root with `?root=`, plus the
recent events) and `POST /api/workflow-budget/clear` with `{ "root": "<id>" }`.

The clear is bounded in a specific way: it resets the windowed send ring and the
child map, and it touches neither `active` nor the spend ledger. Clearing a
*count* ceiling must not clear *spend* — a token budget the operator did not ask
to forgive, and an active lease count that belongs to turns still in flight.
The clear is written into the same event ring, so it is on the record next to the
refusals it answers.

## Files

- `src/lib/workflow-budget.ts` — `workflowDenialSummary`, a bounded event ring
  (`recordWorkflowBudgetEvent`, `listWorkflowBudgetEvents`),
  `listTrackedWorkflowRoots`, and `clearWorkflowBudgetForRoot`.
- `src/server/index.ts` — per-reason message, the local-refusal header, and the
  event record in `runAdmittedHttpTurn`.
- `src/server/responses/core.ts` — the same for the pre-dispatch ceiling check,
  plus `markLocalRequestLogRefusal` where the log context exists.
- `src/server/management/workflow-budget-routes.ts` — the two endpoints.
- `src/server/management-api.ts` — lazy `OnDemand` wrapper and dispatch entry.
- `src/server/management/route-registry.ts` — the two inventory entries.
- `tests/lib/workflow-budget.test.ts` — clear is scoped and recorded; the event
  ring is bounded.
- `tests/server/management-workflow-budget-routes.test.ts` — both endpoints, and
  that a data-plane key cannot reach the clear.
- `scripts/test-layout/layout.json` and
  `tests/fixtures/test-layout-expected.json` — the new test file, registered in
  both as the layout guard requires.

## Acceptance

1. Each of the four denials produces a message naming its own ceiling, and the
   response carries `x-opencodex-local-refusal` with the machine-readable name.
2. Every refusal and every clear lands in the bounded event ring; the
   `core.ts` path additionally marks its request-log row synthetic.
3. `GET /api/workflow-budget` reads one root, and
   `POST /api/workflow-budget/clear` clears exactly that root.
4. The clear leaves `active` and the spend ledger untouched, is recorded, and is
   refused for a caller that only holds a data-plane key.

## Owed, and not in this work-phase

`GET /api/workflow-budget` and `POST /api/workflow-budget/clear` are owed CLI
verbs. An operator looking at a 429 is usually already in a terminal, and the
ledger is process memory, so unlike the Lab routes there is no local SQLite
projection the CLI could read instead — the verb has to be an HTTP call. Both are
declared `deferred-verb` in the route registry against this document, which is
what keeps them out of the undeclared-route ratchet without pretending the gap
does not exist.

## Verification posture

Local suite, typecheck, install and build: NOT RUN, by standing instruction.
Hosted CI at the exact final head is the only proof. Pushed with `--no-verify`.
