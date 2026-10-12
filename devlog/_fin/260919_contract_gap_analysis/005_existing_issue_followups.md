# Reuse existing issue authority

These are proposed comments, subject to the same unanimous publication review as new issues.

## #2358

Source-grounded follow-up at `7864869c31c41cca9830d93540238f17df8faafb`: custom-tool representation and grammar can extend the existing passive compatibility manifest rather than introducing another contract registry.

Current path: `src/responses/custom-tool-compat.ts:187` lowers custom format into a string-input function; `src/responses/parser-tools.ts:67` also represents freeform calls without grammar provenance. The existing `src/compatibility/manifest.ts` already has passthrough/translated/degraded/unsupported dispositions and exact-subject assertion evidence.

Implementation path:

1. Add secret-free fixtures under `tests/fixtures/compatibility/` for the exact destination/auth/inbound/upstream subject, with separate custom representation and grammar assertions.
2. Classify native preservation as passthrough, useful string-wrapper representation as translated, removed grammar as degraded with a concrete limitation, and refusal as unsupported.
3. Extend the matching manifest and `tests/codex-integration/compatibility-manifest.test.ts` so every claim names live assertion IDs, not only test filenames.
4. Update `structure/adapters/compatibility-contracts.md`. Keep manifests passive and optional Lab code outside core runtime imports.
5. Add richer CLI/catalog output only after its consumer contract exists; leave current binary tool-availability fields unchanged.

Acceptance: native and lowered fixtures are distinguishable, grammar loss cannot be labeled lossless, missing assertion evidence fails manifest validation, and no runtime behavior changes from adding evidence. This is static analysis and an implementation proposal; no local runtime suite was run. The broader universal IR/package rewrite is not needed for this bounded slice.

## #5049

Implementation-path refinement from source review at `7864869c31c41cca9830d93540238f17df8faafb`. This issue already owns the narrow per-admission-key authorization gap; no duplicate proposal is needed.

- Extend `OcxApiKeyEntry` in `src/types/config.ts:245` with optional policy fields and wire their full chain: config/management input validation, persistence, reload/default handling, key rename/rotation preservation, management/CLI projection, catalog projection and request consumers.
- Reuse the authenticated key identity from `src/server/auth-cors.ts:395`; caller-supplied informational identity headers are not policy authority. Keep management credentials independent.
- Evaluate policy against canonical resolved provider/model identity, then re-evaluate after fallback/combo route changes. `src/server/responses/request-prepare.ts:404` is one repeated resolution point; inventory HTTP, WebSocket, translated inbound, combo and retry entrypoints before implementation.
- Define aliases explicitly: an allowed combo alias must not implicitly authorize an otherwise forbidden resolved destination. Catalog filtering and actual admission must consume the same policy evaluator.
- Refuse before upstream I/O, preserve key-scoped hub usage (`src/server/hub-usage.ts:8`), and expose bounded denial metadata without secret material.

Acceptance fixtures: unset policy preserves current behavior; allowed/denied direct models; aliases; fallback and combo re-resolution; key rotation/rename; invalid policy input; data-vs-management auth separation; and zero physical sends on denial. Register new tests in both layout manifests, update config/catalog/management/Responses structure owners, and document operator behavior. Broader tenant roles and administration remain in #95. No runtime tests or live account calls were performed for this analysis.
