# ADR-0021 — Shared catalog

- Contract owner: [catalog.md](../catalog.md#shared-catalog)

## Decision record

- 목적과 의도: Prevent Windows PowerShell/CIM process discovery from blocking Bun's event loop while v2 sub-agent guidance is assembled.
- 기존 구현 및 제약 조건: The stale-catalog check is advisory on the request path, but CLI/service lifecycle operations use the same process evidence before warning or terminating narrowly matched app-servers.
- 검토한 주요 대안: Remove stale-catalog guidance, move every platform collector into workers, or isolate only the Windows request path behind asynchronous child processes.
- 선택한 방식: Keep the synchronous fail-closed collector for explicit lifecycle operations; v2 requests use asynchronous trusted-System32 PowerShell, one identity-scoped in-flight refresh, and the existing short cache. Cache invalidation advances a generation so a pre-write CIM result cannot repopulate post-write state.
- 다른 대안 대신 이 방식을 선택한 이유: This preserves process ownership and matching invariants while preventing a slow CIM query from starving `/healthz` and unrelated proxy traffic.
- 장점, 단점 및 영향: Concurrent v2 turns do not multiply CIM walks and the event loop remains responsive. A cold request can still await the bounded advisory check, and collection failure suppresses OpenCodex-authored model guidance as `unknown`.
