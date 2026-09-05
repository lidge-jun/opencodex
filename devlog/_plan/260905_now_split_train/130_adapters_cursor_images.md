# S04 L3/5 — images

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

Docs basis: `4cc219549`; source basis: `origin/dev = 1362b1a3841b4de20177e5d65865a513dd7936c4`. Every source line range below refers to `src/adapters/cursor/images.ts` at that source commit, not a future leaf. Read alongside 000_plan.md, 001_stale_check.md, 002_layer_map.md, and ../260905_modular_debt_ledger/014_lane_adapters_media.md (lane 014; relevant file subsection). Status: diff-level plan only; no code, Git mutation, test run, or orchestration performed by this delegate.

## Loop spec

- Archetype: **pure-move**. Work class C3 structural planning, docs-only delegated mode; the parent owns all loop/goal state.
- Goal: move the inventoried responsibilities into the named sibling leaves, each ≤400 lines, preserving the original public import path and leaving 327 expected lines in the original.
- Non-goals: no exported rename/removal, no behavior or signature change, no dependency/tooling installation, no new validation, no changes to generated protobufs, native-exec ownership, live transport scheduling, registry policy, or unrelated files. No production-module execution or test run in this drafting task.
- Verifier: 002_layer_map.md **Per-layer gate**, instantiated in Verification below. Planned commands are for the layer executor; they are not results from this draft.
- Stop: parent records an independently verified, exact-tip layer with all accepts met and exact-head CI rollup; no merge. Stop implementation immediately on a changed signature, string/wire delta, duplicated state, cycle, unaccounted source-reader, or unsupported layer-size claim.
- Escalation: source drift, required files outside this partition/test list, an actual behavior defect, or the sizing conflict below goes to the parent; do not repair it opportunistically. Unreleased security findings go only to approved scratch, never this public devlog.

Implementation sizing escalation: the move body is 383 lines (≤500 if counted once), but ordinary additions + deletions is at least 766 before glue. 002 does not define a move-discount metric. Parent must settle that metric or approve a move-only exception/revise topology before claiming the ≤500 changeset gate. This draft does not waive it.

Structural decision and pre-change map: Byte sniffers (172–197, 431–501) need no dependency. Decode/preparation policy (17–60, 71–91, 97–169, 299–425) depends only on those sniffers and Bun globals. Conversation traversal and SelectedImage/blob construction remain original. Rejected: moving sniffers alone leaves 600 lines; moving all image logic into one new file simply relocates debt. Chosen: image-format.ts and image-preparation.ts siblings, matching native-exec-fs.ts / native-exec-network.ts. Current consumers protobuf-request.ts:21, request-builder.ts:36, live-transport.ts:16, types.ts:5 → images → native-exec/gen/types (1–15). New graph: original → preparation → format; original → format and native-exec as before. No image fetch, media policy, blob-owner, or conversation-lifetime redesign.

No-code alternatives: doing nothing leaves the requested size debt; deletion/configuration cannot preserve these existing behaviors while shortening their implementation; reuse means moving the current declarations, not inventing equivalent helpers. Owner search: `rg --files src/adapters/cursor`, `rg -n '<symbol>' src gui/src scripts tests`, and the lane-014 seam audit. The named new siblings do not already exist. Existing stable imports are compatibility boundaries, not permission for new convenience barrels.

## Symbol inventory

AST evidence: `git show origin/dev:src/adapters/cursor/images.ts`; working-tree bytes compared equal; `ast-grep run --lang typescript --kind <kind> --json=compact src/adapters/cursor/images.ts` for lexical/variable/function/interface/type-alias/class declarations, filtered to top-level source starts. Ranges are inclusive, include an `export` modifier on the same line, and exclude preceding comments. 43 owned top-level declarations; imports are dependencies, not redeclared owned symbols.

