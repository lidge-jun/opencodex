# 030 — state-store eviction mechanisms

Date: 2026-08-01  
Work phase: wp4  
Depends on: none  
Binding inputs: `000_state_store_inventory.md` §§4–6, `005_impl_roadmap.md` locked decision 3 and store-by-store lock, `006_roadmap_audit_synthesis.md` R1-2/R1-5/S2-5/S3-2.

## Outcome

Apply exactly three mechanisms, selected per store rather than by convenience:

1. exact clock-TTL sweep where current getters already treat an expired row as absent;
2. config/account-generation reconciliation where a key is owned by the current configuration;
3. admission or owner-specific release where a live resource cannot be evicted safely.

Live keys keep their current behavior. Warning memos and Codex quota rows never gain a
TTL. Windows ACL successes are removed only for the actual renamed temp path. Retained
diagnostic values are byte-normalized at admission in 035, not swept by time.

## Shared lifecycle utility

### NEW `src/lib/state-store-sweeper.ts`

```ts
export const STATE_SWEEP_INTERVAL_MS = 60_000;

export interface GenerationContext {
  generation: number;
  providerNames: ReadonlySet<string>;
  comboIds: ReadonlySet<string>;
  comboTargets: ReadonlySet<string>;
  codexAccountIds: ReadonlySet<string>;
  oauthAccountKeys: ReadonlySet<string>;
  configRoots: ReadonlySet<string>;
}
export interface StateStoreRegistration {
  name: string;
  sweepExpired?: (now: number) => number;
  sweepLiveness?: () => number;
  reconcileGeneration?: (context: GenerationContext) => number;
}
export interface StateSweepResult { storesVisited: number; rowsRemoved: number }

export function registerStateStore(registration: StateStoreRegistration): () => void;
export function sweepExpired(now?: number): StateSweepResult;
export function sweepExpiredOnWrite(now?: number): StateSweepResult;
export function sweepLiveness(): StateSweepResult;
export function captureConfigGeneration(): number;
export function setGenerationContextBuilder(build: () => GenerationContext): void;
export function reconcileStateGeneration(context: GenerationContext): StateSweepResult;
export function startStateStoreSweeper(options?: StateStoreSweeperOptions): { stop(): void };
export function stopStateStoreSweeper(): void;

export interface StateStoreSweeperOptions {
  /** Override the 60 s interval (tests only; production uses the default). */
  intervalMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}
```

Registration names are static and unique; replacement does not duplicate callbacks.
`startStateStoreSweeper()` replaces the prior singleton, creates one 60-second interval,
and invokes `unref?.()`. Each timer tick runs exact-TTL callbacks followed by bounded
owner-specific liveness callbacks. One callback failure logs only the static registration
name and does not stop later callbacks. `sweepExpiredOnWrite()` runs only TTL callbacks,
synchronously after a successful owner write; it creates no promise tail and performs no
PID probes. Reconciliation never runs from the clock timer.

Start the singleton beside the watchdog in `src/server/index.ts:300-316` (the current
watchdog call is `startMemoryWatchdog()` at `:306`); stop it in
`drainAndShutdown()` at `src/server/lifecycle.ts:70-95`. If side-effect registration
would create an import cycle, add explicit wiring in NEW
`src/lib/state-store-registrations.ts`; do not add a generic helper module.

### Generation protocol and stale-writer fence (wp4 A-gate B1/B2 — locked)

- **Canonical owner:** the sweeper module owns a single monotonic
  `configGeneration` counter, initial value 0 (pre-first-reconcile state is
  generation 0 and is never reconciled against — a reconcile requires a
  COMPLETE context). `captureConfigGeneration()` returns the generation a store
  writer carries from key selection/flight admission through completion. The
  "config generation beside the loaded-config owner"
  wording in the locked table above is SUPERSEDED by this section (round-2
  blocker 4): there is exactly ONE counter and the sweeper owns it; config.ts
  merely calls the trigger.
