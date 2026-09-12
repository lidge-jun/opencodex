# Add Codex reset-first through the canonical pool settings API

Cycle reset; C3 scheduling. Independent of quota history and eligibility. Carry #4080 at ecf6b4e48a4c2992c296fada2caf6a8132313eaa, credited to Terry Tan <tmy1995hflc@gmail.com>. Its public diff is a design input, with mandatory canonical-contract adaptation below. Do not enable reset-first for Anthropic or generic OAuth pools.

MODIFY source paths in #4080: `src/codex/routing.ts`, `src/codex/pool-rotation.ts`, `src/codex/auth-api.ts`, `src/types/config.ts`, `src/cli/account-extended.ts`, `src/cli/account.ts`; retain existing priority, eligibility, threshold, and healthy affinity. New Codex strategy sorts earliest FUTURE short/weekly reset after filtering, then usage and stable order. Unknown/elapsed reset is not preferred. Threshold zero disables usage filtering while retaining ordering; exhausted-account behavior remains existing safe fallback.

Additional MODIFY `src/oauth/pool-settings-capability.ts` and `src/server/management/oauth-account-routes.ts`: use a Codex-specific parser that accepts reset-first; canonical PUT /api/pool/settings and GET normalization must preserve it. Generic/Anthropic parsers keep rejecting reset-first. Update `gui/src/account-pool-strategy.ts`, strategy controls/settings, `gui/src/pool-settings.ts` types, locale translations and config docs from #4080 for the canonical route.

```diff
- strategy: normalizeAccountPoolStrategy(config.accountPoolStrategy)
+ strategy: normalizeCodexAccountPoolStrategy(config.accountPoolStrategy)
```

Field chain: CLI/GUI strategy creation → canonical PUT parser → config.accountPoolStrategy write → config load + canonical GET parser → pool rotation/preview/failover, CLI and GUI display. Audit every existing strategy comparison/default, not just the union. No schema migration or new dependency. Exact contributor diff remains `.tmp/accounts-20260912/pr4080.diff` during planning; changes are adapted to current callers before B.

Extend regression sources for canonical PUT/GET/save/reload, legacy endpoint, non-Codex rejection, tied/missing/elapsed resets, threshold zero, priorities, affinity and failover. Existing #4080 test cases are retained/adapted. Update all source ownership docs; screenshot of final rendered strategy control is included with PR. Local suites/build/typecheck/install NOT RUN; final head hosted CI supplies proof. #3376 remains partial until history/capacity; monthly/Anthropic/latest-first scope is reported separately.
