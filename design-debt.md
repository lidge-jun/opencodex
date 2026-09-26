# Scoped design debt

This audit covers the Meta Muse Responses tool-choice change only. All three modules below were swept against the design-review flags. It records confirmed findings only.

## Inventory

| Module | Role | Review |
| --- | --- | --- |
| `src/adapters/openai-responses/muse-tool-choice.ts` | Validates the caller's original and effective selector, then normalizes Muse's final request body. | Swept against the design-review flags. No confirmed findings. |
| `src/adapters/openai-responses/passthrough.ts` | Applies the normalizer at the final Meta Responses body boundary. | Full module swept. No confirmed findings. |
| `src/server/responses/passthrough-dispatch.ts` | Maps the compatibility error to an initial HTTP 400 before dispatch. | Full module swept. No confirmed findings. |

Provider registry and configuration modules are excluded. The selected design adds no provider
flag or persisted setting. Other adapters, transports, and request-selection paths are outside this
behavior's scope.

## Confirmed findings

| ID | Severity | Flag | Evidence | Smallest redesign | Status |
| --- | --- | --- | --- | --- | --- |
| - | - | - | No confirmed findings in the three-module sweep. | - | - |

Severity counts are S1: 0, S2: 0, S3: 0. No findings were refuted because none were raised. No
security findings are recorded here.

Audit date: 2026-09-27. Modules swept: 3. Modules inconclusive: 0.

The nose comparison covered 60 files in Responses normalization and provider registry code.
It retained 109 duplication families, with no new family. One recheck contained two unchanged
streaming accumulator regions whose line locations moved. Both regions were compared with `origin/dev`.