Consumer counting: `rg -l 'images' src gui/src scripts tests` narrows candidates; resolve static `from` and dynamic `import()` relative specifiers to this exact file; then `rg -l -w '<symbol>' <resolved-consumer-files>` counts distinct referencing consumer files. Count excludes the defining file. Private declarations have 0 external bound consumers; their local references move with the partition. This is a file count, not call-site count; do not reuse 001's broad basename heuristic as symbol fan-in.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `MAX_CURSOR_IMAGE_BYTES` | const | 18–18 | yes | 1 | `image-preparation.ts` |
| `MAX_CURSOR_IMAGE_DECODE_BYTES` | const | 24–24 | yes | 1 | `image-preparation.ts` |
| `CURSOR_VISION_SOFT_MAX_BYTES` | const | 30–30 | yes | 1 | `image-preparation.ts` |
| `CURSOR_VISION_SOFT_MAX_BYTES_HIGH` | const | 33–33 | yes | 1 | `image-preparation.ts` |
| `CURSOR_VISION_MAX_EDGE` | const | 36–36 | yes | 0 | `image-preparation.ts` |
| `MAX_CURSOR_IMAGE_DECODE_EDGE` | const | 42–42 | yes | 1 | `image-preparation.ts` |
| `MAX_CURSOR_IMAGE_PIXELS` | const | 45–45 | yes | 1 | `image-preparation.ts` |
| `CURSOR_VISION_JPEG_QUALITIES_DEFAULT` | const | 47–47 | no | 0 | `image-preparation.ts` |
| `CURSOR_VISION_JPEG_QUALITIES_HIGH` | const | 48–48 | no | 0 | `image-preparation.ts` |
| `CURSOR_VISION_SOFT_MIN_EDGE` | const | 50–50 | no | 0 | `image-preparation.ts` |
| `CURSOR_VISION_SOFT_SHRINK` | const | 51–51 | no | 0 | `image-preparation.ts` |
| `CURSOR_VISION_PASSTHROUGH_MIME` | const | 53–59 | no | 0 | `image-preparation.ts` |
| `MAX_CURSOR_IMAGES` | const | 62–62 | yes | 1 | `images.ts` (residual) |
| `CURSOR_VISION_IMAGE_OMITTED` | const | 65–66 | yes | 1 | `image-preparation.ts` |
| `CURSOR_VISION_IMAGE_HISTORY_MARKER` | const | 69–69 | yes | 2 | `images.ts` (residual) |
| `CursorImageError` | class | 71–79 | yes | 1 | `image-preparation.ts` |
| `ResolvedCursorImage` | interface | 81–87 | yes | 1 | `image-preparation.ts` |
| `PrepareCursorImageOutcome` | type | 89–91 | yes | 0 | `image-preparation.ts` |
| `isImagePart` | function | 93–95 | no | 0 | `images.ts` (residual) |
| `estimatedBase64DecodedBytes` | function | 97–99 | no | 0 | `image-preparation.ts` |
| `isHighDetail` | function | 101–104 | no | 0 | `image-preparation.ts` |
| `softMaxBytesForDetail` | function | 106–108 | no | 0 | `image-preparation.ts` |
| `jpegQualitiesForDetail` | function | 110–112 | no | 0 | `image-preparation.ts` |
| `decodeCursorImageDataUrl` | function | 114–161 | yes | 1 | `image-preparation.ts` |
| `throwIfImagePhaseAborted` | function | 163–169 | no | 0 | `image-preparation.ts` |
| `sniffCursorImageFormat` | function | 172–197 | yes | 1 | `image-format.ts` |
| `extractCursorImageUrls` | function | 200–202 | yes | 1 | `images.ts` (residual) |
| `CursorImagePartRef` | interface | 204–207 | yes | 0 | `images.ts` (residual) |
| `extractCursorImageParts` | function | 210–224 | yes | 0 | `images.ts` (residual) |
| `resolveCursorImages` | function | 231–269 | yes | 1 | `images.ts` (residual) |
| `resolveCursorImageParts` | function | 271–280 | yes | 0 | `images.ts` (residual) |
| `cursorImageAttachmentPath` | function | 283–290 | yes | 0 | `images.ts` (residual) |
| `prepareCursorImageForWire` | function | 299–425 | yes | 1 | `image-preparation.ts` |
| `sniffCursorImageDimensions` | function | 431–501 | yes | 1 | `image-format.ts` |
| `buildSelectedImages` | function | 509–532 | yes | 1 | `images.ts` (residual) |
| `buildSelectedContext` | function | 538–545 | yes | 1 | `images.ts` (residual) |
| `resolveActiveCursorImages` | function | 551–562 | yes | 2 | `images.ts` (residual) |
| `imageDataUrlFromPrepared` | function | 564–566 | no | 0 | `images.ts` (residual) |
| `prepareCursorImageDataUrl` | function | 572–612 | yes | 0 | `images.ts` (residual) |
| `prepareCursorContentParts` | function | 614–641 | no | 0 | `images.ts` (residual) |
| `cursorVisionPrepareStartIndex` | function | 647–655 | yes | 1 | `images.ts` (residual) |
| `PreparedCursorRawMessages` | interface | 663–666 | yes | 0 | `images.ts` (residual) |
| `prepareCursorRawMessages` | function | 668–704 | yes | 2 | `images.ts` (residual) |

