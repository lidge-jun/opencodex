# 010 — Client core: contract, state, sync, routes, CLI (wp2)

All new code lives under `src/telemetry/profile/` (owned by `structure/telemetry.md`). Edits to stack-owned files
are additive and listed explicitly.

## NEW `src/telemetry/profile/contract.ts` (import-free except `../contract`)

The collector imports it, like `src/telemetry/contract.ts`.

```ts
import { MODEL_FAMILIES, parseCalendarUtcDayMs, type TelemetryModelFamily } from "../contract";
export const PROFILE_SCHEMA_VERSION = 1 as const;
export const PROFILE_HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,22})[a-z0-9]$/;   // 3–24, no leading/trailing "-"
export const PROFILE_RESERVED_HANDLES: readonly string[];                    // admin, api, me, ocx, opencodex, root, support, system, telemetry, leaderboard, dashboard, anthropic, openai, google, null, undefined, …
export const PROFILE_AVATARS = ["slate","red","orange","amber","lime","green","teal","cyan","blue","indigo","violet","pink"] as const;
export const PROFILE_DISPLAY_NAME_MAX = 32;
export const PROFILE_MAX_DAY_REQUESTS = 1_000_000;
export const PROFILE_MAX_DAY_TOKENS = 10_000_000_000;
export const PROFILE_SUBMIT_MAX_AGE_DAYS = 7;
export const PROFILE_SECRET_RE = /^ocxp_[A-Za-z0-9_-]{43}$/;                // 32 random bytes, base64url
export type ProfileAvatar = typeof PROFILE_AVATARS[number];
export type ProfilePeriod = "day" | "week" | "month";
export const PROFILE_PERIOD_DAYS = { day: 1, week: 7, month: 30 } as const;
export interface ProfileTokensV1 { input; cacheRead; cacheWrite; output; reasoning }   // non-negative safe ints
export interface ProfileFamilyRowV1 { family: TelemetryModelFamily; requests: number; tokens: number }
export interface ProfileDayV1 { schemaVersion: 1; day: string; requests: number; tokens: ProfileTokensV1; families: ProfileFamilyRowV1[] }
export interface ProfileCreateV1 { schemaVersion: 1; handle: string; displayName: string; avatar: ProfileAvatar }
export function normalizeProfileHandle(raw: string): string;                 // trim + lowercase
export function validateProfileHandle(raw: unknown): { ok: true; handle } | { ok: false; error };
export function validateProfileDisplayName(raw: unknown): { ok: true; displayName } | { ok: false; error };
export function validateProfileCreateV1(input: unknown): { ok: true; value } | { ok: false; error };
export function validateProfileDayV1(input: unknown, now: number): { ok: true; value } | { ok: false; error };
export function sumProfileTokens(t: ProfileTokensV1): number;
```

Validation rules (shared by client and collector):

- Exact key sets at every level (unknown keys rejected).
- Handle: `PROFILE_HANDLE_RE`, no `--`, not all digits, not reserved.
- Display name: NFC, trimmed, 1–32 code points; only Unicode letters, marks, numbers, space and `. _ - '`;
  no two consecutive spaces; rejects anything matching `/\.[a-z]{2,}/i` (domain-like) so a name cannot be a link.
- Day: calendar `YYYY-MM-DD`, strictly before today (UTC), at most `PROFILE_SUBMIT_MAX_AGE_DAYS` old.
- `requests` ≤ `PROFILE_MAX_DAY_REQUESTS`, token sum ≤ `PROFILE_MAX_DAY_TOKENS`.
- Families: unique, from `MODEL_FAMILIES`, `requests > 0`, sum of family requests == `requests`, sum of family tokens
  == token sum, a row with tokens > 0 needs requests > 0. `requests == 0` days are not sent.

## NEW `src/telemetry/profile/state.ts`

File `<OPENCODEX_HOME>/telemetry-profile.json`, written with `atomicWriteFileNoFollow` and mode 0600 (chmod after
write on POSIX, like `telemetry-state.json`), read with a 64 KiB cap and `lstat` symlink refusal.

```ts
export const TELEMETRY_PROFILE_FILE = "telemetry-profile.json";
export interface TelemetryProfileState {
  schemaVersion: 1; handle; displayName; avatar; secret;               // secret never leaves this module except to client.ts
  connectedAt: string; connectedDay: string;                           // UTC day of connect; only later days are sent
  sentDays: Record<string, string>; lastSentDay: string | null; lastSentAt: string | null;
  retryAfterUntil: string | null; pendingDelete: boolean; revoked: boolean;
}
export function readTelemetryProfileFile(dir?): { state: TelemetryProfileState | null; unreadable: boolean };
export function writeTelemetryProfileState(state, dir?): void;          // prunes sentDays older than 30 days
export function deleteTelemetryProfileFile(dir?): void;
export function toPublicProfileStatus(state): TelemetryProfilePublicState; // drops secret
```

## NEW `src/telemetry/profile/client.ts`

