# Anthropic image-context recovery

The provider-level `anthropicImageContextRecovery` flag is off by default.
Disabled or omitted, it preserves the existing normalization, image guard,
and tighter-image 413 retry. Ordinary Codex compaction follows the
[compaction contract](../transports/responses-failover.md#compaction-routing-overrides).

On the opt-in route, `src/server/responses/adapter-dispatch.ts`,
`src/images/loop.ts`, and `src/web-search/loop.ts` may replace a physical
upstream size refusal with a single image-context recovery.
`src/server/responses/anthropic-image-context.ts` finds an older image-bearing
prefix on a complete user-turn boundary. Open tool calls stay with their results.
The newest image remains in the retained context. A cut that covers developer
or system messages is refused. The separate system prompt stays verbatim.

`src/server/responses/request-transport.ts` binds recovery to the still-current
selection and the exact credential and Messages URL of the refused physical
send. The transport checks both again after pacing and plugin rewrites.
`src/adapters/anthropic.ts` rejects a build carrying compacted history for a
different continuation owner.

`src/server/responses/image-context-recovery.ts` releases the refused body before
the same owner's recovery sends acquire pacing. It allows one billable summary
with tools and reasoning disabled and one smaller resend. The summary's wire
output cap is at most 1,024 tokens and at most the refused request's wire cap.
First-party Opus 5.5 skips its adaptive-thinking default on the summary only.
Both legs share the original send, translation, and cancellation limits. Cancellation
while retaining the refusal takes the client-cancellation path. Live search and media
iterations feed the SSE stall watchdog while recovery is pending.
Under an enforced spend ceiling, direct recovery reserves each leg against
the original spend scopes before physical dispatch. The summary and resend each
settle their own reported usage under the [spend contract](../transports/responses-spend.md).
A denied reservation
returns the original 413. Sidecar recovery under enforced spend requires
authoritative accounting for earlier sends. The proxy accepts only a bounded,
completed text summary, and a second 413 ends recovery.
Recovered history is scoped to the running request. The feature starts no
background cache renewal and records no request-origin data.