Resolved direct importers: 6 distinct files (4 production, 2 tests). Production paths:

- `src/adapters/cursor/live-transport.ts` — unchanged.
- `src/adapters/cursor/protobuf-request.ts` — unchanged.
- `src/adapters/cursor/request-builder.ts` — unchanged.
- `src/adapters/cursor/types.ts` — unchanged.

## Leaf partition

All paths below are new sibling files under `src/adapters/cursor/`, following the existing kebab-case native-exec-* and protobuf-* convention. Each symbol body and attached comment moves without rewriting. Physical slice accounting includes blank lines/comments; keep slice contents in their original relative order. Expected sizes use the exact compact import/re-export lines shown; multiline formatting consumes spare budget and must be recounted, especially catalog.ts.

### `src/adapters/cursor/image-format.ts`

- Transfer source slices: 171–198, 427–502 (104 physical lines).
- Symbols: `sniffCursorImageFormat`, `sniffCursorImageDimensions`.
- Expected line count: 104 moved + 0 import lines = **104**, ≤400.
- Own imports: none; standard Bun/JavaScript globals are not module imports.

### `src/adapters/cursor/image-preparation.ts`

- Transfer source slices: 17–60, 64–67, 71–92, 97–170, 292–426 (279 physical lines).
- Symbols: `MAX_CURSOR_IMAGE_BYTES`, `MAX_CURSOR_IMAGE_DECODE_BYTES`, `CURSOR_VISION_SOFT_MAX_BYTES`, `CURSOR_VISION_SOFT_MAX_BYTES_HIGH`, `CURSOR_VISION_MAX_EDGE`, `MAX_CURSOR_IMAGE_DECODE_EDGE`, `MAX_CURSOR_IMAGE_PIXELS`, `CURSOR_VISION_JPEG_QUALITIES_DEFAULT`, `CURSOR_VISION_JPEG_QUALITIES_HIGH`, `CURSOR_VISION_SOFT_MIN_EDGE`, `CURSOR_VISION_SOFT_SHRINK`, `CURSOR_VISION_PASSTHROUGH_MIME`, `CURSOR_VISION_IMAGE_OMITTED`, `CursorImageError`, `ResolvedCursorImage`, `PrepareCursorImageOutcome`, `estimatedBase64DecodedBytes`, `isHighDetail`, `softMaxBytesForDetail`, `jpegQualitiesForDetail`, `decodeCursorImageDataUrl`, `throwIfImagePhaseAborted`, `prepareCursorImageForWire`.
- Expected line count: 279 moved + 1 import lines = **280**, ≤400.
- Own imports:

```ts
import { sniffCursorImageFormat, sniffCursorImageDimensions } from "./image-format";
```

### Residual `src/adapters/cursor/images.ts`

Retain: `MAX_CURSOR_IMAGES`, `CURSOR_VISION_IMAGE_HISTORY_MARKER`, `isImagePart`, `extractCursorImageUrls`, `CursorImagePartRef`, `extractCursorImageParts`, `resolveCursorImages`, `resolveCursorImageParts`, `cursorImageAttachmentPath`, `buildSelectedImages`, `buildSelectedContext`, `resolveActiveCursorImages`, `imageDataUrlFromPrepared`, `prepareCursorImageDataUrl`, `prepareCursorContentParts`, `cursorVisionPrepareStartIndex`, `PreparedCursorRawMessages`, `prepareCursorRawMessages`.

