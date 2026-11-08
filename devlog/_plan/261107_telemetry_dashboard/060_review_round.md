# 060 — PR review round 1

Review feedback on the stack (#8293, #8300, #8303, #8304, #8305, #8308) from Ingwannu, CodeRabbit and the
Codex reviewer. These decisions supersede any conflicting text in 000–050. Each lands on the layer that
owns the code, and each layer's PR description records it.

## Why the privacy statement changes (blocking)

`README.md` (and its seven translations under `readme/`) and `docs-site/src/content/docs/reference/code-signing.md`
carry the SignPath Foundation sentence "This program will not transfer any information to other networked
systems unless specifically requested…". With default-on telemetry that sentence would be false. SignPath's
conditions (https://signpath.org/terms.html) allow software that sends data to systems the user did not
specify only if the behaviour is described in a privacy policy, shown during installation, and can be
disabled at installation. The replacement statement (D12) says exactly that, lands on layer 2 (the first
layer that can send), and layer 5 links it to the telemetry guide.

## SignPath conditions

SignPath Foundation's conditions (https://signpath.org/terms, read 2026-11-08), "Respect user privacy and
security": "Software that collects user data and transfers it to systems not specified by the user must
a) describe this behavior in a privacy policy, b) display this policy during installation and c) include
installation options to disable these functions." Its website condition allows either a privacy-policy link
or the "will not transfer" sentence.

(a) is met by the D12 statement. (b) and (c) are not clearly met. SignPath signs the standalone `ocx.exe`,
which has no installer, and the MSI, whose installer shows no policy and has no disable option. The CLI
prompt and the dashboard popup appear on first run, after installation. The release workflow still uses the
`test-signing` policy, so no production-signed build exists yet. Round 1 treated first-run disclosure as
"during installation"; that reading is not confirmed.

Owner decision (2026-11-08), D21: telemetry stays default-on and the stack satisfies all three:

- (a) The D12 privacy statement (README and translations, code-signing page in English and Turkish,
  `SPONSORS.md`) and the layer 5 guide describe exactly what is sent and how to opt out.
- (b, c) MSI: a new layer between 2 and 3 adds an installer page generated from
  `src/telemetry/disclosure.ts`, the same text the CLI prompt prints. It links the policy and has a
  "Send anonymous usage statistics" checkbox, checked by default. Unchecked, the choice is recorded in
  HKCU and the desktop app persists `telemetry.decision = "declined"` into the user's config before it
  resolves, attaches to or starts any proxy. Tests pin the dialog text source and the persisted opt-out.
- (b, c) Standalone `ocx.exe` and npm installs have no installer: nothing is sent before
  `noticeShownAt`, and the notice (the CLI prompt or the GUI popup) shows the policy summary and offers
  disabling at that moment. A test proves zero sends before `noticeShownAt`.

Layers that can send (2 and above) merge only after the installer layer and the zero-send test are in
the stack and have passed their reviews and CI.

## Decisions

