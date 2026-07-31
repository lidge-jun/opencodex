# Cycle 3 — integration, isolated runtime, docs, and closeout

Depends on: Cycles 1 and 2 green
Exit gate: full tests/type/build/docs/smoke green, evidence complete, current docs synchronized
Change class: integration rewrite, isolated verification tooling, current SoT docs, unit archival

## Cycle objective

Prove the new contract across HTTP/SSE, Responses WebSocket, compact, management, catalog,
migration/restore, sidecars, and an actual isolated Codex client. Remove false “three-tier” names
from active tests/scripts, update only current user/structure docs, and archive this unit only after
all evidence is reproducible.

## Integration test decision

`tests/openai-three-tier-e2e.test.ts` is **renamed** to
`tests/openai-provider-option-e2e.test.ts`, not amended in place under the old name. The filename and
`describe("OpenAI three-tier integration spine")` are executable contract labels; retaining them
would assert a topology the implementation intentionally removed. Git history preserves provenance,
while the new name makes test selection and failures truthful.

### `RENAME + REWRITE tests/openai-three-tier-e2e.test.ts -> tests/openai-provider-option-e2e.test.ts`

Retain the deny-by-default network interceptor, temporary homes, real `~/.claude` hash check,
HTTP/SSE lifecycle fixture, WebSocket fixture, compact assertions, API Pro selected/wire identity,
request logs, usage rows, and cleanup.

Replace the three-provider flow with one mode-switch flow:

1. Build canonical `openai` with no persisted mode (therefore Pool) plus unchanged
   `openai-apikey`; add a usable main token and one usable added account credential.
2. Set main quota above threshold and added-account quota below threshold.
3. Assert the registry/presets/management DTO expose `openai`, `openai-apikey`, and no
   `openai-multi`.
4. Send bare HTTP/SSE, compact, and WebSocket turns. Assert default Pool picks the added credential,
   preserves bare selected/wire ids, records provider `openai`/safe account label, and tracks the
   pool WebSocket account.
5. PATCH `providers.openai.codexAccountMode` to `direct` through the real management endpoint.
6. Repeat bare HTTP/SSE, compact, and WebSocket turns. Assert caller bearer ownership, no injected
   account id, zero pool-state mutation, and no model/catalog identity change.
7. Switch back to Pool and verify the next new turn re-enters affinity/quota selection after the
   affinity map was cleared.
8. Run unchanged explicit `openai-apikey/gpt-5.6`, Sol/Terra/Luna Pro, compact, log, usage,
   disabled-model, subagent, and injection identity cases. No bare request may hit API transport.
9. Assert `/api/models` contains one `openai` group of bare native ids, the unchanged API group, and
   no namespaced legacy Multi id.
10. Spawn the renamed migration child and compare its exact receipt.

The test’s evidence JSON becomes `evidence/030_e2e.json` with fields:

```json
{
  "schemaVersion": 1,
  "verdict": "PASS",
  "publicNetworkFallback": false,
  "poolDefault": "PASS",
  "directIsolation": "PASS",
  "http": "PASS",
  "websocket": "PASS",
  "compact": "PASS",
  "apiProIsolation": "PASS",
  "migrationRestore": "PASS",
  "oneOpenAiModelGroup": "PASS",
  "realClaudeStateUnchanged": true
}
```

## Migration-from-three-tier fixture

### `RENAME + REWRITE tests/fixtures/openai-three-tier-migration-child.ts -> tests/fixtures/openai-provider-option-migration-child.ts`

The child writes a genuine shipped-v1 fixture before importing config/startup modules:

- `openaiProviderTierVersion: 1`;
- canonical `openai` and canonical `openai-multi` rows;
- default `openai-multi`;
- added account and active account;
- legacy Multi references in `disabledModels`, `subagentModels`, `injectionModel`, shadow model,
  global search/vision sidecars, Claude search/vision sidecars, and `providerContextCaps`;
- an unrelated custom provider and unrelated selected ids that must remain byte-equivalent.

The receipt proves:

- `.pre-openai-tiers-v2.bak` bytes exactly match the original and mode is 0600;
- a sentinel `.pre-openai-tiers-v1.bak` is unchanged;
- first output provider ids contain one `openai` and no `openai-multi`/`chatgpt`;
- default is `openai`, mode is `pool`, marker is 2;
- every known legacy namespaced id is bare and arrays are deduplicated in stable order;
- lower context cap wins and warnings contain paths only;
- unrelated provider and API-key ids are unchanged;
- second projection/startup is byte-idempotent and performs no save;
- restoring the v2 backup parses as marker 1, then re-migrates to exactly the first output bytes;
- differing pre-existing v2 backup fails before save.

