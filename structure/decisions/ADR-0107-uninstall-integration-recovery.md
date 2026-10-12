# ADR-0107 — decision recorded under "Client Integrations"

- Contract owner: [clients/integrations.md](../clients/integrations.md)

## Decision record

- 목적과 의도: Restore every recorded third-party client contribution before uninstall deletes the ownership and snapshot evidence needed to do so safely.
- 기존 구현 및 제약 조건: Generic integration records lived under the OpenCodex config root and were removed by the ownership manifest, while uninstall restored native Codex, Grok, and Desktop state only. The ordinary disable writer already owns drift detection, snapshots, compensation, and per-client locking.
- 검토한 주요 대안: Leave external files unchanged; teach the config remover about third-party formats; restore snapshots wholesale; or invoke the existing coordinated disable workflow before config removal.
- 선택한 방식: Under the final client-lifecycle lease, strictly read root and Aside child-profile ownership stores, validate client IDs and registered profile paths before mutation, load one export roster, disable each recorded integration in deterministic order, verify its record retired, and abort config removal on any refusal or error. Enumerate persisted child stores rather than just desired/current profiles so orphaned ownership cannot be silently discarded.
- 다른 대안 대신 이 방식을 선택한 이유: Reusing the writer preserves the same fragment-level ownership and conflict rules as an explicit toggle. Whole-file restoration can erase later user edits, while deleting evidence first makes a safe retry impossible.
- 장점, 단점 및 영향: Successful uninstall retires every recorded client contribution before deleting OpenCodex state. Cleanup is not a cross-client transaction: earlier successful disables remain applied if a later client refuses, and failed writer compensation may leave an intermediate client file. A refusal retains remaining recovery state, not a guarantee that files are unchanged or restoration completed. Operators must inspect reported client files and retained snapshots before retrying. Cleanup takes the existing writer locks and model-roster load before local state is deleted.
