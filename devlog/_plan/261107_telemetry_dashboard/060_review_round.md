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
D15 Small-cohort protection (collector; revised after the round-2 review of #8304): every breakdown (providers, models, versions, platforms, channels, errors, dailyByProvider) publishes a value only for (day, key) pairs reported by at least 10 DISTINCT installs on that day, and applies the threshold before summing days into the range. One install therefore cannot pass it alone by reporting on many days or by spreading usage over many provider/family rows. Distinct per-day counts: daily_installs (one row per install-day) for version/platform/channel; daily_errors.installs (+1 per report per cause); daily_provider_installs and daily_family_installs (+1 per report per provider and per model family, however many daily_models rows the report carries). Single-valued dimensions (version, platform, install channel) fold a day's sub-threshold rows into that day's "other", published only if it reaches 10 on that day; the versions list keeps 49 named rows and folds the tail into "other". Multi-valued dimensions (providers, model families, error causes) drop sub-threshold rows instead of folding them, because a bucket of several such rows can be one install counted several times; a native "other" key needs 10 distinct installs like any key. totals/daily/heatmap unchanged. Document the residual subtraction risk.
D16 Rate limit: 120 reports/hour per salted hourly hash of the client key (shared IP / CGNAT capacity); 429 with Retry-After. The key comes only from cf-connecting-ip: IPv4 per address, IPv4-mapped IPv6 as its IPv4 address, other IPv6 collapsed to its /64 prefix (one subscriber usually holds a whole /64). x-forwarded-for is never consulted; a request without a valid cf-connecting-ip shares one fixed bucket.
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
- The per-day distinct-install threshold keeps one install's numbers out of every breakdown row, but
  totals, daily and heatmap stay unfiltered, so the combined value of suppressed rows can still be
  approximated by subtracting published rows from published totals.
- The rate limit keys IPv6 on the /64, so a client holding a larger prefix (a /48 has 65,536 /64s)
  gets one budget per /64; requests without cf-connecting-ip all share one budget.
- Installs without an installer (the standalone `ocx.exe`, npm) meet SignPath's install-time conditions
  only through the first-run notice (CLI prompt or dashboard popup); D21 accepts that reading.

## Delivery (round 1)

| Layer | Fix commit | Merged upward as |
| --- | --- | --- |
| 1 plan | `3e4597d1ba` | — |
| 2 client core | `9e0284d392` | `64ac26aa7d` (layer 1 merged in) |
| 3 GUI | `5b6092ca14` | `ea8175f2b7` |
| 4 collector | `057c57e8be` | `54019606ff` |
| 5 docs | `d8fc29c2c1` | `4ebb3c1499` |
| 6 dashboard | `ea78acfa0f` | `bed30cf2b7` |

The layer 5 merge conflicted where layers 2 and 5 both rewrote the privacy statement (README, seven
translations, `readme/i18n-manifest.json`, `code-signing.md`, Turkish `code-signing.md`) and
`structure/telemetry.md`. Layer 5's text was kept: it carries the same D12 statement plus the guide link,
and its structure doc is a superset of layer 2's. Layer 2's README test passes against it. Branches move by
merge commits, never by force-push.
