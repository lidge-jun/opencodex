# 550 — S16 L3/5: src/lab/public/community.ts

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: pure-move. Work class: C3 architecture planning, docs-only delegated scope. Parent owns orchestration, loop and goal state; this document executes none of them.
- Goal: split `src/lab/public/community.ts` (479 lines) into the named leaves while preserving all current exports, signatures, object identities and behavior.
- Non-goals: no behavior fixes, public identifier renames, schema changes, new dependencies, import-consumer churn, function-body rewrites, core-root edits, merge, release or deployment. No code/test/git-state mutation in this drafting task.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below. Current planning basis is docs HEAD `4cc219549`, code `origin/dev = 1362b1a38`; `git diff origin/dev -- src/lab/public/community.ts` is empty. All source line anchors below refer to that code basis, not future leaf line numbers.
- Stop: drafting ends after this plan's declaration/export/state/test inventory is checked. Implementation ends only when its independent per-layer gates and exact-head CI evidence are recorded; no merge is authorized by this document.
- Escalation: stop implementation and return to the parent if source drift invalidates the partition, an export/identity changes, an oracle cannot move without weakening, a new cycle appears, any residual/leaf exceeds 400, or the fixed layer scope needs expansion. Do not create an unplanned #b or edit 002 from this task.

Public evidence validation is an existing security boundary. Require explicit security review of the move, but make no authority, privacy, signature, cache-quota, locking, filesystem safety or validation-policy changes. Any newly discovered security finding is recorded only in ignored scratch, not this public devlog.

## Symbol inventory

Origin/dev declaration spans were enumerated with `sg run --lang ts --kind 'function_declaration,lexical_declaration,interface_declaration,type_alias_declaration,export_statement' --json=compact src/lab/public/community.ts`, keeping column-zero declarations; exported declarations are counted once. Imports are not redeclarations of their source owners: original import block is src/lab/public/community.ts:1–25, and the exact post-split imports appear below.