- **Context construction:** `buildGenerationContext()` lives in
  `state-store-registrations.ts` and reads each owner's CURRENT authoritative
  set through owner exports. Exact canonical forms are locked:
  - `providerNames` is the exact own-property names in `config.providers`;
  - `comboIds` is the exact own-property ids in `config.combos`;
  - `comboTargets` is `${comboId}::${targetKey(target)}`, where
    `targetKey(target)` is exactly `src/combos/types.ts:48-50`'s
    `${target.provider}/${target.model}`. Thus target `a/m1` in combo `free`
    is `free::a/m1`; validated ids/providers/models cannot make `::` ambiguous;
  - `codexAccountIds` contains raw stable account ids. Added accounts retain
    their configured ids; the main account uses the literal
    `MAIN_CODEX_ACCOUNT_ID` value `__main__` whenever the canonical OpenAI
    forward provider remains configured and enabled, including while it needs
    reauth, so safety state is not mistaken for a deleted account;
  - `oauthAccountKeys` is `${provider}\0${accountId}`, exactly matching
    `src/providers/quota.ts:300-302`. Guardian's
    `oauth:${provider}:${accountId}` and other owner-local strings are parsed
    by their owner and compared as this canonical pair; the coordinator never
    manufactures owner-local keys;
  - `configRoots` contains canonical roots supplied by config-ownership.
  The combos owner supplies `comboTargets` via a typed topology export; other
  owners likewise expose typed live-set exports rather than private map keys.
  All reads take the SERVER's long-lived config
  object (the `1256/1649` doctrine: an ad-hoc `loadConfig()` snapshot must
  not be used — absence in a transient snapshot does not prove not-live;
  round-2 blocker 5). The context is built ONCE per reconcile, synchronously
  in a single microtask after the triggering commit is VISIBLE ON the live
  server config object (whether the trigger replaced it or mutated it in
  place — see the three trigger shapes below), so every owner read observes
  the same committed state, then stamped with the attempt's unique
  `candidateGeneration` (see §Failure semantics — `++attemptSequence`, not
  `configGeneration + 1`).
- **Trigger sites (exact, round-4 blocker 5):** the trigger is "the LIVE
  server config object now reflects a committed topology change", which in
  this codebase happens through THREE distinct shapes, each of which calls
  `reconcileStateGeneration(buildGenerationContext())` AFTER its mutation is
  visible on the live object:
  1. Initial server startup, after `serverConfig` is captured
     (server/index.ts:256) and registrations are wired.
  2. Management routes that mutate the live object IN PLACE (combo/provider/
     account routes, e.g. combo-routes.ts:133/207): the route handler calls
     the trigger after its in-place mutation + successful `saveConfig()`.
     `saveConfig()` itself is NOT a trigger — it merely persists its argument
     (config.ts:1543) and cannot know whether that argument is the live
     object or an ad-hoc snapshot.
  3. OAuth flows that load-modify-save a SEPARATE snapshot (oauth/index.ts:
     765): these are NOT triggers at save time. Their changes become
     reconciliation-relevant only when adopted into live server state, which
     happens through the existing `reconcileOAuthProviders`/account-refresh
     path on the live object — THAT adoption site calls the trigger. An
     ad-hoc snapshot save with no live adoption never reconciles (correct:
     the live topology has not changed).
  `buildGenerationContext()` reads ONLY the live server config object and
  owner registries — never a `loadConfig()` snapshot. Never from the timer.
- **Failure semantics:** each successful owner atomically records its current
  live-key set/topology and `lastReconciledGeneration`. If a callback throws,
  log the static registration name, leave that owner on its prior generation,
  and schedule ONE retry on the next `sweepExpiredOnWrite` tick (retry uses a
  freshly built context — stale contexts are never reused).
  To make that retry executable, the sweeper stores the CONTEXT BUILDER, not
  a context: `setGenerationContextBuilder(build: () => GenerationContext)` is
  called once from `state-store-registrations.ts`; the retry invokes it
  fresh (round-2 blocker 4).
  A reconciliation attempt stamps its complete context with
  `candidateGeneration = ++attemptSequence` — a SEPARATE monotonic attempt
  counter that never resets and never reuses a value (round-4 blocker 2:
  deriving candidates from `configGeneration + 1` lets two different attempts
  share a candidate after an interleaved config change, so an owner stamped
  by attempt 1 would wrongly reject attempt 2's replacement and keep an
  obsolete live set). Every attempt therefore carries a unique generation;
  owners ALWAYS accept a context whose candidate is strictly greater than
  their `lastReconciledGeneration` and replace their live set wholesale.
  Successful owners retain the candidate stamp; the global `configGeneration`
  advances to the attempt's candidate only when every callback succeeds. On
  partial failure, writers captured from the still-current global generation
  compare stale against any owner already stamped with the candidate, and the
  fresh retry (a NEW attempt with a NEW higher candidate) completes or
  re-replaces every owner without reusing an old context.
  Partial reconciliation is deletion-only: a failed callback leaves extra
  rows but never deletes a live key.
- **Combo topology reconciliation:** remove a whole selection row when its
  `comboId` is absent. For a still-live combo, remove each `currentWeights`
  member whose `${comboId}::${targetKey}` is absent from `comboTargets`, while
  preserving surviving weights, target order, and the active target/successes
  when that active target remains live.
