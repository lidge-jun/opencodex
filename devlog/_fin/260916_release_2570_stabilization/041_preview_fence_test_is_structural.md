# Follow-up: the preview read-fence test asserts shape, not behaviour

Raised by the third regression audit on the 2.57.0 candidate, deferred past the
release on purpose.

## What the test does today

`tests/responses/responses-preview-main-read-fence.test.ts` reads
`src/server/responses/request-prepare.ts` and `src/codex/auth-context.ts` as
text and asserts with regexes that both native-main read fences carry the
request-owned ownership term, that both preview sites validate ownership the way
`resolveCodexAuthContext` does, that no main exclusion is guarded by drain state
alone, and that `nativeMainSelectionOnly` stays derived from the drain.

It was written that way deliberately, for the reason recorded in its own header:
driving the divergence end to end needs a `thread_spawn` whose caller bearer is
forwardable, an account-gated candidate model, and a denial cache whose only
entry is main. The sibling contract in
`tests/routing/subagent-fallback-preview-sites.test.ts` made the same call for
the same subsystem.

## Why that is not sufficient

A structural assertion catches the regression that has actually recurred twice --
a fence reconstructed inline from drain state, losing the ownership half -- and
nothing else. It cannot see a fence that is present but wired to the wrong
headers, an ownership term computed against a stale route, or a consumer that
stops reading `nativeMainReadsForbidden`. Any of those is a semantic routing
regression that would keep this file green, which means the file reports more
confidence than it holds.

## What the replacement needs

A behavioural case that drives `prepareResponsesRequest` with a forwardable
caller bearer on a `thread_spawn` and observes that the preview performs no
credential-validating read of the physical main token and scores main the same
way final authentication does. The expensive part is the fixture, not the
assertion: an account-gated model, a populated denial cache, and an injected
entitlement resolver that records whether main was consulted. The existing pool
harness in `tests/routing/subagent-fallback-handle-responses.test.ts` already
carries most of it, but that file is at its size cap, so the work is a new file
in `tests/routing/` plus its two layout registrations.

Keep the structural file when the behavioural one lands. They fail on different
things, and the cheap one is what catches the inline-reconstruction regression
before review.
