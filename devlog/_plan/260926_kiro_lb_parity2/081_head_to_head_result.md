# 081 — Head-to-head with kiro-lb, from the landed tree

Written by the method in `080_head_to_head_method.md`. opencodex at `origin/dev` `54ed02be17`
(after #5967, #5981, #5991, #5994, #5996, #6001, #6002); kiro-lb at `bee73b3` (no newer commits on
2026-09-27, so no new kiro-lb behaviour needed classifying). Every opencodex claim cites merged code and
names the regression test that proves it; every test file named exists at `54ed02be17`. kiro-lb was
studied for behaviour only; no AGPL code or text was copied.

## Result in one paragraph

Every one of the 20 adopted rows (18 adopted in 001, plus S1/F and P8/J, which landed on dev outside this unit) now reaches parity with kiro-lb or better, each with a named test; the two Keep rows (A7, M) hold, and the 13 Reject rows keep their reasons.
opencodex is ahead outright where it matters most for a pool of accounts: quota and exhaustion evidence
now survives restart and is fenced to the login that measured it (kiro-lb keys by account and never
fences a re-login), refresh stays leased where kiro-lb falls back to an unleased refresh, credentials are
never reloaded from an unrelated source, region values are validated, and polling is on demand; load
spreading is now at parity (deterministic, opt-in least-loaded against kiro-lb's weighted race or
deterministic most-credits mode). Kiro-lb still leads on eight axes listed
below. Each is a deliberate choice or needs live evidence we do not have, so **the goal criterion "ahead on
every compared axis" is not met as written**; "ahead or at parity on every adopted axis" is.

## Row by row

