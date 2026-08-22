# 040 — Phase 5: bounded oversized rollout inspection (PR #1115)

Credit: **Simon** (`Simon <email from PR head>`), PR #1115.
Adoption: near-verbatim cherry-pick of 5 commits.

## Defect

`src/codex/native-residue.ts` reads a rollout file without bounding it to the
observed size, decodes the whole buffer at once, and can mis-handle a pathname
that changed between stat and read. An oversized rollout therefore drives an
unbounded read during residue inspection.

## Change

Source commits, oldest first — `f86e7a783`, `37fada88d`, `d348308c3`,
`926621db5`, `b5452a0a5`:

| Path | Op | Content |
|------|----|---------|
| `src/codex/native-residue.ts` | MODIFY | +167/−27: bound reads to the observed size, decode UTF-8 incrementally, parse JSONL from bounded chunks, re-stat the pathname, scan lines once, preserve BOM |
| `tests/codex-native-residue.test.ts` | MODIFY | +69: oversized, malformed, truncated, and BOM cases |

**Residue classification is not weakened** — the bound applies to how much is
read, not to what counts as residue. That distinction is the review-critical
part: a bounded reader that silently reclassified a truncated rollout as
"clean" would hide real residue.

## Execution

```
git cherry-pick f86e7a783 37fada88d d348308c3 926621db5 b5452a0a5
```

All five carry Simon's authorship; the chain is kept intact rather than
squashed so the review history stays legible.

## Verification

- `bun test tests/codex-native-residue.test.ts`
- `bun run typecheck`
- `bun run privacy:scan`

## PR

Stack 04, base = stack 03 head. Credits Simon; notes that the unrelated
native-history bound was already split out by the contributor.