- **Late-completion fence (round-2 blocker 2):** each affected writer captures
  `writerGeneration` before work begins. At retained-state commit,
  `writerGeneration < lastReconciledGeneration` is stale. A stale write is
  accepted when its exact key remains in the owner's current live set, but is
  DROPPED when absent; old work cannot resurrect a deleted key, while live-key
  writes retain current behavior. The fence never detaches or cancels an
  accepted request/flight: it gates only its completion write.
- **Registration timing:** owner modules register at module scope through
  `state-store-registrations.ts`, which is imported by `server/index.ts`
  before `startStateStoreSweeper()`; a registration arriving after a
  reconcile simply joins the next one (no catch-up replay).

## Locked store-by-store table

The inventory shorthand `catalog/*` resolves to `src/codex/catalog/*` in this checkout.

| Store and current anchor | Locked mechanism | Diff-level owner change |
|---|---|---|
| Subagent `modelHealth`, `src/codex/subagent-model-fallback.ts:35-42,160-171,229-248` | TTL sweep | Export `sweepExpiredSubagentModelHealth(now)`; delete `unavailableUntil <= now`; invoke write sweep after `modelHealth.set`; never touch `quotaPrimedAt.global`. |
| Combo cooldown, `src/combos/failover.ts:5-19,40-77` | TTL sweep | Export/register `sweepExpiredComboTargetCooldowns(now)` and preserve every live Retry-After row. |
| API-key cooldown, `src/providers/key-failover.ts:17-53,89-130,174-190` | TTL sweep | Delete only `cooldownUntil <= now`; keep key ordering and current exact-key lazy cleanup. |
| Anthropic health, `src/oauth/anthropic-routing.ts:34-40,96-123` | TTL sweep | Export a health sweep using the same semantic deadline as `isCooled`; affinity at `:234-241` remains its existing 2,000/24 h LRU. |
| XAI permanent-failure verdicts, `src/oauth/index.ts:54-61,326-327` | TTL sweep | Globally delete the same 30-second-expired verdicts that `cached()` already treats as absent; S3-2 forbids reconciliation-only handling. |
| Warning memos, `src/codex/catalog/provider-fetch.ts:219`, `src/codex/catalog/aggregation.ts:37-39,281-283`, `src/router.ts:154-180`, `src/combos/request.ts:4-38`, `src/config.ts:435,2052-2053` | Reconciliation only | Clear/rebuild only after a complete new config generation. No TTL: time expiry would re-emit intentionally suppressed warnings. |
| Codex quota, `src/codex/quota.ts:15-27,51,261-326` | Reconciliation only | Remove accounts absent from current account generation and persist the reduced map. The 6 h rule is hydration admission, not live expiry. |
| Provider quota history, `src/providers/quota.ts:52-61,195-239,278-342` | Reconciliation plus admission | Remove dead provider/account keys; cap distinct live flights in 035; never detach an accepted flight. Capture generation at probe admission and fence retained cache writes at `:259,324,389-401`; a late deleted-account result returns to its caller but is not retained. |
| Codex routing health, `src/codex/routing.ts:85-138,209-243` | Reconciliation | Remove account-wide and quota-scope rows only for deleted accounts; preserve live Retry-After and probe generation. Capture generation with routed account selection and fence health writes at `:230-237,349-562,1225-1404`; late outcomes for a deleted account do not recreate health. |
| Model-cache history, `src/codex/model-cache.ts:42-56,114-147` | Reconciliation | Add `reconcileModelCacheProviders(validProviders)` covering cache, failure, status, and live-count maps atomically. |
| Pool rotation, `src/codex/pool-rotation.ts:6-12,44-80,180-185` | Reconciliation | Remove deleted pool/account rows while preserving current sticky/RR weights. |
| Combo rotation, `src/combos/resolve.ts:13-20,85-105,161-167` | Reconciliation | Remove deleted combo ids and `currentWeights` targets absent from `comboTargets`; preserve current target order and surviving sticky/RR state. Capture generation at pick/state creation and fence writes at `:54-65,85-105,120-167`. |
| Guardian backoff, `src/oauth/token-guardian.ts:54-99,118-225` | Reconciliation | Remove deleted provider/account rows; keep a configured revoked account at its current backoff. Capture generation when each task is admitted and fence retained backoff writes at `:90-99,137-148,186-218`. |
| Reauth state, `src/codex/account-runtime-state.ts:1-13` plus OAuth account maps | Reconciliation | Remove only keys absent after a successful persisted account mutation. Auth work captures generation before dispatch; fence `markAccountNeedsReauth` at `account-runtime-state.ts:3-5` and equivalent OAuth writes so late failures for deleted accounts are dropped. |
| GCP ADC, `src/lib/gcp-adc.ts:61-66,83-127,274-302` | Reconciliation plus admission | Remove source fingerprints absent from the authoritative ADC source set; cap active source flights in 035; retain current expiry-on-resolve. Capture generation with `expectedSource` and fence `tokenCache.set(source, ...)` at `:273-295`; an old-source flight still resolves to its caller but is not retained. |
| Config ownership, `src/lib/config-ownership.ts:79-87,233-258` | Reconciliation | Remove a root only when absent from manifest/current roots and no owned path references it. Never infer inactivity from age. |
| Config warnings, `src/config.ts:435,2052-2053` | Reconciliation only | Warning rows follow complete config generation; never TTL-expire them. |
| PID command-line memo, `src/config.ts:2112-2121` | Liveness-based owner release | Export/register `sweepDeadOcxStartProcessCache(maxProbes = 64)`. Each timer tick probes at most 64 cached PIDs with `process.kill(pid, 0)`: delete only on `ESRCH`; retain on success, `EPERM`, or unknown errors. Advance a round-robin cursor over a key snapshot so maps larger than 64 receive eventual coverage. Never config-reconcile this owner and never probe it from write-trigger sweeps. |
| OAuth login/abort/manual maps, `src/oauth/index.ts:823-904,939-1020` | Reconciliation plus admission | Remove dead provider/account generations; 035 caps flows/probes and pending-code bytes; never evict an in-progress owner. |
| Active turns/sockets/workers/slots | Admission only | Implement the hard caps and coherent busy responses in 035; do not register an accepted owner and later sweep it away. |

