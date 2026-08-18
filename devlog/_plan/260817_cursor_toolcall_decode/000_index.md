# 260817 — Cursor tool-call decode and hardening

Unit goal: decode how the Cursor adapter encodes/decodes tool calls and tool
results, prove where information is lost or a turn dies mid-call, and land the
fixes the decode justifies.

Trigger: `cursor/grok-4.6` sessions running Computer Use / `node_repl` break
repeatedly — the turn dies mid tool call, the model loses the result, and the
session resets. This unit stops guessing and reads the wire.

## Document map

| Doc | Content |
|-----|---------|
| `001` | Tool-call lifecycle decode (`protobuf-events.ts`) |
| `002` | Tool-result encoding decode (`protobuf-request.ts`, `gen/agent_pb.ts`) |
| `003` | Transport terminal decode (`live-transport.ts`, `transport-retry.ts`) |
| `004` | External wire/format evidence (public reverse-engineering, vendor docs) |
| `010` | Phase 1 — gate the clean-EOF terminal (High) |
| `020` | Phase 2 — tool-result image passthrough (High) |
| `030` | Phase 3 — `xai/grok-4.6` and `apply_patch`: measurement first (symptom unreproduced) |

## Findings summary

Two defects are proven by source reading and get implementation phases. A third
is a proven *lossy conversion* whose behavioral symptom did **not** reproduce in a
live probe, so its phase begins as measurement and may close NOOP.

| # | Defect | Severity | Phase |
|---|--------|----------|-------|
| F1 | A clean HTTP/2 EOF after >=1 frame settles the transport as success without `turnEnded`, so `finalizeTurnEvents` never runs and an open tool call vanishes. Non-streaming reports the truncated turn as `completed`. | High | `010` |
| F2 | Every image part of a tool result is replaced with placeholder text, even though the Cursor protobuf has a first-class `McpImageContent` case that the adapter already uses elsewhere. | High | `020` |
| F3 | On the `xai` path the freeform `apply_patch` contract is erased (`parser.ts:184`, `openai-chat.ts:1194`). The conversion is provably lossy; that this is *why* grok-4.6 avoids the tool is **not proven** — per-property guidance already exists (`parser.ts:189`). `030` is an experiment, not a fix. | lossy conversion proven; **symptom did not reproduce** in a live probe — see 030 | `030` |

### Disproved hypotheses

- **"Open tool calls are silently dropped at finalize."** False. When a real
  `turnEnded` arrives, `finalizeTurnEvents` fails closed with an explicit
  incomplete-tool-call error (`protobuf-events.ts:1361`). The defect is not the
  finalizer; it is that a clean EOF never reaches it (F1).
- **"`maxClientToolCalls` / unknown-tool errors come from `commitToolCall`."**
  False. Both originate in `recordToolCall` (`protobuf-events.ts:1103`, `:1107`).
  `commitToolCall` only rejects invalid freeform and shell-bridge args.
- **"Tool-result text is unbounded and blows the request budget."** Partly false.
  There is no single whole-request cap, but external-model root replay is pruned
  to 192 roots / 512 KiB with UTF-8 truncation (`protobuf-request.ts:60,122`),
  and blobs are admitted under 16 MiB/entry and 64 MiB/store
  (`native-exec.ts:81`). Unbounded growth is bounded by pruning, not by failure.

## Execution contract (user-set)

- Branch `cursor-call`; push continuously with `--no-verify`; pushing pre-approved.
- CI verification explicitly waived by the user for this loop.
- Authoritative suite runs on `ssh lidge`, not the local workstation.
- Parallel subagents pre-approved: `gpt-5.6-sol` medium for code decode/audit,
  `gpt-5.6-luna` low for web discovery.
- One decade doc per implementation phase; one phase per PABCD cycle.


## Audit trail

The first draft of this unit was submitted to an adversarial `gpt-5.6-sol`
reviewer instructed to falsify it. It returned **FAIL with ten findings**, all of
which were re-verified against source before being accepted. The unit was
corrected rather than defended:

| # | Finding | Resolution |
|---|---------|------------|
| 1 | `001` put arg buffering on `toolCallDelta`; it happens on `partialToolCall` (`protobuf-events.ts:1254`) | table corrected |
| 2 | `003` presented two terminal rows as unconditional; both are `expectedClose`-conditional | table corrected |
| 3 | `010` claimed a typed error makes the turn retryable; `committed` is set on HTTP/2 `connect` (`live-transport.ts:780`) so `canRetry` can never be true | claim withdrawn, retry test removed |
| 4 | `010` wanted `finalizeTurnEvents` **and** `settleFail`, producing a double terminal | transport named sole terminal owner |
| 5 | `010` equated `state.terminated` with a real `turnEnded`; the synthetic client-tool finalize also sets it (`:386`, `:750`) | meaning corrected, test 4 added |
| 6 | `002` claimed image loss is the direct cause of resets; no live trace supports it | causal claim withdrawn |
| 7 | `020` planned to reuse the MCP base64 decoder; `OcxImageContent` carries a `data:` or remote URL (`types.ts:156`) | data-URL parser specified, remote URLs scoped out |
| 8 | `020`'s per-image cap cannot bound one `ConversationStep`, which is stored as a single blob | conversation-level byte budget, newest-first |
| 9 | `030` claimed Grok gets no apply_patch guidance; `parser.ts:189` already attaches per-property guidance | root cause downgraded to "lossy conversion, cause unproven" |
| 10 | `030`'s guidance would fire for every `openai-chat` provider and could demote a sibling edit tool | xai-scoping attempted; round 2 finding 1 then showed the identity seam does not exist, and finding 3 showed the sibling predicate is undefinable — see the round 2 table |

Findings 3, 4, 5, 9, and 10 were load-bearing: acting on the original plan would
have produced a double-terminal bug, a test that could never pass, and a prompt
change leaking into unrelated providers.

## Open follow-ups (deliberately not in this unit)

- **Non-streaming reports a terminal-less turn as `completed`** (`bridge.ts:1829`).
  Real, but fixing it needs evidence about whether Cursor ever legitimately ends
  a stream without `turnEnded`; a wrong guess fails healthy turns. Not smuggled
  into `010`.
- **User-message images are placeholdered** (`request-builder.ts:201`,
  `protobuf-request.ts:314`) although `SelectedImage` supports blob/inline data.
  Separate capability, separate unit.

### Round 2

The corrected unit was submitted to a second independent adversarial reviewer,
which confirmed the `001`/`003` corrections and found `010` coherent,
regression-free, and implementable — then returned **FAIL with seven further
findings** on the other documents:

| # | Finding | Resolution |
|---|---------|------------|
| 1 | `030`'s xai-only gate is not implementable where it was placed: the adapter factory never receives a provider name (`adapters/registry.ts:15-17`, `server/adapter-resolve.ts:51-52`) | threading provider identity is now declared in-scope for `030`; its isolation test must use the **same base URL** so host sniffing cannot fake a pass |
| 2 | `020`'s decoded-byte budget still cannot bound a serialized `ConversationStep`, so a near-limit text result plus an image could newly fail | bounding moved **after** serialization: measure, degrade images, re-serialize; added a near-limit regression test and a byte-identical no-image test |
| 3 | "sibling edit-capable tool" has no decidable predicate (`types.ts:206-224`, `tool-catalog-nudge.ts:12-17`) | gate dropped; the note now describes call shape instead of claiming exclusivity, so no predicate is needed |
| 4 | `020` would tighten `parseDataUrl`, which Anthropic, Google, and Command Code share (`adapters/image.ts:8`) | a new strict helper is layered **on top of** the shared parser; the shared contract is untouched |
| 5 | `030` misstated xAI support: custom function calling is demonstrated via `/v1/responses`, and object-root schemas are still required | corrected; option 3 must also distinguish the API-key surface from the OAuth CLI proxy |
| 6 | `000` overstated F3 as proven and recorded xai isolation as resolved | F3 downgraded above; the round-1 row now points at findings 1 and 3 |
| 7 | `004` conflates Connect end-stream framing with gRPC-web trailers | terminology corrected in `004`; the sources are kept as protocol-principle context, not as claims about this transport |

