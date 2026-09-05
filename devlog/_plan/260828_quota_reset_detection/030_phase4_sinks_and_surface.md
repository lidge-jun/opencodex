# wp4 — Notification sinks and operator surface

The config section, the sinks that actually fire the token, and the surfaces an operator
reads. Everything here is inert until config says otherwise.

## MODIFY `src/types/config.ts`

Add to `OcxConfig` (near the other optional feature sections, before `corsAllowOrigins`):

```ts
  /** Quota-reset detection and notification. Off by default; see OcxQuotaResetNotifyConfig. */
  quotaResetNotify?: OcxQuotaResetNotifyConfig;
```

And the shape:

```ts
export interface OcxQuotaResetNotifyConfig {
  /** Global kill-switch. Default false — nothing detects, nothing polls, nothing fires. */
  enabled?: boolean;
  /** Which reset kinds to notify on. Default both. */
  kinds?: Array<"scheduled" | "surprise">;
  /** Poll interval seconds for idle detection. Default 900. Min 60. 0 disables polling. */
  pollSeconds?: number;
  /** POST a JSON event here. Must resolve public unless allowPrivateNetwork. */
  webhookUrl?: string;
  /** Allow a loopback/private webhook target (self-hosted receivers). Default false. */
  allowPrivateNetwork?: boolean;
  /** Webhook timeout ms. Default 5000. */
  timeoutMs?: number;
  /** Run a local command with the event as JSON on stdin. */
  command?: string[];
}
```

## MODIFY `src/config.ts`

Follow the `agentTaskRecovery` template exactly — it is the only optional section wired
through all four places, and skipping any one of them produces a section that silently
vanishes or a write path that accepts garbage.

1. Schema beside `agentTaskRecoverySchema` (`:843`):
```ts
const quotaResetNotifySchema = z.object({
  enabled: z.boolean().optional(),
  kinds: z.array(z.enum(["scheduled", "surprise"])).optional(),
  pollSeconds: z.number().int().min(0).optional(),
  webhookUrl: z.string().url().optional(),
  allowPrivateNetwork: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
  command: z.array(z.string()).optional(),
}).strict();
```
2. Register in `configSchema` beside `:898`, with the same rationale comment:
```ts
  // Invalid optional notify config must not discard unrelated provider/account state.
  quotaResetNotify: quotaResetNotifySchema.optional().catch(undefined),
```
3. `quotaResetNotifyError(value)` modeled on `:2058`, added to the
   `validateConfigCandidate` chain at `:2179`.
4. `warnDegradedQuotaResetNotify(parsed)` modeled on `:1675`, called in ALL THREE
   `loadConfig` success branches (`:1832`, `:1856`, `:1876`). A new section is not in
   `SALVAGEABLE_CONFIG_SECTIONS` (`:3161`), so `.catch(undefined)` plus this warning is the
   whole degradation story — worth stating rather than discovering later.
5. **`validFileConfigDiagnostics` (`:1957`) — added after the wp2 audit (blocker 4).**
   A diagnostics surface SEPARATE from the three load branches, feeding
   `ocx config show --source`. `agentTaskRecovery` appears in both (`:1975` and `:1832`);
   registering only the load branch leaves the CLI silent about a degraded section.

### Two more consumers the first chain audit missed (blocker 4)

- **`webhookUrl` MUST be redacted.** `SECRET_KEYS` at `src/cli/config-command.ts:18`
  matches `apiKey|key|accessToken|refreshToken|idToken|token|password|clientSecret` —
  `webhookUrl` matches none. For Slack and Discord the URL *is* the credential, so
  `ocx config show` would print it and `config export` (`:190`) would write it to disk.
  Add `webhookUrl` to that pattern; a redaction test comes with it.
- **`safeConfigDTO` (`src/server/auth-cors.ts:695`) is an explicit whitelist**, so
  `quotaResetNotify` is correctly invisible to `GET /api/config`. That is the intended
  outcome, recorded here so a later GUI toggle reads it as a deliberate omission rather than
  an oversight.

`getDefaultConfig()` is NOT touched: it carries no optional-feature keys, deliberately.
Absent means off.

## NEW `src/quota/reset-notify-config.ts`

```ts
export type ResolvedQuotaResetNotify = {
  readonly enabled: boolean;
  readonly kinds: ReadonlySet<QuotaResetKind>;
  readonly pollMs: number;
  readonly webhookUrl?: string;
  readonly allowPrivateNetwork: boolean;
  readonly timeoutMs: number;
  readonly command?: readonly string[];
};

export function resolveQuotaResetNotify(raw: unknown): ResolvedQuotaResetNotify;
export function isQuotaResetNotificationEnabled(): boolean;
```

Read-time normalization with clamping, the `token-guardian.ts:77` `resolved()` pattern.
`enabled` is only true when explicitly `true` AND at least one sink is configured — an
enabled subsystem with nowhere to send is a misconfiguration, and treating it as off keeps
the "no sink invoked" guarantee honest. `pollSeconds: 0` means passive-only.

