# wp1 — initial model-selection policy

Depends on: wp0 roadmap lock. No dependence on the new popup implementation.

## Contract and exact file map

### NEW src/providers/initial-model-selection.ts

Own a threshold constant (20), typed registration-state helpers, preservation and
the pure authoritative-discovery transition. No filesystem/network/timers here.

Persisted provider field:

```ts
initialModelSelection?: {
  version: 1;
  registrationId: string; // new UUID on first creation only; preserved on overwrite
  status: "pending" | "ready" | "all-off";
  modelCount?: number;
};
```

- `initializeProviderModelSelection(next, existing)`: if existing, preserve its
  initialization field plus selectedModels/modelPreset/newModelPolicy when omitted
  by replacement; do not interpret missing old state as pending. On new OAuth or
  ChatGPT-forward connections, leave initialization absent; on new key/local
  connections, set version 1 pending. Use the effective canonical auth mode after
  existing enrichment/validation; mixed-auth explicit key is eligible. Never set
  `provider.disabled`. Remove untrusted submitted internal state on new rows.
- `initialModelSelectionPending(provider)`: true only for valid v1 pending.
- `reconcileInitialModelSelections(config, models, authoritativeProviders)`:
  process only pending entries; leave non-authoritative results pending. Deduplicate
  usable canonical model switch selectors per provider, including intentional
  static catalogs and separately listed catalog IDs. Display-only alias labels do
  not add a switch. Use the Models inventory's row identity;
  custom metadata overrides do not remove a discovered row from the count.
  At >=20 append canonical `routedSlug` selectors to config.disabledModels without
  duplicates, status all-off/count. At <20 status ready/count. Exempt effective
  OAuth/forward pending connections become ready without OFF. Do not modify
  unrelated disabled entries or later-arrival policy. Return changed boolean.
- `adoptInitialModelSelections(live, projected)`: adopt only changed initialization
  metadata for still-existing providers after successful convergence commit.

### MODIFY src/types/provider.ts

Declare the optional field beside selectedModels. Document marker absence means
legacy/exempt, not "initialize on next boot". Declare/export the state type here
if reused by the policy; avoid duplicate definitions.

### MODIFY src/config.ts

Add optional v1 status/count schema next to provider selected-model-related fields.
Malformed metadata must degrade only the metadata, not discard providers/secrets.
No migration or automatic seeding in loadConfig/getDefaultConfig: existing users
must remain unchanged. Ordinary save/load serializes the additive field.

### MODIFY src/server/auth-cors.ts

Classify `initialModelSelection` as `runtime` in the exhaustive provider-field
policy. Expose only the validated non-secret state through safeConfigDTO, not the
provider editor DTO. PUT/PATCH editor admission must not gain ownership of it.
Keep every existing credential redaction and permission check unchanged.

### MODIFY registration writers

| Path | Exact insertion |
| --- | --- |
| src/server/management/provider-routes.ts POST /api/providers | Immediately before assigning stripped `prov`, initialize/preserve against the freshly re-read current row after DNS await; existing selection fields survive replacement. Add sanitized state to success response if useful. |
| src/cli/provider.ts handleAdd | Before config.providers[name]=provConfig, call initializer against existingProvider. Preserve current costs behavior. JSON gains non-secret state; no discovery claim from the static registry list. |
| src/cli/init.ts | Initialize the chosen new provider before save; init remains a deliberate fresh-config operation. |
| src/oauth/login-cli.ts commitKeyLoginProvider | After existing key-row merge, initialize/preserve before save and live reload. |
| src/oauth/index.ts upsertOAuthProvider | After existing auth/key preservation, preserve model-selection fields/state; new genuine OAuth is exempt. Do not change credential selection. |

Existing config reload/import paths are not new provider registrations and do not
invent markers. Key-pool additions and account reauth must not reseed state.

### MODIFY src/codex/catalog/provider-fetch.ts

The shared `filterCatalogVisibleModels` excludes rows whose configured provider is
pending. Do not remove those rows from the gather result used to count models or
from the management inventory; this is a visibility filter, not a discovery filter.
All current consumers inherit pending hiding (Codex, /v1/models, export consumers).
No change to explicit model-ID routing.

### NEW src/providers/initial-model-selection-runtime.ts

Own the ordinary-discovery completion write, independent of Codex integration.
Match registration UUID as well as normalized inventory-producing configuration
(including custom rows, combos and provider dependencies). Equal field values
after delete/re-add are not the same registration. Schema-default normalization
and order-independent comparison avoid spurious mismatches after load/save.
Capture pending provider config and disabledModels before gather; use existing
authoritative outcome metadata and the pure transition after discovery. Re-read
under mutatePersistedConfig, compare the captured provider/selection identity,
and apply only still-pending matching entries. Existing completed state is adopted
rather than reset. Concurrent provider replacement or user selection changes
invalidate the decision; leave pending and retry on a later refresh. Persist state
and disabled selectors in one coordinated config write. No new timer. A write
failure must not publish a successful completed state; keep exposure pending.

### MODIFY src/server/management/shared.ts and src/codex/catalog/sync.ts

