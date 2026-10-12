# ADR-0106 — decision recorded under "Usage accounting"

- Contract owner: [dashboard-and-usage.md](../dashboard-and-usage.md)

## Decision record

- 목적과 의도: Keep "no recorded usage" distinct from "usage could not be read" across the API and dashboard cache.
- 기존 구현 및 제약 조건: Missing ledgers are valid empty installations, while older daemons encoded real read failures as HTTP 200 with zero-filled counters.
- 검토한 주요 대안: Keep the zero-filled error envelope and teach every consumer about it; mark it incomplete; or use an HTTP failure and retain compatibility rejection in the primary dashboard.
- 선택한 방식: Return a minimal HTTP 500 error envelope and reject the legacy HTTP-200 error before cache publication.
- 다른 대안 대신 이 방식을 선택한 이유: Zero counters and incomplete history are valid data states; neither can truthfully represent an unavailable ledger, and a transport failure already composes with stale-data retention.
- 장점, 단점 및 영향: Operators no longer see false zero cost or traffic and valid cached data survives refresh failures; clients that treated every 200 as data now receive an explicit failure and must use their existing retry/stale path.
