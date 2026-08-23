# Shared Account-Pool Kernel Design

Date: 2026-08-22
Status: approved implementation design
Scope: extract a shared sticky-session / rate-limit failover kernel for OAuth
account pools; thin plugins for Claude, Antigravity, and Cursor; Codex stays on
its existing rich plugin. Command Code pooling is out of scope.

This is fork-owned work. Pull requests target `yansigit/opencodex`, not
`lidge-jun/opencodex`.

## Goal

One small engine that sticks a conversation to one credential, spreads only
unbound sessions when a plugin opts in, and rotates mid-request only on
429/auth death — without rewriting Codex routing or lighting prompt-cache cost
on every hop.

## Architecture

- **Codex** remains the rich plugin in `src/codex/routing.ts` (WHAM, spark
  scopes, `__main__`, probe leases, pin). Do not flip Codex pool default-off in
  this unit.
- **Kernel** lives in `src/routing/account-pool/` — affinity, cooldown,
  `resolvePoolAccount`, `rotatePoolAccountOn429`. Generic pick primitives stay
  in `src/codex/pool-rotation.ts`.
- **Claude** (`anthropic-routing.ts`) migrates onto the kernel; public function
  names and default-off gate stay.
- **Antigravity** gets session affinity and bounded stick-wait; no new-session
  load balancing.
- **Cursor** gets optional, default-off sticky 429 failover; do not wire
  `CursorCredentialRouter` weighted RR.
- **Wave 3** (separate): senpi-style Cursor conversation remint — overflow
  resource-exhausted surfaces first, then remints wire id ≤3; not an account hop.
- **v1 does not merge** `src/providers/key-failover.ts` (API keys, not OAuth
  accounts).

## Four rules (every plugin)

1. **Bound session stays on one account.** Affinity is keyed by a plugin-derived
   session id (thread header, client thread id, OpenResponses session — not a
   shared-cohort `prompt_cache_key`).
2. **New-session spreading is opt-in per plugin.** Claude already supports quota /
   round-robin / fill-first for unbound sessions. Cursor and Antigravity do not
   spread new sessions in v1.
3. **Mid-request rotate only on rate-limit 429 or auth death.** Cap three hops,
   pre-commit / pre-stream only — never after client-visible output. Do not
   `setActiveAccount` in a way that steals other live session affinities.
   **402 / billing exhaustion is not 429** — long billing cooldown, no carousel.
4. **Refuse / warn when credentials share org, workspace, Cloud project, or team
   quota.** Pooling does not multiply shared limits.

## Plugin vs Codex

| Concern | Codex plugin | Kernel + thin plugins |
| --- | --- | --- |
| Session affinity | Thread + quota scope | Plugin `sessionKeyFromRequest` |
| New-session pick | quota / RR / fill-first (shipped on) | Opt-in; Claude only in v1 |
| Mid-request 429 hop | Pre-stream alternate account | Kernel `rotatePoolAccountOn429` |
| Promote active account | Codex-local paths | Plugin promotes after usable token |
| WHAM / probe / spark | Codex-only | Not in kernel |
| Default enabled | Pool mode default | Claude / Cursor off; Antigravity no spread |

Promotion is not a kernel primitive. Plugins call `setActiveAccount` /
`promoteAnthropicActiveAccount` after a usable token — not inside
`rotatePoolAccountOn429`.

## Provider terms (operator responsibility)

OpenCodex does not endorse using additional accounts to circumvent rate limits,
quotas, plan limits, or other provider restrictions, or sharing credentials
between people. Operators must follow each provider's **current** terms. This
design records official posture for implementers; it is not legal advice.

