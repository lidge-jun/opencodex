# LD — closure evidence for #4429 and #3719

Both issue bodies predate the commits that changed the answer. Each claim below was re-judged
against `origin/dev` at `2f025814f3`, by reading the current source rather than the issue text.
The host owns every close decision; this unit only supplies the evidence.

## #4429 — key-auth Responses gateway echoes hosted `web_search` as a client `function_call`

The report asked for two things, and named the shape of the fix itself: ship a non-Ollama executor
for `webSearchBridge` by reusing the existing sidecar executors, then have the intercepted call run
proxy-side and continue the conversation upstream so the caller sees a hosted `web_search_call`
cell.

| Ask | State at HEAD | Evidence |
|---|---|---|
| A non-Ollama key-auth gateway can arm the bridge | Delivered | `5b707d3a5c` |
| The intercepted call runs proxy-side and the conversation continues upstream | Delivered | `024e43ddf1`, `3557ada7de` |
| A leg mixing the search with a client-executed tool does not kill the turn | Delivered | `2e6a0316b9` (#4586) |
| The destination learns the executed result on the next turn | #4587, addressed by this lane's PR | — |

`planPassthroughWebSearchBridge` no longer returns early for a non-`ollama` backend. For
`openai`, `anthropic`, `xai`, `gemini` and `exa` it plans on the presence of that backend's own
resolved credential and never derives an Ollama Cloud origin, so an internal gateway on an
arbitrary base URL arms exactly as the reporter asked. The credential boundary #3761 called for
survives: only the `ollama` backend spends the passthrough provider's own API key, and a backend
whose credential is missing stays disarmed instead of falling through to a different paid search.

The hosted/client distinction the issue turns on is `isWebSearchCallItem` against
`isClientExecutedItem`. A namespaced `ns__web_search` is a tool identity the client declared and
executes itself, so it is never intercepted, and `web_search` is never added to the
undeclared-tool guard's allowed names — that would authorize a call nobody can execute rather than
removing it. The guard's authority over every other tool a destination emits is unchanged.

**Recommendation.** Closable once #4587 lands. One thing in the report is not resolved and is not
a code defect: whether the reporter's gateway auto-executes Kimi's builtin `$web_search` server
side and merely echoes the call. That needs a live probe the reporter offered to run. If the host
wants it tracked, it is a question to the reporter on the existing thread, not a separate defect.

## #3719 — Anthropic thinking replay through proxy-auth translation

The body states that the inbound translator drops assistant `thinking` and `redacted_thinking`
blocks on replay. That is false at HEAD.

| Checkbox | State at HEAD | Evidence |
|---|---|---|
| Implement Anthropic-to-Anthropic replay fidelity, preserving upstream signatures and opaque redacted blocks | Delivered | `4a59dbc2b7`, `58fcb0961d` |
| Verify a multi-turn thinking/tool-result exchange with both block types | Covered by regression tests | `tests/adapters/anthropic/anthropic-thinking-signature.test.ts` |
| Compare cache creation/read usage across controlled continuation turns | Not established | — |
| Document native passthrough eligibility separately from translated-route cache support | Delivered | `docs-site/src/content/docs/guides/claude-code.md` |

`src/claude/inbound.ts` encodes the Anthropic signature as `{sig}` and each opaque
`redacted_thinking` payload as `{red:[...]}` inside a bounded `ocxr1` envelope carried in
`encrypted_content`. `src/adapters/anthropic.ts` replays the redacted blocks verbatim first, in
the original stream order, then the signed `thinking` block.

The separation this lane was asked to preserve is real and enforced in code, not by convention.
`isLikelyRealAnthropicThinkingSignature` gates the outbound `thinking` block, so a value that does
not look like an upstream-issued signature is dropped rather than sent as one. Two specific
leaks are refused rather than generalized: the inbound translator rejects an `ocxr1` envelope
carrying `sig` that arrives in an Anthropic `signature` field, because proxy-minted reasoning
continuity must never be replayed as an Anthropic signature; and a native OpenAI-encrypted blob
has no `ocxr1` prefix, so the decoder returns null and it keeps its placeholder rather than being
laundered into a signature. Carrying signature data to a different provider stays out of scope.

**Recommendation.** Only the third checkbox is unproven, and it is a measurement rather than an
implementation: a controlled cache creation/read comparison across continuation turns with a
stable model, credential scope, prompt prefix, tool set and retention setting. It needs live
Anthropic traffic, which this lane cannot produce under the no-local-execution rule, and neither
the per-turn cache-miss claim nor its attribution to dropped replay blocks was ever reproduced —
in #3646 or here. The host's options are to close #3719 on the implemented and documented scope
and treat the unreproduced cache claim as not established, or to keep it open solely as a
measurement task. The public guide already states the honest position: replay preserves non-hidden
signed blocks and opaque redacted blocks on the intended Anthropic adapter, and that this does not
establish live Anthropic acceptance or cache-hit improvements. No documentation change is needed
for a close.

## Pull requests reviewed, not carried

- **#3952** mixes several changes. The part that touches this lane is a single guarded rewrite in
  the Responses passthrough: when `provider.modelSuffixBracketStrip` is set, the outbound `model`
  has its bracketed suffix stripped, detached before the write so the caller's raw body is not
  mutated. That much is sound and independent of the freeform-tool and Moonshot work in the same
  branch. It should be judged per change, not as one verdict.
- **#4783** targets `main` and is a draft. Within this lane's scope it adds an `openai-apikey`
  bridge backend and routes the bridge's reasoning setting through `resolveSidecarReasoning`
  instead of reading `sidecar.reasoning` directly. The backend addition is the same generalization
  #4429 asked for, so it overlaps that area; it needs to be retargeted to `dev` before any of it
  can be judged on merit.
- **#4900** belongs to another lane's Cursor work. Not duplicated here. Nothing in this lane's
  history-replay scope depends on it.
