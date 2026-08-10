# 030 — Phase 4: native-main ACL timeout recovery (PR #1130)

Credit: **luvs01** (`luvs01 <email from PR head>`), PR #1130.
Adoption: near-verbatim cherry-pick.

## Defect

The Windows secret-ACL helper treats a timeout the same as a permanent failure,
so a transient ACL call stall permanently fences the native-main owner path.
There is no bounded retry and no coded error to distinguish "the ACL tool timed
out" from "the ACL was refused".

## Change

Source commit `004a6c12c`:

| Path | Op | Content |
|------|----|---------|
| `src/lib/windows-secret-acl.ts` | MODIFY | +88/−~20: coded error taxonomy, timeout classified separately from permanent denial, one bounded retry |
| `src/codex/native-main-owner.ts` | MODIFY | +20: consume the coded result; retry once on timeout, fail closed otherwise |
| `src/codex/native-main-lock-file.ts` | MODIFY | +6/−~2: propagate the coded failure |
| `tests/windows-secret-acl.test.ts` | MODIFY | +135: permanent-error, timeout, and retry-exhaustion cases |
| `tests/native-main-owner-lifetime.test.ts` | MODIFY | +78: owner path behavior under each failure class |

**Fail-closed is preserved.** The retry applies only to the timeout class; a
refused ACL still denies. This matters because the path guards a physical
credential — a retry that swallowed a denial would be a security regression,
and the tests pin that it does not.

## Execution

```
git cherry-pick 004a6c12c
```

## Verification

- `bun test tests/windows-secret-acl.test.ts tests/native-main-owner-lifetime.test.ts`
- `bun run typecheck`
- `bun run privacy:scan`

Note: the Windows-specific code path cannot be exercised natively on macOS; the
tests inject the ACL boundary. That limitation is stated in the PR rather than
claimed as full platform proof.

## PR

Stack 03, base = stack 02 head. No issue link (#1130 has none); credits luvs01.
