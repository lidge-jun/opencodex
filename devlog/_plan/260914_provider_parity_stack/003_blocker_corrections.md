# Blocker corrections — authoritative over the decade docs

Independent coordinator review raised material blockers against the first draft of
this unit. Where this document and a decade doc disagree, **this document wins**.
Each correction was re-verified against source in this worktree before adoption.

## C0 — verification status, corrected

The first draft of `000_plan.md` presented a verifier table with exit codes as if
this session had run them. It had not. That prefill is withdrawn.

**Standing user instruction: no local product check may run on this Mac.** No
`bun test`, `bun run test`, `typecheck`, `build`, `lint`, `structure:check`,
`privacy:scan`, prepush script, or `cxc receipt test` is executed by this session.
Every such gate is reported as **NOT RUN BY USER INSTRUCTION**, never as passing,
provisional, or assumed. Layers publish as **DRAFT** on that basis.

What real evidence exists:

| Check | Result | Provenance |
|---|---|---|
| `bun run typecheck` | exit 0 | **coordinator baseline** at `df7dc1be53`, before this unit's changes — `.tmp/provider-parity-control/baseline-typecheck.log` |
| `bun run structure:check` | exit 0, "structure/ SSOT checks passed" | coordinator baseline, same commit — `baseline-structure.log` |
| `bun run privacy:scan` | exit 0, "Privacy scan passed" | coordinator baseline, same commit — `baseline-privacy.log` |
| this unit's changes | **NOT RUN** | forbidden on this host |

Those three are a baseline of unmodified source, not coverage of anything this unit
adds. Documents were untracked at that observation, so they do not evidence new-file
coverage either.

`structure:check` is also described more narrowly now: it validates the structure
index, path and invariant integrity. It does **not** prove that every owning doc was
updated alongside its source area. The earlier wording overclaimed what it observes.

Remaining evidence paths, in the order this unit uses them: hosted GitHub Actions at
the exact pushed head, and independent static review through Aside. Red-first
execution is impossible under this restriction, so regression tests are written to
assert desired behavior and reviewed statically instead of being run red.

## C1 — F2 belongs at the final target, not the ingress

The draft deleted controls in `src/server/chat-completions.ts` based on
`settledRoute`. That is wrong, and it is a data-loss bug in both directions.

`settledRoute` is the route settled at Chat ingress. A combo or policy route
resolves its concrete child later in the Responses pipeline, so an ingress-time strip
mutates shared intent before the real target is known: a canonical-first combo that
falls back to a key gateway has already lost the caller's controls, and a
non-canonical-first combo that falls back to canonical still ships them.

Verified final-target site: `stripUnsupportedForwardParams`
(`src/adapters/openai-responses.ts:1279-1287`) is applied to `outBody` at
`:2253`, inside `if (forward)`, after the concrete provider is known. It currently
drops only `max_output_tokens` and `metadata`, and it returns a copy, so
`parsed._rawBody` stays caller-owned.

**Corrected design.**

1. `src/server/chat-completions.ts`: keep `internalBody.store = false` for every
   `openai-responses` route. Remove the `delete` of `max_output_tokens`,
   `temperature`, `top_p`, `stop` and `user`. No adapter-string branch remains at
   the ingress.
2. `src/adapters/openai-responses.ts`: extend the existing final-target sanitizer so
   the canonical ChatGPT backend still rejects nothing it rejects today. The
   `max_output_tokens`/`metadata` drop stays applied to every `forward` provider,
   because that is its current, separately-owned behavior and widening or narrowing
   it would collide with `#4528`. The sampling controls `temperature`, `top_p`,
   `stop` and `user` are removed **only** under
   `isCanonicalOpenAiForwardProvider(provider)`, alongside the existing
   canonical-only block at `:2255-2260`, and non-mutatingly.

This preserves generic key-gateway and custom-forward compatibility, and it decides
on the provider that actually receives the body.

Directional combo tests are required, not optional: canonical-first falling back to a
key gateway must retain the caller's controls, and non-canonical-first falling back
to canonical must have them removed.

## C2 — F3 must not silently ignore an explicit schema

