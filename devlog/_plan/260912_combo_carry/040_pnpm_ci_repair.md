# Native-platform pnpm shim regression fixtures

The final all-lane run found two pnpm shim tests failing on Windows. Both request Linux shim
semantics against Windows filesystem metadata. The tested source and fixture blobs are identical
at the Combo base, failing tip and current dev; this is source evidence of pre-existing code, not
an executed baseline reproduction. Hosted run34674363301 job103503916566 contains the failure.

Scope: MODIFY tests/update/update-pnpm.test.ts only, plus this record. Production resolver,
POSIX executable-bit guard, declaration file and update/job.ts remain unchanged. Local suites,
build/typecheck/install remain NOT RUN; hosted CI observes the repair. No workflow changes.

NEW local fixture helper emits actual-host launchers: POSIX ocx/opencodex scripts with executable
permissions; Windows cmd and PowerShell files for both commands. MODIFY the active-target and
alias cases to use the helper and verifier's real host default. The stale-target case replaces
both forms of only opencodex on Windows, preserving rejection coverage for both command names.
The two previously failing cases continue to run on every platform.

NEW separate POSIX permission case: native valid target passes, removing one shim's execute bits
rejects that command, restoring permissions passes. This new filesystem-specific case runs on
POSIX only; NTFS cannot provide the claimed mode-bit contract. This is not a skip of either
failing test and does not weaken the production permission predicate.

Preserve the existing explicit Windows cmd/PowerShell case. Reject the earlier proposed stat
injection: host-native fixtures preserve coverage without changing production APIs. Use a new
owned dev repair PR, independent read-only review, --no-verify push and repaired cumulative tip
hosted CI. Original Combo all-lane FAIL remains recorded. Windows shard3's separate devin CLI
discovery failure is handed to the parent for its owner; this pnpm change does not claim to fix it.
