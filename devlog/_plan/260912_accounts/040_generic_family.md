# Scope generic quota evidence and cooldowns by model family

Cycle generic-family; C3, foundation for lifecycle. Extend existing generic pool; do not stack Google-specific #2562/#3283. Current `src/oauth/generic-account-failover.ts:200` already activates kernel strategies; quota threshold remains unused. #4299 narrow head 4583f9793295f75d4bf69d0bfb0900a550bc05bd supplies family-ranking input; adapt with Co-authored-by: chilung <b0423031@gmail.com> when reused.

MODIFY `src/oauth/account-quota-rank.ts`: optional requested-model context chooses matching Antigravity Gem/Cla windows only, preserving no-model existing behavior and conservative unknown evidence. MODIFY generic-account-failover.ts health key/eligibility/ranking/fill-first: quota cooldown key is provider+account+known family, auth failures remain global. Thread model context into both kernel fill-first headroom and quota branch. `autoSwitchThreshold` is consumed by quota selection; zero disables proactive usage threshold, not upstream exhaustion. Reactive quorum activation stays unchanged; provider/global flags affect proactive preference only.

```ts
type GenericQuotaScope = "account" | "gemini" | "claude";
type GenericSelectionContext = { modelId?: string; sessionKey?: string; now: number };
```

MODIFY `src/server/responses/core.ts` initial preference and every generic retry site to pass actual routed modelId; snapshot admission remains guarded and uses account-matched routing metadata. No extra Lab import. Field chain: route.modelId creation → in-memory context only → no disk serialization → headroom and health scope consumers. No provider error body's arbitrary string is allowed as a family identifier; family mapping is bounded known model semantics.

Extend existing generic failover and account quota rank tests, plus a real handleResponses regression with opposing Gem/Cla windows. Assert Claude quota cooldown leaves Gemini usable, global auth exclusion blocks both, unknown model remains conservative, threshold zero semantics, kernel fill-first consumes same family. Sync `src/oauth/`, `src/server/` ownership docs and operating config docs. Local runtime suites NOT RUN; hosted final cumulative lifecycle tip verifies the foundation.

Reflection REF-01 accepted. GenericQuotaScope is account|gemini|claude. GenericSelectionContext carries modelId?, sessionKey?, now. Thread it through headroom/exhaustion/ranking/eligibility/fill-first/initial-preference/rotation/Retry-After. Global cooldown blocks every family; known-family cooldown blocks that family; unknown context considers all relevant cooldowns. Clear/reconcile removes every scope. Core anchors: initial 4350; rotation 5542,6480,6853,7587,7998; refresh 5420,7377; admission 4054,4149,4413. Revalidate anchors at each P. Sidecar uses its actual routed model identity; absence uses account-conservative quota scope.
