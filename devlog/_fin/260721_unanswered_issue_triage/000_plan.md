# Unanswered issue triage and fixes

This work validates the unanswered issues open on 2026-07-21 before changing code.

## Scope

- #190: Cursor rejects an aggregate Codex tool catalog with `resource_exhausted`.
- #181: provider deletion hides the server's actionable default-provider guard.
- #198: usage/log cost estimates can be mistaken for actual billing.
- #180 and #196: verify fixes already absorbed into `dev` instead of duplicating them.
- #177 and #178: verify whether the vendors expose a model-inference contract that fits an OpenCodex provider.

[Decision Log]
- 목적과 의도: Validate each report against current `dev`, fix confirmed defects, and leave evidence-backed issue replies.
- 기존 구현 및 제약 조건: Cursor registers client tools through a protobuf `McpTools` field with observed count and byte ceilings. The same filtered catalog must drive protobuf advertising and client tool-call recognition. GUI-visible text must be translated in every locale.
- 검토한 주요 대안: Import the closed #192 heuristic patch; drop whole namespaces by count; stub schemas and move them into prompt text; measure actual serialized definitions and prioritize recoverable tools.
- 선택한 방식: Measure the real serialized `McpTools` payload, enforce one hard count cap, prioritize explicit and `tool_search`-loaded tools, and skip oversized candidates while continuing to fill the catalog. Surface server delete errors directly and label cost values as non-billing list-price equivalents.
- 다른 대안 대신 이 방식을 선택한 이유: The closed patch undercounted protobuf bytes, could exceed the count cap through reserved tools, and did not reliably promote searched tools. Exact serialization removes those failure modes without inventing an incompatible schema-stubbing protocol.
- 장점, 단점 및 영향: The transport stays below both observed Cursor limits and searched tools become usable on the next turn. Some low-priority tools can still be omitted in very large catalogs, so the request includes an explicit recovery note when `tool_search` is available. Serialization adds bounded setup work once per Cursor turn.

## Verification plan

- Focused parser, Cursor request-builder/tool-definition/error tests.
- GUI lint, i18n lint, TypeScript build, and relevant existing tests.
- Full repository pre-push gate before pushing `dev`.

## Result

- #180 was already implemented on current `dev` as the complete `ocx account` command family. Its 41-case regression matrix passes; privacy-scan fixture strings were changed from token-shaped literals without changing behavior.
- #196 was already absorbed on `dev`; the registry and three Qwen 3.8 reasoning replay tests pass.
- #190 now budgets the exact serialized `McpTools` protobuf to 120,000 bytes and 330 definitions, prioritizes explicit/native and tool-search-loaded definitions, and classifies residual catalog exhaustion as HTTP 400 `tool_catalog_too_large` rather than a quota rate limit.
- #181 now displays the management API's structured delete error, with a translated fallback for network, empty, or malformed responses.
- #198 now labels dashboard cost values as API list-price equivalents rather than charges in English, Korean, German, and Chinese, with matching public documentation.
- #177 and #178 remain feature requests: Warp documents an asynchronous Oz agent-run API, while Factory documents configuring upstream model gateways for its own client. Neither public contract is an OpenAI-compatible model-inference endpoint that can be registered as an OpenCodex provider without a new adapter contract.

## Verification result

- Full repository suite: 3,296 passed, 0 failed before the fixture-only privacy repair.
- Post-repair focused suite: 94 passed, 0 failed for Cursor error/catalog handling, request logging, and the #180 CLI matrix.
- Root TypeScript typecheck passed.
- GUI ESLint, i18n lint, and production build passed.
- Privacy scan passed.
- React Doctor full scan completed; it reported the repository's existing baseline (197 diagnostics, including one pre-existing `Models.tsx` state-updater error). No new diagnostic was introduced by these changes.
