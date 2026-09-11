# Audit round 1 — reviewer verdict and dispositions

Reviewer: `xai/grok-4.6` explorer subagent, read-only, dispatched against the orch worktree.
Verdict: **fail**. Seven anchored findings, all accepted. The dispositions below are folded into
`010_lane_partition.md` and `020_lane_packets.md` before any lane is dispatched.

## F1 — L1 and L6 both need the Responses WebSocket path

Anchor: L1 was given the glob `src/server/responses/*` while L6 was given "streaming/WebSocket
prelude paths"; the prelude timeout L6 must investigate is
`src/server/responses/codex-ws-exchange.ts:214` (`failStream("codex websocket response prelude
timed out")`). The packet even told L6 to stop if the cause landed in L1's territory, which is an
admission that the boundary was wrong.

Disposition: territories are now explicit file lists, not globs. `codex-ws-exchange.ts` and
`codex-ws-wire.ts` belong to L6; L1 keeps `core.ts`, `chat-completions.ts`, `claude-messages.ts`,
`compact.ts`, `policy-fallback.ts`, and the undeclared-tool guard.

## F2 — L3's #4212 needs a Responses file

Anchor: the issue names `src/server/responses/codex-auth-error.ts:35`, which sat inside L1's glob
while L3 owned only `src/codex/*`.

Disposition: `src/server/responses/codex-auth-error.ts` is assigned to L3. No open PR touches it, so
the assignment costs L1 nothing.

## F3 — #4207 is client work and collides with #4204

Anchor: #4207 names `src/client/hub-client.ts:145`, `src/client/connect.ts:542`,
`src/codex/catalog/effort.ts:441`, `src/cli/connect.ts:187`. #4204 is the same max/ultra clamp on
`effort.ts:441`. They were split across L2 and L4, and `src/client/*` was owned by nobody.

Disposition: #4207 moves to L4, which now owns `src/client/*` and `src/codex/catalog/effort.ts`.
Two issues that clamp the same line are now one serialized stack. L2 keeps only #4201.

## F4 — carried PRs drag files out of their lane

Anchor: #4188 carries eight `docs-site/**` files, #4210 one, #4203 thirty-six files including
`scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`, #4170 touches
`src/lib/process-control.ts`, and #4190's leak lives in `src/adapters/qoder/adapter.ts`, which no
lane owned.

Disposition: L7 owns only the two documentation pages it is fixing
(`docs-site/**/guides/providers.md`, `docs-site/**/guides/remote-hub.md`); any lane may update the
documentation page that describes its own change. `src/lib/process-control.ts` is added to L4,
`src/adapters/qoder/*` to L6. The #4203 file count is corrected to 36.

## F5 — two PR states were stated wrong

Anchor: #4171 is a draft at `CHANGES_REQUESTED`, and #4170 is a draft at `REVIEW_REQUIRED`; the
packet described neither as a draft.

Disposition: corrected in place.

## F6 — the test-layout rule contradicted AGENTS.md

Anchor: the packet said to avoid `layout.json` by naming files conventionally; `AGENTS.md:23` says a
new test file needs an entry in both `layout.json` `explicit` and
`tests/fixtures/test-layout-expected.json`, with the regex seeds as a temporary placement only.

Disposition: the avoidance rule is withdrawn. Every lane registers its own test files in both maps
as AGENTS.md requires, and the orchestrator resolves the resulting append-only conflicts during the
serialized merges. A rule that tells a lane to skip a repository requirement is worse than a
conflict that takes a minute to resolve.

## F7 — six items were not actually decision-free

Anchor: #4197 (refuse versus preserve metadata), #4211 (`excludedPlans` versus `minimumPlan`),
#4176 (prefix normalization versus the unified-exec rewrite), #4191 (four competing mitigations),
#4207 (compatible projection versus blocking readiness), and #4203 (what "trim" means) each left a
choice open, which contradicts the round's own decision-free filter.

Disposition: the orchestrator makes those six calls now, in writing, and the lanes implement them.
They are recorded in `020_lane_packets.md` per lane:

| Item | Decision |
|---|---|
| #4197 | Refuse the integration write when the target exists and its owner is not the process euid, with an explicit API error. Do not relax the `0600` hardening and do not attempt `fchown`. |
| #4211 | Ship `codexPool.excludedPlans` as an array, absent by default. Do not ship `minimumPlan`: ordering plans requires a rank this repository does not have. |
| #4176 | Normalize the invented `default.` prefix back at the undeclared-tool guard, which is what the issue states as expected behaviour. The unified-exec rewrite is out of round scope. |
| #4191 | Reproduce first. The only in-scope fix is to classify and report the prelude timeout honestly, including the close code and the cause. A configurable prelude budget is a report, not a patch. |
| #4207 | Fail closed: when the projection is not compatible with the local client, block readiness rather than reporting success. |
| #4203 | Trim to the pnpm self-update path plus the tests and the one documentation page that path requires. |

