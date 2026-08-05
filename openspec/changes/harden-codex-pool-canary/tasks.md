## 1. Isolated canary

- [x] 1.1 Add a RED deterministic canary for synthetic 429-to-alternate-account recovery and bounded affinity state.
- [x] 1.2 Add the minimum test-only affinity-count observation required by the canary.
- [x] 1.3 Make the canary pass without changing persistent configuration or public runtime behavior.

## 2. Verification

- [x] 2.1 Run the focused pool, Responses, and memory-watchdog regressions plus typecheck and privacy scan.
- [x] 2.2 Run the isolated canary as the real-surface success and failure proof; verify task-owned cleanup and that port 10123 remains untouched.
- [x] 2.3 Perform the required High-risk independent change/domain review before any delivery claim.