| ID | Axis | kiro-lb (`bee73b3`) | opencodex (`54ed02be17`) | Verdict | Proving test / reject reason |
|---|---|---|---|---|---|
| A1/A2/A9 | Native device onboarding | `kiro/device_login.py:49-56,119-141,218-276`; dashboard start at `kiro/dashboard.py:1188` | `src/oauth/kiro-device-login.ts:176,288,303`; `src/oauth/store.ts:943` (`appendKiroAccountFromDeviceLogin`); CLI `--method` at `src/cli/account-auth.ts:37,146` | parity (API/CLI) | `tests/providers/kiro/kiro-device-builder.test.ts` "register, authorize, pending, slow_down and approve without persisting a service profile"; `tests/providers/kiro/kiro-device-social.test.ts` "uses millisecond authorization timings and appends duplicate profile ARN with warning"; `tests/server/server-kiro-device-login.test.ts` "native only with a valid method; reauth and invalid methods are rejected"; `tests/cli/cli-account-kiro-device.test.ts` "--method starts native flow and prints only the public view" |
| A3 | Refresh window | `kiro/config.py:100-103` | `src/oauth/index.ts:83` (60 s) | parity | Reject holds: a policy difference with no evidence the shorter window fails. |
| A4 | Refresh contention | `kiro/auth.py:954-992` | `src/oauth/store.ts:420,431` (lock, 120 s stale) | ahead-ocx | Reject holds: an unleased refresh can lose a rotated token. |
| A5 | Terminal refresh rejection | `kiro/auth.py:645-676` | `src/oauth/kiro.ts:38` (code allowlist); `src/oauth/kiro-terminal-failover.ts:9` | parity | `tests/server/server-kiro-refusal-e2e.test.ts` "terminal refresh rejection marks reauth and admits the sibling before any A send", "post-401 terminal refresh rejects A generation and replays on B once", "an unlisted refresh error on 400 does not mark reauth or rotate" |
| A6 | External source reload | `kiro/auth.py:645-653` | `src/oauth/kiro.ts:615` (reload only when the ARN matches) | ahead-ocx | Reject holds: an unrestricted reload can import another account. |
| A7 | Builder ID profile | `kiro/device_login.py:286-293` | `src/oauth/kiro.ts:520` | parity | `tests/providers/kiro/kiro-builder-id-profile.test.ts` "the fallback never becomes the account's identity, region, or stored metadata" |
| A8 | Secrets in logs | `kiro/auth.py:822-834` | `src/oauth/kiro.ts:533-543` (allowlisted refresh-error codes) | ahead-ocx | Reject holds: kiro-lb logs the full failed OIDC response body; we log allowlisted codes only. |
| S1/F | Builder ID usage ARN | `kiro/usage.py:63-97` | `src/providers/kiro-usage.ts:226` (shared resolver) | parity | `tests/providers/kiro/kiro-usage-restart.test.ts` "probe and runtime use the same request-profile resolver" |
| S1b | No ARN, no probe | same | `src/providers/kiro-usage.ts:184` | parity | `tests/providers/kiro/kiro-usage-restart.test.ts` "non-OIDC missing ARN makes no usage request and keeps same-login last good bar" |
| B/P7 | Restart continuity | `kiro/store.py:314-350` | `src/providers/kiro-account-state-disk.ts:43`; `kiroAccountEvidence` at `src/providers/kiro-usage.ts:300` | ahead-ocx (login fence plus TTL/reset) | `tests/providers/kiro/kiro-account-state-disk.test.ts` "first routing request hydrates exhausted evidence without probing", "two different logins into one identity-less slot invalidate evidence across restart" |
| P6 | Polling | `main.py:356` | `src/providers/quota.ts:418-440` (pull on demand, joined per account) | ahead-ocx | Reject holds: kiro-lb polls in the background every 60 s or more even when polling is disabled; ours is pull-on-demand. |
| P9 | Served success clears a verdict | `kiro/account_manager.py:1411` | `src/providers/kiro-usage.ts:344`; `src/server/responses/adapter-delivery.ts:125` | parity | `tests/providers/kiro/kiro-refusal-failover.test.ts` "kiro later served completion clears older exhaustion but not a newer refusal or different identity" |
| E5 | Provider egress | `kiro/proxy_chain.py:176-198` | `src/adapters/kiro-retry.ts:169-196` | parity | `tests/providers/kiro/kiro-transport-parity.test.ts` "initial, reset, gateway alternate and 429 recovery use the supplied executor" |
| E2/H | 502/503/504 rotation | `kiro/http_client.py:603-653` | `src/adapters/kiro-retry.ts:290-296` | parity | `tests/providers/kiro/kiro-transport-parity.test.ts` "canonical HTTP %i rotates once and final failure is fixed text", "500, 521 and custom URLs do not rotate" |
| E6 | Timeout handling | `kiro/network_errors.py:65-145` | `src/adapters/kiro-retry.ts:200` | parity on header deadline → 504; ahead-lb on the connect/read split | `tests/providers/kiro/kiro-transport-parity.test.ts` "header deadline becomes 504 without rotating; caller abort preserves its reason" |
| E7 | Fixed public 5xx text | `kiro/exceptions.py:27-36` | `src/adapters/kiro-errors.ts:215` | parity | `tests/providers/kiro/kiro-transport-parity.test.ts` "upstream 5xx marker reaches neither client nor debug ring or stderr"; `tests/server/server-kiro-refusal-e2e.test.ts` "unrotated Kiro 5xx retains fixed public text after raw-error handoff" |
| E1 | Extra endpoint dialects | `kiro/endpoints.py:25-82` | runtime host plus `q.*` | ahead-lb | Reject holds: kiro-lb itself verifies only the runtime host (`kiro/endpoints.py:9-12`). |
| E4 | Endpoint probe | `kiro/endpoint_probe.py:2-8` | absent | ahead-lb | Reject holds: the probe spends real credits. |
| E8 | Region | `kiro/http_client.py:593-615` | `src/oauth/kiro-credentials.ts:14,115-123` (region pattern validation) | ahead-ocx | Reject holds: kiro-lb interpolates the region unvalidated; ours validates the region value and keeps it account-scoped. |
| E9 | Connection reuse | pooled clients | `src/adapters/kiro-retry.ts:188-193` (fresh connection on reset) | parity | Reject holds: equivalent contract, nothing to adopt. |
| P4/I | Refusal classes | `kiro/account_manager.py:1496,1539` | `src/adapters/kiro-refusal.ts:11`; `src/oauth/generic-account-failover.ts:426`; Kiro loop at `src/server/responses/adapter-dispatch.ts:907` | parity | `tests/providers/kiro/kiro-refusal.test.ts` "kiro refusal: 429 rate and 400 or 429 monthly reasons stay distinct"; `tests/providers/kiro/kiro-refusal-failover.test.ts` "kiro monthly refusal persists and skips only the refused account until reset or TTL" |
| P5/E3 | Suspension 403 | `kiro/account_manager.py:1514` | `src/oauth/generic-account-failover.ts:104` | parity | `tests/providers/kiro/kiro-refusal-failover.test.ts` "kiro suspended account rotates before output"; `tests/server/server-kiro-refusal-e2e.test.ts` "Kiro post-output refusal never resends the turn" |
| P1/P2 | Spreading healthy load | `kiro/account_manager.py:1162-1208` | `src/oauth/generic-account-failover.ts:601` (initial choice), 489 (rotator) | parity (ours: deterministic least-loaded, opt-in; kiro-lb: weighted race by default, deterministic `most_credits` mode at `kiro/account_manager.py:1209-1219`) | `tests/providers/kiro/kiro-leased-responses.test.ts` "least-loaded selects the less busy Kiro account on the first physical send", "least-loaded does not move a healthy request when proactive preference is off" |
| P3 | Per-account concurrency | `kiro/concurrency.py:2,95` | `src/oauth/kiro-account-load.ts:14,66` | parity | `tests/providers/kiro/kiro-account-load.test.ts` "a cap admits one, wakes one waiter, and never exceeds the limit"; `tests/providers/kiro/kiro-leased-responses.test.ts` "a full selected account waits then returns 503 account_capacity without a store write" |
| P10 | Affinity | `kiro/account_manager.py:1444` | none | parity | Reject holds: a global cursor is not conversation affinity. |
| P8/J | Per-request credits | `kiro/usage_tracking.py:55,80` | `src/adapters/kiro/stream.ts:609`; `src/types/request.ts:451` | parity | `tests/providers/kiro/kiro-metering-usage.test.ts` "repeated per-request readings replace the prior snapshot, including zero"; `tests/providers/kiro/kiro-metering-events.test.ts` "parses real precise sample metering event with unit and usage" |
| U1 | Multiplier estimates | `kiro/model_costs.py:8-22` | none | ahead-lb (advisory) | Reject holds: a second, weaker number beside measured credits. |
| C1/N | Per-account catalogue | `kiro/model_catalog.py:38-78` | `src/providers/kiro-model-catalog.ts:12,120` | parity | `tests/providers/kiro/kiro-model-catalog.test.ts` "management ListAvailableModels pairs each bearer with its own profile and region", "unrecognised or empty management replies preserve the last good list" |
| C2 | Membership as evidence | `kiro/model_resolver.py:309-355` | `src/oauth/generic-account-failover.ts:237` | parity | `tests/providers/kiro/kiro-model-preference.test.ts` "reactive Kiro rotation prefers model evidence after room filtering", "no catalogue evidence never moves a healthy active account" |
| C3 | Context limits | `kiro/model_costs.py:64-74` | `src/providers/kiro-model-catalog.ts:129`; `src/adapters/kiro/usage.ts:223`; `src/server/request-log.ts:1633` | parity when catalogue evidence exists; ahead-lb on the static fallback (272k GPT-5.6 window at `src/providers/kiro-models.ts:34` vs kiro-lb's 1M) | `tests/providers/kiro/kiro-model-catalog.test.ts` "a mixed known/unknown roster never reports more than the smallest known window" |
| W1/W2 | IDE fingerprint | `kiro/utils.py:20-31,74-85` | `src/adapters/kiro/wire.ts:8` (`KIRO_IDE_VERSION = "1.0.0"`) | ahead-lb | Reject holds: needs our own capture. |
| S2 | MCP web search | `kiro/mcp_tools.py:131-150` | none | n/a | Reject holds: a new feature, not auth or usage. |
| K | Quota metrics | `kiro/metrics.py:262` | `src/providers/kiro-quota-metrics.ts:16`; `src/server/request-metrics.ts:192-196` | parity | `tests/providers/kiro/kiro-quota-metrics.test.ts` "fresh cached credits yield four opaque gauges without probing", "future, stale, reset-passed, and identity-mismatched rows are omitted" |
| L | Auto-selection state | dashboard (`b176585`) | `src/oauth/generic-account-failover.ts:134`; `src/server/management/oauth-account-routes.ts:407`; `src/cli/account.ts:108` | parity (API/CLI) | `tests/providers/kiro/kiro-auto-selection.test.ts` "Kiro candidate and list projection agree on family-less exclusion states"; `tests/cli/cli-kiro-auto-selection.test.ts` "Kiro list prints a closed reason and carries it in JSON" |
| M | Opaque labels | `c0a7f98` | `src/codex/account-label.ts:36` | parity | Kept; `tests/oauth/oauth-account-attribution.test.ts` "an o-label is a valid persisted label and a p-label still is" |

## Where kiro-lb still leads

| Axis | Why we did not follow (yet) |
|---|---|
| W1/W2 IDE wire fingerprint | Changing the wire identity without our own capture risks every Kiro request. Needs a live capture. |
| E1 extra endpoint dialects | kiro-lb itself verifies only the runtime host for every credential type (`kiro/endpoints.py:9-12`); unverifiable offline. |
| E4 paid endpoint probe | Spends real credits; our 5xx rotation self-heals without spending. |
| S2 MCP web search side call | A new feature, not auth or usage. |
| U1 per-model credit estimates | Measured credits (`providerCredits`) are the source of truth; an estimate beside them is a weaker second number. |
| Dashboard device-login UI | Native device login ships in the CLI and management API (060, option a); the dashboard still uses kiro-cli. A device-code dialog is the follow-up. |
| Operations dashboard | Routable state and quota gauges are in the API, CLI and metrics export (070), not rendered in the GUI; the `health` field does not yet reflect Kiro suspension/exhaustion. |
| C3 static context fallback | Without catalogue evidence our static GPT-5.6 window is 272k (`src/providers/kiro-models.ts:34`) where kiro-lb records 1M; the observed catalogue raises it when an account reports it. |
| E6 connect vs read timeout split | A header deadline maps to 504 and never rotates on caller abort, but connect and read timeouts are not separated. |

## Narrowed by recorded decisions (not failures)

- **A1/A2/A9:** native login is add-only; neither method yields a verified identity, so native re-login is
  refused and native accounts recover by remove and re-add. Flow binding is principal kind plus an
  unguessable, unlisted flow id (no per-session identity exists in management auth).
- **P3:** a full account waits up to 250 ms and returns a retryable `503 account_capacity`; capacity never
  moves a request or writes the stored selection.
- **L:** `autoSelectable`/`skipReason` are API and CLI fields; the GUI does not render them.

## Evidence gaps (fixture-only, never exercised against a live Kiro account)

- 030 refusal bodies: `MONTHLY_REQUEST_COUNT`, `TEMPORARILY_SUSPENDED` and the suspension message wordings.
- 050 `ListAvailableModels` reply fields (`models[].modelId`, `tokenLimits.maxInputTokens`).
- 060 device-flow replies: social field names and units, social terminal statuses, social `profileArn`
  uniqueness, Builder ID replies and `x-amzn-errortype` spellings.
- Metering frame repetition within one send (the parser itself was built from kiro-cli captures).
- Egress through a real proxy, 502/503/504 rotation against the real `q.*` host, cross-account context
  window accuracy.

## Verification of this document

Run on 2026-09-27 against branch `codex/kiro-lb2-081-head-to-head` at `origin/dev` `54ed02be17` with this file present:

- `bun run privacy:scan` — "Privacy scan passed" (exit 0).
- `bun run structure:check` — "structure/ SSOT checks passed" (exit 0).
- Mechanical check (`.tmp/check081.mjs`, scratch): every `tests/...` path named above exists in `git ls-tree origin/dev`, and each of the 35 row IDs in 001 appears exactly once in the row table.