Consumer counts mean **direct importing/re-exporting modules**, not occurrences or transitive barrel consumers. Resolved relative import clauses were checked with `rg -q -w <symbol>`; namespace imports and wildcard re-exports count once for every exported symbol. Non-exported declarations have zero external consumers. `rg --files src gui/src scripts tests` supplied the search universe. Module fan-in is 3; the mechanically requested basename-only gate returns 3.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `MAX_IMPORT_BYTES` | const | 27–27 | no | 0 | `community-input.ts` |
| `MAX_CACHE_FILES` | const | 28–28 | no | 0 | `community.ts (residual)` |
| `MAX_CACHE_BYTES` | const | 29–29 | no | 0 | `community.ts (residual)` |
| `MAX_DEPTH` | const | 30–30 | no | 0 | `community-input.ts` |
| `MAX_OBJECT_KEYS` | const | 31–31 | no | 0 | `community-input.ts` |
| `MAX_ARRAY_ELEMENTS` | const | 32–32 | no | 0 | `community-input.ts` |
| `MAX_GENERIC_STRING_BYTES` | const | 33–33 | no | 0 | `community-input.ts` |
| `COMMUNITY_MUTATION_LOCK_NAME` | const | 34–34 | no | 0 | `community.ts (residual)` |
| `COMMUNITY_BUNDLE_FILE_RE` | const | 35–35 | no | 0 | `community.ts (residual)` |
| `COMMUNITY_REVOCATION_FILE_RE` | const | 36–36 | no | 0 | `community.ts (residual)` |
| `COMMUNITY_FILE_OPTIONS` | const | 38–44 | no | 0 | `community.ts (residual)` |
| `CommunitySummaryCache` | type | 46–50 | no | 0 | `community.ts (residual)` |
| `communitySummaryCache` | let | 52–52 | no | 0 | `community.ts (residual)` |
| `assertId` | function | 54–59 | no | 0 | `community-input.ts` |
| `scanStructure` | function | 61–90 | no | 0 | `community-input.ts` |
| `boundedInput` | function | 92–108 | no | 0 | `community-input.ts` |
| `assertCommunityArtifactAuthority` | function | 110–117 | no | 0 | `community-input.ts` |
| `verifiedBundle` | function | 119–128 | no | 0 | `community-input.ts` |
| `bundleObjectPath` | function | 130–135 | no | 0 | `community.ts (residual)` |
| `revocationObjectPath` | function | 137–139 | no | 0 | `community.ts (residual)` |
| `readBounded` | function | 141–144 | no | 0 | `community.ts (residual)` |
| `cacheUsage` | function | 146–164 | no | 0 | `community.ts (residual)` |
| `assertCacheCanAdd` | function | 166–171 | no | 0 | `community.ts (residual)` |
| `persistAtLocked` | function | 173–218 | no | 0 | `community.ts (residual)` |
| `persistAt` | function | 220–231 | no | 0 | `community.ts (residual)` |
| `readJson` | function | 233–237 | no | 0 | `community.ts (residual)` |
| `files` | function | 239–241 | no | 0 | `community.ts (residual)` |
| `readVerifiedBundleAt` | function | 243–245 | no | 0 | `community.ts (residual)` |
| `bundleFromName` | function | 247–257 | no | 0 | `community.ts (residual)` |
| `bundlesFromNames` | function | 259–266 | no | 0 | `community.ts (residual)` |
| `restoreOwnPublisherOrigin` | function | 268–277 | no | 0 | `community.ts (residual)` |
| `importCommunityEvidenceBundle` | function | 279–293 | yes | 2 | `community.ts (residual)` |
| `readCommunityEvidenceBundleForPublisherLocked` | function | 295–305 | no | 0 | `community.ts (residual)` |
| `readCommunityEvidenceBundleForPublisher` | function | 307–316 | yes | 1 | `community.ts (residual)` |
| `RevocationMetadata` | type | 318–321 | no | 0 | `community-input.ts` |
| `resolveTargetBundle` | function | 323–360 | no | 0 | `community-input.ts` |
| `findTargetBundleLocked` | function | 362–387 | no | 0 | `community.ts (residual)` |
| `importCommunityEvidenceRevocation` | function | 389–409 | yes | 1 | `community.ts (residual)` |
| `communityFingerprint` | function | 411–417 | no | 0 | `community.ts (residual)` |
| `copySummaries` | function | 419–421 | no | 0 | `community.ts (residual)` |
| `listCommunityEvidenceLocked` | function | 423–475 | no | 0 | `community.ts (residual)` |
| `listCommunityEvidence` | function | 477–479 | yes | 3 | `community.ts (residual)` |

Direct production consumers / public boundaries, all preserved:

- `src/lab/public/index.ts:12`.
- `src/lab/public/operator.ts:5`.

## Leaf partition

Structural decision: Move bounded parsing, bundle validation and in-memory revocation-target resolution to community-input.ts; keep storage, locks, listing and cache invalidation together. Existing community-authority.ts, strict-json.ts, privacy.ts and signature.ts remain canonical and are reused; community-files.ts naming remains untouched. Reject lifting persistAtLocked into a separate storage leaf: its writes to communitySummaryCache at :209/:214 would require a new invalidation API or a back-import, so it is not the lowest-churn pure move. The chosen seam narrows the lane's broader import/storage recommendation to its stateless input portion.

Sibling convention evidence: `src/lab/public/community-files.ts`, `community-authority.ts`, `file-safety.ts` and `strict-json.ts` are concern-named siblings; no second community registry or generic helpers module.

The existing lane-016 inventory replaces an extra map command. Search evidence: `rg --files src/lab/public`, exact symbol searches and the direct-consumer inventory above; existing owners are reused, not copied. Doing nothing leaves the approved file-size debt; deletion/configuration would change behavior. Blast radius: local Lab feature plus unchanged entry-path consumers.

Expected counts below are an in-memory plan calculation: original complete declaration bodies and attached comments, the imports shown here, named re-exports, and one blank line between declarations. They are not a claim of executed source changes. Formatting may change the exact number; implementation must run wc and still stay ≤400. Private declarations listed in each leaf's “leaf exports” gain only the internal import seam; they are **not** added to the original public export surface.

### `src/lab/public/community-input.ts` — expected 137 lines

