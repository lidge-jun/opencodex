# #4903 — a capability refusal classified as a request-shape refusal

## Reproduction, re-derived at the tip

A combo opens a new conversation. The shadow title call carries `response_format`, the first
target's Alibaba gateway answers HTTP 400, and the chain stops instead of trying the target
behind it.

`comboFailureDecision` reaches
`["origin_rejected", "context_length_exceeded", "invalid_request_error"].includes(error.code)`
and returns `stop`. `isRequestLocalTargetIncompatibility` runs first and could return `hop`,
but it refuses at its own first guard: the gateway's `invalid_parameter_error` is not in the
generic code set, and none of its three accepted shapes — `Unsupported parameter: user`, an
`unsupported_value` on `reasoning.effort`, and a model-scoped image-input rejection — describes
a `response_format` refusal.

There is a second blocker the issue body does not name, and it is why the reported text reads
`Provider error 400: data: {...}`. The gateway reports the refusal inside a single SSE frame.
`normalizeUpstreamErrorText` cannot parse `data: {...}` as JSON, so `classificationText` keeps
the raw frame and `upstreamCode` arrives `undefined`. Even with the code set widened, the
envelope check would still fail on the unparsed frame.

## Why neither obvious option was taken

Hopping on every 400 replays a genuinely malformed request against every remaining target.
Dropping `response_format` changes the output contract the caller asked for, silently, on a path
whose entire purpose is a structured result.

So the verdict is narrowed to a capability claim: the message must name `response_format` AND
say it is unavailable or unsupported. "Invalid schema for response_format" names the field and
claims nothing about capability, and stays terminal.

## The envelope

- HTTP 400, intact provider JSON, `type: "invalid_request_error"`, three-envelope depth budget,
  16,384-character bound — the same discipline the existing predicate uses.
- Code set is the shared generic one plus `invalid_parameter_error`, held in its own set so the
  `user` and image branches are not widened by a code they were never reasoned about.
- `param` may be absent or explicitly null; a param naming another field contradicts the message
  and fails closed.
- One `data:` prefix is unwrapped, and only on a single-line body. That unwraps one frame rather
  than parsing a stream, so a multi-event body is left alone and still fails closed.

## What the next target gets

The same request, `response_format` included. A target that can honour the contract honours it;
one that cannot is skipped in turn. Traversal stays finite because combo excludes each attempted
target and policy tries each candidate once. The verdict records no cooldown, since a capability
gap says the target is healthy and the request did not fit it.

Cancellation, structured origin and cyber-policy refusals, and the non-replayable post-send codes
are all tested before this verdict and remain authoritative.

## Relationship to #4817

`#4817` forwards a zero-output SSE bare error event to the next target only when
`comboFailureDecision` already says `hop`. This issue is the opposite half: the decision said
`stop`, so that path could never carry it. The two are complementary and neither closes the
other.
