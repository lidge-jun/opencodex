# WP9 — split Codex catalog gather from commit

Research: `001_catalog_seam.md`. Shared contract: `005_contract.md`. Read both
before implementing this diff.

The incident is still r2 #1: catalog refresh combines provider discovery,
catalog assembly, catalog replacement, and cache invalidation in one awaited
operation (`src/codex/refresh.ts:40-52`,
`src/codex/catalog/sync.ts:507-569,600-616`). The 16 management mutations then
call a `Promise<void>` helper that catches dynamic-import, discovery, parse, and
disk failures and discards all of them (`src/server/management-api.ts:105-112`).
That shape cannot put slow observation outside a later lock and a fixed write
sequence inside it, and it cannot tell the caller what actually happened.

WP9 lands the first real catalog-scoped `ConvergeCodex`, rewires exactly those
16 management mutation sites, and leaves the explicit sync/startup/CLI/restore
call shapes for WP12 while modifying each retained writer chain to acquire the
permanent catalog serialization primitive K. A catalog-only commit updates catalog,
create-once catalog backups, and models cache only. It neither reads nor advances the
native routing pair and never writes `config.toml`, generated profile, injection journal, or
history. The transition row makes that boundary mandatory: every positive
native generation requires matching history schedule fields, every
`beginTransition` publishes that schedule, and `assertPublished` rejects a
transition that was not published (`src/codex/transition-state.ts:74-83,314-344,420-428`).

All current-code citations and diff context below were rechecked on 2026-08-04
against the live worktree rooted at
`2becc771977afb112fc8db45ed878fb67625c1a5`, including the WP9 source edits now
present at that HEAD. The contract citations refer to the authoritative worktree amendment:
permanent K, owner-held config generation,
home/source/process-local evidence, and no-clobber publication are at
`005_contract.md:609-1107,1109-1350`; K's owner/path and the four
transitional chains are fixed at `005_contract.md:1442-1640`.

## IN / OUT

IN — observe-only admission and gather:

- `src/config.ts`, `src/codex/generation.ts` (MODIFY) — add a genuinely read-only
  generation observation that never creates, initializes, chmods, or registers
  `config-mutation.sqlite`. The existing `readConfigGeneration` is not that API:
  it resolves/records the path and opens SQLite with `create:true`
  (`src/config.ts:1745-1776,1799-1807,1849-1854`,
  `src/codex/generation.ts:110-142`). WP9
  consumes the contract-owned `withExpectedConfigGenerationSync`; it does not
  wrap this observer in the lock or redefine the generation contract.
- `src/codex/catalog-admission.ts` (MODIFY) — keep the landed request constructor
  and snapshot capture; switch snapshot capture to the observe-only generation
  read, capture the required raw/default `CODEX_HOME` selector, canonical home and
  root identity plus the PRESENT-or-ABSENT `catalog-target-selection` observation,
  assign an opaque identity to the exact retained config reference plus its keyed
  snapshot, and carry the contract-owned `sourceEvidence`. Do not redefine
  `createCatalogConvergeRequest` or `captureCatalogAdmissionSnapshot`, which
  already exist at lines 40-53 and 138-179.
- `src/codex/convergence-types.ts` (MODIFY) — synchronize the already contract-owned
  closed `CatalogSourceRole`, `CatalogHomeSelectionObservation`,
  `CatalogSourceObservation`, `CatalogSourceEvidence`,
  `CatalogProcessLocalEvidence`, `CatalogGatherAuthorityIdentity`, and
  `CatalogAdmissionSnapshot` additions from `005_contract.md`; no WP9-private
  duplicate type is allowed.
- `src/codex/catalog/filesystem-evidence.ts` (NEW) — sole owner of gather source
  reads and target probes. Its opaque session records PRESENT and ABSENT
  observations before returning, captures and seals catalog-home selection before
  accepting any derived path, seals the complete closed role map into the candidate,
  records every native catalog/cache consultation under
  `native-catalog-selection`, and is the only gather path permitted to call
  filesystem consultation primitives.
- `src/codex/runtime.ts`, `src/codex/catalog/bundled.ts` (MODIFY) — catalog gather
  uses a gather-specific observe-only pair:
  `peekCodexRuntimeForCatalogGather(evidenceSession)` and
  `resolveCatalogSourceForGather(evidenceSession)`. They never probe an executable
  or start a subprocess. The first returns only an already-resolved process-local or
  persisted runtime observation; the second consumes a matching in-memory bundled
  catalog or observed persisted catalog/backup/cache source and otherwise returns
  `catalog-unavailable`. `bundled.ts` owns the catalog-specific adapter;
  `runtime.ts` exposes only a process-cache peek and pure persisted-state parser and
  never imports the catalog evidence module. A cold miss never becomes permission to
  execute Codex. Each runtime/bundled memo owns a process-lifetime monotonic epoch and
  a private, recursively frozen value snapshot. Owners clone incoming values,
  deep-freeze every reachable object and array before publication, expose recursively
  readonly types, and return only detached deeply frozen clones or non-aliased
  immutable views; no caller receives the private cache object itself. Population,
  replacement, clear, invalidation, persisted-runtime write, and test reset advance
  the applicable epoch before exposing the replacement. Gather seals the exact
  epoch/value identity plus a non-aliased immutable candidate copy, and commit
  revalidates both before its first write. Whenever runtime identity influences a
  candidate, the evidence session
  records `codex-runtime.json` as PRESENT or ABSENT even on a warm-cache hit.
  This is required because `persistCodexRuntime` writes the file and clears the memo
  without advancing config generation (`src/codex/runtime.ts:268-284`), while bundled
  cache hits and replacements are process-local. The current worktree's runtime owner
  already publishes/returns deeply frozen detached values
  (`src/codex/runtime.ts:16-48,90-105,417-470,505-516`), and the bundled owner does
  likewise (`src/codex/catalog/bundled.ts:60-138,268-302`); WP9 preserves those
  round-4-closed semantics rather than reintroducing the audited private-cache alias.
  The ordinary resolver reaches `probeVersion`, whose sandbox deliberately calls
  `mkdtempSync` and `rmSync` (`src/codex/runtime.ts:286-335,505-516`), while
  bundled loading both calls the persisting resolver and runs `codex debug models`
  (`src/codex/catalog/bundled.ts:220-267,268-302`). Neither path is reachable from
  gather.
- `src/codex/model-cache.ts` (MODIFY) — **round-6 scope amendment:** this is the
  canonical owner of the per-provider models/freshness/cooldown decision consumed by
  flight authority, so WP9 must add its deep-frozen detached snapshots and monotonic
  owner epoch here rather than asking `provider-fetch.ts` to attest to state it does
  not own. Today fresh/stale readers expose the private array, `setCached` retains the
  caller alias, and failure, clear, reconcile, and eviction mutate without an epoch
  (`src/codex/model-cache.ts:17-21,74-86,147-168,172-208,225-226`).
- `src/oauth/index.ts`, `src/oauth/store.ts`,
  `src/codex/catalog/provider-fetch.ts` (MODIFY) — add and consume an observe-only
  active-token snapshot. The filesystem-evidence owner reads the exact auth-store
  buffer under `provider-auth-selection`; `oauth/store.ts` exposes/reuses pure
  normalization semantics rather than calling `peekAuthStore` or another hidden
  filesystem reader. `peekAuthStore` confirms the desired no-chmod/no-backup behavior
  but still owns its own `existsSync`/`readFileSync` consultation today
  (`src/oauth/store.ts:177-181`). The gather path never refreshes, persists, acquires
  an intent lock, creates/removes an intent file, hardens a path, or backs up malformed
  credentials. The current token resolver can enter refresh/persistence
  (`src/oauth/index.ts:327-400`) and the ordinary refresh-capable gather awaits it
  (`src/codex/catalog/provider-fetch.ts:472-499`).
  Replace the partial `providerCatalogFingerprint` single-flight identity with the
  complete contract-owned gather-authority identity. Authority capture happens before
  the map lookup; the flight consumes the captured config/auth/native/source/process
  snapshots and returns the exact identity that produced its result. A joiner must
  match that identity before candidate construction. The map still coalesces a herd
  only when every authority component is equal.
- `src/codex/refresh.ts`, `src/codex/catalog/sync.ts`,
  `src/codex/catalog/parsing.ts` (MODIFY) — prepare immutable catalog/cache/backup
  bytes and source evidence without writing. In particular, target selection no
  longer hides an `existsSync`/`readFileSync` consultation inside
  `readCodexCatalogPath()` (`src/codex/catalog/parsing.ts:167-176`); admission makes
  that consultation through the evidence owner. Preserve production path semantics:
  relative `model_catalog_json` resolves below the canonical active home, an absolute
  configured target remains absolute even outside that home, and an existing catalog
  leaf symlink resolves to and writes through its real target
  (`src/codex/catalog/parsing.ts:52-80`, `src/config.ts:125-164,192-213`).

IN — fixed commit and convergence:

- `src/codex/catalog-write-serialization.ts` (NEW) — permanent synchronous K owner,
  keyed by effective user plus canonical `CODEX_HOME`, backed by its own SQLite
  database with `busy_timeout=0` and `BEGIN IMMEDIATE`. It returns only from an
  owner-held synchronous callback carrying a fresh private permit minted for that
  acquisition. A module-private active-permit registry binds the exact permit object
  to the active K transaction identity and canonical owning home; there is no public
  constructor, brand, or registration API. The owner revokes the permit in `finally`
  before commit/rollback releases K, including when the callback throws, and exports
  only the assertion low-level mutators need. K is separate from both N and
  `config-mutation.sqlite`, and WP11 never replaces it.
- `src/codex/user-identity.ts` (MODIFY) — add
  `resolveCodexCatalogSerializationDatabasePath` beside the landed native coordinator
  resolver. Consumers use its final path verbatim; the K and N database paths must be
  distinct (`005_contract.md:1442-1553`).
- `src/codex/internal/catalog-writer.ts` (NEW/MOVE) — the contract-owned low-level
  owner for catalog, hashed/legacy backups, and models cache. Every mutator requires
  the permit plus canonical owning `CODEX_HOME` and calls K's runtime assertion before
  temp creation, hardening, unlink, link, rename, truncate, replacement, or any other
  filesystem mutation. It never reads or mutates K's private registry. Do not create
  the obsolete `internal/catalog-commit.ts` name (`005_contract.md:1555-1589`).
- `src/codex/convergence.ts` (NEW) — primary catalog gather/commit orchestration for
  the 16 management mutations. The symbol graph additionally permits only the exact
  four WP9 transitional writer chains below; WP12 removes those exceptions.
- `src/codex/management-convergence.ts` (MODIFY) — retain the landed
  management-only factory and catalog-only projection, but replace the placeholder
  body at lines 81-96 with the real call into `convergence.ts`. The factory keeps
  the exact config reference it already captures; no second factory or projection
  is introduced.
- `src/codex/catalog.ts` (MODIFY) — preserve reader/pure exports while removing
  direct writer re-exports from the public facade after legacy callers have explicit
  imports. It currently re-exports `syncCatalogModels`, `restoreCodexCatalog`, and
  `invalidateCodexModelsCache` together (`src/codex/catalog.ts:1-11`).

IN — management callers and tests:

- `src/server/management-api.ts`, `src/server/management/context.ts`, and the four
  invoking route modules (MODIFY) — replace the swallowed helper with a total,
  lazy catalog-convergence adapter returning `CatalogDisposition`.
- The four WP9-transitional chains are IN and use one of two freshness shapes; none may
  read X before K and merely transform or replace X-derived bytes under K. Retained
  management `POST /api/sync` uses **evidence-bound precomputation**: preserve its
  public signature and slow provider/network gather order, seal every filesystem
  value/absence/selector and process-local authority that influenced the candidate,
  then revalidate the complete evidence after acquiring K and before any mutation.
  Drift discards/regathers or follows the existing no-write/write-failure return path.
  This shape is required because current `syncCatalogModels` reads the target and
  `onDiskCatalog`, awaits provider gathering, and derives the replacement from that
  captured merge input at `src/codex/catalog/sync.ts:513-520,526,565`.
  Startup cache invalidation in `src/server/index.ts`, CLI `sync-cache` in
  `src/cli/index.ts`, and native restore in `src/codex/inject.ts` use **under-K
  recomputation**: they acquire K before their authoritative catalog/backup/cache read,
  repeat/discard any pre-K prepared state, and keep K live through deterministic
  derivation and every resulting write. These three chains are synchronous and have no
  provider/network await that justifies a pre-K filesystem snapshot. Public signatures,
  return values, and compatibility behavior stay unchanged; explicit imports needed
  after the facade stops re-exporting writers are mechanical. This is freshness-safe
  serialization of the retained roots, not WP12's convergence rewire
  (`005_contract.md:1591-1640`).
- `tests/codex-refresh.test.ts` and the existing management route suites (MODIFY).
- `tests/codex-runtime.test.ts` (MODIFY) — retain the current regression proving nested
  mutation through a returned runtime cache graph cannot alter owner state
  (`tests/codex-runtime.test.ts:138-148`) and use only the intentional owner
  mutation/invalidation seam when a test needs to move the cache epoch.
- `tests/codex-catalog.test.ts`, `tests/app-owned-memory.test.ts`, and
  `tests/gather-routed-models-single-flight.test.ts` (MODIFY) — focused owner and
  flight tests for nested alias isolation, every required epoch bump, and
  pre-lookup TTL/cooldown decisions. These are the only additional files pulled by
  the round-6 owner-scope correction.
- `tests/codex-convergence-contract.test.ts` (CREATE). It does not exist in the
  WP8b tree; WP9 creates it rather than “extending” an imaginary file.

OUT:

- WP10 history scheduling/worker behavior. Catalog-only work schedules no history.
- WP11 native lock acquisition. WP9 creates and permanently owns K; K is not the
  native lock and is not a placeholder. Global order is N -> K -> C. Because WP9
  catalog-only work does not acquire N, its concrete order is K -> C. `C -> K`,
  `K -> N`, and a held `N -> H` are forbidden.
- WP12 full admission/observer/provenance, full `scope:"full"` convergence,
  and the call-shape rewires for `/api/sync`, startup, CLI cache sync, and restore.
  Those four roots already hold K in WP9; WP12 removes their transitional reachability
  without replacing K.
- Any runtime command that starts, stops, syncs, restores, ensures, or manages the
  live service; any write to real `~/.codex` or `~/.opencodex`; GUI/release/deploy.

The round-6 scope amendment stops at the authority owner. `model-cache.ts` already
depends only on the catalog model type and the generic generation-reconciliation and
memory-budget hooks; advancing its epoch inside reconciliation and the existing
eviction callback requires no WP10 history owner, WP11 N acquisition, or WP12 full
admission/observer/provenance surface. The three focused tests above are the only
additional file scope. No phase boundary or N -> K -> C edge changes.

WP9 typechecks at its own commit. `management-convergence.ts` contains working
catalog behavior, not a placeholder waiting for WP12. WP12 may consolidate the
management factory/projection into `convergence.ts` when it installs the full
entry point; that later move is a module consolidation, not completion of an
unfinished WP9 branch.

Phase-entry gate: WP8b's executable `withExpectedConfigGenerationSync` owner seam is
now present at `src/config.ts:1882-1906`, with its shared callable/result types at
`src/codex/convergence-types.ts:262-272`, as required by
`005_contract.md:617-647`. Recheck that seam before WP9 implementation; if it is absent
or no longer validates through the already-held `configMutationDatabase`, stop and
report the WP8b scope dependency. Do not emulate it with a second connection, weaken
the guard to observe-before-write, or leave a placeholder for WP12. K does not extend
that phase-entry dependency: the current worktree's in-progress WP9 implementation
already has distinct native and catalog final-path resolvers
(`src/codex/user-identity.ts:165-220`) and a concrete K owner; this plan remains their
contract because WP9 is the first phase that must serialize catalog/backup/cache publication.
Moving K to WP8b would widen the already-landed admission seam without an earlier
consumer, while deferring it to WP11/WP12 would leave WP9's retained writers unsafe.

## A. Filesystem-write-free gather

### A1 — state the guarantee exactly

The guarantee is **filesystem-write-free**, not globally side-effect-free. Gather may
update bounded discovery-status, provider model cache, and in-flight admission maps
(`src/codex/catalog/provider-fetch.ts:523-543,570-586,684-690,796-818`); they are
permitted because they do not mutate user files and are reset between isolated tests.
The runtime and bundled memos are observe-only from gather, but their owners can
replace them concurrently (`src/codex/runtime.ts:417-470`,
`src/codex/catalog/bundled.ts:60-138`), which is why the candidate seals epochs and
identities. No credential, raw provider error, source path, or digest may escape
through those caches into `CatalogDisposition`.

Filesystem-write-free means the entire interval from **before admission capture**
through resolved runtime observation, token observation, provider calls, fallback
selection, parsing, serialization, and candidate construction performs no mkdir,
write, rename, copy, unlink, chmod/ACL change, SQLite create/init/WAL change,
ownership registration, backup, transient temp-file creation, executable probe, or
subprocess. The guarantee covers scratch outside the Codex/OpenCodex homes too;
there is no permitted gather scratch scope.

This bound deliberately catches the writes hidden by the old plan:

- runtime selection must not persist `codex-runtime.json`;
- ordinary auth reads must not call `loadAuthStoreInternal`, whose read path
  hardens files and backs up invalid JSON (`src/oauth/store.ts:135-145`);
- expired OAuth is a sanitized provider-auth degradation/failure for this gather,
  not permission to refresh and persist;
- admission must not invoke the create-on-read generation path, which can also
  register ownership metadata (`src/lib/config-ownership.ts:202-226,262-282`).
- `resolveCodexRuntime()` is forbidden even though it does not itself persist: a
  cold resolution reaches `probeVersion()`, and that probe intentionally creates
  and deletes a temporary `CODEX_HOME` because real Codex writes even for
  `--version` (`src/codex/runtime.ts:286-335,505-516`). A final-state
  manifest cannot see that created-then-deleted directory.