Symbols: `MAX_IMPORT_BYTES`, `MAX_DEPTH`, `MAX_OBJECT_KEYS`, `MAX_ARRAY_ELEMENTS`, `MAX_GENERIC_STRING_BYTES`, `assertId`, `scanStructure`, `boundedInput`, `assertCommunityArtifactAuthority`, `verifiedBundle`, `RevocationMetadata`, `resolveTargetBundle`.

Leaf exports: `MAX_IMPORT_BYTES`, `assertId`, `scanStructure`, `boundedInput`, `verifiedBundle`, `RevocationMetadata`, `resolveTargetBundle`. Everything else in this leaf stays private.

Own imports (exact):

```ts
import { jcsStringify } from "../digest";
import { validateCommunityEvidenceAuthorities } from "./community-authority";
import { validatePublicEvidencePrivacy } from "./privacy";
import { verifyPublicEvidenceBundle } from "./signature";
import { parseStrictPublicJson } from "./strict-json";
import type { PublicEvidenceBundleV1 } from "./types";
import { PublicEvidenceValidationError } from "./validate";
```

### Residual `src/lab/public/community.ts` — expected 350 lines

Retains: `MAX_CACHE_FILES`, `MAX_CACHE_BYTES`, `COMMUNITY_MUTATION_LOCK_NAME`, `COMMUNITY_BUNDLE_FILE_RE`, `COMMUNITY_REVOCATION_FILE_RE`, `COMMUNITY_FILE_OPTIONS`, `CommunitySummaryCache`, `communitySummaryCache`, `bundleObjectPath`, `revocationObjectPath`, `readBounded`, `cacheUsage`, `assertCacheCanAdd`, `persistAtLocked`, `persistAt`, `readJson`, `files`, `readVerifiedBundleAt`, `bundleFromName`, `bundlesFromNames`, `restoreOwnPublisherOrigin`, `importCommunityEvidenceBundle`, `readCommunityEvidenceBundleForPublisherLocked`, `readCommunityEvidenceBundleForPublisher`, `findTargetBundleLocked`, `importCommunityEvidenceRevocation`, `communityFingerprint`, `copySummaries`, `listCommunityEvidenceLocked`, `listCommunityEvidence`.

No #a/#b/#c subdivision: the whole file's assigned work is this layer, and no residual exceeds 400. There is no unnamed later remainder. Upstream imports retained by the residual, in addition to the local imports in the next section:

```ts
import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { jcsStringify } from "../digest";
import { ensureLabDirs, labCommunityDir } from "../paths";
import { communityBundleFileName } from "./community-files";
import { privateRegularFileSize, readPrivateRegularFile } from "./file-safety";
import { withPublicEvidenceMutationLock } from "./mutation-lock";
import { recordLocalPublicOrigin } from "./origin";
import { cleanupStalePrivateFileStages, cleanupStalePrivateFileStagesInDir, isPrivateFileStageName, publishPrivateFileExclusive } from "./private-file";
import { verifyPublicEvidenceRevocation } from "./revocation";
import { loadExistingPublicPublisher } from "./signature";
import { parseStrictPublicJson } from "./strict-json";
import type { CommunityEvidenceSummaryV1, PublicEvidenceBundleV1, PublicEvidenceRevocationV1 } from "./types";
import { PublicEvidenceValidationError } from "./validate";
```

## Re-export block

The compatibility re-export block is **empty**: this partition moves no currently exported declaration. Keep the existing exported function definitions in the original file. Do not fabricate an `export { boundedInput }` or expose any other formerly private leaf helper from the facade.

Retained exports in the original file: `importCommunityEvidenceBundle`, `readCommunityEvidenceBundleForPublisher`, `importCommunityEvidenceRevocation`, `listCommunityEvidence`. No wildcard or renamed re-export is introduced. This is preservation of an existing boundary, not a new internal convenience barrel.

Explicit local imports required by residual call sites (re-exporting binds nothing):

```ts
import { MAX_IMPORT_BYTES, assertId, scanStructure, boundedInput, verifiedBundle, resolveTargetBundle } from "./community-input";
import type { RevocationMetadata } from "./community-input";
```

## Module-level state and cycles

