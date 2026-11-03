# 261102 Codex pool affinity persistence — 080 consolidated implementation spec

Single source of truth for implementation. Consolidates 010-070 and the round-7 residuals; where they differ, this file wins.
Issue: https://github.com/lidge-jun/opencodex/issues/8091. Follow-up (ownership manifest race): https://github.com/lidge-jun/opencodex/issues/8093.
Security-sensitive (MAINTAINERS.md): a dedicated Terra security review runs before the PR and its verdict goes in the PR description.

## 1. Problem

Codex pool pins (`threadAccountMap`) and conversation-state issuers (`conversationStateIssuerMap`) in `src/codex/routing/thread-affinity.ts`
are in memory only, and the key they use is `codexConversationKeyFor()` in `src/codex/lineage.ts`, an HMAC under a per-process random secret.
A restart re-places every conversation (round-robin moves most of them: cold prompt cache) and loses the issuer that triggers the
account-change scrub (carried encrypted state can fail with `invalid_encrypted_content`).

## 2. Contract

- A pin survives a graceful proxy restart for up to 24 h idle when the request's cohort anchor is derivable from its headers: every request
  with `session-id` (Codex CLI/App roots and subagents) and session-less requests anchored on their immediate parent. Deeper session-less
  chains, keys first derived under another config home, legacy raw-parent keys and keys whose anchor was evicted are memory-only.
- Pins whose account is gone, re-logged (new `quotaHistoryIdentity`), legacy (no identity) or expired are dropped: normal selection.
  Usability (pause, reauth, cooldown, plan/model exclusion, transient hold) stays with the existing resolver (`resolveCodexAccountForThread`, src/codex/routing.ts:498).
- `__main__` pins and `__main__` issuers are not persisted.
- A crash, a failed final flush, or a poisoned store makes the next owner discard every row (fail closed).
- Only the process holding the state directory's single-writer lease (`src/lib/spend-ledger-owner.ts`, acquired by `startServer`) persists.
  A server in another process on the same home is refused by that lease; servers in the same process share it (reference-counted).

## 3. Security posture

- `CODEX_LINEAGE_KEY` and every value derived from it stay process-local and unchanged: pin/issuer map keys, `authCtx.affinityKey`,
  `_cursorClientThreadId` (request-prepare.ts:417,563; cursor request-builder.ts:385; advisor state.ts:213 derives its own hash from it),
  compact's issuer binding key (compact.ts:1684), lineage scope keys, affinity-debug tags (own key, ADR-0089). Request-log lanes use their
  own digest of raw headers. Previous-response replay is keyed by response ids (implementer cites file:line in the PR). None changes.
- New durable artifact: `<configHome>/codex-affinity.sqlite` (0600, Windows ACL via `hardenSecretPath`). It holds a 32-byte store secret
  (`meta.secret`), rows keyed by `HMAC-SHA256(secret, "opencodex/codex-affinity/conversation/v1\0" + anchor)` (issuers: `.../issuer/v1`),
  opaque pool account ids, identity fences `sha256("opencodex/codex-affinity/identity/v1\0" + quotaHistoryIdentity)`, scopes and timestamps.
  No raw session/thread ids, no ephemeral keys, no tokens, no emails. Anyone who can read two copies of the file can link identical row keys
  and pool ids across restarts; the secret is needed only to test a guessed anchor. Never logged; warnings are identifier-free.

## 4. Modules and changes

### 4.1 `src/codex/lineage.ts`
- Add `setCodexConversationAnchorObserver(fn?: (key: string, anchor: string) => void)`; `codexConversationKeyFor` calls it after deriving
  (`anchor` = the family/thread value; for the cohort form both are the anchor). No new imports. Update the LIFETIME doc block: keys stay
  process-local; the affinity store persists only digests under its own secret.

### 4.2 `src/lib/spend-ledger-owner.ts`
- `onSpendLedgerOwnerReleasing(hook)`: in `release()`, after the per-lease `released` idempotence guard and the existing owner/refcount checks,
  when this is the final reference (`owner.references === 1`): set `releasing = true`; run each releasing hook in its own try/catch;
  clear `releasing` in `finally`; then continue exactly as today (decrement, null `activeOwner`, `boundLedgerHome = null`, release hooks,
  ROLLBACK/close, throw on rollback/close failure).
