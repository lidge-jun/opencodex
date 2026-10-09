# 050 — Acceptance map

Every acceptance scenario of this unit maps to a work-phase, a test file and the hosted CI job that runs
it. "Shared fixture" means the scenario is executed for both instances by the parameterised harness in
`tests/helpers/anthropic-instance-fixture.ts` (two instances, four accounts, A1 and B1 deliberately sharing
the stored account ID while tokens and verified UUIDs differ, a fake upstream that records which token and
UUID each physical send carried). No suite is copied with a string replace.

## Harness

| ID | Contract | WP | Test file |
|---|---|---|---|
| H-01 | two instances, four accounts, equal-ID collision, send ledger, isolated home | wp3 | `tests/helpers/anthropic-instance-fixture.ts` |
| H-02 | the same case body runs for A and B; only instance/account mapping is normalised | wp3 | every `*instance*` file below |
| H-03 | negative control: a deliberately misbound test resolver (B bound to A's facade) must make the no-cross-send assertion fail; production code is untouched | wp3 | `tests/adapters/anthropic/anthropic-instance-isolation.test.ts` |

## Regression, UX, config

| IDs | WP | Test file |
|---|---|---|
| REG-01, REG-03, CFG-01, STATE-05, STATE-12 | wp2 | `tests/providers/provider-anthropic-instance.test.ts` |
| REG-02, REG-06, WIRE-05, WIRE-15, UX-02, UX-07 | wp3 | `tests/claude-integration/anthropic2-native-routing.test.ts` |
| REG-04, STATE-13, AUTH-01 | wp3 | `tests/adapters/anthropic/anthropic-instance-isolation.test.ts` |
| REG-05 | wp2 | `tests/providers/provider-anthropic-instance.test.ts` (apikey, compatible adapter, claude-cli excluded) |
| REG-07, AUX-07 | wp3 | `tests/adapters/anthropic/anthropic-instance-isolation.test.ts` (explicit combo keeps targets) |
| UX-01, UX-03 | wp4 | `tests/codex-integration/anthropic2-catalog.test.ts` |
| UX-04, UX-05 | wp4 | `gui/tests/anthropic2-provider-surfaces.test.tsx` |
| UX-06 | wp4 | `tests/cli/cli-anthropic2-account.test.ts` |
| CFG-02, CFG-03, CFG-04, STATE-11 (salvage half) | wp2 | `tests/config/config-anthropic-instance-pool.test.ts` |
| CFG-05 | wp5 | single PR: B is advertised only in the PR that carries every slice |

## Credentials

| IDs | WP | Test file |
|---|---|---|
| AUTH-02, AUTH-12, AUTH-15 | wp2 | `tests/oauth/oauth-anthropic-instance-registration.test.ts` (CLI fixture hash unchanged, no Keychain stub call) |
| AUTH-03, AUTH-14, UX-04 (server half) | wp2 | same file (login writes only B; failure leaves A and defaults untouched) |
| AUTH-04, AUTH-05, AUTH-08 | wp2 | `tests/oauth/oauth-anthropic-instance-refresh.test.ts` |
| AUTH-06, AUTH-07 | wp2 | same file, run for both instances against the existing single-flight/intent contract |
| AUTH-09, AUTH-10, AUTH-11, AUTH-13, AUTH-16 | wp2 | `tests/oauth/oauth-anthropic-instance-registration.test.ts` |
| STATE-10 | wp2/wp3 refinement | same file (custom key provider, gateway OAuth row, unmarked canonical OAuth row and orphan auth row preserved); marked override parity and marker round-trip in provider/config/discovery tests |

## Pool policy and recovery

| IDs | WP | Test file |
|---|---|---|
| POOL-01 … POOL-09, POOL-16, POOL-17 | wp3 | `tests/adapters/anthropic/anthropic-instance-pool-parity.test.ts` (shared fixture) |
| POOL-10 … POOL-15 | wp3 | `tests/adapters/anthropic/anthropic-instance-recovery.test.ts` |
| POOL-18 … POOL-20 | wp3 | same file (await barriers, output-started no-replay, physical budget) |
| STATE-01, STATE-02, STATE-03, STATE-09 | wp3 | `tests/adapters/anthropic/anthropic-instance-isolation.test.ts` |

## Wire and model features

| IDs | WP | Test file |
|---|---|---|
| WIRE-01, WIRE-02, WIRE-14, WIRE-16 | wp3 | `tests/claude-integration/anthropic2-native-routing.test.ts` |
| WIRE-03, WIRE-04, WIRE-12, WIRE-13 | wp3 | `tests/responses/anthropic2-responses-parity.test.ts` |
| WIRE-06, WIRE-08, WIRE-09 | wp3 | `tests/responses/anthropic2-responses-parity.test.ts` and `tests/claude-integration/anthropic2-native-routing.test.ts`: separate cases per feature (thinking/redacted thinking/signatures; tools, tool results, parallel tools; cache_control/TTL/images), each run native and translated for A and B, upstream bodies compared after normalising only token/UUID |
| WIRE-07 | wp3 | `tests/claude-integration/anthropic2-native-routing.test.ts`: first-party destination and beta/identity conditions identical; a custom `anthropic2` gateway row stays non-native |
| WIRE-10 | wp3 | `tests/adapters/anthropic/anthropic2-fast-parity.test.ts`: fast off, opt-in on, unsupported model, for A and B (mirrors `anthropic-fast-opt-in.test.ts` cases) |
| WIRE-11 | wp4 | `tests/codex-integration/anthropic2-catalog.test.ts`: catalog/client context and output markers versus effective limits are equal for A and B |

## Helpers, observability

| IDs | WP | Test file |
|---|---|---|
| AUX-01 … AUX-06, AUX-08, AUX-11 … AUX-14 | wp4 | `tests/vision/vision-anthropic-instance-sidecar.test.ts`, `tests/web-search/web-search-anthropic-instance.test.ts` |
| AUX-09, AUX-10 | wp4 | `tests/server/anthropic2-management.test.ts` |
| STATE-04 | wp4 | same file (unknown save outcome on B pool settings, A untouched) |
| STATE-06, STATE-07, STATE-08 | wp4 | `tests/usage/anthropic2-usage-attribution.test.ts` |
| account health DTO (A/B same ID, different cooldown) | wp3 | `tests/oauth/oauth-anthropic-instance-health.test.ts` |

## Compatibility evidence and exclusions

- STATE-11 pinned pre-feature source at `6a7632db2a85c359da9feac976180450ebb42c60`
  executed under Bun 1.4.0 in [hosted run 37752878337](https://github.com/lidge-jun/opencodex/actions/runs/37752878337).
  Its receipt confirms orphan B read preservation, preservation after A and B
  writes, and selective config salvage without auth mutation. The uploaded artifact
  is named `anthropic2-old-version-<tested-head>`; only synthetic data was used.
  This establishes the narrow old-store compatibility check, not supported in-place
  downgrade with active B. Downgrade instructions retain stop/backup/remove-B-config
  requirements and never move or delete A credentials.
- The diagnostic workflow (`.github/workflows/anthropic2-contract-diagnostic.yml`), its old-version
  fixture (`tests/fixtures/anthropic-instance-old-version.ts`) and the dashboard capture scripts
  (`scripts/ci/anthropic2-gui-capture/`) targeted only this branch and were removed before merge;
  they remain at `6921271276`. The wp4 helper/surface suites and GUI suites passed there in hosted run
  37797569391, which also produced the PR screenshots (published on `pr-assets` at `50b1da0832`).
- Section 9 live-account smoke: needs separate owner approval and real accounts; not run.

## Release blockers (PRD §11) → evidence

| Blocker | Evidence |
|---|---|
| B succeeds with no B account via A/caller/CLI token | AUTH-01, AUTH-02, WIRE-05 |
| B 403/429/usage changes A state | POOL-10, POOL-11, POOL-13, H-03 |
| B is bridge-only | WIRE-01 |
| account/UI calls an A-only endpoint | UX-05, UX-06, AUX-09 |
| helpers use A for a B request | AUX-01, AUX-02, AUX-03 |
| A config change changes B or the reverse | CFG-02, STATE-04 |
| provider prefix reaches upstream | WIRE-15 |
| migration overwrites A config/auth | REG-01, STATE-10 |
| B changes bare-model/default/Claude Code routing | REG-02, REG-06 |
| tests cannot tell A from B | H-03 negative control |
| unrun CI reported as passing | wp5 exact-head check-run evidence |