- `loadBundledCodexCatalog()` and `runCodexDebugModels()` are forbidden beneath
  gather. The current bundled loader resolves/persists a runtime and executes
  `codex debug models --bundled` without an isolated gather environment
  (`src/codex/catalog/bundled.ts:220-302`).

The observe-only generation API opens an existing database with `readonly:true`,
performs only schema/version/select checks, and closes it. Missing DB/table/row,
busy, malformed, or unreadable state returns the existing typed unavailable result;
it never initializes generation zero. `captureCatalogAdmissionSnapshot` projects
that result into a typed catalog refusal through the total adapter.

The gather-specific resolver is a separate API, not a flag on
`resolveCodexRuntime()`. `bundled.ts` owns
`peekCodexRuntimeForCatalogGather(evidenceSession)`: it may consume an unexpired
successful value from a pure process-cache peek exported by `runtime.ts`, or parse
persisted `codex-runtime.json` bytes supplied by the evidence session through a pure
runtime-state parser. The persisted file is a mandatory PRESENT-or-ABSENT
`runtime-selection` observation whenever that runtime identity affects the candidate,
including a warm process-cache hit. `runtime.ts` never imports the catalog evidence
owner. This path does not test whether the command is executable, discover PATH
alternatives, call `probeVersion`, persist selection, or execute the command. The observation can
only identify a matching already-populated in-memory bundled-catalog cache; it is not
authority to refill it. The runtime and bundled owners return a detached recursively
frozen clone or non-aliased immutable view with the current process-lifetime
epoch/value identity; recursively readonly public types prohibit nested object/array
mutation as well. The private memo snapshot is never returned. The candidate records
`unused` when an owner does not influence preparation.
`resolveCatalogSourceForGather(evidenceSession)` then tries that immutable cache value
followed by active-catalog/backup/models-cache buffers read through the evidence owner.
Its closed result is usable prepared source or
`catalog-unavailable`; the latter projects to the existing sanitized
`skipped/catalog-unavailable` disposition and leaves no residue.

The observe-only token snapshot receives the exact auth-store buffer from the
filesystem-evidence owner and applies the store's pure normalization once. A
non-expired access token may be used. Missing, malformed, near-expiry, or expired
OAuth credentials yield provider-auth without calling any refresh path. Static API
keys and request headers already present in the admitted `Readonly<OcxConfig>` remain
usable. If the auth-store buffer influences a live provider result, its PRESENT or
ABSENT `provider-auth-selection` observation joins the candidate's private source
evidence; token bytes never do.

Round 5 closes a separate live-flight authority hole. The current
`providerCatalogFingerprint` includes endpoint/catalog fields but excludes
`authMode`, `apiKey`, and `headers`
(`src/codex/catalog/provider-fetch.ts:134-156`); `gatherFlightKey` hashes that partial
projection (`src/codex/catalog/provider-fetch.ts:159-179`) and the map joins solely by
the resulting key (`src/codex/catalog/provider-fetch.ts:790-819`). Those omitted
fields are behavioral: forward mode exits with no models, credential resolution is
awaited, and the effective request headers are then built
(`src/codex/catalog/provider-fetch.ts:472-499,546-566`). The observed failure was A at
generation N in forward mode, B admitted at N+1 in key mode, and B receiving A's
empty promise result with no A authority in its candidate.

The current in-progress worktree adds a plain SHA-256 of the observed auth-store
buffer as a key prefix (`src/codex/catalog/provider-fetch.ts:771-787`). It still omits
static key/forward mode and configured headers, and `GatherFlightResult` still carries
no authority (`src/codex/catalog/provider-fetch.ts:85-89`). It therefore neither
closes the failing sequence nor meets the privacy rule below.

WP9 keeps single-flight because equivalent concurrent management mutations should
not multiply upstream `/models` requests. It rejects the alternative of prohibiting
all cross-admission sharing: that is safe but defeats the thundering-herd control the
flight map exists to provide. Sharing is narrowed to callers whose complete immutable
`CatalogGatherAuthorityIdentity` is equal. In practice that means the same exact
resident `Readonly<OcxConfig>` reference, the same admitted generation and exact
config snapshot, the same auth snapshot, the same native-catalog/source snapshot,
the same sealed source-session identity, and the same relevant process-local inputs.
A different config object does not share merely because selected catalog fields are
equal.

`catalog-admission.ts` assigns each retained config object an opaque process-local
WeakMap identity and combines it with generation plus a keyed identity of the exact
canonical config graph. The gather-authority owner mints one unexported random
256-bit process key and computes domain-separated HMAC-SHA-256 values over
length-prefixed canonical encodings. Canonical config encoding preserves own-key
presence, primitive type, array order, and sorted object keys; values that cannot be
represented exactly refuse admission. The auth component covers, per enabled
provider, provider name, effective mode, credential state, exact resolved API-key or
observe-only OAuth token bytes (or explicit absence), the exact
`provider-auth-selection` observation, and the final discovery method/URL/normalized
headers after transport defaults. Header names are lowercased and sorted while values
stay byte-exact only inside the HMAC input.

Effective discovery policy is its own component, not a field of the one below. Round
7 reproduced why: `tests/helpers/provider-registry-discovery.ts:15-30` assigns
`modelDiscovery` and `preserveCustomDestination` onto a live `PROVIDER_REGISTRY` row
and restores them in a `finally`, and three tests drive the real `gatherRoutedModels`
through it (`tests/provider-model-discovery-contract.test.ts:182,210,253`). Those
fields decide results — `resolveProviderModelDiscovery` reads the live entry and
derives the filter plus the clamped `maxModels`/`maxResponseBytes` from it
(`src/providers/model-discovery.ts:123-136`). With a flight already active, a caller
holding the same config reference, generation and cache decision joined it and
received rows its own policy required rejecting: `fetchCount=1` with both callers
getting three rows, against a control run where the same override alone returned the
fallback and warned about the two-row limit.

So before flight lookup the owner captures a detached, recursively frozen effective
discovery-policy snapshot per enabled provider: the registry-transport match outcome,
the exact `url`/`path`/`query` location policy including explicit absence, the final
method and URL, the complete declarative filter, and the clamped `maxResponseBytes`
and `maxModels`. Its HMAC is `discoveryPolicyIdentity`, and the flight consumes only
that snapshot — nothing re-reads the registry after keying. Filing this under the
native component would have hidden it exactly when it matters, because that component
is `unused` without combos and the reproduction has no combos. A registry source
revision is also insufficient: the helper changes content without changing one.

Two exported Sets were investigated in the same round and deliberately excluded.
Nothing in this repository mutates `CALLABLE_CONFIGURED_COMPATIBILITY_MODELS`
(`src/codex/catalog/provider-fetch.ts:286`) or `JAWCODE_CATALOG_AUGMENT_PROVIDERS`
(`src/codex/catalog/parsing.ts:121`); each is a module-load literal with a single read
site. Treating them as authority would make every export authority. Freezing them is
optional defense in depth, not a prerequisite for this phase.

The native component is explicit `unused` when no combo needs native rows. Otherwise
the evidence owner captures a detached, deeply frozen ordered native slug/capability
snapshot and records every active-catalog/cache consultation, including absence, as
`native-catalog-selection`. The identity covers that exact snapshot and the immutable
revision identities of provider registry data, generated Jawcode metadata, and the
pinned upstream-model snapshot used during assembly. `provider-fetch.ts` consumes
this captured value; it may not call the current hidden native source path after the
flight is keyed. Today that path reaches `nativeOpenAiSlugs()` during combo assembly
(`src/codex/catalog/provider-fetch.ts:878-903`), and the owner can read active catalog
or cache while selecting slugs (`src/codex/catalog/metadata.ts:169-179`).

Relevant process-local flight input includes the settled runtime/bundled
epoch/value evidence and a per-provider immutable model-cache/cooldown snapshot with
its owner epoch and value identity. The latter controls whether discovery uses fresh,
stale, configured, or network data (`src/codex/catalog/provider-fetch.ts:517-560`),
so omitting it again treats absence of evidence as equality. It binds map admission
but is not added to K -> C revalidation because the producing flight itself may
advance that cache. Runtime/bundled evidence remains candidate-bound and
commit-revalidated exactly as already specified.

Round 6 makes both ownership and ordering executable. `model-cache.ts` replaces its
mutable `CacheEntry.models` with a private recursively deep-frozen clone and exposes
recursively readonly types. `setCached` clones every reachable object/array before
publication and retains no caller alias; `getFreshCached`, `getStaleCached`, and the
new flight-decision capture return detached recursively deep-frozen snapshots rather
than the private graph. The owner's process-lifetime epoch advances before every
result-affecting publication: every `setCached`, including a byte-identical
replacement; every `markModelsFetchFailure`; every state-changing provider/all clear;
every accepted reconciliation generation; and every budget eviction that removes an
entry. The epoch is monotonic and is not reset by test cleanup. Omitting any one of
those bumps is a contract failure, not an optimization.