- While `releasing`, `acquireSpendLedgerOwner` and `mintSpendLedgerStorage` throw `SPEND_LEDGER_OWNER_NOT_HELD`.
- Optional neutral aliases (`mintStateDirectoryStorage`, `assertStateDirectoryStorageOwned`) with a doc comment; behavior identical.
- Tests: throwing releasing hook does not block release; repeated release is a no-op; first of two leases does not run hooks; acquire/mint inside
  a hook refused; existing `tests/lib/spend-ledger-owner.test.ts`, `tests/server/spend-ledger-owner-startup.test.ts` pass.

### 4.3 `src/lib/config-ownership.ts`
- Add `codex-affinity.sqlite`, `-journal`, `-wal`, `-shm` to `INITIAL_OWNED_PATHS` next to the `config-mutation.sqlite*` entries.

### 4.4 New `src/codex/routing/thread-affinity-store.ts`
Imports only `src/config/*`, `src/lib/*`, `bun:sqlite`, node builtins and the account-store reader (no routing value import cycle, no Lab).

Scope = (config home, owner generation, storage token). Created lazily on the first affinity access when `mintSpendLedgerStorage("codex-affinity.sqlite")`
succeeds and `isPassiveRead()` is false. A home change or generation change retires the scope (close handle, drop log/touches/anchors/consulted set)
and clears the live affinity maps (as the Claude store drops its rows on home change). The anchor observer resolves the active scope FIRST,
then records `anchorByKey` (LRU, 4096, 24 h TTL, refreshed per derivation). Passive calls do nothing (no open, observe, adopt, schedule, flush).

Open (synchronous; any failing step -> rollback/close, identifier-free warning, scope disabled for its lifetime. Earlier steps may already have
created the empty file or set its mode/ACL; for an unsupported version or shape the app makes no schema, metadata or row change, though SQLite's
own hot-journal recovery may still alter bytes):
1. `assertNotRealHomeUnderTest(home)` before anything else.
2. `recordOwnedConfigPath` for the db and its three sidecars (`-journal`, `-wal`, `-shm`); any `false` -> do not create.
3. `openSync(path, "wx", 0o600)` tolerating EEXIST; regular file, not a symlink, nlink 1, uid owner on POSIX; chmod 0600; `hardenSecretPath(path, {required:true})`; re-check.
4. `assertStorageOwned(token)`; `new Database(path)`; `PRAGMA busy_timeout = 0`; default rollback journal (no journal-mode change).
5. `BEGIN IMMEDIATE`; read `user_version` and `sqlite_master`. Empty v0 -> create schema v1, `meta.secret` (32 random bytes), `meta.clean = 0`.
   v1 with the exact expected tables -> if `meta.clean != 1`, DELETE all thread and issuer rows; set `meta.clean = 0`. Anything else -> ROLLBACK, close, disable.
   COMMIT. BUSY at any point is an anomaly under the lease -> disable.

Schema v1: `meta(name TEXT PRIMARY KEY, value BLOB)`; `threads(row_key TEXT, scope TEXT, account_id TEXT, fence TEXT, created_at INTEGER, last_used_at INTEGER, PRIMARY KEY(row_key, scope))`;
`issuers(row_key TEXT PRIMARY KEY, account_id TEXT, fence TEXT, last_used_at INTEGER)` (fence nullable).

Writes:
- Ordered structural log in call order: bind(rowKey, scope, accountId, fence, createdAt, lastUsedAt) = upsert; deleteScope; deleteKey;
  deleteAccountPins(accountId) (pins only; issuers kept, as today); issuerSet (upsert); issuerDelete; clearIssuers; clearAll. Only `clearAll`
  may drop earlier entries. Ops are logged only for keys with a known anchor in the scope (account-wide and clear ops always).
- Touch set (rows touched since the last flush) applied after the log in the same transaction. The timestamp is read from the LIVE in-memory entry
  AT FLUSH TIME, never captured when the touch is scheduled: the getter schedules the touch before `src/codex/routing.ts` mutates the returned entry
  (routing.ts:903-911), so a captured value would persist the old time and could expire an active pin. A touched row whose live entry is gone is skipped. Statement:
  `UPDATE ... SET last_used_at = max(last_used_at, ?) WHERE row_key=? AND scope=? AND account_id=? AND fence=?` (issuers: `account_id` and `fence IS ?`). Never inserts.
- Structural ops schedule a microtask flush; touches (same-account rebind, binding read, issuer peek) a 1 s unref'd timer. A binding read schedules a
  touch so the in-place `lastUsedAt` writes in `src/codex/routing.ts:911,942,985,1021` are captured (that file is at its size cap and is not edited).
