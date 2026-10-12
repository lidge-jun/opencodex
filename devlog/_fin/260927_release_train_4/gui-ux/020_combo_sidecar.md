# Phase 020 — mixed combo Vision Sidecar enrollment (#4932)

**Decision:** reimplement the contributor's cohesive behavior after Phase 010, with attribution, against current `combo-routes.ts`. The old branch's GUI work is reusable, but its server route has a 200-success hole for a missing provider and can overwrite an image-capable declaration with text-only.

## Diff-level map

- **MODIFY** `gui/src/combo-capabilities.ts`, `combo-workspace-data.ts`, `components/combo-workspace-controls.tsx`, `pages/Combos.tsx`: permit image input when every member is known and text-only members can be declared; reject audio-only rows rather than treating every non-image row as text; name exactly which members receive a sidecar declaration; fail closed for unknown catalog entries; keep the primary save action and clear loading/error states.
- **MODIFY** all ten `gui/src/i18n/` locale modules, including the missing Vietnamese translations; no English-only hint in JSX.
- **MODIFY** `src/server/management/combo-routes.ts`: accept request-only `visionSidecarTargets`, validate exact member ownership, configured provider existence, current modality declaration and image-input gate before any mutation. Reject a missing provider or an already-image-capable submitted target instead of returning 200 after silently skipping/overwriting it. Write each eligible text-only `inputModalities` declaration into the provider map while preserving other capabilities, and do not persist the request-only field under `combos`.
- **MODIFY** `structure/catalog.md`, `structure/config.md`, `structure/dashboard-and-usage.md`, `docs-site/src/content/docs/guides/{combos,sidecars}.md`; **MODIFY** `tests/routing/combo-management-api.test.ts` and `tests/gui/combo-workspace-data.test.ts`; register any new files in both test-layout inventories.

## Activation and proof

In an isolated proxy, create a mixed combo from one image-capable and one text-only synthetic member; inspect the hint before save, save, then read back the per-model modality patch and combo behavior. Unknown member, disabled image input, non-member target, missing configured provider, already-image-capable submitted sidecar target and audio-only row each fail without config mutation or a false success receipt. Edit that model's capability through Phase 010 afterward and verify the combo state remains truthful. Browser proof includes desktop/400px, keyboard, empty/loading/error, and at least one long locale; screenshot before/after. Run focused regressions, `test:changed`, typecheck, GUI full tests/lint/build plus `cd gui && bun run lint:i18n` and `cd gui && bun test tests/locale-parity.test.ts`, structure/privacy and exact-head CI.

## Rollback and boundary

Do not overwrite sibling per-model context/reasoning axes. If the generated modality declaration cannot be distinguished from an operator's existing declaration, the implementation must preserve the existing one and explain that behavior; rollback must never delete operator-owned facts.

## P revalidation for `wp2` (2026-09-28, `dev` `3401e1ee73`)

Continuity: phase 010's D (`012_model_settings_done.md`) closed with #6105 merged and pointed here, adopting the explorer's corrections. That direction stands, with the corrections below.

**Corrected claims.** A missing configured provider is already rejected by `comboConfigError` before #4932's silent skip could run (`src/server/management/combo-routes.ts:225-231`, `src/combos/types.ts:275-281`). An explicit provider check stays as a guard, but there is no reachable 200 to fix. #4932 never persisted `visionSidecarTargets` under `combos`, because `stored` is built from the normalized combo. Both defects that do hold are kept: #4932 overwrites an existing declaration with `["text"]` (`mergeModelCapabilities`, `src/config/provider-validation.ts:419-432`), and it classifies audio-only rows as sidecar-eligible, although the runtime requires `text` (`src/vision/eligibility.ts:136-146`). It also lacks `vi.ts`.

**Enrollment mechanism, verified.** `isModelVisionSidecarConsumer` (`src/vision/eligibility.ts:136`) treats an exact `modelCapabilities[id].inputModalities` containing `text` but not `image` as a sidecar consumer. The catalog then advertises `image` for that row (`src/codex/catalog/model-hints.ts:285-294`), whether or not the sidecar is enabled. After enrollment, `GET /api/models` reports the member as image-capable, so the existing `comboImagesSupported` check passes on reload. Actually describing an image needs the sidecar enabled with a usable backend (`src/vision/plan.ts:195-217`).

### Decisions

1. **Server (`combo-routes.ts`).** Accept a top-level, request-only `visionSidecarTargets: {provider, model}[]` on combo create/update. Validate every target before any mutation:
   - The target is an exact member of the submitted combo.
   - The provider exists and is routed (not `openai` native or a combo).
   - The combo's `imageInput` is not `disabled`.
   - The member's existing declaration, read the way the runtime reads it (exact `modelCapabilities`, then the legacy record), is absent. An existing text-only declaration is a no-op. A declaration that includes `image`, or one that lacks `text`, is a 400; it is never overwritten.

   Write each `["text"]` declaration into a copied `modelCapabilities` row, preserving sibling capability fields, in the same `commitProviderPatch` transaction as the combo write, so there is one save. The field never lands under `combos` and is not echoed back.
