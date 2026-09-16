# 010 — Lane assignments

Each lane is one worktree Codex thread on its own branch. The orchestrator model
is named per lane; inside the lane the implementation work goes to devin/swe-2
and xai/grok-4.6 subagents at roughly a 2:3 ratio. Every lane runs cxc-loop,
pushes with --no-verify, opens one pull request against dev, and runs no local
suite.

This split is the second revision. The first one was audited and failed: two
round-1 lanes both owned src/server/responses/core.ts, two round-2 lanes both
owned the Models dashboard, and src/codex/catalog/effort.ts had two claimants
across rounds. Lanes in the same round are now disjoint by file, and the only
remaining overlaps are sequential, where the later round branches from dev after
the earlier one has landed. The write-scope exclusions below are the mechanism;
they are part of each lane's dispatch, not advice.

## Round 1 lanes — branch from current dev

| Lane | Orchestrator | Issues | Carried | Write scope |
|---|---|---|---|---|
| R1-L1 catalog normalization | claude-opus-5 | #4570, #4505 | — | src/codex/catalog/parsing.ts and catalog normalization; **not** catalog/effort.ts |
| R1-L2 pool routing and prompt cache | kimi/k3 | #4546, #4550 | — | src/codex/routing.ts, pool and session affinity; **not** src/providers/devin*, src/providers/antigravity*, src/server/responses/* |
| R1-L3 cursor policy and errors | claude-opus-5 | #4508, #4542 | #4509 (HeiTuz), #4544 (001005HS) | src/adapters/cursor/* |
| R1-L4 responses terminal, reasoning payload, media | claude-opus-5 | #4469, #4311, #4312, #4532 | #4549 (jiaoyun286) | src/server/responses/*, src/responses/*, src/adapters/anthropic* |
| R1-L5 provider account lifecycle edges | kimi/k3 | #4503, #3781 | — | src/providers/devin*, src/providers/antigravity*; **not** the pool kernel |

### What each lane owns

**R1-L1** — #4570 is a live-catalog regression where
zhipu-bigmodel-coding/glm-5.3-flash loses its contextWindow on 2.54.0, so the
model arrives with no context budget. #4505 is the neighbouring modality gap:
DeepSeek V4.1 Flash and GLM-5.3 Flash declare no image input, which disables
combo image routing on OpenCode Go and CommandCode. Both are parsing and
normalization. The reasoning ladder is explicitly not this lane's, because
R2-L6 owns effort.ts.

**R1-L2** — #4546 is the expensive one: pool routing rotates accounts mid-thread,
which destroys the prompt-cache prefix and produces a 10x-50x token burn above
the 80% usage threshold. #4550 is the same subsystem from the other side, an
existing Codex CLI thread that bypasses the pool over a direct WebSocket while
status still claims opencodex-local.

**R1-L3** — #4508 loses the Cursor data-policy "action required" signal into a
bare failed_precondition, and #4542 makes the native-exec refusal name
shell_command/exec_command even when the catalog has no shell tool, which makes
kimi-k3 abandon the turn. #4509 and #4544 are contributor attempts at exactly
this surface; both are carried with attribution rather than reimplemented blind.

**R1-L4** — this is the merged Responses lane. #4469 is reasoning
encrypted_content never reaching the caller that asked for it; #4311 is paginated
Codex history silently stopping projection after provider metadata relabeling;
#4312 reports an Anthropic content_filter terminal as a 502 so Codex retries
something that can never succeed; #4532 is dynamic image downscaling on append
busting the prompt prefix cache, which #4549 fixes. They were two lanes until the
audit showed #4549 already diffs core.ts, encrypted-payload.ts, compact.ts and
collaboration.ts — the same files #4469 needs. One lane, one merge.

**R1-L5** — #4503 is the Devin provider's detached credential rekey leaving a
host-selection window, and #3781 is the Antigravity quota-refresh failure with
missing canonical Fake-IP handling. Both are vendor-local and stay out of the
pool kernel that R1-L2 owns.

## Round 2 lanes — branch from dev after round 1 lands

Cutting these after round 1 is what makes the remaining overlaps safe. R2-L6
needs src/codex/catalog/parsing.ts, which R1-L1 also changes, and #4461 edits it
too.

Round 2 runs in two waves, and inside wave A exactly one lane owns the config
schema. That rule is the thing that took three audit passes to get right: any
lane that adds a user-facing setting has to edit src/config.ts and
src/types/config.ts, so "disjoint" cannot be expressed in feature terms alone.
L8 is the schema owner for wave A; L6 and L7 land behavior only, and if either
one genuinely needs a new setting it files a follow-up instead of editing the
shared schema.

