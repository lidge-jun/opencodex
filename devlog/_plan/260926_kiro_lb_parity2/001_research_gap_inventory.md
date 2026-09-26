# 001 — kiro-lb (bee73b3) gap inventory against opencodex dev (bb3f3c2d0d)

Research only. No diffs here; each adopted row is designed to diff level in its decade doc.
kiro-lb is AGPL-3.0: behaviour was studied from source; no code, comments, or structure were
copied. kiro-lb anchors are `path:line` in the reference clone at `/tmp/kiro-lb` (commit
`bee73b3`, 141 commits after the `474df2b` baseline of `260829_kiro_quota_pool/080`).
opencodex anchors are repository paths at `bb3f3c2d0d`. No live Kiro or AWS call was made.

Five read-only discovery lanes produced the raw rows (auth, pool, endpoint/network, wire and
catalog, commit history). This document is the reconciled result; where two lanes disagreed the
row records which one was verified and how.

## Verdict key

- **ahead-lb**: kiro-lb does something opencodex does not, or does it better.
- **ahead-ocx**: opencodex is stricter or cheaper; nothing to adopt.
- **parity**: equivalent contract.

## Authentication and credential lifecycle

| ID | Axis | kiro-lb | opencodex | Verdict | Decision |
|---|---|---|---|---|---|
| A1/A2/A9 | Onboarding: Builder ID, Google, GitHub device authorization run inside the gateway; each account is registered independently | `kiro/device_login.py:49-56,119-141,218-276,341-364`, `kiro/accounts_admin.py:95-133` | Add-account shells out to `kiro-cli logout/login` and temporarily switches the one CLI session (`src/oauth/kiro.ts:347-445`, `src/server/management/oauth-account-routes.ts:240`) | ahead-lb | **Adopt** → 060 |
| A3 | Refresh window | 10 min skew (`kiro/config.py:100-103`) | 1 min shared gate, rotated refresh token persisted per account (`src/oauth/index.ts:83,1019-1041`) | parity | Reject: policy only, no failure evidence for the shorter window |
| A4 | Refresh contention | SQLite lease, then refreshes *without* the lease after 75 s (`kiro/auth.py:954-992`, `27d476a`, `4b42892`) | Cross-process file lock, 120 s stale bound, bounded wait (`src/oauth/store.ts:422-429`) plus in-process join (`src/oauth/index.ts:568-605`) | ahead-ocx | Reject: an unleased refresh can lose a rotated token |
| A5 | Rejected refresh token | Bare 400/401 from the token endpoint = dead credential (`kiro/auth.py:645-676`, `da1ebc6`) | Terminal only for recognised OAuth codes (`src/oauth/kiro.ts:38-46,533-543`) | mixed | **Adopt narrowly** → 030: a terminal refresh rejection removes the account from rotation for this request; the classification stays code-based |
| A6 | External source reload | Reloads any registered source on 400 (`kiro/auth.py:645-653`) | Retries a changed CLI token only when its ARN matches (`src/oauth/kiro.ts:615-676`) | ahead-ocx | Reject: unrestricted reload can import another account |
| A7 | Profile discovery | No ListAvailableProfiles for Builder ID (403) (`kiro/device_login.py:286-293`) | Same; request-scoped Builder ID fallback (`src/oauth/kiro.ts:520-530`) | parity | Keep; 060 must not persist the service profile as identity |
| A8 | Secrets in logs | Logs the full failed OIDC response body (`kiro/auth.py:822-834`) | Allowlisted codes only; client secret never in request snapshots (`src/oauth/index.ts:83-92`) | ahead-ocx | Reject |

## Usage probe and quota state

