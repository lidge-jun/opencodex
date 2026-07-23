# 060 — PR #303: Document Cursor exec policy and catalog troubleshooting (DRAFT)

- Author: diegocantarero · base `dev` · +57/−13, docs-site only (3 files). Draft PR.
- CI: enforce-target pass; CodeRabbit skipped (draft).

## What it does

- codex-integration.md: new "Catalog troubleshooting" checklist (selectedModels →
  disabledModels → liveModels/models → Cursor GetUsableModels → cache TTL + `ocx sync`),
  plus an honest caution box about external local writers racing catalog files.
- configuration.md + adapters.md: documents the `nativeLocalExec: "off" | "codex-sandbox" |
  "on"` tri-state and demotes `unsafeAllowNativeLocalExec` to legacy-equivalent.

## Accuracy check against dev source

- `nativeLocalExec` tri-state exists (`src/types.ts:892`); "codex-sandbox" fail-closed matches
  `src/adapters/cursor/exec-policy.ts` comments; legacy-boolean precedence matches registry
  note (`src/providers/registry.ts:355`). Accurate.
- `selectedModels` (types.ts:735), `disabledModels` (types.ts:481), `modelCacheTtlMs`
  (types.ts:537) all real. Accurate.
- English-only: ja/ko/ru/zh-cn counterparts not updated — per repo policy translated locales
  must not contradict English source; additive sections are acceptable but ideally synced.

## Verdict: **APPROVE once undrafted** (optionally request locale sync as follow-up)

Low-risk docs improvement, verified accurate. Merge when the author marks it ready; locale
sync can ride a follow-up commit.