Round 2 mattered most where it was least comfortable: findings 1 and 2 each
showed a *correction* from round 1 was itself unimplementable. That is the
argument for auditing revisions rather than only first drafts.

### Round 3

A third reviewer confirmed that F3 is now stated honestly and that `004`'s
Connect/gRPC-web disambiguation is correct, then returned **FAIL with five
findings** — every one a refinement of a round-2 correction:

| # | Finding | Resolution |
|---|---------|------------|
| 1 | `020` never wires its degrade loop to the real limit authority; `BLOB_MAX_ENTRY_BYTES` is private and test-overridable (`native-exec.ts:91`, `:122-126`) | the effective limit is exported and passed, so the degrade loop and admission cannot drift |
| 2 | `030`'s identity seam covered one construction site; adapters are rebuilt on retry/rotation (`core.ts:584` and seven more) | identity is mandatory at the route-resolver boundary; a reconstruction test is added |
| 3 | Same-base-URL isolation does not prove identity gating; auth mode or headers could discriminate | the isolation test now uses an identical `OcxProviderConfig`, varying only identity |
| 4 | "cannot demote a sibling tool" is an unsupported behavioral claim | wording shape specified (conditional, never "prefer"); residual risk recorded as live-test-dependent, not disproved |
| 5 | The xAI paragraph was still too absolute | restated as a claim about the *documented contract*; object root or `anyOf`/`oneOf` branches are permitted |

Also folded: test 8's byte-identical comparison must freeze `crypto.randomUUID()`
(`protobuf-request.ts:509`, `:592`) or compare deterministic nested step bytes.

The finding count fell 10 -> 7 -> 5 and the severity fell with it: round 3 found
no unimplementable design, only under-specified ones. `010` has now been judged
coherent, regression-free, and implementable by two independent reviewers.

### Round 4

The fourth reviewer confirmed the round-3 corrections landed correctly and that
`010` tests 1, 2, 4, 5 are writable against current fixtures, then returned
**FAIL with one blocker and four refinements**:

| # | Finding | Resolution |
|---|---------|------------|
| 1 **BLOCKER** | `010` could still double-error: `recordToolCall` emits unknown-tool/limit errors WITHOUT setting `state.terminated` while leaving earlier calls open (`protobuf-events.ts:1103`, `:1107`; pinned by `tests/cursor-protobuf-events.test.ts:534`), so the EOF branch would add a second terminal via `cursor.ts:180` | predicate widened to no-terminal-of-any-kind with an explicit emitted-error flag; test 6 added |
| 2 | `010` test 3 rationale overstated: normal synthetic suspension finalizes with an empty call set (that is test 4) | fixture clarified - reach `expectedClose` plus an open call via an error-triggered cancellation with an open sibling |
| 3 | `030` still chose option 2 and kept implementation Done criteria despite the unreproduced symptom | option 2 made explicitly conditional on reproduction; measurement exit criteria added ahead of implementation criteria |
| 4 | The code-mode-disabled probe has no harness: every routed catalog row is stamped `code_mode_only` (`src/codex/catalog/parsing.ts:424`) | harness must be named before probing - direct Responses fixture or controlled catalog override |
| 5 | `000` still labelled phase 3 as does-not-use-apply_patch and claimed every finding gets an implementation phase | document map and summary corrected |

Finding 1 is the one that justifies four rounds. It is the **same double-terminal
defect round 2 caught**, surviving in a path neither of us had looked at: the
corrected predicate was right about `turnEnded` and the synthetic finalize, and
still wrong about mapper errors. Rounds 2 and 3 had both already blessed `010`.

Trajectory: 10 -> 7 -> 5 -> 1 blocker plus 4 refinements.

### Round 5 — the round that changed the phase

Round 5 was asked to verify the round-4 blocker fix. It returned **FAIL with a
new blocker**, and the finding reframed `010` entirely:

The duplicate-terminal defect is **not something this phase would introduce.**
It already ships on `dev`. A mapper error from `recordToolCall`/`commitToolCall`
does not set `state.terminated` (`protobuf-events.ts:1100-1169`), so a later real
`turnEnded` passes the guard at `:1231` and emits a SECOND terminal at
`:1361-1376`. The same split exists for a mapper error followed by a Connect,
socket, abort, or budget failure: the queued error is yielded
(`live-transport.ts:611-623`), then `cursor.ts:180` emits the failure as another.

