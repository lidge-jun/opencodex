# 102 — #1798: restore must survive an app rewrite

One PABCD cycle. Runs AFTER `101` — also touches `src/codex/inject.ts`.

## Verified state

1. Injection stores original bytes plus an injected hash.
2. The Codex App rewrites `config.toml`.
3. Restore sees the hash mismatch and refuses journal restoration (`src/codex/journal.ts:123`).
4. Fallback removal only recognizes an `openai_base_url` immediately preceded by the OpenCodex marker (`src/codex/injected-marker.ts:53`), because `removeCodexConfig` bases ownership on that predicate (`src/codex/inject.ts:1193`).
5. The app-rewritten, unmarked line therefore survives.

Partially satisfied already: catalog backup lookup falls back from the hash-named backup to the legacy backup for the default path (`src/codex/catalog/parsing.ts:545`).

## Required shape

Replace exact-byte restore-or-strip with a three-way semantic merge over baseline B (what we saved at injection), injected I (what we wrote), and current C (what is on disk now):

- A key whose current value equals I is ours — remove it, or restore B's value if B had one.
- A key whose current value differs from BOTH B and I was changed by the user or the app — preserve it.
- A key present in B, absent from I, and absent from C was removed by someone else — do not resurrect it.

**Do not ship a marker-only deletion patch.** An unmarked `openai_base_url` may be genuinely user-owned; deleting it because it looks like ours is data loss, and it is the failure mode this issue is one half of.

When the merge cannot classify a key confidently, leave it and report it. A restore that says "I left these three lines, check them" is far better than one that silently deletes a user's setting.

## Tests

- App rewrites the injected line unmarked: restore removes it and preserves an unrelated user key added in the same rewrite.
- User sets their own `openai_base_url` before injection: restore returns THAT value, not absence.
- User edits an unrelated key after injection: it survives restore byte-identical.
- Hash mismatch no longer means give-up: the merge path runs and the home ends clean.
- The catalog fallback at `parsing.ts:545` keeps working; add a regression if none pins it.

---

## Audit correction and outcome (at `ba456bdcf`)

An independent read-only audit checked this document against the tree before implementation.
Three of its claims were wrong in ways that would have produced vacuous work.

- **A true baseline/injected/current three-way merge is not implementable from today's journal.**
  `Journal` (`src/codex/journal.ts:19`) stores the full baseline but only `sha256` of the injected
  state, so `I` does not exist as bytes. A real B/I/C merge requires a journal version that
  persists the injected config, and that is a larger change than the defect needs.
- **"A user's own pre-injection `openai_base_url` is returned by restore" is vacuous.** Under
  Design B, injection refuses to overwrite an unmarked user URL at all (`src/codex/inject.ts:258`),
  so there is nothing to return. The real risk is the inverse — restore DELETING a URL we never
  wrote — and that is what the shipped test pins.
- **`saveConfigPreservingClaudeCode()` and `mutatePersistedConfig()` are not reusable here.** They
  mutate OpenCodex's own JSON config, not `$CODEX_HOME/config.toml`. Treating them as restore
  machinery would be a domain error.

The audit also corrected the catalog claim: the generic legacy backup is applied only when the
resolved path is the DEFAULT catalog (`opencodex-catalog.json`, `src/codex/catalog/parsing.ts:544`).
`models_cache.json` is not that path, and `tests/codex-catalog-restore.test.ts` already pins that a
custom path does not get the generic backup. So the "legacy fallback partially satisfies #1798"
line was false for the reported case.

### What shipped

A narrower fix keyed on evidence rather than formatting: `markJournalInjectedState` records the
exact root `openai_base_url` the injection wrote, and the fallback strip removes a root URL whose
value equals it. That survives the app's comment-dropping rewrite, which is the actual mechanism
in the report, while an exact-value match keeps restore from touching a user's own gateway.

- `src/codex/journal.ts` — record and expose the injected URL.
- `src/codex/injected-marker.ts` — `stripJournaledOpenaiBaseUrl()`, value evidence beside the
  existing marker-adjacency rule.
- `src/codex/inject.ts` — `removeCodexConfig()` reads the journal once and uses it for both the
  ownership verdict and the strip.
- `tests/codex-restore-app-rewrite.test.ts` — reproduces the app rewrite literally; driven red by
  pinning the accessor to null.

Journals written before this change carry no recorded URL and fall back to today's marker rule, so
the change is backward compatible.

### Still open

The `models_cache.json` half. Catalog restore re-resolves its target from the post-rewrite TOML
(`src/codex/catalog/parsing.ts:185`), so a rewrite that dropped `model_catalog_json` sends restore
to the default catalog and never touches the proxy-written cache. The fix is to capture the
INJECTED catalog path in the journal and pass it into `restoreCodexCatalogWithPermit()`
(`src/codex/catalog/sync.ts:1686`) as an explicit target. #1798 stays OPEN for that.

