# 060 — wp8/wp9: CLI quota surfaces and platform fixes

### #2565 — `ocx provider quota` prints a count
`quota()` (`src/cli/provider-runtime.ts:105`) renders through `summaryLines()`, a
depth-1 flattener that emits `N item(s)` for a non-scalar array
(`src/cli/runtime-api.ts:294`). The correct per-report renderer already exists:
`quotaParts()`/`providerQuotaLine()` (`src/cli/account-extended.ts:267`), used today
by `ocx account refresh`. Effort XS; add a rendering regression.

### #2566 — per-account quota in `ocx account list`
Server side already exists: `fetchProviderAccountQuotas`
(`src/providers/quota.ts:1561`) exposed at
`/api/oauth/accounts?provider=…&quota=1` (`oauth-account-routes.ts:268`), gated to
Anthropic by `supportsPerAccountQuota()` (`quota.ts:1395`). The CLI never passes
`quota=1` (`src/cli/account-api.ts:237`) and rejects `--quota`
(`src/cli/account.ts:18`). Add the opt-in flag, keep default listing cheap, update the
eight locale docs.

### #2558 — Fast falsely reported as downgraded
`src/providers/fastwire.ts:345` treats any non-priority response tier as a confirmed
`response-declined`, and `TierObservationContext` (`src/types/provider.ts:107`) has
no destination-authority field, so a ChatGPT-forward destination that echoes
`default` is indistinguishable from a real downgrade. Canonical forward detection
already exists (`src/providers/openai-tiers.ts:34`) and the route is in scope where
the context is built (`src/server/responses/core.ts:1638`). Note: `fastOutcome`
drives priority pricing, so this changes cost attribution.

### #2557 — Windows `--restart-desktop-app`
Two defects: PowerShell statements are joined with spaces
(`src/codex/desktop-app-restart.ts:124`), and a thrown probe becomes `[]`
(`:140`) → `no_targets` (`:268`) → the CLI prints "not running"
(`src/cli/dispatch.ts:618`). The reason union has no probe-failure state (`:43`).
HIGH risk: this is a process-termination path and must stay fail-closed on both the
initial and PID-recheck probes.

