---
title: Telemetry and Privacy
description: Anonymous daily usage statistics, consent and agent boundaries, opt-out controls, payload preview, and collector retention.
---

opencodex includes anonymous, daily usage telemetry so maintainers and the community can see which
versions, platforms, install channels, provider kinds, and coarse model families are used in
practice and where request failures occur. Project-wide daily aggregates (active and new install
counts, a 365-day active-install heatmap, active minutes, request outcomes, five-bucket token
totals, daily and range provider-kind and model-family shares, top-50 version counts, OS/CPU
platform and install-channel counts, and error-cause counts) are served publicly by the
collector's read-only `GET /v1/stats` endpoint for the public project dashboard; per-day install
hashes (`installDayHash`) and rate-limit hashes (`ip_hash`) are never returned by `/v1/stats`.

Telemetry is **on by default**, and **nothing is sent until a person has seen the notice**.

## How consent and the default-on rule work

A fresh install — or an existing install that updates into a release with telemetry and has no
saved decision — starts in the `awaiting-notice` state. While in `awaiting-notice`, the proxy
sends no telemetry.

Sending becomes active only after a person has seen the disclosure or recorded a choice:

1. **Web dashboard popup (`TelemetryConsentCard`)** — opens on a standalone or Home proxy on first
   run or after an update when no decision is recorded and no environment opt-out is set (connected
   Remote Link Child proxies defer telemetry management to their Home proxy). The **Share anonymous
   daily usage statistics** checkbox is pre-checked. Clicking **Continue** saves `decision: "accepted"` (or
   `"declined"` if unchecked) via `PUT /api/telemetry`. Dismissing the dialog with Escape or the
   backdrop records `noticeShownAt` via `POST /api/telemetry/notice` so the default-on state
   applies; because `decision` remains unset, the dialog will appear again on the next dashboard
   load until you click **Continue** or set a choice in **Proxy details**. Merely loading the page
   without interacting with or dismissing the dialog records nothing.
2. **Interactive terminal prompt** — `ocx start`, `ocx init`, and `ocx service install` ask
   `Share anonymous usage statistics? [Y/n]` once when stdin and stdout are interactive TTYs and
   no decision or notice timestamp is recorded. Pressing Enter or `y` records `decision:
   "accepted"`; `n` records `decision: "declined"`.
3. **Explicit enable** — turning on **Share anonymous usage statistics** in the dashboard under
   **Proxy details**, or running `ocx telemetry enable [--json]` outside an agent-driven session,
   records
   `decision: "accepted"`.

`resolveTelemetryStatus` (`src/telemetry/consent.ts`) evaluates effective state in this exact
precedence order:

| Condition (first match wins) | Effective state | Status `reason` |
| --- | --- | --- |
| `OCX_TELEMETRY` is `0`, `false`, `off`, or `no` | Disabled | `env-ocx-telemetry` |
| `DO_NOT_TRACK` is `1`, `true`, or `yes` | Disabled | `env-do-not-track` |
| `telemetry.decision === "declined"` | Disabled | `declined` |
| `telemetry.decision === "accepted"` | Enabled | `accepted` |
| `telemetry.decision` unset and `telemetry.noticeShownAt` set | Enabled | `default-on` |
| `telemetry.decision` unset and `telemetry.noticeShownAt` unset | Disabled | `awaiting-notice` |

## Agent-driven starts never enable telemetry

An AI coding agent or automation harness must never answer the telemetry prompt or acknowledge the
disclosure on your behalf:

- When `ocx start`, `ocx init`, or `ocx service install` runs under an agent or CI environment
  (`CLAUDECODE`, `CODEX_THREAD_ID`, `CURSOR_TRACE_ID`, `CI`, and similar markers checked by
  `isAgentDriven()`), in a non-TTY shell, or as a background service (`OCX_SERVICE=1`), opencodex
  skips the prompt, prints a one-line notice at most once per version (tracked in
  `<OPENCODEX_HOME>/.telemetry-deferred`), and writes **neither** `noticeShownAt` nor `decision`.
  The install stays in `awaiting-notice` and sends nothing until you use the dashboard or an
  outside-agent terminal session yourself.