| Provider | Pool stance in v1 | Official notes (summary) |
| --- | --- | --- |
| OpenAI / Codex | Shipped pool unchanged | Consumer ToS / Services Agreement forbid sharing credentials and circumventing limits. ChatGPT OAuth in third-party clients is officially allowed. Same workspace shares one agentic pool — pooling logins adds no quota. |
| Anthropic | Default off; migrate only | Consumer OAuth for Claude Code / claude.ai only; third-party routing of Free/Pro/Max tokens prohibited. Workspace prompt cache is isolated per workspace. |
| Google Antigravity | Failover-only bugfix | Harvesting OAuth is a violation; circumventing usage limits risks recertification flags. Code Assist OAuth does **not** support cached content — stickiness is for thought-signature replay and project bind, not cache-dollar savings. |
| Cursor | Default off | AUP forbids circumventing rate limits and manipulating usage metering. Teams usage is per seat; Enterprise may pool. |
| Command Code | **No pool** | One account per person; extra accounts for credits → lifetime ban. Team credits pool per org only. |

## Antigravity stick-wait (narrow)

When this session's sticky account is `rate_limited` and remaining cooldown is
≤5 seconds, **wait** instead of hopping to another account. Never wait on
`quota_exhausted` or `geo_blocked`. Do not document stick-wait as prompt-cache
savings — Code Assist has no official cached-content path for OAuth.

## Billing vs 429

402, payment-required, and billing-exhaustion responses use a **billing**
cooldown class. They must not enter the short 429 hop carousel or the three-hop
failover cap. Codex already splits this in `quota-rejection.ts`; the kernel
`CooldownRegistry` shares the taxonomy for Anthropic, Antigravity, and Cursor.

## Kernel interface (lock names)

```ts
export const ACCOUNT_POOL_MAX_FAILOVERS = 3;

export type AccountPoolPickReason =
  | "affinity" | "active" | "lowest-usage" | "round-robin" | "fill-first"
  | "only-eligible" | "none" | "all-cooled" | "disabled";

export interface AccountPoolPlugin {
  readonly poolKey: string;
  sessionKeyFromRequest(input: {
    sessionIdHeader?: string | null;
    threadIdHeader?: string | null;
    clientThreadId?: string | null;
    promptCacheKey?: string | null;
    promptCacheKeyIsSharedCohort?: boolean;
  }): string | null;
  listEligibleAccountIds(now: number): string[];
  usageScore?(accountId: string): number;
}

export function resolvePoolAccount(
  plugin: AccountPoolPlugin,
  sessionKey: string | null,
  opts: { strategy: "quota" | "round-robin" | "fill-first"; enabled: boolean; activeAccountId?: string },
  now?: number,
): { accountId: string | null; reason: AccountPoolPickReason };

export function rotatePoolAccountOn429(
  plugin: AccountPoolPlugin,
  failedAccountId: string,
  sessionKey: string | null,
  retryAfterHeader: string | null,
  now?: number,
): string | null;

export interface CooldownRegistry {
  set(accountId: string, until: number, meta?: { source?: string; reason?: string }): void;
  get(accountId: string, now?: number): { until: number } | null;
  clear(accountId: string): void;
  sweep(now?: number): number;
}
```

Affinity: process-local map, TTL 24h, max entries, component byte cap (mirror
Anthropic 512-byte / 2000-entry limits). Ignore Desktop shared-cohort
`prompt_cache_key`.

## Lab and privacy boundaries

- `src/routing/account-pool/` must not import `src/lab/`.
- Do not add kernel imports from `src/router.ts` or `src/server/lifecycle.ts`.
- No emails, tokens, or account ids in logs (existing opaque label style).

## Explicit non-goals

- Per-request round-robin on Cursor, Antigravity, or Command Code
- Wiring `CursorCredentialRouter` (yelixir weighted RR)
- Treating overflow resource-exhausted as an account-pool 429 hop (Wave 3
  remints conversation id only)
- Mid-stream credential hop after client-visible output
- Waiting out 24h `quota_exhausted` / `geo_blocked`; branding stick-wait as cache
- Prefix-hash OAuth account pick or weighted RR on Cursor/Antigravity
- Turning Claude or Cursor pools on by default
- Extracting Codex WHAM/probe/pause into the kernel
- Key-pool and OAuth-pool unification
- Upstream PR to `lidge-jun/opencodex`
