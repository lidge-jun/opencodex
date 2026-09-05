# S21 L4/4 — Disposable-host fixture owner

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

Archetype: **pure-move**. Goal: separate the disposable-host fixture/preflight owner from row scenarios in the 402-line executable; leave both files ≤400. Non-goals: no systemd operation, no running the acceptance script, no sentinel creation, no changing credentials/account paths, no new scenario or changed teardown/provenance semantics, no moving the executable path.

Mode: bounded docs-only planning; C3 module analysis with C4 review care for the eventual globally addressed service/deletion harness. cxc-dev §1/§5 and cxc-dev-architecture apply; parent owns orchestration/loop/goal. Verifier = `002_layer_map.md` → **Per-layer gate**, below. Drafting stop: this assigned document complete. Implementation stop: its own tip has gates and exact-head PR evidence; no merge. Escalate any new dependency, contract/body change, unsafe host requirement, cycle, leaf >400, or file scope expansion.

Structural decision: split at the existing fixture/scenario seam (lane 016; source `scripts/disposable-host/codex-service-composed-acceptance.ts:129`, :328). Reject deleting comments to get under 400, and reject exporting state from the executable (importing it runs `main().catch`). One sibling leaf follows existing `scripts/test-run-lock.ts` and `scripts/*-child.ts` naming. Search `rg --files scripts` and exact declarations found no existing disposable fixture owner; the workstation-safe test fixture is deliberately a different environment and must not be imported into this production script.

Current map: no source importer or local dependency; built-in fs/os/path/crypto and bun:sqlite; unguarded `main().catch` owns execution. Intended map: same executable → sibling fixture leaf → those same built-ins, with no return edge. Blast radius: this harness and a safe test-source guard, not the service runtime.

Budget escalation: moving the 301 original fixture/preflight lines gives ≥602 literal changed lines before imports. Parent must approve a mechanical-move budget exception or adjust the assigned topology before implementation; this document does not create additional layers.

## Symbol inventory

Basis: docs `4cc219549`; source `origin/dev 1362b1a38`. Fresh `git diff origin/dev -- scripts/disposable-host/codex-service-composed-acceptance.ts` was empty. All inclusive ranges below are origin/dev source lines. Use `sg run --lang ts --kind 'function_declaration,lexical_declaration,type_alias_declaration,interface_declaration,class_declaration' --json=compact scripts/disposable-host/codex-service-composed-acceptance.ts` and column-zero declaration verification with `rg`.

`rg -l 'codex-service-composed-acceptance' src gui/src scripts tests` returns no matches (no importing external file); every symbol therefore has zero external consumer files. Internal calls are not counted as import consumers. There are 22 named non-import declarations.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `SENTINEL` | const | 26–26 | no | 0 | `codex-service-composed-fixture.ts` |
| `SENTINEL_BYTES` | const | 27–27 | no | 0 | `codex-service-composed-fixture.ts` |
| `UNIT` | const | 28–28 | no | 0 | `codex-service-composed-fixture.ts` |
| `repoRoot` | const | 29–29 | no | 0 | `codex-service-composed-fixture.ts` |
| `cliPath` | const | 30–30 | no | 0 | `codex-service-composed-fixture.ts` |
| `accountHome` | const | 31–31 | no | 0 | `codex-service-composed-fixture.ts` |
| `accountUnit` | const | 32–32 | no | 0 | `codex-service-composed-fixture.ts` |
| `eventLedger` | const | 33–33 | no | 0 | `codex-service-composed-fixture.ts` |
| `RowId` | type | 35–35 | no | 0 | `codex-service-composed-fixture.ts` |
| `ChildResult` | type | 36–36 | no | 0 | `codex-service-composed-fixture.ts` |
| `Transition` | type | 37–37 | no | 0 | `codex-service-composed-fixture.ts` |
| `fail` | function | 39–41 | no | 0 | `codex-service-composed-fixture.ts` |
| `assertDisposableSentinel` | function | 43–52 | no | 0 | `codex-service-composed-fixture.ts` |
| `spawnResult` | function | 54–67 | no | 0 | `codex-service-composed-fixture.ts` |
| `requireCommand` | function | 69–76 | no | 0 | `codex-service-composed-fixture.ts` |
| `emptyRegistrationGate` | function | 78–101 | no | 0 | `codex-service-composed-fixture.ts` |
| `byteManifest` | function | 103–117 | no | 0 | `codex-service-composed-fixture.ts` |
| `sameManifest` | function | 119–121 | no | 0 | `codex-service-composed-fixture.ts` |
| `coordinatorPath` | function | 123–127 | no | 0 | `codex-service-composed-fixture.ts` |
| `Fixture` | class | 129–326 | no | 0 | `codex-service-composed-fixture.ts` |
| `runRow` | function | 328–383 | no | 0 | original |
| `main` | function | 385–393 | no | 0 | original |