communitySummaryCache is the only top-level mutable singleton (community.ts:52). Keep its type at :46–50, all reads/writes (:209, :214, :427–428, :473), fingerprint (:411–417) and copy-on-read helper (:419–421) in community.ts, one owner. COMMUNITY_MUTATION_LOCK_NAME (:34) is a string, not a new lock object; the real lock remains ./mutation-lock. MAX_IMPORT_BYTES (:27) moves to community-input.ts and is explicitly imported for COMMUNITY_FILE_OPTIONS (:38–44) and persistAtLocked (:181), never duplicated. All other moved MAX_* values are immutable scalars. Sets at :340, :367, :449–450 remain per-call allocations. The dependency direction is community → community-input → existing validation authorities, never community-input → community. Existing cache/list/persist temporal coupling stays local; pure input functions are functional coupling.

Lane 016 reported no return path through this file. The proposed edges above preserve that direction; this is a design argument, not a completed implementation cycle scan. During implementation, repeat lane 016 method G (resolved static imports/exports, type-only edges and literal dynamic imports) for each new leaf and the residual, and require no new cycle. Do not “fix” a cycle with lazy imports or duplicate a type/constant. No protected core root, activation timing or optional-Lab registration seam is changed.

## Tests

Direct test import inventory, from `rg -l 'src/lab/public/community"' tests` with relative specifiers resolved and hits inspected:

| test file / import anchor | action |
|---|---|
| `tests/lab/lab-community-mutation-lock.test.ts:6` | unchanged — keep original import path |

Additional indirect/guard coverage (all unchanged unless a narrowly described case is added below):

- `tests/lab/lab-community-evidence.test.ts`.
- `tests/lab/lab-community-publisher-continuity.test.ts`.
- `tests/lab/lab-community-filename-contract.test.ts`.
- `tests/lab/lab-public-core-contract.test.ts`.
- `tests/lab/lab-public-review-fixes.test.ts`.
- `tests/lab/lab-public-deep-review-regressions.test.ts`.
- `tests/lab/lab-public-coderabbit-regressions.test.ts`.
- `tests/lab/lab-public-final-review-regressions.test.ts`.
- `tests/lab/lab-public-lifecycle-hardening.test.ts`.
- `tests/lab/lab-public-wire-contract.test.ts`.
- `tests/lab/lab-public-provenance-recovery.test.ts`.

Text-oracle inventory: **zero tests read this specific file as source**. Checked `rg -n '(executor\\.ts|persistence\\.ts|community\\.ts|verification\\.ts|verdicts\\.ts)' tests`, qualified source paths and candidate reader bodies. Therefore retarget-to-leaf = none; add-leaf-to-scan-list = none. Behavioral imports stay unchanged; source-reading tests are not weakened into export-existence checks.

The generic boundary guard reads graph nodes at `tests/lab/core-lab-boundary.test.ts:69` and its composition root at :355; its PROTECTED list (:20–28) and reader paths are unchanged. It discovers relative graph edges without a new leaf scan list. Never retarget or edit the protected production roots to accommodate this split.

No source-text guard is retargeted. Drive tests/lab/lab-community-evidence.test.ts:151 red once by temporarily bypassing validateCommunityEvidenceAuthorities inside community-input.ts:verifiedBundle, then restore; retain same-key revocation/idempotence (:159), cross-key rejection (:178), and the original-path mutation-lock test (:72). These are planned controlled mutations in an isolated implementation checkout, not changes made by this docs task.

## Verification

This is the `002_layer_map.md` Per-layer gate instantiated for S16 L3. These are **future implementation commands**, not tests run by this docs-only delegate. Run at this layer's own tip, not the top of the stack. Focused domains: tests/lab.

```sh
bun run typecheck
bun test tests/lab/lab-community-mutation-lock.test.ts tests/lab/lab-community-evidence.test.ts tests/lab/lab-community-publisher-continuity.test.ts tests/lab/lab-community-filename-contract.test.ts tests/lab/lab-public-core-contract.test.ts tests/lab/lab-public-review-fixes.test.ts tests/lab/lab-public-deep-review-regressions.test.ts tests/lab/lab-public-coderabbit-regressions.test.ts tests/lab/lab-public-final-review-regressions.test.ts tests/lab/lab-public-lifecycle-hardening.test.ts tests/lab/lab-public-wire-contract.test.ts tests/lab/lab-public-provenance-recovery.test.ts
bun test tests/lab
bun run privacy:scan
# No src/server, src/router or src/lib edit: 002's extra core-boundary command is not triggered.
wc -l src/lab/public/community-input.ts src/lab/public/community.ts
rg -n 'from "[^"]*/community"' src gui/src scripts tests | wc -l
# Full suite only on the designated remote, never in this local worktree:
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-lab-public-community && git checkout -q FETCH_HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15'
```

