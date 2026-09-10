# #1048 production-entry census

Rechecked against `origin/dev` at `aacd6528d8` on 2026-08-26. “Covered”
means the named test invokes the production entry or the disposable runner does.
Rows retired from *additional composed execution* retain a concrete regression or
inventory proof and a reason why another process-level case would duplicate the
same receiving production edge.

| ID | Disposition | Evidence |
|---|---|---|
| P01 | Retired from additional composed execution | `src/cli/init.ts` calls the same native apply convergence exercised by P02/P08 after saving config; `tests/init-eof.test.ts` owns the unique interactive/EOF boundary. No independent writer remains. |
| P02 | Covered | `tests/codex-composed-acceptance.test.ts` — “A-reduced: real CLI and HTTP entry points preserve an OFF Codex config/home”. |
| P03 | Retired from additional composed execution | `tests/shutdown-launcher.test.ts` — “ocx launcher graceful shutdown”; shutdown cleanup uses the same remove convergence proven by P07. |
| P04 | Covered | `tests/codex-composed-acceptance.test.ts` — “A-reduced: real CLI and HTTP entry points preserve an OFF Codex config/home”. |
| P05 | Covered | Same A-reduced case invokes real `ocx sync`. |
| P06 | Covered | Same A-reduced case invokes real `ocx sync-cache`. |
| P07 | Covered | The A-reduced case invokes real `ocx restore`; D-reduced invokes the same row under foreign ownership. |
| P08 | Covered | Same A-reduced case invokes real `ocx restore back`. |
| P09 | Covered (disposable only) | `scripts/disposable-host/codex-service-composed-acceptance.ts` row P09, real `ocx stop`, exact +1 remove transaction. |
| P10 | Covered (disposable only) | Disposable runner row P10, real `ocx uninstall`, exact +1 remove transaction before owned-state deletion. |
| P11 | Retired from additional composed execution | `tests/cli-help.test.ts` — “recover-history requires exact confirmation before mutating history”; this command owns a history-only job, not a native mutation, so it cannot satisfy Scenario A's native-transaction oracle. |
| P12 | Retired from additional composed execution | `tests/cli-provider.test.ts` — “provider add --sync flag is accepted without error” and “provider add --sync --json reports needsSync false”; live sync receives P19/P05's catalog convergence. |
| P13 | Retired from additional composed execution | `tests/cli-models.test.ts` — “models add accepts slash model ids”; its live branch calls the same management/catalog convergence inventoried below. |
| P14 | Retired from additional composed execution | `tests/cli-models.test.ts` — “an unambiguous slash selector still removes its row”; same receiving convergence as P13. |
| P15 | Retired from additional composed execution | `tests/codex-v2-gate.test.ts` — “off -> on carries the active legacy value and removes the boot conflict”; mode mutation is independently tested and its sync tail is P05/P19. |
| P16 | Retired from additional composed execution | `tests/codex-v2-gate.test.ts` — “on -> off carries the active v2 value and removes v2 limit storage”; same sync tail as P15. |
| P17 | Covered | P02 in A-reduced and “Grok E2E: route-disabled Grok stays absent across a real startup” execute startup reconciliation in real child processes. |
| P18 | Covered (disposable only) | Disposable runner row P18, authenticated real `POST /api/stop`, exact +1 remove transaction. |
| P19 | Covered | A-reduced, B-reduced, D-reduced, and D-unknown send real authenticated `POST /api/sync` to a real server. |
| P20 | Retired from another process case | `tests/management-provider-validation.test.ts` — “provider POST overwrite preserves modelCosts when the payload omits it”; `tests/codex-convergence-contract.test.ts` — exact route-inventory test proves its convergence call. |
| P21 | Retired from another process case | `tests/management-provider-validation.test.ts` — “provider PATCH field-mask edits non-reserved providers and rejects unsafe fields (WP040)”; route inventory proves convergence. |
| P22 | Retired from another process case | `tests/management-provider-validation.test.ts` — “provider deletion removes stale provider context caps”; route inventory proves convergence. |
| P23 | Retired from another process case | `tests/management-provider-validation.test.ts` — “provider context-cap API supports global value and set-all toggles”; all three branches are counted by the exact route inventory. |
| P24 | Retired from another process case | `tests/native-model-toggle.test.ts` — “management API surfaces: /api/models leads with native rows; subagent available drops disabled bare slugs”; exact route inventory proves convergence. |
| P25 | Retired from another process case | `tests/model-visibility-management-api.test.ts` — “enables excluded or blocked models and disables without erasing the allowlist”; exact route inventory proves convergence. |
| P26 | Retired from another process case | Custom-model create is one of the exact `7 + 13 + 2 + 2` calls asserted by `tests/codex-convergence-contract.test.ts`; its receiving commit is covered by P19. |
| P27 | Retired from another process case | Custom-model update is in the same exact route inventory; no direct writer remains outside management convergence. |
| P28 | Retired from another process case | Custom-model delete is in the same exact route inventory; no direct writer remains outside management convergence. |
| P29 | Retired from another process case | `tests/model-visibility-management-api.test.ts` — “uses raw allowlist ids, canonical routed slugs, and rejects invalid requests”; exact route inventory proves convergence. |
| P30 | Retired from another process case | `tests/combo-management-api.test.ts` — “PUT and DELETE clear only the mutated combo cooldowns”; `codex-convergence-contract` proves both alias-write routes converge. |
| P31 | Retired from another process case | `tests/combo-management-api.test.ts` — “DELETE refresh immediately retires the final managed combo catalog row”; route inventory proves convergence. |
| P32 | Retired from another process case | Agent-settings write is included in the exact convergence-call inventory; V2 mutation semantics are covered by `tests/codex-v2-gate.test.ts`. |
| P33 | Retired from another process case | `tests/subagent-roster-retention.test.ts` — “retained roster entries are appended once, after the selectable models”; exact route inventory proves convergence and the follow-up remains independently tested. |
| P34 | Covered (disposable only) | Disposable runner row P34, fixture install/stop then real `ocx service start`, exact +1 apply transaction. |
| P35 | Covered (disposable only) | Disposable runner row P35, real `ocx service stop`, exact +1 remove transaction. |
| P36 | Covered (disposable only) | Disposable runner row P36, real `ocx service uninstall`, exact +1 remove transaction. |

## Summary

- 14 rows have direct composed process coverage: P02, P04-P10, P17-P19,
  P34-P36.
- 22 rows are explicitly retired from an additional composed process case.
  Their command/route semantics remain covered, and their write tail is either
  the already-composed convergence seam or the exact static route-call inventory.
- The six service rows are not accepted as passing until the disposable script
  runs green on a sentinel-provisioned host and its final empty gate is captured.
