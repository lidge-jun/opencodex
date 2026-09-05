# 200 — S06 L2/2: artifact storage and pinned transfer

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: `pure-move`. C3 structural planning; future implementation needs explicit security review of the moved destination-policy and retention boundary, without changing it. Parent owns orchestration/goal state.
- Goal: reduce `src/images/artifacts.ts` from 552 lines to ≤330 through focused storage and HTTPS leaves; retain every original API and image/video budget, permission, cancellation, redirect, pinning and retention behavior.
- Non-goals: no security fixes, new validation, URL-policy changes, budget changes, format changes, write-mode cleanup, new transport, framework/dependency, caller migrations, new tests/tooling, merge or release.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below. Stop at an independently passing layer with an open exact-head-green PR. No merge.
- Escalation: changed source basis, missing oracle, a body/signature change, unresolved cycle, >400 leaf/residual, extra file requirement, or a >500-line hard sizing interpretation must return to the parent. Findings requiring security work go only to ignored scratch. This task writes only the two assigned S06 docs; no code, tests, git mutation or cxc orchestration commands.
- Size note: the 249-line physical move is about 498 raw added+deleted lines before imports/re-exports. Wiring can exceed the DEFAULT 500-line threshold. Request the same move-aware sizing decision as L1; do not claim the 002 threshold passes by ignoring additions or deletions or invent an unassigned layer.

Basis: docs HEAD `4cc219549`; code `origin/dev` `1362b1a3841b4de20177e5d65865a513dd7936c4`. Source/test citations below refer to that basis. Source matches the working tree. Read 000/001/002 plus `devlog/_plan/260905_modular_debt_ledger/014_lane_adapters_media.md`'s `src/images/artifacts.ts` section: paths :83–95, prune :140–173, pinned connect :302–331, image :361–416 and video :454–552. Current graph: Google adapter, image bridge and server → artifacts → config, filesystem, destination-policy and pinned-http. Intended graph: unchanged callers → artifacts → `artifact-store.ts` / `artifact-transfer.ts` → existing dependencies. Blast radius: image feature/public artifact boundary; no transport implementation is duplicated.

Structural decision: split storage/retention and pinned transfer; keep image/video materialization and turn budgets together in the original boundary. Rejected: do nothing/delete/configure cannot resolve size with export preservation; moving video first while importing path helpers back from `artifacts.ts` creates a cycle; reimplementing pinned HTTP duplicates the canonical `src/lib/pinned-http.ts`. Searches for `timestampPrefix`, `connectPublicHttps`, `writeArtifactUnique` and `getArtifactsDir` locate this owner; keep the existing destination-policy and pinned-http APIs. Reuse sibling naming (`src/images/{fulfill-video,xai-video-client,synthetic-tool}.ts`) and the already-established leaf structure (`src/vision/timeout-bounds.ts`, `src/config/provider-name.ts`). No new internal index/barrel.

Direct source dependents: `src/adapters/google.ts:4`, `src/images/fulfill.ts`, `src/images/fulfill-video.ts`, `src/images/loop.ts`, `src/server/images.ts:46`, and dynamic `src/server/index.ts:1800`. Existing path imports remain untouched. S06 L1 must already be this branch's base even though there is no direct import between the two source files.

## Symbol inventory

