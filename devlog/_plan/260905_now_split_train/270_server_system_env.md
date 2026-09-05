# S09 L1/3 — system environment shell integration

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Existing split implementation history; aggregate delivery pending. Original PR is not individually merged.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: `pure-move`; C3 architecture planning, docs-only delegated scope. Implementation touches an existing authentication boundary and requires the repository's explicit security review, without changing its behavior.
- Goal: extract shell-file/hook handling from `src/server/system-env.ts` (537 lines) while preserving every original export and keeping launchctl tracking and model derivation together.
- Non-goals: no auth-policy changes, launchctl behavior changes, hook-path fixes, export renames, dependency additions, or opportunistic unused-import cleanup. Do nothing/configure/delete cannot satisfy the size target; reuse the existing functions rather than introduce a second implementation.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below. No verifier commands or implementation are run in this documentation task.
- Stop: one independently verified layer, original and leaf each <=400 lines, exact-head green CI recorded, PR open against `dev`; never merge. Stop this delegation after writing and checking the assigned document.
- Escalation: source drift, a changed auth result, an import cycle, >500 changed source lines, a weakened oracle, or a required file outside the executor's approved scope returns to the parent. Parent owns orchestration, loop and goal state.

Evidence basis: docs HEAD `4cc219549`; `origin/dev` `1362b1a38`. All source ranges below refer to that code basis, verified identical to the working file. The older ref in 001 is not this document's source basis. Lane: `../260905_modular_debt_ledger/011_lane_server_responses.md:398` starts the system-env section.

Structural decision: CLI and management consumers currently enter `system-env.ts`, which owns shell snapshots and launchctl state. Keep that compatibility boundary; move the shell snapshot's auth resolver with its shell writer, and let the residual call that leaf directly. Rejected: moving only `.zshrc` hooks (133–242) leaves about 427 lines; leaving the resolver in the residual creates `system-env -> shell -> system-env`. Blast radius is the server environment feature, not a new package or public API.

## Symbol inventory

Collected with `git show origin/dev:src/server/system-env.ts | rg -n '^(export )?(async )?(function|interface|type|const|let|class) |^}'`, checking multiline endings against numbered source. Imported bindings are dependencies listed in Leaf partition, not locally defined symbols. Consumers are distinct external files using the symbol through this module, found with `rg -l` on the old import path and symbol-name `rg` within that set; private declarations have zero external consumers (same-name declarations elsewhere do not count). `shell` = `src/server/system-env-shell.ts`; `residual` = original file.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---|---|
| SystemEnvDeps | type | 26–31 | yes | 0 | shell |
| systemEnvAnthropicEnv | function | 39–52 | no | 0 | shell |
| systemEnvMarkerMode | function | 54–63 | no | 0 | shell; internal leaf export |
| getShellEnvFilePath | function | 71–73 | yes | 0 | shell |
| shellValue | function | 75–77 | no | 0 | shell |
| writeShellEnvFile | function | 79–127 | no | 0 | shell; internal leaf export |
| removeShellEnvFile | function | 129–131 | no | 0 | shell; internal leaf export |
| SHELL_HOOK_MARKER | const string | 138–138 | no | 0 | shell |
| SHELL_HOOK_LINE | const string | 139–139 | no | 0 | shell |
| installShellHook | function | 141–156 | yes | 0 | shell |
| uninstallShellHook | function | 158–184 | yes | 1 | shell |
| claudeCodeCliInstalled | function | 187–203 | yes | 1 | shell |
| reconcileShellHook | function | 218–242 | yes | 2 | shell |
| SYSTEM_ENV_NAMES | const tuple | 244–248 | no | 0 | residual |
| MANAGED_SYSTEM_ENV_NAMES | const Set | 250–261 | no | 0 | residual |
| SystemEnvTracking | interface | 263–269 | no | 0 | residual |
| SystemEnvResult | type | 271–271 | no | 0 | residual |
| RevertResult | type | 272–272 | no | 0 | residual |
| CleanupResult | type | 273–273 | no | 0 | residual |
| getSystemEnvTrackingPath | function | 275–277 | yes | 0 | residual |
| launchctlGetenv | function | 279–287 | yes | 0 | residual |
| readTracking | function | 289–304 | no | 0 | residual |
| setLaunchctlEnv | function | 306–308 | no | 0 | residual |
| unsetLaunchctlEnv | function | 310–312 | no | 0 | residual |
| ownedBaseUrl | function | 314–316 | no | 0 | residual |
| writeTracking | function | 318–327 | no | 0 | residual |
| rollbackInjectedKeys | function | 329–345 | no | 0 | residual |
| computeEffectiveModelEnv | async function | 351–365 | no | 0 | residual |
| injectSystemEnv | async function | 367–481 | yes | 3 | residual |
| applySystemEnvToggle | async function | 483–486 | yes | 10 | residual |
| revertSystemEnv | function | 488–519 | yes | 2 | residual |
| cleanStaleSystemEnv | async function | 521–537 | yes | 1 | residual |