The flight race is decided before the map, not repaired inside the promise. After the
exact config, effective auth, native-source, and runtime/bundled inputs are known,
gather takes one clock observation and synchronously asks the owner for an ordered
decision for every enabled provider: `unused`, `fresh-cache`, `cooldown`, or
`network`. Each used snapshot includes the detached fresh/stale models or explicit
absence, owner epoch, stored `fetchedAt`/`failureAt`, and exact
`freshUntil`/`cooldownUntil`. The authority owner computes its domain-separated keyed
value identity and the aggregate `modelCacheDecisionIdentity`; only then may code
consult `gatherInflight` (`src/codex/catalog/provider-fetch.ts:796-819`).

`gatherRoutedModelsUncached` receives those immutable decisions as arguments. Once a
flight has claimed a slot, its provider branches may not call `getFreshCached`,
`getStaleCached`, or `isModelsFetchCoolingDown`; even a network-failure fallback uses
the stale/absence value sealed before lookup. A success or failure may mutate the
owner through `setCached`/`markModelsFetchFailure`, which advances the epoch and makes
a later admission distinct. Time passage itself does not bump the epoch: crossing
`freshUntil` or `cooldownUntil` changes the effective decision and therefore its keyed
identity, so a post-boundary caller cannot join a pre-boundary flight even when the
stored value and owner epoch are unchanged. Calls captured on the same side of the
same boundary may still coalesce.

The fourth-cache audit found no additional mutable process-local input to catalog
model selection. `gatherInflight` is the coordination map being keyed, while
`lastDropWarnSignature`, combo warning signatures, and the last-omission sink affect
logging or retain an output copy; the flight result uses its own local omissions and
none of those maps is read to choose models
(`src/codex/catalog/provider-fetch.ts:108-110,273-281,821-852`,
`src/codex/catalog/aggregation.ts:39-69,238-244`). Discovery-status/live-count maps
likewise feed management status, not provider model selection. If any such side map
becomes a gather input later, it must join the pre-lookup immutable authority capture
and owner-epoch rule before that change lands.

No raw API key, OAuth token, secret header, auth-store buffer, or stable plain digest
is a field of the identity. Only opaque process-keyed HMAC values and the opaque
config-reference token leave the authority owner, and none may be logged, serialized,
or projected into `CatalogDisposition`. Copying `apiKey` into the old fingerprint,
using plain SHA-256, or exporting the HMAC key is forbidden: all three create a
credential-bearing or offline-guessable structure.
The private candidate may retain the existing exact-buffer source digest solely for
K -> C revalidation of `provider-auth-selection`; the flight owner HMACs that
observation as input and never exposes the plain digest as a key, result, log, or
response.

The in-flight map stores an entry containing the deep-frozen authority plus its
promise, bucketed by `authorityId`; it is no longer `Map<string, Promise<...>>`.
Component equality is checked before joining, so even a forced bucket collision does
not share. The flight receives the captured authority inputs and returns
`{ authority, models, comboOmissions }`. Each caller compares the returned authority
to its own admission before candidate construction. A mismatch discards the result
and returns retryable stale or regathers within `deadlineMs`; no candidate, K permit,
or filesystem write follows. This second check is mandatory defense in depth, not an
optimization delegated to the map key.

### A2 — seal the closed role-bearing source observations

`captureCatalogAdmissionSnapshot(config)` remains the pre-gather constructor. Before
accepting any derived path it records the raw environment/default selector, canonical
`CODEX_HOME`, and root identity as required `homeSelection`. Its source evidence starts
with every conditional role key present as an empty list and the required
`catalog-target-selection` observation for the logical
`$CODEX_HOME/config.toml` path, recorded PRESENT or ABSENT. The opaque
filesystem-evidence session then records every consulted filesystem source under
the contract's closed role union: bundled template, active merge, hashed/legacy
fallback, models-cache fallback, native-catalog selection, runtime selection, or
provider-auth selection. Callers cannot append, omit, remove, or rebuild those
observations.

The required ABSENT state closes a target-selection hole that a present-file digest
list cannot represent. `readCodexCatalogPath()` chooses the default catalog exactly
when `config.toml` is absent (`src/codex/catalog/parsing.ts:167-176`). If that file
appears after gather with `model_catalog_json` selecting another target, no digest of
any previously present file changes; without the required absence observation the
obsolete default target could be overwritten and reported `committed`. Therefore
`config.toml` is always observed with role `catalog-target-selection`, and either
PRESENT -> ABSENT or ABSENT -> PRESENT is `stale` before any write.

For a PRESENT source, the evidence owner reads once and hashes the **same exact
buffer** it returns. For an ABSENT source, it records the logical path, canonical
missing-leaf path, stable canonical-parent identity, and `fileIdentity:null`.
Alternatives consulted and found absent are still evidence because their absence
caused fallback. Process-local caches and network responses are not fabricated as
filesystem observations; used runtime/bundled values instead contribute sealed
`CatalogProcessLocalEvidence`. The candidate receives deeply frozen source/process
evidence and detached snapshots with no mutable alias back to either memo owner.
Missing `homeSelection`, a required role or conditional key, a required
runtime-selection PRESENT/ABSENT observation, or a used epoch/value identity is
structurally invalid and cannot reach commit.

Immediately before the first replacement, the under-K-and-C commit callback re-reads
the raw/default home selector, re-runs the production home resolver, compares selector,
canonical root, root identity, and every re-derived config/catalog/cache/backup target,
then re-observes every candidate-bound source and revalidates each used runtime/bundled
epoch/value identity. It compares source state, logical/canonical path, parent identity,
file identity, and PRESENT digest. Home/target/source/process-local drift returns
`stale`; unreadable, unresolvable, non-regular, or ambiguous evidence returns `refused`.
Both paths write zero bytes. This detects the audited same-inode
truncate/rewrite even when config generation and target identity are unchanged. It
catches single-direction drift only: content/state A→B→A returning identical
evidence before comparison, parent A→B→A between checks, and a write after the final
comparison remain outside C17 (`005_contract.md:830-943`).

### A3 — preserve bundled-first template precedence

`loadCatalogForSync` keeps its current default-path branch: obtain the bundled
catalog first and clone it as the native template; read the on-disk catalog
separately as the merge source. The invariant is explicit at
`structure/03_catalog-and-subagents.md:23-27` and implemented at
`src/codex/catalog/bundled.ts:474-483` plus
`src/codex/catalog/sync.ts:517-523`.

The WP9 edit removes the materializing fallback call from the tail of
`loadCatalogForSync`; it does not move catalog/backup/cache ahead of an already
available matching bundled template. Gather may clone a matching in-memory bundled
catalog but may not refill that cache. A cold cache falls through to filesystem
sources observed by the evidence owner; no usable native template yields
`catalog-unavailable`. Existing explicit materialization and probing callers remain
outside the 16 management paths until their owning phase migrates them.

### A4 — candidate ownership

The candidate remains opaque, one-shot, and catalog-private. Its `WeakMap` state
contains prepared bytes, result/notices, target identities, the admitted config
generation, home selection, sealed candidate-bound `CatalogSourceEvidence`, and
sealed `CatalogProcessLocalEvidence`, plus the complete deep-frozen
`CatalogGatherAuthorityIdentity` returned by the flight. Candidate construction first
requires exact equality with the caller's expected authority; mismatch returns
retryable stale without constructing the candidate. Memo-derived graphs are
recursively frozen detached snapshots and cannot alias the owners' private caches.
The authority equality includes the ordered pre-lookup provider cache/cooldown
decisions, but commit does not revalidate their epoch because the producing flight is
allowed to advance that owner while resolving; the result-authority equality is the
binding proof for this flight-only input.
Commit marks a successfully constructed candidate consumed before validation and
before the first write; a second call returns `candidate-consumed` and writes nothing.
No route can inspect, serialize, reconstruct, or replay it.

Only catalog-private outcomes are added here:

```ts
export interface CatalogWriteReceipt {
  readonly keyedBackup: "written" | "preserved" | "not-requested";
  readonly legacyBackup: "written" | "preserved" | "not-requested";
  readonly catalog: "written" | "not-written";
  readonly cache: "written" | "not-written";
}

export type CodexCatalogCommitResult =
  | { readonly kind: "committed"; readonly changed: boolean; readonly writes: CatalogWriteReceipt }
  | { readonly kind: "stale"; readonly reason: "generation" | "home-selection" | "source-observation" | "process-local" | "target-identity" | "candidate-consumed" }
  | { readonly kind: "refused"; readonly reason: "source-unreadable" | "source-ambiguous" | "target-unsafe" }
  | { readonly kind: "failed"; readonly surface: "disk"; readonly writes: CatalogWriteReceipt };
```

`convergence.ts` projects those private variants into the contract's existing
`CatalogDisposition`; routes never switch on this union.

## B. Fixed synchronous commit

Preparation returns exact catalog/cache bytes and optional create-once backup bytes.
`internal/catalog-writer.ts` accepts only that prepared value and synchronous
filesystem dependencies. It accepts no config, provider client, parser, subprocess,
OAuth resolver, Promise, or callback that can return a Promise.

