# L4 — Responses private fields and conversation-history repair

Delivery lane R2-L4. One new implementation plus review of two contributor pull
requests. Local test execution is prohibited for this lane; every claim below is
backed by source reading and hosted CI at an exact head.

## Units

| Unit | Item | Kind | Write scope |
|---|---|---|---|
| U1 | #4853 `access_programs` reaches strict third-party Responses upstreams | new implementation | `src/adapters/openai-responses/request-strips.ts`, `src/adapters/openai-responses/passthrough.ts`, `structure/transports/responses.md`, one new test file plus its two layout entries |
| U2 | #4871 (closes #4870) xAI Responses tool-result adjacency | review and integrate a contributor PR | none — review only |
| U3 | #4848 (closes #4842) ollama-native deferred boundaries | review a contributor PR | none — review only |

U2 and U3 are separate authors' branches. They are reviewed, not reimplemented.
If anything has to be carried, a `Co-authored-by` trailer naming the original
author is mandatory; prose attribution is not equivalent.

## U1 — #4853

### What the client actually sends

Codex 0.155 added a top-level `access_programs` object to the Responses request
body. Upstream, `cyber_access_program::for_auth` gates it on ChatGPT auth alone
and never on the destination base URL, so loopback injection — which deliberately
keeps Codex's built-in `openai` provider identity while pointing it at this proxy
— leaves the field attached no matter where the proxy ultimately routes the turn.
The field is serialized on three upstream request shapes: the HTTP Responses
request, the compaction input, and the WebSocket `response.create` envelope.

Verified against the Codex checkout at `/Users/jun/Developer/codex/121_openai-codex`:

- `codex-rs/core/src/cyber_access_program.rs` — the auth-only gate.
- `codex-rs/codex-api/src/common.rs` — `AccessPrograms { cyber: &'static str }`,
  present on `ResponsesApiRequest`, `CompactionInput` and `ResponseCreateWsRequest`,
  each `skip_serializing_if = "Option::is_none"`.
- `codex-rs/core/src/client.rs` — assigned at the HTTP, compaction and WebSocket
  call sites.

No public specification defines the field, so a third-party gateway that validates
its top-level schema is correct to reject it. The reporter measured exactly that:
the same body 400s on `muse-spark-1.3-contributor` with the field and returns 200
without it, while `totally_made_up_param` 400s the same way and lenient models on
the same base URL return 200 either way.

### What the client does not send

The issue proposes also stripping `codex_output_schema`. Source reading does not
support that: in `codex-rs/codex-api/src/common.rs` the string
`"codex_output_schema"` is the `name` of the JSON-schema `text.format` object, not
a top-level request key, and no serde field carries that name. The reporter's probe
table used it as an arbitrary unknown-key probe alongside `totally_made_up_param`.
Adding it to a strip list would delete a key this client never sends and would
silently discard it for any other client that does send it meaningfully. It stays
out of the table, and the table comment records why.

### The boundary

The strip belongs at the existing noncanonical boundary in
`src/adapters/openai-responses/passthrough.ts`, beside
`stripInternalChatMessageMetadataPassthrough`, which solves the identical problem
one level down for the per-item private key
`internal_chat_message_metadata_passthrough`.

The predicate is `!isOpenAiOperatedResponsesDestination(provider)`, not the
`!isCanonicalOpenAiForwardProvider(provider)` its sibling uses. This reversed an
earlier decision in this document, and reading `src/server/responses/compact.ts` is
what reversed it: the native `/responses/compact` path spreads the caller's raw body
into the upstream request without passing through this adapter, and
`supportsNativeResponsesCompactEndpoint` offers that endpoint to the canonical
ChatGPT surface and to `openai-apikey` at `api.openai.com`. Stripping on the
canonical predicate would therefore make one provider behave differently on its two
endpoints for the same field, which is a new inconsistency in exchange for nothing
the report asked for.

The destination predicate fixes exactly the reported class — gateways this proxy does
not operate, which is where the 400 is observed — and leaves every OpenAI-operated
route byte-identical. Whether `api.openai.com` tolerates the field under an API key
is unverified, and this change does not have to answer it.

### Shape

A table, not a sanitizer. `CANONICAL_ONLY_TOP_LEVEL_FIELDS` mirrors the existing
`CANONICAL_ONLY_TOOL_FIELDS` table in the same file: one row per private key that
Codex is observed to attach, so the next one is a row rather than another bespoke
pass. Nothing generic is removed — an unknown key this lane has not traced to a
client is forwarded exactly as today.

`stripCanonicalOnlyTopLevelFields` returns its input unchanged when no listed key
is present, so the common path allocates nothing, passes non-objects through, and
never mutates the caller-owned raw body.

### Coverage

One place covers HTTP, WebSocket and compaction. `passthrough.ts` serializes
`finalBody` once and the WebSocket path transports that same request instead of
rebuilding it; `buildRoutedCompactionBody` runs later in the same pipeline on the
already-stripped body.

### Tests

