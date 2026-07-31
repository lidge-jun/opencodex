---
created: 2026-07-16
status: completed
tags: [grok, quota, ima2-gen, cli-jaw, cross-repo]
---

# Grok weekly credits REST cross-repo implementation

## Loop spec

- Archetype: spec-satisfaction repair.
- Trigger: Grok Build OSS disclosed `GET /v1/billing?format=credits`; existing consumers still use legacy monthly billing or the pre-OSS gRPC-web reverse-engineered path.
- Goal: make `ima2-gen` and `cli-jaw` prefer the source-backed weekly credits JSON contract while preserving legacy monthly fallback.
- Non-goals: estimate the weekly pool's dollar value, change UI layout, change login/refresh flows, support Grok's `GROK_LOCAL_AUTH` development issuer against a local auth/proxy stack, or modify unrelated dirty files.
- Verifier: focused quota tests, TypeScript checks, source/generated-JS parity for ima2-gen, cli-jaw structure count/docs gates, and a credential-safe live smoke that reads only percentage/period/source.
- Stop: both repos return a weekly window from `{ config: { creditUsagePercent, currentPeriod } }`, treat omitted percentage in a valid weekly period as zero, and retain monthly fallback coverage.
- Memory artifact: this plan and repository tests/docs.
- Terminal outcomes: DONE on fresh green proof; BLOCKED on an unrecoverable repo/toolchain failure; UNSAFE if existing overlapping user edits prevent a scoped patch.

## Scope and exact delta

### ima2-gen

- MODIFY `routes/quota.ts`
  - before: only `~/.progrok/auth.json`; `GET /v1/billing`; assumes `monthlyLimit/used`; always emits monthly dollar billing.
  - after: ordered credentials retain `auth_mode`, `oidc_issuer`, `user_id`, email, source, and first-party eligibility. Only `oidc` or `external` entries whose issuer is production xAI auth attempt weekly credits; all usable candidates remain eligible for legacy fallback.
  - weekly request: `GET /v1/billing?format=credits` with bearer, `X-XAI-Token-Auth`, `x-authenticateresponse`, required non-empty `x-userid`, client mode, and required Grok client version. Resolve version from `~/.grok/version.json`, then `models_cache.json`, then `grok version`; if user ID/version is unavailable, skip weekly and continue to legacy fallback.
  - parser accepts the real top-level `{ config: { creditUsagePercent, currentPeriod } }` envelope; it accepts only `USAGE_PERIOD_TYPE_WEEKLY` with parseable `currentPeriod.end` and defaults an omitted percentage to zero.
  - each weekly and monthly candidate attempt has its own exception boundary so rejection, timeout, malformed JSON, and non-2xx continue to the next candidate/fallback instead of escaping the function.
  - export a credential-safe `inspectGrokWeeklyEligibility(homeDir?)` view that reports only eligibility/reason/candidate count/client version. It must never return tokens, user IDs, emails, or raw auth data.
- MODIFY `routes/quota.js`: compile the dirty tree to an isolated temporary `outDir`, inspect the generated `routes/quota.js`, and copy only that generated file; compare before/after status manifests so no other path changes.
- MODIFY `tests/billing-source.test.ts`: import the quota owner (not the health route alone) and test the nested envelope, first-party candidate/header selection, omitted-zero weekly JSON, invalid/non-weekly rejection, and exception/non-2xx/malformed-JSON activation of monthly fallback.
- MODIFY `README.md`, `docs/API.md`, `docs/FAQ.md`, `docs/CLI.md`, `structure/03-server-api.md`: document weekly-first and legacy monthly fallback; dollar billing is optional and legacy-only.

### cli-jaw

- MODIFY `src/routes/quota.ts`
  - before: direct `grok.com` gRPC-web request plus heuristic protobuf scanner.
  - after: `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`, nested-envelope JSON parser for the same weekly contract, then legacy `/v1/billing` fallback.
  - retain auth mode, issuer, `user_id`, and first-party eligibility in credential candidates; accept xAI-issued `oidc` and `external` credentials; require source-parity user/version/auth/client headers for weekly calls; isolate every candidate attempt so transport/JSON/non-2xx failures reach fallback.
  - export the same sanitized eligibility preflight so the live smoke can distinguish no eligible local setup from an attempted proxy failure.
  - delete the obsolete protobuf frame/field scanners and exported `parseGrokCreditsGrpcWeb`.
- MODIFY `tests/unit/quota-status.test.ts`: import the JSON parser and fetch owner; assert the real envelope, zero omission, first-party headers/candidate selection, and transport/malformed/non-2xx fallback activation rather than relying on source text alone.
- MODIFY `README.md`, `structure/AGENTS.md`, `structure/INDEX.md`, `structure/server_api.md`: replace gRPC-web claims with credits REST JSON.
- MODIFY `structure/str_func.md` and the existing quota count in `structure/server_api.md`: calculate the final quota source line count and patch only those named references. Run `verify-counts.sh` read-only; do not use its broad `--fix` mode.

## Acceptance and activation evidence

