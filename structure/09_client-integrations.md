# Client Integrations

The client-integration subsystem writes one generated OpenCodex provider contribution into a
third-party client's existing config without taking ownership of the rest of that file. Its core
promise is reversibility: apply snapshots first, writes atomically, records exactly what it owns,
and refuses refresh, disable, or restore when the current file cannot be classified safely.

## Module Responsibilities

| Module | Responsibility |
| --- | --- |
| `src/clients/config-export.ts` | Pure per-client config builders and the exact managed fragments each client receives. It never writes files. |
| `src/integrations/registry.ts` | Canonical config/detection paths, source-preserving YAML declarations, writer-lock behavior, and client IDs. |
| `src/integrations/config-io.ts` | Bounded file loading and parsing. Values that cannot round-trip through the target serializer are rejected before mutation. |
| `src/integrations/state.ts` | The single `absent` / `current` / `stale` / `conflict` / `unsafe` classifier used by status and every writer operation. |
| `src/integrations/ownership.ts` | Durable ownership records: file, generated contribution, protected contribution, exact fragment paths, and operation identity. |
| `src/integrations/ownership-policy.ts` | Client-scoped declarations for fields a client is documented to derive after apply. It must never contain a broad format-wide exemption. |
| `src/integrations/writer.ts` | Apply, refresh, disable, and restore transactions, including snapshot-first ordering, compare-before-commit, and compensation. |
| `src/integrations/store.ts` / `journal.ts` | One-root persistence for ownership records, operation history, snapshots, and retention maintenance. |

## Data Flow

```text
client registry + export context
  -> build managed contribution
  -> load and parse current config
  -> classify exact recorded fragments
  -> snapshot prior bytes
  -> merge or remove only recorded paths
  -> compare current bytes again
  -> atomic write
  -> ownership record + operation journal
```

Status and mutation must use the same classifier. A special case added only to a status endpoint
would be misleading because refresh or disable could still reject the same file; a special case
added only to a writer would let a mutation bypass the state users saw.

TOML temporal scalars cannot survive the JSON-cloned merge representation with their types
intact. The common parser refuses documents containing them before either status or mutation
proceeds, including nested arrays and inline tables. Quoted date strings remain supported.

## Catalog visibility

Management export and CLI export apply the canonical routed catalog visibility filter before
serialization: provider selections, disabled models, and pending initial selection all constrain
the client roster. The full management list remains available for selection. Native rows retain
their existing visibility rules.

## Owned catalog convergence

Visibility, selected-model and preset writes refresh already-owned Pi/Aside contributions after
persisting the selection. Explicit sync refreshes MCode, Pi and Aside. The shared catalog-refresh
fan-out loads the filtered roster lazily once, leaves unowned clients alone, and reports each
refusal independently. Existing coordinated writers retain all no-clobber and ownership checks.
Implicit refresh operations use distinct flight keys: overlapping desired catalogs return busy
rather than joining a write of a different catalog and reporting false success.

## Fast model selectors

The serving proxy resolves `fastRowAvailable` on every management model row, including its
`fastRows` setting (default true), canonical eligibility, native upstream tier evidence, and
exact-ID collisions checked before disabled rows are filtered. Management and CLI projections
carry the boolean into the shared client serializers. Only true creates an additive `--fast`
selector, preserving the underlying provider, model ID, modalities, limits, and effort metadata.
False or missing metadata never causes local inference, so old or disabled remote hubs remain
authoritative. Existing client configs receive the entries on export or managed refresh.

## Hermes Model Capabilities

Hermes cannot infer custom-provider capabilities from its built-in registry. The OpenCodex
provider therefore emits `models` as a mapping keyed by the canonical namespaced selector. An
explicit catalog modality list containing `image` becomes `supports_vision: true`; an explicit,
non-empty list without `image` becomes `false`; an absent or empty modality list keeps an empty
model object so Hermes receives no guessed capability. OpenCodex does not emit `supports_video`
because its authoritative input-modality vocabulary currently has no video value.

[Decision Log]
- 목적과 의도: Preserve catalog-backed image routing when Hermes uses OpenCodex as a custom provider.
- 기존 구현 및 제약 조건: A string array preserved model selection but normalized to empty metadata in Hermes, while OpenCodex has authoritative text/image/audio facts but no video fact.
- 검토한 주요 대안: Keep the array; mark every model vision-capable; infer video from model names; emit a per-model metadata map from declared modalities.
- 선택한 방식: Emit a stable per-model map and include only the `supports_vision` boolean that the catalog can prove.
- 다른 대안 대신 이 방식을 선택한 이유: The map is the Hermes-supported capability boundary, while guesses would misroute attachments or advertise unsupported video.
- 장점, 단점 및 영향: Vision-capable custom models route correctly and text-only rows stay explicit; unknown rows remain unknown, and video routing waits for authoritative source metadata.