D1 Consent-day cutoff: only UTC days strictly AFTER the UTC day of (decidedAt ?? noticeShownAt) are ever sent.
D2 Env opt-out: whenever OCX_TELEMETRY or DO_NOT_TRACK opt-out is observed (proxy startup in background-lifecycle even though the scheduler is not started, and on every tick), persist ineligibleThroughDay = today's UTC day and an envOptOutActiveSince marker in telemetry-state.json (atomic no-follow write) and delete the install id; only days strictly after ineligibleThroughDay are sent. A proxy started under the opt-out reads the env once and runs no ticks, so the marker covers the whole time it runs: while it is set nothing is eligible, and the period closes (ineligible through the closing day, marker cleared) on that proxy's clean stop or on the first tick without the opt-out. Tests: consented user runs with OCX_TELEMETRY=0 for days, removes it, those days are never sent and a fresh id is minted; a proxy that runs opted out from Monday to Thursday, ended by a crash and by a clean stop, never lets those days be sent (failing-first in layer 2).
D3 Version regex everywhere (contract): ^\d+\.\d+\.\d+(-preview\.\d{8}(\.\d+)?)?$ ; test vectors 2.40.1, 2.6.15-preview.20260701, 2.6.15-preview.20260701.1, 2.7.9-preview.20260712.2; reject build metadata.
D4 ocx telemetry enable: requires an interactive human terminal (isatty stdin AND stdout, not OCX_SERVICE, not isAgentDriven); prints the disclosure block, then asks a confirm (default yes) and records accepted; otherwise exits non-zero with agent_consent_required / tty_required pointing to the dashboard. disable always allowed.
D5 Disclosure block printed before every CLI Y/n prompt (ocx start/init/service install and enable): what is sent, what is never sent, that aggregates are public at opencodex.me/dashboard, how to see the exact payload (ocx telemetry status --json), how to turn it off (ocx telemetry disable, OCX_TELEMETRY=0, DO_NOT_TRACK=1, Proxy details toggle). A CLI test pins the text.
D6 ocx config import: for EVERY caller, preserve the persisted telemetry block unchanged (ignore imported telemetry). Tests: undecided and declined installs.
D7 Re-read persisted consent and env immediately before transmission; if not effective, abort without sending. Ticks carry an AbortSignal cancelled by stop and by consent changes (nudge).
D8 Aggregation accumulates counters inside onEntry for the target day only; never retains ledger rows.
D9 CLI enable/disable: if mutatePersistedConfig returns unavailable (or throws), exit non-zero with an actionable error, print no success line, and do not delete the id unless the decline persisted.
D10 GET /api/telemetry preview uses the same day the scheduler would send next (oldest eligible unsent day). If none is eligible, preview the latest completed day and return previewEligible:false (field added); never imply it will be sent.
D11 Client honors HTTP 429 Retry-After (and 503): persist retryAfterUntil in telemetry-state.json, skip ticks until then; spreads sends with jitter.
D12 Privacy statement (README.md, all 7 readme/README.*.md, docs-site/src/content/docs/reference/code-signing.md and its tr copy, SPONSORS.md): replace the SignPath "will not transfer any information..." sentence with an accurate statement: opencodex sends one anonymous daily usage summary (version, platform, counts; never prompts, outputs, keys, accounts, hosts or paths) to telemetry.opencodex.me only after the person installing or operating it has seen the notice (dashboard popup or interactive CLI prompt) and has not declined; it can be turned off at install time in that prompt and anytime with ocx telemetry disable, OCX_TELEMETRY=0, DO_NOT_TRACK=1 or Proxy details; project-wide aggregates are public; otherwise data goes only where the user configures. Keep the README Privacy line in English in every translation (as today) unless readme/i18n-manifest.json rules require otherwise. code-signing.md: also fix the "carry none of your ... usage data" claim.
D13 GUI popup dismissal (Escape/backdrop/close) records NOTHING; only Continue (PUT /api/telemetry) records decision and notice; the popup returns on the next app start while undecided. Remove POST /api/telemetry/notice entirely (server route, registry entry, capability exemptions, GUI call, tests, docs).
D14 Stats semantics: activeInstalls in totals and installs in breakdowns are INSTALL-DAYS (sum of daily reporting installs); add totals.avgDailyActiveInstalls (install-days / days in range, rounded to 1 decimal). Dashboard shows "Avg daily active installs" as the KPI with install-days in the tooltip.
D15 Small-cohort protection (collector): add an installs column (count of contributing reports) to daily_models and daily_errors (and dailyByProvider derivation); in every breakdown (providers, models, versions, platforms, channels, errors, dailyByProvider per day) fold rows with fewer than 10 install-days in the selected range into "other"; drop "other" if it is itself below 10; totals/daily/heatmap unchanged. Document the residual subtraction risk.
D16 Rate limit: 120 reports/hour per salted IP hash (shared IP / CGNAT capacity); 429 with Retry-After.
D17 Dashboard labels all figures "self-reported by opencodex installs"; docs note reports are unauthenticated and can be forged within rate limits.
D18 Collector-first rollout: any roster/contract change must be deployed to the collector before a client release emits it (README of collector + structure doc).
D19 Guide discloses the salted hourly IP hash for rate limiting (pruned after 2 hours).
D20 Dashboard: GitHub release download totals follow pagination (per_page=100, follow Link rel=next up to 10 pages, mark "partial" if capped); applying an empty snapshot clears the heatmap.


## Finding → decision map

| Finding | Source | Decision | Layer |
| --- | --- | --- | --- |
| Published privacy statement becomes false | Ingwannu (blocking) | D12 | 2, 5 |
| Env opt-out days are backfilled | Ingwannu (blocking) | D2 | 2 |
| Consent day usage before the notice | Ingwannu | D1 | 2 |
| Preview tags rejected by the version regex | Ingwannu | D3 | 2 (contract) |
| activeInstalls over a range is a sum | Ingwannu | D14 | 4, 6 |
| CLI prompt is not a disclosure | Ingwannu | D5 | 2 |
| Opt-in wording | CodeRabbit | title/objective now say default-on (opt-out) | 1 |
| Roster changes break older collectors | CodeRabbit | D18 | 4, 5 |
| `ocx telemetry enable` without a TTY | CodeRabbit | D4 | 2 |
| Imported consent can backdate sending | CodeRabbit | D6 | 2 |
| Identity kept under an env opt-out | CodeRabbit | D2 | 2 |
| Preview day differs from the next send | CodeRabbit | D10 | 2, 3 |
| Automated dismissal records the notice | CodeRabbit | D13 | 2, 3 |
| Atomic dedup and rollup | CodeRabbit | already in #8304 (single conditional batch) | 4 |
| Forged reports | CodeRabbit | D17 (labelled self-reported; rate limit) | 4, 5, 6 |
| More than 64 model rows | CodeRabbit | already folded into `other`/`other` in #8300 | 2 |
| Shared-IP capacity and Retry-After | CodeRabbit | D11, D16 | 2, 4 |
| Small-cohort exposure | CodeRabbit | D15 | 4, 6 |
| IP-hash disclosure | CodeRabbit | D19 | 5 |
| Consent re-check before sending | Codex P1 | D7 | 2 |
| Aggregation keeps the whole ledger | Codex P2 | D8 | 2 |
| CLI reports unpersisted changes | Codex P2 | D9 | 2 |
| Public docs for the controls | Codex P1 (#8300, #8303) | already in #8305 | 5 |
| Release pagination, heatmap reset | Codex P2 (#8308) | D20 | 6 |

## Residual risks

- Reports are unauthenticated. Rate limits and the self-reported label bound, but do not prevent, forged
  figures.
- Folding small rows into `other` limits single-install exposure; a suppressed value can still be
  approximated by subtracting published rows from published totals when only one row is folded.