- `PUT /api/telemetry` and `POST /api/telemetry/notice` require a live human dashboard browser
  session (`hasHumanDashboardSession`). Requests authenticated only with the management admin token
  or a remembered-device session are refused with HTTP `403` (`code: "agent_consent_required"`).
- `ocx telemetry enable` refuses agent-driven callers with `agent_consent_required` and exits with
  status `1`.
- `ocx config set telemetry` and `ocx config unset telemetry` are refused for all callers, and an
  agent-driven `ocx config import` drops any `telemetry` key rather than importing consent.
- Opting out with `ocx telemetry disable`, `OCX_TELEMETRY=0`, or `DO_NOT_TRACK=1` is always
  permitted, including from scripts and agent sessions.

As with GitHub starring, these checks guard the standard CLI and management API paths against
agent harnesses (`AGENT_ENV_VARS`) and admin-token callers; they are paired with the policy rule
that agents running as your local user must never edit `config.json` or mint a loopback session to
record consent on your behalf.

## How to turn telemetry off

You can disable telemetry at any time through any of five controls:

1. **GUI consent popup** — uncheck **Share anonymous daily usage statistics** and click
   **Continue** when the first-run or post-update dialog appears.
2. **Proxy details toggle** — open the [Web Dashboard](/guides/web-dashboard/) Overview page, go to
   the **Telemetry** section under **Proxy details** (`#proxy-telemetry`), and switch off **Share
   anonymous usage statistics**.
3. **CLI command**:

   ```bash
   ocx telemetry disable
   ```

   This writes `"decision": "declined"` to `config.json` and immediately deletes the local
   `<OPENCODEX_HOME>/telemetry-id.json` file.
4. **`OCX_TELEMETRY=0`** — set `OCX_TELEMETRY=0` (or `false`, `off`, `no`, case-insensitive) in the
   proxy environment.
5. **`DO_NOT_TRACK=1`** — set `DO_NOT_TRACK=1` (or `true`, `yes`, case-insensitive) in the proxy
   environment.

Both environment variables override `config.json` immediately without modifying the saved file.
While either variable is set, the dashboard toggle is disabled and names the active variable.

## How to see the exact payload

You can inspect the exact JSON report prepared from your latest completed UTC day before consenting
and at any time afterward:

- **CLI (human-readable + JSON preview)**:

  ```bash
  ocx telemetry status
  ```

- **CLI (machine-readable snapshot)**:

  ```bash
  ocx telemetry status --json
  ```

  This queries `GET /api/telemetry` when the proxy is running and falls back to building the same
  snapshot locally from `config.json` and `usage.jsonl` when the proxy is stopped.
- **Web dashboard** — click **Preview the JSON** inside the first-run/post-update consent dialog
  or beside the **Share anonymous usage statistics** switch in **Proxy details** to view the
  **What is sent** / **Never sent** summary and the exact JSON payload.

Before the first report has been sent — or after telemetry is disabled and `telemetry-id.json` is
removed — no local install ID exists on disk, so `installDayHash` in the preview is shown as 64
zeros (`0000000000000000000000000000000000000000000000000000000000000000`).

## What is collected

Each report covers one completed UTC calendar day (`YYYY-MM-DD`) and is validated by
`validateTelemetryPayloadV1` (`src/telemetry/contract.ts`) before leaving the proxy and again on the
collector. Unknown keys and strings outside the closed vocabularies below are rejected.

Here is a real example payload produced by `buildTelemetryPayloadV1` (`src/telemetry/payload.ts`):