All import declarations:

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `createHash` | import | 8–8 | no | 0 | fixture |
| `existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync` | import | 9–21 | no | 0 | fixture; existsSync/readFileSync also original |
| `homedir, tmpdir` | import | 22–22 | no | 0 | fixture |
| `join, relative, resolve` | import | 23–23 | no | 0 | fixture; join also original |
| `Database` | import | 24–24 | no | 0 | fixture |

Top-level statement `main().catch(...)` at 395–402 stays original exactly; it is not guarded by `import.meta.main`, and adding that guard would be an out-of-scope behavior change. All Fixture members remain inside their class; none become singleton declarations.

## Leaf partition

| New leaf | Symbols | Expected lines including imports | Own imports |
|---|---|---:|---|
| `scripts/disposable-host/codex-service-composed-fixture.ts` | `SENTINEL`, `SENTINEL_BYTES`, `UNIT`, `repoRoot`, `cliPath`, `accountHome`, `accountUnit`, `eventLedger`, `RowId`, `ChildResult`, `Transition`, `fail`, `assertDisposableSentinel`, `spawnResult`, `requireCommand`, `emptyRegistrationGate`, `byteManifest`, `sameManifest`, `coordinatorPath`, `Fixture` | 320 | `createHash` from `node:crypto`; all eleven existing fs imports from `node:fs`; `homedir, tmpdir` from `node:os`; `join, relative, resolve` from `node:path`; `Database` from `bun:sqlite` |

Move **26–326 = 301** original lines, retaining their order and comments. Leaf imports preserve the original 17-line import block (:8–24), plus two spacing lines: 320 expected. Keeping a **sibling** (not a deeper subfolder) preserves `resolve(import.meta.dir, "../..")` at origin :29 exactly, and therefore the CLI path.

Residual expectation: **88** = 402 − 301 − 17 old import-block lines + 4 replacement import lines. Retain header :1–7, row runner :328–383, main :385–393, catch :395–402 and surrounding existing spacing. All files ≤400; no #b required. Actual physical counts must be recorded during execution. `Fixture` stays a 198-line cohesive lifetime owner; don't refactor methods or delete the unused `byteManifest` while moving.

Only the existing symbols used across the new boundary gain leaf exports: `Fixture`, `fail`, `assertDisposableSentinel`, `requireCommand`, `emptyRegistrationGate`, `eventLedger`, and the three types `RowId`, `ChildResult`, `Transition`. All other leaf helpers/constants remain private. This is the existing harness implementation boundary, not a user-facing API.

## Re-export block

**No compatibility re-export lines:** the original file currently exports no value/type/default symbols; preserve that empty export set. Do not re-export the fixture's internal API from the executable and never import the executable to get helpers.

