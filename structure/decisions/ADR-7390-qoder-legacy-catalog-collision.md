# ADR-7390 — decision recorded under "Qoder settings ownership"

- Contract owner: [clients/qoder.md](../clients/qoder.md)

## Decision record

- 목적과 의도: Stop Qoder from rejecting the opencodex provider because one model key appears in both `providers.opencodex.models` and `modelConfigs.customModels`.
- 기존 구현 및 제약 조건: The exporter wrote both catalogs, using provider-and-model array selectors for the legacy rows. Qoder treats the duplicate key as a provider conflict. Rows written by users or older manual exports carry no ownership record.
- 검토한 주요 대안: Keep writing both catalogs; write only the provider catalog and keep every unowned legacy row; delete colliding legacy rows during apply; write only the provider catalog and classify an unowned colliding row as a conflict before any write.
- 선택한 방식: Export only `providers.opencodex`. Refresh removes legacy rows a record still owns. An unowned `provider: "opencodex"` row naming an exported model makes the shared classifier return `conflict` / `unowned-key`, and the writer and preview planner also refuse `overwrite` for it.
- 다른 대안 대신 이 방식을 선택한 이유: Keeping the colliding row recreates the rejected configuration while reporting success, and deleting it removes configuration opencodex never wrote. The shared classifier already decides status, preview and every write, so all three agree.
- 장점, 단점 및 영향: Model IDs no longer need array selectors, which also removes the Qoder trigger for ADR-7512. A user with a hand-written duplicate row must remove or rename it before enable, refresh, overwrite or disable proceeds, because `overwrite` replaces only paths opencodex writes and that row is not one of them.