Retain original imports 1–15: UUID creation, protobuf selected-context construction, Ocx message types, and native-exec blob ownership are still used in the residual. Add three local imports and three re-export lines.

Accounting: 704 − 383 moved  + 3 local import lines + 3 re-export lines = **327** expected lines. All leaves plus residual total 711 = 704 original + 7 net import/export glue lines. No >400 residual and no #a/#b/#c part in this approved map. A size-policy escalation is not a hidden #b commitment; if the parent adds parts, re-plan lower-consumer leaves first and publish each intermediate residual count.

Export existing throwIfImagePhaseAborted (163–169) only from image-preparation.ts for residual traversal callers. Do not add it to images.ts public exports. ResolvedCursorImage and PrepareCursorImageOutcome move with preparation, so it never imports its own types back from images.ts.

## Re-export block

Insert into the original file exactly these named lines; current exported declarations that stay local remain exported in place (`MAX_CURSOR_IMAGES`, `CURSOR_VISION_IMAGE_HISTORY_MARKER`, `extractCursorImageUrls`, `CursorImagePartRef`, `extractCursorImageParts`, `resolveCursorImages`, `resolveCursorImageParts`, `cursorImageAttachmentPath`, `buildSelectedImages`, `buildSelectedContext`, `resolveActiveCursorImages`, `prepareCursorImageDataUrl`, `cursorVisionPrepareStartIndex`, `PreparedCursorRawMessages`, `prepareCursorRawMessages`). Do not use export-star and do not re-export newly exposed internal-only seams.

```ts
export { sniffCursorImageFormat, sniffCursorImageDimensions } from "./image-format";
export { MAX_CURSOR_IMAGE_BYTES, MAX_CURSOR_IMAGE_DECODE_BYTES, CURSOR_VISION_SOFT_MAX_BYTES, CURSOR_VISION_SOFT_MAX_BYTES_HIGH, CURSOR_VISION_MAX_EDGE, MAX_CURSOR_IMAGE_DECODE_EDGE, MAX_CURSOR_IMAGE_PIXELS, CURSOR_VISION_IMAGE_OMITTED, CursorImageError, decodeCursorImageDataUrl, prepareCursorImageForWire } from "./image-preparation";
export type { ResolvedCursorImage, PrepareCursorImageOutcome } from "./image-preparation";
```

Re-export binds nothing locally. The original needs these explicit leaf imports in addition to its retained original imports:

```ts
import { sniffCursorImageDimensions } from "./image-format";
import { MAX_CURSOR_IMAGE_BYTES, CURSOR_VISION_IMAGE_OMITTED, CursorImageError, decodeCursorImageDataUrl, throwIfImagePhaseAborted, prepareCursorImageForWire } from "./image-preparation";
import type { ResolvedCursorImage } from "./image-preparation";
```

## Module-level state and cycles

`CURSOR_VISION_PASSTHROUGH_MIME` at 53–59 has exactly one owner: image-preparation.ts. Both JPEG quality arrays (47–48), soft resize thresholds (50–51), and caps (18–45) move with it. MAX_CURSOR_IMAGES (62) and history marker (69) remain original; omission marker (65–66) moves to preparation and is imported by the original. No module-level mutable Map, WeakMap, let, lock, timer, or cached Bun.Image. Native-exec.ts remains the sole blob-state authority; do not move or duplicate storeCursorBlob. Existing types.ts:5 imports ResolvedCursorImage from images.ts and remains unchanged. Preparation does not import ./types, native-exec, or images, avoiding preparation → images → preparation and types → images → types cycles. Format has zero imports. Boundary validation, abort timing, and error identity are preserved.

Read-only graph check of this planned layer's new imports found no return cycle involving `image-format.ts`, `image-preparation.ts`. The stack still inherits the **L1 type-only-cycle prerequisite** documented in 110_adapters_cursor_tool_definitions.md: `src/types.ts:112 → src/types/provider.ts:701 → native-exec-desktop.ts:19 → native-exec-tools.ts:25 → tool-definitions.ts → src/types.ts`. Do not claim whole-stack type acyclicity until the parent resolves that out-of-scope prerequisite; these later leaves do not repair it. The local partition/line accounting here remains conditional on a valid L1 parent.

