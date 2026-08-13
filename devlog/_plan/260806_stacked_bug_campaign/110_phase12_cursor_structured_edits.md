# 110 — Phase 12: Cursor structured-edit conversion (#1017, PR #1036)

Credit: **NexusCore** (`@ZachDreamZ`), PR #1036. Reporter: **Vincent-HD**
(#1017). Adoption: **adapted** — provenance derivation corrected.

## Defect

Codex advertises `apply_patch` as a single-string function
(`src/responses/parser.ts:166`). The Cursor adapter emits calls with normalized
arguments but never converts structured edits into a valid `apply_patch`
envelope (`src/adapters/cursor/protobuf-events.ts:388`), so Cursor consistently
produces invalid payloads.

## Why adapted

#1036's translator and tests are good. The remaining defect is provenance:
`src/adapters/cursor/live-transport.ts:543-560` computes visibility from
`cursorVisibleTools` but then derives structured-edit availability and tool
names from the *earlier* `request.tools`. After filtering or budgeting removes a
tool, the two disagree — and a synthetic edit identified by wire name alone can
collide with a real client tool.

## Change

File list read from `gh pr diff 1036` against `dev` = `e9d957bf6`.

| Path | Op | Content |
|------|----|---------|
| `src/adapters/cursor/tool-definitions.ts` | ADOPT (+111) | Cursor-compatible `edit_file`/`multi_edit` definitions, injected only when Codex exposed `apply_patch`, tagged with internal provenance |
| `src/adapters/cursor/protobuf-events.ts` | ADOPT (+180) | Convert exact-match replacements into a valid Codex freeform patch envelope, emit as `apply_patch` preserving the original call id, and reject malformed/ambiguous replacements with an explicit bridge error rather than forwarding invalid patch text |
| `src/adapters/cursor/request-builder.ts` | ADOPT (+15/−~4) | Produce the final filtered/budgeted catalog that provenance derives from |
| `src/adapters/cursor/live-transport.ts` | ADAPT (+15) | **Change from #1036:** derive the structured-edit set from the final filtered catalog produced by `request-builder.ts`, not from the earlier `request.tools` — after filtering or budgeting drops a tool the two disagree |
| `src/adapters/cursor/native-exec.ts`, `src/adapters/cursor/native-exec-fs.ts` | ADOPT (+6/−~2, +15/−~7) | Supporting wiring as authored |
| `tests/cursor-structured-edit.test.ts` | ADAPT (NEW, +449) | Authored conversion and collision cases, plus a post-filter provenance case proving the set is derived after filtering |

Injection happens **only** when Codex exposed `apply_patch` — the adapter must
not invent an editing capability the client never offered.

## Verification

- `bun test tests/cursor-structured-edit.test.ts` and the Cursor adapter suites
- `bun run typecheck`
- `bun run privacy:scan`

## PR

Stack 11, base = stack 10 head. `Closes #1017`. Credits NexusCore and Vincent-HD.
