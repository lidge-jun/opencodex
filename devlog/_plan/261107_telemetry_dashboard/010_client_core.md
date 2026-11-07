# 010 — Client telemetry core

Stack layer 2. Everything the proxy needs to decide, build, preview and send a daily report, the
management API and CLI that later layers use, the shared wire contract, and the structure doc that
claims the new `src/` area. Anchors were read on `c61e957900`.

## Shared wire contract (`src/telemetry/contract.ts`)

An **import-free** module (same rule as `src/usage/telemetry-contract.ts`) holding the closed rosters
and the payload validator: `TELEMETRY_SCHEMA_VERSION = 1`, `PROVIDER_KINDS`, `MODEL_FAMILIES`,
`INSTALL_CHANNELS`, `RELEASE_CHANNELS`, `OS_VALUES`, `ARCH_VALUES`, the outcome classes and the failure
causes (re-declared and pinned equal to `REQUEST_OUTCOME_CLASSES` / `REQUEST_FAILURE_CAUSES` by a test),
and `validateTelemetryPayloadV1(input, now)`. The collector (030) imports this file directly, so the
client cannot emit a key or value the collector rejects and the two cannot drift.

- `PROVIDER_KINDS` (vendor-level, closed): openai, chatgpt, anthropic, claude-subscription, google,
  vertex, xai, deepseek, moonshot, qwen, zai, minimax, mistral, openrouter, groq, cerebras, together,
  fireworks, cursor, kiro, copilot, devin, ollama, lmstudio, local-other, other. The client maps a
  provider's registry preset to a kind; custom/unknown providers become `other`. User-chosen provider
  keys, labels and base URLs are never read into the payload.
- `MODEL_FAMILIES` (closed prefix buckets): gpt-6, gpt-5, gpt-4, o-series, codex, claude-opus,
  claude-sonnet, claude-haiku, gemini-3, gemini-2, grok, deepseek, qwen, kimi, glm, minimax, mistral,
  llama, other.
- `version` must match `^\d+\.\d+\.\d+(-preview\.\d{8}(\.\d+)?)?$` (no build metadata).

## State model

Type `OcxTelemetryConfig` lives in a new `src/types/telemetry.ts`; `src/types/config.ts` (1996 lines,
ratchet threshold 2000) gains exactly one import line and one field line, or an existing block moves
out first if the count says otherwise. Schema in `src/config/schema/config-schema.ts` as
`telemetryConfigSchema.optional().catch(undefined)`, strict live-write validation in
`src/config/diagnostics.ts`, load-degrade warning in `src/config/load-degrade.ts`, baseline adoption
`adoptPersistedTelemetry` in `src/config/live-reconcile.ts`.

```ts
type OcxTelemetryConfig = {
  decision?: "accepted" | "declined";   // absent = undecided
  decidedAt?: string;                   // ISO
  noticeShownAt?: string;               // a human saw the disclosure (GUI or interactive TTY)
};
```

There is **no persisted endpoint**: the collector URL is the constant
`https://telemetry.opencodex.me/v1/events` in `sender.ts` with a test-only injection seam.

`resolveTelemetryStatus(config, env)` (`src/telemetry/consent.ts`):

| Condition (first match) | `effective` | `reason` |
| --- | --- | --- |
| `OCX_TELEMETRY` ∈ {0,false,off,no} | false | `env-ocx-telemetry` |
| `DO_NOT_TRACK` ∈ {1,true,yes} | false | `env-do-not-track` |
| `decision === "declined"` | false | `declined` |
| `decision === "accepted"` | true | `accepted` |
| undecided and `noticeShownAt` set | true | `default-on` |
| undecided, no notice | false | `awaiting-notice` |

## Who may change it (agent boundary)

Telemetry is on by default, so the only thing that can switch sending on for an undecided install is
a human seeing the disclosure. Following `AGENTS_INSTALL.md` and `src/cli/star-prompt.ts`:

- An agent-driven start (`isAgentDriven()`, non-TTY, or `OCX_SERVICE=1`) prints a one-line notice at
  most once per version (`.telemetry-deferred` marker in the config dir) and writes **neither**
  `noticeShownAt` nor `decision`. The install stays `awaiting-notice` until a human sees the GUI popup
  or an interactive prompt.
- `PUT /api/telemetry` and `POST /api/telemetry/notice` both require `hasHumanDashboardSession(ctx)`.
- `ocx telemetry enable` refuses with `agent_consent_required` (non-zero exit) when `isAgentDriven()`;
  `ocx telemetry disable` is always allowed (opting out is never a consent risk).
- `src/cli/config-command.ts` `set`/`unset` refuse the `telemetry` key, and `import` drops a
  `telemetry` block when agent-driven, pointing to `ocx telemetry`.
- `AGENTS_INSTALL.md` gains a short "Telemetry" entry in its user-consent list.

## Identity

`src/telemetry/install-id.ts` keeps `<OPENCODEX_HOME>/telemetry-id.json` (`0o600`, exclusive no-follow
create, pattern of `src/quota-pool/identity.ts`), created on the first send and deleted when the
decision becomes `declined`. The raw id never leaves the machine; each report carries
`installDayHash = sha256(installId + ":" + day)` and `newInstall: true` only on the very first report
of a freshly minted id (the collector counts new installs per day, version and channel from it).

## Aggregation (`src/telemetry/aggregate.ts`)

Scans `usage.jsonl` with `scanUsageLedgerCooperatively` (`src/usage/ledger-scanner.ts`) for one
completed UTC day:

- `activeMinutes`: distinct `floor(timestamp / 60000)` values (≤ 1440).
- `requests`: counts per outcome class via `classifyRequestOutcome` (`src/usage/request-outcome.ts`).
- `models`: per (`providerKind`, `modelFamily`) requests and **disjoint** token buckets —
  `inputTokens` = uncached input (`normalizeCostTokens`, `src/usage/cost.ts`), `cacheReadTokens`,
  `cacheWriteTokens`, `outputTokens` = output minus reasoning, `reasoningTokens`. The five sum to the
  display total (`usageDisplayTotalTokens`); a test pins that identity.
- `errors`: counts keyed by failure cause (kebab-case, e.g. `rate-limit`).

## Payload v1

```json
{ "schemaVersion": 1, "batchId": "<uuid>", "day": "2026-11-06", "installDayHash": "<64 hex>",
  "newInstall": false,
  "env": { "version": "2.40.1", "releaseChannel": "latest", "os": "darwin", "arch": "arm64",
           "installChannel": "npm-global" },
  "activeMinutes": 312,
  "requests": { "completed": 840, "failed": 12, "incomplete": 3, "aborted": 5 },
  "models": [ { "providerKind": "anthropic", "modelFamily": "claude-opus", "requests": 400,
                "inputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0,
                "outputTokens": 0, "reasoningTokens": 0 } ],
  "errors": { "rate-limit": 7 } }
```

`installChannel` mapping in `src/telemetry/payload.ts`: `OCX_DESKTOP_SUPERVISED === "1"` → desktop;
container markers (`/.dockerenv`, `/run/.containerenv`) → docker; `detectInstallOwnership().installer`
npm → npm-global, pnpm → pnpm-global, bun → bun-global, mise → mise, standalone → standalone,
source → source; otherwise unknown. Every field is named explicitly in the builder and the result is
run through `validateTelemetryPayloadV1` before sending or previewing.

## Scheduling and sending

- `src/server/background-lifecycle.ts` `startProcessLoops` starts a dormant `.unref()` scheduler via
  `void import("../telemetry/scheduler")…` unless an env opt-out is set; `stopProcessLoops` stops it
  (handle kept in background-lifecycle), and `registerOptionalShutdownHook("telemetry", stop)` covers
  drain. `src/server/index.ts` and `src/cli/index.ts` (1999 lines) are not touched.
- Each tick (startup jitter, then every 6 h) re-reads config passively from disk and re-evaluates
  `resolveTelemetryStatus`, so CLI and GUI changes take effect without a restart. The management
  routes also call `adoptPersistedTelemetry` and nudge the scheduler.