The outer catalog orchestration acquires K after evidence-bound gather and before any
config transaction. Automatic catalog convergence retries fail-fast K acquisition only
within `deadlineMs`; each attempt and the complete owner-held callback remain
synchronous. Every successful acquisition mints a fresh private permit and transaction
identity, registers the exact permit object as active for canonical `CODEX_HOME`, and
passes it only to that callback. Compile-time permit requirements remain a reachability
guard, not proof of lock ownership: every low-level mutator must call K's owning
module's runtime assertion with the permit and canonical owning home before its first
filesystem mutation. The assertion rejects an unregistered, inactive, revoked,
previous-transaction, forged, or wrong-home object. K's module-private registry is not
exported or inspected by the writer. In `finally`, K revokes the permit before it
commits/rolls back and releases the SQLite transaction, including callback-throw paths.
One live permit may authorize the fixed sequence inside its own callback and nothing
afterward. Catalog convergence and retained `/api/sync` use evidence-bound
precomputation; startup cache invalidation, CLI `sync-cache`, and native restore instead
acquire K before authoritative read and recompute under K. Public signatures do not
change. Catalog convergence commit performs, in order:

1. acquire K after N when N exists; WP9 catalog-only has no N and therefore starts at
   K. Once K is held, mark the candidate consumed and call
   `withExpectedConfigGenerationSync(candidate.generation, commitCallback)` to enter C;
2. inside K -> C, re-resolve home selection and every derived target, validate target
   identity, re-observe every sealed PRESENT/ABSENT source, and revalidate each used
   process-local epoch/value identity immediately before the first write;
3. publish the keyed backup with atomic no-clobber semantics using K's permit;
4. publish the legacy backup with atomic no-clobber semantics when the default path
   requests it;
5. replace the active catalog;
6. replace the models cache; then return from the synchronous callback so the owner
   can release C and then K.

The owner-side guard is not a read-before-write check. Its implementation validates
the expected generation using the `configMutationDatabase` handle whose SQLite
transaction is already held, invokes the complete synchronous catalog callback on a
match, and releases only after the callback returns
(`005_contract.md:631-647,676-743`). A cooperating config writer therefore cannot
commit N+1 between validation and catalog publication. Conflict never invokes the
callback; lock/database unavailability projects through the total adapter.

Do not wrap `readConfigGeneration`, `readConfigGenerationAtPath`, or the new
observe-only reader inside `withConfigMutationLockSync`. Those observers open a
second SQLite connection; while the first connection owns `BEGIN IMMEDIATE`, the
second connection contends with its own caller instead of validating it. The guard
must use `readConfigGenerationInTransaction` or its private equivalent on the
already-held database. WP9 composes permanent K with the existing config mutation
lock; it does not import WP11's native lock, and catalog-only work does not bump config
generation. No callback holding C may acquire K, no K callback may acquire N, and no
catalog path acquires H.

Receipt fields change only after the corresponding replacement succeeds. A failure
returns the exact prefix receipt and consumes the candidate; callers must regather.
There is no rollback claim.

Target identity remains strict except for one create-once rule. Backup publication
creates and hardens a unique adjacent temp, then uses an operation whose contract is
destination-must-not-exist: exclusive hard link or a platform
rename-without-replace equivalent. Ordinary overwrite rename is never a fallback.
The existing `atomicWriteFile` cannot implement this contract because its final
operation is an overwriting rename (`src/config.ts:192-245`, especially line 213).
The unpublished temp is scrubbed and removed on every path.

If publication returns `EEXIST`, another process won after validation. Commit
resolves and validates that winner under stable parent/file identity. A readable,
regular, non-routed valid catalog backup is preserved and the receipt becomes
`preserved`; malformed, unreadable, routed, symlinked, or identity-ambiguous content
is `refused`. The loser never unlinks, truncates, or overwrites the winner. This
exception applies only to a backup create-once target, never to a backup selected as
a gather source; selected source observations remain strict
(`005_contract.md:1087-1107`).

## C. Catalog-only convergence

### C1 — consume the WP8b seams

WP9 does not redeclare request, snapshot, projection, or shared result types.
`management-convergence.ts` consumes:

- `createCatalogConvergeRequest` from
  `src/codex/catalog-admission.ts:40-53`;
- `captureCatalogAdmissionSnapshot` from
  `src/codex/catalog-admission.ts:138-179`;
- `projectCatalogOnlyOutcome` from its landed owner at
  `src/codex/management-convergence.ts:63-75`;
- shared `CatalogDisposition`, `ConvergeOutcome`, and `ConvergeCodex` from
  `convergence-types.ts`.

The placeholder factory body at `src/codex/management-convergence.ts:81-96` is
replaced in place. It validates catalog scope without throwing, captures admission,
awaits the write-free gather, acquires K, enters
`withExpectedConfigGenerationSync`, executes the synchronous catalog callback before
C and K release, and projects the result. The
lower-level orchestration lives in new `convergence.ts`, so only that module reaches
`internal/catalog-writer.ts` from the 16 management-mutation paths; the four explicit
transitional chains remain the only WP9 exceptions. The retained management module
remains the factory boundary until WP12 consolidates the full funnel.

### C2 — permanent K plus owner-held generation and complete candidate evidence

A `scope:"catalog"` commit does not request `CommitExpectation`, open
`transition-state.ts`, call `beginCodexTransition`, call `assertPublished`, or read
or advance `{nativeGeneration,currentTxId}`. Its `catalog-only` outcome correctly
has no pair fields (`src/codex/convergence-types.ts:207-224`).

Catalog staleness is guarded by:

- the complete non-secret-bearing gather-authority identity, checked both before
  joining a flight and again between the result and candidate construction, so a
  shared promise can never erase the admitted config generation/reference, effective
  auth, native/source snapshot, or relevant process-local inputs that produced it;
- permanent effective-user/canonical-`CODEX_HOME` serialization K, held across every
  catalog/backup/cache authoritative transaction by convergence and all four
  transitional roots, using either under-K recomputation or complete post-acquisition
  evidence revalidation;
- a fresh acquisition-bound permit whose module-private registry liveness,
  transaction identity, and owning-home binding every low-level mutator asserts at
  runtime before its first filesystem mutation, then revokes before K release;
- the observe-only config generation captured before gather and validated by
  `withExpectedConfigGenerationSync` on its already-held transaction through the
  complete synchronous commit;
- required raw/default catalog-home selection, canonical root identity, and equality
  of every target re-derived under K -> C;
- candidate-bound closed PRESENT/ABSENT source observations, including required
  `config.toml` target selection and mandatory runtime-selection evidence whenever
  runtime identity influenced the candidate;
- used runtime/bundled process-cache epochs and recursively frozen, non-aliased value
  identities whose private owner snapshots are never returned directly;
- target parent/file identity plus the narrow create-once backup exception.

The commit must never import or invoke routing writers. A test fails if catalog-only
work changes `config.toml`, generated profile, journal, transition row, or history.

### C3 — total, non-throwing management adapter

Delete `refreshCodexCatalogBestEffort` from
`src/server/management-api.ts:105-113` and its context field at
`src/server/management/context.ts:68`. Replace the dependency with a factory seam
for `createManagementConvergeCodex(config)` and expose one context adapter such as
`convergeCodexCatalog(): Promise<CatalogDisposition>`.

That adapter is total. One outer `try/catch` covers request construction, lazy
dynamic import, missing export, factory construction, admission, gather, commit,
projection, and malformed/unexpected outcomes. Expected private results map
directly. The adapter tracks whether commit began and the commit function catches
every expected replacement failure into a receipt, so even an unexpected throw has
a conservative typed projection:

| Internal condition | `CatalogDisposition` projection |
|---|---|
| gather admission or K acquisition busy/deadline | `skipped/busy`, retryable |
| no usable catalog source | `skipped/catalog-unavailable` |
| config/home/target/source/process-evidence refusal | `skipped/refused` |
| generation, home, source, process-local, or identity drift | `skipped/stale`, retryable |
| provider auth/network gather failure | matching `failed` reason, `phase:"gather"`, `partialWrite:false` |
| lazy import, missing export, factory, or unexpected pre-commit failure | sanitized `failed/disk`, `phase:"gather"`, `partialWrite:false` |
| expected replacement failure | `failed/disk`, `phase:"commit"`, `partialWrite` derived from the receipt |
| unexpected throw after commit begins | `failed/disk`, `phase:"commit"`, `partialWrite:true` (fail closed) |

No raw message, provider, token, path, or digest reaches the response. The route
dispatcher may continue to rethrow unrelated errors at
`src/server/management-api.ts:150-163`; no catalog error escapes to it.

The lazy binding is cached only after factory construction succeeds. A failed lazy
import/factory remains retryable on a later mutation instead of caching a broken
closure. The factory closure itself is also total, including wrong-scope input.

Each current await becomes one adapter call and appends its returned disposition.
The complete invocation set remains provider 6
(`src/server/management/provider-routes.ts:147,338,487,512,527,546`), model 6
(`src/server/management/model-routes.ts:214,313,352,390,404,440`), combo 2
(`src/server/management/combo-routes.ts:198,216`), and agent settings 2
(`src/server/management/agent-settings-routes.ts:280,525`).

Order is part of compatibility:

- `/api/v2` keeps its intentional Codex config writes before catalog convergence
  (`src/server/management/agent-settings-routes.ts:230-280`);
- combo update keeps save/reconcile/cooldown work, then convergence, then optional
  Claude definition sync (`src/server/management/combo-routes.ts:188-200`);
