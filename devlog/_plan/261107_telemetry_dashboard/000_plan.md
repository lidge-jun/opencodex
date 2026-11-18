# Default-on (opt-out) telemetry and the opencodex.me usage dashboard

## Objective and scope

Add anonymous, default-on (opt-out) product telemetry to the opencodex proxy and a public, project-wide
analytics page at `https://opencodex.me/dashboard`. The proxy reports install/version/platform
pings, active time, request and token totals, and error counts; a collector stores daily
aggregates; the dashboard renders installs, active time, usage, errors and downloads.

Delivery is a manual chain of stacked pull requests, one per work phase below, each based on the
previous layer and the bottom on `dev`. No deploy of the collector, no DNS change, no merge and no
release are part of this unit; those are maintainer actions after review.

The visual and structural reference is [junhoyeo/tokscale](https://github.com/junhoyeo/tokscale)
(MIT): its contribution heatmap, KPI header, client/model breakdown tables, and the
validated aggregate submit API. Patterns are adapted, not vendored; credit lives in the dashboard
footer and in the PR descriptions.

## Owner decisions (2026-11-07)

| Id | Decision |
| --- | --- |
| hosting | Collector is a Cloudflare Worker with D1 at `telemetry.opencodex.me`. The repository ships its code, schema and tests; deployment is a maintainer step. |
| consent | Superseded by default-on. |
| update-popup | An install that updates and has no recorded decision sees the same consent popup once after the update. |
| default-on | Telemetry defaults to **on** (opt-out). The GUI first-run/post-update popup (checkbox pre-checked) and the first interactive `ocx start` (Y/n, default yes) let the user choose. `ocx init` and `ocx service install` ask the same question. An agent-driven start prints a notice and never answers for the user or records the notice. No payload is sent until a person has seen the disclosure. Advanced settings and `ocx telemetry disable` turn it off later. |
| scope | The dashboard is public and project-wide (aggregates only). No per-user profiles or leaderboards. |

## Privacy contract (applies to every layer)

- Effective state: env opt-out (`OCX_TELEMETRY=0` or `DO_NOT_TRACK=1`) → off; decision `declined` → off; `accepted` → on; undecided → on only after `noticeShownAt` is recorded, which only a person can cause (GUI popup seen, interactive TTY prompt answered). An agent-driven start prints a notice but records nothing, so an agent can never switch sending on.
- Identity is a random install id (UUID v4) generated on first send, never derived from
  hardware, accounts, hostnames or paths. Disabling telemetry deletes it; re-enabling mints a new one.
- Payloads carry only closed-vocabulary values and counters: version, OS, arch, install channel,
  provider *kind* (closed vendor roster), coarse model family, closed
  error codes, and integer counts. Never request or response bodies, prompts, model output, API
  keys, OAuth tokens, account ids or e-mails, custom base URLs, hostnames, file paths, or free-form
  error text.
- The exact JSON the next send would contain is visible before consent ("What is sent") and via
  the management API and `ocx telemetry status`.
- The collector stores no IP address and no raw install id: reports carry a per-day install hash,
  rate limiting uses a salted hourly IP hash pruned after two hours, and only the first report per
  install and day counts.
- No backfill: only UTC days strictly after the day of the disclosure or decision are sent, days
  covered by an `OCX_TELEMETRY=0` / `DO_NOT_TRACK=1` opt-out are never sent (060 D2), and at most one
  day is sent per scheduler tick.
- The published privacy statement (README and its seven translations, the docs-site code-signing
  page in English and Turkish, `SPONSORS.md`) describes default-on telemetry and every way to turn it
  off. It changes in layer 2, the first layer that can send, never later (060 D12).
- The collector URL is a constant; it is not configurable from `config.json`.
- Telemetry code stays off the core request path: `src/router.ts`,
  `src/server/lifecycle.ts` and `src/server/responses/core.ts` must not import `src/telemetry/`.
  Aggregates are computed from the existing usage log on a timer, never inline in a request.

## Work phases (stack order)

| Layer | Doc | Thesis |
| --- | --- | --- |
| 1 | this unit | Docs-only roadmap. |
| 2 | [010_client_core.md](010_client_core.md) | Config field, consent state, install id, aggregate builder, payload v1, sender, management API, `ocx telemetry`, `structure/telemetry.md`. |
| 2b | [060_review_round.md](060_review_round.md) D21 | Windows installer page (disclosure, policy link, opt-out checkbox) and the desktop app carrying an installer opt-out into the config. |
| 3 | [020_gui_consent.md](020_gui_consent.md) | First-run card, post-update popup, Advanced toggle, preview dialog, all locales. |
| 4 | [030_collector.md](030_collector.md) | Cloudflare Worker + D1: ingest validation, limits, daily rollups, public stats API. |
| 5 | [040_docs_privacy.md](040_docs_privacy.md) | Telemetry guide, sidebar, configuration reference. |
| 6 | [050_dashboard.md](050_dashboard.md) | Astro page `/dashboard`: heatmap, KPIs, breakdowns, errors, downloads. |

## Verification floor per layer

`bun run typecheck`; focused tests for the layer plus `bun run test:changed`;
`bun run structure:check`, `bun run privacy:scan`, file-size ratchet and test-layout guards for
any layer adding files; `bun run lint:gui` and `bun run build:gui` for layer 3; docs-site build
for layers 5 and 6; `bun run skill:surface:check` when a CLI capability is added. Each layer gets an
independent review before its PR is opened.


## Audit disposition (round 1)

Independent audit (argon, read-only): FAIL with 9 blockers and 6 majors; all accepted and folded.
Agent-driven starts no longer record the notice; the notice and decision routes need a human session;
`ocx telemetry enable` and `ocx config set telemetry` refuse agent-driven use; no persisted endpoint;
no pre-consent backfill and one day per tick; an import-free shared contract module with closed rosters
that the collector imports; strict version regex; `OcxTelemetryConfig` in `src/types/telemetry.ts`
and no edits to `src/cli/index.ts` or `scripts/test-layout/layout.json` (ratchet headroom 0–4 lines);
`telemetry` added to the skill-surface roots; session-only route exemptions; the docs guide now lands
before the dashboard; collector typecheck test; a tick-driven scheduler that re-reads config and stops in
`stopProcessLoops`, with `OCX_TELEMETRY=0` in the test preload; explicit install-channel mapping; GUI
dialog sequencing via `onSettled`, notice only on dismiss, `readOnly`; unified `env` and kebab-case
causes; disjoint token buckets; `TelemetryStatsV1` with `dailyByProvider` and a 365-day heatmap; dedup
on `(day, install_day_hash)`; prompts in `ocx init` and `ocx service install`; sidebar, configuration
reference and both header menus. Goalplan note: work phase wp4 delivers 040 (docs) and wp5 delivers 050
(dashboard).


## Audit disposition (round 2)

Same reviewer: PASS, 0 blockers; all 9 blockers and 6 majors verified resolved. Two minors folded: the
collector `tsconfig.json` overrides `rootDir`/`declaration` (030), and the new capability objects in
`src/cli/capabilities-observe-system.ts` stay plain literals because `tests/helpers/cli-capability-data.ts`
rejects `/` tokens and host identifiers there (010).

## PR review round 1

Reviewer feedback on the open stack is recorded, with owner decisions D1–D21, in
[060_review_round.md](060_review_round.md). Those decisions supersede conflicting text in 000–050, including
the public privacy statement change that must land with the first layer able to send.