- Flush = `assertStorageOwned(token)`, one `BEGIN IMMEDIATE` transaction: log, touches, prune (idle > 24 h or future-dated; newest 2048 per table ordered by
  `last_used_at DESC, row_key, scope`, model-detour scopes evicted first). Failure -> ROLLBACK, keep log, retry next flush. 3 consecutive failures or log
  > 16384 entries -> POISONED: drop log/touches, never write again, `clean` stays 0.
- Releasing hook (registered once via `onSpendLedgerOwnerReleasing`): if the scope is open and not poisoned, one transaction = log + touches + prune +
  `meta.clean = 1`. Transaction failure -> ROLLBACK (clean stays 0). Then close; a close error after a successful COMMIT leaves `clean = 1` committed
  (state is consistent: everything was committed) and is reported as an identifier-free warning. Retire the scope. `onSpendLedgerOwnerReleased` retires
  any scope still open (defensive). Late async work after release is memory-only and never reopens under the old token.

Reads (adoption):
- On a live-map miss for key K with a known anchor in an open scope: a pending delete/clear in the log covering rowKey(K) -> absent. Otherwise SELECT.
  Thread row valid when: not idle > 24 h, not future-dated, scope valid (`legacy`, a known `CodexQuotaScope`, or `model-detour:<base>:<model>` whose model
  passes the existing 512-byte component rule), account record has a credential, not deleted, current `quotaHistoryIdentity` fence equals the stored fence.
  Valid -> insert into `threadAccountMap` with the record's CURRENT generation, `lastReevalAt = now`, no transient fields, increment
  `threadAffinityEntryTotal`, run the existing LRU prune. Invalid -> log deleteScope.
- Issuer row: idle > 24 h or future-dated -> absent and log issuerDelete (time passes after the last flush prune, and the live issuer map also
  expires on peek, thread-affinity.ts:238,274). Otherwise fence equal -> issuer = account id; fence null or different -> `CODEX_UNKNOWN_CONVERSATION_STATE_ISSUER`.
- A bounded per-scope consulted set avoids re-querying; read errors are not cached.
- `getThreadAffinityScopes(K)` adopts all restored scopes for K first.

### 4.5 `src/codex/routing/thread-affinity.ts` (call-site hooks only; not the affinity log label)
- `ThreadAffinityEntry.identityFence?: string`, captured in `bindThreadAffinityForScope` from the same record read that supplies `generation`;
  kept by `handOffThreadAffinityGeneration`. Entries without a fence (legacy record, `__main__`) are memory-only.
- `rememberConversationStateIssuer(bindingKey, accountId, now?, credential?: { generation, chatgptAccountId })`: fence captured only when the record's current
  generation AND `credential.chatgptAccountId` match; else the row is fence-less (restores as unknown). `__main__` not persisted.
- Export `CODEX_UNKNOWN_CONVERSATION_STATE_ISSUER` (a string no account id can equal).
- Hooks in: scoped getters (adopt on miss; touch on hit), `getThreadAffinityScopes`, bind/delete/delete-for-account, `clearThreadAccountMapForAccount`,
  TTL/LRU prune, `handOffThreadAffinityGeneration`, issuer remember/peek/clear, `clearThreadAccountMap` (clearAll).
- Update the lifetime comments (issuer map, legacy adoption).

### 4.6 `src/server/responses/account-change-state.ts`
- `rememberServingConversationStateIssuer` passes `{ generation, chatgptAccountId }` for pool contexts.
- `applyAccountChangeConversationStateScrub`: unknown issuer counts as changed.
- `accountChangeFileReferenceRefusal`: unknown issuer ignored; refuse only for a known different issuer or a `priorAccountId` move.

### 4.7 Comment-only
`src/adapters/google-antigravity-wire.ts` comment about the process-random key: keep the meaning (the key still changes across restarts), adjust wording only if needed.

## 5. Reset and removal

