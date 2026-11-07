# Policy Candidate Fallback

`src/server/responses/policy-request-scope.ts` retains the first policy evaluation's complete
eligible provider/model membership and decision throughout Responses preparation and fallback.
Subagent selection and encrypted-task recovery keep that membership; a replacement outside it is
refused before dispatch, and policy fallback may continue with another originally eligible candidate.
A shadow-intercept target is probed without that capture and is captured only once interception is
accepted, so a declined policy target never scopes the request's own route.
The outer wrapper snapshots the original wire body of any request whose model a configured shadow
intercept can rewrite: interception runs after that snapshot, so a routing-profile target selected
by interception keeps the same candidate traversal and exhausted-refusal 400 a direct policy
request has. A retried candidate replays the pre-interception body under the concrete candidate
selector and carries the interception's helper isolation and suppressed label through
`shadowCallIntercepted`.
`src/server/responses/policy-fallback.ts` inspects and executes each retry as a concrete candidate,
so a public combo or profile alias cannot reselect its destination. Redirects remain inside the
original evaluation, including eligible destinations omitted from the bounded diagnostic trace.
The outer retry owner captures caller admission policy before its first attempt when ingress has not
already supplied it. Every candidate receives that same immutable Advisor policy snapshot.

When a main-account hard-lock fallback selects a profile, `src/server/responses/request-prepare.ts`
checks its first ranked destination against the original model under the
[fallback policy](../fallback-policy.md#sites), before authentication or upstream dispatch.

After final normalization, preparation refuses a Chat destination that cannot preserve a mandatory
tool choice using `MandatoryToolChoiceUnavailableError`. The local response identity allows traversal
to a compatible originally eligible candidate without sending to the incompatible destination.
Ordinary direct routes keep the client-facing 400; upstream errors do not acquire this identity.
Non-forward Copilot routes defer this check until Auto negotiation settles the adapter and model.
`src/server/responses/request-transport.ts` repeats the check after every negotiation, including
credential and session renewal; a static Responses route cannot silently become incompatible Chat.
Copilot stages its provider/model until negotiation, scope and mandatory-tool checks pass. `src/server/responses/request-spend-target.ts` supplies the accepted candidate's identity to spend admission without overwriting physical attribution, and clears that binding for each new transport preparation. Only a physical send publishes the candidate's account/model/adapter to its log; account, model or wire changes seal the previous attempt before applying the new identity. Admitted roster identity still funds only ingress-owned budgets before the first send. Persisted refreshes, manual selection and paused-account fences remain authoritative.
Policy and combo children carry the local refusal identity; direct requests retain the same 400.
Direct and exhausted-policy tool refusals carry proxy-error provenance without a Copilot account-error presentation, so Chat and Messages retain the local diagnostic.
Auto-pause credential refresh maps the same typed refusal before returning from recovery, while its
unused hop reservation is released. Adapter and native Responses error delivery carry that identity
through response rebuilding so policy traversal also works after a mid-dispatch renegotiation.
Every refresh exception cancels its original response and releases the exchange's abort linkage;
caller cancellation uses the selected effective signal and is captured before cleanup aborts the upstream, so cleanup or an unused request signal cannot manufacture it.
Queued Copilot refusals consume no physical-send budget or attempt count. Initial, recovery and continuation reporters settle at the HTTP executor; the Copilot attempt note follows spend admission through the physical-send observer. Other OAuth runTurn notes and forward/Codex receipt paths keep their existing owners. Single-use recovery reservations reject a second dispatch before another count is recorded.

Normal virtual-model wire mapping remains attached to its admitted selector and does not add a new
eligible model. Policy traversal records settled physical destinations and skips a destination already
attempted through another candidate or redirect; same-target credential and transient retries retain
their existing budgets. Local skips preserve the last upstream failure and its log context, including
route identity, usage, active attempt and spend tracker; preparation-only fields are discarded.
A refusal minted only after a physical send — a re-negotiated destination refused inside
credential recovery — is a dispatched candidate instead: the hop it was sent on commits and
that sent destination becomes the next hop's source for the fallback guard.
Completed physical attempt rows remain intact, and final logging settles the last actual send's usage.
The initial decision remains the selection evidence while physical attempts record execution.
When every observed refusal is specifically a mandatory-tool incompatibility, exhausted policy traversal returns the direct 400 diagnostic. Generic local skips and upstream failures permanently exclude that projection; cancellation and replay boundaries retain precedence. Discarded local bodies and replaced upstream failure bodies are cancelled to settle their lifetime owners; a refused fallback guard also cancels the retained failure.

Cancellation, non-replayable responses and committed output keep the
[shared replay boundaries](responses-failover.md). A local policy refusal is identified by its
in-process response identity; matching upstream prose or error codes cannot authorize another attempt.
The translator-budget and account-lease wrappers in `src/server/responses/core-lifetime.ts` carry
that identity from their source response without deriving it from serialized error contents.
`src/server/responses/core-combo-failure.ts` carries it when rebuilding a consumed failure, so the
combo can skip that local candidate while copied upstream bytes remain ordinary failures.
Formatted quota errors retain [their upstream-code provenance](responses-combo-boundaries.md#upstream-account-quota-exhaustion-failover)
through lifecycle wrappers; a reflected quota message on a 400/422 response does not authorize a
candidate hop merely because formatting serialized it as `insufficient_quota` or its text mentions a free-tier single-request cap.

Coverage: `tests/routing/routing-policy-dispatch-scope.test.ts` exercises real request preparation,
normalization and configured subagent selection with synthetic dispatch. It also covers recovery,
alias collisions, redirects, bounded traces and virtual models. `tests/routing/routing-policy-fallback.test.ts`
pins request snapshots, terminal responses, cancellation, credential handoff and attempt accounting.
It also covers shadow-intercepted policy routes: candidate traversal, upstream failover, exhaustion
to the client-facing 400, and isolation carry onto the retried candidate.
`tests/responses/responses-direct-chat-tool-choice.test.ts` exercises the real endpoint's pre-send
Chat refusal, unchanged hosted/MCP selectors and tool declarations, and native MCP output on Responses fallback.
It also runs a shadow-intercepted request through the real endpoint to a compatible policy candidate.
`tests/adapters/translator-budget-lifetime.test.ts` distinguishes a local refusal from identical
upstream wire bytes through both lifetime wrappers followed by combo failure rebuilding, including the tool-specific identity and exactly-once release of leases and translator accounting.
