# wp4 — defect landing

Findings the sweep confirms as release-blocking or user-visible get repair branches off
fresh `dev`, one branch per defect class so each stays independently reviewable. Every
repair goes through its own PR with exact-head CI, and dev is allowed to finish one
push-event run afterwards.

The known entry already on the register is the top-level help text in
`src/cli/help.ts`, which still advertises `(14 clients)` after Cline made it fifteen.
That one is carried by #4390 rather than a separate branch.

A finding classified as non-blocking is recorded with the reason it does not block, not
silently dropped. A finding in authentication, credential handling, or release
automation stops the train instead of being landed quickly.

## Exit

No open release-blocking finding, and dev green at a head that already contains every
repair.
