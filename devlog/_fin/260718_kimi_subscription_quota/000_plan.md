# Kimi subscription quota integration

## Loop spec

- Archetype: repair a missing provider integration.
- Trigger: the Providers workspace shows no Kimi subscription quota even though Kimi Code exposes authenticated quota data.
- Goal: show Kimi Code 5-hour, weekly, and total subscription-credit utilisation in the existing quota UI without inventing period or gift semantics.
- Non-goals: local token accounting, Kimi Platform pay-as-you-go billing, HTML scraping, or monetary Extra Usage wallet rendering.
- Verifier: `bun test tests/provider-quota.test.ts tests/quota-bars-rows.test.ts` plus a live authenticated `GET /api/provider-quotas?refresh=1`; the tests prove parsing/auth/redaction and the live probe proves the provider path is active.
- Stop condition: Kimi produces one `kimi:usages` report with the three supported rows, malformed responses produce no fresh row, authentication failures follow the existing bounded last-good policy, and no credential/raw payload reaches the management API.
- Memory artifact: this plan and its final verification section.
- Expected terminal outcomes: DONE when the tested and live report renders; NOOP if the live endpoint no longer returns usable fields; BLOCKED if OAuth cannot access `/usages`.
- Escalation: the main agent reclaims any delegated slice after two failed packets; no implementation slice is delegated in this one-file backend patch.

## Evidence and contract

