# 010 — wp1: #1459 / #1460, byte-identical catalog resync

## The defect (#1459)

`writeRetainedCatalogSync` writes the Codex catalog unconditionally, so every
sync moves the file's mtime even when the produced bytes are identical.
`collectCodexAppServerCatalogState()` compares that mtime against each running
Codex's start time, so an ordinary `ocx start` classifies every already-running
Codex as holding an outdated in-memory catalog. Since #1407 that verdict
withholds all opencodex-authored v2 model guidance, so a configured
`injectionModel` / `subagentModels` roster silently stops reaching the session
for the rest of that Codex's lifetime.

## What the contributor did (`7bf8b84a1`)

Adds `currentCatalogFileContent()` and returns early with
`catalogWritten: false` when the on-disk content matches the prepared content,
before `replaceActiveCodexCatalog`. Also updates three convergence assertions
in `tests/codex-convergence-account-selectors.test.ts` from expecting a
redundant write to expecting `catalogWritten: false` while still asserting the
sync was not policy-skipped, and documents the behavior in
`docs-site/src/content/docs/guides/sub-agent-surface.md`.

The direction is right and minimal: it does not weaken the permit,
revalidation, or atomic-write path.

## Blocker: the comparison is not a byte comparison

`src/codex/catalog/sync.ts:1176-1183` on the PR head:

```ts
/** Exact bytes currently on disk at `path`, or null when unreadable/absent. */
function currentCatalogFileContent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
```

and at line 1363:

```ts
if (currentCatalogFileContent(catalogPath) === content) {
```

The doc comment claims exact bytes; the code compares decoded JavaScript
strings. `readFileSync(path, "utf8")` replaces invalid UTF-8 with `U+FFFD`, so
different on-disk bytes compare equal to a legitimately encoded replacement
character. Reproduced independently:

```json
{"decodedEqual":true,"bytesEqual":false,"malformedHex":"80","replacementHex":"efbfbd"}
```

Consequence: a catalog holding a malformed byte where the prepared content
holds a real `U+FFFD` is judged identical, the atomic repair write is skipped,
and `catalogWritten: false` is returned even though the prepared bytes differ
from the file. The no-op guard would preserve corruption. Given #904 and #417
are both open U+FFFD investigations, silently preserving malformed bytes in the
catalog is not a hypothetical annoyance.

## The fix

```ts
function currentCatalogFileContent(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}
```

and at the comparison:

```ts
const currentContent = currentCatalogFileContent(catalogPath);
if (currentContent !== null && currentContent.equals(Buffer.from(content, "utf8"))) {
  return { added, path: catalogPath, catalogWritten: false, comboOmissions };
}
```

The unreadable/absent fallback to a real write is preserved: `null` fails the
guard and falls through to `replaceActiveCodexCatalog`.

## Regression

In `tests/codex-catalog-sync-hardening.test.ts`, adjacent to the new no-op mtime
test: write a catalog containing a raw `0x80` byte where the prepared content
contains a real `U+FFFD`, then assert

1. `catalogWritten === true` — the malformed file is still rewritten;
2. the raw `0x80` is gone and the bytes contain UTF-8 `EF BF BD`;
3. a subsequent genuinely byte-identical sync returns `catalogWritten === false`.

Ablation: this test must be shown red against the string-compare version and
green against the byte-compare version. Assertion 3 keeps it honest — without
it, the test would also pass if we simply deleted the no-op guard.

## Verification

- `bun test tests/codex-catalog-sync-hardening.test.ts tests/codex-convergence-account-selectors.test.ts`
- `bun run typecheck`
- `bun run privacy:scan`

Baseline on the unmodified contributor head: 42 pass / 0 fail.

## Landing

Cherry-pick `7bf8b84a1` onto `dev`, preserving `tlsdnwn55` as author, then a
second commit for the byte-compare correction and its regression.
