# 010 — Config rebase deletion provenance

## Current facts

- `configSchema` accepts unknown top-level fields through `.passthrough()`
  (`src/config.ts:837-934`), and successful loads return that parsed object
  (`src/config.ts:1795-1812`). An additive metadata field therefore remains readable
  by an older binary and survives its ordinary whole-config save.
- The long-lived rebase state contains cloned config values only
  (`src/config.ts:2601-2627`). It cannot record an absent key's cause.
- Guarded save consequently derives authority from key presence: disk-only keys are
  excluded from reconciliation (`src/config.ts:2912-2935`). This preserves an
  explicit deletion but also discards an unseen concurrent addition.
- The two pinned outcomes are distinct. A disk-only `claudeCode` edit must survive an
  unrelated save (`tests/config-user-edits.test.ts:221-231`), while an explicit live
  deletion of a disk-only `grokExcludedModels` key must win
  (`tests/config-user-edits.test.ts:652-675`). Presence alone cannot satisfy both.

## Persisted contract

Add optional top-level metadata:

```json
{
  "configRebaseProvenance": {
    "version": 1,
    "deletedTopLevelKeys": ["grokExcludedModels"]
  }
}
```

`deletedTopLevelKeys` is a sorted, duplicate-free tombstone set. A top-level deletion
writer records the key through one config-owned helper. Before persistence, every key
that is present in the candidate removes its tombstone; an empty set removes the
metadata. Thus a later explicit assignment supersedes an earlier deletion.

Only a schema-valid version-1 record grants deletion authority. Missing metadata keeps
the current presence-based behavior until a writer explicitly records a deletion.
Unknown/future records pass through opaquely and grant no authority. Loading or arming
a baseline never creates provenance because neither operation knows why a key is absent.

The metadata key itself is excluded from ordinary three-way reconciliation. The guarded
save combines the candidate's explicit tombstones with the newest disk metadata, then
uses only candidate tombstones to decide whether a disk-only field is reconciled or
deleted. This lets an unseen concurrent key survive while preserving an explicit live
deletion.

## Top-level deletion-writer inventory

The current source contains these top-level config deletions; nested provider,
`claudeCode`, sidecar, combo-row, and routing-profile-row deletions are not top-level
provenance events.

- `src/server/management/agent-settings-routes.ts:98` — `clientIntegrations`
- `src/server/management/agent-settings-routes.ts:344` — `multiAgentMode`
- `src/server/management/agent-settings-routes.ts:351` — `keepNativeChatGptOnV1`
- `src/server/management/agent-settings-routes.ts:562-568` — four injection fields
- `src/server/management/agent-settings-routes.ts:599` — generic delegation fields
- `src/server/management/agent-settings-routes.ts:718-720` — two fallback fields
- `src/server/management/agent-settings-routes.ts:761` — `grokExcludedModels`
- `src/server/management/config-routes.ts:440,461-475` — seven general settings
- `src/server/management/combo-routes.ts:249` — `combos`
- `src/server/management/routing-profile-routes.ts:332` — `routingProfiles`
- `src/providers/context-cap.ts:53,74,81` — `providerContextCaps`
- `src/codex/account-priority.ts:37,81` — priorities and active pin
- `src/codex/account-pause.ts:15` — paused account IDs
- `src/codex/desired-state.ts:117` — `clientIntegrations`
- `src/providers/provider-id-rewrite.ts:177` — `customModels`
- `src/cli/v2.ts:196,220` — two CLI general settings
- `src/cli/provider.ts:313` — a nested provider row, excluded from top-level provenance

The implementation replaces every included statement with the config-owned helper.
Normalization-only deletes in `src/config.ts` are excluded: they sanitize parsed data
and are not user-intent writers. Reconciliation deletes are also excluded because they
apply another writer's state rather than originate intent.

## Verification and falsification

- Focused tests cover explicit deletion versus unseen addition, missing/version-1/future
  migration behavior, old-reader passthrough, and every writer's use of the helper.
- For each new behavior test, revert the production hunk it exercises, confirm failure,
  then restore it before final verification.
- Final gates: `bun x tsc --noEmit`, all `tests/config*.test.ts`, and every additional
  test file found by imports of `src/config.ts` or the changed deletion-writer modules.
