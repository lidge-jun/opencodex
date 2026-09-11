# ADR-0095 — decision recorded under "Canonical forward continuation extensions"

- Contract owner: [adapters/compatibility-contracts.md](../adapters/compatibility-contracts.md#canonical-forward-continuation-extensions)

## Decision record

- 목적과 의도: Make provider compatibility explicit and machine-readable before larger routing or Responses refactors.
- 기존 구현 및 제약 조건: Adapter-wide conformance tests already protect tool translation, and Compatibility Lab owns broader protocol evidence, but neither publishes an exact provider/destination/auth/model claim table. Lab must remain outside the ordinary request import graph.
- 검토한 주요 대안: Infer capabilities directly from registry flags; publish prose only; add a broad all-provider matrix immediately; introduce the schema with one exact fixture-backed subject.
- 선택한 방식: Add a passive versioned schema and one exact `openai`/canonical Codex URL/forward/`gpt-5.6-sol` manifest whose claims reference assertion-level fixtures executed against the production adapter.
- 다른 대안 대신 이 방식을 선택한 이유: Registry flags do not capture transformations such as local continuation expansion or orphan-output degradation. A broad first matrix would turn unverified assumptions into public promises.
- 장점, 단점 및 영향: The first contract is small but trustworthy and can feed future CLI/GUI surfaces. Coverage expands only as fixtures are added; no request behavior changes in this slice.
