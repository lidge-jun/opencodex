# Lane B — make already-connected providers actually work

Baseline: `origin/dev` = `2f025814f3`, `package.json` 2.59.0.

This lane does not add provider names. Every unit below is about a provider a user has
already connected that does not serve a request correctly. Two rules shape the whole plan:

- A symptom cluster is split by cause before anything is written. One patch that makes a
  bundle of symptoms go away is the failure mode this lane is meant to avoid.
- A change that hides a failure is out of scope: failover on every 400, replaying an
  uncertain send, unconditionally dropping unsupported fields, or reporting unobserved
  usage as zero.

## Why the 429 evidence bar is high here

`src/adapters/google.ts` already documents that Cloud Code Assist answers
`429 RESOURCE_EXHAUSTED` for a *policy* rejection — the Claude-Agent identity paragraph —
and 200 for the identical request with that paragraph removed, same account, seconds apart.
The comment on `ANTIGRAVITY_CLAUDE_SDK_PARAGRAPH_REJECTORS` states the reason the set is
probe-established per generation: "a policy rejection wearing a quota error's clothing sends
users hunting a quota problem that does not exist".

`classifyGoogle` in `src/adapters/google-errors.ts` confirms the two are not separable from
the wire alone. The message reported in #4856, `Resource has been exhausted (e.g. check quota)`,
contains none of the hard-quota needles in `isGoogleQuotaExhaustedText`, so it is classified as a
retryable rate limit — exactly as a genuine transient limit would be. Status, body, and headers
cannot tell a request-shape rejection from real exhaustion. Only a matched envelope toggle can:
same account, same minute, one field changed, 429 becomes 200 and back.

That is the standard this lane applies to any claim that a request-shape fix resolves a 429.

## Existing pull requests — current-head disposition

None of these is merged by this lane. The end state is an open PR with exact-head CI evidence,
or a written closure rationale handed to the host.

### #4913 — strip `x-anthropic-billing-header:` for Cloud Code Assist (head `a5f76582e8`)

The change is correctly placed and correctly scoped to the CCA adapter boundary. The regex is
anchored at position 0 without `/m`, and that anchor does fire: the Claude surface collapses
the whole top-level `system` array through `systemToInstructions`, the result becomes
`systemParts[0]`, and `parser.ts` pushes it as `systemPrompt[0]`. Nothing is prepended before
the client's text in `messagesToGeminiFormat`, so a billing header sent as the first line of
Claude Code's system prompt is at offset 0 of the assembled string.

Open points, all raised at the current head rather than carried from an earlier review:

1. The strip is unconditional for every CCA request, while the neighbouring Claude-SDK-paragraph
   strip is gated on a probe-established per-generation set. The deviation is defensible — a
   billing header carries no instruction value, so removing it cannot change model behaviour the
   way removing an identity paragraph can — but the PR should say that, because the file's own
   documentation makes the stricter discipline the default expectation.
2. The causal claim is not yet established to this file's standard. Two live 200s after the fix
   do not separate "the header caused the rejection" from "the window rolled over". The probe the
   file already describes is what settles it.
3. Missing composition case: the realistic Claude Code shape puts the billing header and the
   following text in one `system` block. `stripAntigravityRejectedClaudeSdkParagraph` filters on
   whole `

`-delimited paragraphs by exact equality, so when the header is glued to the
   Claude-Agent paragraph that filter currently misses. Stripping the header first repairs it.
   That is a real second benefit of this PR and nothing tests it.
4. One unrelated blank-line deletion above `ANTIGRAVITY_REJECTED_CLAUDE_SDK_PARAGRAPH`.

This PR must not be described as resolving #4856. It addresses cause A below and nothing else.

### #4676 — rank Antigravity failover by Gemini vs Claude quota family (head `1daf4f67eb`)

The guard restoration has already landed on this branch: `1daf4f67eb` puts back
`isNonReplayableResponse` and the wire-scoped `enforceDeclaredToolNames` that the quota-family
rebase dropped. The earlier review finding is closed and is not re-raised.

Two things block it now, and they are different in kind:

- `hygiene` fails with `unsponsored_surface` because the PR touches `src/oauth/`, a restricted
  prefix in `.github/scripts/pr-sponsored-surface.cjs`. `enforce-target` fails for the same
  reason, since it re-collects the deterministic hygiene failures. This is one root cause, not
  two, and it clears only when a maintainer security-reviews the OAuth surface and applies
  `maintainer-sponsored`. That is a host decision.
- `test 3/4` failed at the exact head in the run the host approved. Diagnose before anything
  else; a family-scoping change that breaks a test is not a labelling problem.

The lane's remaining review work is to confirm family-scoped headroom and cooldown do not leak
into the Codex, Anthropic, or Kiro paths. `headroomOf` currently takes the maximum usage across
all windows regardless of the requested family, which is the defect the PR targets.

### #4877 — forward the selected model's input ceiling for Devin (head `795a416b5b`)

Reviewed for one question: does the input ceiling of the *selected* model and account actually
reach the request? Exact-head CI was approved by the host and is running.

### #4900 — stop Cursor grok-4.6 tool-result echo from poisoning later turns (head `5702c8e4f9`)

Judged as a change on top of #4875, not against the original report. Three scopes must stay
separate and the PR must not blur them:

- replaying the current send automatically (out of scope — this is the uncertain-replay failure
  the round forbids);
- preventing contamination of a new conversation (in scope);
- recovering a conversation already poisoned (explicitly not attempted; the PR says an affected
  thread still needs a new task, which is the honest position).

## Issues — cause-by-cause disposition

### #4856 — five causes, not one