- `/api/subagent-models` keeps save, convergence, Claude sync, Desktop apply, response
  (`src/server/management/agent-settings-routes.ts:518-528`).

Therefore “no additional writes” is asserted around the convergence call itself,
not around the whole route. Route tests separately assert the existing primary and
follow-up writes still execute in their original order after every committed,
skipped, refused, failed, lazy-import-failed, and factory-failed disposition.

## D. WP9 reachability, bounded honestly

WP9's C14 claim is only that the 16 management mutation sites no longer reach
`refreshCodexCatalogBestEffort` or catalog writers and instead pass through the
catalog-scoped `ConvergeCodex`. It does **not** claim that `convergence.ts` is the
repository's sole catalog writer root yet.

The symbol-graph test permits these exact legacy roots until WP12:

| Legacy root | Current path | WP12 removal |
|---|---|---|
| management `POST /api/sync` | `src/server/management/config-routes.ts:261-268` → `src/codex/sync.ts:83-90` → `src/codex/refresh.ts:40-52` → evidence-bound pre-K provider gather (`src/codex/catalog/sync.ts:513-526`) → K → complete evidence revalidation → catalog/cache writers | rewire to full convergence and `toSyncResponse`; K remains |
| server startup cache invalidation | `src/server/index.ts:403` → K → authoritative catalog/cache read and derivation in `src/codex/catalog/sync.ts:603-612` → models-cache writer | route startup through full convergence/observer; K remains |
| `ocx sync-cache` | `src/cli/index.ts:849-855` → K → authoritative catalog/cache read and derivation in `src/codex/catalog/sync.ts:603-612` → models-cache writer | route CLI command through full convergence; K remains |
| native restore | `src/codex/inject.ts:764-774` → K → authoritative backup/catalog read and derivation in `src/codex/catalog/sync.ts:573-595` → catalog writer | move restore writes behind full convergence/provenance; K remains |

The allowlist is exact by root module and writer symbol, not a directory wildcard.
WP12 owns deleting every row. No new legacy root may be added in WP9.

`tests/codex-convergence-contract.test.ts` is created with a TypeScript-resolved,
symbol-granular graph: static imports, literal dynamic imports, path aliases,
re-exports, renamed imports, namespace property access, and wrappers all preserve
the writer symbol identity. An unresolved module, unresolved symbol, computed
dynamic import, or non-literal import that could hide a writer fails the test rather
than being skipped. The test publishes the WP9 legacy allowlist as data and proves
all 16 management roots terminate at `convergence.ts` before a catalog writer.
It also proves every catalog/backup/cache mutator requires K's permit and reaches K's
runtime assertion before any filesystem mutator. Separate runtime tests prove that
assertion rejects leaked/reused/forged/wrong-home permits; the graph alone is not lock-
liveness proof. Lock-order fixtures reject `C -> K`, `K -> N`, or held `N -> H`
acquisition edges through aliases, wrappers, or re-exports.

## Tests

### T1 — gather really performs no filesystem write

Run admission plus gather in a child process with fresh `mktemp -d` values for
`OPENCODEX_HOME`, `CODEX_HOME`, any config/runtime home, and a dedicated process temp
root wired through `TMPDIR`, `TMP`, and `TEMP`. Before admission, capture a recursive
manifest of every isolated root: relative path, kind, regular-file SHA-256, size,
mode, nanosecond mtime where available, and symlink target. Compare it after gather.

Start recursive filesystem event journals for every isolated root **before calling
`captureCatalogAdmissionSnapshot`** and stop them only after gather settles. Fail on
create/delete/rename/write/metadata events so a temp file created and deleted within
the interval is visible; the before/after manifest is corroboration, not the only
proof. Prove the harness is non-vacuous with controls that (a) chmod an existing file
and (b) create then delete a temp file; both must fail. Inject throw-on-call executable
hooks for `mkdtempSync`, runtime probing, `execFileSync`/subprocess launch, runtime
persistence, OAuth refresh/persist/intent, ownership registration, generation
initialization, backup creation, and atomic replacement. Reset and separately assert
the permitted process-local caches changed only within their bounded owners.

Broken mutations that must turn T1 red: call `resolveCodexRuntime` on a cold cache,
call `runCodexDebugModels`/`loadBundledCodexCatalog`, replace observe-only runtime
resolution with `resolveAndPersistCodexRuntime`, use `loadAuthStore`, or use
`readConfigGeneration`. The executable spy or pre-admission event journal detects the
subprocess, created-then-deleted probe home, mkdir, chmod, backup, SQLite, ownership,
or other transient write.

### T2 — K, home/cache/source evidence, generation, and identity reject before write

Start with the round-5 live-flight authority matrix. In isolated temporary homes,
pause request A after generation N with `authMode:"forward"` has claimed flight F.
Persist N+1 with `authMode:"key"` and an API key, capture B from the new exact config
reference, and resume. B must claim a distinct flight or reject A's result as
retryable stale; B must never construct or commit A's empty result. Force the two
entries into one primary bucket and require the result-carried component comparison to
reject A even when key routing is wrong. The named broken mutation **restore the
legacy `providerCatalogFingerprint`/`gatherFlightKey` and remove result-authority
validation** must reproduce the audited `fetchCount:0, a:[], b:[]` failure.

Repeat with config and generation unchanged while A is live, but replace the exact
OAuth-store observation so another active account/token is selected. B must capture a
different `provider-auth-selection` and `authSnapshotIdentity`, run separately or
reject A, and never commit A's rows. The named broken mutation **omit OAuth source
observation plus effective token bytes from the auth HMAC input** must turn this test
red. Repeat again with config/auth unchanged while the observed native catalog/cache
changes the ordered slug/capability snapshot used by combo resolution. B must not
accept A's native rows. The named broken mutation **omit
`native-catalog-selection`/`nativeCatalogSourceIdentity` from the map and result
identity** must turn this test red.

Repeat once more with config, auth and native sources all unchanged while A is live,
and change only the effective discovery policy through the existing
`withRegistryDiscovery` helper — the reachable mutation path, not a synthetic one.
B must capture a different `discoveryPolicyIdentity`, claim its own flight or reject
A's result as stale, and must never accept rows its own `maxModels`/filter would have
rejected. Pair it with the control the audit used: the same override with no
concurrent flight returns the fallback and warns about the row limit, which is what
makes the joined result recognizably wrong rather than merely different. The named
broken mutations that must turn this red are **file discovery policy under the native
component** (it is `unused` without combos, and this case has none) and **key the
snapshot by a registry source revision instead of its content** (the helper mutates
the entry in place without moving any revision).

One more row, because every case above asks whether B may join A and none asks what A
itself does after it wins. Round 8 found a real post-await reread:
`augmentRoutedModelsWithRegistryOpenAiApiRows` calls `providerMatchesRegistryTransport`
and reads the registry entry after the network await
(`src/codex/catalog/provider-fetch.ts:955-961`). The reviewer captured A under
`withRegistryDiscovery` with a custom `openai-apikey` destination and
`preserveCustomDestination: true`, paused the response, let the helper restore the
registry, then resumed: A had captured `match:false` but processed under the restored
`match:true` and emitted the full trusted OpenAI row set. So an implementation can key
correctly, carry its authority honestly, and still commit bytes from a policy it never
admitted — while passing every join-focused row above.

Drive that exact sequence and assert A uses its captured non-match and adds no trusted
OpenAI rows, with post-lookup registry reads instrumented to fail. The named broken
mutation is **let post-key processing consult the live registry instead of the
captured match and detached augmentation inputs**.

Each row verifies the private identity inside the owner-level unit fixture, while
instrumented production log/response/serialization sinks receive neither that
identity nor the API key, OAuth token, configured secret header, auth-store bytes, or
their plain SHA-256 values. The named privacy mutation
**put `apiKey`, header values, token text, or a stable unkeyed credential digest into
the fingerprint/identity** must fail those behavioral sink assertions. Round 6
verified that `bun run privacy:scan` still passes against the current plain auth-store
digest, so the scanner remains a supplemental hygiene gate and is not proof of this
non-disclosure property.

Add the model-cache owner/flight matrix with one fake clock and the real public owner
APIs. Seed nested models through `setCached`, mutate the caller's original nested
object/array, then attempt the same through `getFreshCached` and `getStaleCached`.
The owner snapshot and a second read remain byte-identical and recursively frozen.
The named broken mutation **retain the `setCached` array or return the private cache
graph** must change the second read without any assignment/epoch and turn this row red.

Pause A after its per-provider decision is captured and before its flight settles.
Run separate rows for byte-identical `setCached`, `markModelsFetchFailure`, provider
and all-cache clear, accepted reconciliation, and real budget eviction. Each mutation
must advance the owner epoch, change B's decision/value identity, and prevent B from
joining or accepting A. The named broken mutations **omit the set bump for an equal
replacement**, **omit the failure/cooldown bump**, **omit the clear bump**, **omit the
reconcile bump**, and **omit the eviction bump** each make exactly their row red. The
harness observes the epoch immediately around each owner call so a later mutation
cannot accidentally mask a missing bump; omitting ANY required bump therefore fails.