The leaf direction listed in Loop spec is the allowed DAG. Sibling leaves import their canonical owner directly, never this original facade. Preserve initialization order for cross-constant references. Verify both runtime and type-only edges; a typecheck alone does not prove acyclicity. Compare the resolved import graph at the parent and tip; zero new cycles and no path from any new leaf back to the original are required. Existing external-format/provenance checks remain at the same trust boundary; do not reinterpret validation while relocating it.

## Tests

Exact direct-test list from `rg -l 'adapters/cursor/images' tests`, with specifier resolution to discard comments/other basenames:

- `tests/providers/cursor/cursor-images.test.ts` — **unchanged** import path and assertions.
- `tests/providers/cursor/cursor-vision-wire-harness.test.ts` — **unchanged** import path and assertions.

`rg -l 'readFileSync|Bun\\.file|source\\(' tests | xargs rg -n 'images'` produces a false-positive candidate `tests/providers/cursor/cursor-images.test.ts`: its actual file read is :47 (`Bun.file(pngPath).arrayBuffer()`), and :46 sets pngPath to `../../helpers/cursor-grumpy-fixture.png`. This reads a binary fixture, not images.ts. Disposition: unchanged, including fixture path. `tests/lib/credential-redirect-guard.test.ts:61` targets src/server/images.ts, a different file; unchanged. No test reads the target source file and no retarget-to-leaf/add-leaf-to-scan-list is warranted. This corrects 001's heuristic count of one without editing 001.

Transitive source-reader exception: `tests/lab/core-lab-boundary.test.ts:69` reads each resolved source file while walking static imports/re-exports. A read-only replay of that walk from `src/server/responses/core.ts` reaches this target (413 visited files at the basis). Disposition: **unchanged**; new leaves are automatically included through named imports/re-exports, so no manual add-leaf-to-scan-list and no retarget. Never edit its PROTECTED roots (lines 20–28). At implementation time drive this guard red once with a temporary forbidden leaf edge to `../../lab/paths`, then restore and prove green; no forbidden edge may enter a commit.

In C phase, drive `tests/providers/cursor/cursor-images.test.ts:68` red by temporarily disabling the inbound decoded-byte guard in image-preparation.ts; use :498 and :559 to drive dimension rejection red with a temporary sniff/limit mutation. Restore before green. Preserve original :47 fixture read, soft-cap/prep-before-cap :78, and historical/raw-message identity assertions. Do not weaken bomb, MIME, abort, or size assertions.

No test file is added by this plan, hence no test-layout manifest change. If extra regression coverage proves necessary, extend the existing focused files first and report scope expansion instead of silently creating new tests.

## Verification

Instantiate 002's Per-layer gate in this layer's dedicated worktree, not in the docs worktree. Nothing in this code fence was run by the drafting delegate.

```sh
bun run typecheck
# Focused domain: providers/cursor (includes the direct Cursor tests listed above)
bun test tests/providers/cursor
bun test tests/adapters/adapter-tool-conformance.test.ts
# Transitive source-graph guard; justified even though only adapters files move
bun test tests/lab/core-lab-boundary.test.ts
bun run privacy:scan
wc -l src/adapters/cursor/image-format.ts src/adapters/cursor/image-preparation.ts src/adapters/cursor/images.ts
rg -n 'from "[^"]*/images"' src gui/src scripts tests | wc -l
rg -l 'adapters/cursor/images' tests
# Full suite: remote only; preserve pipeline failure rather than trusting tail's exit status
ssh lidge 'set -o pipefail; cd ~/ocx-ci/opencodex && git fetch origin codex/split-adapters-cursor-images && git checkout -q FETCH_HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15'
```

Focused named subset (for initial tight red/green and for an exact task manifest):

```sh
bun test tests/adapters/adapter-tool-conformance.test.ts tests/providers/cursor/cursor-images.test.ts tests/providers/cursor/cursor-request-builder.test.ts tests/providers/cursor/cursor-vision-wire-harness.test.ts
```

