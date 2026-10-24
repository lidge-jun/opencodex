# ADR-7512 — decision recorded under "Qoder settings ownership"

- Contract owner: [clients/qoder.md](../clients/qoder.md)

## Decision record

- 목적과 의도: Keep Integrations status available when Qoder cannot represent a catalog model in an exact managed array selector.
- 기존 구현 및 제약 조건: Qoder correctly refuses ambiguous selector construction, but its generic exception escapes the shared reader and fails the whole collection, even without a Qoder installation.
- 검토한 주요 대안: Drop unaddressable models, extend the persisted selector grammar, catch every error in the collection route, or classify a dedicated construction refusal in the shared reader.
- 선택한 방식: Raise a typed selector-construction error and catch only that error around contribution construction in the shared state reader, returning the existing unsafe/unresolvable-path status with resolved target metadata.
- 다른 대안 대신 이 방식을 선택한 이유: This preserves exact ownership and the existing fail-closed preview/write behavior without changing persisted selector interpretation, silently omitting catalog models, or hiding unrelated programming errors.
- 장점, 단점 및 영향: Collection and single-client status remain usable and unrelated clients are unaffected. Qoder management still refuses an unaddressable catalog; the existing generic status reason does not identify the particular model. No selector grammar or writer behavior changes.