## Ownership Axes

`fileFingerprint` records the exact whole-file result for restore and for serializers that may lose
comments. `blockFingerprint` records the exact generated contribution and detects catalog, model,
port, or provider drift. `fragmentPaths` bounds disable to the paths OpenCodex actually created.
New records pair the exact contribution fingerprints with semantic fingerprints that recursively
sort JSON object keys while preserving array order. Existing records without the semantic companion
fall back to comparing the recorded generated contribution when the catalog has not moved. This
keeps old records readable while preventing a client's formatting-only key reorder from
masquerading as a protected edit.

[Decision Log]
- 목적과 의도: Treat JSON object-key order as formatting while retaining safe ownership proof across upgrades.
- 기존 구현 및 제약 조건: Existing records contain order-sensitive hashes, and replacing their hash format in place would make every installed integration look foreign-edited.
- 검토한 주요 대안: Replace the hash format globally; ignore key order only for ZCode; store a semantic companion beside the existing exact hash.
- 선택한 방식: Preserve the exact hashes for compatibility and add object-key-independent semantic companions to new records, with a bounded desired-contribution fallback for old records.
- 다른 대안 대신 이 방식을 선택한 이유: A global replacement cannot validate old records, while a ZCode-only exception would leave the shared JSON ownership rule inconsistent.
- 장점, 단점 및 영향: New records tolerate key normalization even across catalog refreshes; old records recover when the recorded catalog is still reconstructible, and ambiguous old-record drift remains fail-closed.

Clients normally protect every field in every recorded fragment. A client that writes documented,
runtime-derived fields back into an owned fragment may additionally record:

- `refreshablePaths`: the exact document paths that client may derive for this operation;
- `protectedBlockFingerprint`: the contribution fingerprint after only those paths are removed.

The paths are stored with the operation instead of recomputed from the latest catalog. That keeps a
later catalog expansion from silently widening what an older ownership record allows. Malformed or
incomplete policy records fail closed.

## ZCode Runtime Metadata

ZCode 3.8.1 persists model defaults into `provider.opencodex.models.*` after OpenCodex writes the
provider. The accepted derived paths are deliberately narrow:

- `reasoning` for model IDs emitted by that apply;
- `limit.output` for model IDs emitted by that apply;
- `limit.context` only when OpenCodex emitted no authoritative context for that model.

Provider identity and connection fields (`name`, `kind`, `enabled`, `source`, and every `options`
member), model membership, model names, modalities, and authoritative context limits remain
protected. Changing any of them stays `conflict / foreign-edit`.

Records written before the protected fingerprint existed can recover from ZCode-derived metadata
only while the desired contribution is still identical to the one recorded at apply time. If the
catalog also changed, the old record cannot distinguish catalog drift from a foreign edit and must
fail closed. A successful refresh writes the new operation-scoped policy.

[Decision Log]
- 목적과 의도: Allow ZCode's documented runtime normalization without turning genuine provider or connection edits into refreshable drift.
- 기존 구현 및 제약 조건: The classifier hashed the whole `provider.opencodex` fragment. That was safe for ordinary JSON clients but made every ZCode save a permanent foreign edit. Refresh and disable both depend on the same ownership proof.
- 검토한 주요 대안: Ignore all model metadata; compare only the provider connection envelope; hard-code a ZCode branch directly in `state.ts`; store explicit operation-scoped mutable paths and a protected fingerprint.
- 선택한 방식: Keep the strict generated contribution hash, add a separate protected fingerprint, and persist the exact ZCode-derived paths with each ownership record through a client-scoped policy module.
- 다른 대안 대신 이 방식을 선택한 이유: Ignoring all model metadata would allow user model edits to be overwritten. Comparing only the connection envelope would stop protecting model membership and capabilities. A state-only special case would disagree with writer behavior. Operation-scoped paths preserve the original grant across later catalog changes.
- 장점, 단점 및 영향: Normal ZCode saves become refreshable, connection edits still fail closed, and later catalog refreshes remain possible. Legacy records with simultaneous catalog drift still require a conservative manual recovery because the old schema did not store enough evidence.

## Verification

Behavior changes require real writer tests against a temporary home and state store. At minimum,
cover accepted derived metadata, protected connection edits, protected authoritative context,
catalog changes after a derived rewrite, and legacy-record fail-closed behavior. Synthetic
fingerprint-only tests are supplementary; they cannot prove the status and writer paths agree.

## Remote connection lifecycle

Remote clients journal and restore native integrations locally while model traffic travels directly to the hub. Catalog writes occur only after protocol negotiation and full remote schema validation. The management relay is launcher-scoped and fixed to the connection's management origin. Claude/Codex launch behavior remains integration-scoped. Key rotation and recovery align both the local connection credential and the connection-owned Desktop profile before reporting completion. Disconnect restores owned Desktop settings and native integrations locally without automatic hub-key revocation or usage mirroring. Interrupted cleanup remains recoverable for the same connection; conflicts prevent a full-cleanup claim.

