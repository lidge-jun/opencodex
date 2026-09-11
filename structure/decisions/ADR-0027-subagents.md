# ADR-0027 — Subagents

- Contract owner: [subagents.md](../subagents.md#subagents)

## Decision record

- 목적과 의도: keep generated Claude Code `ocx-*.md` roster files synchronized when the proxy is
  started or ensured on Linux, Windows, and macOS, including background service restarts.
- 기존 구현 및 제약 조건: explicit `ocx claude` launches and Management API writes reconciled the
  files, while the startup call inside `injectSystemEnv` ran only on macOS with system-env enabled.
  `startServer` is also used as an in-process library/test primitive and cannot safely mutate the
  real user home on every invocation.
- 검토한 주요 대안: write from `startServer`; duplicate hooks in each OS service manager; reconcile
  once from the owning CLI lifecycle after the listener becomes available.
- 선택한 방식: the foreground/service start and live-proxy ensure paths call one best-effort helper
  after bind, using the live Management API context-window map and the existing marker-verified
  atomic roster writer. macOS system-env startup keeps its existing shared-window sync and skips the
  duplicate call.
- 다른 대안 대신 이 방식을 선택한 이유: it covers every supported service entrypoint without
  adding home-directory side effects to server-library consumers or creating a second roster format.
- 장점, 단점 및 영향: stale OpenCodex-owned definitions converge on every daemon start, disabled integration
  prunes them without provider discovery, and catalog failure falls back to unmarked definitions so
  startup remains available. A later dashboard save or `ocx claude` launch restores missing context
  markers after a transient failure.