`fetchAllModels` collects authoritative outcomes during its existing gather and
finalizes pending initialization before returning rows. This covers management,
/v1/models and other clients even with Codex integration OFF. Legacy calls with
no pending provider keep the existing fast path, with no writes/new discovery.
`syncCatalogModels` finalizes pending initialization BEFORE capturing its retained
catalog evidence; never insert config writes inside an already sealed gather.
The evidence-only gather entry point remains mutation-free.

### MODIFY src/codex/management-convergence.ts and src/codex/convergence.ts

Implementation refinement: the management wrapper resolves pending initialization
BEFORE capturing catalog admission, just as retained sync does before its evidence
read. This avoids coupling durable initial selection to a later catalog-file write
or exposing an in-memory completed marker after a failed config save. The evidence
gather stays read-only; convergence only carries pending-provider names into final
visibility filtering. Existing later-arrival projection is untouched. Registration
choices commit independently of optional Codex catalog success. Snapshot identity
already hashes complete config, so no second fingerprint implementation is needed.

### MODIFY src/server/management/model-rows.ts and model-routes.ts

Management rows remain visible to edit but pending rows report disabled/pending
truthfully. Model visibility writes for a pending new provider return a typed
pending response rather than publishing provisional models; use existing refresh
flow for retry. Do not toggle provider.disabled. Completed all-off models are
enabled through the existing single/group switch operations, without reinitializing.

### MODIFY remaining exposure consumers and retained-row merge

- src/server/management/agent-settings-routes.ts: injection, subagent-available,
  fallback and Claude model candidates that currently filter only disabledModels
  also exclude pending provider rows. Preserve intentional saved-choice retention
  (a stored choice remains representable, not a new selectable/public model).
- src/codex/catalog/sync.ts: add pending provider exclusions to the shared final
  merge after retained/degraded rows are recovered. Pass pending provider names
  from both retained sync and convergence into merge inputs. Never infer provider
  identity from a loose prefix; use existing catalog-entry provider provenance.
  A deleted/re-registered provider cannot recover ON rows from its old disk cache.

## Field chain

Creation: new provider writers above → JSON save: config persistence → load:
provider schema → consumers: pending filter, convergence, management DTO/rows,
CLI metadata and wp2 GUI. Overwrites: shared preservation helper. Deletion removes
the provider field with its provider; re-adding a genuinely deleted row is new.
Unsupported/malformed versions do not turn legacy data into a pending registration.

## Regression map and activation evidence

NEW tests/providers/initial-model-selection.test.ts (register basename in both
scripts/test-layout/layout.json and tests/fixtures/test-layout-expected.json):

- 19/20 and duplicate IDs; static 20; degraded live 20 stays pending; zero-model
  authoritative result completes ready; unrelated provider flags preserved.
- 19 rows plus one separate catalog ID = 20 switches; a display alias or metadata override of an
  existing row does not lower its count; exact duplicate selectors count once.
- new key/local pending versus OAuth/forward exempt; mixed-auth key eligible.
- initial all-OFF uses canonical selectors and keeps provider active.
- second reconciliation does nothing; manual enable stays enabled on rediscovery.
- existing unmarked provider, marked provider, force overwrite and login retain
  selection/preset/new-model policy; no field resets from update.
- pending visibility absent from public catalog but management rows remain usable
  and marked pending; no direct-ID routing changes.
- Codex integration OFF still resolves pending state through management/public
  model discovery; ordinary-discovery persistence failure keeps pending; stale
  concurrent selections or registration identity cannot be overwritten.
- Pending degraded/write-failure candidates are absent from injection/fallback/
  subagent candidate APIs; old retained disk rows remain hidden after re-add.

Extend existing tests/codex-integration/codex-convergence-contract.test.ts and
model-visibility-management-api.test.ts for commit-bound state persistence and
pending-write behavior. Extend tests/cli/cli-provider.test.ts,
tests/oauth/key-login-preserves-model-costs.test.ts and
tests/oauth/oauth-upsert-preserves-api-key.test.ts for creation/preservation seams.
Extend tests/server/config.test.ts for malformed metadata and round-trip; add DTO
field policy assertions near existing safeConfigDTO tests.

Verification: no local suites; direct tsc + whitespace, independent code/security
boundary review, exact-head existing GitHub CI including the regression files.
New tests are required coverage, not weakened old expectations. No TDD claim
without remote red proof. Public documentation notes belong with each PR scope.

## A-round synthesis

Accepted pending-candidate and retained-recovery gaps: explicit consumers and final
merge now own the exclusion, with regressions. Accepted ordinary finalizer adoption:
copy both committed state and disabled selectors to the caller, never only metadata.
Physical-count provenance finding is resolved by narrowing the unconfirmed counting
assumption to the actual Models switch inventory, not by growing a second physical
model catalog. This matches the user's screenshot and threshold UX. Separately
listed catalog IDs count, display-only aliases do not, and metadata customization
is not a reason to discount a row.

### Re-registration cleanup

When an explicit new registration replaces a deleted provider, remove orphaned
provider-qualified disabled selectors before seeding its new state. Cover raw and
encoded forms by exact provider namespace; preserve other providers and current
combo public aliases. Cleanup happens on re-registration rather than retroactively
changing every existing provider or broadening deletion operations. A new small
catalog must not inherit the previous registration's all-OFF selectors.