Finally capture one A immediately before a cache TTL boundary and one immediately
before a cooldown boundary, advance the fake clock across exactly that boundary with
no owner mutation, and capture B. B's effective decision changes to `network`, its
identity differs, and it cannot join A. Instrument the flight body so every
post-lookup call to `getFreshCached`, `getStaleCached`, or
`isModelsFetchCoolingDown` fails the test. The named broken mutation **key only epoch
and stored value, then decide or re-read freshness/cooldown after claiming the
flight** turns both boundary rows red.

Table-drive every `CatalogSourceRole`: required config target selection,
filesystem-backed bundled-template source, active catalog, selected hashed backup,
selected legacy backup, models-cache fallback, native-catalog source, runtime-state
source, auth-store source, and every consulted absent alternative. Gather at config
generation N, truncate and
rewrite a PRESENT selected source **in place** so file identity and generation remain
the same, then commit. Expect `stale` and byte-identical targets. Repeat PRESENT ->
ABSENT and ABSENT -> PRESENT. In the required target-selection case, gather with
`config.toml` absent, then create it with `model_catalog_json` selecting another
catalog; expect `stale` and byte-identical old/new targets. Make each re-observation
unreadable/ambiguous and expect `refused` with zero writes. Retarget one parent and
expect target-identity rejection. Compile fixtures that omit
`required["catalog-target-selection"]` or any conditional role key; each must fail,
while the complete shape compiles. Additional compile/private-validation fixtures omit
`homeSelection`, a runtime-influenced candidate's PRESENT-or-ABSENT
`runtime-selection`, and a used process memo's epoch/value identity; each incomplete
shape must fail before commit, while the complete shape compiles.

Create real temporary homes A and B and set the raw selector to a `current` symlink
initially targeting A. Gather from `A/a.json`, retarget `current` once to B while
leaving every A file unchanged, then commit. Under K -> C the implementation must
re-read the raw selector, re-run `activeCodexHome`, compare canonical home/root
identity, re-derive config/default-catalog/cache/backup/configured targets, and return
`stale` with zero writes in either home. The named broken mutation is **retain only
A's resolved config/source evidence and skip home re-resolution**; it incorrectly
commits into A while Codex reads B.

Freeze the current target-selection semantics with three real-file fixtures
(`src/codex/catalog/parsing.ts:52-80`, `src/config.ts:125-164,192-213`):

- relative `model_catalog_json = "nested/a.json"` resolves beneath the canonical
  `CODEX_HOME`, and gather/commit compare and write that derived target. The named
  broken mutation **resolve the relative value from cwd** writes the wrong file.
- an absolute configured target outside `CODEX_HOME` stays that exact absolute target;
  the named broken mutation **force every configured target under CODEX_HOME** either
  refuses valid current behavior or writes the wrong file.
- an existing catalog leaf symlink is resolved to its real target and survives an
  atomic write through that target. The named broken mutation **rename over the
  logical symlink leaf** replaces the link or writes the wrong entry. This accepted
  active-catalog behavior does not weaken T3's refusal of a symlinked create-once
  backup winner.

Warm runtime R1 and bundled template B1, gather a candidate that consumes both, then
pause provider gathering and replace/invalidate each memo. Commit must revalidate the
monotonic epoch and immutable value identity under K -> C and return `stale` with zero
writes, including invalidate-and-repopulate with byte-identical data. Obtain runtime
and bundled-cache values through their real public read APIs, let gather seal them,
then attempt nested object and array mutation through the returned graphs. The private
owner snapshot and candidate evidence remain byte-identical because the detached clone
or immutable view is recursively frozen; a top-level-only freeze is insufficient. If
the fixture instead uses the supported explicit owner mutation seam, that operation
must advance the epoch and commit must return `stale` before any write. Keep the
current detached/deep-freeze regression at `tests/codex-runtime.test.ts:138-148`; any
fixture that intentionally changes owner state uses the owner seam. Separately gather
from warm R1 while
`codex-runtime.json` is observed ABSENT, create persisted R2 without advancing config
generation, and require `stale` with zero writes; repeat PRESENT replacement and
removal. The named broken mutations are **compare cache bytes without the epoch**,
**return the private cache object or only shallow-freeze it**, and **record runtime-
selection only on cold loads**; they respectively accept byte-identical replacement,
allow nested mutation without assignment/epoch movement so stale commit succeeds, or
accept ABSENT -> PRESENT on a warm hit.

Prove the cooperating-writer guarantee with two real processes and the real config
mutation API. Process A enters
`withExpectedConfigGenerationSync({value:N}, callback)`; callback entry proves
validation matched and pauses while the config transaction is still held. Process B
then attempts a real persisted config mutation. Because the existing lock is
fail-fast (`src/config.ts:1790-1839`), B's first attempt must report lock/busy and must
not commit N+1 while A is paused. A's synchronous catalog bytes land before callback
return; after A releases, B retries through the real mutation API and commits N+1.
Conflict never invokes the callback. Instrument SQLite connection creation and
require the guard to validate through the already-held handle, with no second
connection.

Add a distinct two-process K barrier using the **real retained management
`POST /api/sync` chain**, not a writer stub or direct permit helper. Process A gathers
catalog X, acquires K then C, completes generation/home/source/process-local/target
validation, and pauses immediately before its first replacement. Process B sends a
real `Request` through `handleManagementAPI` for `POST /api/sync`, reaches
`refreshCodexModelCatalog`, and prepares Y. While A is
paused B must not replace catalog or cache. After A releases, B may follow its retained
no-write/failure path or retry and publish Y; the forbidden trace is Y then X with A
reporting `committed`. Reverse acquisition order: let B publish Y while holding K,
then require A to revalidate after acquiring K and return `stale` with zero writes.
Run the same K-exclusion shape for startup cache invalidation, CLI `sync-cache`, and
native restore.

Add the round-4 direction separately. Retained `/api/sync` process A reads X and starts
its slow provider gather before owning K. Convergence process B then acquires K and
publishes Y; only afterward may A resume and acquire K second. A must revalidate all
pre-K source/process evidence and discard/regather or follow its existing no-write/
failure result path, never replace Y with X-derived bytes. Repeat with another retained
`/api/sync` process B as the K-first publisher so retained-vs-retained is tested
independently of convergence. For startup invalidation, CLI `sync-cache`, and native
restore, instrument the authoritative read and prove it cannot start before K; pause
after that read and prove a convergence or retained writer cannot publish until the
complete read-transform-write releases K. The named broken mutation is **move only the
replacement under K while retaining the authoritative read before K**; it permits the
forbidden X-read -> Y-publish -> X-derived-overwrite trace even though every rename
holds K.

Exercise the runtime permit boundary against real temporary targets. Leak a permit and
call a mutator after its callback; reuse that revoked permit during a later K
acquisition for the same home; forge an object through a cast plus prototype/symbol
copying; and pass a still-live home-A permit to a home-B mutator. Each attempt must be
refused before temp creation, hardening, unlink, link, rename, truncate, or replacement,
with byte-identical targets. A fresh permit may authorize all fixed writes inside its
own live callback. The named broken mutations are **assert only the compile-time permit
shape**, **omit revocation before K release**, or **omit the owning-home comparison**;
the leaked/reused, forged, or wrong-home attempt respectively reaches the mutation spy.

Document but do not claim detection for content A→B→A returning exact A before the
comparison, parent A→B→A entirely between checks, or a write after the comparison.

Broken mutations that must turn T2 red, in addition to the named mutations above:
omit the required ABSENT config observation, remove digest comparison while retaining
generation/file identity, release C before callback, acquire C before K, call
`readConfigGenerationAtPath` from inside the guard, remove the low-level mutator's
runtime permit assertion, return/retain a mutable model-cache alias, omit any required
model-cache owner-epoch bump, capture cache/cooldown after map lookup, or omit the
effective TTL/cooldown boundary from its decision identity. The absent->present target switch commits obsolete bytes,
the same-inode rewrite commits stale bytes, process B commits N+1 while A is paused,
retained-gathered X overwrites K-published Y, a leaked/forged/wrong-home permit reaches
filesystem mutation, a post-mutation/boundary caller joins the wrong provider flight,
inverse order deadlocks/self-contends, or the guard opens the forbidden second handle.

### T3 — exact four-step receipt and bytes

Inject failure immediately before each replacement and assert both receipt and real
target bytes:

| Failure before | Expected completed prefix | Required byte state |
|---|---|---|
| keyed backup | none | all four targets retain pre-image |
| legacy backup | keyed only | keyed has candidate bytes; legacy/catalog/cache retain pre-image |
| catalog | keyed + legacy | both backups have candidate bytes; catalog/cache retain pre-image |
| cache | keyed + legacy + catalog | backups/catalog have candidate bytes; cache retains pre-image |

Every row also proves the candidate is consumed and a second commit writes nothing.
Repeat backup absent→present with a valid non-routed backup and expect `preserved`;
repeat with malformed, unreadable, routed, symlinked, and ambiguous appearing backups
and expect refusal before any replacement.