| ID | Axis | kiro-lb | opencodex | Verdict | Decision |
|---|---|---|---|---|---|
| S1/F | Builder ID usage ARN | Recovers the ARN and requires it in query and body (`kiro/usage.py:63-97`, `84ab1bf`) | Landed by #5937 (`9c7c046520`): the probe asks `resolveKiroRequestProfile`, carries `builderIdFallback` so the service ARN never picks the region, pins a CREDIT-only reply, and documents it (`src/providers/kiro-usage.ts`, `docs-site/src/content/docs/reference/adapters.md`) | parity | Done upstream of this unit; 010 adds only a regression that runtime and probe keep sharing one resolver |
| S1b | ARN-less non-OIDC probe | Refuses to send when no ARN can be formed | Sends and eats a 400 | ahead-lb | **Adopt** → 010: no request, reason recorded as unknown |
| B/P7 | Restart continuity | SQLite rows seed routing at startup; errored rows excluded (`kiro/store.py:314-350`, `kiro/account_manager.py:576`, `27d476a`, `5376d05`) | The disk store exists but only Anthropic hydrates it; the Kiro commit path never persists (`src/providers/quota.ts:426,490-503`, `src/providers/quota/account-cache.ts:102-117`). Verified by reading both call sites; the pool lane's "landed" claim covered only the generic store | ahead-lb | **Adopt** → 010: persist and hydrate Kiro rows and the exhaustion/overage verdict, bounded by reset and TTL |
| P6 | Polling | Background poll, ≥60 s even when disabled (`main.py:356`, `kiro/dashboard.py:970`) | Pull on demand behind TTL, joined per account (`src/providers/quota.ts:418-440`) | ahead-ocx | Reject |
| P9 | Recovery | A success clears a stale exclusion (`kiro/account_manager.py:1411`) | Verdict expires at TTL or reset only | parity (different rule) | **Adopt** → 030: a served success supersedes an older exhaustion verdict for that account |

## Transport, endpoint, and error handling

| ID | Axis | kiro-lb | opencodex | Verdict | Decision |
|---|---|---|---|---|---|
| E5 | Egress | Every send goes through the configured proxy chain (`kiro/proxy_chain.py:176-198`) | **Bug:** `fetchWithResetRecovery` calls `fetchWithAttemptDeadline` without `ctx.executor`, so Kiro sends use `globalThis.fetch` and bypass provider egress (`src/adapters/kiro-retry.ts:158-197`, `src/lib/upstream-retry.ts:462-480`; the shared helper that honours it is `src/adapters/physical-send.ts:14`) | ahead-lb | **Adopt** → 020 (first item) |
| E2/H | 5xx endpoint rotation | 502/503/504 and transport failures rotate endpoint; account errors never do (`kiro/http_client.py:603-653`, `d194e5c`, `b6db5e3`) | Alternate host only for connection errors and 400/403/404/405 signatures (`src/adapters/kiro-retry.ts:134-147,200-217,256-279`) | ahead-lb | **Adopt** → 020: 502/503/504 before any output rotate to the existing alternate host within the send budget |
| E6 | Timeout classes | Connect vs read timeouts, timeout → 504 (`kiro/network_errors.py:65-145,282-336`) | One header deadline (`src/adapters/kiro-retry.ts:158-197`) | ahead-lb | **Adopt** → 020: a header-deadline expiry surfaces as a gateway timeout and never rotates on caller abort |
| E7 | 5xx body hygiene | Fixed public text for 5xx (`kiro/exceptions.py:27-36,102-125`, `3de54a6`) | Bounded, redacted upstream text still reaches the client (`src/adapters/kiro-errors.ts:82-87`) | ahead-lb | **Adopt** → 020 |
| E1 | Extra endpoint dialects | CodeWhisperer and AmazonQ hosts with their own headers (`kiro/endpoints.py:25-82`) | Runtime + one `q.*` fallback | ahead-lb | Reject: kiro-lb itself marks only the runtime host verified for every credential type (`kiro/endpoints.py:9-12`); unverifiable offline |
| E4 | Endpoint probe | Operator probe spends real generation requests (`kiro/endpoint_probe.py:2-8`) | Absent | ahead-lb (feature) | Reject: costs real credits; 020's rotation self-heals without spending |
| E8 | Region | Unvalidated interpolation (`kiro/http_client.py:593-615`) | Allowlisted, account-scoped (`src/oauth/kiro-credentials.ts:109-123`) | ahead-ocx | Reject |
| E9 | Connection reuse | Pooled clients | Shared fetch; reset attempts force a fresh connection | parity | Reject |

## Account pool

