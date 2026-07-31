# Unified Token Guardian — design (Thread A)

Date: 2026-07-03
Owner: Boss (main session), PABCD Phase 0 build output.
Status: DONE (design pass). Implementation = Phases 1–4 (each its own PABCD cycle).

Design principle (from goal): the guardian is a **caller** of the existing refresh machinery, not
new refresh/locking logic, and it is **policy-gated per provider** so it adds zero ToS surface by
default. See `30_tos-account-safety.md` for why gating is mandatory, not optional.

## Interface

```ts
// src/oauth/token-guardian.ts (NEW)
export type RefreshPolicy = "proactive" | "lazy-only" | "disabled";

export interface TokenGuardianHandle { stop(): void }

// Started once after the server binds; returns a handle whose stop() clears the timer.
export function startTokenGuardian(): TokenGuardianHandle;
```

Config (added to `OcxConfig`, `src/types.ts:223`, alongside `shutdownTimeoutMs` `:251`):

```ts
tokenGuardian?: {
  enabled?: boolean;          // default false — global kill-switch
  tickSeconds?: number;       // default 3600 (1h); codex-lb uses 6h
  jitterSeconds?: number;     // default 300 — de-synchronize + look less bot-like
  concurrency?: number;       // default 3
  leadSeconds?: number;       // refresh when expiresAt within this window (default 900 = 15m)
  failureBackoffBaseSeconds?: number;  // default 300
  failureBackoffMaxSeconds?: number;   // default 3600
};
```

`refreshPolicy` attaches to each provider def (`OAuthProviderDef`, `src/oauth/index.ts:21`) with
the risk-tiered defaults locked in `00_plan.md` (Anthropic `disabled`; OpenAI/Cursor/Google/xAI/
Kiro/Kimi `lazy-only`). A user override lives in the provider's config entry so opting a provider
into `proactive` is explicit and per-provider.

## Control flow (one tick)

```
every (tickSeconds ± jitter), IF config.tokenGuardian.enabled:
  A) single-account layer:
     for each provider in OAUTH_PROVIDERS where policy(provider) === "proactive":
        cred = getCredential(provider); if none → skip
        if cred.expires <= now + leadSeconds:
           await getValidAccessToken(provider)   // existing dedup + persist; NO new logic
  B) multi-account Codex pool (only if policy("chatgpt") === "proactive"):
     for id in listCodexAccountIds()  (bounded by concurrency semaphore):
        rec = readCodexAccountRecord(id); if deleted/no cred → skip
        if rec.credential.expiresAt <= now + leadSeconds:
           await getValidCodexToken(id)           // existing file-lock + generation-CAS + fingerprint
  on TokenRefreshError(reason=revoked|expired):    // src/codex-account-store.ts:174
     mark account/provider in a backoff map; surface a reauth notice; do NOT retry-spin
```

Why this is safe by construction:
- **No new refresh path.** `getValidAccessToken` (`src/oauth/index.ts:115`) already dedupes via the
  `tokenRefreshes` map and persists via `saveCredential`. `getValidCodexToken`
  (`src/codex-account-store.ts:278`) already holds the cross-process file lock (`:224`), does a
  generation CAS (`saveCodexAccountCredentialIfGeneration` `:139`), and reuses a sibling account's
  fresh token for the same grant (`findFreshCredentialForGrant` `:264`). The guardian only *calls*
  them earlier than a user request would.
- **Idempotent with lazy path.** If a real request refreshes first, the guardian's expiry check
  short-circuits (token no longer within `leadSeconds`), and if they race, the file lock + CAS make
  the loser a no-op.
- **Permanent-failure aware.** Reuses the existing `TokenRefreshError` classification (`:366`);
  the guardian stops touching a `revoked`/`expired` account until re-login, mirroring codex-lb's
  `PERMANENT_FAILURE_CODES` deactivation.

> 출처: [Soju06/codex-lb — guardian: interval/jitter/backoff/leader-election](https://github.com/Soju06/codex-lb)

## Lifecycle hook points (diff-level, Phase 4)

- **Start** — `src/cli.ts` after the server binds (`server = startServer(port)` at `src/cli.ts:120`,
  post `installCrashGuards()`):
  ```
  + const guardian = startTokenGuardian();
  ```
- **Stop** — in the `shutdown()` path's `syncCleanup()` (`src/cli.ts` ~`:143`) and/or before
  `drainAndShutdown(server, ...)` (`src/cli.ts:172` / `src/server.ts:160`):
  ```
  + try { guardian.stop(); } catch { /* best-effort */ }
  ```
  (Clearing the interval prevents a refresh firing mid-drain.)

The guardian must never block drain: its work is fire-and-forget `void`-ed promises with the
concurrency semaphore; `stop()` only clears the timer, in-flight refreshes settle on their own.

## Divergence from codex-lb (intentional)

- codex-lb runs multi-replica with DB leader-election (`scheduler_leader`); opencodex is a
  single local daemon (one PID, `writePid` `src/cli.ts`), so no leader election — the single
  process IS the leader. The cross-process **file lock** already guards against a second `ocx`
  instance double-refreshing.
- codex-lb keys staleness on a persisted `last_refresh` (8-day use-time / 12h guardian). opencodex
  keys on `expiresAt` proximity (`leadSeconds`) to avoid a schema migration in Phase 0/1; a
  `lastRefresh` field is an optional Phase 1 refinement if we want codex-lb's exact "warm the
  chain every N days regardless of expiry" behavior.

## Phase map (implementation, each its own PABCD)

1. `refreshPolicy` on `OAuthProviderDef` + `tokenGuardian` config schema + risk-tiered defaults.
   Files: `src/oauth/index.ts`, `src/types.ts`, `src/config.ts`.
2. Single-account guardian loop (step A). New `src/oauth/token-guardian.ts`.
3. Codex-pool guardian loop (step B) — the codex-lb parity piece.
4. Lifecycle wiring + jitter/backoff + tests (`tests/`).
