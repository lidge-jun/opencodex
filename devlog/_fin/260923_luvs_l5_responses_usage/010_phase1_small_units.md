# wp2: #5434 OAuth rotation attribution

Source: #5434 head `f6778bfb70`. #5474 (`49a9c15988`, `68f74eb844`, merge `f4eab495c3`) and
#5305 (`fa7f53fee3`) close without a carry; the commit ledger is in `000_plan.md`.

## Recipe

```sh
git cherry-pick -x 1ac1ba0c8f f6778bfb70
```

Files (MODIFY): `src/oauth/generic-account-failover.ts` (new non-mutating
`hasEligibleGenericOAuthFailoverTarget` using the same eligibility predicate as rotation),
`src/server/responses/adapter-continuation.ts`, `src/server/responses/passthrough-dispatch.ts`,
`src/server/responses/run-turn-execution.ts` (gate `noteAttemptRecoveryWithheld` on the probe),
`structure/transports/responses.md` (cooldown-aware attribution sentence),
`tests/oauth/generic-oauth-failover.test.ts` (negative cooldown case, positive eligible case,
source-oracle assertion over the three call sites).

## Check

Static: `git diff --check origin/dev...HEAD`; merge preview clean. A reviewer confirms the probe
matches `rotateGenericOAuthAccountOn429`'s predicate and that the three sites are gated.