Widening the EOF predicate would therefore have made this phase's own tests pass
while two live instances of the same bug continued shipping next door.

| # | Finding | Resolution |
|---|---------|------------|
| 1 **BLOCKER** | Terminal ownership is incomplete across the whole turn, not just at EOF; two pre-existing duplicate-terminal paths | phase reframed around the invariant *exactly one terminal per turn*; the flag is consulted at three sites (EOF branch, message dispatch, failure throw); tests 7 and 8 added and must be shown red on the unmodified tree |
| 2 | The flag cannot be set from `cursor.ts` without threading new state through `runCursorTurnWithRetry` (`transport.ts:5-14`) | seam moved to the transport's own `push` (`live-transport.ts:531-535`), where queue admission guarantees delivery |
| 3 | All six tests were constructible but none covered the blocker; fixtures named | fixtures adopted into `010`; tests 7 and 8 added for the pre-existing paths |
| 4 | Test 3 cannot isolate the `expectedClose` conjunct, since its setup necessarily emits an error | kept as a path regression with that limitation stated, not as proof of that term |

**Why five rounds was not excessive.** Each round found a defect the previous
round had blessed: rounds 2 and 3 both declared `010` coherent and
regression-free, round 4 found it could double-error, and round 5 found the
double-error was already in production. The trajectory 10 -> 7 -> 5 -> 1 -> 1 is
not converging noise; the count fell while the severity of what was found rose.

Scope note: `010` now fixes a defect that predates this unit. That is an
expansion beyond the original F1, adopted deliberately because the narrow fix
would have been indistinguishable from a real one while leaving the class alive.

### Round 6 - reversing round 5

Round 6 audited the reframed `010` and **disproved round 5 premise**.
Verified independently before accepting:

- The bridge ALREADY enforces terminal singleness: streaming cancels upstream at
  the first terminal (`bridge.ts:1248`), batch ignores later events after the
  first error (`:1619`).
- `tests/bridge-terminal-singleness.test.ts` exists for exactly this and covers
  error-then-done, done-then-error, and producer abort. Run locally: **3 pass, 0 fail**.

So a second ADAPTER terminal never becomes a second PROTOCOL terminal. Round 5
tests 7 and 8 would have been red at the adapter boundary and green at the
boundary users observe - a regression test for a bug nobody can see.

| # | Finding | Resolution |
|---|---------|------------|
| 1 **BLOCKER** | The invariant was stated at the wrong boundary; protocol-level singleness is already enforced and tested | `010` reverted to its narrow F1 scope; the round-5 scope expansion is recorded as an error |
| 2 **BLOCKER** | The `push` seam is not turn-wide: adapter-owned errors bypass it (`cursor.ts:127` abort, `:180` throw) | the flag is retained ONLY as a local guard for the EOF branch, where every mapper terminal does pass through `push` |
| 3 **BLOCKER** | A genuine zero-terminal path exists: an unexpected `NGHTTP2_CANCEL` is thrown (`live-transport.ts:619`) but treated as benign and swallowed (`cursor.ts:181`) | recorded as a follow-up below, NOT absorbed into this phase |

**What rounds 5 and 6 taught together.** Round 5 argued for widening scope on a
defect it had proven at the adapter boundary; round 6 showed that boundary is not
where the contract lives. A finding can be technically accurate and still point
at the wrong layer - which is why the reversal was accepted rather than split
down the middle. `010` is now smaller than it was three rounds ago.

Added to the open follow-ups: the `NGHTTP2_CANCEL` zero-terminal path
(`live-transport.ts:619` throws, `cursor.ts:181` swallows), confirmed by a fresh
probe to produce zero adapter events. Separate defect, separate unit.

## Implementation status (2026-08-17)