1. Weekly non-zero: `{ config: { creditUsagePercent: 57, currentPeriod: { type: USAGE_PERIOD_TYPE_WEEKLY, end } } }` yields label `weekly`, percent `57`, and the same reset timestamp.
2. Weekly zero omission: a real `{ config: { currentPeriod: weekly } }` envelope with no `creditUsagePercent` yields `0`; this explicitly fires the proto3 omission branch.
3. Invalid/new response: absent/non-weekly period returns `null`, allowing the existing monthly fallback loop to execute.
4. Boundary fallback: rejected fetch, timeout/abort-style rejection, malformed JSON, and non-2xx weekly responses are each driven by deterministic mocks and observed to reach legacy monthly billing.
5. Auth boundary: API-key/web-login/non-xAI credentials are never sent to the weekly endpoint; xAI-issued `oidc` and `external` credentials with user ID send every expected auth/user/version/client header. Missing user ID/version deterministically skips weekly and reaches fallback. Legacy candidates remain usable only in the fallback loop.
6. Legacy fallback still emits monthly percent plus optional dollar billing.
7. Live smoke first reads the sanitized preflight. Only preflight `eligible:false` is SKIP. When eligible, a non-weekly/null/error result prints a sanitized failure and exits nonzero; a weekly result prints only percent/period/source. No credential, user ID, email, or raw auth payload is printed.
8. Compare post-change status against captured baseline manifests; the new delta/commits contain only named files while unrelated pre-existing dirty files and submodules remain untouched.

## Verification commands

### ima2-gen

- `node --import tsx --test tests/billing-source.test.ts`
- `npm run typecheck`
- `npm run typecheck:tests`
- isolated `tsc -p tsconfig.build.json --outDir <tmp>` followed by exact generated `routes/quota.js` comparison/copy
- baseline-vs-final status manifest comparison and `git diff --check`
- credential-safe live smoke script: import `inspectGrokWeeklyEligibility` and `fetchGrokBilling`; print `SKIP` only when preflight is ineligible; otherwise require `q.windows[0].label === "weekly"`, print sanitized percent/reset on success, and set `process.exitCode = 1` for null/error/monthly results.

### cli-jaw

- `npx tsx --experimental-test-module-mocks tests/run.mts tests/unit/quota-status.test.ts`
- `npm run typecheck`
- manual quota count patch, then read-only `bash structure/verify-counts.sh`
- `npm run docs:check`
- `git diff --check`
- credential-safe live smoke script: import `inspectGrokWeeklyEligibility` and `fetchGrokBilling`; print `SKIP` only when preflight is ineligible; otherwise require `q?.periodLabel === "weekly"`, print sanitized percent/reset/source on success, and set `process.exitCode = 1` for null/monthly results.

## Audit synthesis — round 1

Reviewer verdict: FAIL, six blockers. All accepted.

1. Envelope RCA: the plan described the inner config as the fixture. Fix: parser/tests now consume the real `{ config }` response.
2. Auth RCA: token-only candidates lost source eligibility and user metadata. Fix: retain eligibility/user ID and name every source-parity header.
3. Fallback RCA: one outer try/catch made thrown weekly failures bypass monthly fallback. Fix: per-candidate exception isolation plus four failure-mode activation tests.
4. Generated JS RCA: manual mirror edits violate ima2's generated-artifact contract, while a normal build would overwrite unrelated dirty outputs. Fix: isolated outDir compile and single generated-file copy with status manifests.
5. Oracle RCA: parser/source-text tests could pass while fetch wiring was wrong. Fix: exported/injectable fetch owner tests at the actual network boundary in both repos.
6. Count RCA: broad `--fix` can mutate unrelated drift and `server_api.md` is already stale. Fix: patch only final quota counts and run verifier read-only.

## Audit synthesis — round 2

Reviewer verdict: FAIL with one High and two Medium residuals. All accepted.

1. Auth parity RCA: OIDC-only eligibility omitted xAI-issued external credentials, and optional user/version headers diverged from the source. Fix: mirror `is_xai_auth` for `oidc|external` plus xAI issuer, require user ID and locally resolved Grok version, and skip weekly to fallback when either is absent.
2. Stop-text RCA: the loop header still named the rejected root-level shape. Fix: use the real `{ config }` envelope everywhere.
3. Smoke RCA: verification promised a live check without a command or missing-credential rule. Fix: add sanitized per-repo smoke commands; absent eligible auth/version is an explicit SKIP, not a fabricated PASS.

## P re-entry after audit-loop limit

Three consecutive A rounds failed, so the cycle returned A → I → P instead of forcing A → B.

1. Smoke oracle RCA: `fetchGrokBilling` alone cannot distinguish no eligibility from attempted failure. Fix: add a separate sanitized eligibility preflight in both repos; eligible attempts fail closed unless the returned window is weekly.
2. Issuer scope decision: source supports production and `GROK_LOCAL_AUTH` local-dev issuers, but both target apps are wired to the production proxy and installed-user auth files. Local-dev auth/proxy support is explicitly out of scope rather than accidentally claimed as parity.

## Completion evidence — 2026-07-16

- `ima2-gen` commit `1cd9313` (`feat(quota): read Grok weekly credits`)
  - focused quota tests: 7/7 pass
  - `npm run typecheck`: pass
  - `npm run typecheck:tests`: pass
  - isolated `tsc -p tsconfig.build.json --outDir <tmp>` generation and `routes/quota.js` byte comparison: pass
  - scoped `git diff --check`: pass
  - live sanitized smoke: weekly 57%, reset `2026-07-19T13:05:52.277209+00:00`, pass
- `cli-jaw` commit `ac6af6e2` (`feat(quota): use Grok credits REST`)
  - focused quota tests: 28/28 pass
  - `npm run typecheck`: pass
  - `npm run docs:check`: pass
  - scoped `git diff --check`: pass
  - live sanitized smoke: weekly 57%, reset `2026-07-19T13:05:52.277209+00:00`, source `grok:grok-build-billing-credits-rest`, pass
- `bash structure/verify-counts.sh` was run read-only. The named quota source count is 529L and both quota references were updated. The command still reports one unrelated concurrent `public/` file-total drift (documented 764, live 765); per collision policy it was not auto-fixed or staged.
- Existing unrelated dirty files in both repositories were preserved. In `cli-jaw/structure/str_func.md`, only the quota 529L hunk was staged; concurrent settings/public count hunks remain unstaged and unmodified by this commit.

Terminal outcome: DONE.