Keep this fixture process-isolated so module-level config paths and warning sets cannot contaminate
the main test worker.

## Isolated runtime smoke

### Runtime child (moved to Cycle 2, audit fold-back A5)

The rename/rewrite of `scripts/openai-three-tier-runtime-child.ts` ->
`scripts/openai-provider-option-runtime-child.ts` is delivered by Cycle 2 (see
`020_surfaces.md` §Render-grounded QA) so Cycle 2's render QA is independently gated. This
cycle consumes the already-renamed child and owns only the PARENT smoke/evidence
orchestration below. The child contract for reference:

- Continue deleting inherited `OPENAI_*`, `CODEX_*`, `OPENCODEX_*`, and proxy env variables before
  installing fixture-only values.
- Continue using temporary `OPENCODEX_HOME`/`CODEX_HOME`, an explicit loopback host, a reserved
  kernel-assigned port, and deny-by-default intercepted upstream fetches.
- Configure one `openai` (mode omitted to test pool default) and unchanged `openai-apikey`.
- Add one fixture pool credential. Seed main quota hot and added quota cool so the first bare probe
  selects a non-main account.
- Expose the normal management endpoint so the parent can PATCH Direct without restart.
- Capture `providerName`, `accountMode`, credential owner, safe account owner, selected model, wire
  model, reasoning mode, and upstream URL. Never write raw credentials to evidence.
- Keep catalog sync and Codex config injection checks; require no `openai-multi/*` slug and require
  unchanged API Pro slug.
- Emit `{ type: "ready", pid, port, version, catalogReady: true }`; assert `port !== 10100`.

### `RENAME + REWRITE scripts/openai-three-tier-runtime-smoke.ts -> scripts/openai-provider-option-runtime-smoke.ts`

Preserve two cold starts, distinct PID proof, readiness/health matching, real-state hash before/after,
actual `codex exec` API-Pro run, redacted failures, timeout bounds, and guaranteed child teardown.

New probe order on the second child:

1. bare `gpt-5.6-sol` with admission/caller bearer while mode is missing => captured Pool, non-main
   added account;
2. PATCH Direct through the isolated management API;
3. bare `gpt-5.6-terra` => captured Direct/caller bearer and no account id;
4. actual `codex exec --model openai-apikey/gpt-5.6-sol-pro` => API key, wire Sol, Pro mode;
5. verify catalog has one bare OpenAI group and API Pro row, no legacy namespace.

The smoke must never call `ocx stop`, `ocx restart`, `/api/shutdown`, process-control helpers, or a
fixed port. Before starting, record the read-only PID/listener identity for `127.0.0.1:10100` when
present; after teardown, require the same identity. Absence is recorded as absence and is not
“fixed.”

Write:

- `evidence/030_runtime_smoke.json`
- `evidence/030_client_history.json`

Runtime evidence has separate `poolDefault`, `direct`, and `apiPro` objects under the same public
provider contract. The existing opt-in live-key probe remains API-only and requires
`OCX_ALLOW_LIVE_OPENAI_SMOKE=1`; otherwise it records `NOT RUN` with zero live calls.

## Verification-tooling renames

False hardening/three-tier names must not remain as active gate owners.

### `RENAME + MODIFY scripts/openai-hardening-evidence-scan.ts -> scripts/openai-provider-option-evidence-scan.ts`

- Validate `030_e2e.json`, `030_runtime_smoke.json`, `030_client_history.json`, and
  `030_gate_summary.txt`.
- Require pool-default, direct-isolation, API-Pro, distinct-PID, catalog-ready, user-state, and
  live-key-policy fields.
- Reject raw bearer/key/token/account fixture values and absolute temporary/user paths.

### `RENAME + MODIFY scripts/openai-hardening-final-gates.ts -> scripts/openai-provider-option-final-gates.ts`

- Update test/script/doc manifests to renamed paths and the new unit root.
- Replace gate label `openai-three-tier-e2e` with `openai-provider-option-e2e`.
- Run the isolated smoke, optional live-key status, evidence scan, full isolated tests, typecheck,
  GUI build, docs build, privacy scan, stale-contract scan, and `git diff --check`.
- The gate script may read listener/process state for 10100 but must contain no stop/restart/signal
  operation for it.

### `RENAME + MODIFY tests/openai-hardening-tooling.test.ts -> tests/openai-provider-option-tooling.test.ts`

- Update fixture filenames/schema and script imports.
- Test pass, missing-field, secret-leak, stale-absolute-path, wrong live-key policy, and gate-summary
  failure cases.
