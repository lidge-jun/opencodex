# Outcome — v2.39.0 shipped on both channels

`DONE`. Both channels published, each `gitHead` matching the exact promotion SHA.

| Channel | Version | Promotion SHA | npm `gitHead` |
|---------|---------|---------------|----------------|
| stable  | `2.39.0` | `af6113a0381d6fff2e4dce587652825c7eeb6423` | matches |
| preview | `2.39.0-preview.20260901` | `75f3895c14965205be694e8ebb8e93f472630539` | matches |

`npm view @bitkyc08/opencodex dist-tags` reads `latest=2.39.0`,
`preview=2.39.0-preview.20260901`. GitHub releases `v2.39.0` and
`v2.39.0-preview.20260901` both exist. Release runs `33464579658` (stable) and
`33464064409` (preview), both success.

**The stale preview channel is fixed.** It had been stranded at
`2.36.0-preview.20260830` for two cycles.

## Promotion sequence

PR #3123 (`dev` → `preview`) merged at `75f3895c1`; PR #3125 (`dev` → `main`) merged
at `af6113a03`. Both PRs failed `enforce-target` and were drafted, as every promotion
PR is; both were readied and admin-merged. Both promotion SHAs needed and got their own
green push-event Cross-platform CI and Service lifecycle runs.

## The audit found nothing, and that was checked rather than assumed

Five parallel `gpt-5.6-sol`/high lanes returned PASS across the request path,
credentials, CLI/service, GUI/docs, and release mechanics — recorded in `050`.

## What actually cost time: a real cross-platform flake

`tests/server-auth.test.ts:2288` —
`server local API auth > websocket passthrough refreshes pool auth for each response.create turn`
— failed **three times** on this train: twice on macOS (preview PR run and preview push
run) and once on **Linux** `test 3/4` (main push run). Every failure was the same
assertion, always the *first* element:

```
expect(seenAuth).toEqual(["Bearer old-access-token", "Bearer new-access-token"])
- Expected  - 1
+ Received  + 1
```

It passes locally on macOS and passed on rerun every time. The file is **not in the
promotion delta**, so this is not a v2.39.0 regression.

The mechanism, from reading the test: the stored credential is saved with
`expiresAt: now + 120_000` (`:2237`) while `REFRESH_SKEW_MS` is `60_000`
(`src/codex/account-store.ts:22`). The refresh predicate is
`cred.expiresAt > Date.now() + REFRESH_SKEW_MS` (`:717`), so the credential is only
60 s clear of the skew boundary. Critically, `startServer(0)` runs at `:2245`
**before** `Date.now` is pinned at `:2249` — so any work the server does in that
window reads the real clock. When the first turn's read lands on the wrong side of that
boundary, the refresh fires early and `seenAuth[0]` is already the new token. The
second element is always correct, which is exactly the signature of an early first
refresh rather than a missing second one.

This is a genuine test defect, not runner slowness. The 30 s CI watchdog floor in
`tests/helpers/ci-watchdog.ts` does not help, because nothing here times out.

**A fix already exists and is not merged.** Commit `926a8d8c4`
(`test(auth): pin websocket refresh account`) on `codex/3063-combo-compact-failover`
pins the account namespace and routes both turns through `ws-refresh/gpt-test`. It
rides on PR #3109, which is about combo compact failover and unrelated to this test.
That fix should be split onto its own PR to `dev` so the flake stops taxing every
release train — it cost three reruns and roughly 45 minutes here.

## Residual

PR #3073's intermittent macOS `tests/shutdown-launcher.test.ts` failure did not appear
on this train and remains open.

## Follow-up owed

One item, and it is not this unit's to close: split `926a8d8c4` out of PR #3109 onto
its own PR against `dev`. The commit is a two-line test change that pins the account
namespace so both WebSocket turns route through `ws-refresh/gpt-test`; it has no
relationship to combo compact failover and should not wait on that review. Until it
lands, every release train pays the same three-rerun tax on a test that is not testing
the thing that breaks.