## NEW `src/quota/reset-sinks.ts`

```ts
export type QuotaResetDeliveryResult = {
  readonly sink: "webhook" | "command";
  readonly ok: boolean;
  /** Closed-union failure reason. Never an upstream body or a URL. */
  readonly reason?: "blocked-destination" | "timeout" | "http-error" | "spawn-failed";
};

export async function deliverQuotaResetEvent(
  event: QuotaResetEvent,
  config: ResolvedQuotaResetNotify,
): Promise<QuotaResetDeliveryResult[]>;
```

Webhook: `assertUrlResolvesPublic(url)` from `src/lib/destination-policy.ts:377` unless
`allowPrivateNetwork` — an operator-supplied URL is an SSRF surface and this repo already
has the policy for it. Then `fetch` with `signalWithTimeout(timeoutMs)` from
`src/lib/abort.ts:101` plus its `cleanup()`, `POST`, `application/json`, body =
`JSON.stringify(event)`, response body cancelled via `cancelResponseBodyBestEffort`.
No retry: a reset notification is only interesting while it is fresh, and the mark-seen
ordering in wp3 already forbids re-delivery.

Command: `Bun.spawn` with the event JSON on stdin as ENCODED BYTES —
`stdin: new TextEncoder().encode(json)`. A plain string throws `ERR_INVALID_ARG_TYPE` on
Bun 1.4.0 (audit blocker 7), and every existing call site in this repo uses `"ignore"` or
`"inherit"` (`src/oauth/kiro.ts:98`, `src/codex/user-identity.ts:128`), so there is no
in-repo precedent to copy. The argv form is used deliberately: the command is NOT shell
interpreted, so an operator-supplied string cannot become an injection surface.

Both sinks are independently try/caught, so one failing never suppresses the other, and
neither ever throws to the caller (criterion c-6).

### Payload — the privacy contract

```json
{
  "type": "quota_reset",
  "kind": "surprise",
  "scope": "codex",
  "accountTag": "k3f9x2ab",
  "window": "weekly",
  "percentBefore": 96,
  "percentAfter": 4,
  "previousResetAt": 1772000000000,
  "resetAt": 1772400000000,
  "detectedAt": 1771900000000
}
```

Closed-union labels and numbers only. No email, no account id, no token, no path, no URL.
`bun run privacy:scan` cannot verify this — it scans repository text, not runtime output
(`scripts/privacy-scan.ts:227`) — so the type is the enforcement, exactly as
`src/server/management/system-routes.ts:126` argues for its own key union.

## NEW management route

`GET /api/quota-resets` in a new `src/server/management/quota-reset-routes.ts`, prefix-guarded
like `request-history-routes.ts:47`, chained into `src/server/management-api.ts:220` with a
lazy import mirroring `handleLabRoutesOnDemand` (`:121`).

The lazy import is mandatory, not stylistic. `src/server/management-api.ts` is the FOURTH
entry in the protected set at `tests/core-lab-boundary.test.ts:25`, added precisely because
eagerly importing handlers there put ~70 modules on every dashboard request. A static import
would make this subsystem the next instance of that bug, and the boundary walker
deliberately does not follow `import()` edges (`tests/core-lab-boundary.test.ts:76`), so
lazy loading is the sanctioned remedy rather than a way around the guard.
Returns `{ enabled, events: QuotaResetEvent[] }` via `jsonResponse`. Auth is inherited from
`requireManagementAuth` at `src/server/index.ts:1016` — a GET route adds no auth code of
its own, and this one spends no user identity.

## NEW CLI subcommand

`ocx provider resets [--limit N] [--json]`, added to the `provider-runtime.ts:179` handler
map and `src/cli/registry.ts` usage text. Renders one line per event —
NOT via `summaryLines`, which is a depth-1 flattener that collapsed a whole report to
"N item(s)" in #2565 (`src/cli/provider-runtime.ts:118`).

## NEW `tests/quota-reset-notify.test.ts`

- absent config -> `isQuotaResetNotificationEnabled() === false`; enabled with no sink -> false
- `kinds: ["surprise"]` drops a scheduled event and keeps a surprise one
- webhook sink receives exactly one POST whose parsed body has no `@`, no `/Users/`, and no
  `accountId` key
- a throwing webhook returns `ok: false` with a closed-union reason and does not reject
- a blocked private destination is refused with `"blocked-destination"` unless
  `allowPrivateNetwork`
- a webhook failure does not prevent the command sink from running
- invalid `quotaResetNotify` in config leaves `providers` intact (the `.catch(undefined)`
  guarantee) and the write path rejects it
- `GET /api/quota-resets` returns recorded events and requires management auth

## Accept criteria

All wp2-wp4 suites green, `bun x tsc --noEmit` 0, `bun run privacy:scan` 0,
`bun test tests/core-lab-boundary.test.ts` 0. Activation evidence: the captured webhook
body from a fired surprise event.
