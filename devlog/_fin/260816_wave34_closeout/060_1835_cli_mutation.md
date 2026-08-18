# 060 — #1835/#1838: route `config set/unset` through the existing primitive

Both issues are CLOSED as duplicates of each other, but the defect is live and the fix is small. Reopen `#1838` (the surviving number) or land the fix referencing both.

## Verified defect

`config set/unset` reads the disk snapshot OUTSIDE the mutation lock (`src/cli/config-command.ts:133`), then sends that whole older snapshot through `saveConfig` (`:145`). A concurrent edit landing in between is silently reverted. `config import` likewise replaces via raw `saveConfig` (`:178`).

## Fix — no new primitive needed

The roadmap asks for a new "config mutation intent primitive". It already exists:

```ts
mutatePersistedConfig<T>(mutate: (config: OcxConfig) => PersistedConfigMutation<T>): PersistedConfigMutationOutcome<T>
```

(`src/config.ts:2884` — clones the latest validated disk config, reruns the callback, compares exact raw strings, rebases up to three times.)

The real contract is narrower than a naive patch callback. `PersistedConfigMutation<T>` is `{ changed: boolean; value: T }`, and the outcome is `{ status: "committed" | "unchanged"; value: T } | { status: "unavailable"; reason: "missing" | "invalid" | "conflict" }` (`src/config.ts:2855-2866`). There is no `applyPath`; the existing local helper is `setPath(root, path, value, remove)` at `src/cli/config-command.ts:48`.

So `set`/`unset` become:

```ts
const outcome = mutatePersistedConfig(config => {
  // Snapshot BEFORE mutating, so `changed` is an honest comparison.
  const before = JSON.stringify(config);

  const candidate = structuredClone(config) as Record<string, unknown>;
  setPath(candidate, path, parsed, action === "unset");

  // Same validation the command already performs, but on the FRESH candidate.
  const validated = validateConfigCandidate(candidate);
  if (!validated.ok) throw new Error(validated.error);

  // The pin clear belongs to this transaction, not a follow-up write.
  if (pathSegments(path)[0] === "codexAccountPriorities") clearCodexAccountPin(validated.config);

  // REPLACE, do not merge: Object.assign cannot remove a key that `unset` deleted,
  // so an unset would appear to succeed while changing nothing.
  for (const key of Object.keys(config)) {
    if (!(key in validated.config)) delete (config as Record<string, unknown>)[key];
  }
  Object.assign(config, validated.config);

  return { changed: JSON.stringify(config) !== before, value: undefined };
});
if (outcome.status === "unavailable") { /* report missing | invalid | conflict, exit non-zero */ }
```

Three things the callback must get right, all of which the current code does outside the lock:

- `changed` must compare a snapshot taken BEFORE the mutation against the object after it. Comparing after `Object.assign` compares a value with itself and always reports `true`, which bumps the config generation on a no-op write.
- The callback mutates `config` in place because that is the object the primitive commits, but it must REPLACE its contents: delete every key the validated candidate dropped before assigning. A plain `Object.assign` merge cannot remove a key, so `unset` would silently become a no-op.
- Validation runs on the candidate built from the FRESH config, not the one read before the lock.
- `clearCodexAccountPin` (`src/cli/config-command.ts:144`) must stay inside the transaction; leaving it outside reintroduces the same race for the pin.

The read now happens inside the transaction, so the mutation is applied to whatever is actually on disk at commit time.

**`import` deliberately does NOT change.** Import is an intentional whole-document replacement; forcing it through patch semantics would silently merge instead of replace, which is a different and worse surprise. What it needs instead is honesty: compute the set of top-level keys present on disk but absent from the imported document and warn about each before writing, so a replacement that drops the user's providers is announced rather than discovered later.

## Tests

In the CLI config tests: a `set` whose callback observes an externally-changed disk state applies onto the NEW state, not the stale one; `unset` likewise; `import` still replaces wholesale but emits a warning naming each dropped top-level key; and a byte-identical `set` does not bump the config generation.

`tests/cli-headless-parity.test.ts:378` and the pin behavior at `:429` currently exercise this command path. Both must keep passing unchanged — if the `clearCodexAccountPin` ordering or the validation error text moves, they regress, and that is the signal that the migration was done wrong.