Each owner exports a semantic sweep/reconcile function. The coordinator passes complete
sets; it must not recreate owner-local key strings. The single `configGeneration` counter
lives in the sweeper (§Generation protocol supersedes earlier drafts of this paragraph);
the trigger sites are exactly the three shapes in §Generation protocol (startup capture,
in-place management-route commits after successful save, and OAuth live-adoption sites —
`saveConfig()` alone is never a trigger). Failed parse/save and speculative routing do
not advance it.

## Windows ACL delete-after-rename contract

### Coverage expansion (wp4 A-gate blocker 1 — every hardened temp producer)

The two config-writer sites are NOT the only producers of hardened ephemeral
temp paths. Every producer below hardens a unique temp and must forget its
memo entry only after a CONFIRMED unlink/rename; a failed removal retains the
memo (fail-closed):

| Producer | Anchors | Temp lifecycle |
|---|---|---|
| Config atomic writers | config.ts:96-113, 174-197 | temp → rename to config |
| OpenAI migration backups | config.ts:331, 368, 380 | backup temps |
| Response spill store (NEW in wp2) | spill-store.ts:231, 237 (harden), 248 (unlink) | per-spill temp |
| Tray atomic replacement | tray/windows.ts:222, 227, 230 | icon/state temp |
| Management-token publication | server/management-auth.ts:82, 92, 111 | token temp |

Implementation shape: the single `forgetHardenedSecretPath(path)` export specified below in
`windows-secret-acl.ts` invoked by each producer's cleanup path (post-rename
and post-unlink), so the memo store stays bounded by the number of LIVE temps
rather than growing one entry per write. Regression coverage per producer:
spill, tray, backup, and management-auth each prove the memo entry disappears
after the temp is gone and is RETAINED when removal fails. wp2/wp4 are
file-disjoint but share this store — the spill-store change is a one-line
cleanup-hook call, inside wp4's write set by this amendment.

Current anchors:

- `src/lib/windows-secret-acl.ts:37-40` retains directory/file success paths and timeout keys.
- `src/lib/windows-secret-acl.ts:363-367` permits a destination key only for timeout memoization.
- `src/lib/windows-secret-acl.ts:375-455` adds the actual `targetPath` after successful `icacls`.
- `src/config.ts:96-113,174-197` hardens unique `*.ocx.<pid>.<seq>.tmp` files, then renames them.

Add:

```ts
export function forgetHardenedSecretPath(targetPath: string): void {
  hardenedPaths.delete(targetPath);
}
export function hardenedSecretPathCountForTests(): number;
```

For both atomic writers the order is fixed:

```ts
io.harden(tmp);                 // memo belongs to this exact temp
io.rename(tmp, path);           // durable destination replacement
forgetHardenedSecretPath(tmp);  // only after successful rename
```

After a failed transaction, forget the success memo only after that exact temp has been
unlinked. If a hardened residual remains, keep its memo until removal. Never add the
destination to `hardenedPaths`, never reuse one temp's success for the next temp, and
never clear `timedOutPaths[destination]` on rename.

