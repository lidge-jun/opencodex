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
collector's read-only `GET /v1/stats` endpoint for the [public project dashboard](/dashboard/); per-day install
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
   daily usage statistics** checkbox is pre-checked. Clicking **Continue** saves `decision: "accepted"`
   (or `"declined"` if unchecked), `decidedAt`, and `noticeShownAt` via `PUT /api/telemetry`.
   Dismissing the dialog with Escape, the backdrop, or the close button — or merely loading the page
   without clicking **Continue** — records **nothing** (`decision` and `noticeShownAt` stay unset,
   and there is no notice-only endpoint). While undecided, the popup returns on the next app start
   or dashboard load until you click **Continue** or record a choice in **Proxy details** or the CLI.
2. **Interactive terminal prompt** — `ocx start`, `ocx init`, and `ocx service install` first print
   a disclosure block (what is sent, what is never sent, that project-wide aggregates are public at
   `opencodex.me/dashboard`, how to inspect the exact payload with `ocx telemetry status --json`,
   and how to turn telemetry off with `ocx telemetry disable`, `OCX_TELEMETRY=0`, `DO_NOT_TRACK=1`,
   or the **Proxy details** toggle) and then ask `Share anonymous usage statistics? [Y/n]` once when
   both stdin and stdout are interactive TTYs (`isatty`), `OCX_SERVICE` is unset, and `isAgentDriven()`
   is false. Pressing Enter or `y` records `decision: "accepted"` (plus `decidedAt` and `noticeShownAt`);
   `n` records `decision: "declined"`.
3. **Explicit enable** — turning on **Share anonymous usage statistics** in the dashboard under
   **Proxy details** records `decision: "accepted"` right away (the panel already shows what is sent).
   Running `ocx telemetry enable [--json]` in an interactive human terminal (where both stdin and
   stdout are TTYs, not `OCX_SERVICE`, and not `isAgentDriven()`) prints the same disclosure block,
   asks the `[Y/n]` confirmation prompt (default yes), and records `decision: "accepted"` when
   confirmed.

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
- `PUT /api/telemetry` requires a live human dashboard browser session (`hasHumanDashboardSession`).
  Requests authenticated only with the management admin token or a remembered-device session are
  refused with HTTP `403` (`code: "agent_consent_required"`).
- `ocx telemetry enable` requires an interactive human terminal (`isatty` on both stdin and stdout,
  not `OCX_SERVICE`, and not `isAgentDriven()`). Otherwise it exits non-zero (`1`) with
  `agent_consent_required` or `tty_required` and directs you to the dashboard.
- `ocx config set telemetry` and `ocx config unset telemetry` are refused for all callers, and
  `ocx config import` ignores any imported `telemetry` block for every caller and preserves the
  persisted `telemetry` configuration unchanged.
- Opting out with `ocx telemetry disable`, `OCX_TELEMETRY=0`, or `DO_NOT_TRACK=1` is always
  permitted, including from scripts and agent sessions.

As with GitHub starring, these checks guard the standard CLI and management API paths against
agent harnesses (`AGENT_ENV_VARS`) and admin-token callers; they are paired with the policy rule
that agents running as your local user must never edit `config.json` or mint a loopback session to
record consent on your behalf.

## How to turn telemetry off

You can disable telemetry at any time through any of these controls:

1. **Windows installer** — the MSI has a page with this summary, a link to the
   [privacy statement](/reference/code-signing/#privacy), and a **Send anonymous usage statistics**
   checkbox, checked by default. Clear it, or pass `OCX_TELEMETRY_CHOICE=optout` to a silent
   `msiexec /qn` install, and the desktop app saves `"decision": "declined"` the first time each
   account on the computer starts it, before it resolves or starts any proxy (on a fresh install the
   decline is held in `telemetry-state.json` until a `config.json` exists, so `ocx init` still runs
   setup). The choice is recorded for the whole computer, so it also covers a silent install run by
   an administrator or a deployment tool, and in-app updates keep it (only `send` keeps telemetry on;
   `optout` in any letter case, or any other value, turns it off). Each opt-out applies once per
   account: running a newer installer and continuing
   without changing the box keeps the earlier decision as it was, so it is not applied again over a
   choice you made in the dashboard since. If the save fails, a proxy the app starts runs with
   `OCX_TELEMETRY=0`, and the app retries in the background and on the next launch. Leaving the box
   checked does not start sending by itself, and never turns telemetry back on for an account that
   turned it off; the popup below still appears first. A background service from
   `ocx service install` can start a proxy at logon without the app, so an opt-out recorded by a
   later installer reaches it the next time the app starts; run `ocx telemetry disable` to stop it
   at once.
2. **GUI consent popup** — uncheck **Share anonymous daily usage statistics** and click
   **Continue** when the first-run or post-update dialog appears.
3. **Proxy details toggle** — open the [Web Dashboard](/guides/web-dashboard/) Overview page, go to
   the **Telemetry** section under **Proxy details** (`#proxy-telemetry`), and switch off **Share
   anonymous usage statistics**.
4. **CLI command**:

   ```bash
   ocx telemetry disable
   ```

   This writes `"decision": "declined"` to `config.json` and, once that decline is durably
   persisted, deletes `<OPENCODEX_HOME>/telemetry-id.json`. If `mutatePersistedConfig` returns
   `unavailable` or throws during `ocx telemetry enable` or `ocx telemetry disable`, the CLI exits
   non-zero with an actionable error, prints no success line, and does not delete
   `telemetry-id.json` unless the decline persisted.
5. **`OCX_TELEMETRY=0`** — set `OCX_TELEMETRY=0` (or `false`, `off`, `no`, case-insensitive) in the
   proxy environment.
6. **`DO_NOT_TRACK=1`** — set `DO_NOT_TRACK=1` (or `true`, `yes`, case-insensitive) in the proxy
   environment.

The two environment variables only reach a proxy that inherits them. A proxy run as a background
service (systemd, launchd or Task Scheduler, through `ocx service install`) does not see variables
exported in your interactive shell; set them in the service's own environment, or use one of the
persistent controls above. `ocx telemetry status` asks the running proxy, so it shows the state that
proxy actually uses.

Both environment variables override `config.json` immediately without modifying the saved file.
Whenever `OCX_TELEMETRY` or `DO_NOT_TRACK` opt-out is observed — at proxy startup in
`src/server/background-lifecycle.ts` (even though the scheduler timer is not started) and on every
scheduler tick — opencodex also persists `ineligibleThroughDay` set to today's UTC day (`YYYY-MM-DD`)
and an `envOptOutActiveSince` marker in `<OPENCODEX_HOME>/telemetry-state.json` via an atomic no-follow
write and deletes `<OPENCODEX_HOME>/telemetry-id.json`. A proxy started with the variable reads it
once, so the marker covers every day that proxy keeps running. The opt-out period ends when that
proxy stops cleanly, or, if it crashed, at the first scheduler tick without the variable; either way
`ineligibleThroughDay` moves to that day. If you later remove the environment variable, no day the
opt-out covered is ever sent, including the day it ended, and a fresh install ID is minted on the next
eligible send. While either variable is set, the dashboard toggle is disabled and
names the active variable.

## How to see the exact payload

`GET /api/telemetry` and `ocx telemetry status [--json]` build `preview` for the **same completed UTC
day the scheduler would send next** (the oldest eligible unsent UTC day within the 7-day window, with
`previewEligible: true`). When no completed UTC day is currently eligible to be sent (for example
before consent is given, on the UTC day consent was recorded, while disabled, or when all eligible
days have already been sent), the snapshot previews the latest completed UTC day for inspection and
returns `previewEligible: false` so it never implies that day will be sent:

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
| `env.version` | Version matching `^\d+\.\d+\.\d+(-preview\.\d{8}(\.\d+)?)?$` (for example `2.40.1`, `2.6.15-preview.20260701`, `2.6.15-preview.20260701.1`, or `2.7.9-preview.20260712.2`); any `+build` metadata is stripped by the client and rejected by `validateTelemetryPayloadV1`. |
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
- Usage from the UTC calendar day on which consent or disclosure was recorded (`formatUtcDay(decidedAt ?? noticeShownAt)`) or any earlier UTC day — only completed UTC calendar days strictly after the consent/disclosure day (`day > formatUtcDay(decidedAt ?? noticeShownAt)`) are ever sent.
- Usage from any UTC calendar day covered by an `OCX_TELEMETRY=0` or `DO_NOT_TRACK=1` opt-out, including every day a proxy started with it kept running and the day the opt-out ended (`day <= ineligibleThroughDay`, and nothing at all while `envOptOutActiveSince` is set).

## Public profile and rank (opt-in)

Separately from the anonymous telemetry above, you can connect a **public profile** to appear on the
[leaderboard](/dashboard/#leaderboard) and see where your own usage ranks over the last day, week and month. It
is off unless you connect it yourself, and it never changes your anonymous telemetry choice; connecting
needs anonymous telemetry to be on, because the profile's totals come from the same local daily aggregate.

- **Connect** from the *Public profile & rank* card on the dashboard Home, or with
  `ocx telemetry profile connect --handle <handle> [--name <display name>] [--avatar <colour>]` in an
  interactive terminal (the prompt defaults to no). You choose a handle (3–24 lowercase letters, digits or
  hyphens), a display name and an avatar colour from a fixed palette. No e-mail address or account is asked
  for. The collector returns a secret that the proxy stores in `<OPENCODEX_HOME>/telemetry-profile.json`
  (mode `0600`); it is never shown, printed or returned by the dashboard API, and the collector keeps only
  its SHA-256 hash. Like the telemetry decision, connecting is refused for agents
  (`agent_consent_required`), non-interactive terminals (`tty_required`) and remembered dashboard
  sessions.
- **What is public**: the handle, display name and colour, your rank, and per day the request count, the
  five token buckets and per-model-family request and token totals (the closed `modelFamily` list).
  The collector's profile and leaderboard responses carry `x-robots-tag: noindex`; the
  [dashboard](/dashboard/#leaderboard) page renders them in the browser and is itself a public page.
- **What is sent**: once per completed UTC day strictly after the day you connected, at most one day per
  tick and no more than 7 days back, `POST /v1/profiles/me/days` with exactly those totals. Profile
  submissions carry no install ID, install-day hash, batch ID, version, platform, install channel, provider
  name or kind, error, prompt, output, key, account or path, and run on their own timer. Nothing is sent
  while anonymous telemetry is off (`OCX_TELEMETRY=0`, `DO_NOT_TRACK=1`, declined or awaiting the notice);
  the profile stays connected and resumes when telemetry is on again.
- **See it**: `ocx telemetry profile status` shows the profile, a summary of the next day it would send, and
  your ranks; `ocx telemetry profile status --json` includes the exact payload as `preview`. The card shows the
  profile and ranks.
- **Disconnect** at any time, from the card or with `ocx telemetry profile disconnect` (always allowed,
  including for agents, with the proxy stopped and with telemetry off). It deletes the profile and every day
  submitted for it on the collector. If the collector cannot be reached, the deletion stays pending, nothing
  more is sent, and the proxy retries on every tick and on its next start. Disconnecting and connecting again
  is also how to replace the secret.
- **Ranking**: for each period the collector ranks profiles with a positive total using standard
  competition ranking (ties share a rank). Totals are self-reported and checked for consistency and daily
  limits, each day is accepted once, and the first submission for a day wins.
- **Abuse controls**: reserved handles, display names of 1–32 letters, digits, spaces and `. _ ' -` that cannot
  look like a web address, five profile
  creations per network per hour, per-profile submission limits, profiles that never submit are removed after
  14 days, and maintainers can hide a profile from every public view.
- **Sign-in with GitHub** is not available yet: it needs a GitHub OAuth app that the maintainers have not
  created.

## Storage, retention, and collector source

- **Local install ID and daily hash rotation** — when telemetry sends its first report, the proxy
  creates `<OPENCODEX_HOME>/telemetry-id.json` (mode `0600`) containing a random UUID v4. The raw
  UUID never leaves your machine; each report sends only `sha256(installId + ":" + day)`. Because
  the UTC date is hashed together with the UUID, an installation's hash changes every day and
  cannot be linked across days on the server. Declining telemetry or running with `OCX_TELEMETRY=0`
  or `DO_NOT_TRACK=1` deletes `telemetry-id.json` immediately, and re-enabling later generates a new
  UUID.
- **Streaming single-day aggregation** — `src/telemetry/aggregate.ts` scans `usage.jsonl` through
  `scanUsageLedgerCooperatively` and accumulates counters inside the `onEntry` callback for the
  target UTC day only; it never retains ledger rows in memory.
- **Background schedule and no backfill** — an unref'd background timer (`src/telemetry/scheduler.ts`)
  runs once after startup (30–60 s jitter) and every 6 hours thereafter (with jitter), completely off
  the request path. Each tick carries an `AbortSignal` cancelled on shutdown (`stopProcessLoops`) or
  when consent changes (`nudgeTelemetryScheduler`), re-reads `config.json` from disk, and sends at
  most **one** completed UTC day per
  tick (oldest unsent day first, within the last 7 completed UTC days) to
  `https://telemetry.opencodex.me/v1/events` with a 10-second timeout. Only completed UTC calendar
  days strictly after the consent/disclosure UTC day (`day > formatUtcDay(decidedAt ?? noticeShownAt)`)
  and strictly after `ineligibleThroughDay` (`day > ineligibleThroughDay`) are ever sent. Immediately
  before transmission, the scheduler re-reads persisted consent and environment variables and aborts
  without sending if telemetry is no longer effective. If the collector returns HTTP `429` or `503`,
  the client persists `retryAfterUntil` in `<OPENCODEX_HOME>/telemetry-state.json` and skips ticks
  until that time: it honors a `Retry-After` header when present and otherwise backs off about 15–20
  minutes. Sent day markers in
  `telemetry-state.json` are pruned after 30 days. If the collector is not yet deployed or is
  unreachable, the 10-second send attempt fails quietly in the background without affecting proxy
  traffic or marking the day as sent.
- **One report per install per day** — the collector deduplicates on `(day, install_day_hash)` in a
  single atomic conditional D1 batch across `daily_installs`, `daily_totals`, `daily_models`, and
  `daily_errors`. Re-sending the same day for the same `installDayHash` is a no-op and never
  double-counts.
- **Salted hourly hash for rate limiting (no raw IP addresses stored)** — the collector never
  stores raw client IP addresses. For abuse rate limiting (**120 reports per hour** per key, sized
  for shared NAT / CGNAT addresses and returning HTTP `429` with `Retry-After`), ingest hashes a
  key derived only from Cloudflare's `cf-connecting-ip` (an IPv4 address as is, an IPv6 address
  collapsed to its /64 prefix so one host cannot rotate past the limit; `x-forwarded-for` is
  ignored) with a mandatory secret salt and the current UTC hour
  (`sha256(RATE_LIMIT_SALT + "\0" + bucketHour + "\0" + key)`) in `rate_limits`, and an hourly
  scheduled job (`15 * * * *`) deletes each bucket within about 2 hours 15 minutes of its hour.
- **Install-days, small-cohort protection, and unauthenticated self-reported figures** — because
  `installDayHash` rotates every UTC day, `totals.activeInstalls` and the `installs` count in each
  breakdown of `GET /v1/stats` measure **install-days** (the sum of daily reporting installs across
  the selected range), while `totals.avgDailyActiveInstalls` reports `install-days / days in range`
  rounded to 1 decimal place (shown on the dashboard as **Avg daily active installs** with
  install-days in the tooltip). Small-cohort protection is applied per day, on distinct installs:
  a breakdown row (`providers`, `models`, `versions`, `platforms`, `channels`, `errors`, and each
  day of `dailyByProvider`) includes a day's value for a key only when at least **10 distinct
  installs** reported that key on that day, before days are summed into the selected range. One
  install therefore cannot reach the threshold alone by reporting on many days or through many
  providers or model families (`daily_models`, `daily_errors`, `daily_provider_installs` and
  `daily_family_installs` count each report once per key). Version, platform and channel rows below
  the threshold fold into that day's `"other"`, published only if it reaches 10; provider, model
  and error rows below it are dropped. `totals`, `daily`, and `heatmap` stay unfiltered, so a
  suppressed value can still be approximated by subtraction from the published totals. In addition,
  reports to
  `POST /v1/events` are **unauthenticated** and can be forged within the per-key rate limit and
  payload bounds. Forged reports can also lift a real install over the threshold: 9 forged reports
  for a rare key on the same day as one real install make 10 distinct installs, and the sender can
  subtract their own share to recover that install's figures for the key. The install stays
  anonymous, and the rate limit raises the cost without preventing it. The public dashboard
  therefore labels all figures
  **"self-reported by opencodex installs"**.
- **Daily aggregate retention** — `daily_installs` rows (which hold only the per-day hash, version,
  release channel, OS, CPU architecture, install channel, `new_install`, and `active_minutes`) are
  pruned after 400 days; `daily_totals`, `daily_models`, and `daily_errors` hold only project-wide
  daily counters with no per-install rows and are retained indefinitely.
- **Collector-first contract rollout and auditable source code** — the client implementation lives in
  [`src/telemetry/`](https://github.com/lidge-jun/opencodex/tree/main/src/telemetry) and the
  Cloudflare Worker + D1 collector lives in
  [`services/telemetry-collector/`](https://github.com/lidge-jun/opencodex/tree/main/services/telemetry-collector).
  Both import the closed rosters in `src/telemetry/contract.ts`, so any roster or wire-contract
  addition follows a **collector-first** rollout (deployed to the collector before a client release
  emits it).
  For the `config.json` schema and environment variables, see
  [Server and Runtime Configuration](/reference/configuration/server/#telemetry-telemetry).
