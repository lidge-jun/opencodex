# 500 — S15 L3/5: src/lab/artifacts/sanitize.ts

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: `pure-move`; C3 architecture planning, docs-only bounded delegation. cxc-dev §1/§5 and cxc-dev-architecture apply. Parent alone owns orchestration, loop and goal state.
- Goal: separate lexical redaction and UTF-8 truncation, with every original public export and behavior preserved.
- Non-goals: no behavior fixes, new validation, renamed symbols, signature changes, new dependencies, public API expansion, core activation changes, releases or merges. This document plans implementation; this drafting task changes no source and runs no tests.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below; full tests only on `ssh lidge`, never locally.
- Stop: independent layer-tip verification and green exact-head CI evidence recorded, with the layer PR open; do not merge. Stop before implementation if a stated escalation is unresolved.
- Escalation: source drift, unexpected oracle coupling, new cycle, public export loss, changed state lifetime, any scope expansion, or the size-budget conflict below goes to the parent. Do not add a sixth stack layer or edit 002 here.
- Basis: docs HEAD `4cc219549`; verified source `origin/dev = 1362b1a3841b4de20177e5d65865a513dd7936c4`. All source anchors in this document refer to that revision. `git show origin/dev:src/lab/artifacts/sanitize.ts` matches the working file byte-for-byte.
- Prior audited seam: `devlog/_plan/260905_modular_debt_ledger/016_lane_cli_storage_usage_update_lab_scripts.md:335`. Read together with 000, 001, 002; actual consumer/oracle evidence below supersedes the approximate basename-based counts in 001.

Structural decision before implementation: Current: artifacts/store.ts:23, projection/rebuild.ts:5 and fabric/observe.ts:2 consume sanitize; the only imports are ArtifactClass, MAX_SANITIZED_STRING_FIELD, jcsStringify and redactSecretString (5–8). Chosen: move existing address/scanned-span operations, account/URL-path operations and UTF-8 truncation into three dependency-free siblings. Keep contract checks, recursive normalization and scrubString's ordered pipeline. Rejected: moving the complete lexical section into one file would exceed 400 lines; changing regex behavior or merging it with src/lib/redact would not be a pure move. structure/09_compatibility-lab.md's evidence-text contract remains authoritative and unchanged.

## Symbol inventory

Measured by `sg run --lang ts --kind 'function_declaration,interface_declaration,type_alias_declaration,lexical_declaration' --json=compact src/lab/artifacts/sanitize.ts`, matched to column-zero declarations in the pinned source. Nested declarations are excluded. Ranges include declaration syntax through its closing line, not preceding comments.

