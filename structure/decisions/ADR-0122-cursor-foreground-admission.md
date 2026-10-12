# ADR-0122 — decision recorded under "Cursor Native Exec"

- Contract owner: [providers/cursor.md](../providers/cursor.md#cursor-native-exec)
- Supersedes the foreground execution decision in [ADR-0105](ADR-0105-cursor-foreground-shell-ownership.md).

## Decision Log

- Purpose and intent: Prevent foreground commands from outliving their request while preserving
  Cursor's required typed completion and the normal client-owned shell workflow.
- Existing implementation and constraints: The previous POSIX process-group implementation bounded
  output to 1 MiB and attempted TERM/KILL cleanup; Windows was rejected without a job-object owner.
  A process group does not own descendants that start a new session. Synchronous `shellArgs` also
  lacked descendant ownership, so fencing only the streaming shape would leave a bypass.
- Alternatives considered: Add a Linux-only cgroup launcher and a Windows job-object launcher;
  retain process-group cleanup as best effort; or reject both foreground shapes before spawn.
- Selected approach: Reject both `shellArgs` and `shellStreamArgs` on all platforms, even with the
  trusted-local opt-in. Keep typed failure and stream completion, the request's redirect hint, and
  the transport's closed-owner cancellation fence. Remove the obsolete buffering and process scans.
- Why this approach: No kernel-backed launcher is available in the current runtime. Reporting
  best-effort group termination as complete descendant cleanup is not a sound lifetime contract.
  A portable launcher requires separate implementation and validation before enabling execution.
- Benefits, tradeoffs, and impact: No foreground child or output allocation can escape this path.
  Experimental native foreground execution is unavailable on POSIX as well as Windows; callers
  must use their client-owned tools. The previous 1 MiB execution allowance is no longer active
  because nothing is spawned. Background shells and other opted-in native operations are unchanged
  and are not covered by this foreground lifetime guarantee.