The entire replacement residual import block is:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Fixture, fail, assertDisposableSentinel, requireCommand, emptyRegistrationGate, eventLedger } from "./codex-service-composed-fixture";
import type { RowId, ChildResult, Transition } from "./codex-service-composed-fixture";
```

No local binding is expected from a re-export. Both `runRow` and `main` remain private local functions.

## Module-level state and cycles

- `eventLedger: string[] = []` at origin :33 is mutable module-level state, even though lane 016's narrower let/Map/Set scan reported none. Its **one owner** is the fixture leaf. All writes remain there (:50, :71, :85, :92); original main only reads `.join` (:392). Do not copy, reset, freeze, or reinitialize the array.
- `SENTINEL` (:26), `SENTINEL_BYTES` (:27), `UNIT` (:28), `repoRoot` (:29), `cliPath` (:30), `accountHome` (:31), `accountUnit` (:32) move together to that same owner and keep evaluation order. No new top-level I/O beyond the existing path/home computations.
- No top-level let, Map, Set, WeakMap or lock. `Fixture.lock` and `lockAllowlist` (:151–152, :187–189) remain instance-owned paths, not newly acquired locks. `baselineOutside`, seed and temp root stay constructor-scoped/instance-scoped. No Fixture instance is constructed at import time.

Single directed edge original → fixture, only built-ins below; no type-only back edge. Temporal coupling remains explicit: main platform check → sentinel verification → require systemctl → each row's empty-registration gate → constructor/install → teardown → final empty gate. The ledger initialization stays before all of them. A leaf-to-entry import would eagerly rerun the harness and create a cycle: prohibit it with the source guard below. The ledger's sole-writer/read-only-consumer relationship is retained; no new shared writer or defensive logic is introduced.

## Tests

Exact `rg -l` public-path importer list in `tests`: **empty**. Exact basename/path and reader-intersection searches found **no existing source-text oracle** for this script. There are consequently no existing retarget-to-leaf or add-leaf-to-scan-list dispositions to invent.

Related but not importing this script: `tests/codex-integration/codex-composed-acceptance.test.ts` covers workstation-safe composed rows through the real CLI/server (entry paths :49–50); keep all existing assertions unchanged. Its fixture is not reusable for these globally addressed systemd rows.

Future test change: in that existing test file, add a separate **source-only** guard describing the disposable fixture boundary. Read exact paths `scripts/disposable-host/codex-service-composed-acceptance.ts` and `scripts/disposable-host/codex-service-composed-fixture.ts` via the existing repository-root helper; no new test filename or layout-map edits. Add-leaf-to-scan-list: the new guard includes the fixture path, checks that the sentinel/empty-registration implementation resides there, and the scenario entry imports only the declared boundary. Check no main call/spawn/Fixture construction at leaf module evaluation, one eventLedger declaration, no leaf import of the executable, and sentinel invocation before the first command in main. Use AST/syntax-aware checks where comments also contain those words.

Drive the new guard red once by removing the sentinel invocation from the entry source in the isolated implementation worktree, then restore; separately introduce a forbidden leaf-to-entry import and restore. The red test must only read text, never import/execute the destructive script. A safe export inventory assertion may import the inert fixture leaf but must not instantiate Fixture. Existing guards are not weakened or retargeted.

The real six-row census is **not** a local/ordinary CI test. It requires a separately authorized, root-sentinel-provisioned disposable Linux/systemd image. Do not create the sentinel or run service operations on this workstation or on the generic lidge checkout. Source-only verification must not be reported as real six-row acceptance.

## Verification

Future L4 commands instantiate 002's per-layer gate (no test or script executed in this drafting turn):

```sh
bun run typecheck
bun test tests/codex-integration/codex-composed-acceptance.test.ts
bun run privacy:scan
wc -l scripts/disposable-host/codex-service-composed-fixture.ts scripts/disposable-host/codex-service-composed-acceptance.ts
rg -l 'from ".*codex-service-composed-acceptance"' src gui/src scripts tests
git diff --numstat origin/dev...HEAD -- scripts/disposable-host
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-disposable-host-codex-service-composed-acceptance && git checkout -q FETCH_HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15'
```

The importer check must have no matches (rg exit 1 is expected, not a failed contract). The new entry → fixture edge is measured separately; no leaf → entry edge and no type cycle. Full remote run must retain actual exit status with pipefail or explicit status capture plus complete logs; tail alone cannot prove green. Confirm the remote SHA equals L4. `scripts/AGENTS.md` prepush is also remote-only because it includes the full suite; obtain explicit security review for service/deletion tooling.

No core-Lab conditional check is activated: none of `src/server`, `src/router`, `src/lib` is touched. Preserve protected roots. Platform CI checks static/import portability; only a separately authorized disposable Linux/systemd run can prove six-row runtime results. Missing disposable-host evidence is reported explicitly, never substituted with a workstation launch.

## Accept criteria

1. All 22 named declarations and five import declarations have an explicit owner; 301 original lines move without body/signature changes.
2. One new leaf measures ≤400 (320 expected), original ≤400 (88 expected), public export set remains empty.
3. Leaf is a sibling, preserving repoRoot/cliPath semantics; no main invocation, service query or temporary fixture creation occurs on leaf import.
4. One eventLedger owner remains; sentinel and before/after empty-registration checks, transaction counts, account paths, and teardown allowlist are unchanged.
5. Source guards have recorded red/restore evidence; focused safe tests, typecheck, privacy, remote full suite/prepush and exact-head CI pass. Real disposable-host results are reported separately if authorized; no false acceptance claim.
6. Parent resolves the diff-size exception and obtains tooling/security review before execution/review-ready. Base contains L3; no merge, release, account mutation or extra branch occurs in this drafting task.

## PR

Title: `refactor(scripts): separate disposable service fixture ownership (split S21 L4/4)`
Branch: `codex/split-disposable-host-codex-service-composed-acceptance`.
Base: `dev`.
Closes: none.

Fill Summary, Verification, Checklist in `.github/PULL_REQUEST_TEMPLATE.md`. Review only this layer's diff. Stack navigation (only L2 depends on L1; merges require separate authorization):

| # | PR | Layer / branch | Base | Review focus |
|---|---|---|---|---|
| 4 | #TBD-S21-L4 | `codex/split-disposable-host-codex-service-composed-acceptance` | `dev` | Fixture owner; sentinel order |
| 3 | #TBD-S21-L3 | `codex/split-test` | `dev` | Environment and selection leaves |
| 2 | #TBD-S21-L2 | `codex/split-release-notes-b` | `codex/split-release-notes-a` | Tags, attribution, PR rendering |
| 1 | #TBD-S21-L1 | `codex/split-release-notes-a` | `dev` | Carry, commit fallback, polish |

Base: dev — no dependency on the layers below; no cascade obligation. This final layer does not authorize landing any part of the stack.
