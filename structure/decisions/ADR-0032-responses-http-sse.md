# ADR-0032 — decision recorded under "Responses HTTP/SSE"

- Contract owner: [transports/responses.md](../transports/responses.md#responses-httpsse)

## Decision record

- 목적과 의도: Keep transport helpers reusable without making every consumer evaluate the full routed Responses and sidecar graph at module load.
- 기존 구현 및 제약 조건: The original `responses.ts` split copied the monolith import header into `fetch-helpers.ts`; seven helper exports therefore retained 39 distinct runtime import specifiers and reached 326 modules even though the implementations used only three runtime dependencies.
- 검토한 주요 대안: Leave the imports because current modules have limited top-level side effects; move the helpers again; prune the copied imports and lock the direct runtime boundary.
- 선택한 방식: Preserve the file and all public exports, remove unused runtime edges, and enforce an explicit three-specifier allowlist with a source-level regression that also proves type-only imports are ignored.
- 다른 대안 대신 이 방식을 선택한 이유: Relying on unrelated modules to remain side-effect-free makes startup ownership accidental, while another move adds churn without changing the responsibility boundary.
- 장점, 단점 및 영향: Ordinary native Chat and compact consumers no longer load unrelated routing, combo, OAuth, web-search, vision, and relay modules through this leaf. The allowlist is intentionally strict, so a future helper that needs a new runtime dependency must make that ownership decision explicit in code, tests, and this document.
