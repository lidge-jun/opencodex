# Client Integrations

Shared parsing and streaming follow the [request-copy](../transports/byte-accounting.md#request-copy-accounting) and [stream-buffer accounting](../transports/byte-accounting.md#stream-buffer-accounting) contracts.

The client-integration subsystem writes one generated OpenCodex provider contribution into a
third-party client's existing config without taking ownership of the rest of that file. Its core
promise is reversibility: apply snapshots first, writes atomically, records exactly what it owns,
and refuses refresh, disable, or restore when the current file cannot be classified safely.
Managed client targets are inspected without following a final symbolic link, and their atomic
replacement addresses the named directory entry rather than resolving that link again at commit.
Uninstall runs the same coordinated disable path for every strict ownership record before removing
OpenCodex state, including the legacy Aside owner and every child profile store under
`integrations/aside-profiles/<profileId>/`. `src/cli/uninstall-integrations.ts` validates all stores
and registered Aside paths before mutation; `src/integrations/aside-profile-context.ts` supplies
the guarded child stores. An unreadable record, conflict, or failed compensation aborts config
removal and retains remaining recovery state. Earlier successful disables are not rolled back;
failed compensation can leave an intermediate client file. Inspect the reported client files and
retained snapshots before retrying; preserved recovery state does not prove restoration completed.

> Decision record: [ADR-0107](../decisions/ADR-0107-uninstall-integration-recovery.md)

Shared response support has a separate [bounded ingestion contract](../transports/inventory.md#bounded-response-ingestion-and-orcarouter-login):
raw-byte callers own their byte and deadline budgets and inherit best-effort cancellation.
The OrcaRouter login ceiling applies to its key exchange; client configuration files retain the
parsing and ownership rules below.

## Module Responsibilities

| Module | Responsibility |
| --- | --- |
| `src/clients/config-export.ts` | Pure per-client config builders and the exact managed fragments each client receives. It never writes files. |
| `src/integrations/registry.ts` | Canonical config/detection paths, current-provider-store declarations, source-preserving YAML declarations, writer-lock behavior, and client IDs. |
| `src/integrations/target.ts` | Which file one operation reads, writes and records, and whether a write there reaches the client. |
| `src/integrations/config-io.ts` | Bounded file loading and parsing. Values that cannot round-trip through the target serializer are rejected before mutation. |
| `src/integrations/state.ts` | The single `absent` / `current` / `stale` / `conflict` / `unsafe` classifier used by status and every writer operation. |
| `src/integrations/ownership.ts` | Durable ownership records: file, generated contribution, protected contribution, exact fragment paths, and operation identity. |
| `src/integrations/ownership-policy.ts` | Client-scoped declarations for fields a client is documented to derive after apply. It must never contain a broad format-wide exemption. |
| `src/integrations/writer.ts` | Apply, refresh, disable, and restore transactions, including snapshot-first ordering, compare-before-commit, and compensation. Freezing an input copies the proxy configuration and the model roster as plain data before the first await, so the plan a revalidation approves and the document that follows it read one input; an input that cannot be copied is refused rather than read twice. Aside captures the same configuration copy when its context is created, because its preference write edits the live configuration between the check and the profile writes. |
| `src/integrations/mutation-plan.ts` | The shared observation both a preview and a mutation read, and the value-free plan an operator confirms. It owns no IO of its own, takes no lock, and must never import `writer.ts`. |
| `src/integrations/store.ts` / `journal.ts` | One-root persistence for ownership records, operation history, snapshots, and retention maintenance. |

## Cursor installed capability reads

`src/integrations/cursor-effort-table.ts` reads the installed agent bundle through one regular-file
handle, refuses final symlinks where supported, and caps bytes read even if the file grows after
inspection. Failure retains the static-table fallback. Parsed content is cached by path, mtime and
size; the returned table always uses the current install version, including on a cache hit.
`tests/providers/cursor/cursor-effort-table.test.ts` covers cache reuse, version refresh and unsafe files.

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

## Read-only mutation plans

An operator confirming apply, overwrite, disable or undo is agreeing to consequences they were
never shown. A plan is what shows them, and it is only trustworthy if it describes the operation
that will actually run.

One observation serves both. `mutation-plan.ts` owns the read, parse, contribution build, record
selection and classification that the writer used to perform itself, so a preview and the mutation
it authorizes cannot disagree. The direction is strict: state, ownership and merge feed the plan;
the plan feeds the writer and the preview routes. The plan module must never import the writer.

Preview and mutation differ in exactly two ways, and both are declared rather than implied.
Pending-prune maintenance and client transaction recovery each write, so they are explicit options
with no default that a preview passes as false. And a preview takes its model roster from the
retained export snapshot instead of gathering one, because discovery refreshes credentials and
writes the provider cache. With no usable snapshot the request is refused, which covers a cold
process and equally a snapshot retired because the configuration or the provider cache moved. The
roster is gathered and projected from a detached copy of the configuration
(`src/config/admitted-identity.ts`) taken before the gather, so an edit that lands mid-load changes
neither half of the result; the same admission is revalidated against the resident object and the
configuration file before anything is retained, so such an edit leaves no snapshot rather than one
recorded under a state its rows never had. The identity a caller carries between a preview and the
mutation that confirms it is process-local and opaque, and describes nothing about the
configuration. The
Integrations collection read populates one when discovery succeeds and the configuration can be
identified, so the page an operator opens before confirming anything is the usual way back rather
than a guarantee.

Each operation is decided the way that operation decides it. Apply checks installation and
admission before the classifier and reports a conflict ahead of unsafe; disable asks neither,
because removing what we wrote from a file that still exists is meaningful regardless of
installation; restore reads the journal row and the target's bytes and never parses, so a file
that is readable but unparseable is still restorable. An operation that would write nothing says
so and names no places.

Published paths are declared, not inferred. Every client states where its managed fragments live,
a path is emitted only on an exact template match, and the string emitted is the template rather
than the observed path, so a dynamic position renders as a wildcard and a value cannot leak. A
path outside the declaration is refused rather than described: an ownership record accepts
arbitrary strings and is not a validation authority.

The fingerprint covers every input the decision rests on, including the roster, the observed
install kind and the admission predicate, and for restore the snapshot's actual bytes rather than
only its operation id. A confirmed mutation re-plans the coordinator's frozen input with the lock
held, before any snapshot, write or journal row, and separately checks that the snapshot it
captured is still current; the roster and that identity are read together so the check cannot
validate one snapshot while the mutation writes another. Aside is the exception that proves the
placement: it persists preferences and imports journal rows before any writer lock, so its check
runs once profile and path selection is frozen and before those writes.

The fingerprint is an optimistic token, never authorization. Management authentication and every
ownership rule still decide whether a mutation may happen, and the writer's own
compare-before-commit guard is unchanged.

Gajae export and managed refresh share the loopback-only provider builder. It writes the
non-secret `LOOPBACK_API_KEY_PLACEHOLDER` as `apiKey`, so the client can activate the provider
without a separately populated environment variable. The managed contribution owns only the
provider block in `models.yml`; default presets and proxy routing in `config.yml` remain user-owned.

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
authoritative. Existing client configs receive the entries on export or managed refresh. A Dashboard
save refreshes enabled native clients and already-owned file integrations when the running proxy port
is available; otherwise the operator refreshes the integration or client catalog explicitly.

## Model input capability exports

All registered integrations consume the shared catalog, including [Anthropic seed image metadata](../runtime.md#capability-aware-image-admission), through their existing schema-specific exports:

| Client | Per-model output |
| --- | --- |
| OpenCode | `attachment`, `modalities.input` |
| Pi, OMP, Prime, Aside, omo, Gajae, DSH | `input` (text/image only) |
| ZCode | `modalities.input` (text/image only) |
| Cline | `modalities.input`, `supportsVision` |
| Hermes | `supports_vision` (see below) |
| OpenClaw | `input`, filtered to declared text/image/video/audio; omitted when none remain |
| Kimi Code | `capabilities: ["image_in"]` only for declared image input; omitted for unknown/text-only models |
| MiniMax Code | No per-model image capability field emitted |
| Raycast | `abilities.vision.supported` |

No exporter infers image support from a model name. Existing client eligibility filters and ownership/refresh rules remain unchanged; exports do not add fields to schemas without a supported mapping.

## Hermes Model Capabilities

Hermes cannot infer custom-provider capabilities from its built-in registry. The OpenCodex
provider therefore emits `models` as a mapping keyed by the canonical namespaced selector. An
explicit catalog modality list containing `image` becomes `supports_vision: true`; an explicit,
non-empty list without `image` becomes `false`; an absent or empty modality list keeps an empty
model object so Hermes receives no guessed capability. OpenCodex does not emit `supports_video`
because its authoritative input-modality vocabulary currently has no video value.

> Decision record: [ADR-0090](../decisions/ADR-0090-hermes-model-capabilities.md)

## Hermes session affinity

Hermes exports include `session_affinity_header: session-id` on the entire OpenCodex provider,
independent of the model roster. This is a header name: Hermes generates the conversation-scoped
value. No static session identifier or protocol switch is emitted, and upstream header-forwarding
rules remain unchanged. Hermes must support the documented per-provider affinity option to use it.

`src/integrations/ownership-policy.ts` recognizes exactly one predecessor: an owned Hermes block
without this setting. The block may remain unchanged or have gained only the supported value; after
removing that field, its exact or recorded semantic fingerprint must match the previous record.
Client, config path and fragment-path ownership still apply. Other edits remain conflicts, and
after adoption the affinity field is fully protected, including against deletion.

Legacy blocks report `stale` until an explicit Apply records the new contribution. Implicit refresh
leaves both their configuration and ownership unchanged, reporting that Apply is needed; this also
defers catalog updates until Apply. Once upgraded, normal refresh resumes and preserves affinity.
Replace emits the setting too. The existing source-preserving YAML, snapshot and restore paths
remain authoritative. `tests/clients/integrations-hermes-affinity.test.ts` exercises the real writer
against temporary client homes, including exact-workaround adoption, refusal, refresh and undo.

## Ownership Axes

`fileFingerprint` records the exact whole-file result for restore and for serializers that may lose
comments. `blockFingerprint` records the exact generated contribution and detects catalog, model,
port, or provider drift. `fragmentPaths` bounds disable to the paths OpenCodex actually created.
New records pair the exact contribution fingerprints with semantic fingerprints that recursively
sort JSON object keys while preserving array order. Existing records without the semantic companion
fall back to comparing the recorded generated contribution when the catalog has not moved. This
keeps old records readable while preventing a client's formatting-only key reorder from
masquerading as a protected edit.

> Decision record: [ADR-0091](../decisions/ADR-0091-ownership-axes.md)

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

> Decision record: [ADR-0092](../decisions/ADR-0092-zcode-runtime-metadata.md)

## A store the client no longer reads

A client may move its provider list to a different file between releases and keep the old one
reachable only through a one-shot import. That import runs on an install that has never created the
new file and never again, so every later write to the old path is read by nobody. ZCode 3.14 is the
instance this rule was written for: the apply was correct, the ownership record was correct, the
journal row was correct, and no model appeared in the client.

A client in that position declares `currentStore` in the registry. The declaration is not only a
location: it carries the text format of that file, the contribution shape its reader understands,
and the predicate that decides whether a document on disk is a version whose shape has been
observed. Naming the store without the last three would be naming a file we cannot write.

`src/integrations/target.ts` turns that declaration into the one answer every surface uses: which
file this operation reads, writes, journals and records, and whether a write there reaches the
client. It decides from three facts, in order:

1. No declared store, or no store on disk — the config file, unchanged. A client that has never run
   still imports what we write there, which is why the rule keys on the store's presence rather
   than on a client version.
2. This project's own block already in one of the two files — that file. Disable removes what we
   wrote from where we wrote it, and no apply leaves a block in one file while writing another.
3. Otherwise the store, and only when its schema establishes.

Four properties are load-bearing:

- The store is observed through the same `IntegrationIO` seam as the config file, so status and
  mutation cannot disagree about which file an operation is about. Only proven absence permits
  legacy writes; failed observations and non-file stores refuse apply/refresh as unestablished.
- The ownership record, the journal row and the undo guard all follow the target rather than the
  client. A row naming the store is restorable because the guard asks whether this client still
  names that location, not whether it is the config file.
- The refusal is bound into the plan fingerprint together with its reason, so a confirmation taken
  before the client created its store cannot be committed afterwards — and neither can one taken
  before the store's schema version moved under an unchanged path.
- Disable is never gated on it. Removing bytes this project wrote from the file it wrote them to is
  unaffected by where the client reads, and refusing it would leave the block unremovable through
  the tool.

Writing the store does not relax ownership anywhere. The store keys a model rule by the pair
`(providerId, modelId)`, so the managed path names both: a selector naming only the model would
match another provider's rule for the same model and replace it. A rule carrying this project's
provider id that no record accounts for — including one the client's own migration created — is a
conflict, and the explicit overwrite remains the only way past it.

Persisted selector segments have two disjoint grammars owned by `src/integrations/merge.ts`.
An unversioned `[field=value]` segment is permanently a one-criterion selector; commas and later
equals signs remain part of its value, so an older ownership record keeps naming the same element.
New multi-field selectors use the explicit `[v2:field=value,field=value]` grammar and are emitted by
the shared formatter. A segment beginning with that reserved marker but failing the complete v2
grammar is unreadable rather than a plain key or a v1 selector, so malformed persisted bytes cannot
silently select a different element.

A store whose schema cannot be established is reported, never merged into. That file holds the
user's other providers and the client rewrites it on its own, so asserting a nesting we have not
observed would trade a silent no-op for a silent loss. Status reports the store beside the file
state rather than folding it into the state: `current` remains the truth about the file, and the
notice appears only when the client reads some other file than the one the state is about.

Deleting the client's store to re-trigger its own import is not implemented and must not be. It
discards every provider the client keeps there.

## Verification

Behavior changes require real writer tests against a temporary home and state store. At minimum,
cover accepted derived metadata, protected connection edits, protected authoritative context,
catalog changes after a derived rewrite, and legacy-record fail-closed behavior. Synthetic
fingerprint-only tests are supplementary; they cannot prove the status and writer paths agree.

## Remote connection lifecycle

Remote clients journal and restore native integrations locally while model traffic travels directly to the hub. Catalog writes occur only after protocol negotiation and full remote schema validation. The management relay is launcher-scoped and fixed to the connection's management origin. Claude/Codex launch behavior remains integration-scoped. Key rotation and recovery align both the local connection credential and the connection-owned Desktop profile before reporting completion. Disconnect restores owned Desktop settings and native integrations locally without automatic hub-key revocation or usage mirroring. Interrupted cleanup remains recoverable for the same connection; conflicts prevent a full-cleanup claim.

## Local destinations on a hub

A client running on the proxy's own machine has two destinations, and they are resolved
separately by `src/lib/local-destinations.ts`. Inference (`localInferenceDestination`) is
`127.0.0.1` on the unauthenticated loopback listener's effective port when that listener is
enabled, otherwise the public port on the bind address — `127.0.0.1` for a loopback or wildcard
bind, and the tailnet or LAN address otherwise, where no loopback data socket exists at all. So
`ocx claude`, the `system-env` injection, the Claude Desktop profile, the Cursor gateway value,
the gateway-model cache, the routed vision self-fetch and the API-access loopback fallback all go
through that resolver rather than composing the port themselves. Management
(`localManagementOrigin`) is the hub's loopback `hub.managementIngress` when enabled, otherwise
the public bind address, and the caller supplies the management credential. `fetchClaudeCodeState`
is that resolver's caller: it sends the local admin token to the management ingress, or — with no
ingress — to the bind address, and either destination is host-local and never reaches an exported
client configuration. Management authentication has no loopback bypass and the data-loopback
listener serves no `/api/*`, so these two must never be collapsed into one base URL, and an admin
credential must never be written into an exported client configuration.

Both resolvers share the same fallback shape, and the inference one additionally reports whether
its destination demands data-plane admission: the loopback listener and a genuinely loopback bind
need no credential, while a wildcard or tailnet bind does. Each caller either attaches that
credential — the `OPENCODEX_API_AUTH_TOKEN` / service-token-file / `apiKeys` ladder, never the
admin token — or logs that it is degrading. Composing `http://127.0.0.1:<public port>` by hand is
what produced a dead socket on a tailnet-bound hub in the first place.

## Aside profile ownership

The local CLI sync shares one absolute deadline across listener attestation and the
capability-bearing POST, even if the listener keeps sending partial bytes.

Aside discovery projects only registered numeric account IDs, labels and current status. Catalog
paths derive from the configured root/u/id, never from browser profilePath. Guarded filesystem
identity and IO apply to status and writes; internal resolved path pairs survive async freezing.

`asideProfileSync` owns desired all-profile defaults and per-profile overrides. The legacy
connection defaults all profiles on; explicit per-profile changes materialize that default and
pin one legacy root owner before changing it. Sibling stores remain independent. Policy saves
precede coordinated writes under one scoped flight, and actual file state/refusals remain
separate. Restore reconciles target intent from validated snapshot ownership without changing
sibling policy. Profile journal views retain source-store provenance for older legacy entries.

The shared atomic replacement publisher also identifies explicit Remote Workspace file writes as `remote-workspace`; its isolated owner and support limits are documented in [Remote Workspace](../remote-workspace.md).

## Cline paired files

Cline CLI uses `providers.json` for connection settings and sibling `models.json` for its
catalog. `src/integrations/cline-document.ts` separates native documents from raw-byte snapshot
bundles; `src/integrations/cline-io.ts` projects both files onto the existing writer/journal.
Only each file's `providers.opencodex` entry is owned. Schema envelopes and the user's default
provider remain user-owned. Cline's selected model and update timestamp can change during normal
use; refresh preserves a selection only while its model remains routed. Connection fields and
catalog membership remain protected.

Each file replacement is atomic; the pair is recoverable, not simultaneously visible. Stop Cline
before explicit enable/sync/disable/restore and restart afterward. Unattended refresh excludes
Cline. A private pending record precedes replacement and survives partial failure. Read-only
status reports an unfinished pair as unsafe; explicit mutation recovers only unchanged original
or intended bytes and compatible ownership. A journaled pair must match both intended files and
final ownership before pending cleanup. Foreign edits retain the pending evidence and refuse.
Undo restores both original byte strings, including individual file absence; drift requires the
existing explicit confirmation. The journal endpoint evaluates Undo against the same pair.

Recovery reads commit history and ownership through strict store methods. Unreadable or malformed
metadata is uncertainty, never evidence that a transaction did not commit. Pending records validate
complete ownership, exact Cline paths and result fingerprints before either native file is replaced.
Native pair writes replace the named directory entries without following final symlinks. A symlink
present at validation is refused, and one exchanged into place during a mutation is refused rather
than redirecting OpenCodex's write outside Cline's settings directory.