| Phase | Outcome | Evidence |
|-------|---------|----------|
| `010` clean-EOF terminal | **SHIPPED** `54f68daf5` | 7 audit rounds; red-before-green proven; lidge 608 pass/0 fail |
| `020` tool-result images | **SHIPPED** `878b067e8..cc906b0fc` | 5 review rounds; byte-equality with `4e167fd38` verified twice; lidge 624 pass/0 fail |
| `030` xai apply_patch | **NOT REPRODUCED** | live probe: both `xai/grok-4.6` and `cursor/grok-4.6` used `apply_patch` successfully |

### What shipped for 010

A framed Cursor stream that ends with no terminal while a client tool call is open
now fails with `CursorStreamTruncatedError` instead of settling as success. Before
this, the deferred tool call emitted nothing at all: streaming degraded to
`response.incomplete`, and the non-streaming path returned `"completed"` for a turn
whose tool call had silently vanished. `expectedClose` (client-tool suspend) and an
already-emitted terminal stay graceful.

### What shipped for 020

The Cursor ENCODER now emits tool-result images as real `McpImageContent`. The final
design differs from the original plan in three ways, each forced by a review that
proved the plan would have broken a working request:

1. **Bounding is post-serialization, not a byte budget.** A step is one blob shared
   with the call's arguments, text, and framing, so `toolCallStep` serializes and
   re-serializes with fewer images (oldest dropped first) until it fits the live
   `cursorBlobMaxEntryBytes()`.
2. **Placeholders are capped to the legacy string length.** A longer replacement text
   could itself push a previously admissible step past the ceiling.
3. **Consecutive text is newline-joined into one item**, as the legacy encoding did.
   Emitting one protobuf item per part added framing that overflowed at the boundary.

The net invariant, verified by two independent reviewers across 300 adversarial
probes: **a tool result with no images serializes byte-identically to the
pre-feature encoding.**

### Why 030 did not ship

A live probe spawned `xai/grok-4.6` and `cursor/grok-4.6` as subagents on the same
edit task. Both edited the file and both reported using `apply_patch`. The symptom
this phase was written to fix did not reproduce, so no code was written. The
measurement cycle in `030` stands, and the phase closes NOOP unless the user
supplies a failing case. Note the probe did not isolate the top-level freeform
surface — the cursor agent reached `apply_patch` through code mode — so this is
"not reproduced", not "proven absent".

## Final status — all phases

| Phase | Outcome | Verified |
|-------|---------|----------|
| `010` clean-EOF terminal | **SHIPPED** `54f68daf5` | 7 rounds; lidge 608/0 |
| `020` tool-result images | **SHIPPED** `878b067e8..cc906b0fc` | 5 rounds; byte-equality verified twice; lidge 624/0 |
| `030` xai apply_patch | **NOT REPRODUCED** | live probe: both providers used `apply_patch` |
| `040` server-side cancel | **SHIPPED** `f145fd513..c9681d043` | lidge 630/0 |
| `050` terminal-less turns + #422 | **SHIPPED** `aa800ae65..1651002c5` | 8 rounds; lidge 12800/0 across 830 files |

Final full suite at `1651002c59`: **12800 pass / 0 fail**, typecheck clean.
Pre-campaign baseline was 12761/0 across 826 files.

### What the campaign actually found

The user's report was "Computer Use keeps disconnecting mid tool call". The decode
found three distinct ways a Cursor turn could lose work, and the last one turned
out not to be Cursor-specific at all:

1. A clean stream EOF dropped an open tool call and reported success (`010`).
2. Every screenshot reached the model as placeholder text, though the wire had
   always supported images (`020`).
3. A cancel Cursor sent us was indistinguishable from one we sent, so the turn
   vanished entirely (`040`).
4. Underneath all three: the bridge reported a turn with no terminal as
   `completed` — and on a compaction turn installed its partial output as
   replacement history (`050`). That one affected every provider.

The xai `apply_patch` symptom did not reproduce when probed live, so no code was
written for it.

### Remaining follow-ups

- **Kiro** `completionMode: "disabled"` and **ordinary Google mode** erase
  truncation reasons before the bridge can act (`050`). Adapter-side, each its
  own unit.
- **User-message images** are still placeholdered although `SelectedImage`
  supports blob/inline data (`002`). Separate capability.
- **`030`** stays open as a measurement cycle pending a reproducible failing case.
