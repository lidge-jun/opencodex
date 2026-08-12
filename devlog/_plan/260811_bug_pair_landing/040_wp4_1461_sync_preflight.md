# 040 — wp4: #1453 / #1461, sync/restore preflight

## The defect (#1453)

`ocx sync` and `ocx restore back` fail with a message that names no reason:

```text
Codex sync did not complete. Fix the reported Codex config issue and retry.
Plain `codex` was not switched back to opencodex. Fix the reported Codex config issue and retry.
```

No config issue is ever printed, and `ocx doctor` reports every check `ok`, so
the instruction cannot be followed. Worse, because `refreshCodexModelCatalog`
runs before `injectCodexConfig`, a sync can fail after the catalog was already
truncated — leaving the catalog short and routing un-injected.

## What the contributor did (`9e5cc13f5`)

`src/codex/inject.ts` gains a `validateOnly` mode that suppresses
external-provider journal deletion and returns before artifact writes
(876-890). `src/codex/sync.ts` runs that preflight before the catalog refresh
and sends injection failures to stderr (120-140, 195-196). Tests assert the
concrete stderr text, an unchanged catalog and cache, an artifact-free
successful preflight, and two injection calls on the fallback path.

The shape is right: check first, then write, and say why when refusing.

## No blocker in the diff

Audited and clean. The red CI is not this PR's fault — see 002 for the full
classification. In short: a Bun 1.3.14 segfault (exit 132, no assertion), the
#1302 shard hang on `tests/cli-models.test.ts`, and a 10s timeout on a Cursor
blob test this PR never touches. All three run green locally on the PR head, on
clean `dev`, and on the PR merged onto current `dev` (73 pass / 0 fail across
the three CI-associated files).

## Verification

- `bun test tests/cli-restore-back.test.ts tests/codex-sync-api.test.ts`
  (baseline on the contributor head: 16 pass / 0 fail)
- re-run the three CI-associated files on the merged tree
- `bun run typecheck`, `bun run privacy:scan`

## Landing

Cherry-pick `9e5cc13f5` preserving `Ingwannu` as author. No correction commit
expected. If the merged tree changes the picture, this doc gets amended at wp4's
P rather than papered over.