Two draft errors. `!isImageCapableModel(...)` silently dropped a caller's schema on
image-capable models, reintroducing the exact defect F3 fixes. And Cloud Code Assist
was described as upstream-unsupported, which is not established.

**Corrected.** An image-capable model with **no** schema keeps today's
`responseModalities` image behavior untouched. An image-capable model **with** an
explicit schema gets a scoped, content-free error rather than silence. Cloud Code
Assist is described exactly as it is: **not implemented or verified by opencodex**,
not proven impossible upstream. A malformed or absent `json_schema.schema` is
validated through the existing parser path rather than silently downgraded to plain
JSON mode.

**Field contract, recorded explicitly.** Google's current guide shows REST
`generationConfig.responseFormat.text.{mimeType,schema}`, while the same guide's Go
examples, the Firebase `GenerationConfig` reference, and the Gemini Enterprise tool
reference all still document `responseMimeType` + `responseJsonSchema`; Google Cloud
REST marks the older pair deprecated but not removed. This unit emits
`responseMimeType: "application/json"` plus `responseJsonSchema`, because that pair
is documented as raw JSON Schema — matching the IR's OpenAI-style schema without a
type-case translation — and is still accepted. `responseSchema` is deliberately
omitted, as the Firebase reference requires when `responseJsonSchema` is used. The
tool-parameter sanitizer is not applied to an output schema.

## C3 — F5 must not throw in the shared parser, and a marker is not a fix

The draft claimed native raw passthrough never enters the parser. That is false:
`src/responses/parser.ts:570` sets `_rawBody: body`, and the Responses adapter
forwards `parsed._rawBody` (`src/adapters/openai-responses.ts:2226`, `:2410`).
The request does pass through `parseRequest`; the adapter simply forwards the raw
body afterwards.

Consequence: a throw inside `inputContentParts` would regress legitimate raw
Responses passthrough, including `runTurn`, compaction and sidecar paths, not only
HTTP `buildRequest`.

**Corrected.** The shared parser stays non-throwing and gains recognition only.
Refusal belongs to the adapters that cannot carry the payload, as a content-free,
target-local error naming the modality and never echoing bytes, a URL, or a
client-controlled format string. Unknown and malformed parts keep their existing
tolerant behavior deliberately.

**A marker is not payload support.** F5 audio is therefore **not** claimed as fixed.
Recognition plus explicit target-local refusal is the deliverable; real audio
transport stays an explicit residual (`050_residuals.md` R2).

## C4 — F9 must fix both branches

The draft fixed only the image-bearing branch and called the text-only branch
correct. It is not: at `src/adapters/openai-chat.ts:786-787` a video-only or
text-plus-video message joins `(p as OcxTextContent).text` over a video part,
yielding `""`, and the message is then dropped. That is the reported defect left in
place, and the draft's acceptance row asserted the silent loss as success.

**Corrected.** Both branches handle a video part. No acceptance row may assert a
silent drop as success. No universal "upstream does not support video" claim is
made — the statement is scoped to this adapter's Chat wire.

## C5 — F8 chronological provenance is an ordering change

Collecting history tool images without changing order does not produce chronological
provenance: current-message images are appended to `imageBlocks` before the history
loop runs (`src/adapters/coding-agent/protocol.ts:412`, `:424`, `:443-451`).

**Corrected.** Ordering is fixed deliberately so blocks follow conversation order,
and the regression uses two distinguishable images — one historical, one current —
asserting their relative position rather than only their count.

## C6 — file-map gaps

`src/adapters/kiro/payload.ts` was missing from the Layer 4 file map and is required:
the marker must be appended before `rawGroupText` is computed (`:292-293`), or
adjacency grouping rebuilds the turn from `texts` and discards it.

## C7 — scope boundary held open deliberately

"전부 수정" means no straightforward confirmed loss is left unaddressed. It does not
mean inventing vendor support. Actual vendor-tool execution stays off for
CodeBuddy and Qoder; a strict unsupported request is rejected rather than faked. A
full native client-tool bridge, and unverified gateway capabilities, are separate
feature work and are recorded as a boundary, not delivered here. No unverified
all-model vision declaration is added to any catalog. `#4511` stays untouched.