AST ranges from `git show origin/dev:src/images/artifacts.ts`, cross-checked with numbered source/`rg`. Ranges exclude leading comments. Consumer count = distinct external consumer files with `rg -l -w '<symbol>'` among resolved static/dynamic/mock importers, with import bindings inspected. Include `tests/images/download-cap-default.test.ts:30–32`'s multiline template import with `?cap=…`, which a simple static-import regex misses. Boundary fan-in: **13 files = 6 source + 7 tests**, counting the mock consumer. S=`src/images/artifact-store.ts`; T=`src/images/artifact-transfer.ts`; A=residual `src/images/artifacts.ts`.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| MAX_DECODED_BYTES_PER_IMAGE | const | 11–11 | no | 0 | A |
| MAX_DECODED_BYTES_PER_RESPONSE | const | 12–12 | no | 0 | A |
| MAX_DOWNLOAD_BYTES | const | 14–14 | yes | 1 | T |
| DOWNLOAD_IDLE_TIMEOUT_MS | const | 16–16 | yes | 0 | T |
| MAX_ENCODED_BYTES_PER_IMAGE | const | 25–25 | yes | 3 | A |
| DEFAULT_ARTIFACT_KEEP_COUNT | const | 28–28 | yes | 1 | S |
| ARTIFACT_HTTP_PREFIX | const | 31–31 | yes | 0 | S |
| ARTIFACT_ID_RE | const RegExp | 33–33 | no | 0 | S |
| BASE64_RE | const RegExp | 37–37 | no | 0 | A |
| ImageBudget | interface | 39–41 | yes | 1 | A |
| PinnedDownloadFn | type alias | 44–48 | yes | 1 | T |
| createImageBudget | function | 50–52 | yes | 5 | A |
| chargeImageBudget | function | 55–61 | yes | 0 | A |
| getArtifactsDir | function | 63–65 | yes | 0 | S |
| artifactHttpUrl | function | 71–77 | yes | 2 | S |
| resolveArtifactPath | function | 83–95 | yes | 1 | S |
| readArtifactBytes | function | 97–109 | yes | 0 | S |
| decodeValidatedImageBase64 | function | 115–132 | yes | 1 | A |
| pruneOldArtifacts | function | 140–173 | yes | 1 | S |
| timestampPrefix | function | 175–188 | no | 0 | S (internal named export) |
| writeArtifactUnique | async function | 196–213 | no | 0 | S (internal named export) |
| sniffImageExtension | function | 216–225 | yes | 1 | A |
| guessExtFromMagic | function | 227–233 | yes | 1 | A |
| pruneArtifacts | function | 236–238 | yes | 4 | S |
| materializeInlineImage | async function | 240–257 | yes | 6 | A |
| pinnedHttpsGet | function | 267–292 | yes | 1 | T |
| pickPinnedAddress | function | 294–296 | no | 0 | T |
| connectPublicHttps | async function | 302–331 | no | 0 | T (internal named export) |
| fetchPublicHttpsImage | async function | 340–359 | yes | 2 | T |
| downloadImageToArtifact | async function | 361–416 | yes | 3 | A |
| MAX_VIDEO_DOWNLOAD_BYTES | const | 418–418 | no | 0 | A |
| MAX_VIDEO_BYTES_PER_TURN | const | 420–420 | no | 0 | A |
| VideoBudget | interface | 422–426 | yes | 1 | A |
| createVideoBudget | function | 428–430 | yes | 2 | A |
| chargeVideoBudget | function | 433–437 | yes | 0 | A |
| guessVideoExtFromMagic | function | 439–447 | yes | 0 | A |
| downloadVideoToArtifact | async function | 454–552 | yes | 2 | A |
| PinnedAddress | type re-export | 9–9 | yes | 0 | existing ../lib/pinned-http via A |

All seven import declarations: :1 `readdirSync/readFileSync/statSync/unlinkSync/existsSync` move to S; :2 `writeFile` shared by A/S, `mkdir/open/unlink` stay A; :3 `basename/resolve/sep` move to S, `join` needed by both A/S; :4 `getConfigDir` needed by both A/S; :5 destination assessment/resolution move to T; :6 `recordOwnedConfigPath` stays A; :7 `pinnedHttpGet` and `PinnedAddress` move to T, with the existing type re-export retained in A. No other top-level declaration or executable initializer exists.

## Leaf partition

1. **`src/images/artifact-store.ts` — expected ≤160 lines.** Owns exactly S rows. Move :27–33, :63–109, :134–213, :235–238, with comments: **138 original lines**, plus ≤22 import/separator lines. `timestampPrefix` and `writeArtifactUnique` acquire internal named exports only because A calls them. `ARTIFACT_ID_RE` remains private. Own imports:

   ```ts
   import { readdirSync, readFileSync, statSync, unlinkSync, existsSync } from "node:fs";
   import { writeFile } from "node:fs/promises";
   import { basename, join, resolve, sep } from "node:path";
   import { getConfigDir } from "../config";
   ```

