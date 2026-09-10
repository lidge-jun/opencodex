# Mid-thread encrypted agent-task recovery (#4089) — plan

## Reader summary

Problem: switching a live Codex Desktop thread from a native ChatGPT model to a routed provider
model bricks the thread with `unreadable_encrypted_agent_task`. The thread's history already
contains a backend-minted `encrypted_content` agent message, every later turn replays it, and
`agentTaskRecovery` — even when explicitly enabled — never runs, because the direct recovery
block is gated on `isThreadSpawnRequest(req.headers)` and a mid-thread model switch is not a
thread spawn. Answer: `threadSpawn` was never the trust boundary; `recoveryAdmission()` is.
What changes: the direct gate drops the `threadSpawn` conjunct, so any routed Responses request
carrying an unreadable encrypted agent envelope gets one recovery attempt under the same
unchanged admission checks. The combo gate keeps its spawn requirement.

## Loop spec

- Loop archetype: satisfy-spec (single work-phase wp1, one PABCD cycle; not multi-cycle, so no
  docs-first roadmap cycle).
- Trigger: lidge-jun/opencodex#4089, delegated as one lane of the post-2.49 round.
- Class: C4. This widens a trust boundary — a code path that spends the caller's stored native
  ChatGPT session becomes reachable from a request shape that previously could not reach it — so
  it gets a durable evidence record and expects security review before merge.
- Goal: a mid-thread native-to-routed model switch attempts recovery; the discriminator
  `recovery_reason` is present on the non-spawn error body; the admission checks are untouched;
  PR on `dev` with green exact-head CI.
- Non-goals: #2495 (opt-in plaintext V2 rewrite) and #3661 (spawn-path recovery failures) are
  explicitly out of this lane and are not grouped in. No widening of `recoveryAdmission()`. No
  change to the combo path. No change to `canPassThroughEncryptedV2AgentTask()`, so an
  OAuth-mode routed provider still has no ciphertext passthrough. No early client-side rejection
  of the model switch (suggested direction 2 in the issue) — that is a product/UX decision for a
  separate unit.
- Local verification: NOT RUN by standing maintainer instruction for this round (no product
  suite, no typecheck, no build, no lint, no `bun install`). Remote CI on the PR's exact final
  head is the only gate: `.github/workflows/ci.yml` job `test` (line 263), gated on the
  `changes` filter that covers `src/**` and `tests/**` (lines 191, 193), runs
  `bash scripts/ci/run-bun-test-batches.sh` (line 325) whose `find tests -type f` selection
  includes `tests/server/agent-task-recovery.test.ts`.
- Stop condition: PR non-draft, mergeable, exact-head CI green. Merging is the main session's.
- Expected terminal outcomes: DONE = PR open with green exact-head CI; BLOCKED = irreducible CI
  failure or a conflict the main session must sequence.

## Root cause (evidence)

`src/server/responses/core.ts:3616-3624` — the direct (non-combo) recovery block:

```
  inboundWire === "responses"
  && threadSpawn
  && agentTaskRecovery
  && !isCanonicalOpenAiForwardProvider(route.provider)
  && !options.comboAttempt
  && !canPassThroughEncryptedV2AgentTask(route, inboundWire)
```

`threadSpawn` is `isThreadSpawnRequest(req.headers)` (`core.ts:3503`), which
`src/server/effort-policy.ts:33` defines as true only for `x-openai-subagent: collab_spawn`
or turn metadata `subagent_kind === "thread_spawn"`. A mid-thread model switch carries neither,
so the whole block is skipped: `restoreCachedEncryptedAgentTasks()` never runs, the recovery
call never runs, and `recoveryFailureReason` stays `undefined`. The request then falls through
to `core.ts:3762-3769` and returns `unreadable_encrypted_agent_task` with no
`recovery_reason` field at all (`core.ts:1988-1999` only attaches the field when a reason
exists). That absence is exactly the discriminator the reporter observed on loopback.

A thread started on the routed model never carries backend-minted ciphertext, which is why it
never reproduces. Once one native-minted `encrypted_content` agent message is in the history it
is replayed on every subsequent turn, so the thread is permanently unusable on that provider.

`canPassThroughEncryptedV2AgentTask()` (`core.ts:1990ff` comment block) requires
`authMode === "key"` plus `allowEncryptedV2AgentTasks` plus an `openai-responses` wire, so
an OAuth-mode routed provider has no passthrough escape either. Recovery is the only path.

## Change