| ID | Axis | kiro-lb | opencodex | Verdict | Decision |
|---|---|---|---|---|---|
| P4/I | Refusal classes | Rate 429 → short cooldown; monthly quota (429 or 400 `MONTHLY_REQUEST_COUNT`) → reset-aligned quarantine (`kiro/account_manager.py:1496,1539`, `abae7c6`, `ba3c694`) | Generic rotation only on HTTP 429 (`src/server/responses/adapter-dispatch.ts:856-860`, `src/oauth/generic-account-failover.ts:346`) | ahead-lb | **Adopt** → 030 |
| P5/E3 | Suspension 403 | Excluded and failed over (`kiro/account_manager.py:1514`, `9206884`, `6f5e062`) | Non-retryable permission error to the client (`src/adapters/kiro-errors.ts:138-150`) | ahead-lb | **Adopt** → 030, before any client bytes only |
| P1/P2 | Healthy-account spreading | Quota-weighted random race (`kiro/account_manager.py:1162-1208,1288`) | Keeps a healthy active account; deterministic ordering (`src/oauth/account-quota-rank.ts:158-172`, `src/oauth/generic-account-failover.ts:443-484`) | ahead-lb on distribution | **Adopt, better** → 040: deterministic least-loaded choice among quota-healthy accounts, opt-in |
| P3 | Per-account concurrency | Optional semaphore with bounded wait (`kiro/concurrency.py:2,95`, `kiro/http_client.py:554`) | Absent | ahead-lb | **Adopt** → 040 |
| P10 | Affinity | Global last-success cursor (`kiro/account_manager.py:1444`) | None, documented | parity | Reject: a global cursor is not conversation affinity |
| P8/J | Per-request credits | Records upstream credit frames per serving account (`kiro/usage_tracking.py:55,80`, `main.py:594`, `432c9b3`) | Kiro token usage is estimated; no credit field (`src/usage/log.ts:532`) | ahead-lb | **Adopt** → 070 |
| U1 | Multiplier estimates | Coarse per-model estimates (`kiro/model_costs.py:8-22,108-132`) | None | ahead-lb (advisory) | Reject: 070 records measured credits; an estimate beside them would be a second, weaker number |

## Model capability and wire

| ID | Axis | kiro-lb | opencodex | Verdict | Decision |
|---|---|---|---|---|---|
| C1/N | Per-account catalogue | ListAvailableModels per account, failure keeps the previous list (`kiro/model_catalog.py:38-78`, `ea55e46`) | Static list (`src/providers/kiro-models.ts:1-55`) | ahead-lb | **Adopt** → 050 |
| C2 | Resolution | Aliases checked against the live catalogue, unknown IDs pass through (`kiro/model_resolver.py:309-355`) | Normalise and send (`src/providers/kiro-models.ts:67-77`) | ahead-lb | **Adopt** → 050: membership is evidence for account choice, never a hard block |
| C3 | Context limits | Records a larger GPT-5.6 context than ours (`kiro/model_costs.py:64-74`) | 272k (`src/providers/kiro-models.ts:30-38`) | ahead-lb | **Adopt** → 050, sourced from the catalogue's token limits where present |
| W1/W2 | IDE fingerprint | Headers aligned to an IDE capture (`kiro/utils.py:20-31,74-85`, `a200631`) | `KiroIDE-1.0.0` envelope (`src/adapters/kiro/wire.ts:5-8`) | ahead-lb on fidelity | Reject for this unit: changing the wire identity without a capture of our own risks every Kiro request; recorded as NEEDS_HUMAN evidence |
| S2 | MCP web_search side call | ARN on the MCP header (`kiro/mcp_tools.py:131-150`) | No side call; tools ride the generation payload | n/a | Reject: new feature, not auth or usage |

## Operations

| ID | Axis | kiro-lb | opencodex | Verdict | Decision |
|---|---|---|---|---|---|
| K | Metrics | Prometheus quota series (`kiro/metrics.py:262`, `81aafc2`) | Metrics export has no Kiro quota series (`src/server/request-metrics.ts:21`) | ahead-lb | **Adopt** → 070 with opaque, bounded labels |
| L | Routable state | Dashboard counts routable accounts, excludes disabled (`b176585`, `bf907d9`) | Quota bars without the reason an account is skipped (`gui/src/components/QuotaBars.tsx:376`) | mixed | **Adopt** → 070: routable state and reason in the account listing API/CLI |
| M | Opaque labels | Masked account labels (`c0a7f98`) | Opaque usage labels (`src/usage/log.ts:63`) | parity | Keep |

## Already ahead (kept, re-verified)

Explicit quota-bucket priority and a separate trial window (`src/providers/kiro-usage.ts:42,100-126`);
overage-aware exhaustion; allowlisted regions; pull-on-demand probes joined per account; stale
verdicts degrade to unknown; bearer, ARN and region taken from one account snapshot; physical-send
budget across Kiro's nested retries (`src/adapters/kiro-retry.ts:166-177`); replay refusal after
stream output (`src/adapters/kiro/stream.ts:385-405`).