- OpenCodex currently dispatches quota probes only for OpenAI, xAI, Anthropic, Cursor, and Antigravity in `src/providers/quota.ts`.
- The official Kimi Code CLI at commit `3086e4703992fbbe7a41379405ee243713ad9ced` calls `GET https://api.kimi.com/coding/v1/usages` with OAuth Bearer authentication.
- Official source: [`packages/oauth/src/managed-usage.ts` at commit `3086e470`](https://github.com/MoonshotAI/kimi-code/blob/3086e4703992fbbe7a41379405ee243713ad9ced/packages/oauth/src/managed-usage.ts#L1-L43) owns the URL and parser; [lines 291-319](https://github.com/MoonshotAI/kimi-code/blob/3086e4703992fbbe7a41379405ee243713ad9ced/packages/oauth/src/managed-usage.ts#L291-L319) own the Bearer fetch.
- A live authenticated probe on 2026-07-18 returned HTTP 200 with:
  - `usage.{limit,used,remaining,resetTime}` for the weekly window.
  - `limits[].window.{duration,timeUnit}` plus `detail.{limit,remaining,resetTime}` for the 5-hour window.
  - `totalQuota.{limit,remaining}` for total subscription credits; it contains no duration or reset field, so it must not be labelled monthly.
  - `subType` as entitlement metadata. No gift meaning is inferred from it.
- `boosterWallet` is officially Extra Usage monetary balance and is deliberately excluded from percentage quota bars.
- Gift balances are exposed only by Kimi Desktop's separate web-membership API. The Kimi Code OAuth token received HTTP 401 from that API, so OpenCodex must never probe it under the existing provider login.

## Scope boundary

### IN

- `src/providers/quota.ts`
- `tests/provider-quota.test.ts`
- this numbered implementation record

### OUT

- `src/oauth/kimi.ts`: the official CLI and the verified live call need only `Authorization` and `Accept`; no header export is required.
- New GUI layout or component behavior: `AccountQuota`, `ProviderWorkspaceShell`, `ProviderUsage`, and `QuotaBars` already carry and render 5-hour, weekly, monthly, and custom windows.
- Extra Usage money/balance UI.
- Changes to unrelated dirty worktree files.

## Diff-level plan

### MODIFY `src/providers/quota.ts`

- Extend `ProviderQuota` with `fiveHourPercent` and `fiveHourResetAt`; include the 5-hour field in `hasQuotaRows()`.
- Add narrow Kimi payload helpers next to the other provider probes:
  - accept finite number or numeric string values;
  - calculate used percent from `used`, or from `limit - remaining` when `used` is absent;
  - read ISO/epoch reset values through the existing `normalizeResetAt()`;
  - identify the 5-hour row primarily from `window.duration === 300` + a minute unit, with label fallback for documented drift;
  - map top-level `usage` to weekly and `totalQuota` to a neutral `Total subscription credits` custom row.
- Add `fetchKimiQuota(provider, config)` using the existing refreshed OAuth access-token owner and the canonical `https://api.kimi.com/coding/v1/usages` endpoint, an 8-second timeout, `Accept: application/json`, and Bearer auth.
- Before acquiring or sending the OAuth token, require the normalized configured base URL to equal `https://api.kimi.com/coding/v1`; custom or malicious hosts receive no probe.
- Return only normalized percentages/reset timestamps as source `kimi:usages`; missing credentials, non-2xx, invalid JSON, zero limits, or unrecognized rows produce no fresh report. The shared quota cache intentionally preserves a prior good report for at most 30 minutes on transient/auth failures.
- Dispatch only the canonical OAuth Kimi provider (`name === "kimi"`, `authMode === "oauth"`). API-key Moonshot/Kimi providers remain out of scope.

### MODIFY `tests/provider-quota.test.ts`

- Add Kimi to the shared OAuth fixture/config and return a realistic `/usages` payload containing weekly, 5-hour, total subscription quota, entitlement metadata, and secret-bearing decoy fields.
- Assert the report source and normalized `fiveHourPercent`, `weeklyPercent`, `Total subscription credits` custom row, and reset timestamps.
- Assert the request uses the Kimi OAuth token and that credentials, user identity, entitlement metadata, and raw payload fields are absent from serialized reports.
- Add focused cases for malformed/zero-limit Kimi data, a non-canonical Kimi base URL that must never be fetched, expired-token refresh failure that must not call `/usages`, successful refresh whose fresh Bearer token reaches `/usages`, and the existing bounded last-good behavior after a Kimi 401.

### C-phase localization amendment

- MODIFY `gui/src/components/QuotaBars.tsx` to translate the neutral raw label `Total subscription credits` through the existing custom-window label switch.
- MODIFY `gui/src/i18n/{en,ko,de,zh}.ts` with the one matching label key; no layout or style change.
- MODIFY `tests/quota-bars-rows.test.ts` to prove the raw provider identity maps to the localized key.

## Acceptance and activation scenarios

- Happy path activation: a configured logged-in OAuth Kimi provider receives the documented live payload; the report contains 0% 5-hour, 15% weekly, and 1% total-subscription utilisation with live reset timestamps where supplied.
- Remaining-only branch activation: the fixture omits `used` for the 5-hour and `totalQuota` rows; the test proves `limit - remaining` arithmetic.
- Drift fallback activation: a fixture row without window metadata but with a `5h` label still maps to the 5-hour slot.
- Failure activation: a 200 response with zero/malformed limits returns no report, while the quota cache remains usable for other providers.
- Destination activation: a Kimi provider pointed at a non-canonical base URL performs no fetch and never releases the OAuth token.
- Auth/cache activation: an expired credential whose refresh fails never calls `/usages`; a successful refresh sends the fresh access token to `/usages`; a later 401 preserves the previous good row only within the shared 30-minute bound.
- Redaction activation: fixture secrets and Kimi user/entitlement fields appear upstream but not in `JSON.stringify(result)`.

## Unsupported data boundary

- Gift balance is not available through Kimi Code OAuth. The Kimi Desktop membership endpoint is out of scope and must not be called.
- `totalQuota` is not labelled monthly because the API supplies neither duration nor reset metadata.
- `boosterWallet` is Extra Usage money, not gift quota, and remains hidden until a separate monetary-balance contract is designed.

## SoT sync

No general architecture document describes provider-specific quota probes. This implementation record and the existing provider-quota contract tests are the local source of truth; no broad documentation change is warranted.

## Final verification — 2026-07-18

- `bun run typecheck`: PASS.
- Focused provider/workspace/quota suites: PASS, 37 tests / 0 failures.
- `cd gui && bun run build`: PASS; only the pre-existing Vite chunk-size warning remains.
- `bun run test`: PASS, 2,883 tests / 0 failures / 12,424 assertions.
- `bun run privacy:scan`: PASS.
- Live OAuth activation: `fetchProviderQuotaReports()` returned `kimi:usages` with 5-hour 0%, weekly 15%, and total subscription credits 1%; no raw account payload was emitted.
- Destination activation: a non-canonical Kimi base URL made zero fetch calls in the regression suite.
- Auth activation: refresh-success used the fresh Bearer token; refresh-failure skipped `/usages`; a 401 preserved last-good data only within the shared 30-minute bound.
- Render grounding: isolated agbrowse at 1440×813 rendered the Korean Kimi Usage tab with `5시간 한도`, `주간 한도`, and `전체 구독 크레딧`; screenshot `/tmp/agbrowse-kimi-quota.NxZVfS/screenshots/screenshot_1784340006889.png`. Console was empty and the expected `/api/provider-quotas` request was present.
- Independent implementation review: PASS, 8/8 implementation files reviewed, no blocking finding.
- Teardown: isolated Chrome stopped; QA server on port 10101 exited via SIGINT.

## Terminal result

DONE. Kimi Code OAuth now supplies the three quota rows its safe provider endpoint exposes. Gift balances remain unsupported because they require the separate Kimi web-membership authentication boundary; the Kimi Code token was verified to receive HTTP 401 there.
