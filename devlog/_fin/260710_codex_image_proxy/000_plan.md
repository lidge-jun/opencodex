# Codex standalone Images proxy repair

Date: 2026-07-10
Status: DONE — source repair implemented, verified, and ready for archival
Work class: C4 (new data-plane API contract + OAuth credential forwarding)

## Loop specification

- Archetype: spec-satisfaction repair.
- Trigger: Codex `image_gen.imagegen` called `POST /v1/images/generations` through opencodex and received `404 Unknown endpoint`.
- Goal: make Codex standalone image generation and edit calls traverse opencodex with the same authenticated upstream contract Codex uses without the proxy.
- Non-goals: change `codex-rs`; change `ima2-gen`; replace the standalone Codex tool with the Responses hosted `image_generation` tool; add image generation to non-OpenAI providers; redesign account routing; publish or release a package.
- Verifier: focused Bun integration tests, the affected server/auth suite, full `bun test ./tests/`, `bun run typecheck`, `bun run privacy:scan`, and an endpoint activation probe that reproduces the original path against the patched source.
- Stop condition: both image routes proxy correctly, auth/header invariants are proven, upstream failures remain faithful, unrelated `/v1/*` paths still return JSON 404, and every verifier exits 0.
- Memory artifact: this implementation unit plus `structure/01_runtime.md` and `structure/04_transports-and-sidecars.md`.
- Expected terminal outcomes: `DONE` when all gates pass; `BLOCKED` if the private ChatGPT Images backend rejects the source-proven Codex contract; `UNSAFE` if supporting the path would require weakening local API auth or forwarding unbounded/unapproved headers; `NEEDS_HUMAN` only for deployment of the patched source into an externally managed installation.
- Escalation condition: two repairs with the same failing delta enter root-cause mode; three return to plan.

The cxc session `019f4a8d-53c2-7de1-b812-beed6d130796` could not be activated because its session file was absent. The user explicitly authorized a heuristic continuation. This devlog and the native plan tracker therefore carry phase state; no claim is made that the cxc FSM is active.

## Baseline

Fresh probe against the running proxy:

```text
POST http://127.0.0.1:10100/v1/images/generations
HTTP 404
{"error":{"message":"Unknown endpoint: POST /v1/images/generations","type":"not_found","code":"not_found"}}
```

The source has handlers for `/v1/responses/compact` and `/v1/responses`, then sends every remaining `/v1/*` path to the JSON 404 guard (`src/server/index.ts:292-350`). The existing regression explicitly lists `/v1/images/generations` among paths that must return 404 (`tests/server-auth.test.ts:1020-1035`).

## Dependency-ordered work-phase map

### WP1 — Standalone Images data plane

Detailed design: `010_wp1_standalone_images_proxy.md`

1. Lock generation/edit/auth/error contracts with failing integration tests.
2. Add a focused Images proxy owner and route both exact POST paths before the generic guard.
3. Preserve request content type/body bytes and selected Codex account credentials while keeping the upstream host fixed by trusted provider config.
4. Synchronize maintainer and public endpoint documentation.
5. Run the full verification and security gates.

This is one independently verifiable work phase. Research and implementation are split into separate numbered documents; they are not separate work phases.

## Acceptance criteria

1. `POST /v1/images/generations` reaches `<forward-provider-base>/images/generations`, keeps the incoming JSON payload, and returns an `ImagesResponse` containing `data[].b64_json` unchanged.
2. `POST /v1/images/edits` reaches `<forward-provider-base>/images/edits`. Codex's JSON `images[].image_url` body is preserved; multipart content types are not rewritten if a compatible caller supplies one.
3. Both routes execute the existing drain, local data-plane API-auth, and origin gates before upstream work.
4. Thread-affined pool credentials replace inbound main-account credentials exactly as they do for `/v1/responses`; authorization and account IDs are never logged or returned.
5. Provider selection is deterministic and credential-safe: enabled `openai-responses` + `forward` providers only, in `defaultProvider`, `openai`, `chatgpt`, then stable config order. API-key and OAuth providers are never eligible.
6. Only the existing forwarded-header allowlist plus the request's `content-type` and Codex provider `version` header cross the boundary. Provider static headers are applied before selected runtime credentials so runtime auth wins. Every non-identity request `content-encoding` returns 415 before upstream work.
7. A streaming collector counts each chunk before retaining it and buffers no more than the existing 256 MiB data-plane bound. A numeric declared size is only an early-rejection optimization; malformed or missing declarations are decided by the actual stream. Oversize returns 413 with zero upstream attempts.
8. Each paid Images POST has exactly one upstream attempt, including connection-reset failures. Client cancellation aborts before response headers, and cancellation after headers cancels the relayed upstream body.
9. Pool-account 429/5xx/connect failures update existing upstream-health state; main-account requests never mutate pool health.
10. Upstream status, body, and safe headers are relayed; stale compression/framing and cookies are stripped by the existing sanitizer.
11. `/v1/alpha/search`, `/v1/memories/trace_summarize`, and all other unknown `/v1/*` paths still return JSON 404.
12. No source or behavior changes occur in `codex-rs`, `ima2-gen`, web-search, vision, Responses transformations, or provider catalogs.

## Verification commands

```bash
bun test tests/images-proxy.test.ts
bun test tests/server-auth.test.ts tests/codex-auth-context.test.ts tests/upstream-retry.test.ts tests/passthrough-headers.test.ts
bun run typecheck
bun run privacy:scan
bun test ./tests/
git diff --check
```

The C gate also runs an endpoint-level activation probe against a patched in-process server. A live ChatGPT image call is optional evidence only if it can be made without changing the user's installed service or exposing credentials.

## Continuity / attestations

- P: root cause and contracts recorded in `001_contract_research.md`; trust-boundary controls recorded in `002_threat_model.md`; diff-level build plan recorded in `010_wp1_standalone_images_proxy.md`.
- A: the first independent review returned `GO-WITH-FIXES` with seven blockers; the first re-audit caught one invalid response-construction detail; the final same-reviewer re-audit returned `GO`. The synthesis and plan deltas are recorded in `003_audit_synthesis.md`.
- B: RED/GREEN implementation and the final file map are recorded in `011_implementation_and_verification.md`.
- C: focused and full automated gates, independent implementation review, real-wire HTTP QA, and teardown all passed. Evidence is recorded in `011_implementation_and_verification.md` and `.codexclaw/evidence/019f4a8d-53c2-7de1-b812-beed6d130796/qa/http-images/`.
- D: evidence consolidated; terminal outcome `DONE`. The active installed daemon was not restarted, as recorded in the implementation note.