- It sends only completed days on or after the UTC day of `decidedAt ?? noticeShownAt` (no pre-consent
  backfill), at most **one day per tick**, oldest first, at most the last 7 days; 10 s
  `signalWithTimeout`, no in-tick retry. Sent days live in `<OPENCODEX_HOME>/telemetry-state.json`.
- `tests/preload.ts` sets `OCX_TELEMETRY=0` so no test process ever sends.

## Management API

Thin `src/server/management/telemetry-routes.ts` (seen by `management-route-registry.test.ts`)
delegating to `src/telemetry/routes.ts`, lazily namespaced from `src/server/management-api.ts` and
declared in `route-registry.ts`:

- `GET /api/telemetry` → effective/reason/decision/env override, install channel, last sent day,
  `preview` (the exact payload for the latest completed day; hash shown as a placeholder when no id
  exists).
- `PUT /api/telemetry` `{ decision }` — human session only; `exempt: { reason: "session-only" }`.
- `POST /api/telemetry/notice` — human session only, idempotent; `exempt: { reason: "session-only" }`.

## CLI

`src/cli/telemetry.ts`: `ocx telemetry status [--json]` (route `GET /api/telemetry`, falls back to
local status when the proxy is down), `enable` and `disable` (local config mutation, `routes: []`,
`mutates: true`). Capability objects stay plain string/array/object literals (the lexical guard in `tests/helpers/cli-capability-data.ts` rejects `/` tokens and host identifiers). Registered in `capabilities-observe-system.ts`, `registry.ts`, `dispatch.ts`,
`help.ts`; `telemetry` is added to the `observe-system` roots in
`scripts/generate-ocx-skill-surface.ts` and `tests/ci-workflows/skill-ocx-generated.test.ts`, then
`bun run skill:surface`.

Interactive prompt `Share anonymous usage statistics? [Y/n]` (default yes; Enter = yes; records
`decision` and `noticeShownAt`) shown once when undecided, from: `maybeShowStarPrompt()`'s module on
interactive `ocx start` (no new line in `src/cli/index.ts`), `ocx service install` next to its star
prompt (`src/service/cli.ts`), and the end of `ocx init` (`src/cli/init.ts`).

## Ownership

`structure/telemetry.md` registered in `structure/manifest.json` claiming `src/telemetry/`,
`src/types/telemetry.ts`, `src/server/management/telemetry-routes.ts` and `src/cli/telemetry.ts`,
naming only paths that exist in this layer; `bun run structure:index`. The four 600-line structure
docs are not extended.

## Verification

- `tests/usage/usage-telemetry-client.test.ts`: status matrix, env precedence, id file mode and
  deletion, aggregate bucketing and the disjoint-token identity on a fixture ledger, payload validator
  rejects extra keys/unknown roster values/semver metadata, roster parity with the usage contract, no
  pre-consent days, one day per tick, sender timeout, nothing sent when not effective.
- `tests/usage/usage-telemetry-core-boundary.test.ts`: `router.ts`, `lifecycle.ts`,
  `responses/core.ts`, `management-api.ts` have no load-time path to `src/telemetry/`.
- `tests/server/server-telemetry-routes.test.ts`: GET preview; PUT and notice refused with admin token
  and remembered-admin; accepted with a human session; notice idempotent.
- `tests/cli/cli-telemetry.test.ts`: status/enable/disable, enable refused when agent-driven, config
  set refusal, agent-driven start writes no notice, prompt default yes.
- New tests registered in a domain shard (`layout-usage.json` etc.; `layout.json` is at 1999 lines)
  and `tests/fixtures/test-layout-expected.json`.
- `bun run typecheck`, focused files, `bun run test:changed`, `bun run structure:check`,
  `bun run skill:surface:check`, `bun run privacy:scan`, file-size and layout guards,
  `tests/cli/cli-capabilities.test.ts`, `tests/server/management-route-registry.test.ts`.