One conjunct deleted from `src/server/responses/core.ts:3618-3619`, plus a comment recording
why. The cache restore (`restoreCachedEncryptedAgentTasks`) lives inside the same `if`, so it
moves with the gate — which also fixes the reporter's third observation, that a proxy restart
loses any chance of reusing a previously recovered plaintext for the thread.

## Why the trust boundary is unchanged

`recoveryAdmission()` (`src/server/responses/agent-task-recovery.ts:249-283`) is untouched.
Every one of its checks still runs on the widened path, and each one independently refuses:

1. `isApiAuthRequired(config)` — a proxy with inbound API auth configured is never admitted.
2. `CODEX_ORIGINATORS` membership on the `originator` header.
3. No `x-opencodex-api-key` and no `x-api-key` on the inbound request — remote/shared proxy
   callers are refused outright, because caller-controlled Codex metadata is not strong enough
   to authorize spending a stored ChatGPT session.
4. A `Bearer` token that passes `isNativeChatGptAccessToken()`: RS256 + `kid`, an issuer in
   `OPENAI_TOKEN_ISSUERS`, the `https://api.openai.com/v1` audience, the Codex OAuth
   `client_id`/`azp`, unexpired, `nbf` honoured, and a present auth claim object.
5. The account id extracted from that token must equal the explicit `chatgpt-account-id`
   header.
6. A proxy admission secret presented as the bearer is rejected before anything else
   (`isProxyAdmissionSecret`).

The recovery cache is keyed by an HMAC over the token and account id
(`agent-task-recovery.ts:275-279`), so a widened entry point cannot read another caller's
recovered plaintext. `restoreCachedEncryptedAgentTasks()` re-runs `admittedRecovery()` per
item before touching the cache (`agent-task-recovery.ts:559-561`).

The population that gains reachability is therefore: a loopback request from a Codex originator,
holding a live native ChatGPT bearer for the same account named in `chatgpt-account-id`, with no
inbound API key, on a proxy that does not require inbound API auth — that is, the same user whose
session would be spent, on the same machine. `threadSpawn` narrowed *which of that user's own
requests* could use their own session; it did not keep anyone else out.

## Plaintext-oracle bound

`src/server/responses/encrypted-payload.ts:181-192` records the reason recovery is
`NEW_TASK`-only: `MESSAGE` is matched for the unreadability CHECK so a reply envelope whose
whole body is one Fernet token is not forwarded verbatim, but decrypting a `MESSAGE` on the
parent's behalf would build a plaintext oracle out of a payload the parent's session may not be
entitled to read. That asymmetry is enforced in
`src/server/responses/agent-task-recovery.ts:508` and is not touched here. Widening the *entry*
gate does not widen *what* may be decrypted: an unreadable `MESSAGE` still fails closed with a
refusal reason, and the only envelope that reaches an actual decrypt attempt is a `NEW_TASK`
the admitted caller's own session is entitled to read.

## Why the combo gate stays

`core.ts:2691-2694` keeps `!isThreadSpawnRequest(req.headers)`. The combo path has its own
native-target filtering and per-attempt failover semantics
(`canDecryptUnreadableAgentTask`, `payloadEligible`, `comboPayloadReadable`), and the
reported defect is on the direct path. Widening both at once would mean two behavior changes
under one security review; the combo path can be reconsidered separately with its own evidence.

## Regression

`tests/server/agent-task-recovery.test.ts` gains the reporter's A/B pair: two `post()` calls
with an identical body — one `agent_message` carrying a routing header plus a structurally valid
Fernet-shaped `encrypted_content` slot — differing only by the `x-openai-subagent: collab_spawn`
header, against a routed provider. Both must fail with `unreadable_encrypted_agent_task`, and
both must now carry `recovery_reason`, because `recovery_reason` is attached only when recovery
actually ran. Before this change the non-spawn arm has no `recovery_reason` field.

## Docs

`docs-site` framed this feature as spawn-only ("a native ChatGPT parent spawning a routed v2
child"). The reference page and the sub-agent surface guide now name both qualifying request
shapes, and the combo paragraph states explicitly that combo recovery is still spawn-only. The
same one-clause precision is applied to the seven translated locales so they do not contradict
the English source, matching what #3754 did for the combo-recovery change. The `docs-site` build
was not run under the same standing instruction; the edits are prose-only inside existing pages.

## Terminal outcome

Tracked on lidge-jun/opencodex#4135. This unit moves to `devlog/_fin/` once the PR is on `dev`.