2. **GUI classification (`combo-capabilities.ts`).** Each member is classed from its `/api/models` row as `image` (modalities include `image`), `sidecar` (known modalities with `text` and without `image`), or `blocked` (no known modalities, or no `text`). The Image input switch is available when no member is `blocked` and at least one member is `image` or `sidecar`. Saving with images on sends every `sidecar` member as a target.
3. **Hint (`combo-workspace-controls.tsx`).** When `sidecar` members exist, the hint names them exactly (`provider/model`) and says the Vision Sidecar will describe images for them. If `GET /api/sidecar-settings` reports the sidecar disabled, a warning line says images for those members need it turned on, linked to its settings. When a member is `blocked`, the hint names it and the reason (modalities unknown, or no text input), and the switch stays off. Save errors surface the server's rejection through the existing error path. The save stays one primary action.
4. **Copy.** New keys go into all ten locales, including `vi`.
5. **Tests.** `tests/routing/combo-management-api.test.ts` gets each rejection with config unchanged and no save: non-member target, disabled image input, image-capable or audio-only declaration, and native provider. It also covers the success write that preserves sibling fields, the text-only no-op, and the absence of the field under `combos`. `tests/gui/combo-workspace-data.test.ts` gets classification and request shape; a `gui/tests/combo-workspace-*.test.tsx` case covers the rendered hint and the save body.

Deferred: a provenance marker for generated declarations. Rollback keeps operator facts, and the declaration can be cleared per model from phase 010's editor.

### Architect reflection (`01a0e45c-65f8-7023-8894-501c6910b602`, `gpt-6-sol`): GAPS, folded

1. **Precedence.** Server validation reuses the runtime predicates instead of re-deriving precedence. The effective declaration is read in the runtime's order: exact `modelCapabilities`, then the operator's custom row, then `noVisionModels`, then `modelRecordValue` over the legacy record (exact, colon-family, case-fold) (`src/vision/eligibility.ts:136-146,200-218`, `src/reasoning-effort.ts:124`). For each target:
   - If `modelAcceptsImageInput` says the model already takes images, return 400, because a text-only declaration would hide a real capability.
   - If the effective declaration exists and lacks `text`, return 400.
   - If the registry-enriched provider already makes it a consumer (`isModelVisionSidecarConsumer`), do nothing, since the catalog already advertises image.
   - Otherwise, including a custom row declared `["text"]` (which the catalog's custom-row path does not cover, `src/codex/catalog/routed-gather.ts:730`), write the exact `modelCapabilities[model].inputModalities = ["text"]` and preserve sibling fields.

   The reload test asserts `/api/models` reports `image` for each enrolled member.
2. **Sidecar status.** `Combos.tsx` loads `GET /api/sidecar-settings` separately from the three workspace requests, so a failure never blocks the workspace. It reads `vision.enabled` (`src/server/management/config-routes.ts:280,815`). A missing or failed read shows no warning and does not guess. The warning appears only when `vision.enabled === false` and `sidecar` members exist.

The integration point is confirmed: create, update and rename share `PUT /api/combos` (`combo-routes.ts:132`), with one save at `:343`, so `commitProviderPatch` can wrap the mutation and that save.

### Independent A (`01a0e45f-c395-79a0-b1cb-41c43abde891`, `gpt-6-sol`): GO-WITH-FIXES; held for the next train

Before B started, the coordinator narrowed train 4 to PRs that were already open or nearly finished. No implementation started, so #4932 is **held for the next train** with a comment on the PR. The audit findings below are part of the plan the next train starts from:

1. **High.** Enrollment makes a member advertise `image`, so catalog modalities alone reclassify it as native-image after reload, and the "sidecar is off" warning disappears. Classify with the declaration `/api/models` exposes separately (`inputModalitiesDeclared`, `src/server/management/model-rows.ts:388-404`), and test save, reload, then disable the sidecar.
2. **Medium.** A custom row's `/api/models` row is rebuilt from `customModels` (`model-rows.ts:323-334,373-376`), so "every enrolled member reports `image`" cannot hold for a custom row. Either align that projection with sidecar coverage or test the custom-row outcome separately.
3. **Medium.** Show enrollment and sidecar wording only while the combo's image input is enabled. Test an existing `imageInput: "disabled"` combo, then switching it on.
4. **Medium.** Wrapping the save in `commitProviderPatch` needs direct tests: a successful rename still migrates identity and `disabledModels`, and a failed save restores the combo, the declaration and the rewritten references. Both guides must say that removing a member leaves its provider-level declaration until the operator clears it (phase 010's editor can).