- Replace fixture `openai-multi-main` owner with one `openai` pool-mode owner and separately require
  Direct/caller evidence.

`scripts/openai-hardening-live-policy.ts` and `scripts/openai-hardening-runtime-env.ts` have no
three-tier semantics and may retain names only if a pre-write search confirms no stale provider
contract. If imported by renamed tooling, their behavior remains unchanged.

## Remaining regression fixture updates

These current test files are not renamed, but any marker-1/Multi fixture is updated or explicitly
kept only as migration input:

| Path | Required rewrite |
| --- | --- |
| `tests/openai-api-virtual-models.test.ts` | Marker 2 current configs; remove Multi from comparison loops; API alias/catalog assertions unchanged. |
| `tests/server-images.test.ts` | Current fixtures use `openai` pool/direct; only dedicated migration input may contain legacy id. |
| `tests/server-search.test.ts` | Same one-provider mode conversion and provider-log expectation. |
| `tests/vision-sidecar-e2e.test.ts` | Current fixture marker 2 and one forward candidate. |
| `tests/web-search.test.ts` | Expected candidate is `openai` with pool mode. |
| `tests/claude-messages-endpoint.test.ts` | Pool default is `openai`, selected models are bare. |
| `tests/claude-models-discovery.test.ts` | Current config marker 2; no duplicate Multi group. |
| `tests/oauth-public-surface.test.ts` | Current config marker 2; no public legacy id. |
| `tests/codex-catalog.test.ts` | Current rows/context caps are one native group; legacy rows exist only in migration-specific cases. |
| `tests/provider-quota.test.ts` | Provider report key is `openai`; Pool/Direct account choice is explicit. |
| `tests/codex-quota-prime.test.ts` | Pool primes, Direct does not. |
| `tests/router.test.ts` | No runtime legacy namespace and no API fallback for bare ids. |
| `tests/server-auth.test.ts` | All current auth/sidecar/WS fixtures use one provider option; v1 input appears only in migration coverage. |

After the exhaustive changes in Cycles 1–3, this command may match `openai-multi` only in the
migration implementation/tests/fixture and explicit historical/supersession prose:

```sh
rg -n 'openai-multi|OPENAI_MULTI_PROVIDER_ID|Codex Multi-account|three-tier' \
  src gui/src tests scripts README.md README.ko.md README.zh-CN.md structure docs-site/src/content/docs
```

Any match in registry, derive/preset output, router, catalog, current DTO/GUI, runtime smoke current
fixture, or active usage instructions is a gate failure. The old constant spelling
`OPENAI_MULTI_PROVIDER_ID` must have zero matches; migration uses
`LEGACY_OPENAI_MULTI_PROVIDER_ID`.

## Current documentation diff manifest

Do not edit anything under `devlog/_fin/260717_openai_hardening`.

### `MODIFY README.md`, `README.ko.md`, `README.zh-CN.md`

- Replace the three-provider table/examples with one `openai` Codex-login provider whose Pool
  default and Direct option are shown, plus unchanged `openai-apikey` examples.
- Replace `openai-multi/<model>` examples with bare ids and point account-mode changes to Providers.
- Document marker 2 and `.pre-openai-tiers-v2.bak`; retain one short compatibility note that v1
  three-tier configs migrate automatically.
- Preserve unrelated user edits already present in localized READMEs; patch only matching contract
  paragraphs.

### `MODIFY structure/08_openai-provider-tiers.md`

- Keep the path as the stable OpenAI contract SoT.
- Retitle to `OpenAI Provider Account-Mode SOT`.
- First paragraph: “This current contract supersedes the provider-identity and account-selection
  sections of `devlog/_fin/260717_openai_hardening`; that archived unit remains historical evidence
  for the earlier three-tier implementation.”
- Replace the provider table, model examples, migration/restore section, model/wire identity,
  sidecar rules, and management/UI section with the locked v2 contract.
- State exact defaults, direct short-circuit, pool engine, no API fallback, marker 2, v2 backup,
  selected-id rewrites, one model group, and option banner.
- Do not add a “correction” inside the archived `_fin` unit.

### `MODIFY structure/00_overview.md`, `structure/03_catalog-and-subagents.md`, `structure/04_transports-and-sidecars.md`, `structure/05_gui-and-management-api.md`

These are current structure summaries containing the old split. Make only contract-local edits:
one option-aware `openai`, bare native ids, one mode-aware sidecar candidate, one provider card, and
one Models group. Point detailed rules to `structure/08_openai-provider-tiers.md`.

### `MODIFY docs-site/src/content/docs/guides/codex-app-models.md` and locale peers

