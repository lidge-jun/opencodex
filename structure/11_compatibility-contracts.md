# Compatibility Contracts SOT

## Purpose

Compatibility manifests state what one exact provider, adapter, authentication mode, inbound
protocol, upstream protocol, and model set does with a feature. They do not infer that every model
using the same adapter has identical behavior.

The initial contract is intentionally narrow: canonical `openai` Codex-login forwarding for
`gpt-5.6-sol` over the `openai-responses` adapter. Later providers or models need their own fixture
evidence before they can be added.

## Files

| Path | Responsibility |
| --- | --- |
| `src/compatibility/manifest.ts` | Versioned schema, wire classifications, and fail-closed validation. |
| `src/compatibility/openai-responses.ts` | First bundled compatibility manifest. |
| `src/compatibility/index.ts` | Manifest catalog for future CLI and GUI readers. |
| `tests/fixtures/compatibility/` | Secret-free request vectors and assertion-level expected behavior. |
| `tests/compatibility-manifest.test.ts` | Executes fixtures against production adapters and proves every claim has evidence. |

## Dispositions

| Disposition | Meaning |
| --- | --- |
| `passthrough` | The relevant semantic value reaches the upstream representation unchanged. |
| `translated` | OpenCodex deliberately represents the feature differently while preserving its purpose. |
| `degraded` | OpenCodex keeps useful information but cannot preserve the complete original semantics. |
| `unsupported` | The feature is removed or rejected for the exact declared subject. |

`translated`, `degraded`, and `unsupported` claims require a concrete limitation. Every fixture
claim names exact assertion IDs; a test-file name alone is not evidence because it can stay green
after the relevant assertion is deleted.

## Runtime boundary

Compatibility manifests are passive data. The Responses request path, router, and server startup do
not import them. A future `ocx compatibility explain` or GUI reader may load the catalog on demand,
but adding a manifest must not activate Compatibility Lab or alter dispatch behavior.

[Decision Log]
- 목적과 의도: Make provider compatibility explicit and machine-readable before larger routing or Responses refactors.
- 기존 구현 및 제약 조건: Adapter-wide conformance tests already protect tool translation, and Compatibility Lab owns broader protocol evidence, but neither publishes an exact provider/auth/model claim table. Lab must remain outside the ordinary request import graph.
- 검토한 주요 대안: Infer capabilities directly from registry flags; publish prose only; add a broad all-provider matrix immediately; introduce the schema with one exact fixture-backed subject.
- 선택한 방식: Add a passive versioned schema and one exact `openai`/forward/`gpt-5.6-sol` manifest whose claims reference assertion-level fixtures executed against the production adapter.
- 다른 대안 대신 이 방식을 선택한 이유: Registry flags do not capture transformations such as local continuation expansion or orphan-output degradation. A broad first matrix would turn unverified assumptions into public promises.
- 장점, 단점 및 영향: The first contract is small but trustworthy and can feed future CLI/GUI surfaces. Coverage expands only as fixtures are added; no request behavior changes in this slice.
