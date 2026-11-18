# 261102 Codex pool affinity persistence — 020 plan revision (answers audit round 1 + coordinator note)

Supersedes the Design, Tests and Verification sections of 010_plan.md. Problem statement, docs list and out-of-scope
boundaries in 010 stay. Issue: https://github.com/lidge-jun/opencodex/issues/8091

## Security posture (coordinator note; security-sensitive per MAINTAINERS.md)

The existing conversation-key secret `CODEX_LINEAGE_KEY` in `src/codex/lineage.ts` STAYS process-local and unchanged.
Every consumer of the derived key `app:HMAC(CODEX_LINEAGE_KEY, anchor, anchor)` therefore reveals exactly what it reveals today:

| Consumer of the ephemeral key | Where | Changes? |
|---|---|---|
| `threadAccountMap` / `conversationStateIssuerMap` keys, pending release reasons | `src/codex/routing/thread-affinity.ts` (memory) | no |
| `authCtx.affinityKey` passed as `threadId` to routing | `src/codex/auth-context.ts`, `src/server/responses/core-codex-account.ts`, `passthrough-*.ts`, `src/providers/openai-sidecar.ts` (memory) | no |
| `_cursorClientThreadId` (Cursor adapter conversation id, advisor state) | `src/server/responses/request-prepare.ts:417,563`, `src/adapters/cursor/request-builder.ts:385`, `src/advisor/state.ts` | no |
| lineage scope `auth:HMAC(key, Authorization)` and records | `src/codex/lineage.ts` (memory) | no |
| debug capture tags | `src/codex/affinity-debug.ts` (own process-local key, ADR-0089) | no |
| request log / usage ledger lanes | `src/server/request-log-conversation.ts` — uses its own digest of raw headers, not the affinity key | no |

The ONLY new durable artifact is the snapshot. Its row keys are derived from a SEPARATE secret used for nothing else:
`rowKey = HMAC-SHA256(storeSecret, "opencodex/codex-affinity/conversation/v1\0" + anchor)` (hex), where `anchor` is the
cohort anchor already used by `codexConversationKeyFor(anchor, anchor)` (the session id, or the parent thread id for
session-less requests). Issuer rows use domain `.../issuer/v1`. The store secret never leaves the store module and the
snapshot file; it is not logged, not exposed by diagnostics or management APIs. What becomes linkable across restarts:
only that "the same anchor was bound to account X", and only to someone who can read both the private snapshot and the
private secret file (owner-only). Nothing written to logs gains cross-restart linkability.

## Design

### A. Store secret — inside `src/codex/routing/thread-affinity-store.ts`

- File `<configHome>/codex-affinity-key`, content `v1:<base64url 32 bytes>\n`, read with `readBoundedRegularFileSync(path, 128)`
  (rejects symlinks, junctions, non-regular files, oversize).
- States per config-home scope: `durable` (read valid file, or our exclusive create succeeded and re-read matches),
  `pending` (generated, publish in flight), `disabled` (publish failed, lost the exclusive race, file unreadable).
  **The snapshot is written only in state `durable`** (blocker 2): a process with an unpublished or losing key never touches
  `codex-affinity.json`. Exclusive-race loser: re-read the winner's key; if valid, adopt it before any row key is derived
  (rows are derived lazily at flush time from retained anchors — see B — so adoption is safe) and become `durable`;
  otherwise `disabled`.
- ENOENT -> generate, exclusive publish via `withConfigDirHardeningSettled(home, () => atomicWriteFileNoFollow(path, text, undefined, {}, { exclusive: true }))`
  inside `trackBackgroundWork`. A snapshot with no key file is ignored (cannot be verified) and replaced on the first durable flush.
- Present-but-invalid regular file -> identifier-free warning, replace with a fresh key (non-exclusive atomic write), drop any
  existing snapshot (its rows are unverifiable). Unreadable/symlink/non-regular -> warning, `disabled`, never replaced blindly.
- Ownership: the key file and snapshot are recorded as owned config files (use the default non-exclusive path's ownership
  recording, or call `recordOwnedConfigPath` after an exclusive publish) so uninstall/reset removes them. Implementer verifies
  how `src/lib/config-ownership.ts` is consumed and states it in the PR.

### B. Durable rows without changing the ephemeral key

- `src/codex/lineage.ts` gains a one-slot observer: `setCodexConversationAnchorObserver(fn | undefined)`; `codexConversationKeyFor(familyId, threadId)`
  calls `fn?.(key, familyId, threadId)` after deriving. No new imports in lineage.ts (stays a leaf). The store registers the
  observer when `thread-affinity.ts` loads it.
- The store keeps, per config-home scope, a bounded `anchorByKey: Map<ephemeralKey, anchor>` (same TTL/size as the binding map;
  memory only — raw anchors already live in lineage records in memory). Row keys are computed from the anchor only when a
  snapshot is serialized or a restored row is looked up. Keys with no recorded anchor (legacy raw-parent keys, test keys bound
  directly) are memory-only, exactly as today.