2. **`src/images/artifact-transfer.ts` — expected ≤125 lines.** Owns exactly T rows. Move :13–16, :43–48, :259–359: **111 original lines**, plus ≤14 import/separator lines. `connectPublicHttps` becomes an internal named export for A's video downloader; `pickPinnedAddress` remains private. Keep the cap, timeout, callback signature, response cancellation and error text verbatim. Own imports:

   ```ts
   import { assessUrlDestination, resolvePublicAddresses } from "../lib/destination-policy";
   import { pinnedHttpGet, type PinnedAddress } from "../lib/pinned-http";
   ```

3. **Residual `src/images/artifacts.ts` — expected ≤330 lines.** Exactly A rows, image/video materialization, both budgets and both magic-format decisions remain. Arithmetic: 552 − 138 − 111 = 303 original lines; replace original :1–9 import/re-export header with ≤36 lines → ≤330. No `#b` is required for residual size. Combined allowance: ≤615 = 330 + 160 + 125, a maximum net +63 wiring/separator lines, with no duplicated bodies. Measure actual line counts, not a compressed formatting proxy.

In-memory physical-line accounting using these ranges and the exact import/export blocks below produced **S=146, T=116, residual=320** (582 total = 552 + 30 wiring lines). The larger bounds reserve formatting room. This is plan accounting, not an implementation/test result; the three internal helpers need an `export` keyword but no additional source line.

## Re-export block

Exact exports added/retained at the original `src/images/artifacts.ts` path; all A-row local exports stay in place:

```ts
export type { PinnedAddress } from "../lib/pinned-http";
export {
  DEFAULT_ARTIFACT_KEEP_COUNT,
  ARTIFACT_HTTP_PREFIX,
  getArtifactsDir,
  artifactHttpUrl,
  resolveArtifactPath,
  readArtifactBytes,
  pruneOldArtifacts,
  pruneArtifacts,
} from "./artifact-store";
export {
  MAX_DOWNLOAD_BYTES,
  DOWNLOAD_IDLE_TIMEOUT_MS,
  pinnedHttpsGet,
  fetchPublicHttpsImage,
} from "./artifact-transfer";
export type { PinnedDownloadFn } from "./artifact-transfer";
```

Explicit replacement imports for A (a re-export does not bind its name locally):

```ts
import { mkdir, writeFile, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { getArtifactsDir, timestampPrefix, writeArtifactUnique } from "./artifact-store";
import { MAX_DOWNLOAD_BYTES, connectPublicHttps, fetchPublicHttpsImage, type PinnedDownloadFn } from "./artifact-transfer";
```

Do not re-export internal `connectPublicHttps`, `timestampPrefix`, or `writeArtifactUnique` from A. Do not retarget consumers to leaves: notably `tests/images/z-fulfill.test.ts:32` must still mock the original module.

## Module-level state and cycles

- No top-level `let`, Map, Set, WeakMap, cache, lock or timer exists. `ARTIFACT_ID_RE` (:33) belongs only to S; `BASE64_RE` (:37) stays only in A. Both regexes lack global/sticky flags. Scalar constants have one owner per the table; `MAX_DOWNLOAD_BYTES` must not be restated in A.
- Budgets (:39–41, :422–426) are per-call objects returned by their factories, not module-global state. Keep check+charge sequencing at :55–61 and :433–437. Video reader/file handle and cleanup state (:493–550) remain one local lifetime in A. Naming still calls `new Date()` and `crypto.randomUUID()` per write; no import-time timestamp or memoization.
- A→S and A→T only; S→config/node fs/path; T→destination-policy/pinned-http. Neither leaf imports A, the other leaf, `images/index.ts`, or vision. Exporting `getArtifactsDir` from S avoids S→A; T owns both constants and `PinnedDownloadFn` to avoid T→A type/constant back-edges.
- Lane G1 found no cycle. Future executor must run its in-memory resolved graph walk including type edges on A/S/T; no return path allowed. The existing config graph is not simplified in this move. New edges are functional; read/write/retention ordering and validation→DNS→pinned-connect sequencing stay inside their owners.
- Security review is required for a pure move across this boundary: prove policy calls at :316–321, HTTPS rejection, pinned transport options/defaults :322–329, image/non-2xx handling :348–357, and unique-write options :206 are unchanged. No additional defense or unrelated security finding belongs in this public planning document.

