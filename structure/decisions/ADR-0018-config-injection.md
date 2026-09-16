# ADR-0018 — decision recorded under "Config injection"

- Contract owner: [config.md](../config.md#config-injection)

## Decision record

- 목적과 의도: Make restore and native-residue inspection accept and reject exactly the same versioned history provenance contract.
- 기존 구현 및 제약 조건: Both modules independently checked version, database identity, entry ids, absolute rollout paths, provider/source tuples, and event markers; drift could make one module restore a manifest that the other refused to classify.
- 검토한 주요 대안: Keep duplicate validators synchronized through review, import the mutation-heavy history provider into residue inspection, or extract a pure shared leaf.
- 선택한 방식: Extract only types, path identity, filename id, provenance, and unknown-data validation; keep all filesystem, rollout, SQLite, retry, and mutation policy in the existing callers.
- 다른 대안 대신 이 방식을 선택한 이유: A pure leaf removes schema drift without pulling write-side effects or database ownership into the read-only startup inspection graph.
- 장점, 단점 및 영향: Format changes now have one validator and shared invalid fixtures; callers still intentionally own different user-facing failure mappings, so contract changes require updating both mappings and this document.