`tests/responses/openai-responses-passthrough.test.ts` is the natural home and is
frozen at 4809 lines by the file-size ratchet, so the regression lands in a new
file with byte-identical entries in `scripts/test-layout/layout.json` (`explicit`)
and `tests/fixtures/test-layout-expected.json`. It pins four facts: a third-party
destination loses the field, the canonical ChatGPT forward surface keeps it, the
caller's raw body is not mutated, and an unlisted unknown top-level key is still
forwarded — the last one is what stops this from becoming a general sanitizer.

### Ownership

`structure/manifest.json` assigns `src/adapters/` to
`structure/transports/responses.md`, which already describes the noncanonical
private-field boundary and the `CANONICAL_ONLY_TOOL_FIELDS` table. It gains the
top-level table in the same change, as `structure:check` requires.

## U2 — #4871

Contributor branch `fix/xai-responses-tool-result-adjacency` (MerryEcho). It seeds
`requiresAdjacentResponsesToolResults` on the xAI registry entry and widens the
orphan-call repair so a non-forward adjacency provider synthesizes a placeholder
output for a `function_call` that has no matching output.

Review must resolve, with evidence:

1. `custom_tool_call` — whether the repair and the adjacency pass cover custom
   tool calls at all, and whether their position relative to
   `rewriteRoutedCustomToolsForUpstream` leaves a dangling custom call unrepaired.
2. The forward-auth rejection boundary — that the forward path is behaviorally
   unchanged by the rewritten condition.
3. Blast radius on the other adjacency providers (`kimi`, `kimi-code`,
   `deepseek`), which the widened condition newly enrolls in the placeholder
   repair.

Hard constraint: this repairs interrupted tool-call history. It must not disable
stateful operation to do so. xAI's Responses API stores conversations and documents
`previous_response_id`, so `statelessResponses` must stay unset and
`stripStatefulResponsesParams` must stay unreachable from the new condition. The PR
also does not claim to remove the first upstream reset, and should not be asked to.

### Outcome

Questions 1 and 2 came back clean. The repair and the adjacency pass both index and
emit `custom_tool_call_output`, and both run before
`rewriteRoutedCustomToolsForUpstream`, so a dangling custom call is paired first and
lowered as a pair. The forward path is byte-identical, because the synthesis flag is
`!forward && ...` in both versions. The hard constraint holds:
`stripStatefulResponsesParams` is reachable only under `if (stateless)`, xAI does not
set it, and `store` and `previous_response_id` survive.

Question 3 found a real defect. `kimi` and `kimi-code` hold the adjacency flag and
are neither forward nor stateless, so on `dev` the orphan repair never runs for them
at all; gating synthesis on that flag would have started inserting placeholder tool
turns into Kimi conversations. The evidence that this is wrong rather than merely
broader is in the report that introduced the flag: Kimi returned HTTP 200 for a call
with no result at all, so that shape is not one it rejects.

The distinction worth keeping is that adjacency reorders items the upstream would
accept in some order, while synthesis inserts an item the client never sent, which is
a claim about what happened in the conversation. Those are different promises and
should not share a flag. The fix adds `requiresPairedResponsesToolResults`, threaded
exactly like its sibling and seeded on `xai` only; `statelessResponses` implies it,
so DeepSeek keeps the repair it already had and Kimi returns to its `dev` behavior.

It was pushed as a follow-up commit onto the contributor's own branch, which
`maintainerCanModify` permits, so the pull request and its credit stay with its
author rather than moving to a lane-owned branch. Regressions were added for the
separation itself and for the custom-tool ordering, which was previously unpinned.
## U3 — #4848

Contributor branch `fix/ollama-native-deferred-boundaries` (briascoi). A separate
adapter, sharing no code path with U2, so it is not stacked under any Responses
work.

Review must confirm the change restores message order without dressing a tool call
that produced no result as a success: the synthesized message has to keep the
execution status visibly unknown, the deferred messages must all be released with
their order and multimodal content intact, and the orphan, duplicate and
mismatched-result guards must still throw.

### Outcome

No correctness defect. The synthesized message records unknown execution status in
wording identical to the chat wire's, the deferred list is FIFO and is released by
the post-loop flush even when the history ends with an open batch, multimodal
content survives, and all four strict guards still throw. State is request-local.
Independence from U2 is confirmed at the file level: no shared file, helper, or state
object, and separate adapter entries in `src/adapters/registry.ts`. The only comment
left is a documentation suggestion, not a gate failure.

## Operating constraints

- No local verification of any kind. No `bun test`, `bun run test`,
  `bun run test:changed`, `bun run typecheck`, `bun x tsc`, `bun install`,
  `bun run build:gui`, or `ocx`. A local suite previously deleted real
  `~/.opencodex` data. Evidence is source reading plus hosted CI at an exact head.
- Push with `git push --no-verify`; the pre-push hook runs the local suite.
- Merge, rebase and squash decisions belong to the dispatching session. This lane
  ends with pull requests open and exact-head CI evidence recorded.
- No flake management: no widened timeouts or budgets, no added retries, no
  platform skips, no masking. Windows jobs are dispatch-only.
- Repository artifacts are English and follow the issue and pull-request templates.
- Undisclosed security analysis goes to `.tmp/`, never to `devlog/`.