The waves exist for the same reason. Wave A is L6, L7 and L8, which
are disjoint from each other. Wave B is L9 alone, branched from dev after L8
lands. The second audit found why: #3630 and #3377 are config-schema changes in
src/config.ts and src/types/config.ts, and L9's carried #4042 already edits both
of those files plus src/server/background-lifecycle.ts, which is exactly where a
refresh timer would register. Naming L8's scope as catalog-refresh-status.ts and
convergence.ts did not remove that collision, it only hid it. Sequencing does
remove it.

| Lane | Orchestrator | Issues | Carried | Write scope |
|---|---|---|---|---|
| R2-L6 codex runtime and Windows probe (wave A) | claude-opus-5 | #4204, #4458 | #4461 (S0RYUASUKA) | src/codex/runtime.ts, catalog/effort.ts, catalog/bundled.ts, catalog/parsing.ts; **no new config-schema fields** |
| R2-L7 web-search bridge (wave A) | kimi/k3 | #4429 residual, #2730 | — | src/web-search/*, src/server/search.ts; **no new config-schema fields** |
| R2-L8 catalog auto-refresh backend (wave A) | claude-opus-5 | #3630, #3377 | — | src/codex/catalog-refresh-status.ts, convergence.ts, src/config.ts, src/types/config.ts, src/server/background-lifecycle.ts; **not** gui/, **not** management/config-routes.ts |
| R2-L9 dashboard model and usage surface (wave B, branches after L8 lands) | kimi/k3 | #4175, #4209 | #4193 (chilung-cgu), #4042 (Vocllum) | gui/src/pages/Models.tsx, gui/src/pages/Usage.tsx, src/server/management/config-routes.ts, and the config-schema files only as rebased on top of L8 |

**R2-L6** — #4204 has a stale persisted CLI 0.135.0 stripping max and ultra while
Codex Desktop runs 0.153.4, and #4458 is the Windows prompt probe missing the
Codex App runtime and its base prompt source. Both are runtime resolution, and
effort.ts has exactly one owner in the whole unit.

#2279 was in this lane and is deferred out of the unit. It asks for a per-model
setting that suppresses synthetic max while retaining ultra, which is a
config-schema field, and the third audit pass showed that putting a schema field
in L6 collides with L8 no matter how the rest of the scope is drawn. It is a real
ask and it stays open; it just does not fit a lane that has to run beside a
schema owner.

**R2-L7** — #4429 is only partly landed. #4515 (cb2e15ba6f) shipped the
passthrough backends and said so, but the residual is mixed-tool continuation:
a key-auth Responses gateway (Kimi K3) still echoes hosted web_search back as a
client function_call, and webSearchBridge stays Ollama-only. The lane closes the
residual, not the whole issue as if nothing had landed. #2730 is the related ask
to let /v1/alpha/search use a configured backend without ChatGPT forward auth.

**R2-L8** — #3630 wants periodic catalog auto-refresh so newly released models
appear without a manual ocx sync. #3377 wants per-model capability declarations
for text-only, context tier, and video processing mode. Backend only; the
dashboard side of the same story belongs to R2-L9.

**R2-L9** — #4175 is the Dashboard toggle for Fast selector rows, which #4193
already implements. #4209 wants the dashboard to distinguish a hub model change
that is saved from one that is synced from one that is actually active on a given
client. #4042 adds a configurable usage history size limit and has gone stale.

## Contributor merge queue

These need review plus an admin squash, not new implementation. The reviewers
found that every one of them was sitting with Cross-platform CI and React Doctor
in action_required, which is the fork-workflow approval gate — so none of them
had ever produced exact-head suite proof. Approving those runs at the current
head is the first step for each, and the merge waits on the result.

- Batch 1 (round 1): #4565, #4452, #4451, #4383, #4139, #4517, #4298, #4071,
  #4033
- Batch 2 (round 2): #3952, #3748, #3742, #4224, #4265, #4199, #4177, #3833,
  #4178, #4566, #4564, #4568, #4569
- Held: #4309 is 288 commits behind dev and its provider-count assertions cannot
  be trusted until it is rebased.

Draft state is a gate artifact, not an author objection: the contributor gate
opens fork pull requests as drafts and holds them until a four-box checklist is
ticked, and the local-CI box is an attestation a fork author cannot satisfy
because fork contributors cannot start repository CI. Marking such a pull request
ready before an admin squash is a maintainer action, and it is recorded as one.
