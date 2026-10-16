# Current dev integration and CI fixture repair

Runtime branch rebased onto593978db0. Conflict resolution preserved both settings/doc sections and the new quota-reset observer: ordinary committed usage notifies once; the policy merger remains pure; baseline forgetting and policy clearing coexist. Credits-only writes retain their original notification exclusion, with a minute0/59/60 regression against false rolling-reset detection.

The new dev quota auto-refresh feature makes billable warmups, so main hard-lock now gates that path too. The state leaf removes the lifecycle/facade cycle; reconciliation runs under runtime ownership, token refresh precedes shared ownership, prepared credentials and final restrictions are checked, and false-only skip preserves completion/retry state. Added-account and existing warmup fallback behavior remain unchanged.

CI33939734355 macOS2/2 timed out without an assertion after an environment-assembly fixture. The executed synthetic merge was d1ef2aa4, not a bare head checkout. Source inspection identified unstubbed filesystem/Keychain detection; the unit file now supplies absent-I/O defaults while retaining explicit detection overrides and every assertion. The connected subscription case uses AUTH_PRESENT rather than unsupported dependency fields. Lorentz re-review PASS. This is a hermeticity repair; the historical hang's exact cause is not proven without a process sample. No production CLI timeout or runtime behavior was changed.

No local suites. New-head CI, integration re-review and upper-layer cascade remain mandatory before merge; old successes do not authorize the rewritten stack.

Averroes reviewed the completed warmup/state-leaf/observer integration and regressions: PASS, blocking_issues0. Lorentz independently reviewed the hermetic Claude unit fixture: PASS. Root TypeScript and diff checks passed; all behavioral execution remains CI-only. The new main warmup admission test is registered in both layout manifests.