- **Durability contract (blocker 1, narrowed and documented):** a pin survives restart when the request's key is derivable from
  its headers alone: every request carrying `session-id` (all Codex CLI/App turns, roots and subagents), and session-less
  requests whose anchor is their immediate parent. A session-less chain of depth >= 2 resolves through an in-memory lineage
  record that a restart forgets, so it re-places after restart as it does today. Docs say so. Test both sides.

### C. Snapshot store (`codex-affinity.json`)

- `{ version: 1, threads: [{ rowKey, scope, accountId, fence, createdAt, lastUsedAt }], issuers: [{ rowKey, accountId, fence?, lastUsedAt }] }`.
- Fence (blocker 5): `fence = sha256hex("opencodex/codex-affinity/identity/v1\0" + record.quotaHistoryIdentity)`. `quotaHistoryIdentity` is a random
  UUID minted on every new login/replacement and preserved across same-account token refresh (`src/codex/account-store.ts:264,493,554`),
  i.e. the Codex twin of the Claude `loginFence`. Records without a valid `quotaHistoryIdentity` stay memory-only (Claude legacy rule).
- `__main__` pins are not persisted (no durable identity fence for the native login). `__main__` issuer rows and pool issuer rows
  whose fence no longer matches restore as a foreign sentinel issuer (`"\u0000foreign"`), which never equals a serving account id
  and therefore forces the account-change scrub instead of letting stale carried state reach a new account.
- Restore of a thread row: TTL ok, not future-dated, scope valid, account record has credential, not deleted, fence matches. On adoption
  the entry takes the record's CURRENT generation (fence proves identity continuity; this also covers an offline `ocx account refresh`),
  `lastReevalAt = now`, no transient fields. Otherwise discard -> normal selection. Usability (paused, reauth, cooldown, plan/model
  exclusion, transient) is left to the existing resolver (`resolveCodexAccountForThread`, `src/codex/routing.ts:498`, reuse checks ~959-1021).
- Bounds (blocker 6): read cap and write cap both `MAX_FILE_BYTES = 2 MiB`; per table newest-first up to 2048 rows; on write, if the
  serialized document exceeds the cap, drop oldest rows (detour scopes first, then by `lastUsedAt`, ties by rowKey) until it fits —
  deterministic. Duplicate rowKey+scope on read: keep newest. Scope validation mirrors the real component rules: `legacy`, a known
  `CodexQuotaScope`, or `model-detour:<base>:<model>` where model passes the existing 512-byte component limit (no extra cap on the whole scope).
- Lazy adoption + reconciliation (blocker 3): restored rows live in `restoredThreads: Map<rowKey, Map<scope, row>>` and
  `restoredIssuers: Map<rowKey, row>`. EVERY mutation for an ephemeral key K with a known anchor first reconciles the restored rows of
  rowKey(K): bind (restored row for that scope dropped, live wins), delete scope, delete-for-account, issuer remember, and the getters
  (adopt). Account-wide operations (`clearThreadAccountMapForAccount`, `handOffThreadAffinityGeneration` — fence unchanged so no row edit
  needed) and `clearThreadAccountMap`/`clearConversationStateIssuerMap` act on restored rows too, even when the live map misses. TTL pruning and
  LRU eviction count live + restored rows against the 2048 bound, detour-first as `pruneLruThreadAffinities` does. Adoption increments
  `threadAffinityEntryTotal` and runs the existing prune. `getThreadAffinityScopes(threadId)` adopts all restored scopes for that key first.
