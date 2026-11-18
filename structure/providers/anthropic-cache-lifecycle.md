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
The newest image remains in the retained context.

`src/server/responses/request-transport.ts` binds recovery to the still-current
selection and the exact credential and Messages URL of the refused physical
send. The transport checks both again after pacing and plugin rewrites.
`src/adapters/anthropic.ts` rejects a build carrying compacted history for a
different continuation owner.

`src/server/responses/image-context-recovery.ts` releases the refused body before
the same owner's recovery sends acquire pacing. It allows one billable summary
with tools disabled and one smaller resend, both within the original request's
send, spend, translation, and cancellation limits. Sidecar recovery under
enforced spend requires authoritative accounting for earlier sends. The proxy
accepts only a bounded, completed text summary, and a second 413 ends recovery.
Recovered history is scoped to the running request. The feature starts no
background cache renewal and records no request-origin data.