Consumers are distinct direct import/re-export files across `src gui/src scripts tests`, found with `rg -l` path/symbol searches and verified against the actual import binding. A wildcard re-export counts once for every public symbol; a dynamic namespace import counts for runtime exports, not erased types. Private declarations have zero external consumers, even if unrelated same-named declarations occur elsewhere. Transitive barrel clients are covered by the Lab domain gate, not double-counted. Total direct module consumers: **8**.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| FORBIDDEN_KEY | const | 10–10 | no | 0 | src/lab/artifacts/sanitize.ts |
| SECRETISH | const | 11–11 | no | 0 | src/lab/artifacts/sanitize.ts |
| SECRETISH_GLOBAL | const | 12–12 | no | 0 | src/lab/artifacts/sanitize.ts |
| redactForArtifact | function | 14–27 | yes | 2 | src/lab/artifacts/sanitize.ts |
| FORBIDDEN_CONTRACT_KEYS | const | 29–29 | no | 0 | src/lab/artifacts/sanitize.ts |
| assertNoSecretMaterial | function | 31–53 | no | 0 | src/lab/artifacts/sanitize.ts |
| scrubValue | function | 55–80 | no | 0 | src/lab/artifacts/sanitize.ts |
| JWT_RE | const | 99–99 | no | 0 | src/lab/artifacts/sanitize.ts |
| EMAIL_RE | const | 108–109 | no | 0 | src/lab/artifacts/sanitize.ts |
| PREFIXED_ACCOUNT_RE | const | 113–113 | no | 0 | src/lab/artifacts/sanitize-accounts.ts |
| UUID_RE | const | 114–114 | no | 0 | src/lab/artifacts/sanitize-accounts.ts |
| MAC_RE | const | 121–121 | no | 0 | src/lab/artifacts/sanitize.ts |
| IPV4_RE | const | 122–122 | no | 0 | src/lab/artifacts/sanitize.ts |
| HOSTNAME_RE | const | 142–142 | no | 0 | src/lab/artifacts/sanitize.ts |
| STRONG_HOST_CONTEXT_RE | const | 163–164 | no | 0 | src/lab/artifacts/sanitize.ts |
| WEAK_HOST_CONTEXT_RE | const | 165–166 | no | 0 | src/lab/artifacts/sanitize.ts |
| DOTTED_NAMESPACE_RE | const | 173–173 | no | 0 | src/lab/artifacts/sanitize.ts |
| RESERVED_HOST_NAMES | const | 190–190 | no | 0 | src/lab/artifacts/sanitize.ts |
| PROSE_AFTER_MARKER | const | 191–194 | no | 0 | src/lab/artifacts/sanitize.ts |
| isHostCandidate | function | 195–204 | no | 0 | src/lab/artifacts/sanitize.ts |
| AMBIGUOUS_HOST_RE | const | 212–212 | no | 0 | src/lab/artifacts/sanitize.ts |
| CONTEXTUAL_HOST_TOKEN_RE | const | 221–221 | no | 0 | src/lab/artifacts/sanitize.ts |
| ACCOUNT_LABEL_RE | const | 229–229 | no | 0 | src/lab/artifacts/sanitize-accounts.ts |
| IDENTIFIER_ONLY_RE | const | 230–230 | no | 0 | src/lab/artifacts/sanitize-accounts.ts |
| UNQUOTED_TERMINATOR | const | 231–231 | no | 0 | src/lab/artifacts/sanitize-accounts.ts |
| isPrefixedAccount | function | 233–238 | no | 0 | src/lab/artifacts/sanitize-accounts.ts |
| scrubUrlPath | function | 246–266 | no | 0 | src/lab/artifacts/sanitize-accounts.ts |
| isIdentifierShape | function | 268–270 | no | 0 | src/lab/artifacts/sanitize-accounts.ts |
| UUID_ANYWHERE_RE | const | 272–272 | no | 0 | src/lab/artifacts/sanitize-accounts.ts |
| redactIdentifiersInText | function | 281–283 | no | 0 | src/lab/artifacts/sanitize-accounts.ts |
| decodeToFixedPoint | function | 286–299 | no | 0 | src/lab/artifacts/sanitize-accounts.ts |
| isIpv4 | function | 302–306 | no | 0 | src/lab/artifacts/sanitize-addresses.ts |
| isIpv6 | function | 309–338 | no | 0 | src/lab/artifacts/sanitize-addresses.ts |
| redactIpv6 | function | 345–389 | no | 0 | src/lab/artifacts/sanitize-addresses.ts |
| redactScannedSpans | function | 392–410 | no | 0 | src/lab/artifacts/sanitize-addresses.ts |
| redactContextualAccounts | function | 422–459 | no | 0 | src/lab/artifacts/sanitize-accounts.ts |
| scrubString | function | 461–530 | no | 0 | src/lab/artifacts/sanitize.ts |
| TRUNCATION_MARKERS | const | 532–544 | no | 0 | src/lab/artifacts/sanitize-truncate.ts |
| truncateUtf8 | function | 554–577 | yes | 5 | src/lab/artifacts/sanitize-truncate.ts |
| sanitizeDiagnostic | function | 580–582 | yes | 8 | src/lab/artifacts/sanitize.ts |
| sanitizedJsonBytes | function | 584–586 | yes | 1 | src/lab/artifacts/sanitize.ts |

Direct edge evidence (including public re-exports):

- `src/lab/index.ts:8` — *.
- `src/lab/observe/from-conformance.ts:6` — sanitizeDiagnostic, truncateUtf8.
- `src/lab/observe/from-live.ts:3` — sanitizeDiagnostic, truncateUtf8.
- `src/lab/projection/rebuild.ts:5` — sanitizeDiagnostic.
- `src/lab/fabric/observe.ts:2` — sanitizeDiagnostic, truncateUtf8.
- `src/lab/artifacts/store.ts:23` — redactForArtifact, sanitizeDiagnostic.
- `src/lab/query/dto-map.ts:1` — sanitizeDiagnostic.
- `tests/lab/lab-evidence-sanitization.test.ts:22` — sanitizeDiagnostic, truncateUtf8.

Import declarations are not new owners: their exact leaf/residual binding allocations are given below. No default export exists.

## Leaf partition

Reuse the existing same-directory sibling convention: `events/limits.ts`, `events/errors.ts`, `ledger/artifact-refs.ts`, `artifacts/secure-fs.ts`, `fabric/producer-protocol.ts`. The five source directories and proposed names were inspected with `rg --files`; none of the new paths exists at the pinned source. No new index/barrel, generic utils module, package or directory is needed. The original paths are compatibility boundaries explicitly retained by the split-train contract, not new internal convenience barrels.