`TELEMETRY_PROFILE_API_BASE = "https://telemetry.opencodex.me"` (constant, not configurable; test override seam like
`setTelemetrySenderOverridesForTests`). Each call uses `signalWithTimeout(10_000)` and returns a tagged result
`{ ok: true, body } | { ok: false, status?, error, retryAfterMs? }`:

- `createProfile(body: ProfileCreateV1)` → `POST /v1/profiles`, 201 `{ ok, profile, secret }` (secret validated with `PROFILE_SECRET_RE`).
- `submitProfileDay(secret, day: ProfileDayV1)` → `POST /v1/profiles/me/days` (`authorization: Bearer`).
- `fetchOwnProfile(secret)` → `GET /v1/profiles/me`.
- `deleteProfile(secret)` → `DELETE /v1/profiles/me`; 200 and 401 both count as deleted (401 = the secret is unknown, the row is already gone).

## NEW `src/telemetry/profile/sync.ts`

```ts
export function buildProfileDay(aggregate: DailyTelemetryAggregate): ProfileDayV1 | null; // sums rows by family; null when no requests
export function resolveNextProfileDay(state, telemetryState, now): { day: string | null; reason };
export async function runProfileTick(options): Promise<{ sent: boolean; deleted?: boolean; day?: string; reason: string }>;
export function startProfileScheduler(): () => void;    // startup 2–10 min jitter, then 6 h ± 30 min; unref'd
export function nudgeProfileScheduler(): void;
```

Tick order: (1) unreadable profile file → `state-unreadable`; none → `not-connected`. (2) `pendingDelete` → `deleteProfile`,
on success delete the file → `deleted`. (3) `revoked` → `revoked` (nothing sent until reconnect).
(4) Anonymous telemetry gate: `resolveTelemetryStatus(withPendingTelemetryDecision(diskConfig))` must be effective and
`isTelemetryEnvOptOut` null; `telemetry-state.json` must be readable. Otherwise `telemetry-off` / `state-unreadable`
(the profile file is not modified). (5) `retryAfterUntil` in future → `retry-after-backoff`.
(6) Day: reuse `resolveNextEligibleTelemetryDay(status, { ...telemetryState, sentDays: profile.sentDays,
ineligibleThroughDay: max(telemetryState.ineligibleThroughDay, profile.connectedDay) }, now)` so every anonymous
eligibility rule applies unchanged (strictly after the telemetry consent day, nothing while an env opt-out marker or
owner is set, strictly after `ineligibleThroughDay`, 7-day window) plus strictly after the connect day and not
already in the profile's own `sentDays`. (7) Aggregate with `aggregateTelemetryForDay(d)`, build the day; a day with no requests is recorded
as sent without a request. (8) Re-check the gates just before sending. (9) Send; 200 → record; 401 → `revoked = true`;
429/503 → `retryAfterUntil`; other → `send-failed`.

The profile tick never reads `telemetry-id.json` and never imports `install-id.ts` (guarded by a source test).

## NEW `src/telemetry/profile/routes.ts` + MODIFY `src/server/management/telemetry-routes.ts`

`telemetry-routes.ts` gains a lazy branch: paths under `/api/telemetry/profile` go to
`import("../../telemetry/profile/routes")`. Routes:

| Method | Path | Guard | Behaviour |
| --- | --- | --- | --- |
| GET | `/api/telemetry/profile` | admin | `{ available, connected, profile?: {handle, displayName, avatar, connectedAt, lastSentDay, pendingDelete, revoked}, telemetryEffective, nextDay, preview }`. `preview` is the exact `ProfileDayV1` the next tick would send (or null). Never the secret. |
| GET | `/api/telemetry/profile/rank` | admin | Proxies `GET /v1/profiles/me`, cached 5 min per handle; `{ ok, rank }` or `{ ok: false, error }`. |
| POST | `/api/telemetry/profile` | human session (`hasHumanDashboardSession`), else 403 `agent_consent_required` | Body `{ handle, displayName, avatar, acknowledgePublic: true }`. Refuses with 409 `telemetry_off` unless anonymous telemetry is effective, 409 `already_connected`. Creates the profile, writes the file, nudges the scheduler. Maps collector 409 → `handle_taken`, 400 → `invalid`, 429 → `rate_limited`. |
| DELETE | `/api/telemetry/profile` | admin (revocation is never gated: parity with `PUT /api/telemetry` declines and `ocx telemetry disable`, which are always permitted; only *connecting* is human-only) | Sets `pendingDelete`, attempts deletion immediately (not gated on anonymous telemetry being on), returns `{ ok, deleted, status: "deleted" \| "deletion_pending" }`. `deletion_pending` names the retry owner: the proxy's profile loop on every tick and every start. |

MODIFY `src/server/management/route-registry.ts`: four rows; POST is `exempt: { reason: "session-only", … }` like
`PUT /api/telemetry`.

## NEW `src/cli/telemetry-profile.ts` + MODIFY `src/cli/telemetry.ts`