## Tests

`rg -l 'artifacts' tests -g '*.test.ts'`, filtered to actual imports/mock declarations (including multiline template imports), yields this complete consumer list. Every row stays **unchanged**:

| test file | import/mock location | disposition |
|---|---|---|
| `tests/images/artifacts-prune.test.ts` | :12, :70 | unchanged; public retention/materialization exports |
| `tests/images/artifacts-ssrf.test.ts` | :9 | unchanged; destination/pinning behavior through public download |
| `tests/images/download-cap-default.test.ts` | :30–32 | unchanged; template-query dynamic import, mock before import |
| `tests/images/gemini-inline.test.ts` | :5 | unchanged; budget and inline materialization |
| `tests/images/pinned-https-get.test.ts` | :84, :115, :170, :234, :262, :310 | unchanged; dynamic imports, pinned transport contract |
| `tests/images/z-fulfill.test.ts` | :32 `mock.module` | unchanged; preserve the original mock boundary |
| `tests/server/server-images.test.ts` | :16, :2541 | unchanged; adapter/server API consumers |

No target-specific body-text oracle was found for `artifacts.ts`; artifact file reads in `gemini-inline.test.ts:122` are generated image bytes, not source. Do not rewrite them into leaf-source assertions. General recursive source guards also read this file:

| test | exact source read | disposition |
|---|---|---|
| `tests/codex-integration/codex-history-reachability.test.ts` | :100 and :114; recursive `src` discovery :54–61 | unchanged; S/T automatically included; no allowlist expansion |
| `tests/windows/windows-popup-fix.test.ts` | :139; recursive discovery :121–129 | unchanged; S/T automatically included |
| `tests/lab/core-lab-boundary.test.ts` | :69; traversal from protected roots | unchanged; existing core→adapter graph reaches artifact handling; named leaf edges are followed without changing PROTECTED |

No explicit add-leaf-to-scan-list or retarget-to-leaf change is required; verify recursive discovery includes both new files. The `?cap=` query only refreshes the facade, not necessarily its new dependency; run that mock-bearing test in its own process as shown below and do not add query propagation or a production factory. If exact-head CI reveals cross-test contamination, escalate a test-only path/isolation adjustment with evidence rather than silently changing the production API.

Drive guards red once in future C: temporarily remove T's `?? MAX_DOWNLOAD_BYTES` at original :327 and require `download-cap-default.test.ts:35` to fail; temporarily change S's non-positive retention early return at original :142 and require `artifacts-prune.test.ts:50` to fail. Confirm public-path pinned redirect/limit tests remain green after restoring the originals. For recursive coverage, inject a forbidden PowerShell argv literal in each leaf and require the Windows source scan to report that path, then restore it. No fault injection or tests are run in this drafting task.

## Verification

Draft validation actually performed: read-only `bun -e` parser checks matched all **37** definition rows to original start/end lines, checked the nine headings in order, parsed every TypeScript snippet, and counted proposed files in memory. `git diff --no-index --check /dev/null devlog/_plan/260905_now_split_train/200_images_artifacts.md` reported no whitespace errors. No tests, typecheck, code edits or git mutations were performed.

Future executor commands at S06 L2's exact tip, not merely the already-verified parent tip:

```sh
bun run typecheck
bun test tests/images/download-cap-default.test.ts
bun test tests/images/artifacts-prune.test.ts tests/images/artifacts-ssrf.test.ts tests/images/gemini-inline.test.ts tests/images/pinned-https-get.test.ts
bun test tests/images/z-fulfill.test.ts
bun test tests/images/loop.test.ts
bun test tests/images/loop-reasoning-replay.test.ts
bun test tests/images/z-handler-activation.test.ts
bun test tests/images/plan.test.ts tests/images/synthetic-tool.test.ts tests/images/xai-client.test.ts
bun test tests/server/server-images.test.ts
bun test tests/lab/core-lab-boundary.test.ts tests/codex-integration/codex-history-reachability.test.ts tests/windows/windows-popup-fix.test.ts
bun run privacy:scan
wc -l src/images/artifact-store.ts src/images/artifact-transfer.ts src/images/artifacts.ts
rg -n '(from|import|mock\.module).*artifacts|src/images/artifacts|from "\./artifacts"' src gui/src scripts tests -g '*.ts' -g '*.tsx'
```

Reconcile the final search to the same 13-file consumer inventory, including `download-cap-default` and `z-fulfill`. Use `rg -l -w` for the symbol-by-symbol check, inspect bindings for alias/type imports, and compare original AST exports to the post-split facade. A raw line count alone is not a file/import count. The commands include all 12 current `tests/images/*.test.ts` files, with mock-bearing bridge tests isolated; no repository-wide local suite. Run the lane G1 graph walk on A/S/T and require no return path. All direct tests above remain public-contract tests, not merely leaf unit tests.

Full suite is remote-only. This instantiates 002 with `pipefail`/full-log retention to prevent `tail` masking a failing test process:

```sh
ssh lidge 'bash -lc '\''set -o pipefail; cd ~/ocx-ci/opencodex && git fetch origin codex/split-images-artifacts && git checkout -q FETCH_HEAD && git rev-parse HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tee /tmp/ocx-S06-L2-tests.log | tail -15'\'''
```

Require zero failures, exit 0, full log inspection and remote SHA equality with the PR head. Parent coordinates exclusive remote-checkout use. Before ready-for-review capture full exact-head CI rollup, not an empty required-check list. Security review follows `MAINTAINERS.md`; no approval is claimed by this plan. No local full suite, browser or deployment work is required for the pure move.

## Accept criteria

1. Each top-level definition has one owner matching the inventory; only A/S/T and authorized layer docs change. Bodies, signatures, errors and defaults are unchanged.
2. S≤160, T≤125, A≤330 and all files ≤400; all 249 original moved lines accounted for once; no unassigned `#b` or formatting-only line compression.
3. Every original value/type export remains importable from `src/images/artifacts`; three new internal helper exports are not leaked through that path.
4. Original 13 consumer files and the fulfillment mock boundary are unchanged. Query-import cap test executes in a fresh process and passes.
5. Destination-policy/pinning, redirects, byte caps, image/video budgets, permissions, naming, unique-write retries, pruning and cleanup preserve the original contract; explicit security review is recorded.
6. No new cycle; recursive history/Windows/Lab guards discover the leaves; fault-injected cap/retention/source guards fail once and restored code passes.
7. Focused checks, typecheck, privacy and exact-head remote full suite/CI pass independently at L2, whose parent is the current L1 head. No merge/release.
8. Parent resolves raw diff sizing under 002 before implementation; cascading L1 changes invalidates L2 evidence until reverified.

## PR

Title: `refactor(images): separate artifact storage and pinned transfer (split S06 L2/2)`

Branch: `codex/split-images-artifacts`. Base: `dev`. Closes: none.

Fill `.github/PULL_REQUEST_TEMPLATE.md` Summary, Verification and Checklist, including security-review evidence. DEV-STACK-03 map (future PR numbers remain placeholders):

| # | PR | Layer | Branch | Base | Review focus |
|---|---|---|---|---|---|
| 2 | #TBD-S06-L2 | images artifacts ← you are here | codex/split-images-artifacts | dev | storage/HTTPS leaves, original artifact API |
| 1 | #TBD-S06-L1 | vision | codex/split-vision-index | dev | planning/rewrite leaves, co-located cache |

Base: dev — no dependency on the layers below; no cascade obligation.

Review only this layer's diff. S06 groups execution order and PR navigation under `003_parent_decisions.md` STACK-INDEPENDENCE-01; both layers are independent PRs against dev. This train stops with open PRs and never merges.
