# Windows composed-fixture cache ownership

## Trigger and plan amendment

Final integrated run 34049728209 failed only Windows shard 2/6's composed-toggle B case with a request timeout. Product changes did not run in that management-only case. Three-head diagnostic run 34051777446 kept all deadlines/assertions, comparing base 24c761a, prior d60a0716 and current 84c94f3; all samples passed, but OFF consistently consumed 20-26 seconds of a 30-second request budget.

## Controlled evidence

Same-VM run https://github.com/lidge-jun/opencodex/actions/runs/34053472964 changed only fixture child PowerShell module-cache policy, on fixed source 84c94f3. The parent cache was read into a private job-owned regular file; no original cache path was passed to experiment subprocesses. All test assertions and deadlines remained unchanged.

| Condition | Startup | OFF request | Result |
| --- | --- | --- | --- |
| Original A1 | 35.26 s | abort at 30.00 s | timeout; held-sync 45 s abort also recorded |
| Original A2 | 30.11 s | 25.50 s | pass |
| Owned empty, two samples | 26.71-27.41 s | 26.07-26.96 s | pass |
| Owned prepared copy, two samples | 6.12-6.29 s | 3.36-3.37 s | pass |
| Restored original | 27.50 s | 26.15 s | pass |

The copied-cache whole composed file also passed (7 pass, 1 pre-existing skip, 0 fail). A1 has mixed abort observations, so the latency comparison uses the complete A2 and restored-control samples. A mere empty destination did not remove the delay. In copied samples the stale sync completed after the provider release; original controls exhausted discovery before release. No guard-ablation claim is made.

## Scoped delta and acceptance

MODIFY tests/codex-integration/codex-composed-acceptance.test.ts only: seed a Windows-only constructor-owned module cache using the existing Desktop fixture policy, outside the Codex manifest root, and pass only that owned destination to children. Preserve HOME/USERPROFILE variants, real SID/service evidence, coordinator paths, provider hold/release, cleanup, all assertions and all deadlines. No product, workflow, or identity-policy changes.

The isolated diagnostic workflows are not delivery changes. Independent source/security review and a fresh full cross-platform run of the combined latest-dev integration head remain required. Local suites/typecheck/build are NOT RUN per instruction. This support layer is separate from the four product PRs.

## Follow-up source review

External review of #3808 identified a construction-failure cleanup gap: the fixture is registered only after its constructor returns. The cache-setup block now removes its own temporary root with bounded retries before rethrowing. Parent cache sources and shared coordinator paths remain outside that cleanup. Independent source review passed; final remote verification will include the delta.

Run 34054412656 passed Windows composed shard 2, including B at 8.511 seconds. It failed a different competing-OFF fixture in shard 6 before the flip started; this does not negate the cache-control result and is tracked separately.