This code protects credential/config files and requires explicit security review under
`AGENTS.md`/`MAINTAINERS.md`. The security reviewer must specifically attest that, after
a prior **successful** temp harden and rename, the second temp for one destination executes
`icacls` again and real permission/`icacls` failures remain fail-closed. Preserve the
existing timeout-only exception: a destination-keyed timeout memo may skip `icacls` for a
later temp and returns `ok:false`; it must never enter or masquerade as the success memo.

## Diagnostic values: classification, not a clock sweep

Crash trace strings at `src/lib/crash-guard.ts:206-245`, debug lines/subscribers at
`src/lib/debug-log-buffer.ts:3-35`, injection lines at
`src/lib/injection-debug-log.ts:10-27`, Claude metadata at
`src/claude/inbound-debug.ts:40-106`, fixed breadcrumbs at
`src/lib/sidecar-tracker.ts:10-48`, and affinity components at
`src/codex/routing.ts:105-109,624-688` / `src/oauth/anthropic-routing.ts:34-40,234-241`
have no expiry semantics. They therefore use mechanism 3: 035's UTF-8 byte admission
and truncation marker. Do not register them with `sweepExpired()` and do not truncate
tool JSON, credential values, or route keys into ambiguous identities.

## Regression cases

Add `tests/state-store-sweeper.test.ts`:

- `global fake-clock sweep visits every registered TTL owner once`
- `expiry boundary removes expired rows and preserves live rows`
- `one throwing owner does not block later sweep owners`
- `write-trigger uses the same callbacks without creating a queue`
- `timer start is singleton unrefed and stop is idempotent`
- `reconciliation runs only for a newer complete generation`
- `stale or duplicate generation cannot delete current keys`
- `live combo keeps surviving weights while a removed target weight is reconciled`
- `late old-generation completion cannot resurrect a deleted key but can update a still-live key`
- `PID liveness sweep probes at most 64 rotates coverage keeps live EPERM and unknown rows and deletes only ESRCH`

Extend nearest owner suites with:

- `subagent health sweep removes expired untouched model keys`
- `combo and API-key sweeps preserve live Retry-After rows`
- `Anthropic health and XAI verdict sweeps use their exact semantic deadlines`
- `warning reconciliation never expires a current-generation warning by time`
- `Codex quota reconciliation ignores row age and removes only deleted accounts`
- `model-cache reconciliation removes all four maps for one deleted provider`
- `pool combo guardian GCP ownership and reauth reconciliation preserve current keys`
- `provider quota GCP guardian routing combo and reauth late completions obey the generation fence`

Extend `tests/windows-secret-acl.test.ts` and the atomic-writer cases in
`tests/config.test.ts`:

- `second atomic temp for the same destination is hardened again`
- `rename success forgets only the actual temp success memo`
- `destination timeout memo never vouches for a new temp`
- `destination timeout memo preserves the existing ok:false no-retry contract`
- `failed unlink retains the residual temp success memo`
- `later successful residual cleanup forgets that exact memo`.

Verification:

```bash
bun test tests/state-store-sweeper.test.ts tests/windows-secret-acl.test.ts tests/config.test.ts
bun run typecheck
bun run test
bun run privacy:scan
```

## Explicitly not changed

- No TTL for warning memos or live Codex quota rows.
- No deletion of live Retry-After, accepted resources/flights, current sticky state,
  last-good models, or configured guardian backoff.
- No process-wide accounting interface; 030 provides sweeping only.
- No provider event semantics, `#820` scheduler architecture, destination-level ACL
  success memo, or fail-open hardening behavior.

## wp4 A-gate freshness audit (HEAD `0d1fa7dd5`, 2026-08-01)

All listed store anchors remain current after wp2/wp3; no landing moved or redefined the
named maps. The server start/stop seams and both atomic writers also remain at the anchors
above. The Windows wording/test list now distinguishes a forgotten success memo from the
existing destination-keyed timeout-only `ok:false` memo.

All three blockers are accepted and resolved in the locked design above:

1. `comboTargets` carries exact `comboId::provider/model` topology, with canonical
   main-Codex and OAuth account-key forms; partial target removal is executable.
2. Per-owner `lastReconciledGeneration` plus captured writer generations prevent old
   completions from resurrecting deleted keys while preserving accepted flights and live keys.
3. `ocxStartProcessCache` is owner-released by a bounded round-robin liveness sweep that
   deletes only `process.kill(pid, 0)` `ESRCH` proofs and is outside config reconciliation.

**wp4 A-gate verdict: PASS.**
