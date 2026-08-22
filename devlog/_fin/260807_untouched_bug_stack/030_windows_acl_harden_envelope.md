# 030 — #1156: Windows ACL harden envelope is too small

## Defect, stated precisely

The original report and our first triage both said PR #1135's retry shares the
5-second budget. That is wrong, and the correction matters.

Owner-level recovery at `src/codex/native-main-owner.ts:205-210` calls
`hardenSecret` again, and each call creates its own deadline at
`src/lib/windows-secret-acl.ts:651-670` and `:703-720`. The retry does get a
fresh envelope.

The real defect: **one complete ACL sequence gets 5 seconds total**. The
deadline is created per harden call and every command inside it draws from the
remainder (`:426-470`, `:475-506`). A sequence is `/grant:r`, `/inheritance:r`,
and a verification pass, plus `/findsid` fallbacks when the principal does not
resolve on the first form. On a machine where `icacls` is slow — Defender
real-time scanning, a roaming profile, a domain controller round-trip — the
budget is exhausted mid-sequence and the owner publishes a permanent
`unavailable`, so every native request returns 503.

`loadConfig` hardens directory, config, and auth sequentially, which is why the
budget is shared per call in the first place: per-attempt budgets would stack
into multi-minute startup stalls. The comment at `:227-234` documents this
trade-off, and it is a real one.

## Change

`src/lib/windows-secret-acl.ts:234` — raise `HARDEN_DEADLINE_DEFAULT_MS` from
`5_000` to `30_000`.

Keep everything else: the 60-second `HARDEN_DEADLINE_MAX_MS` cap, the
`OPENCODEX_ACL_TIMEOUT_MS` override, the clamp, and the shared-envelope
structure.

Rejected alternative: independent per-command budgets. With `/findsid`
fallbacks and retries, that multiplies into the startup stall the shared budget
was introduced to prevent. Raising one constant preserves the design and fixes
the reported failure.

## Worst-case cost, stated honestly

An earlier draft of this doc said "roughly 60 seconds". That was wrong, because
the budget is per harden *call* and `loadConfig()` makes three of them
sequentially — directory, config file, then `auth.json`
(`src/config.ts:1759-1764`):

```
hardenConfigDir();
hardenExistingSecret(configPath);
hardenExistingSecret(join(dir, "auth.json"));
```

So the real bounds after raising the default to 30 seconds are:

| Path | Before (5s) | After (30s) |
|---|---|---|
| `loadConfig()` startup, all three hardens timing out | ~15s | **~90s** |
| native-owner harden + one recovery (250ms delay) | ~10.25s | ~60.25s |

A 90-second synchronous startup stall is a real cost and has to be justified
rather than glossed over. Two things make it acceptable:

1. It is the **timeout** path, not the normal path. Reaching 90 seconds requires
   all three ACL sequences to exhaust a 30-second envelope, meaning `icacls` is
   pathologically slow on that machine. On a healthy machine the sequence
   finishes in milliseconds and nothing changes.
2. The alternative is what #1156 reports today: the harden fails, the owner
   publishes a permanent `unavailable`, and *every* native request returns 503
   until the user restarts. A slow start is recoverable; a permanent 503 is not.

If 90 seconds is judged too long, the fallback is a smaller bump (15 seconds,
giving ~45s startup) rather than reverting to per-command budgets. Record which
bound was chosen in the PR body so the reviewer sees the trade explicitly.

The failure remains fail-closed, which is the security-relevant property.

## Security review gate

This phase touches ACL/credential-permission handling, which requires explicit
security review under `MAINTAINERS.md` — CI green is not sufficient. Run
`bun run privacy:scan` and request the security review before marking the PR
ready.

## Test

`tests/windows-secret-acl.test.ts`:

- `slow successful ACL steps fit the default harden envelope (#1156)` — fake
  clock consumes 2s on `/grant:r` and 11s on `/inheritance:r`, then succeeds.
  Assert `{ok: true}` and that all three core steps ran. Fails under a 5-second
  default.
- Update the existing default-budget expectations at `:356-374` and `:438-465`,
  which assert the old constant.

## Blast radius

Every Windows secret file and directory harden. Behavior is unchanged on
machines where `icacls` is fast; only the failure threshold moves. Memoization
and retry cardinality are untouched.

## Not fixed here

#1149 (ACL principal built from `USERDOMAIN`, rejecting workgroup local
accounts) lives in the same file at `:396-408` but is a different defect with a
different fix. Keeping it out of this phase keeps the diff reviewable; it is a
candidate for the next unit.
