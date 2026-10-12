# Bounded CI prerequisite: preserve the restart observation deadline

PR6500 current-head CI run37114638400, test4/4 job111178976551 failed the existing
production-reserve binding assertion in tests/windows/tray-proxy.test.ts:510.
The observer received a deadline1ms later than its caller's deadline. Both source
and test are unchanged from4b98328dca and latest dev7c59baf959.

## Cause and exact change (C1 local behavior fix)

src/cli/tray-proxy.ts reobserveRestartReplacement reads Date.now twice: once to
compute remaining budget, then again to reconstruct the absolute end. Advancing
the clock between reads extends the caller's budget. Capture one now value and
use it in both expressions. No timeout increase, retry or assertion weakening.

```diff
- const windowMs = Math.min(5_000, deadlineAt - Date.now());
+ const now = Date.now();
+ const windowMs = Math.min(5_000, deadlineAt - now);
 ...
- const end = Date.now() + windowMs;
+ const end = now + windowMs;
```

MODIFY tests/windows/tray-proxy.test.ts: add a deterministic regression with a
clock returning1000then1001, caller deadline6000, and an immediate replacement.
Restore Date.now before awaiting the returned promise. Old source passes6001;
fixed source passes6000. Retain all existing reserve/uncertainty tests.
MODIFY structure/runtime.md within600lines: state the single-observation deadline
contract under the existing CLI restart ownership. No new API/config/dependency.

## Delivery and verification

Publish as a separate small prerequisite PR from current dev, keeping UX diffs
focused. Rebase the three owned UX branches onto it in dependency order, preserving
all existing PR numbers and changing only the foundation PR's base to the new
prerequisite branch. Use force-with-lease only for rewritten owned heads, and
verify both ancestry and each current remote head/base after publication.

Main owns serial Git operations in this bound worktree; no parallel branch writer.
Preserve current delivery docs while switching. Run red/green focused regression,
whole tray-proxy tests, typecheck, structure check, privacy check and an independent
source review. Every resulting PR gets current-head hosted CI. Final outcome stays
PUBLISHED_DRAFT with the unrelated four local full-suite failures still recorded.
This necessary CI repair adds one PR to the requested stack, not client support,
a new lifecycle feature, a merge or a release.
