# Cross-path contract gaps before the next release

Status: open. Target branch for every lane: `dev`.

The batch that landed on 2026-09-20 fixed several defects one path at a time. The
audit that followed found the same shape repeating: a policy is correct where it
was written and absent one wrapper away, or a guard that protects a real hazard
also refuses the supported case. This unit closes that class before the release
rather than adding features.

Each lane is one branch, ordered commits, and one pull request to `dev`. No
stacked child pull requests, no native stacks. A lane owns its files; where two
lanes touch the same subsystem the split is written below so the merge is a union
and not a conflict.

## L1 — one replay refusal on all three HTTP surfaces

`src/lib/upstream-retry.ts` answers an ambiguous connection loss with
`upstream_reset_replay_refused` and no `Retry-After`, which means "this may
already have executed, do not send it again". `src/server/chat-native.ts` and
`src/server/responses/passthrough-error.ts` recognise that. The translated Chat
wrapper in `src/server/chat-completions.ts` does not: it preserves only the cyber
policy code and `model_not_found`, assigns `upstreamCode` just when
`classifyError` produced no code, and then adds a default `Retry-After: 2`. A
refusal to replay leaves the proxy as an ordinary rate limit that clients retry.

Carry the replay verdict as a property of the result the three wrappers share, so
no wrapper re-derives it from a status code. Then decide the status deliberately:
the widely used Python SDK retries 429 by default, so preserving the code while
dropping `Retry-After` does not by itself stop a resend. The acceptance evidence
is the number of physical upstream sends observed through a client with retries
enabled, not a single `fetch`.

## L2 — the Chat translation inbound loses developer position

Outbound keeps a `developer` message where the conversation put it
(`src/adapters/openai-chat/messages.ts`). Inbound does not:
`src/chat/inbound.ts` routes both `system` and `developer` into
`systemParts` and joins them into `body.instructions`, so
`U1 → A1 → D2 → U2` becomes `instructions: D2` with `U1 → A1 → U2`. Position
is gone before any adapter sees it, and no outbound fix can restore it.

This is not a rare internal path. Combo, policy, synthetic effort rows and several
preprocessing routes translate, so the same transcript behaves differently once a
routing feature is on. The Claude inbound already models this correctly by keeping
a mid-conversation instruction as a developer input item
(`src/claude/inbound.ts`, `src/responses/parser.ts`). Reuse that representation
for the mid-conversation case only; a leading system block keeps its current
treatment.

## L3 — an explicit developer-role setting is ignored natively

`foldDeveloperRoleToSystem` decides the role on the translated path. The native
Chat passthrough (`src/adapters/openai-chat/passthrough.ts`) forwards the
caller's `messages` untouched and never reads it, so an operator who recorded
"this destination rejects `developer`" still sends `developer` there. Honour the
explicit setting on both paths and leave the unset default alone: the existing
native test that preserves caller messages stays green.

## L4 — the paginated-history transition, past "enable succeeded"

The provider-table transition on a paginated `openai` home now completes. The
remaining risk is the state after it. Acceptance is destination preservation, not
a successful sync: existing conversations must not resume against the default
OpenAI endpoint, new conversations must use the injected provider and catalog,
restore must return operator-owned settings and remove only what this project
owns, a user-owned root override must not be taken over, and an admission-token
home must still be refused rather than reported as supported.

## L5 — tool constraints survive response repair

`createGrokResponsesSparseTerminalBlockRewrite` rebuilds a terminal output from
collected `output_item.done` events and receives a budget but not this request's
tool selection. The undeclared-tool guard answers a different question — whether a
name was declared — so a request with `tool_choice: none` or a narrowed allow-list
can still receive a call the repair put back. Pass the request scope into the
repair and enforce it there. Keep the failure narrow: one forbidden call must not
discard the ordinary text that accompanied it. The empty-catalog case belongs to
the same rule — compatibility is judged on the final request and the final
response, after every removal, rename and translation.

## L6 — a client integration that writes a store nobody reads

A newer client release reads its provider list from a different file than the one
this exporter writes, and the legacy import does not run again once the new file
exists, so an apply that reports success produces no models. Support the store the
running client actually reads, including catalog refresh and disable, or report
the write as ineffective. Deleting the new file to re-trigger a migration is not a
supported remedy. The verification unit is "the client requests the intended
provider", not "the file was written".

## L7 — one developer-role policy in both documents and the code

`structure/providers/chat-compat.md` states the role is forwarded as itself on
every destination; `docs-site` states an unset setting sends `system`; the two
code paths differ again. Whoever fixes this area next picks one of them and
reintroduces the regression. Make the three agree after L2 and L3 settle, and
derive the statement from the code where a test can hold it.

## L8 — one resend budget per logical request

The ambiguous-resend gate landed with one operator grant per request. The
composition still needs evidence: first send, reset, replacement, disconnect after
`response.created`, then the combo candidate, credential refresh and 429 legs.
Observe two separate numbers — physical sends, and sends of a turn that may already
have executed. The neighbouring retry issues are not closed by this lane and stay
open with their remaining scope recorded.

## Out of scope

A lenient finish for a text-only stream with no terminal event is existing
compatibility behaviour with its own regression coverage. Turning every EOF into an
error would be a policy change, not a fix, and is not part of this unit.
