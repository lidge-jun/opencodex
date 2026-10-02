# Policy Candidate Fallback

`src/server/responses/policy-request-scope.ts` retains the first policy evaluation's complete
eligible provider/model membership and decision throughout Responses preparation and fallback.
Subagent selection and encrypted-task recovery keep that membership; a replacement outside it is
refused before dispatch, and policy fallback may continue with another originally eligible candidate.
A shadow-intercept target is probed without that capture and is captured only once interception is
accepted, so a declined policy target never scopes the request's own route.
`src/server/responses/policy-fallback.ts` inspects and executes each retry as a concrete candidate,
so a public combo or profile alias cannot reselect its destination. Redirects remain inside the
original evaluation, including eligible destinations omitted from the bounded diagnostic trace.

Normal virtual-model wire mapping remains attached to its admitted selector and does not add a new
eligible model. Policy traversal records settled physical destinations and skips a destination already
attempted through another candidate or redirect; same-target credential and transient retries retain
their existing budgets. Local skips preserve the last upstream failure and its log context, including
route identity, usage, active attempt and spend tracker; preparation-only fields are discarded.
Completed physical attempt rows remain intact, and final logging settles the last actual send's usage.
The initial decision remains the selection evidence while physical attempts record execution.

Cancellation, non-replayable responses and committed output keep the
[shared replay boundaries](responses-failover.md). A local policy refusal is identified by its
in-process response identity; matching upstream prose or error codes cannot authorize another attempt.

Coverage: `tests/routing/routing-policy-dispatch-scope.test.ts` exercises real request preparation,
normalization and configured subagent selection with synthetic dispatch. It also covers recovery,
alias collisions, redirects, bounded traces and virtual models. `tests/routing/routing-policy-fallback.test.ts`
pins request snapshots, terminal responses, cancellation, credential handoff and attempt accounting.
