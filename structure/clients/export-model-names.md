# Client Export Model Names

## Scope and policy

Hermes and Command Code support opt-in `alias` names. The default is `routed`.
`src/clients/config-export/model-names.ts` owns the two-value policy, supported
clients and final row projection. `src/clients/config-export/contracts.ts` keeps
`namespaced` canonical and carries a separate proven `aliasNamespaced` candidate.
The public builders in `src/clients/config-export.ts` apply the policy;
serializers consume the resulting rows without performing alias lookups.
Other exporters reject alias mode and retain routed output. Combos retain their
existing public key in either mode. `preferModelAliasIds` has no effect here.

## Selector proof

`src/server/management/model-rows.ts` builds the shared export roster.
`src/clients/config-export/alias-selectors.ts` computes effective aliases once
per provider against the router's known model inventory, before visibility
filtering. A candidate uses the effective provider alias or provider name and a
validated model alias. Native/account-native and combo rows are excluded.

The read-only router must resolve the candidate and canonical key to the same
concrete provider, model and account identity. A policy/combo result, ambiguity,
unsafe namespace, native-ID shadow or refusal falls back to the canonical key.
Canonical/native/combo and synthetic Fast keys are reserved across the full
roster; candidates cannot overwrite another row through normalization. Fast
selectors also require equivalent ingress resolution. Model metadata and
visibility remain those of the original row; aliases never donate metadata.
The common export/contribution boundary regenerates candidates against its exact
captured configuration and current router inventory. Old candidate metadata is
discarded first: a discovery race cannot authorize an alias that was reassigned
before an unbound Apply freezes its input. Serializers remain pure row consumers.
`src/integrations/model-name-guard.ts` rechecks emitted aliases against the live
configuration after all coordinator awaits and profile guards, before maintenance
or transaction writes. It binds inherited mode through the ordinary read-only
observation. A changed selector refuses with conflict; serialization still uses
the frozen input. This also covers coordinated refresh and overwrite, while
routed-only operations and disable retain their existing behavior.

## Stored connection mode

`src/integrations/ownership.ts` stores optional `modelNames` on each ownership
record. An absent legacy value means routed. Unknown present values refuse;
they are never interpreted as permission or silently migrated. Reads and no-op
refreshes do not rewrite legacy records.

`src/integrations/state.ts` resolves requested mode, then the bound file's stored
mode, then routed. Omitted Apply preserves the stored mode, including dashboard
requests. `src/integrations/mutation-plan.ts` binds explicit intent and resolved
mode into the opaque preview fingerprint. A policy-only change is a real change
even if the model keys currently have no aliases and the bytes remain equal.

`src/integrations/writer.ts` resolves policy from the authoritative observation
and commits it through the existing snapshot/ownership/journal transaction.
Undo and compensation carry the complete prior record, including its policy.
Each named Hermes profile uses its own store; automatic catalog refresh still
covers only the default profile (see [Hermes profiles](hermes.md)).

Alias rename/removal takes effect at the next successful managed refresh or
Apply: old owned keys are removed and replaced with a newly proven alias or
routed fallback. Repeating that refresh is a no-op. Existing foreign-edit
refusal and Hermes whole-file automatic-refresh protection remain in force.
Refresh does not recreate a removed managed block. Alias edits and client-file
migration are separate operations; a previously saved selector can be stale
until refresh succeeds.

## CLI and API boundary

`src/cli/integration-input.ts` parses `--model-names alias|routed`.
`src/cli/integration-preview.ts` forwards it as `modelNames` only for supported
apply/overwrite operations. `src/server/management/integration-routes.ts`
validates it before catalog work, carries it through preview/stale-plan rebuilding
and uses it in mutation-flight identity so different intentions cannot join.

`src/cli/export-command.ts` previews naming through the client-config route in
`src/server/management/model-routes.ts`. An explicit naming option uses a passive
current export snapshot; missing/stale evidence refuses without discovery,
credential refresh, config writes, client writes or managed-store maintenance.
Omission on a one-shot export means routed, independent of any saved connection.
Explicit `--out` writes only an export artifact under the existing create/force
rules; it never connects the client.

## Verification

- `tests/clients/client-export-model-names.test.ts`: exact issue-fixture keys,
  router identity, collision/unsafe fallback, unchanged defaults and client scope.
- `tests/clients/integrations-model-names.test.ts`: mode persistence, omission,
  rename/removal, idempotence, foreign edits, policy-only transactions and undo.
- `tests/server/management-export-model-names.test.ts`: request validation,
  passive preview and managed API intent.
- `tests/cli/cli-export-model-names.test.ts`: flag admission and forwarding.