Old-path fan-in is 14 files: `src/cli/index.ts`, `src/server/management-api.ts`, `src/server/management/{agent-settings-routes,logs-usage-routes,combo-routes,config-routes,oauth-account-routes,provider-routes,shared,model-routes}.ts`, and the four direct test importers below. Keep all fourteen import sites unchanged. The namespace import in `claude-management-api.test.ts:8` consumes `applySystemEnvToggle` at line 355; do not count it as using all exports.

## Leaf partition

One new sibling, following the domain-prefixed naming used by `src/server/startup-health-cache.ts` and `src/server/proxy-liveness.ts`; no `index.ts` or convenience barrel. Search `rg -n 'system-env-shell|systemEnvMarkerMode|writeShellEnvFile|reconcileShellHook' src` finds the existing owner, not a pre-existing shell leaf.

`src/server/system-env-shell.ts`: move original 15–242 including comments (228 physical lines). Own all thirteen `shell` rows above. Expected **238 lines**: 228 moved + nine one-line imports + one blank. Export `systemEnvMarkerMode`, `writeShellEnvFile`, and `removeShellEnvFile` only from the leaf for the residual's production calls; do not add them to the compatibility facade. Own imports:

```ts
import { accessSync, constants, readFileSync, writeFileSync, unlinkSync, mkdirSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { getConfigDir } from "../config";
import { resolveAutoContext, type AutoContextMode } from "../claude/context-windows";
import { PROXY_MARKER, defaultAuthDetectDeps, detectClaudeAuth, ownAdmissionTokens, type AuthDetectDeps } from "../claude/auth-detect";
import { resolveClaudeAuthMode } from "../claude/auth-mode";
import { ANTHROPIC_PARENT_ENV_SLOTS, trustedNodeLauncherContext, type AnthropicParentEnvSlot } from "../cli/launcher-context";
import type { OcxConfig } from "../types";
import { recordOwnedConfigPath } from "../lib/config-ownership";
```

Residual `src/server/system-env.ts`: expected **310 lines** = 537 − 229 (15–243, including separator) − 2 (old imports 7–8) + 4 compatibility/import statements below. Retain original 244–537, with identical bodies. Narrow fs/path/auth-detect imports to the names still used; retain `PROXY_MARKER`. Keep unrelated existing imports at 12–13 unchanged. The function at 351 still owns catalog-busy handling. No #b layer and no residual over 400. Formatting can change these estimates; actual `wc -l` must remain <=400. Estimated move-inclusive source diff stays below 500; measure before publishing.

## Re-export block

At the original path, add exactly these named re-exports and separate local bindings (one physical statement per line for the size estimate):

```ts
export { getShellEnvFilePath, installShellHook, uninstallShellHook, claudeCodeCliInstalled, reconcileShellHook } from "./system-env-shell";
export type { SystemEnvDeps } from "./system-env-shell";
import { systemEnvMarkerMode, writeShellEnvFile, removeShellEnvFile } from "./system-env-shell";
import type { SystemEnvDeps } from "./system-env-shell";
```

Keep the six original exported implementations `getSystemEnvTrackingPath`, `launchctlGetenv`, `injectSystemEnv`, `applySystemEnvToggle`, `revertSystemEnv`, `cleanStaleSystemEnv` in place. Re-exporting alone does not bind `SystemEnvDeps` for the retained signature. No `export *`, aliases, or wrapper copies. This is preservation of an existing consumer boundary, not creation of an internal convenience barrel.

## Module-level state and cycles

- `MANAGED_SYSTEM_ENV_NAMES` at `src/server/system-env.ts:250–261`: exactly one Set owner, the residual; not exported or reconstructed in the shell leaf. `SYSTEM_ENV_NAMES` at 244–248 remains adjacent. All tracking read/write/rollback/revert operations stay with them.
- `SHELL_HOOK_MARKER` at 138 and `SHELL_HOOK_LINE` at 139 are immutable strings owned only by the leaf. No top-level let, Map, WeakMap, lock, timer or promise flight exists in this file. The Set at 46 is invocation-local, not a singleton.
- Existing external/temporal coupling is retained: injection writes launchctl values, then the shell snapshot, then caches/agent definitions, and finally tracking. The leaf performs no work at module load. Preserve snapshot timing and resolver calls; do not precompute auth state globally.
- Intended direction: old consumers → `system-env.ts` → `system-env-shell.ts` → existing config/auth/launcher-context owners. The leaf must never import the old facade, even for `SystemEnvDeps`; moving that type and the shared resolver eliminates the otherwise direct back-edge. Existing dynamic catalog/cache imports stay dynamic in the residual, not a newly invented cycle workaround.

