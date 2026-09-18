# ADR-0082 — decision recorded under "Windows service wrapper and incomplete updates"

- Contract owner: [ops/docs-and-release.md](../ops/docs-and-release.md#windows-service-wrapper-and-incomplete-updates)

## Decision record

- 목적과 의도: Prevent a failed npm replacement from making the Task Scheduler wrapper retry missing package files forever.
- 기존 구현 및 제약 조건: The wrapper deliberately restarts a proxy after runtime crashes, but an absent baked Bun or CLI path cannot recover inside that process. Current updater preflight and stop-first behavior reduce replacement risk but do not provide a transactional restore of npm's package tree and global launchers.
- 검토한 주요 대안: Keep unconditional five-second retries, add a generic crash ceiling, restore npm directories in-place, or classify only proven missing executable paths as terminal.
- 선택한 방식: Check the baked Bun and CLI paths before every spawn; log one actionable incomplete-install message and exit with code 3 when either is absent. Preserve the existing retry loop for a child that actually launched and then failed.
- 다른 대안 대신 이 방식을 선택한 이유: A generic retry ceiling can stop a service after unrelated intermittent crashes, while copying a package directory without matching npm shims, ownership, and lock guarantees is not a safe rollback.
- 장점, 단점 및 영향: File-less package skeletons no longer produce unbounded service logs or restart churn. The wrapper still recovers ordinary proxy crashes, but repairing an incomplete npm install remains an explicit reinstall plus `ocx service repair` operation until a verified staged-update design exists.