The ordinary absent→present setup above remains useful but is not the no-clobber race
proof: it creates the backup before commit and would pass a broken
check-absent-then-overwriting-rename implementation. Add a publication barrier after
target/source validation and immediately before the exclusive publish operation.
While process A's hardened temp waits at that barrier, process B atomically creates
the destination and signals A to continue. A must receive `EEXIST`, validate and
preserve B's exact bytes, report `preserved`, and never call ordinary rename or
`atomicWriteFile`. Race two valid publishers from ABSENT and require exactly one
winner. Repeat the interleaving with malformed, unreadable, routed, symlinked, and
identity-ambiguous winners; A refuses without changing winner bytes and always
scrubs its unpublished temp.

Broken mutations that must turn T3 red: set a receipt bit before replacement, catch a
failed replacement and continue, or replace exclusive publication with
check-absent-then-`atomicWriteFile`. Receipt/bytes diverge in a prefix row, or process
A overwrites process B's after-validation winner instead of preserving it.

### T4 — total adapter and route ordering

Drive all 16 real routes with a factory spy and assert reference equality with the
exact config passed to `handleManagementAPI`, one fixed request created by
`createCatalogConvergeRequest`, original 2xx/201, and additive
`catalogRefresh`. Table-drive lazy-import rejection, missing export, throwing factory,
generation unavailable, gather auth/network failure, stale/refused commit, disk
failure before each replacement, and malformed result. None may throw or skip later
work.

Scope the routing-write spies to the convergence call itself. Separately record route
events and assert the original order for `/api/v2`, combo update, and
`/api/subagent-models`, including Claude/Desktop follow-ups after every catalog
disposition.

Broken mutation that must turn T4 red: remove the adapter's outer catch; a lazy-import
or snapshot error reaches the dispatcher, changes the persisted-success route to 500,
and the event log lacks later Claude/Desktop calls.

### T5 — lazy loading and reachability

For laziness, launch a child process that registers a Bun module-load sentinel for
the canonical `src/codex/management-convergence.ts`, imports management API, and
drives only non-refresh routes. The sentinel must remain zero; a second child drives
one catalog mutation and observes one initialization. A route-level “zero calls” spy
alone is not accepted because an eager static import would pass it.

For reachability, run the symbol graph described in D. It must accept only the four
legacy writer rows and reject aliases, re-exports, wrappers, or dynamic imports from
any new root. The same symbol-resolved graph inventories gather filesystem
consultations: every `readFileSync`, `Bun.file`, `existsSync` branch, target
`lstat`/`stat`/`realpath`, or wrapper that reaches one must terminate at
`catalog/filesystem-evidence.ts`. That includes native slug selection: direct
`nativeOpenAiSlugs()` reachability from a keyed flight is forbidden unless its
catalog/cache reads consume the authority-captured evidence session.
Unresolved/computed edges fail closed.
At both the `wp9-transitional` and future `wp12-final` inventory versions, every
catalog/backup/cache mutation must require K's permit and call K's runtime assertion
before its first filesystem mutation. Lock-order fixtures fail on `C -> K`, `K -> N`,
and a held `N -> H`; the accepted full order is N -> K -> C, while WP9 catalog-only
uses K -> C because it never acquires N.

Broken mutations that must turn T5 red: add a static top-level management-convergence
import, alias a catalog writer into a management route, replace a literal import with
a computed dynamic import, or add an absence-only `existsSync`/target `realpath`
outside the evidence owner. Also restore a bare-promise flight map, let the flight
re-resolve auth/native/model-cache decisions after keying, remove the permit parameter from one mutator, add a
fifth unpermitted root, bypass the permit assertion before one filesystem mutator, or
invert any lock edge. The sentinel, compile fixture, or fail-closed graph must reject
each; T2, not the graph, rejects a permit whose runtime lifetime/home is invalid.

### T6 — precedence and native-pair exclusion

On the default catalog path, pre-populate the process-local bundled cache with a
template that differs visibly from catalog/backup/cache plus an on-disk
routed/user-native row. Gather must use cached bundled native template fields and
preserve the on-disk merge row without probing or launching Codex, while recording
the bundled epoch/value identity and the runtime-selection file observation required
by the runtime that selected it. Repeat cold: no
bundled cache plus a valid observed disk fallback succeeds without subprocess; no
bundled cache and no valid disk fallback returns `catalog-unavailable`. Assert no
materialized fallback write. Snapshot the transition row before and after committed,
stale, refused, and failed catalog-only attempts; it must be byte/field identical and
no history schedule appears. Routing artifact and executable-probe spies stay zero.

Broken mutations that must turn T6 red: move disk fallbacks ahead of a populated
bundled cache, call `loadBundledCodexCatalog` to refill a cold cache, request
`CommitExpectation`, omit warm-cache evidence, or call a routing writer.
Template/cold-miss assertions, executable spies, transition-row equality, or routing
spies fail.

## Verification

Static/focused gates for the WP9 commit:

```bash
bun test tests/codex-refresh.test.ts tests/codex-convergence-contract.test.ts
bun test tests/codex-catalog.test.ts tests/app-owned-memory.test.ts tests/gather-routed-models-single-flight.test.ts
bun test tests/codex-config-generation.test.ts tests/codex-sync-api.test.ts tests/codex-models-cache-invalidate.test.ts tests/codex-runtime.test.ts
bun test tests/model-visibility-management-api.test.ts tests/management-provider-validation.test.ts tests/combo-management-api.test.ts tests/codex-v2-gate.test.ts
bun run typecheck
bun run test
bun run privacy:scan
bun --cwd docs-site run build
```

T1 proves admission/gather launches no runtime probe or subprocess. Any unrelated
runtime fixture retained by the broader suites uses temporary homes and child
processes only. No verification invokes `ocx start`, `stop`, `sync`, `restore`,
`ensure`, any `ocx service` command, or the live proxy on port 10100.

## Accept criteria

| Criterion | Proof | Concrete broken mutation that makes it red |
|---|---|---|
| **C1** — gather is filesystem-write-free across user homes and scratch, performs no executable probe/subprocess, and commit is synchronous, fixed, K -> C ordered, one-shot, and receipt-exact | T1 + T3 + T5 | call cold `resolveCodexRuntime`/`loadBundledCodexCatalog`, add an `await` beneath commit, acquire C before K, reorder replacements, pre-set a receipt bit, or replay a consumed candidate |
| **C2/C17** — complete gather-authority identity prevents or rejects cross-admission flight reuse across config/auth/discovery-policy/native/source/process drift without exposing credentials, and a winning flight consumes only its captured snapshots through the whole post-await tail; provider model-cache/cooldown decisions are detached, deeply immutable, owner-epoch-bound, effective-boundary-bound, and captured before flight lookup; permanent K makes every first-party authoritative read-transform-write fresh by under-K recomputation or complete post-acquisition evidence revalidation; retained-gathered-first/K-second races are covered against convergence and another retained writer; owner-held config generation, required home/runtime evidence, deeply frozen non-aliased memo snapshots plus epochs, every closed PRESENT/ABSENT source observation, and target identity reject stale work before write; create-once backups publish atomically without clobber | T2 + T3 | restore partial `gatherFlightKey` plus a bare result, omit OAuth/native authority components, file effective discovery policy under the combo-gated native component or key it by a registry source revision rather than its content, let post-key processing consult the live registry instead of the captured match and detached augmentation inputs, put raw or plain-hashed credentials in the identity, decide/re-read model-cache or cooldown after flight lookup, omit any owner epoch bump or TTL/cooldown boundary identity, leave retained `/api/sync`'s `onDiskCatalog` read before K but guard only replacement, start startup/CLI/restore's authoritative read before K, return or shallow-freeze a private cache snapshot so nested mutation bypasses epoch movement, omit ABSENT `config.toml`/`codex-runtime.json`, skip CODEX_HOME re-resolution, release C before callback, remove same-inode digest comparison, open a second SQLite observer, or replace exclusive publication with overwriting rename |
| **Catalog/native boundary** — catalog-only never reads/advances the native pair or writes routing/history artifacts | T6 | call `expectation()`/`beginTransition`, add pair fields to `catalog-only`, or invoke config/profile/journal/history writer |
| **Best-effort compatibility** — all 16 primary writes retain 2xx/201 and original follow-up order for every catalog failure | T4 | let lazy import/factory/admission throw, scope “zero writes” to the whole route, or return before Claude/Desktop follow-up |
| **C14, WP9-bounded** — the 16 management roots reach catalog writers only through convergence; exactly four documented transitional roots remain until WP12; every low-level mutation requires permanent K's fresh acquisition-bound permit and runtime liveness/transaction/home assertion | T2 barriers + permit negatives + T5 symbol graph | add a fifth root, omit K/permit/assertion from one retained chain, accept a leaked/reused/forged/wrong-home permit, hide a writer through alias/re-export/computed import, or accidentally require WP12 to have already rewired `/api/sync`/startup/CLI/restore |
| **N2** — WP9 replaces the landed placeholder, consumes existing request/snapshot/projection seams, creates permanent K and its resolver plus the contract test, and typechecks without WP10-WP12 | focused tests + typecheck | move K into WP8b/WP11, redefine a WP8b type/helper, refer to a nonexistent later helper, leave a throwing placeholder, or claim the absent test file is merely extended |
