# ADR-0029 — Windows startup ownership listing reuse

- Contract owner: [ops/service-and-sidecars.md](../ops/service-and-sidecars.md#windows-startup-ownership-listing-reuse)

## Decision record

- 목적과 의도: Preserve the race-sensitive Windows ownership recheck while paying for an unchanged locale-neutral full task listing only once during synchronous startup.
- 기존 구현 및 제약 조건: Localized `schtasks /query /tn ... /xml` failures need a full listing to prove absence, the listing may legitimately take more than two seconds, and `unknown` must never become `absent` merely to reduce latency.
- 검토한 주요 대안: Delete the second ownership check; lower the listing timeout; keep a process-wide or TTL cache; reuse an earlier absence regardless of the fresh targeted result; or scope a memo to the two pre-listen checks and key it to the complete targeted result.
- 선택한 방식: Create one cache inside `startServer`, run every targeted query, and reuse its listing result only when status, timeout/spawn flags, stdout, and stderr are byte-identical. Runtime ownership retries do not receive the startup cache.
- 다른 대안 대신 이 방식을 선택한 이유: Removing or weakening revalidation widens the install race, while a global/TTL cache can outlive startup and stale absence can authorize the wrong home. Exact targeted-result identity lets the ordinary no-task locale fallback coalesce without hiding changed evidence.
- 장점, 단점 및 영향: The reported stable zh-CN absence path performs two cheap targeted queries and one full listing. A task that appears is detected by the second targeted query; changed or failed evidence triggers a fresh fail-closed decision, so unusual churn may still pay for two listings rather than guess.