## Tests

Direct importer command: `rg -l 'from .*server/system-env' tests --glob '*.ts'`. Exact list and disposition:

- `tests/server/system-env.test.ts:5–9` — unchanged; preserve launchctl arguments, rollback, ownership, configured token, and lever expectations.
- `tests/claude-integration/claude-system-env-auto.test.ts:6` — unchanged; inject through old path and retain fs/auth spies.
- `tests/claude-integration/claude-shell-hook.test.ts:5` — unchanged; exercises PATH, LF/CRLF, idempotence and failure shape through the re-export.
- `tests/claude-integration/claude-management-api.test.ts:8` — unchanged; preserve old-path `spyOn(systemEnv, "applySystemEnvToggle")` at 355.

Text/source-oracle inventory, distinguishing actual source reads from generated-file reads:

| test / exact read site | disposition |
|---|---|
| `tests/codex-integration/model-visibility-management-api.test.ts:71` — `Bun.file(new URL("../../src/server/system-env.ts", import.meta.url)).text()`; assertion at 78 | unchanged; the original file retains `computeEffectiveModelEnv` and its catalog-busy branch |
| `tests/codex-integration/compatibility-manifest.test.ts:61` — transitive `readFileSync(current, "utf8")`, roots 182–190 include management-api/index | unchanged; automatic traversal follows named re-exports and direct imports into the new leaf; no manual scan-list edit |
| `tests/lab/core-lab-boundary.test.ts:69` — graph read; roots at 20–24, direct reads 278 and 336 | unchanged; PROTECTED roots never edited; any reachable new leaf must remain Lab-free |
| `tests/claude-integration/claude-shell-hook.test.ts:181` — reads `src/cli/index.ts`, not system-env | unchanged; CLI call sites and startup reconciliation count remain intact |

001's coarse “2 textoracle” count is not two direct source reads: full basename searches also find comments and generated tracking-file assertions. The explicit system-env source read is line 71 above; generic graph walkers are listed separately. No oracle needs retargeting or weakening for this partition.

Guards to drive red once during implementation C, then restore: remove the residual catalog-busy condition and run the model-visibility guard; perturb the moved hook's CRLF removal and run the existing CRLF test; temporarily add a forbidden Lab edge on a reachable protected graph and confirm the boundary guard fails without changing PROTECTED. Record mutations and red/green output, never commit the mutations.

## Verification

Commands below are the future layer-tip gate, not results from this docs-only task:

```sh
bun run typecheck
bun test tests/server/system-env.test.ts tests/claude-integration/claude-system-env-auto.test.ts tests/claude-integration/claude-shell-hook.test.ts tests/claude-integration/claude-management-api.test.ts tests/codex-integration/model-visibility-management-api.test.ts tests/codex-integration/compatibility-manifest.test.ts
bun test tests/lab/core-lab-boundary.test.ts
bun run privacy:scan
wc -l src/server/system-env-shell.ts src/server/system-env.ts
rg -n 'from "[^"]*/system-env"' src gui/src scripts tests | wc -l
git diff --check
```

Focused domains: server, claude-integration, codex-integration, Lab boundary only. Compare the fourteen baseline importer sites and twelve-export surface (eleven functions plus one type), not an unqualified symbol-search count. Inspect static/type/literal-dynamic relative edges from the two modules for no new SCC/back-edge; typecheck alone does not prove absence of cycles.

Full suite runs only on `lidge`, per 002. In the authorized dedicated remote checkout, use `ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-server-system-env && git checkout -q FETCH_HEAD && bun install --frozen-lockfile && bun run test'`. Confirm remote HEAD equals the recorded local/PR tip before accepting output; retain the real test exit code and full log, not only the last pipeline command's status. Record exact-head CI rollup separately. No local full suite, merge or release.

## Accept criteria

1. Exactly the original 32 locally defined top-level symbols have one destination each; no copied function bodies or state.
2. Shell leaf <=400 and residual <=400; expected 238/310; measured layer source additions plus deletions <=500 or stop for parent re-slicing.
3. All twelve old exports remain importable, all fourteen old consumer sites are unchanged, and local leaf bindings compile.
4. Catalog-busy source assertion and old-path spies remain meaningful; recorded guard mutations fail then pass after restoration.
5. No new cycle, no eager Lab dependency and no PROTECTED changes; injection/revert sequencing and return values are unchanged.
6. Typecheck, focused tests, privacy scan, remote full suite and exact-head CI are green with recorded tip and output; explicit security review is recorded before review-ready status.
7. PR targets `dev`, includes the repository template and complete S09 map, and remains unmerged.

## PR