```json
{
  "schemaVersion": 1,
  "batchId": "c2bf1164-d009-4111-a8a6-902d55f727c7",
  "day": "2026-11-06",
  "installDayHash": "456b15e3a95d8665bbd9a40ac2cae49986aec3f03b78b6dd601df49abfc406d4",
  "newInstall": false,
  "env": {
    "version": "2.99.0",
    "releaseChannel": "latest",
    "os": "darwin",
    "arch": "arm64",
    "installChannel": "npm-global"
  },
  "activeMinutes": 312,
  "requests": {
    "completed": 840,
    "failed": 12,
    "incomplete": 3,
    "aborted": 5
  },
  "models": [
    {
      "providerKind": "anthropic",
      "modelFamily": "claude-opus",
      "requests": 400,
      "inputTokens": 184200,
      "cacheReadTokens": 6410000,
      "cacheWriteTokens": 512000,
      "outputTokens": 96400,
      "reasoningTokens": 28100
    },
    {
      "providerKind": "chatgpt",
      "modelFamily": "gpt-6",
      "requests": 460,
      "inputTokens": 210500,
      "cacheReadTokens": 5890000,
      "cacheWriteTokens": 0,
      "outputTokens": 112300,
      "reasoningTokens": 44800
    }
  ],
  "errors": {
    "rate-limit": 7,
    "upstream-fault": 5
  }
}
```

| Field | Contents |
| --- | --- |
| `schemaVersion` | Fixed integer `1`. |
| `batchId` | Random UUID v4 generated when the payload is built. |
| `day` | Completed UTC calendar date (`YYYY-MM-DD`), within the last 7 completed UTC days. |
| `installDayHash` | `sha256(installId + ":" + day)` as 64 lowercase hex characters. Rotates every UTC day. |
| `newInstall` | `true` only on the first report ever sent for the current local `telemetry-id.json`; `false` afterward. |
| `env.version` | Strict semver (`X.Y.Z` or `X.Y.Z-preview.N`) with any `+build` metadata stripped. |
| `env.releaseChannel` | `"latest"` or `"preview"`. |
| `env.os` | `"darwin"`, `"linux"`, `"win32"`, or `"other"`. |
| `env.arch` | `"x64"`, `"arm64"`, or `"other"`. |
| `env.installChannel` | `"npm-global"`, `"pnpm-global"`, `"bun-global"`, `"mise"`, `"standalone"`, `"desktop"`, `"docker"`, `"source"`, or `"unknown"`. |
| `activeMinutes` | Distinct UTC minutes (`0`–`1440`) during `day` in which at least one request was logged in `usage.jsonl`. |
| `requests` | Request counts by closed outcome class: `completed`, `failed`, `incomplete`, and `aborted`. |
| `models` | Up to 64 rows per day, grouped by unique `(providerKind, modelFamily)` pairs from the closed rosters below (if more than 64 pairs occur in a day, the top 63 rows by requests and total tokens are kept and the remaining rows are merged into `"other"` / `"other"`). Multi-attempt `combo` requests attribute each attempt to the underlying provider and model, so `models[].requests` can sum to more than top-level `requests`. Each row reports `requests` and five disjoint token counters — `inputTokens` (uncached input), `cacheReadTokens`, `cacheWriteTokens`, `outputTokens` (non-reasoning output), and `reasoningTokens` — whose sum equals the request's displayed total tokens (`usageDisplayTotalTokens`). |
| `errors` | Counts of non-completed requests keyed by the closed failure-cause roster (`transport-unsent`, `transport-ambiguous`, `upstream-declined`, `rate-limit`, `quota-exhausted`, `credential-rejected`, `policy-refusal`, `parameter-rejected`, `ciphertext-refusal`, `payload-too-large`, `payload-rejected`, `upstream-fault`, `empty-output`, `client-cancelled`, `local-refusal`). |

Closed `providerKind` values (26): `openai`, `chatgpt`, `anthropic`, `claude-subscription`, `google`, `vertex`, `xai`, `deepseek`, `moonshot`, `qwen`, `zai`, `minimax`, `mistral`, `openrouter`, `groq`, `cerebras`, `together`, `fireworks`, `cursor`, `kiro`, `copilot`, `devin`, `ollama`, `lmstudio`, `local-other`, `other`.

Closed `modelFamily` values (19): `gpt-6`, `gpt-5`, `gpt-4`, `o-series`, `codex`, `claude-opus`, `claude-sonnet`, `claude-haiku`, `gemini-3`, `gemini-2`, `grok`, `deepseek`, `qwen`, `kimi`, `glm`, `minimax`, `mistral`, `llama`, `other`.

