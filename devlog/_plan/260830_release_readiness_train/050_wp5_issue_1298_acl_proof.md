# 050 — wp5: prove an existing Windows ACL before propagating writes

Issue #1298 is a no-op that currently costs as much as a rewrite. At `dev@47b8d1643`,
`runIcacls()` in `src/lib/windows-secret-acl.ts:503-545` always performs `/grant:r`,
`/inheritance:r`, and broad-SID removal; the async twin at `:549-578` does the same. For a
directory, `grantAce()` at `:499-501` adds `(OI)(CI)`, so the grant can walk every descendant
even when the root already satisfies policy. #1298 measured 88 ms at 10 descendants and
9,438 ms at 20,000. Raising the 30-second envelope at `:233-265` only permits more work.

The change is an opt-in proof shortcut, not a second ACL policy. With
`OPENCODEX_ACL_VERIFY_EXISTING=1`, one non-recursive `icacls <path>` read may return success
only when its complete ACE list proves one explicit effective-owner Full Control ACE, no inherited ACE, and no other principal. Any command, cache, parse, inheritance,
principal, or permission uncertainty enters the existing mutation sequence unchanged. The
flag stays off by default because a parser false-positive could expose credentials;
strict-parse-or-fall-through makes uncertainty pay the old cost instead of weakening policy.
## Patch boundary

| Path | Action | Exact ownership |
|---|---|---|
| `src/lib/windows-user-principal.ts` | MODIFY | Cache and expose the token-derived SID/name pair without adding a pre-check spawn |
| `src/lib/windows-secret-acl.ts` | MODIFY | Add the opt-in single-path reader/parser and call it before sync/async mutation |
| `tests/windows-user-principal.test.ts` | MODIFY | Update the existing exact PowerShell command and lookup fixtures for the paired identity payload |
| `tests/windows-secret-acl.test.ts` | MODIFY | Add issue #1298 proof/fallback/cost regressions through the real harden entry points |

No config schema, GUI, docs-site setting, recursive walk, dependency, or new memo belongs
in wp5. Keep the mutation order, retry count, timeout memo, sanitization, and
required/optional failure branches unchanged.

## `src/lib/windows-user-principal.ts`

Replace the SID-only cache at `:168-171` with exported immutable
`WindowsPrincipalIdentity { grantSid: string; accountName: string }`. Change
`SID_EXPRESSION`/`POWERSHELL_ARGS` at `:31-33` and `:104-110` so the same trusted, non-elevated PowerShell process emits both
`WindowsIdentity.GetCurrent().User.Value` and `WindowsIdentity.GetCurrent().Name` in an
unambiguous two-field payload. `principalFromResult()` at `:214-225` rejects missing,
extra, malformed, non-SID, or empty-name fields; it normalizes only `grantSid` and retains
the token name for case-insensitive reads. `USERDOMAIN`/`USERNAME` remain non-authorities.

Add `resolveCurrentWindowsPrincipalIdentity(timeoutMs)` and its async counterpart beside
`resolveCurrentWindowsPrincipal()` at `:227-255` and `resolveCurrentWindowsPrincipalAsync()`
at `:279-310`. The existing exports keep returning `identity.grantSid`, preserving every
grant caller. Both identity exports consult the shared successful cache before testing
`timeoutMs`; therefore a call with `0` is cache-only. On a miss it throws `EACLIDENTITY`
without starting PowerShell. Preserve injected-runner precedence, async single-flight, and
all reset seams at `:312-341`; the synthetic POSIX identity at `:186-195` becomes a pair.

This is the #1149 boundary: the first process harden takes the full path and seeds the
cache; later hardens may prove a no-op. The proof gate never initiates identity resolution.

In `tests/windows-user-principal.test.ts`, update the existing cases
`builds a non-interactive command without the Bun-incompatible PowerShell window flag`,
`uses the token SID and normalizes it for icacls, independent of WORKGROUP env`, and
`caches only a successful lookup` to use the pair while retaining SID-return assertions.
Extend `invalid output fails closed and is retried rather than cached` with missing-name
and extra-field rows.

## `src/lib/windows-secret-acl.ts`