- Paths:
  - `docs-site/src/content/docs/guides/codex-app-models.md`
  - `docs-site/src/content/docs/ko/guides/codex-app-models.md`
  - `docs-site/src/content/docs/zh-cn/guides/codex-app-models.md`
- Replace three identities/tier selection with one bare OpenAI model group controlled by
  `codexAccountMode`; delete the Multi row; retain API metadata/Pro alias text unchanged.
- Replace restore commands with v2 backup and explain v1 compatibility once.

### `MODIFY only the docs-site locale guides/reference pages where the old Multi contract currently appears`

The grounded allowlist is:

- `docs-site/src/content/docs/guides/codex-integration.md`
- `docs-site/src/content/docs/guides/model-routing.md`
- `docs-site/src/content/docs/guides/providers.md`
- `docs-site/src/content/docs/reference/configuration.md`
- `docs-site/src/content/docs/ko/guides/codex-integration.md`
- `docs-site/src/content/docs/ko/guides/model-routing.md`
- `docs-site/src/content/docs/ko/guides/providers.md`
- `docs-site/src/content/docs/ko/reference/configuration.md`
- `docs-site/src/content/docs/zh-cn/guides/codex-integration.md`
- `docs-site/src/content/docs/zh-cn/guides/model-routing.md`
- `docs-site/src/content/docs/zh-cn/guides/providers.md`
- `docs-site/src/content/docs/zh-cn/reference/configuration.md`

For each, change only paragraphs/tables/config rows that publish Direct/Multi as providers, the
legacy namespace, marker 1 as current, or the v1 backup as the current restore point. Add
`OcxProviderConfig.codexAccountMode?: "pool" | "direct"` with default Pool in configuration
reference. Do not opportunistically translate or rewrite unrelated sections.

After edits, rerun the same `rg` allowlist discovery. A newly found current docs page is added only
if it contains the old active contract; do not bulk-edit docs with no relevant match.

## Verification gates

Run in dependency order from repository root. All commands must exit 0 unless explicitly marked as
an optional live probe.

```sh
# Focused semantic and surface suite
bun test --isolate \
  tests/openai-provider-option.test.ts \
  tests/openai-provider-option-migration.test.ts \
  tests/openai-provider-option-startup.test.ts \
  tests/openai-provider-option-e2e.test.ts \
  tests/openai-provider-option-tooling.test.ts \
  tests/provider-registry-parity.test.ts \
  tests/provider-payload.test.ts \
  tests/codex-account-mode-state.test.ts \
  tests/router.test.ts \
  tests/codex-routing.test.ts \
  tests/server-auth.test.ts \
  tests/codex-catalog.test.ts \
  tests/codex-quota-prime.test.ts \
  tests/provider-quota.test.ts \
  tests/server-images.test.ts \
  tests/server-search.test.ts

# Required isolated runtime; child ports must be non-10100
bun scripts/openai-provider-option-runtime-smoke.ts \
  --unit-root devlog/_plan/260717_openai_single_provider_option \
  --evidence-dir devlog/_plan/260717_openai_single_provider_option/evidence

# Optional paid/public call; records NOT RUN unless explicitly authorized
bun scripts/openai-provider-option-runtime-smoke.ts --check-live-key \
  --unit-root devlog/_plan/260717_openai_single_provider_option \
  --evidence-dir devlog/_plan/260717_openai_single_provider_option/evidence

# Repository-wide gates
bun test --isolate tests
bun run typecheck
bun run build:gui
bun run privacy:scan
cd docs-site && bun install --frozen-lockfile && bun run build
```

Return to the repository root, then run:

```sh
bun scripts/openai-provider-option-evidence-scan.ts \
  devlog/_plan/260717_openai_single_provider_option/evidence

rg -n 'openai-multi|OPENAI_MULTI_PROVIDER_ID|Codex Multi-account|three-tier' \
  src gui/src tests scripts README.md README.ko.md README.zh-CN.md structure docs-site/src/content/docs

git diff --check -- \
  src gui/src tests scripts README.md README.ko.md README.zh-CN.md structure \
  docs-site/src/content/docs devlog/_plan/260717_openai_single_provider_option
```

`bun test --isolate tests` is the authoritative full-suite gate. Record exact pass/fail counts,
duration, commit, and command in `evidence/030_gate_summary.txt`; do not copy old archived counts.

## Evidence and safety receipts

Required evidence directory contents:

- `030_e2e.json`
- `030_runtime_smoke.json`
- `030_client_history.json`
- `030_gate_summary.txt`
- desktop/mobile screenshots and DOM receipts from Cycle 2
- a read-only `live_10100_before_after.json` containing listener identity before/after (or explicit
  absence), with no command capable of changing that listener
