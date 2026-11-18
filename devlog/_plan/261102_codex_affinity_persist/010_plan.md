# 261102 Codex pool affinity persistence (Lane B) — 010 plan

Status: P (plan) — awaiting Terra audit.

## Problem

Codex pool session pins live only in memory, so a proxy restart re-places every ongoing conversation.
Two process-local facts cause it, and both must change:

1. `src/codex/routing/thread-affinity.ts` keeps `threadAccountMap` (conversation key -> scope -> binding) and
   `conversationStateIssuerMap` (binding key -> account that minted carried encrypted state) in memory only.
2. The key those maps are indexed by is `codexConversationKeyFor()` in `src/codex/lineage.ts`:
   `app:HMAC(CODEX_LINEAGE_KEY, family, thread)` where `CODEX_LINEAGE_KEY = randomBytes(32)` at module load.
   After a restart the same conversation derives a different key, so a persisted map alone could never be
   looked up again. (The lineage scope key `auth:HMAC(key, Authorization)` uses the same secret.)

Under round-robin most conversations move after a restart: the prompt cache goes cold and carried encrypted
state minted by the old account can fail with `invalid_encrypted_content`.

Reference implementation to mirror: `src/oauth/anthropic-session-affinity-store.ts` (#7813 / #7828) and its
structure section `structure/providers/anthropic-account-pool.md#durable-session-affinity`.

## Design

### A. Durable conversation-key secret — new `src/codex/affinity-key.ts`

- `codexAffinityKey(): Buffer` returns a 32-byte secret cached per resolved `getConfigDir()` (re-resolved when the
  home changes, as the Claude store's scope does).
- Path: `<configHome>/codex-affinity-key`. Content: one line `v1:<base64url of 32 bytes>` (validated by regex).
- Hydration: `readBoundedRegularFileSync(path, 128)` (rejects symlinks/junctions/non-regular files and oversize).
  Valid -> use. ENOENT -> `randomBytes(32)`, cache it, and persist asynchronously:
  `trackBackgroundWork("codex-affinity-key-write", withConfigDirHardeningSettled(home, () => atomicWriteFileNoFollow(path, text, undefined, {}, { exclusive: true })))`.
  If the exclusive publish loses a race (another process created it first), keep the in-memory key for this process
  (its pins are lost at the next restart, same as today) — no overwrite. Invalid or unreadable -> identifier-free
  `console.warn("[codex-affinity] key unavailable or invalid; affinity is process-local until it is replaced")`, generate
  a fresh key and replace the file with a non-exclusive atomic write (a corrupt key must not disable persistence forever).
- The file is a secret: private mode via the atomic publisher (0600 on POSIX) and the config-dir Windows ACL barrier.
  Never logged, never included in diagnostics.
- `src/codex/lineage.ts`: drop `CODEX_LINEAGE_KEY`; both HMACs call `codexAffinityKey()`. Update the LIFETIME doc block:
  keys are now reproducible across restarts of one config home; lineage records themselves stay process-local.
  Keep lineage a leaf: the new module imports only config/lib modules (no routing import, no cycle).
- `src/adapters/google-antigravity-wire.ts` comment that calls the key "process-random ... changes across a proxy restart":
  reword only (the derivation there stays independent; it must survive loss of the key file too). No behavior change.

### B. Durable pin + issuer snapshot — new `src/codex/routing/thread-affinity-store.ts`

- File `<configHome>/codex-affinity.json`, `{ version: 1, threads: [...], issuers: [...] }`.
  - thread row: `{ keyDigest, scope, accountId, generation, createdAt, lastUsedAt }`
  - issuer row: `{ keyDigest, accountId, lastUsedAt }`
  - `keyDigest = sha256hex("opencodex/codex-affinity/<thread|issuer>/v1\0" + key)`. Raw conversation keys, raw parent ids
    (legacy keys) and binding keys never reach disk. Account ids are opaque pool ids (`isValidCodexAccountId` or `__main__`).
  - Transient fields (`transientHoldSince`, `transientDetourAccountId`) and `lastReevalAt` are not persisted; restored
    entries get `lastReevalAt = restore time`.
- Bounds: `MAX_FILE_BYTES = 1 MiB` on read; newest `CODEX_THREAD_AFFINITY_MAX_ENTRIES` (2048) rows per table on write and read;
  rows idle longer than `CODEX_THREAD_AFFINITY_IDLE_TTL_MS` (24 h), future-dated rows, malformed rows are dropped.
  Scope strings validated (`spark`/quota scopes, `legacy`, `model-detour:<scope>:<model>`, <= 512 bytes).
- Hydration is lazy per config home (first affinity read/write), synchronous and bounded, like the Claude store.
  Restored rows are held in digest-keyed `restoredThreads` / `restoredIssuers` maps; they never enter
  `threadAccountMap` until a request looks them up.
- Adoption: in `getThreadAffinityForScope(threadId, scope)` on a memory miss, and in `peekConversationStateIssuer`,
  compute the digest, take the restored row, validate, and insert it into the in-memory map (removing it from the restored
  map). Validation for thread rows = not expired AND `isThreadAffinityGenerationLive({accountId, generation})` (account record
  exists, has a credential, not deleted, same credential generation; `__main__` must be generation 0). A failing row is
  discarded and the request falls back to normal selection. Usability (paused, reauth, plan exclusion, quota, cooldown) is
  NOT checked at restore: the existing resolve path already re-evaluates a bound account every request and releases it
  with the usual reason. Issuer rows are restored after TTL validation only: an issuer for a deleted account still correctly
  forces the account-change scrub.
- Writes: the snapshot is serialized from the live maps plus unadopted restored rows at flush time, so in-place mutations
  elsewhere are captured. Structural changes (new bind, account change, delete, clear, per-account clear, hand-off,
  prune/evict, issuer change) flush promptly; timestamp-only activity (bind of the same account, a binding read, an issuer
  peek) schedules one coalesced flush after 1 s (unref'd timer). Reading a binding schedules the coalesced flush because
  `src/codex/routing.ts` updates `lastUsedAt` in place after the read and that file is at its file-size cap.
- Publisher: `trackBackgroundWork("codex-affinity-write", withConfigDirHardeningSettled(home, () => atomicWriteFileNoFollow(path, json)))`,
  revision counter re-flush exactly like `flushScope` in the Claude store, best-effort `registerOptionalShutdownHook("codex-affinity", ...)`,
  identifier-free warnings (`[codex-affinity] snapshot persistence failed; using runtime affinity` /
  `snapshot unavailable or invalid; using runtime affinity`). An observed config-home change retires the scope (memory
  restored maps + pending timer), as in the Claude store.
- Exports: `flushCodexThreadAffinity()` (tests and shutdown), `resetCodexAffinityStoreMemoryForTests()`.

### C. Minimal hooks in `src/codex/routing/thread-affinity.ts`

- `getThreadAffinityForScope`: on miss, adopt from the store; on hit, schedule the coalesced touch flush.
- `bindThreadAffinityForScope`, `deleteThreadAffinityForScope`, `deleteThreadAffinitiesForAccount`,
  `clearThreadAccountMapForAccount` (also purge restored rows for that account), `handOffThreadAffinityGeneration` (also
  move restored rows fromGeneration -> toGeneration), prune/LRU paths, `rememberConversationStateIssuer`,
  `peekConversationStateIssuer`, `clearConversationStateIssuerMap`, `clearThreadAccountMap` (also clears restored rows and
  persists the empty snapshot, matching the Claude "explicit runtime selection clears bindings and persists the reset").
- Update the doc comments that promise process-local lifetime (issuer map comment, `adoptLegacyAffinityForScope` comment).
- Keep edits to call sites; do not touch the affinity log label (Lane D) or `src/codex/routing/selection.ts` (Lane C).
- Core-path boundary: the store imports only `src/config/*` and `src/lib/*`; no `src/lab/` reachability.

## Tests (new files; register each in `scripts/test-layout/layout.json` or its domain shard AND a `tests/fixtures/test-layout-expected*.json` shard)

`tests/codex-integration/codex-affinity-restart.test.ts` (temp `OPENCODEX_HOME` per test, `removeTreeWithRetry` cleanup):

1. Restart keeps the pin: build headers with `session-id`/`thread-id`, key = `codexPoolAffinityKey(headers)`, seed two pool
   accounts, `bindThreadAffinity(key, B, now)`, `rememberConversationStateIssuer(key, B)`, flush, simulate restart
   (reset in-memory affinity, store scope and key cache — NOT the files), recompute the key from the same headers: it is
   identical, `getThreadAffinity(key)` returns B, `peekConversationStateIssuer(key)` returns B. Prefer one assertion through
   the real resolver (`resolveCodexAccountForThread` or the existing public resolve used in `tests/codex-integration/codex-routing.test.ts`)
   under round-robin, showing the restored binding wins over the strategy cursor.
   MUST FAIL on old code (record output): the key differs after restart and the map is empty.
2. Dead pins fall back: account removed, credential generation bumped (re-login), and expired (>24 h) rows are dropped;
   resolve returns a normal selection and the dropped row is gone from the next snapshot.
3. Privacy/bounds: the snapshot contains no raw session id, thread id or conversation key; key file is 0600 on POSIX;
   oversized, malformed, future-dated and symlinked snapshots are ignored with an identifier-free warning (assert the
   warning text contains no account id or key); more than 2048 rows keeps the newest.
4. `clearThreadAccountMap()` and `clearThreadAccountMapForAccount()` persist their removals (after restart the pin is gone).
5. Key file: reused across restart; a corrupt key file is replaced and a warning is emitted.

Existing suites to rerun: `tests/codex-integration/codex-routing*.test.ts`, `codex-affinity-debug.test.ts`,
`codex-idle-window.test.ts`, `codex-account-selection-atomicity.test.ts`, `codex-auth-release.test.ts`,
`tests/responses/responses-account-change-scrub.test.ts`, `tests/responses/responses-4546-incident-regression.test.ts`,
lineage tests (`rg -l lineage tests`), `tests/lab/core-lab-boundary.test.ts`, `tests/test-layout.test.ts`, file-size ratchet test.

## Docs

- `structure/providers/openai-tiers.md`: lineage section (lines ~105-160) — key is a per-config-home durable secret; add a
  "Durable Codex pool affinity" paragraph parallel to the Anthropic one (file names, row shape, bounds, validation, flush policy,
  test names). Run `bun run structure:check`; add the new src files to the owning manifest entry if the check asks.
- `docs-site/src/content/docs/reference/cli/providers-accounts.md` (~line 848): replace "proxy restart or affinity eviction can
  also leave a task unbound" with: bindings survive a proxy restart for 24 h idle; eviction, account removal or re-login leave a
  task unbound. Apply the equivalent edit in every locale copy that carries the sentence (`rg -l` across docs-site locales) so no
  locale contradicts English; follow `docs-site/AGENTS.md`.
- `docs-site/src/content/docs/reference/configuration/providers.md` `accountPoolStrategy` row (~line 128) says a task "can become unbound after proxy restart or affinity reset"; update it (and locale copies) the same way.

Issue: https://github.com/lidge-jun/opencodex/issues/8091

## Verification

`bun test <new + listed files>`, `bun run typecheck`, `bun run structure:check`, `bun run privacy:scan`,
`bun scripts/test.ts --changed=dev --parallel=1`. Red-on-old proof: run test 1 against `origin/dev` sources (stash src changes) and record the failure.
`ci:full` label: yes — the change reaches on-disk files and docs the import graph cannot see.

## Out of scope

`src/codex/routing/selection.ts` (Lane C), `src/codex/auth-context.ts` and the affinity log label (Lane D),
`src/server/claude-*`, `src/server/caller-session-identity.ts` (Lane A). No change to selection policy.

## Risks

- Persisting the HMAC secret changes the documented "keys are unreproducible after restart" posture. The secret stays private
  (same protection class as `admin-api-token`), and the snapshot holds only digests of keys derived from it.
- Two processes sharing one config home: exclusive create means the loser keeps a process-local key; acceptable and documented.
- Write amplification: at most one coalesced write per second while traffic flows, same as the Claude store.