Import `WindowsPrincipalIdentity` and the new identity resolver at `:35-39`. Add
`existingAclVerificationEnabled()` beside `resolveHardenDeadlineMs()` (`:258-265`); it is true only when `env["OPENCODEX_ACL_VERIFY_EXISTING"] === "1"`. Add `cachedWindowsPrincipalIdentity()` beside
`currentWindowsPrincipal()` (`:479-485`), implemented as a zero-budget identity call that
catches `EACLIDENTITY` and returns `null`. It must neither invoke a runner nor convert a
cache miss into a hardening failure.

Add `parseExistingAcl(stdout, targetPath, directory, identity)` before `runIcacls()` (`:503`).
Parse lines, not one whole-output regex: remove the exact echoed-path prefix so a same-line
first ACE survives, accept only subsequent indented ACE lines, then stop when localized
unindented summary text begins. Every ACE-region line must parse completely as
`principal:(flags...)`. Compare the principal case-insensitively with `accountName`. Accept
only explicit `(F)` for a file or exactly `(OI)(CI)(F)` for a directory, in any token order.
Reject `(I)`, unknown flags, duplicate owner ACEs, and every other principal—including
Everyone, Authenticated Users, and Users. Require exactly one accepted ACE.

Add sync/async `existingAclSatisfiesPolicy()` wrappers next to `runIcacls()` and `runIcaclsAsync()` (`:503-578`). They run exactly `[targetPath]` through the existing runner
and deadline, never `/T`, `/grant`, `/inheritance`, `/remove`, or `/findsid`. Throw, timeout,
non-zero exit, cache miss, or parser refusal returns `false`; async semantics are identical.

In `hardenEntry()` at `:716-747` and `hardenEntryAsync()` at `:770-798`, place the proof
after existence/platform/success-memo and timeout-memo checks, and after the one deadline
is created, but before the retry loop captures `before` and calls `runIcacls*`. On exact
proof return `{ ok: true }`. Do not call `recordHarden()`, write either success map, or
delete `timedOutPaths`: a read is not evidence of mutation, so the next call reads again.
On `false`, enter the current loop with no retry, error, or memo rewrite.

## Regression matrix in `tests/windows-secret-acl.test.ts`

Save and restore `OPENCODEX_ACL_VERIFY_EXISTING` in the file-level hooks at `:51-64`, then
add `describe("existing ACL proof gate (issue #1298)")` before the failure-path block at
`:466-472`. Add these exact cases:

- `skips sync mutation for a same-line explicit owner Full Control ACE`
- `skips async mutation with a case-varied owner and localized summary text`
- `falls through for an inherited owner ACE`
- `falls through for a broad or otherwise unexpected principal`
- `a cold identity cache performs no read probe and preserves sync and async mutation`
- `read-only success is not entered into either post-mutation memo`
- `directory verification is one non-recursive read at zero and 100000 synthetic descendants`

Use realistic `<path> DOMAIN\\user:(F)` first lines and indented continuations. Localized
summary prose must be ignored only after the ACE region. Fallback tests assert
`[read, grant-owner, remove-inheritance, remove-broad]`, not merely `ok:true`; cache miss
asserts no read probe before mutation seeds identity. The memo case expects two reads, zero
mutations, and both success-map counts at zero. The cost case asserts one `[targetPath]`
command and no `/T` at both sizes; command shape, not timing, proves constant descendant cost.

## Security accounting and verification

This is an E7 runtime shortcut. Its known bypass—unset flag or unprovable output—selects
the current mutation path. Residual risk is a parser false-positive; exact cardinality,
flags, token identity, opt-in rollout, and fallback tests bound it. The final enforcement
layer remains `runIcacls*`; this document claims only a proof shortcut.

Wp5 verification is focused only; the local full suite is forbidden by `000_plan.md`:

```bash
bun test tests/windows-user-principal.test.ts tests/windows-secret-acl.test.ts
```

Capture RED for the new #1298 cases before source edits, then rerun both files for GREEN.
Wp6 owns typecheck, cross-platform push CI, Service lifecycle, and the Windows dispatch.