`ocx telemetry profile [status] [--json]`, `ocx telemetry profile connect --handle <h> [--name <n>] [--avatar <colour>] [--json]`,
`ocx telemetry profile disconnect [--json]`. `telemetry.ts` dispatches `sub === "profile"` before the `enable` gate.
`connect` refuses `isAgentDriven()` (`agent_consent_required`) and non-TTY / `OCX_SERVICE` (`tty_required`), requires
effective telemetry (`telemetry_off`), prints the public-profile disclosure (`PROFILE_DISCLOSURE_POINTS` in
`src/telemetry/profile/disclosure.ts`) and asks `[y/N]` (default no). `disconnect` is always allowed.
`status` reads the live route and falls back to local state.

MODIFY `src/cli/telemetry.ts` `USAGE`, `src/cli/registry.ts` (usage string `ocx telemetry <status|enable|disable|profile> [--json]` + detail lines, same commit as the dispatch), `src/cli/capabilities-observe-system.ts` (three
capability literals), then `bun run skill:surface` regenerates `skills/ocx/references/*`.

## MODIFY `src/server/background-lifecycle.ts`

Independently of the anonymous telemetry env gate (a profile awaiting deletion must be retried even under
`OCX_TELEMETRY=0`, because deletion is the user's own request and sends only the bearer secret), lazily
`import("../telemetry/profile/sync").then(m => stopProfileLoop = m.startProfileScheduler())` **only when
`telemetry-profile.json` exists** (an `existsSync` check; installs without a profile load no profile code); stop it
in the same stop path. Connecting through the management route starts the loop if it is not running. Only the
*send* step is gated on anonymous telemetry. No other stack file changes.

## CLI disconnect without a running proxy

`ocx telemetry profile disconnect` first tries the live route; when the proxy is not reachable it performs the
same steps itself (mark `pendingDelete`, call `deleteProfile`, delete the file on success) and prints
`deletion_pending` with "retried by the proxy on its next start" when the collector cannot be reached.

## Secret rotation and exposure

v1 has no rotate endpoint: disconnect + reconnect is the rotation path (documented). `telemetry-profile.json` is
recorded with `recordOwnedConfigPath` (uninstall removes it) and must not appear in any config export or desktop
backup set (checked in B against `ocx config export` and the desktop backup metadata list).

## Tests (failing first)

- NEW `tests/usage/usage-telemetry-profile-contract.test.ts`: handle/name/day/family validation, sums, caps.
- NEW `tests/usage/usage-telemetry-profile-sync.test.ts`: no send when telemetry off/env opt-out/awaiting notice/unreadable
  state (and profile file untouched); no backfill (connect day and earlier never sent); oldest-first one per tick;
  pendingDelete retries and deletes the file; 401 revokes; secret absent from `toPublicProfileStatus`; the module graph
  of `sync.ts` excludes `install-id.ts` and the payload never contains `installDayHash`/`batchId`.
- NEW `tests/server/server-telemetry-profile-routes.test.ts`: session gate, telemetry_off, no secret in any body,
  DELETE pending path, telemetry decision unchanged by connect/disconnect.
- NEW `tests/cli/cli-telemetry-profile.test.ts`: agent/TTY refusals, default-no prompt, disconnect always allowed.
  Disconnect with the proxy stopped deletes directly; with the collector unreachable it leaves `pendingDelete` and
  the next proxy start's tick deletes it, including while `OCX_TELEMETRY=0` or telemetry is declined.
- MODIFY `tests/usage/usage-telemetry-core-boundary.test.ts` (or a sibling file if it is near a cap): the three core
  files must not reach `src/telemetry/profile/`, and `src/telemetry/profile/sync.ts` must not reach
  `src/telemetry/install-id.ts`.
- Each new test file is registered in `scripts/test-layout/layout*.json` and `tests/fixtures/test-layout-expected*.json`.


## Stale check (wp2 P, 2026-11-09)

- Route path equalities must sit in `src/server/management/telemetry-routes.ts` (the route registry reconciles by an
  equality scan of the owning module), with the handlers in `src/telemetry/profile/routes.ts` behind a lazy import.
- `tests/usage/usage-telemetry-core-boundary.test.ts` already forbids any load-time path from the core files and
  `management-api.ts` into `src/telemetry/`, which covers `src/telemetry/profile/`. The new install-id isolation
  check goes into the profile sync test.
- `background-lifecycle.ts` statically imports `src/telemetry/state.ts` and `consent.ts`; its profile file check
  imports only a tiny `src/telemetry/profile/paths.ts` (no I/O at module load).
- `withPendingTelemetryDecision`, `readTelemetryStateFile`, `formatUtcDay` and `utcMidnightMs` are exported from
  `state.ts` (re-exported by `scheduler.ts`); the profile code imports `state.ts` and `consent.ts` directly, and
  `resolveNextEligibleTelemetryDay`/`latestCompletedUtcDay` from `scheduler.ts`, which statically imports
  `install-id.ts`. A-phase decision: do not move stack-owned code (the stack lane may still edit `scheduler.ts`);
  instead the profile test scans every file under `src/telemetry/profile/` and fails if one imports `install-id`,
  `payload` or `sender`, or names `installDayHash`, `batchId`, `installId` or `telemetry-id`, and asserts the
  submitted body's exact key set.
