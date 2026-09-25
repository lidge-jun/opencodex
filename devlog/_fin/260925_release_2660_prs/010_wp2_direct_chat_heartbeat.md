# 010 — wp2: direct Chat encoder heartbeat parity

## Problem

`dev` at `76db92a4cd` fails
`tests/responses/protocol-direct-encoders-chat.test.ts` > "direct Chat encoder stream lifecycle >
stall watchdog fails the turn like the bridge" with `SyntaxError: JSON Parse error: Unexpected EOF`
at the test's `normalizeFrames` (line 61). Neither parent PR failed on its own head:

- #5806 (`e22209424d`) made the legacy Responses-to-Chat converter relay each typed
  `response.heartbeat` as the SSE comment `: opencodex heartbeat\n\n`
  (`src/chat/outbound.ts:615-623`, ADR-5805).
- #5820 (`0f4c8d4a0f`) added the direct Chat encoder (PF-09), whose writer maps
  `heartbeat` to `ensureRole` only (`src/protocols/encoders/chat.ts:125`), so it sends no
  byte on wire silence.

The stall test drives both paths through heartbeat ticks. The legacy stream now carries comment
frames, `normalizeFrames` parses the empty `data` of a comment block as JSON and throws. Beyond
the test, the direct path does not deliver the keepalive ADR-5805 promises to Chat clients; the
direct encoder is off by default (`protocols.rollout.directEncoders`), so only opted-in
installs are affected.

The same failure is the only CI failure on #5838, #5837, #5835 and #5826 at their current heads,
and on draft #5836, because each is based on the current `dev`.

## Change

### MODIFY `src/protocols/encoders/chat.ts`

Replace the heartbeat alias with the same comment the converter emits, through the sink's
keepalive channel (a keepalive does not count as wire activity, matching ADR-5805 "does not
reset a semantic-progress watchdog"), gated like the Messages writer on termination and demand
(`src/protocols/encoders/messages.ts:207-210`):

```diff
+/** The converter's typed-heartbeat relay (ADR-5805); comment lines produce no Chat event. */
+const CHAT_HEARTBEAT_COMMENT = ": opencodex heartbeat\n\n";
@@
   return {
     start: ensureRole,
-    heartbeat: ensureRole,
+    heartbeat() {
+      ensureRole();
+      if (terminated || failed || sink.desiredSize() <= 0) return;
+      sink.emitKeepalive(CHAT_HEARTBEAT_COMMENT);
+    },
```

If the demand gate makes the direct stream diverge from the legacy one under the parity test
(the legacy converter enqueues without a demand check), B drops the `desiredSize` clause and
records why; the terminal/failed guard stays.

### MODIFY `tests/responses/protocol-direct-encoders-chat.test.ts`

`normalizeFrames` keeps comment-only blocks as a comparable marker instead of parsing them,
so parity covers keepalives too:

```diff
 function normalizeFrames(text: string): unknown[] {
   return text.split("\n\n").filter(block => block.trim().length > 0).map(block => {
-    const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("");
+    const lines = block.split("\n");
+    // SSE comment blocks (the heartbeat relay) carry no event; compare them verbatim.
+    if (!lines.some(line => line.startsWith("data:"))) return lines.join("\n");
+    const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("");
```

and the stall test asserts the keepalive is present on the direct stream:

```diff
     expect(directFrames).toEqual(legacyFrames);
+    expect(directFrames).toContain(": opencodex heartbeat");
     expect(JSON.stringify(directFrames.at(-1))).toContain("upstream_stall_timeout");
```

### MODIFY `structure/transports/streaming-health.md` (SoT sync)

After the paragraph that describes the converter's comment relay (line 36-40), add one sentence:
the direct Chat encoder (PF-09, `src/protocols/encoders/chat.ts`) emits the same comment on its
wire-silence tick through the keepalive channel, so enabling `directEncoders` keeps ADR-5805.

## Acceptance

| Row | Activation | Observable proof |
|---|---|---|
| A1 red | test change only, encoder unchanged | stall test fails: direct frames lack the heartbeat marker |
| A2 green | encoder change applied | `bun test ./tests/responses/protocol-direct-encoders-chat.test.ts` 48 pass 0 fail |
| A3 neighbours | same | `bun test ./tests/chat ./tests/protocols` (existing dirs) and `bun run test:changed` pass |
| A4 types/structure | same | `bun run typecheck` exit 0, `bun run structure:check` exit 0 |
| A5 hosted | PR to `dev` | every required check at the exact head `success`; admin squash merge with `--match-head-commit` |

## Delivery

Branch `codex/260925-direct-chat-heartbeat` from `origin/dev`, one commit, maintainer PR from
the template, maintainer integration recorded in the PR body (MAINTAINERS.md 2026-09-06 rule).


## Amendment after architect consultation (supersedes "Change" and "Delivery" above)

The owner already wrote this fix on 2026-09-25 on the unpushed local branch
`fix/protocols-fu-encoder-heartbeat` (two commits on top of #5820):

- `dd80e03ca3` fix(protocols): relay heartbeat keepalives from the direct encoders —
  `src/protocols/encoders/chat.ts` heartbeat emits `: opencodex heartbeat` through
  `sink.emitKeepalive` after `ensureRole` (guarded by `terminated`);
  `src/protocols/encoders/adapter-events.ts` stops counting keepalives as relayed events
  (`if (activity) relayed(observation)`), matching the bridge; parity tests in
  `protocol-direct-encoders-chat.test.ts` and `protocol-direct-encoders-messages.test.ts`
  compare comment-only blocks and cover heartbeats on both wires.
- `ac3ea085e6` docs(structure): `structure/data-planes/protocol-paths.md` and
  `structure/transports/responses.md` note the direct-encoder keepalives.

This is broader than the draft above (it also closes the relayed-event over-count on every
direct encoder) and is the owner's own work, so wp2 ships it: cherry-pick both commits onto
`origin/dev` as branch `codex/260925-direct-encoder-heartbeat`, authorship preserved. The draft
diff above was validated independently in a scratch worktree (red: parity mismatch; green: 48 pass;
`test:changed` 6971 pass / 0 fail; typecheck 0) and serves as the cross-check only.

An unrelated fork branch `luvs01/fix-encoder-keepalives` (`d5c4b3046a`, `2ff29a9771`, no PR)
fixes the same two points; it is not used, so it carries no co-author obligation.

Acceptance rows A1-A5 stand, applied to the cherry-picked branch; A2 also runs
`./tests/responses/protocol-direct-encoders-messages.test.ts`, and A4 adds
`bun run structure:check` for the two structure edits.