## What is never collected

opencodex never includes any of the following in telemetry payloads:

- Prompts, completions, reasoning traces, tool arguments, or any request or response bodies.
- API keys, OAuth access or refresh tokens, session cookies, or management/data-plane tokens.
- Account IDs, email addresses, organization identifiers, or billing/plan details.
- User-chosen provider names or keys, custom model IDs outside the closed `modelFamily`
  buckets above (unknown models map to `"other"`), or custom `baseUrl` and proxy URLs.
- Hostnames, local or upstream IP addresses, MAC addresses, hardware serials, working directories,
  or file paths.
- Raw or free-form upstream error messages or stack traces.
- Usage from any UTC calendar day prior to the UTC day on which consent or disclosure was recorded (`formatUtcDay(decidedAt ?? noticeShownAt)`). (The UTC day on which consent or disclosure is recorded is aggregated across the full `00:00`–`24:00` UTC day once that day completes.)

## Storage, retention, and collector source

- **Local install ID and daily hash rotation** — when telemetry sends its first report, the proxy
  creates `<OPENCODEX_HOME>/telemetry-id.json` (mode `0600`) containing a random UUID v4. The raw
  UUID never leaves your machine; each report sends only `sha256(installId + ":" + day)`. Because
  the UTC date is hashed together with the UUID, an installation's hash changes every day and
  cannot be linked across days on the server. Disabling telemetry deletes `telemetry-id.json`
  immediately, and re-enabling later generates a new UUID.
- **Background schedule and no backfill** — an unref'd background timer (`src/telemetry/scheduler.ts`)
  runs once after startup (30–60 s jitter) and every 6 hours thereafter, completely off the request
  path. Each tick re-reads `config.json` from disk and sends at most **one** completed UTC day per
  tick (oldest unsent day first, within the last 7 completed UTC days) to
  `https://telemetry.opencodex.me/v1/events` with a 10-second timeout. Earlier UTC calendar days
  (`day < formatUtcDay(decidedAt ?? noticeShownAt)`) are never sent, while the full UTC calendar day
  on which consent or disclosure is recorded becomes eligible once that day completes. Sent day
  markers in `<OPENCODEX_HOME>/telemetry-state.json` are pruned after 30 days. If the collector is
  not yet deployed or is unreachable, the 10-second send attempt fails quietly in the background
  without affecting proxy traffic or advancing `telemetry-state.json` (marking the day as sent).
- **One report per install per day** — the collector deduplicates on `(day, install_day_hash)` in a
  single atomic conditional D1 batch across `daily_installs`, `daily_totals`, `daily_models`, and
  `daily_errors`. Re-sending the same day for the same `installDayHash` is a no-op and never
  double-counts.
- **No IP addresses stored** — the collector never stores raw client IP addresses. Ingest rate
  limiting (30 reports per hour) hashes the client IP with a mandatory secret salt and the current
  UTC hour (`sha256(RATE_LIMIT_SALT + "\0" + bucketHour + "\0" + ip)`) in `rate_limits`, and an
  hourly scheduled job (`15 * * * *`) deletes `rate_limits` buckets older than 2 hours.
- **Daily aggregate retention** — `daily_installs` rows (which hold only the per-day hash, version,
  release channel, OS, CPU architecture, install channel, `new_install`, and `active_minutes`) are
  pruned after 400 days; `daily_totals`, `daily_models`, and `daily_errors` hold only project-wide
  daily counters with no per-install rows and are retained indefinitely.
- **Auditable source code** — the client implementation lives in
  [`src/telemetry/`](https://github.com/lidge-jun/opencodex/tree/main/src/telemetry) and the
  Cloudflare Worker + D1 collector lives in
  [`services/telemetry-collector/`](https://github.com/lidge-jun/opencodex/tree/main/services/telemetry-collector).
  For the `config.json` schema and environment variables, see
  [Server and Runtime Configuration](/reference/configuration/server/#telemetry-telemetry).
