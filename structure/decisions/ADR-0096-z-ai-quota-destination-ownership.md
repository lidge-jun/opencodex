# ADR-0096 — decision recorded under "Z.ai quota destination ownership"

- Contract owner: [gui-and-management-api.md](../gui-and-management-api.md#zai-quota-destination-ownership)

## Decision record

- 목적과 의도: Restore quota reads for documented international Anthropic and Responses bases without changing their inference configuration.
- 기존 구현 및 제약 조건: Admission omitted both bases; a separate monitor ternary treated all other admitted bases as CN.
- 검토한 주요 대안: Add the same paths to two lists, accept any path on either host, or share one exact mapping.
- 선택한 방식: Share one base-to-monitor mapping and preserve the existing CN allowlist.
- 다른 대안 대신 이 방식을 선택한 이유: A single mapping prevents new international admission from silently selecting the CN authentication scheme, without admitting unrelated pay-as-you-go paths.
- 장점, 단점 및 영향: No config migration or inference change; new documented endpoints still require an explicit reviewed mapping entry. Quota-consumption differences are not inferred from adapter choice.
