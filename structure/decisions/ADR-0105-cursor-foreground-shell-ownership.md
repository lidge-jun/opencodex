# ADR-0105 — decision recorded under "Cursor Native Exec"

- Contract owner: [providers/cursor.md](../providers/cursor.md#cursor-native-exec)

## Decision Log

- Purpose and intent: Bound output memory and make every opt-in Cursor foreground shell end with
  its request or transport, including commands and descendants that ignore graceful termination.
- Existing implementation and constraints: `shellStreamArgs` buffered both pipes until child close,
  had no output ceiling or request owner, and sent one direct-child termination signal at timeout.
  The result protocol still requires a final typed result plus stream close.
- Alternatives considered: Stream unbounded deltas directly; reuse the global background-shell
  registry; kill only the direct child; or give each live transport a foreground owner with a
  combined byte budget and bounded process-group termination.
- Selected approach: Each transport owns a sealed foreground registry. POSIX children run in a
  detached process group, retain at most one combined mebibyte of raw stdout/stderr, receive TERM
  then KILL, and settle only after process/pipe cleanup or a bounded unconfirmed-cleanup result.
  Windows fails closed because this implementation has no job-object owner that can prove tree
  cleanup after the shell leader exits.
- Why this approach: A foreground child is part of one request and must not borrow background-shell
  admission or outlive transport teardown. A process group gives POSIX a bounded tree owner; a
  direct-child kill or late `taskkill /T` cannot provide the same invariant on Windows.
- Benefits, tradeoffs, and impact: Verbose or cancelled commands cannot exhaust proxy memory or
  remain indefinitely. Output is returned once in the typed result on success and one bounded
  diagnostic on abort. The unsafe experimental foreground shell is unavailable on Windows until a
  job-object implementation can supply equivalent ownership.