Focused commands overlapping the full lab domain need not be repeated on unchanged code: capture the focused red/green during the move, then domain coverage once at the final tip. Typecheck/privacy must exit 0; tests must report zero failures. The basename-only rg baseline is 3; the resolved exact-module fan-in must remain 3. Leaf names deliberately do not end in /community, so they do not inflate that gate. Recount against the actual parent if upstream changes.

The inherited remote pipeline's tail status alone is not proof of a passing Bun process: capture its complete test result and actual test exit status (enable pipefail or retain the status separately) and record the checked-out SHA. Do not treat fetch/checkout as authorization granted to this docs delegate. Parent/executor verifies remote checkout ownership before use. Record a green **complete exact-head CI rollup**, not an empty required-check list. New or modified source-oracle guards, if discovered, must be driven red and restored before claiming green. No test runner is installed for this plan.

Use `git diff --check`, `git diff --numstat <base>...HEAD` and move-aware diff inspection to prove only declaration moves/import rewiring. Compare all original exports (including erased types) to the explicit inventory. Re-run the lane-G import graph check, including type edges; a clean typecheck alone does not prove acyclicity.

## Accept criteria

1. Every declaration in the inventory has exactly one owner after the split; no duplicated mutable state or constants, and no omitted declaration.
2. All 4 original exported names remain importable from `src/lab/public/community` with the same signatures/identity; the named re-export and local-import blocks above are present exactly where needed.
3. The 1 new leaves have expected counts 137; residual expected 350. Actual `wc -l` is ≤400 for every one. No hidden #b or sixth stack layer is assumed.
4. Existing function bodies, comparison ordering, errors, cleanup/finally behavior, and allocation timing are unchanged apart from export visibility needed by the private leaf seam. No new upward or facade-back import; static/type/dynamic graph has no newly introduced cycle.
5. All direct tests keep original imports; all identified text-oracle dispositions are implemented without weakening. The named deliberate red mutation fails for the intended reason and is fully removed before the final green run.
6. The instantiated local focused/domain, typecheck and privacy gates plus the remote-only full suite pass on the recorded layer SHA, and its complete exact-head CI is green. No local full suite.
7. The PR contains only this layer's pure move and necessary existing-test additions, retains the parent branch base, and includes the full five-layer stack map. Any raw changeset above 500 lines is returned for explicit parent review; do not expand the authorized topology silently.

## PR

Title: `refactor(lab-public): extract bounded community input validation (split S16 L3/5)`

Branch: `codex/split-lab-public-community`. Base: `dev`. Closes: none.

Use every section of `.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification, Checklist); include the pure-move thesis, planned/actual counts, gate evidence and this DEV-STACK-03 map. The placeholders below are intentional pre-creation PR numbers, not existing PRs.

| # | PR | Layer | Branch | Base | Review focus |
|---|---|---|---|---|---|
| 1 | #TBD-S16-L1 | 530 | `codex/split-lab-conformance-executor` | `dev` | separate scenario transport and vector families |
| 2 | #TBD-S16-L2 | 540 | `codex/split-lab-automation-persistence` | `dev` | isolate the state-file lock owner |
| 3 | #TBD-S16-L3 | 550 — this PR | `codex/split-lab-public-community` | `dev` | extract bounded community input validation |
| 4 | #TBD-S16-L4 | 560 | `codex/split-lab-projection-verification` | `dev` | isolate suite artifact parsing |
| 5 | #TBD-S16-L5 | 570 | `codex/split-lab-projection-verdicts` | `codex/split-lab-projection-verification` | separate projection keys and claim reduction |

Base: dev — no dependency on the layers below; no cascade obligation. Every layer passes independently. Merge remains separately user-authorized; never merge or enable auto-merge as part of this plan.