Move complete source slices with their inline/leading comments as listed; only add the listed imports, named re-exports and leaf-local export modifiers needed by other leaves/the residual. Never re-export formerly private implementation helpers from the original public path.

### src/lab/artifacts/sanitize-accounts.ts

- Original slices: `src/lab/artifacts/sanitize.ts:110–114`, `src/lab/artifacts/sanitize.ts:222–299`, `src/lab/artifacts/sanitize.ts:412–459`.
- Symbols: `PREFIXED_ACCOUNT_RE`, `UUID_RE`, `ACCOUNT_LABEL_RE`, `IDENTIFIER_ONLY_RE`, `UNQUOTED_TERMINATOR`, `isPrefixedAccount`, `scrubUrlPath`, `isIdentifierShape`, `UUID_ANYWHERE_RE`, `redactIdentifiersInText`, `decodeToFixedPoint`, `redactContextualAccounts`.
- Expected lines: **133** = 131 moved lines + 0 import/header-separator lines + 2 inter-slice separators; ≤400.
- Additional leaf-only exports for existing cross-partition calls: `PREFIXED_ACCOUNT_RE`, `scrubUrlPath`, `redactContextualAccounts`.
- Own imports: none (dependency-free).

### src/lab/artifacts/sanitize-addresses.ts

- Original slices: `src/lab/artifacts/sanitize.ts:301–410`.
- Symbols: `isIpv4`, `isIpv6`, `redactIpv6`, `redactScannedSpans`.
- Expected lines: **110** = 110 moved lines + 0 import/header-separator lines + 0 inter-slice separators; ≤400.
- Additional leaf-only exports for existing cross-partition calls: `isIpv4`, `redactIpv6`, `redactScannedSpans`.
- Own imports: none (dependency-free).

### src/lab/artifacts/sanitize-truncate.ts

- Original slices: `src/lab/artifacts/sanitize.ts:532–577`.
- Symbols: `TRUNCATION_MARKERS`, `truncateUtf8`.
- Expected lines: **46** = 46 moved lines + 0 import/header-separator lines + 0 inter-slice separators; ≤400.
- Additional leaf-only exports for existing cross-partition calls: none; preserve existing exported declaration modifiers.
- Own imports: none (dependency-free).

Residual `src/lab/artifacts/sanitize.ts`: **302 expected lines**. Retained declarations: `FORBIDDEN_KEY`, `SECRETISH`, `SECRETISH_GLOBAL`, `redactForArtifact`, `FORBIDDEN_CONTRACT_KEYS`, `assertNoSecretMaterial`, `scrubValue`, `JWT_RE`, `EMAIL_RE`, `MAC_RE`, `IPV4_RE`, `HOSTNAME_RE`, `STRONG_HOST_CONTEXT_RE`, `WEAK_HOST_CONTEXT_RE`, `DOTTED_NAMESPACE_RE`, `RESERVED_HOST_NAMES`, `PROSE_AFTER_MARKER`, `isHostCandidate`, `AMBIGUOUS_HOST_RE`, `CONTEXTUAL_HOST_TOKEN_RE`, `scrubString`, `sanitizeDiagnostic`, `sanitizedJsonBytes`.

Line accounting: 586 logical source lines − 287 moved lines + 3 explicit import/re-export lines = 302. The inventory's 585 is `wc -l`: the original lacks a trailing newline and has 586 logical lines. Keep formatting compact as shown; extra formatting lines must still fit the 400-line gate. No residual exceeds 400; no #b layer is required for file size.

Changeset accounting: 287 original lines move; raw additions+deletions for the move alone are 574, before import glue. **Parent decision required:** this exceeds the ≤500 changed-source-line/default PR limit if measured as raw Git additions+deletions. The fixed five-layer S15 map does not allocate a #b for this file. Do not claim this layer satisfies that limit. Parent must explicitly accept a pure-move size exception (with moved-line review evidence) or revise the train topology before code execution. This document does not authorize either change.

## Re-export block

Exact named re-exports to add/retain at the original path:

```ts
export { truncateUtf8 } from "./sanitize-truncate";
```

redactForArtifact, sanitizeDiagnostic and sanitizedJsonBytes remain exported declarations.

Explicit local imports for the residual (add alongside unchanged original imports); re-export statements bind nothing locally:

```ts
import { PREFIXED_ACCOUNT_RE, scrubUrlPath, redactContextualAccounts } from "./sanitize-accounts";
import { isIpv4, redactIpv6, redactScannedSpans } from "./sanitize-addresses";
```

The residual does not call truncateUtf8, so no local truncateUtf8 import is needed.

## Module-level state and cycles

`RESERVED_HOST_NAMES` (190) and `PROSE_AFTER_MARKER` (191–194) stay private in sanitize.ts, with isHostCandidate and its ordered host replacements. No top-level let/Map/WeakMap/lock exists.
Stateful RegExp objects are not duplicated: `PREFIXED_ACCOUNT_RE` (113), `ACCOUNT_LABEL_RE` (229), `UUID_ANYWHERE_RE` (272) move once to sanitize-accounts.ts. PREFIXED_ACCOUNT_RE is a leaf export only because the existing ordered scrubString pipeline also uses that exact object; preserve its global flags and isPrefixedAccount's lastIndex resets (234,236), plus contextual account cursor updates (425,455). Do not clone it in the façade or expose it through lab/index.ts. UUID_RE (114), IDENTIFIER_ONLY_RE (230), UNQUOTED_TERMINATOR (231) are private leaf patterns. SECRETISH_GLOBAL (12), JWT_RE (99), EMAIL_RE (108), MAC_RE (121), IPV4_RE (122), HOSTNAME_RE (142), STRONG_HOST_CONTEXT_RE (163), WEAK_HOST_CONTEXT_RE (165) stay in the façade; the source inventory records the other non-global patterns too. TRUNCATION_MARKERS (532–544) has one private owner in sanitize-truncate.ts.
New edges are sanitize → accounts/addresses/truncate; all three leaves have no imports. In particular accounts does not import SECRETISH or scrubString from sanitize. The global-regex reuse is existing stateful lexical coupling, not permission to add new mutations or resets. Keeping scrubString in place preserves the total replacement order and avoids a façade/leaf back-edge.

Existing lane evidence found no cycle through this file. Recheck the concrete resolved graph at implementation tip, including type-only edges; typecheck alone does not prove acyclicity. This plan introduces only the directed edges above. Do not change protected core roots, turn startServer async, or add activation imports into them.

## Tests

Direct import/dynamic-import test `rg -l` list, all **unchanged** at their original import path:

- `tests/lab/lab-evidence-sanitization.test.ts` — unchanged (import at 22).

Discovery commands (run across all tests, not just tests/lab):

```sh
rg -l 'src/lab/artifacts/sanitize' tests --glob '*.ts'
rg -n 'src/lab/artifacts/sanitize|sanitize\.ts' tests --glob '*.ts'
rg -n 'readFileSync|Bun\.file|readFile\(|source\(' tests --glob '*.ts'
```

Dedicated source-text readers of this file: **none found**. No retarget-to-leaf or add-leaf-to-scan-list is required for a dedicated source oracle.
The generic `tests/lab/core-lab-boundary.test.ts` reads traversed source at **69**, protected roots at **278/336**, and the server composition source at **355**. It reports the first edge into Lab before traversing that target, so these Lab leaves are not dedicated source-text inputs on a successful run. Disposition: **unchanged**, no scan-list addition, never edit `PROTECTED` (20–28). Include its existing negative-fixture cases in the implementation gate.

Additional transitive-barrel/behavioral coverage: `tests/lab/lab-evidence-ledger.test.ts` — unchanged; `tests/lab/lab-fabric-task.test.ts` — unchanged. Run `tests/lab` for all indirect callers.

Guards to drive red once during implementation (temporary mutations must be restored before committing):

Drive the account/path punctuation corpus (`tests/lab/lab-evidence-sanitization.test.ts:128,160,184,355`) red once with a temporary account-redactor bypass, then restore. Drive the marker/code-point truncation guard at 373 red once by temporarily replacing the moved truncator with a naïve slice, then restore. Keep address/compressed-form cases (146), false-positive preservation (115,338), and the integration sinks (385,437) unchanged. These are behavioral guards, not source oracles.

No tests or red mutations were run while drafting this plan; these are executor obligations.

## Verification

Instantiate `002_layer_map.md` Per-layer gate in the dedicated layer worktree, not this docs worktree:

```sh
bun run typecheck
bun test tests/lab/lab-evidence-sanitization.test.ts tests/lab/lab-evidence-ledger.test.ts tests/lab/lab-fabric-task.test.ts
bun test tests/lab
bun run privacy:scan
bun test tests/lab/core-lab-boundary.test.ts
wc -l src/lab/artifacts/sanitize-accounts.ts src/lab/artifacts/sanitize-addresses.ts src/lab/artifacts/sanitize-truncate.ts src/lab/artifacts/sanitize.ts
rg -n 'lab/artifacts/sanitize|from "./sanitize"' src gui/src scripts tests
git diff --check
git diff --numstat origin/dev...HEAD
# Full repository suite: remote only, exact branch tip; pipefail preserves failures.
ssh lidge 'bash -o pipefail -c "cd ~/ocx-ci/opencodex && git fetch origin codex/split-lab-artifacts-sanitize && git checkout -q FETCH_HEAD && git rev-parse HEAD && bun install --frozen-lockfile && bun run test 2>&1 | tail -15"'
```

Required outcome: all local gates exit 0; focused/domain tests have zero failures; every leaf and residual ≤400. The boundary test is included explicitly even though no protected source is edited. Confirm the remote printed SHA equals the layer tip and save the full exit status plus test totals; the tail alone is not proof. Full suite remains remote-only.

Compare resolved direct consumer bindings against the 8-file baseline above (raw basename grep is only a candidate search and can include unrelated modules). Leaf names matching the search are not new original-path consumers. Existing public callers must not need migration. Include wildcard re-export consumers in this comparison. Use the already available parser/import-graph mechanism, or a read-only resolver, to report no cycles containing this residual or any new leaf, including type edges; do not install a new analyzer just for this split. Verify moved declaration bodies are identical to origin/dev after stripping only the newly required export modifiers, and inspect `git diff --color-moved` for accidental behavior edits.

For PR readiness, record exact-head CI (Linux, macOS, Windows) and review status separately from local checks. No tests, typecheck, privacy scan or remote suite have been executed in this docs-only delegation.

## Accept criteria

1. Exactly this layer's original source plus the listed 3 new leaves and necessary existing-test adjustments are changed at implementation time; no other S15 file is implemented in this PR.
2. The complete inventory above has exactly one implementation/type owner per declaration; all original public names resolve from `src/lab/artifacts/sanitize.ts`, with no newly public private helper.
3. Every moved body, constant initializer, comment-backed order and signature matches the pinned source; only import/export plumbing changes.
4. Leaf line counts are 133 for `src/lab/artifacts/sanitize-accounts.ts`, 110 for `src/lab/artifacts/sanitize-addresses.ts`, 46 for `src/lab/artifacts/sanitize-truncate.ts` (or verified formatted equivalents ≤400); residual is approximately 302, always ≤400. No deferred >400 residual.
5. State owners and operation lifetimes match the state section; resolved import graph has no cycle involving the partition.
6. Direct test imports and all source-oracle dispositions are applied exactly as listed; named guards have recorded red→restored-green evidence, without weakening assertions or editing protected roots.
7. Every instantiated local gate and exact-tip remote suite succeeds; source/consumer inventory and privacy scan are recorded. No repository-wide local suite.
8. The parent has explicitly resolved the raw-diff size exception/topology escalation before source implementation.
9. PR base is `codex/split-lab-ledger-store`, stack map contains all five layers, and exact-head CI is green. No merge is performed.

## PR

Title: `refactor(lab-artifacts): separate lexical redaction and UTF-8 truncation (split S15 L3/5)`

Branch: `codex/split-lab-artifacts-sanitize`. Base: `dev`. Closes: **none**.

Use every section of `.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification, Checklist). Include this full DEV-STACK-03 map; placeholder PR numbers are intentional until the parent creates the PRs. Review only this layer's diff against its base; L3 is the current layer.

| Layer | PR | Branch | Base | Review focus |
|---|---|---|---|---|
| L1/5 | #TBD-S15-L1 | codex/split-lab-events-validate | dev | separate field subject and claim validators |
| L2/5 | #TBD-S15-L2 | codex/split-lab-ledger-store | codex/split-lab-events-validate | isolate ledger lock ownership |
| L3/5 | #TBD-S15-L3 | codex/split-lab-artifacts-sanitize | dev | separate lexical redaction and UTF-8 truncation |
| L4/5 | #TBD-S15-L4 | codex/split-lab-fabric-observe | codex/split-lab-artifacts-sanitize | isolate producer outcome validation |
| L5/5 | #TBD-S15-L5 | codex/split-lab-fabric-scratch | dev | separate scratch access from fixture lifetime |

Base: dev — no dependency on lower layers; this layer is the parent of 510 (branch based on it), so any change here cascades into that layer with `git rebase --update-refs` + `--force-with-lease` before review (DEV-STACK-02).

No merge authorization is conveyed by the plan. The current delegated task performs no Git mutation or PR action.
