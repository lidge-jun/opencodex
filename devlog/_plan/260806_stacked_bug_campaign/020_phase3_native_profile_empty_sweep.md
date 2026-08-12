# 020 — Phase 3: skip empty native-profile stage sweeps (#1120, PR #1124)

Credit: **ingwannu** (`Ingwannu <email from PR head>`), PR #1124.
Reporter: **MarcusNeufeldt** (#1120). Adoption: near-verbatim cherry-pick.

## Defect

`startNativeMainStartupLifecycle` always runs `manager.sweepStages()` under the
native-profile SQLite transaction (`src/codex/native-profile-startup.ts:131`),
and `sweepStages()` takes the profile lock unconditionally
(`src/codex/native-profile-manager.ts:916`) — even when there is no stage
registry and no staging tree at all.

A transient lock or Windows ACL failure then leaves the native-main gate in
`stage-cleanup-required`, native requests surface a misleading 503 that reads
like upstream capacity pressure, and `doctor`/`recover` contend on the same
transaction. That is the reported catch-22 on an installation with zero
profiles.

## Change

Source commit `dd2078763`:

| Path | Op | Content |
|------|----|---------|
| `src/codex/native-profile-manager.ts` | MODIFY | +19: absence-only preflight — skip the locked sweep when both the stage registry and this instance's staging tree are provably absent |
| `src/codex/native-profile-startup.ts` | MODIFY | +8: call the preflight before `runOwnedStageSweep` |
| `src/codex/auth-context.ts` | MODIFY | +7/−1: 503 identifies local native-profile maintenance instead of upstream capacity |
| `src/server/claude-messages.ts` | MODIFY | +3/−1: same diagnostic on the Claude path |
| `tests/native-profile-stage-lifecycle.test.ts` | MODIFY | +62: zero-profile/zero-stage install cannot be fenced by an unavailable lock; present or unreadable stage state still fails closed |
| `tests/codex-auth-context.test.ts` | MODIFY | +14: 503 message identity |
| `tests/native-profile-drain-server.test.ts` | MODIFY | +3/−1: message alignment |
| `structure/02_config-and-codex-home.md` | MODIFY | +14: absence-only fast-path invariant |

**Safety property preserved:** any *present* artifact, or any path that cannot
be proven absent, still enters the existing locked fail-closed cleanup.
Owner/claim protection for the physical native-main credential is untouched.
This is a C4-adjacent credential path, so the absence proof — not the happy
path — is what the regression test pins.

## Execution

```
git cherry-pick dd2078763
```

## Verification

- `bun test tests/native-profile-stage-lifecycle.test.ts tests/codex-auth-context.test.ts tests/native-profile-drain-server.test.ts`
- `bun run typecheck`
- `bun run privacy:scan`

## PR

Stack 02, base = stack 01 head. `Closes #1120`, credits ingwannu and the
reporter.