Use the named subset for the temporary mutation checks, then the domain gate after restoration; do not rerun an unchanged passing check solely for confidence. Full suite is **never local**. Remote parent workflow must bind FETCH_HEAD/full-suite output to this exact PR head SHA, preserve a complete remote log as well as its summary, and ensure the remote checkout is exclusively owned before checkout; do not operate on unrelated dirty remote work.

Importer proof: compare the 6-file resolved importer set above at parent and tip. Existing external consumer paths stay unchanged. New leaf imports are planned internal edges, not lost callers; count them separately. The simple 002 line-count command is supporting evidence only: multiline and dynamic imports require the resolved-file check. Export-name/type identity must be checked independently. Run a resolved runtime+type import-cycle scan with available repository tooling or a read-only resolver; do not install a dependency just for this split. Review `git diff --numstat codex/split-cursor-desktop-executor-contract...HEAD` with move-aware comparison and separately record raw additions + deletions; apply the sizing escalation above, not an unrecorded exception. Require green exact-head CI rollup, not merely an empty required-check list.

## Accept criteria

1. Source basis and parent branch are recorded; every owned top-level declaration in this table has exactly one post-move owner, with identical body/signature and attached explanatory comments.
2. All current 30 exports remain importable from `src/adapters/cursor/images.ts`, with the same value/reference/type identity; no new internal-only export leaks through that original path. Residual local calls are bound by explicit imports.
3. Every planned leaf is ≤400 lines and residual is ≤400 (expected 327); actual `wc -l` agrees or the exact formatting delta is recorded. No omitted #b debt.
4. Same CursorImageError constructor identity, MIME allowlist, byte/pixel caps, output JPEG quality ladder, abort propagation, prepared-image object identity, history-window selection, and request-scoped blob writes.
5. All 6 existing resolved importers remain; direct test imports/assertions and transitive source-reader semantics are preserved. Planned red mutations fail the named guards once, are removed, and the restored focused/domain checks pass with 0 failures.
6. Single-owner state allocations, allowed DAG edges, and no new runtime/type cycles are mechanically verified. Lab PROTECTED roots and optional-subsystem activation remain untouched.
7. Typecheck and privacy scan exit 0; remote-only full suite exits 0 at the exact layer SHA; exact-head CI rollup is green. No local full suite, no merge, and no unrelated changes.
8. Parent-to-tip size obeys the agreed 500-line metric or the parent explicitly resolves the documented exception/topology escalation before implementation; this draft itself is not evidence of an approved exception.

## PR

Title: `refactor(adapters-cursor): separate image byte inspection and preparation (split S04 L3/5)`

Branch: `codex/split-adapters-cursor-images`. Base: `codex/split-cursor-desktop-executor-contract`. Closes: **none**.

Use every section of `.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification, Checklist); paste the stack map below into Summary. Review only this layer's parent-to-tip diff. Replace PR placeholders with actual numbers when opened; no PR is created by this draft.

| # | PR | Branch | Base | Review focus |
|---|---|---|---|---|
| 0 (105) | #TBD-S04-L0 | `codex/split-cursor-desktop-executor-contract` | `dev` | desktop-executor-contract |
| 1 | #TBD-S04-L1 | `codex/split-adapters-cursor-tool-definitions` | `codex/split-cursor-desktop-executor-contract` | tool-definitions |
| 2 | #TBD-S04-L2 | `codex/split-adapters-cursor-catalog` | `codex/split-cursor-desktop-executor-contract` | catalog |
| 3 | #TBD-S04-L3 | `codex/split-adapters-cursor-images` | `codex/split-cursor-desktop-executor-contract` | images |
| 4 | #TBD-S04-L4 | `codex/split-adapters-cursor-request-builder` | `codex/split-adapters-cursor-images` | request-builder |
| 5 | #TBD-S04-L5 | `codex/split-adapters-cursor-protobuf-events` | `codex/split-adapters-cursor-tool-definitions` | protobuf-events |

Current layer: **L3**. Parent: `codex/split-cursor-desktop-executor-contract` (#TBD-S04-L0).
Changes to parent `codex/split-cursor-desktop-executor-contract` require rebasing this layer and cascading only
through its actual dependency descendants, with exact-tip/base rechecks
(DEV-STACK-02); sibling layer numbering creates no dependency. Merge remains
parent-before-child and separately authorized, never part of this draft.
