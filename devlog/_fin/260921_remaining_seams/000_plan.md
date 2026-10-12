# The seams the first batch left open

Status: open. Target branch for every lane: `dev`.

The cross-path unit fixed each contract where it was written. Re-reading the
integrated tree found four places where those fixed policies stop one layer
short: an endpoint the refusal never reached, a name that changes between the
check and the thing checked, a match that accepts more than it was given, and a
pair of builders that read different halves of the same provider setting.

Each lane is one branch, ordered commits, and one pull request to `dev`.

## Owned files

| Lane | Owns |
|---|---|
| N1 | `src/server/claude-messages.ts` error path and its tests |
| N2 | `src/server/responses-request-tool-scope.ts`, the scope call site in `src/server/responses/passthrough-delivery.ts`, `src/responses/muse-tool-name-alias.ts` where identity is carried, and the composition test |
| N3 | `src/adapters/openai-chat/passthrough.ts`, the shared wire policy it and `src/adapters/openai-chat.ts` both call, and its tests |
| N4 | `src/integrations/merge.ts` selector parsing and its tests |

N2 owns the scope module outright; N1 and N3 do not touch it.

## N1 — the refusal stops at the Claude Messages wrapper

`src/server/chat-completions.ts`, `src/server/chat-native.ts` and
`src/server/responses/passthrough-error.ts` now agree: an ambiguous connection
loss answers with `upstream_reset_replay_refused`, no `Retry-After`, and
`x-should-retry: false`. `src/server/claude-messages.ts` rebuilds the error
envelope itself. It keeps only the message string, runs the generic
`resolveClientRetryAfter`, and emits an Anthropic error with `Content-Type` and
`Retry-After` — so the refusal reaches the caller as an ordinary retryable
rate limit. Anthropic's own client reads `x-should-retry` before the status
code, so the header is the part that actually stops the resend.

Read the shared verdict here rather than re-deriving it from the message text,
and carry the code, the header and the suppressed `Retry-After` through. Two
behaviours must survive: the transient-5xx to 529 mapping the Claude client
depends on for backoff, and an ordinary provider 429, which keeps the retry
policy it has today. The acceptance is the header and code observed at
`/v1/messages`, not the internal Responses result.

## N2 — identity has to survive the rename

A long client tool name is sent upstream under a short alias, and
`tool_choice` is rewritten to that alias with it. On the way back the payload
rewrites restore the client name first, and only then does the snapshot repair
check the call against the scope built from the outbound body, which still
spells the selector as the alias. The restored name is not the alias, so an
allowed call is removed from the reconstructed terminal output and the turn ends
incomplete.

The same module accepts too much in the other direction. A call is matched by
any of its spellings — bare name, `namespace__name`, `namespace.name` — against
a set holding the selector's spellings, so `alpha.lookup` and `beta.lookup`
both offer bare `lookup` and match each other. The selection set is a set of
strings, so a `custom` and a `function` tool of the same name are not separated
either; the fix is to distinguish a verified conversion from a coincidence of
names, not to refuse every kind mismatch.

Carry the correspondence between the original identity, the wire alias and the
restored identity from the request, and have the scope read that correspondence.
`src/responses/namespace-tool-compat.ts` already reasons about selector kinds
and dotted-alias ambiguity; reuse it rather than growing a second, looser name
set. The regression test has to run the real order — a tool name past the length
limit, a named or allowed-tools selector, alias on the way out, restore on the
way back, sparse terminal reconstruction — and end with the original name and
call id intact. Keep the negative case: a tool the request did not select is
still refused after restoration.

## N3 — two builders, one provider setting

The translated builder turns `reasoningWireFormat: "gateway-object"` with an
effort of `none` into the gateway's object form, and omits the effort entirely
for a tool-bearing request when the model is listed in
`omitReasoningEffortWithToolsModels`. The native Chat passthrough reads neither,
so the same provider and model behave differently depending on whether a routing
feature sent the request through translation.

Apply the explicit settings through one small policy both builders call, after
the provider is resolved. Do not route native requests through translation to
get it: the native path exists to preserve Chat-only fields such as `n`, audio
and logprobs, and losing those is a worse regression than the one being fixed.
An unset setting keeps today's native behaviour. The test compares the final
request body captured on both paths for the same input, not the status code.

## N4 — a selector path must not change meaning

The integration merge grammar gained a conjunction form, `[field=value,field=value]`,
because one field is not always an identity. The single-criterion form allows a
comma inside the value, so a path already written into an ownership record — for
example one whose value itself contains `,` and `=` — can parse as a conjunction
under the new rule and select a different element.

No record in that shape has been found, so this is a migration hazard rather
than a reported loss. Close it deliberately: version the grammar, structure the
selector, or define an escape, and cover it with a test that reads a record
written under the older rule and asserts it still names the same element.

## Out of scope

The paginated-history work and the client provider store landed and are not
reopened here. The two retry issues left open after the first batch keep their
recorded scope; neither is a lane in this unit.
