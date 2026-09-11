# ADR-0091 — Ownership Axes

- Contract owner: [clients/integrations.md](../clients/integrations.md#ownership-axes)

## Decision record

- 목적과 의도: Treat JSON object-key order as formatting while retaining safe ownership proof across upgrades.
- 기존 구현 및 제약 조건: Existing records contain order-sensitive hashes, and replacing their hash format in place would make every installed integration look foreign-edited.
- 검토한 주요 대안: Replace the hash format globally; ignore key order only for ZCode; store a semantic companion beside the existing exact hash.
- 선택한 방식: Preserve the exact hashes for compatibility and add object-key-independent semantic companions to new records, with a bounded desired-contribution fallback for old records.
- 다른 대안 대신 이 방식을 선택한 이유: A global replacement cannot validate old records, while a ZCode-only exception would leave the shared JSON ownership rule inconsistent.
- 장점, 단점 및 영향: New records tolerate key normalization even across catalog refreshes; old records recover when the recorded catalog is still reconstructible, and ambiguous old-record drift remains fail-closed.