| Cause | What it is | Addressed by | State at `2f025814f3` |
|---|---|---|---|
| A | CCA rejects Claude Code's private billing metadata in `systemInstruction` | #4913 | not fixed |
| B | Real Gemini or Claude family window exhausted; `headroomOf` is family-blind so a spent Claude window disqualifies the account for Gemini | #4676 | quota *visibility* fixed (`ef7b3c9cf4`); family-aware ranking not |
| C | Provider save rejected before persistence when Clash/Mihomo resolves the canonical host into `198.18.0.0/15` | #4723 | not fixed |
| D | Only one attempt logged with an empty attempt-level account label despite four eligible accounts | none | generic 429 failover itself landed (`816f3a159d`, `8bfac71466`) |
| E | Some other envelope-specific upstream limit (tool schemas, history bytes, media, output ceiling) | none | unproven |

Cause C is not reported in #4856 itself and is carried here only because it shares the
Antigravity surface; it stays a separate concern rather than being attributed to that thread.
Model-allowlist persistence goes through `model-routes.ts` and runs no destination DNS
validation, so #4723 cannot explain a selected-model-only persistence failure.

Cause D is the one to resist patching. Adding another rotator would be a second mechanism on top
of a working one. The question to answer first is why four eligible accounts produced one
physical send.

### #4820 — Cursor live discovery drops models

Not a slug mismatch, not a capability rejection, not truncation. `filterCursorConfiguredModelsByLiveDiscovery`
iterates the *configured* roster and keeps entries that match a live id, so discovery is an
intersection with a static seed and a live-only id is never iterated. Muse appears in neither
`CURSOR_CAPABILITIES` nor the product exceptions that derive `CURSOR_STATIC_MODELS`, so its six
live variants have no base row to activate.

Fix: add the curated capability row. The broader "merge every unmatched live id" policy is
rejected — `GetUsableModels` advertises ids whose `Run` calls return `not_found`, and the
quarantine comments in the same file are the precedent for not exposing them.

### #4723 — canonical Antigravity through fake-IP save validation

Source-accepted at head `01dadfddca`. The opt-in requires provider name, registry auth kind,
override policy, adapter, runtime auth mode, and normalized base URL to all match the canonical
registry seed, so custom relays, literal `198.18.x` URLs, and mixed private/metadata answers stay
rejected. Needs exact-head CI and a closing reference; it currently closes no issue.

### #4680 — Muse paid OAuth reasoning metadata

`meta-muse` reuses `META_MUSE_REASONING_EFFORTS` from `meta-model`, a five-rung ladder ending at
`xhigh` derived from public docs and a free-tier probe. A paid request for `max` is clamped by
`mapRoutedResponsesReasoningEffort`. The request and response plumbing is otherwise intact; no
parser change is needed.

Gate: advertising `max` on the paid ladder without upstream evidence would invent a capability,
which is the same error as hiding a failure. This unit does not proceed until the issue supplies
a paid-account response accepting `max`.

### #4847 — Union Alpha on OpenCode routes

Two coupled mismatches, and the naive fix breaks a third thing.

- `opencode-go` defaults to `openai-chat`; `union-alpha` has no Anthropic hard pin in
  `src/types/wire.ts`, and `modelAdapters` accepts only the two OpenAI wires, so configuration
  cannot compensate.
- The Go session header is derived from the conversation lane alone, so Chat, Responses, and a
  later Anthropic model share one `x-opencode-session`.
- Trap: `registryEntryForProviderDestination` recognizes Go by comparing the configured adapter
  against the registry's `openai-chat`. Pinning `union-alpha` to Anthropic without touching
  destination recognition drops the session header entirely and reproduces `MissingSessionID`.

Minimal fix is the pin plus protocol-namespaced session ids, keeping operator-supplied session
headers and stable sessions within a protocol.

### #4733 + #4024 — OpenRouter reset-instant key parking

The stale body of #4733 is not the thing under review. Its follow-up already replaced the clone
with a bounded read plus response reconstruction, and that part now works: status, status text,
and headers are copied, pulled bytes are replayed, and the remainder streams lazily rather than
being buffered whole.

What is still open at the current head is narrower and concrete:

- the 4 KiB stop appends a whole chunk before re-checking, so one oversized chunk is retained;
- `reader.read()` has no deadline and no abort signal, so a stalled body blocks rotation and an
  aborted client can still mutate cooldown and selected-key state before cancellation is noticed;
- the error path returns the original response while the reader still holds the lock;
- parsing is a broad regex over arbitrary text applied to every multi-key provider, so an
  unrelated 429 can override a valid `Retry-After` and park a key for up to 32 days.

Merging this head would cover reset-aware parking for a multi-key pool on one Responses dispatch
path only. It would not deliver single-key-to-combo failover, combo-target exhaustion, the other
OpenRouter surfaces, the configurable policy, or parking that survives a restart. The
`Closes #4024` linkage should come off and #4024 should stay open.

## Sequencing

Stacks stay two to three deep and are not chained merely because they share a provider.

1. Review-only, no branch: #4913, #4676, #4877, #4900 at exact head, with the host holding every
   merge and closure decision.
2. Implementation, independent branches off `dev`: #4820 (Cursor capability row), then #4847
   (pin plus session namespacing).
3. Held pending evidence: #4680 (paid `max` rung), #4856 causes D and E.

## Verification posture

No local suite, typecheck, build, install, or `ocx` run takes place in this lane; a past local run
deleted real user data under `~/.opencodex`. Verification is static reasoning over the source
plus hosted CI at the exact head. Fork CI approval is a host action and was granted for the four
heads above.