## Connected Claude Desktop profiles

Connected `ocx claude desktop apply` reads the hub's Desktop snapshot and writes the hub origin
and exact hub-issued IDs to the local Desktop configuration. Static/hybrid embed the entries;
discovery-only keeps discovery on the hub. The hub owns family assignments and defaults; local
show/edit/import/export operations do not manage that profile. After hub changes or historical
client-only aliases, apply again and reselect the model. Connected `import --apply` is explicitly
unsupported and refuses before saving the import.

`src/claude/desktop-discovery-inputs.ts` owns the shared Desktop discovery projection used by
startup registry initialization and server discovery. `src/server/index.ts` exposes the explicit
`GET /v1/models?ids=desktop&format=desktop-config` snapshot, shaped as `{version:1,models:[...]}`
and sent with `Cache-Control: no-store`. `src/client/hub-client.ts` downloads it with the existing
data credential; `src/cli/claude-desktop.ts` selects connected apply, and `src/claude/desktop-3p.ts`
writes the resulting local Desktop configuration. No admin token, hub-profile upload or local
alias regeneration is part of this flow. Unsupported old hubs, invalid snapshots and unavailable
Desktop models fail apply without a local-catalog or loopback fallback.

Date-shaped Desktop IDs can overlap genuine native model IDs. When available discovery and
mapping evidence cannot resolve one, Messages and count-tokens return HTTP 503 with the fixed
`desktop_model_mapping_unavailable` error rather than classifying it as invalid. Unknown legacy hash aliases
remain HTTP 400; neither case reaches date-stripping or fallback routing. Known/registered IDs,
exact operator mappings and recognized native IDs keep their existing handling. Discovery refresh
or reapplying the connected hub profile may supply the missing mapping; retry alone does not
guarantee resolution.

The remote-alias slice does not change thinking/redacted-thinking replay or prompt-cache
behavior. Those remain the separate request tracked in #3719; proxy admission alone does not
establish native Anthropic passthrough or imply that translated Anthropic caching is disabled.

### Desktop ownership across the connection lifecycle

`src/claude/desktop-remote-store.ts` owns the first protected restoration baseline and the
connection-owned Desktop fields. `src/cli/claude-desktop.ts` handles connected apply, while
`src/client/connect.ts` coordinates key rotation/recovery and disconnect. Reapply and rotation retain the original
baseline. Restoration merges into current user fields, preserves unrelated profiles, and restores
the previous selection only while the managed profile is still selected. A later valid user
selection is not changed. A newly created profile with user additions is retained in readable
standard mode instead of deleting those additions.

A proven legacy current-hub/recognized-key profile without an original baseline can be adopted
by apply, rotation/recovery or direct disconnect without a new flag or prerequisite reapply.
Its explicit standard-fallback outcome is distinct from original restoration: only owned gateway
settings are removed, with user fields and independent valid selection preserved. Unknown keys,
changed managed fields or damaged restoration records remain conflicts, not permission to capture
new originals or overwrite user data.

Rotation changes credentials without changing model IDs, family/default choices or selecting the
managed profile again. The CLI reports `rotation: "committed"` only for the new active generation;
`rotation: "rolled_back"` means the previous generation was retained/restored and must not claim
revocation of that previous key. Incomplete recovery keeps the operation unresolved. Disconnect
restores Desktop even with `--keep-catalog`; retries preserve the original catalog choice and must
not clear a newer connection. Authorized uninstall completes or resumes owned Desktop cleanup
before removing OpenCodex state, and preserves recovery state when cleanup conflicts or fails.

These guarantees concern files on disk. Fully quitting and reopening Desktop is required after
apply, rotation/recovery or restoration; there is no automatic process restart or guarantee that
a running app discarded a key. Local disconnect does not revoke the hub key or remove arbitrary
external copies. Model-list snapshot version 1 remains a read-only contract, not a new lifecycle
or profile-upload API. Thinking replay and prompt caching remain separate in #3719.

## Aside profile ownership

Aside discovery projects only registered numeric account IDs, labels and current status. Catalog
paths derive from the configured root/u/id, never from browser profilePath. Guarded filesystem
identity and IO apply to status and writes; internal resolved path pairs survive async freezing.

`asideProfileSync` owns desired all-profile defaults and per-profile overrides. The legacy
connection defaults all profiles on; explicit per-profile changes materialize that default and
pin one legacy root owner before changing it. Sibling stores remain independent. Policy saves
precede coordinated writes under one scoped flight, and actual file state/refusals remain
separate. Restore reconciles target intent from validated snapshot ownership without changing
sibling policy. Profile journal views retain source-store provenance for older legacy entries.
