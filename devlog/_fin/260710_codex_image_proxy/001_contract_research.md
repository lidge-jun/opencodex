# Contract research — Codex standalone image generation

Date: 2026-07-10
Scope: research only; no implementation diffs

## Proven causal chain

Current Codex does not expose the Responses hosted `image_generation` tool for this path. It advertises the local namespaced function `image_gen.imagegen`, dispatches that function inside Codex, then makes a second Images API call:

1. Tool declaration and direct exposure: `/Users/jun/Developer/codex/121_openai-codex/codex-rs/ext/image-generation/src/tool.rs:110-129`.
2. Generate-vs-edit dispatch: the same file at `132-164`.
3. No references yields `gpt-image-2`, `background:auto`, `quality:auto`, `size:auto`: the same file at `259-280`.
4. References yield the JSON edit request with `images[].image_url`: the same file at `281-327`.
5. The client posts relative `images/generations` or `images/edits`: `/Users/jun/Developer/codex/121_openai-codex/codex-rs/codex-api/src/endpoint/images.rs:33-70`.
6. Relative paths append to the active provider base: `/Users/jun/Developer/codex/121_openai-codex/codex-rs/codex-api/src/provider.rs:52-85`.
7. Codex expects an Images response whose `data` entries contain required `b64_json`: `/Users/jun/Developer/codex/121_openai-codex/codex-rs/codex-api/src/images.rs:55-70`.

opencodex injects `openai_base_url = http://<host>:<port>/v1` and an equivalent provider table (`src/codex/inject.ts:76-96`). The relative call therefore becomes `/v1/images/generations` or `/v1/images/edits`. Neither route exists before the generic guard (`src/server/index.ts:292-350`).

## Competing hypotheses

### H1 — The running daemon is merely stale

Falsifier: current repository HEAD should already contain an Images handler.

Rejected. The daemon reported v2.7.1, but repository v2.7.4 still has no handler and its current test intentionally expects the generation path to return 404 (`tests/server-auth.test.ts:1020-1035`). Updating without a source fix cannot resolve the defect.

### H2 — Codex expects a hosted Responses `image_generation` tool

Falsifier: current Codex Responses tests should advertise hosted `image_generation` instead of the local namespace tool.

Rejected. `responses_lite_uses_standalone_web_search_and_image_generation` and `non_lite_uses_standalone_image_generation_by_default` assert the local namespace and absence of the hosted tool (`codex-rs/core/tests/suite/responses_lite.rs:204-245,382-418`).

### H3 — The missing standalone Images route is the root cause

Falsifier: Codex should hard-code another endpoint or the proxy should already match `images/*` before its guard.

Supported. `ImagesClient` appends exactly `images/generations` or `images/edits`, while opencodex handles neither and emits the observed 404.

## ima2-gen contrast

`ima2-gen` is a deliberately different image path:

- It sends `POST /v1/responses` with hosted `{type:"image_generation"}` and forces that tool (`/Users/jun/Developer/new/700_projects/ima2-gen/lib/responsesTools.ts:11-26`, `lib/responsesImageAdapter.ts:294-324`).
- It parses `image_generation_call.result` from Responses SSE/JSON (`lib/responsesParse.ts:326-349,430+`).
- Its direct `/v1/images/generations` route belongs to a different provider pipeline, not GPT OAuth (`structure/03-server-api.md:70`).

Therefore opencodex must not translate the Codex standalone call into ima2-gen's hosted-tool workflow. Codex itself owns the local tool call and expects a normal Images response.

## Official public OpenAI contract

Primary sources opened on 2026-07-10:

- <https://developers.openai.com/api/docs/guides/image-generation>
- <https://developers.openai.com/api/reference/resources/images/methods/generate>
- <https://developers.openai.com/api/reference/resources/images/methods/edit>
- <https://developers.openai.com/api/reference/resources/images>
- <https://developers.openai.com/api/reference/overview#authentication>

They confirm:

- `POST /images/generations` uses a JSON body and supports `gpt-image-2`.
- `ImagesResponse.data[]` can contain `b64_json`; GPT Image models return base64 image data.
- The public `POST /images/edits` contract uses multipart form data, unlike the private Codex/ChatGPT JSON edit request.
- Public API authentication is bearer API-key authentication. These pages do not document the private ChatGPT OAuth backend.

The public edit mismatch is a reason to preserve request bytes/content type, not to rewrite Codex JSON into multipart. Forward-mode behavior is governed by the source-proven Codex private contract. No claim is made that public docs prove the private backend.

## Existing opencodex patterns

- Data-plane gate order: `src/server/index.ts:295-316`.
- Account selection and auth override: `src/codex/auth-context.ts:74-151`.
- Forwarded header allowlist: `src/adapters/openai-responses.ts:6-27`.
- Provider URL/auth precedence: `src/adapters/openai-responses.ts:201-230`.
- Connection-reset retry exists at `src/lib/upstream-retry.ts:1-94`, but is intentionally not reused here: an Images POST can incur paid, non-idempotent work and no source-proven idempotency key exists.
- Client-cancel relay: `src/server/relay.ts:15-40`.
- Safe response-header relay: `src/server/relay.ts:508-533`.

Web-search and vision are not response-relay templates: both consume upstream failures into internal sidecar results. Remote compaction is also not a sufficient template because it omits reset retry, abort propagation, full header sanitization, and account health recording. Native Responses passthrough supplies the correct transport semantics, but none of its Responses-body transformations apply to Images requests.

## Selected design

Add exact POST routes for both standalone operations. A focused `src/server/images.ts` module will:

- deterministically select only an enabled `openai-responses` provider using `authMode: "forward"`, preferring eligible `defaultProvider`, then `openai`, then `chatgpt`, then stable configuration order;
- resolve the same thread-affined Codex auth context as normal turns;
- reject non-identity request content encodings, then stream-collect an opaque body while enforcing the byte ceiling before retaining each chunk;
- preserve content type and the approved Codex headers;
- call the provider base plus the requested Images suffix;
- make exactly one upstream attempt;
- relay status/body/safe headers, update pool-only health state, and abort on client cancellation both before and after response headers.

Keeping the body opaque supports both the current private JSON edit schema and any compatible multipart caller without inventing a lossy transformation.