- `stale_contract_scan.txt` showing only approved migration/history matches

Evidence must contain no bearer, API key, refresh token, raw account id, user home path, or temporary
absolute path. The scanner and privacy gate both enforce this.

## Closeout and `_fin` move rule

Keep the unit under `_plan` while any implementation, test, render, docs, evidence, or audit item is
open. A failed optional paid probe is not required when authorization is absent, but it must be
honestly recorded as `NOT RUN`; every local/isolated gate is required.

Move exactly once only when:

1. all three cycle acceptance tables are satisfied;
2. focused and full tests, typecheck, GUI build, docs build, privacy scan, evidence scan, and diff
   check are green;
3. stale-contract matches are limited to migration/history contexts;
4. render evidence covers Pool, Direct, disabled/absent, desktop/mobile, and en/ko/de/zh;
5. live 10100 listener identity is unchanged;
6. `git status --short` is reviewed so unrelated pre-existing user changes are neither included nor
   reverted;
7. no push/release action has occurred.

Then move the whole directory, preserving evidence and filenames:

```text
devlog/_plan/260717_openai_single_provider_option
  -> devlog/_fin/260717_openai_single_provider_option
```

Do not copy-and-leave two units. Update active script defaults/manifests to resolve `_plan` first and
`_fin` second, as the existing runtime smoke pattern does. If any required gate fails, leave the
unit in `_plan`, record the exact blocker/evidence gap, and do not claim completion.

No commit, push, PR, publish, or live-proxy restart is part of closeout unless separately authorized
by the user after this unit is complete.

## Cycle 3 execution receipt — 2026-07-18

### Integration and migration

- `bun test tests/openai-provider-option-e2e.test.ts`: 1 pass, 0 fail, 79 assertions.
- Combined focused command: 309 pass, 0 fail, 3,616 assertions.
- E2E evidence: `evidence/030_e2e.json` — Pool default rotation, Direct byte/state isolation,
  HTTP/SSE, Responses WebSocket, compact, API Pro identity, migration restore, one OpenAI model
  group, and real Claude state all PASS.
- Migration child receipt is exact and process-isolated. It includes the shipped Direct + Multi +
  API + custom fixture, all known sidecar/Claude model paths, actual backup restore, exact
  re-migration bytes, marker 2 idempotence/no-save, absence preservation, and differing-backup
  pre-save collision.

### Isolated runtime

- Required smoke: PASS.
- Cold start 1: PID 70490, opencodex 2.7.23, port 63954.
- Cold start 2: PID 70529, opencodex 2.7.23, port 63956.
- Both ports are kernel-assigned and not 10100; PIDs are distinct.
- Pool probe selected an added credential for bare `gpt-5.6-sol`; PATCH Direct then used the caller
  for bare `gpt-5.6-terra`; actual `codex exec` preserved
  `openai-apikey/gpt-5.6-sol-pro` -> `gpt-5.6-sol` + Pro.
- Live listener before/after: PID 17423, `bun.exe`, `127.0.0.1:10100`, byte-identical receipt and
  no control action. See `evidence/live_10100_before_after.json`.
- Optional live key: `NOT RUN (credential unavailable)`, zero live calls.
- Deviation: the Cycle 2 child starts with `startServer(0)`, whose `/healthz` reports the requested
  ephemeral sentinel port `0` while readiness reports the actual assigned port. The parent accepts
  only actual-port equality or this explicit `0` sentinel while still matching PID, version, and
  the actual health URL; no Cycle 2 child/server expansion was made.

### Repository gates and docs

- `bun test --isolate tests`: 2,850 pass, 0 fail, 12,188 assertions, 256 files, 51.80s.
- `bun x tsc --noEmit`: PASS.
- `cd gui && bun run lint:i18n && bun run build`: PASS.
- `cd docs-site && bun run build`: PASS, 55 pages.
- `bun run privacy:scan`: PASS.
- `bun scripts/openai-provider-option-evidence-scan.ts .../evidence`: PASS.
- Scoped `git diff --check`: PASS.
- Stale-contract scan: 118 approved migration/history/rejection/negative-guard matches across
  21 files; exact obsolete constant matches 0; active README/docs-site/structure-summary matches 0.
  See `evidence/stale_contract_scan.txt`.
- Gate totals and commit anchor are recorded in `evidence/030_gate_summary.txt`.

Terminal status: **PASS — READY_FOR_PARENT_ARCHIVE**. Per delegation, the unit remains in `_plan`.