- Flush policy: structural changes publish promptly; timestamp-only activity (same-account rebind, binding read, issuer peek) schedules one
  coalesced flush after 1 s (unref'd), which captures the in-place `lastUsedAt` writes in `src/codex/routing.ts:911,942,985,1021`
  (that file is at its size cap). Revision re-flush, `trackBackgroundWork("codex-affinity-write", withConfigDirHardeningSettled(...))`,
  best-effort `registerOptionalShutdownHook("codex-affinity", ...)`. Clear racing a pending flush: the flush serializes at callback time
  from current state under the active-scope check, and a clear bumps the revision so a re-flush follows.
- Config-home scope (blocker 4): scope = resolved `getConfigDir()`. On an observed change the old scope is retired (restored rows, anchor map,
  timers, key state) and the live runtime affinity maps are cleared (mirrors the Claude store, whose rows ARE its runtime map), so home B
  never inherits or persists home A's pins. Every deferred callback re-checks `scope.active && getConfigDir() === scope.home` INSIDE the
  ACL-settled callback before writing (Claude `flushSync` pattern). Lineage records stay process-global but carry only ephemeral keys,
  which home B cannot persist without its own anchor observation — implementer confirms no cross-home leak in the A->B->A test.
- Passive reads (blocker 7): when `isPassiveRead()` is true the store neither creates/replaces the key, nor hydrates, adopts, schedules,
  or flushes; affinity behaves exactly as today for that call.
- Warnings are identifier-free: `[codex-affinity] snapshot persistence failed; using runtime affinity`,
  `[codex-affinity] snapshot unavailable or invalid; using runtime affinity`, `[codex-affinity] key unavailable; affinity stays process-local`.

### D. Hooks in `src/codex/routing/thread-affinity.ts`

Call-site hooks only: the getters, bind/delete/clear paths, LRU/TTL prune, issuer remember/peek/clear, `getThreadAffinityScopes`.
Comment updates for the issuer map and legacy adoption lifetime notes. No change to the affinity log label (Lane D), `selection.ts` (Lane C),
`auth-context.ts` (Lane D), or `src/codex/routing.ts` (at cap).

## Tests

`tests/codex-integration/codex-affinity-restart.test.ts` (register in `scripts/test-layout/layout.json` next to line 709 and in
`tests/fixtures/test-layout-expected.json` next to line 697; run `tests/test-layout.test.ts` and `tests/test-layout-tooling.test.ts`).

1. **Restart, two fresh subprocesses (red-on-old)**: a helper script (`tests/helpers/codex-affinity-restart-worker.ts`, registered if the
   layout requires) run with `bun` twice against one temp `OPENCODEX_HOME`: process 1 seeds two pool accounts (round-robin), resolves a
   session-bearing request through `resolveCodexAccountForThread` with the key from `codexPoolAffinityKey(headers)`, records the issuer,
   then awaits the store flush if the export exists (dynamic import with catch, like `tests/adapters/anthropic/anthropic-affinity-restart.test.ts`)
   and exits; process 2 advances the round-robin cursor so a fresh pick would choose the other account, resolves the same headers, and
   prints the account and whether the account-change scrub fires for a body carrying `previous_response_id` when served by the other account.
   Expect: same account; issuer known. Old code: different account / no issuer. Record the old-code failure from an isolated export of
   `origin/dev` (`git archive origin/dev | tar -x -C <mktemp dir>` + the test file + `bun install --frozen-lockfile` or a node_modules link);
   no stash, no worktree.
2. Fallbacks: account removed; account re-logged (new `quotaHistoryIdentity`); legacy record without identity; expired row; future row ->
   normal selection, row gone from the next snapshot. Usability cases (paused, needs reauth, cooldown, model exclusion, transient hold) assert
   the existing resolver behavior after restore, case by case, not a blanket "deleted".
3. `__main__`: pin not persisted; issuer restores as foreign sentinel and forces scrub.
4. Session-less depth-1 survives; depth-2 session-less chain re-places (documented limitation).
5. Reconciliation before first lookup: bind, delete, delete-for-account, issuer remember, clear and clear-for-account on a key whose row
   was restored but not adopted; pending flush racing clear.
6. Key states: reused across restart; exclusive race loser adopts the winner or stays disabled and never writes the snapshot; publish
   failure leaves no snapshot; corrupt regular key replaced and old snapshot dropped; symlinked/unreadable key disabled, not replaced.
   Key file and snapshot are 0600 on POSIX.
7. Privacy and bounds: snapshot contains no raw session/thread id, no ephemeral key; warnings contain no account id; two full tables with
   worst-case UTF-8 detour scopes stay under the cap and re-read successfully; oversized/malformed/symlinked snapshot ignored.
8. Config home A -> B -> A with pending writes: no cross-home rows, no write after retirement.
9. Passive read: no files created, no pending work.
Drain tracked background work before temp-home cleanup.

Existing suites to rerun: `rg -l` of the affinity entry points (the round-1 audit counted 38 files) plus
`tests/lab/core-lab-boundary.test.ts`, the file-size ratchet test, `tests/ci-workflows/test-home-guard.test.ts`, lineage tests.

## Docs

As in 010, plus: `structure/providers/openai-tiers.md` lineage section states the conversation key stays process-local and adds
"Durable Codex pool affinity" (secret, row derivation, fence, main rule, contract narrowing, bounds, flush, passive, home scope, tests);
`structure/providers/openai-accounts.md` only where it claims pins are process-local (do not touch the diagnostic tags or the idle-window
reservation map). Locale copies found per locale (fr, ko, zh-cn, and any others), not by English text. Build the docs site per docs-site/AGENTS.md.

## Verification

Focused new + affected tests, `bun run typecheck`, `bun run structure:check`, `bun run privacy:scan`, docs-site build,
`bun scripts/test.ts --changed=dev --parallel=1`, red-on-old recorded. Before the PR: a dedicated Terra security review (secret file
permissions/ACL, key scope, cross-restart linkability, snapshot contents, deletion on pool/config reset); its verdict goes in the PR description.