| Entry point | Durable effect |
|---|---|
| `clearThreadAccountMap()` (config/provider/model/combo/agent-settings/logs-usage/oauth-account/shared management routes, server index) | clearAll |
| `clearConversationStateIssuerMap()` | clearIssuers |
| `clearThreadAccountMapForAccount(id)` (removal, auto-pause, plan exclusion, quota refusal, preservation) | deleteAccountPins (issuers kept) |
| account deleted/re-logged without a clear | fence fails on adoption -> row deleted |
| uninstall | owned paths removed (new homes always; existing homes subject to #8093) |

## 6. Tests

New file `tests/codex-integration/codex-affinity-restart.test.ts` (+ helper worker under `tests/helpers/` if needed); register in
`scripts/test-layout/layout.json` (near line 709) and `tests/fixtures/test-layout-expected.json` (near line 697). Lease tests may live in
`tests/lib/spend-ledger-owner.test.ts` if under its size cap, else a sibling file (registered). Cases:

1. Red-on-old: two fresh `bun` subprocesses on one temp home, each acquiring the lease, seeding two pool accounts with round-robin, resolving a
   session-bearing request via `resolveCodexAccountForThread` with `codexPoolAffinityKey(headers)`, recording the issuer, releasing. Process 2 advances
   the cursor so a fresh pick chooses the other account. Expect same account and known issuer (scrub not triggered for the same account; triggered for
   a different one). Old code (isolated `git archive origin/dev` export with the test + helper copied, only the optional store import caught) fails on
   the assertion; record output.
2. Fallbacks: removed, re-logged, legacy, expired, future -> normal selection, row deleted. Usability cases asserted against the resolver one by one.
3. `__main__`: pin and issuer not persisted.
4. Session-less depth-1 survives; depth-2 re-places; anchor eviction -> memory-only.
5. Reconciliation before first lookup: bind/delete/delete-for-account/issuer set/clear/clear-for-account on a key with a restored, unadopted row.
6. Fence races: re-login between bind and release; re-login between dispatch and issuer completion; owned refresh/handoff; Orca rotation; delete + re-add.
7. Unknown issuer with file references via responses and compact; `priorAccountId` retry still refuses; known different issuer still refuses.
8. Lease: not owned -> no file; release flush commits pending op and `clean = 1`; two leases -> only final release flushes; crash (kill subprocess) -> next owner
   restores nothing; poison (injected failures, overflow) -> next owner restores nothing; transaction failure in the releasing hook -> clean 0; close failure
   after commit -> rows restored; release + reacquire -> old token refused.
9. Database shape: unknown version/shape -> app makes no schema, metadata or row change (SQLite hot-journal recovery may still alter bytes) and disables; symlink/non-regular -> disabled; file 0600; INITIAL list has the four names;
   existing owned home records them; recording failure -> no db.
10. Bounds and privacy: > 2048 rows per table keeps newest; worst-case UTF-8 detour scope accepted; no raw ids/ephemeral keys in the db; warnings identifier-free.
    Touch timing: resolver reuse (which mutates `lastUsedAt` after the getter) then release and restart persists the NEW timestamp; an issuer row that
    expired or is future-dated at read time is treated as absent and deleted.
11. Home A -> B -> A, first B request, recorded lineage; passive calls with a populated db and a held lease.
12. Windows: start, use, stop, `removeTreeWithRetry` succeeds.

Existing suites to run: every test file using the affinity entry points or `startServer` + pool affinity (the round-1 audit counted 38), lineage tests,
`tests/responses/responses-account-change-scrub.test.ts`, `tests/responses/responses-4546-incident-regression.test.ts`, owner tests, config-ownership tests,
`tests/lab/core-lab-boundary.test.ts`, `tests/ci-workflows/test-home-guard.test.ts` (new writer refused before ownership init), file-size ratchet,
`tests/test-layout.test.ts`, `tests/test-layout-tooling.test.ts`.

## 7. Docs

- `structure/providers/openai-tiers.md`: lineage section (key stays process-local) + new "Durable Codex pool affinity" subsection (contract, file, schema,
  secret, fences, lease, clean flag, write log, touches, bounds, ownership residual #8093, tests).
- `structure/providers/openai-accounts.md`: only claims that pins are process-local (not the diagnostic tags or idle-window reservations).
- `structure/` owner of `src/lib/spend-ledger-owner.ts` (find via structure/manifest.json): document releasing hooks.
- docs-site: `reference/cli/providers-accounts.md` (~848) and `reference/configuration/providers.md` (`accountPoolStrategy` row) restart wording, in English
  and every locale copy (search per locale); build the docs site per docs-site/AGENTS.md.

## 8. Verification

Focused tests above, `bun run typecheck`, `bun run structure:check`, `bun run privacy:scan`, docs-site build, `bun scripts/test.ts --changed=dev --parallel=1`,
red-on-old recorded. PR gets `ci:full` (subprocess tests, docs, on-disk contracts).

## 9. Out of scope

`src/codex/routing/selection.ts` (Lane C), `src/codex/auth-context.ts` and the affinity log label (Lane D), `src/server/claude-*` and
`src/server/caller-session-identity.ts` (Lane A), `src/codex/routing.ts` and `src/server/index.ts` (size caps), the ownership API fix (#8093).