Title: `refactor(server): isolate shell environment integration (split S09 L1/3)`

Branch: `codex/split-server-system-env`. Base: `dev`. Closes: none.

Use `.github/PULL_REQUEST_TEMPLATE.md` with Summary, Verification and Checklist; carry actual executed evidence, not this planned gate. DEV-STACK-03 body map (placeholder PR numbers intentionally pending publication):

| # | PR | Layer | Branch | Base | Review focus |
|---|---|---|---|---|---|
| 3 | #TBD-S09-L3 | lab-routes | codex/split-server-management-lab-routes | dev | public evidence route boundary |
| 2 | #TBD-S09-L2 | logs-usage-routes | codex/split-server-management-logs-usage-routes | codex/split-server-system-env | usage summary dispatch |
| 1 | #TBD-S09-L1 | system-env — this PR | codex/split-server-system-env | dev | shell snapshot/hook ownership |

Base: dev — no dependency on lower layers; this layer is the parent of 280 (branch based on it), so any change here cascades into that layer with `git rebase --update-refs` + `--force-with-lease` before review (DEV-STACK-02).

Review only this layer's diff. Merging requires separate authorization; this train does not merge.

## P stale-check (2026-09-05, wp270)

origin/dev 760eddee1; system-env.ts unchanged since 445742966 (537 lines); anchors 7/8/12/13/15/138/139/242–244/250 confirmed by sed. Base `dev` (S09 bottom; 280 logs-usage-routes chains on it). src/server touched → core-lab-boundary gate mandatory; text oracle model-visibility-management-api.test.ts:71 reads the residual as source. Executor rules: no bun run test; OCX_TEST_NO_QUEUE=1; CI hygiene requires a test change (extend tests/server/system-env.test.ts).

## A amendment (Raman audit, GO-WITH-FIXES blockers=1 → folded)

Size gate: the raw ≤500 clauses (Loop spec, :75, :140) are void; 003 PURE-MOVE-SIZE-01 binds (228 relocated lines; ≤150 non-move; audit measured ~23 non-move before the test edit). Lab roots citation corrected to core-lab-boundary.test.ts:20–28.
Audit-verified exact residual imports (retain the two already-unused providers imports verbatim; drop original 7–8):
```ts
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { resolveAutoContext, type AutoContextMode } from "../claude/context-windows";
import { PROXY_MARKER } from "../claude/auth-detect";
import { isProxyAdmissionSecret } from "./auth-cors";
import type { OcxConfig } from "../types";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { providerContextCap } from "../providers/context-cap";
import { OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers";
```
plus the two leaf binding lines from the Re-export block. Structure verified: 32/32 ranges, 13 shell rows, leaf imports 23 bindings exact, leaf→residual references none, 12/12 exports, catalog_busy oracle string stays in the residual (:358), 344-module walk: no dependency reaches system-env.

## Execution record (B/C/D, 2026-09-05)

- Executor worktree: `/tmp/ocx-split-270.kvYBRy/wt` (branch `codex/split-server-system-env`, base origin/dev 760eddee1). Executor: gpt-6-astra high (Kant, 01a06f6c-d929-7910-85b4-7dfe4c2c48f6).
- Commits: a7e6ea6ee (move: system-env-shell.ts 238, system-env.ts 310) and 1cab08d40 (test: system-env.test.ts +16 — installShellHook/getShellEnvFilePath identity via both paths; leaf has no ./system-env import; residual still contains catalog_busy). Diff: 3 files, +261/−234; non-move 39 lines; 14 importers unchanged.
- Local gate: typecheck 0; focused (5 files) 84 pass / 0 fail; guards (core-lab-boundary + compatibility-manifest) 23/0; privacy passed.
- Red-drives: (a) CRLF handling removed → claude-shell-hook.test.ts:127 fails (9/2), restored 11/0; (b) catalog_busy string replaced → model-visibility-management-api.test.ts:78 fails + new seam test, restored 39/0; (c) lab import in leaf → core-lab-boundary:288 chain management-api → system-env → system-env-shell → lab/paths, restored 23/0.

- Adversarial diff review (Erdos, gpt-6-astra high, 01a06f70-ebde-7052-8b83-d383aef7d5fb): VERDICT: PASS (slice byte-exact, residual exact, 12/12 exports, 3 seams not leaked, 345-module walk no cycle, catalog_busy at residual :131, leaf Lab-free under PROTECTED management-api.ts).
- lidge full suite at 1cab08d40: SUITE_EXIT=0, 18066 pass / 0 fail / 16 skip (/tmp/suite-split-270.log).
- PR: https://github.com/lidge-jun/opencodex/pull/3585 (base dev, head 1cab08d40). CI rollup at record time: OPEN draft=false 1cab08d40 =1 =16 SKIPPED=2 SUCCESS=8
