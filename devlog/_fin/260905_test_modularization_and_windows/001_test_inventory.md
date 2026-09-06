# 001 — Complete `tests/` inventory

Unit: `devlog/_plan/260905_test_modularization_and_windows/`
Checkout: `/Users/jun/.codex/worktrees/4b3a/opencodex`
HEAD: `9c0e3ca80d24af299dfe740c6cb046aaed0285d0` (`codex/test-modularization-260905`)
Date: 2026-09-05. Read-only inventory. No tracked files were modified.

Work class: C3 docs inventory (cxc-dev). No product code, no test moves.

The plan brief said 1053 files. Live `find tests -type f` on this HEAD is **1127 files** (1061 `*.test.ts` + 66 support). The 1053 figure matches neither current `*.test.ts` (1061) nor current total files (1127). Treat 1127/1061 as the inventory source of truth for this checkout.

## Commands used

```bash
find tests -type f | wc -l
find tests -type d | wc -l
find tests -maxdepth 1 -type f | wc -l
find tests -mindepth 2 -type f | wc -l
find tests -type f \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.test.js' -o -name '*.spec.ts' \ ) | wc -l
find tests -maxdepth 1 -type f -name '*.test.ts' | wc -l
find tests/helpers tests/fixtures tests/e2e-style tests/images tests/videos -type f | wc -l
cxc map tests   # ran; returns ranked function maps, not a file inventory
python3  # import parser for from "../src/...", helper coupling, domains, sizes
rg -n 'tests/' tests scripts .github src bunfig.toml package.json tsconfig.json
rg -n 'readFileSync|Bun.file|readdirSync' tests --glob '*.ts'
sed -n 1,242p scripts/ci/run-bun-test-batches.sh
sed -n 1,567p scripts/test.ts
sed -n 1,80p bunfig.toml
```

`cxc map tests` is present (`/Users/jun/.nvm/versions/node/v24.17.0/bin/cxc`) but emits ranked function maps for individual files, not a directory inventory. Counts below come from `find` + a Python walk of the live tree.

## 1. Counts

| Bucket | Count | Notes |
|---|---:|---|
| Total files under `tests/` | 1127 | `find tests -type f` |
| Directories under `tests/` | 9 | `tests` plus 5 children: helpers, fixtures, e2e-style, images, videos. helpers also has `adapter-conformance/`; fixtures has `compatibility/` and `fabric-executors/` |
| Files at `tests/` maxdepth 1 (flat) | 1048 | 1045 `*.test.ts` + 3 support |
| Files at depth >= 2 | 79 | helpers 39 + fixtures 24 + e2e-style 1 + images 12 + videos 3 |
| `*.test.ts` (Bun-discoverable tests) | 1061 | 1045 flat + 1 e2e-style + 12 images + 3 videos. Zero `*.test.tsx` / `*.test.js` / `*.spec.ts` |
| Support / non-test files | 66 | 1127 − 1061 |
| `tests/helpers/**` | 39 | 0 helpers are themselves `*.test.ts` |
| `tests/fixtures/**` | 24 | JSON model dumps, YAML DSH settings, TS child/oracle fixtures |
| `tests/e2e-style/**` | 1 | `phase100-native-parity.test.ts` |
| `tests/images/**` | 12 | already a nested domain; all `*.test.ts` |
| `tests/videos/**` | 3 | already a nested domain; all `*.test.ts` |
| Flat support at `tests/` root | 3 | `fake-codex-server.ts`, `preload.ts`, `tsconfig.doctor-service-memory-contract.json` |
| Extensions | ts=1107, json=16, yaml=2, png=1, js=1 | png is `tests/helpers/cursor-grumpy-fixture.png`; js is `tests/fixtures/cursor-agent-exec-effort-table.min.js` |
| Total lines across 1061 `*.test.ts` | 396378 | includes the already-nested images/videos/e2e-style files |

### Support files (66)

**Flat (3):** `tests/preload.ts` (bunfig preload; sandboxes HOME), `tests/fake-codex-server.ts`, `tests/tsconfig.doctor-service-memory-contract.json` (CI `bun x tsc --noEmit -p` in `.github/workflows/ci.yml:419`).

**helpers (39):**

```
tests/helpers/account-login-device-child.ts
tests/helpers/account-login-pipe-child.ts
tests/helpers/adapter-conformance/wire-drivers.ts
tests/helpers/agent-task-recovery.ts
tests/helpers/catalog-convergence.ts
tests/helpers/catalog-provider-fetch.ts
tests/helpers/ci-watchdog.ts
tests/helpers/codex-adoption-crash-child.ts
tests/helpers/codex-history-manifest-fixtures.ts
tests/helpers/codex-inject-race-child.ts
tests/helpers/codex-write-lock-child.ts
tests/helpers/cursor-grumpy-fixture.png
tests/helpers/dead-pid.ts
tests/helpers/enforce-pr-target-harness.ts
tests/helpers/fabric-task-test.ts
tests/helpers/fake-chatgpt-jwt.ts
tests/helpers/isolated-codex-home.ts
tests/helpers/logs-api.ts
tests/helpers/management-auth.ts
tests/helpers/management-route-scan.ts
tests/helpers/native-main-claim-child.ts
tests/helpers/native-main-owner-child.ts
tests/helpers/native-profile-lock-child.ts
tests/helpers/native-profile-startup-child.ts
tests/helpers/native-profile-switch-child.ts
tests/helpers/owned-service-home-inspection.ts
tests/helpers/owned-service-home-preload.ts
tests/helpers/owned-service-home.ts
tests/helpers/provider-registry-discovery.ts
tests/helpers/remove-tree.ts
tests/helpers/responses-conformance.ts
tests/helpers/responses-state-never-settling-acl-child.ts
tests/helpers/responses-state-shutdown-budget-child.ts
tests/helpers/startup-health.ts
tests/helpers/storage-policy-api.ts
tests/helpers/test-budget.ts
tests/helpers/translator-budget.ts
tests/helpers/windows-power-shell-fixture.ts
tests/helpers/windows-tray-inheritance-child.ts
```

**fixtures (24):**

```
tests/fixtures/baseten-models.json
tests/fixtures/chutes-models.json
tests/fixtures/commandcode-models.json
tests/fixtures/compatibility/openai-codex-forward-gpt56-sol-v1.json
tests/fixtures/cursor-agent-exec-effort-table.min.js
tests/fixtures/deepinfra-models.json
tests/fixtures/digitalocean-models.json
tests/fixtures/dsh-rc6-compat-e2e-settings.yaml
tests/fixtures/dsh-settings-0.1.0-rc.6.yaml
tests/fixtures/fabric-executors/correct-patch.ts
tests/fixtures/featherless-models.json
tests/fixtures/hyperbolic-models.json
tests/fixtures/minimax-bridge-direct.ts
tests/fixtures/nebius-models.json
tests/fixtures/novita-models.json
tests/fixtures/nscale-models.json
tests/fixtures/openai-provider-option-migration-child.ts
tests/fixtures/provider-model-discovery.json
tests/fixtures/provider-outbound-e2e.ts
tests/fixtures/sambanova-models.json
tests/fixtures/scaleway-models.json
tests/fixtures/translator-budget-required.invalid.ts
tests/fixtures/translator-budget-required.valid.ts
tests/fixtures/vultr-models.json
```

## 2. Domain clustering

Two views: (A) filename first-token histogram of the 1045 flat `tests/*.test.ts`; (B) a proposed exclusive 33-directory layout covering every one of the 1061 `*.test.ts` files. (B) is the migration proposal: 22 top-level domains, with 7 provider/adapter subtrees. Nested `tests/images/`, `tests/videos/`, `tests/e2e-style/` are kept as they already exist.

The brief asked for 12–25 domain directories. **First-wave recommendation is 25 dirs** by collapsing the 8 provider/adapter subtrees into `tests/providers/` (201) and `tests/adapters/` (86). The 33-dir table in §2.B is the optional second-wave split of those two buckets (cursor 63, kiro 14, xai 17, ollama 8, github-copilot 5, google 25, anthropic 19, openai 16). Nested `images/`, `videos/`, `e2e-style/` stay as they already exist.

First-wave 25 (exclusive, sums to 1061):

| Dir | n |
|---|---:|
| `tests/providers/` (incl. cursor/kiro/xai/ollama/github-copilot) | 201 |
| `tests/codex-integration/` | 175 |
| `tests/server/` | 95 |
| `tests/adapters/` (incl. google/anthropic/openai) | 86 |
| `tests/responses/` | 63 |
| `tests/lab/` | 53 |
| `tests/cli/` | 45 |
| `tests/routing/` | 34 |
| `tests/gui/` | 31 |
| `tests/oauth/` | 31 |
| `tests/claude-integration/` | 28 |
| `tests/ci-workflows/` | 27 |
| `tests/usage/` | 25 |
| `tests/lib/` | 21 |
| `tests/clients/` | 20 |
| `tests/service/` | 20 |
| `tests/windows/` | 20 |
| `tests/storage/` | 18 |
| `tests/vision/` | 17 |
| `tests/config/` | 16 |
| `tests/images/` | 12 |
| `tests/web-search/` | 10 |
| `tests/update/` | 9 |
| `tests/videos/` | 3 |
| `tests/e2e-style/` | 1 |

Assignment rule (first match wins): existing nested dir → CI/repo/release filename prefixes → GUI filename **or** `gui/src` import (except CLI/server/api/codex/claude-cli tests) → windows/win/winsw/tray → lab → oauth/chatgpt-oauth → cli/ocx/star → storage/api-storage → responses/openai-responses/chat-completions/sse/ws → server/api/management → routing/router/combo/subagent → cursor/kiro/claude/anthropic/google/openai/ollama/grok|xai/github → remaining named providers → native/codex/catalog → web-search → vision/sidecar → usage/request/quota → update → config → service/doctor → clients/integrations → src-area fallback → four lib source-oracles + helper test.

Filename-prefix and `from "../src/..."` disagree in 9 files (GUI source-oracles named `claude-*`, `codex-*`, `oauth-*`, `routing-*`, `vision-*`; plus `openai-responses-passthrough.test.ts` which is a Responses protocol test). Those 9 follow the import/oracle surface, not the filename token.

Runtime `from "../src/..."` coverage: **986 / 1061** tests import at least one `src/` module. **75** do not (GUI source-oracles, scripts CI tests, CLI subprocess tests, hygiene). Unique-test `src/<area>` hits (a test may count in several areas):

| `src/<area>` | unique tests |
|---|---:|
| types | 511 |
| server | 312 |
| codex | 275 |
| adapters | 229 |
| lib | 191 |
| providers | 161 |
| config | 149 |
| oauth | 112 |
| cli | 82 |
| responses | 70 |
| router | 59 |
| lab | 57 |
| bridge | 38 |
| usage | 36 |
| claude | 35 |
| routing | 31 |
| integrations | 22 |
| web-search | 21 |
| clients | 20 |
| vision | 19 |
| images | 15 |
| reasoning-effort | 14 |
| storage | 13 |
| update | 11 |
| service | 9 |
| grok | 9 |
| chat | 7 |
| combos | 6 |
| client | 5 |
| sidecar | 4 |
| generated / service-manager-probe | 3 each |
| github / tray | 2 each |
| compatibility / remote / stall-timeout | 1 each |

Top unique-test `src/` modules: `src/types` 508, `src/config` 147, `src/server` 82, `src/server/management-api` 82, `src/providers/registry` 77, `src/codex/catalog` 72, `src/adapters/openai-chat` 60, `src/router` 59, `src/oauth/store` 57, `src/providers/derive` 55.

`gui/src` imports: **28** tests. `scripts/` imports: **15** tests. Zero tests `import` `.github/` as a module; several **read** workflow YAML as text (see §3).

### 2.A Filename first-token (1045 flat `tests/*.test.ts`)

| n | token | | n | token |
|---:|---|---|---:|---|
| 118 | codex | | 10 | usage, vision |
| 63 | cursor | | 9 | update, web |
| 52 | lab | | 8 | bridge, client, xai, model, ollama, sidecar |
| 38 | responses | | 7 | adapter, catalog, config, management, request, sse |
| 34 | cli | | 6 | agent, subagent, upstream |
| 29 | claude | | 5 | desktop, doctor, github, gui, integrations, local, service, system |
| 25 | provider | | 4 | alibaba, cline, combo, command, deepseek, empty, fastwire, muse, quota, reasoning, startup |
| 24 | oauth | | 3 | chatgpt, cl01, compatibility, dsh, fast, gemini, issue, key, mimo, ocx, passthrough, process, release, router, settings, terminal, tool, user, zz |
| 22 | server | | 2 | many (account, bun, logs, models, privacy, rate, tray, winsw, ws, …) |
| 20 | native | | 1 | ~130 hapax tokens |
| 19 | anthropic, google | | | |
| 17 | openai | | | |
| 16 | api | | | |
| 15 | windows | | | |
| 14 | kiro, routing | | | |
| 11 | grok, opencode, storage | | | |

Two-token prefixes (selected): `lab-public` 17, `codex-log` 12, `openai-chat` 10, `native-profile` 10, `codex-prompt` 9, `web-search` 8, `cursor-tool` 8, `codex-catalog` 8, `opencode-go` 7, `codex-history` 7, `lab-automation` 6, `api-storage` 6.

### 2.B Proposed exclusive directories (1061 = 100%)

| Dir | n | `src/` areas (unique tests) | 5 example files |
|---|---:|---|---|
| `tests/codex-integration/` | 175 | `codex` 161, `types` 67, `server` 41, `config` 37, `lib` 23, `providers` 10, `cli` 9, `adapters` 8 | `active-registry-admission.test.ts`, `app-owned-memory.test.ts`, `bearer-admission-routed-provider.test.ts`, `catalog-cursor-search.test.ts`, `catalog-input-modality-enum.test.ts` |
| `tests/server/` | 95 | `server` 85, `types` 61, `config` 33, `lib` 27, `codex` 15, `providers` 10, `usage` 9, `oauth` 8 | `account-import.test.ts`, `account-pool-management-api.test.ts`, `adapter-resolve.test.ts`, `agent-task-recovery-cache.test.ts`, `agent-task-recovery-combo.test.ts` |
| `tests/providers/` | 94 | `types` 76, `providers` 66, `adapters` 43, `router` 30, `oauth` 28, `codex` 20, `server` 20, `cli` 14 | `alibaba-region-backup.test.ts`, `alibaba-region-migration.test.ts`, `alibaba-region-startup.test.ts`, `aside-client.test.ts`, `auto-compact-budget.test.ts` |
| `tests/providers/cursor/` | 63 | `adapters` 56, `types` 26, `lib` 8, `codex` 7, `server` 6, `providers` 5, `config` 3, `responses` 3 | `cursor-adapter.test.ts`, `cursor-arg-normalize.test.ts`, `cursor-blob-integrity.test.ts`, `cursor-blob.test.ts`, `cursor-call-id.test.ts` |
| `tests/responses/` | 63 | `server` 40, `types` 33, `responses` 23, `lib` 15, `adapters` 15, `providers` 11, `codex` 6, `bridge` 5 | `apply-patch-envelope.test.ts`, `chat-completions-endpoint.test.ts`, `citation-markers.test.ts`, `continuation-dedup.test.ts`, `custom-tool-compat.test.ts` |
| `tests/lab/` | 53 | `lab` 50, `lib` 13, `types` 12, `server` 9, `routing` 6, `cli` 5, `usage` 1 | `core-lab-boundary.test.ts`, `lab-activation.test.ts`, `lab-automation-coderabbit-regressions.test.ts`, `lab-automation-final-coderabbit-regressions.test.ts`, `lab-automation-ingwannu-regressions.test.ts` |
| `tests/cli/` | 45 | `cli` 34, `types` 7, `codex` 4, `server` 4, `lib` 4, `oauth` 3, `config` 2, `service` 2 | `agent-driven.test.ts`, `cli-account-pool-verbs.test.ts`, `cli-account.test.ts`, `cli-capabilities.test.ts`, `cli-catalog-prewarm.test.ts` |
| `tests/routing/` | 34 | `types` 26, `server` 15, `routing` 15, `codex` 10, `providers` 9, `adapters` 6, `router` 6, `lab` 5 | `cl01-claude-outbound-review-regressions.test.ts`, `cl01-openai-chat-review-regressions.test.ts`, `cl01-review-regressions.test.ts`, `combo-child-headers.test.ts`, `combo-management-api.test.ts` |
| `tests/gui/` | 31 | `providers` 5, `server` 3, `types` 3, `lib` 2, `cli` 2, `codex` 2, `oauth` 2, `router` 2 | `alibaba-intl-token-plan.test.ts`, `claude-manual-env.test.ts`, `codex-account-mode-state.test.ts`, `codex-auth-modal-status.test.ts`, `combo-workspace-data.test.ts` |
| `tests/oauth/` | 31 | `oauth` 31, `types` 17, `lib` 12, `server` 11, `config` 10, `providers` 4, `adapters` 3, `codex` 3 | `adapter-event-oauth-failover.test.ts`, `chatgpt-device-auth.test.ts`, `chatgpt-oauth.test.ts`, `chatgpt-token-expiry.test.ts`, `generic-oauth-failover.test.ts` |
| `tests/claude-integration/` | 28 | `claude` 19, `types` 16, `server` 15, `config` 6, `codex` 6, `cli` 4, `lib` 4, `adapters` 3 | `claude-529-mapping.test.ts`, `claude-agent-startup-sync.test.ts`, `claude-agents-inject.test.ts`, `claude-alias.test.ts`, `claude-auth-detect.test.ts` |
| `tests/ci-workflows/` | 27 | `lib` 4, `clients` 2, `integrations` 2, `types` 2, `config` 2, `server` 1, `cli` 1, `codex` 1 | `assert-mergeable-review.test.ts`, `build-release-changelog.test.ts`, `bump-dev-version.test.ts`, `bun-runtime.test.ts`, `ci-workflows.test.ts` |
| `tests/adapters/` | 26 | `types` 24, `adapters` 16, `bridge` 14, `responses` 8, `server` 6, `lib` 5, `providers` 4, `router` 2 | `abort-race.test.ts`, `adapter-buffered-tool-conformance.test.ts`, `adapter-error-inline.test.ts`, `adapter-registry-authority.test.ts`, `adapter-tool-conformance.test.ts` |
| `tests/adapters/google/` | 25 | `adapters` 20, `types` 18, `providers` 6, `lib` 5, `responses` 4, `codex` 3, `oauth` 3, `usage` 2 | `antigravity-baseurl-override.test.ts`, `antigravity-static-catalog.test.ts`, `gcp-adc.test.ts`, `gemini-37-flash-migration.test.ts`, `gemini-web-search.test.ts` |
| `tests/usage/` | 25 | `usage` 14, `types` 12, `server` 10, `routing` 5, `config` 5, `providers` 4, `codex` 3, `router` 2 | `cost-cap-unknown-evidence.test.ts`, `cost-scoring.test.ts`, `quota-401-recovery-runtime.test.ts`, `quota-401-recovery.test.ts`, `quota-scoring.test.ts` |
| `tests/lib/` | 21 | `lib` 16, `lab` 1, `stall-timeout` 1 | `abort-idle-deadline.test.ts`, `acl-error-classification.test.ts`, `bun-stream-caps.test.ts`, `clearable-deadline.test.ts`, `credential-redirect-guard.test.ts` |
| `tests/clients/` | 20 | `integrations` 8, `clients` 7, `types` 7, `client` 4, `claude` 4, `codex` 2, `cli` 1, `adapters` 1 | `client-connect.test.ts`, `client-export-modality-enum.test.ts`, `client-fingerprint.test.ts`, `client-hub-relay.test.ts`, `client-machine-listener.test.ts` |
| `tests/service/` | 20 | `cli` 6, `lib` 6, `config` 6, `codex` 5, `server` 4, `types` 3, `service` 3, `oauth` 1 | `autostart-health.test.ts`, `crash-guard.test.ts`, `doctor-codex-envkey-readiness.test.ts`, `doctor-oauth.test.ts`, `doctor-provider-apikey.test.ts` |
| `tests/windows/` | 20 | `lib` 13, `cli` 2, `service` 2, `codex` 2, `tray` 2, `config` 1, `server` 1, `types` 1 | `tray-proxy-deadline.test.ts`, `tray-proxy.test.ts`, `win-exec.test.ts`, `win-paths.test.ts`, `windows-atomic-replace.test.ts` |
| `tests/adapters/anthropic/` | 19 | `adapters` 17, `types` 16, `providers` 4, `bridge` 3, `server` 3, `responses` 3, `oauth` 2, `claude` 2 | `anthropic-account-pool.test.ts`, `anthropic-agentrouter-language-framing.test.ts`, `anthropic-baseurl-override.test.ts`, `anthropic-compatible-stream.test.ts`, `anthropic-empty-content.test.ts` |
| `tests/storage/` | 18 | `storage` 11, `types` 7, `config` 6, `server` 5 | `api-storage-cleanup.test.ts`, `api-storage-policy-already-running.test.ts`, `api-storage-policy-mutation-busy.test.ts`, `api-storage-policy-put-race.test.ts`, `api-storage-policy-run.test.ts` |
| `tests/providers/xai/` | 17 | `types` 9, `grok` 7, `server` 5, `codex` 4, `oauth` 4, `adapters` 4, `config` 2, `responses` 2 | `grok-attribution.test.ts`, `grok-config-inject.test.ts`, `grok-effort-inject.test.ts`, `grok-lifecycle.test.ts`, `grok-management-api.test.ts` |
| `tests/vision/` | 17 | `types` 15, `vision` 13, `server` 10, `codex` 7, `oauth` 6, `responses` 5, `config` 4, `web-search` 3 | `sidecar-abort.test.ts`, `sidecar-auth.test.ts`, `sidecar-candidates.test.ts`, `sidecar-settings-vision-controls.test.ts`, `sidecar-settings-vision-filter.test.ts` |
| `tests/adapters/openai/` | 16 | `types` 13, `adapters` 10, `providers` 6, `config` 4, `lib` 4, `server` 3, `router` 2, `codex` 2 | `openai-api-virtual-models.test.ts`, `openai-chat-dangling-toolcalls.test.ts`, `openai-chat-eof.test.ts`, `openai-chat-hardening.test.ts`, `openai-chat-invalid-tool-call-diagnostics.test.ts` |
| `tests/config/` | 16 | `types` 9, `config` 7, `server` 4, `clients` 3, `codex` 3, `integrations` 2, `lib` 2, `usage` 2 | `client-config-export-new-clients.test.ts`, `client-config-export.test.ts`, `client-config-new-clients.test.ts`, `config-load-degrade.test.ts`, `config-mutation-lock.test.ts` |
| `tests/providers/kiro/` | 14 | `oauth` 8, `types` 7, `adapters` 6, `providers` 4, `responses` 2, `bridge` 2, `lib` 2, `reasoning-effort` 1 | `kiro-account-quota.test.ts`, `kiro-adapter.test.ts`, `kiro-builder-id-profile.test.ts`, `kiro-calibration.test.ts`, `kiro-images.test.ts` |
| `tests/images/` | 12 | `images` 11, `types` 5, `adapters` 4, `lib` 1, `providers` 1, `oauth` 1, `server` 1 | `artifacts-prune.test.ts`, `artifacts-ssrf.test.ts`, `download-cap-default.test.ts`, `gemini-inline.test.ts`, `loop-reasoning-replay.test.ts` |
| `tests/web-search/` | 10 | `web-search` 10, `types` 7, `responses` 5, `server` 4, `adapters` 3, `oauth` 2, `lib` 2, `codex` 2 | `format-result.test.ts`, `web-search-anthropic.test.ts`, `web-search-backend-union.test.ts`, `web-search-candidates.test.ts`, `web-search-parse.test.ts` |
| `tests/update/` | 9 | `update` 9, `lib` 1 | `update-badge.test.ts`, `update-job.test.ts`, `update-notify.test.ts`, `update-npm-cache-preflight.test.ts`, `update-npm-invocation.test.ts` |
| `tests/providers/ollama/` | 8 | `types` 7, `adapters` 6, `codex` 4, `providers` 4, `reasoning-effort` 2 | `ollama-native-parser.test.ts`, `ollama-native-reasoning-wire.test.ts`, `ollama-native-structured-output.test.ts`, `ollama-native-v4.test.ts`, `ollama-native.test.ts` |
| `tests/providers/github-copilot/` | 5 | `server` 4, `types` 3, `providers` 3, `oauth` 2, `lib` 1 | `github-copilot-account-origin.test.ts`, `github-copilot-oauth.test.ts`, `github-copilot-sse-rewrite.test.ts`, `github-copilot-stream-contract.test.ts`, `github-copilot-wire-defaults.test.ts` |
| `tests/videos/` | 3 | `images` 3, `types` 1 | `fulfill-video.test.ts`, `plan-video.test.ts`, `xai-video-client.test.ts` |
| `tests/e2e-style/` | 1 | `codex` 1, `responses` 1, `web-search` 1, `types` 1, `bridge` 1 | `phase100-native-parity.test.ts` |

Sum of the table: **1061**. Zero leftover.

### 2.C Domain notes (migration-relevant)

- **`tests/codex-integration/` (175)** is the largest proposed dir. Filename `codex-*` (118) plus `native-*` (20) plus catalog/admission/bearer files whose primary import is `src/codex/*`. Split further later (`catalog/`, `native-profile/`, `auth/`, `inject/`) if a 175-file PR is too big; do not split on the first move if history-follow matters more than PR size.
- **`tests/providers/` (94)** is the residual provider bucket after extracting cursor (63), kiro (14), xai/grok (17), ollama (8), github-copilot (5). Further per-id dirs (`alibaba/`, `deepseek/`, `muse/`, `opencode/`) are optional second-wave splits; each of those is currently <12 files.
- **`tests/server/` (95)** mixes HTTP endpoints, management API, agent-task recovery, loopback, relay. A later `tests/server/management/` split is natural (`management-*`, `account-pool-*`, `agent-task-*`).
- **`tests/gui/` (31)** is defined by `gui/src` source-oracle reads as much as by `gui-*` filenames. `scripts/test.ts` already special-cases “tests importing gui/src” and installs `gui/node_modules` (comment currently says twenty-five files; live count is 28).
- **`tests/ci-workflows/` (27)** owns scripts/CI/release oracles. These files are the highest-density `tests/` path-literal cluster and must move with `.github/workflows/ci.yml`, `scripts/release.ts`, and `scripts/ci/run-bun-test-batches.sh`.
- **`tests/images/` and `tests/videos/` already exist** and are already discovered by `find tests` / bunfig `root = "tests"`. Do not flatten them.
- **`tests/e2e-style/`** is a single file. Keep the directory; AGENTS.md names it.

### 2.D Full membership (every `*.test.ts`)

#### `tests/codex-integration/` (175)

`active-registry-admission.test.ts`, `app-owned-memory.test.ts`, `bearer-admission-routed-provider.test.ts`, `catalog-cursor-search.test.ts`, `catalog-input-modality-enum.test.ts`, `catalog-llamacpp-capabilities.test.ts`, `catalog-oauth-observation.test.ts`, `catalog-retain-models.test.ts`, `catalog-verbosity-default.test.ts`, `catalog-vision-sidecar-modalities.test.ts`, `codex-account-delete-atomicity.test.ts`, `codex-account-label.test.ts`, `codex-account-namespaces.test.ts`, `codex-account-store.test.ts`, `codex-admission-primitives.test.ts`, `codex-admission.test.ts`, `codex-affinity-debug.test.ts`, `codex-app-server-path-spaces.test.ts`, `codex-app-server-processes.test.ts`, `codex-app-server-restart-service.test.ts`, `codex-auth-api.test.ts`, `codex-auth-collision.test.ts`, `codex-auth-context.test.ts`, `codex-catalog-admission.test.ts`, `codex-catalog-golden.test.ts`, `codex-catalog-model-picker-order.test.ts`, `codex-catalog-refresh-status.test.ts`, `codex-catalog-restore.test.ts`, `codex-catalog-sync-hardening.test.ts`, `codex-catalog-write-serialization.test.ts`, `codex-catalog-writer.test.ts`, `codex-catalog.test.ts`, `codex-cli-install-provenance.test.ts`, `codex-cli-update-launcher-policy.test.ts`, `codex-cli-update-zero-effect.test.ts`, `codex-composed-acceptance.test.ts`, `codex-config-generation.test.ts`, `codex-convergence-account-selectors.test.ts`, `codex-convergence-contract.test.ts`, `codex-cooldown-recovery.test.ts`, `codex-coordinator-doctor.test.ts`, `codex-desired-state.test.ts`, `codex-envkey-admission-substitution.test.ts`, `codex-exec-invocation.test.ts`, `codex-features-cache.test.ts`, `codex-features-residual.test.ts`, `codex-filesystem-evidence.test.ts`, `codex-gather-authority.test.ts`, `codex-history-job.test.ts`, `codex-history-lock.test.ts`, `codex-history-provider.test.ts`, `codex-history-reachability.test.ts`, `codex-history-worker-boundary.test.ts`, `codex-history-worker.test.ts`, `codex-history-writer.test.ts`, `codex-home-wsl.test.ts`, `codex-inject-history-wording.test.ts`, `codex-inject-integration.test.ts`, `codex-inject-write-lock.test.ts`, `codex-inject.test.ts`, `codex-injected-marker.test.ts`, `codex-integration-record.test.ts`, `codex-journal.test.ts`, `codex-log-guard-coderabbit.test.ts`, `codex-log-guard-doctor-coderabbit.test.ts`, `codex-log-guard-doctor-protection.test.ts`, `codex-log-guard-doctor.test.ts`, `codex-log-guard-inspect.test.ts`, `codex-log-guard-lock.test.ts`, `codex-log-guard-maintenance-coderabbit.test.ts`, `codex-log-guard-maintenance.test.ts`, `codex-log-guard-policy.test.ts`, `codex-log-guard-processes.test.ts`, `codex-log-guard-protection.test.ts`, `codex-log-guard-status-zero-write.test.ts`, `codex-main-account-refresh.test.ts`, `codex-main-rotation.test.ts`, `codex-management-convergence.test.ts`, `codex-metadata-integrity.test.ts`, `codex-model-entitlements.test.ts`, `codex-models-cache-invalidate.test.ts`, `codex-native-residue.test.ts`, `codex-plan.test.ts`, `codex-plugins-doctor.test.ts`, `codex-pool-rotation.test.ts`, `codex-prompt-adopt.test.ts`, `codex-prompt-base-variants.test.ts`, `codex-prompt-journal.test.ts`, `codex-prompt-layers-read.test.ts`, `codex-prompt-layers-write.test.ts`, `codex-prompt-layers.test.ts`, `codex-prompt-lock.test.ts`, `codex-prompt-route.test.ts`, `codex-prompt-text-probe.test.ts`, `codex-quota-parser-parity.test.ts`, `codex-quota-prime.test.ts`, `codex-quota-rejection.test.ts`, `codex-refresh.test.ts`, `codex-reset-credit-auto-redeem.test.ts`, `codex-reset-credit-operation-ledger.test.ts`, `codex-reset-credit-recovery.test.ts`, `codex-restart-contract-parity.test.ts`, `codex-restart-route.test.ts`, `codex-restore-app-rewrite.test.ts`, `codex-retained-root-serialization.test.ts`, `codex-routing.test.ts`, `codex-runtime.test.ts`, `codex-service-manager-probe-hardening.test.ts`, `codex-service-manager-probe.test.ts`, `codex-shim-autorestore.test.ts`, `codex-shim-readiness.test.ts`, `codex-shim.test.ts`, `codex-spark-visibility.test.ts`, `codex-sqlite-home.test.ts`, `codex-sync-api.test.ts`, `codex-sync-response.test.ts`, `codex-tool-mode.test.ts`, `codex-transition-state-adoption.test.ts`, `codex-transition-state-first-use-regression.test.ts`, `codex-transition-state-race.test.ts`, `codex-transition-state.test.ts`, `codex-user-identity.test.ts`, `codex-v2-gate.test.ts`, `codex-warmup.test.ts`, `codex-websocket-registry.test.ts`, `codex-write-lock.test.ts`, `combos.test.ts`, `compatibility-manifest.test.ts`, `custom-model-catalog-migration.test.ts`, `doctor.test.ts`, `effort-policy.test.ts`, `fast-row-listing.test.ts`, `fast-row.test.ts`, `gather-routed-models-single-flight.test.ts`, `history-migration-guardian.test.ts`, `injection-model-api.test.ts`, `issue-452-empty-503.test.ts`, `issue-702-expired-replay-state.test.ts`, `issue-914-transport-attribution.test.ts`, `model-cache-generation-tombstone.test.ts`, `model-cache.test.ts`, `model-display-names-management-api.test.ts`, `model-metadata-sync.test.ts`, `model-visibility-management-api.test.ts`, `multi-agent-compat.test.ts`, `multi-agent-keep-native-v1.test.ts`, `native-alias-maintainer-regressions.test.ts`, `native-claude-code-toggle.test.ts`, `native-claude-desktop-toggle.test.ts`, `native-codex-toggle.test.ts`, `native-grok-toggle.test.ts`, `native-main-auth-temp.test.ts`, `native-main-claim-cache.test.ts`, `native-main-claim.test.ts`, `native-main-owner-lifetime.test.ts`, `native-model-toggle.test.ts`, `native-profile-api.test.ts`, `native-profile-crash-boundaries.test.ts`, `native-profile-drain-server.test.ts`, `native-profile-manager.test.ts`, `native-profile-processes.test.ts`, `native-profile-recovery.test.ts`, `native-profile-route-security.test.ts`, `native-profile-stage-lifecycle.test.ts`, `native-profile-startup.test.ts`, `native-profile-store.test.ts`, `parallel-tool-calls-optin.test.ts`, `project-config-warnings.test.ts`, `reasoning-effort.test.ts`, `selected-models.test.ts`, `slug-codec.test.ts`, `token-guardian.test.ts`, `ultrafast-tier-honesty.test.ts`, `upstream-reachability.test.ts`, `warmup.test.ts`

#### `tests/server/` (95)

`account-import.test.ts`, `account-pool-management-api.test.ts`, `adapter-resolve.test.ts`, `agent-task-recovery-cache.test.ts`, `agent-task-recovery-combo.test.ts`, `agent-task-recovery-fallback.test.ts`, `agent-task-recovery-security.test.ts`, `agent-task-recovery.test.ts`, `alias-management-api.test.ts`, `api-access-endpoints.test.ts`, `api-catalog-route.test.ts`, `api-codex-log-guard-compact.test.ts`, `api-codex-log-guard-protection.test.ts`, `api-codex-log-guard.test.ts`, `api-debug.test.ts`, `api-key-attribution.test.ts`, `api-keys-routes.test.ts`, `api-usage.test.ts`, `bounded-body.test.ts`, `bridge-live-delivery.test.ts`, `cancel-body-on-abort.test.ts`, `config.test.ts`, `consume-for-inspection-cancel.test.ts`, `data-plane-admission-identity.test.ts`, `debug-settings.test.ts`, `error-fidelity.test.ts`, `errors-adapter-failure.test.ts`, `fetch-header-timeout.test.ts`, `health-scoring.test.ts`, `input-admission.test.ts`, `local-management-attestation.test.ts`, `local-management-capability.test.ts`, `local-management-direct-transport.test.ts`, `local-provider-reload-client.test.ts`, `logs-timezone.test.ts`, `loopback-listener-admission.test.ts`, `loopback-listener-integration.test.ts`, `management-api-logs-metrics.test.ts`, `management-client-config-route.test.ts`, `management-integration-journal-delete.test.ts`, `management-integration-routes.test.ts`, `management-origin-tls.test.ts`, `management-provider-validation.test.ts`, `management-route-registry.test.ts`, `memory-watchdog.test.ts`, `model-discovery-management-api.test.ts`, `outbound-body-guard.test.ts`, `owned-service-home.test.ts`, `passive-route-linker.test.ts`, `port-reclaim.test.ts`, `ports.test.ts`, `proxy-env.test.ts`, `proxy-liveness.test.ts`, `relay-eager.test.ts`, `response-model-identity.test.ts`, `retry-after-429.test.ts`, `route-decision-trace.test.ts`, `server-403-permission-e2e.test.ts`, `server-auth.test.ts`, `server-background-lifecycle.test.ts`, `server-clickjacking-headers.test.ts`, `server-combo-failover-e2e.test.ts`, `server-images-bodyless-content-length.test.ts`, `server-images.test.ts`, `server-key-failover-e2e.test.ts`, `server-kiro-completion-e2e.test.ts`, `server-kiro-oauth-401-replay.test.ts`, `server-live.test.ts`, `server-loopback-host-gate.test.ts`, `server-management-auth.test.ts`, `server-opencode-go-goal-streaming.test.ts`, `server-rate-limit-retry-e2e.test.ts`, `server-request-body-size.test.ts`, `server-search.test.ts`, `server-stop-config-hardening.test.ts`, `server-xai-chat-reasoning-streaming.test.ts`, `server-xai-header-parity.test.ts`, `server-xai-oauth-401-replay.test.ts`, `server-xai-responses-streaming.test.ts`, `session-affinity.test.ts`, `session-lane-recall-harness.test.ts`, `sidebar-routes.test.ts`, `sidebar-star-state.test.ts`, `startup-action-control-elevation.test.ts`, `startup-action-control.test.ts`, `startup-prompt.test.ts`, `stream-aborted-marker.test.ts`, `system-env.test.ts`, `system-restart.test.ts`, `system-routes.test.ts`, `terminal-guard-server.test.ts`, `terminal-guard.test.ts`, `upstream-connect-error.test.ts`, `upstream-http-version.test.ts`, `v2-agent-message-failfast.test.ts`

#### `tests/providers/` (94)

`alibaba-region-backup.test.ts`, `alibaba-region-migration.test.ts`, `alibaba-region-startup.test.ts`, `aside-client.test.ts`, `auto-compact-budget.test.ts`, `azure-adapter.test.ts`, `azure-model-router-tool-schema.test.ts`, `baseten-provider.test.ts`, `chutes-provider.test.ts`, `cline-pass-deepseek-v4-tool-replay.test.ts`, `cline-pass-provider.test.ts`, `cline-pass-reasoning-efforts.test.ts`, `cline-provider.test.ts`, `command-code-error-finish.test.ts`, `command-code-provider.test.ts`, `command-code-quota.test.ts`, `command-code-workspace-cache.test.ts`, `commandcode-provider.test.ts`, `context-cap-unknown-window.test.ts`, `cyber-policy-error-fidelity.test.ts`, `deepinfra-provider.test.ts`, `deepseek-inbound-wire.test.ts`, `deepseek-reasoning-replay-gaps.test.ts`, `deepseek-reasoning-replay.test.ts`, `deepseek-responses-item-id-repair.test.ts`, `digitalocean-scaleway-provider.test.ts`, `exa-web-search.test.ts`, `fast-row-ingress.test.ts`, `featherless-provider.test.ts`, `forward-admission-separation.test.ts`, `hyperbolic-provider.test.ts`, `kimi-oauth-identity.test.ts`, `meta-model-api-provider.test.ts`, `meta-muse-oauth.test.ts`, `mimo-effort.test.ts`, `mimo-free-provider.test.ts`, `mimo-token-plan-provider.test.ts`, `minimax-clients.test.ts`, `minimax-reasoning-split.test.ts`, `model-presets.test.ts`, `model-rename-migration.test.ts`, `moonshot-endpoints.test.ts`, `moonshot-tool-schema.test.ts`, `muse-passive-quota-cache.test.ts`, `muse-passive-quota-observation.test.ts`, `muse-spark-web-search-compat.test.ts`, `muse-subscription-usage.test.ts`, `new-model-policy.test.ts`, `nous-oauth-live.test.ts`, `nous-oauth.test.ts`, `novita-provider.test.ts`, `nscale-vultr-provider.test.ts`, `nvidia-nim-hardening.test.ts`, `opencode-cli.test.ts`, `opencode-free-provider.test.ts`, `opencode-go-deepseek.test.ts`, `opencode-go-grok46-responses.test.ts`, `opencode-go-luna-wire.test.ts`, `opencode-go-muse-context.test.ts`, `opencode-go-muse-vision.test.ts`, `opencode-go-quota.test.ts`, `opencode-go-session-header.test.ts`, `opencode-zen-deepseek-reasoning.test.ts`, `opencode-zen-rate-limit.test.ts`, `openrouter-provider-routing.test.ts`, `provider-account-quota-persistence.test.ts`, `provider-account-quota.test.ts`, `provider-api-keys.test.ts`, `provider-capacity.test.ts`, `provider-config-batch-management.test.ts`, `provider-config-validation.test.ts`, `provider-connection-test.test.ts`, `provider-cost-overlay-config.test.ts`, `provider-discovery-log-suppression.test.ts`, `provider-id-rewrite.test.ts`, `provider-key-store.test.ts`, `provider-live-models.test.ts`, `provider-model-aliases.test.ts`, `provider-model-discovery-contract.test.ts`, `provider-outbound-private-network.test.ts`, `provider-outbound.test.ts`, `provider-quota-observed-marker.test.ts`, `provider-quota.test.ts`, `provider-registry-parity.test.ts`, `provider-static-model-discovery.test.ts`, `qwen38-preserve-reasoning.test.ts`, `rate-limit-retry.test.ts`, `sambanova-nebius-provider.test.ts`, `umans-provider.test.ts`, `upstream-transient-retry.test.ts`, `vercel-gateway-provider-routing.test.ts`, `volcengine-ark-assistant-content.test.ts`, `zcode-client.test.ts`, `zhipu-bigmodel-provider.test.ts`

#### `tests/providers/cursor/` (63)

`cursor-adapter.test.ts`, `cursor-arg-normalize.test.ts`, `cursor-blob-integrity.test.ts`, `cursor-blob.test.ts`, `cursor-call-id.test.ts`, `cursor-cancel-provenance.test.ts`, `cursor-catalog.test.ts`, `cursor-claude-id.test.ts`, `cursor-default-catalog-suppression.test.ts`, `cursor-desktop-exec.test.ts`, `cursor-discovery.test.ts`, `cursor-display-names.test.ts`, `cursor-effort-rows.test.ts`, `cursor-effort-suffix.test.ts`, `cursor-effort-table.test.ts`, `cursor-envelope-echo-retry.test.ts`, `cursor-eof-terminal.test.ts`, `cursor-errors.test.ts`, `cursor-exec-empty-result.test.ts`, `cursor-fast-listing.test.ts`, `cursor-fast-tier.test.ts`, `cursor-framing.test.ts`, `cursor-h2-pool-shutdown.test.ts`, `cursor-hardening.test.ts`, `cursor-http1-transport.test.ts`, `cursor-images.test.ts`, `cursor-integration-status.test.ts`, `cursor-interaction-query.test.ts`, `cursor-kv-store.test.ts`, `cursor-live-smoke-gate.test.ts`, `cursor-live-transport.test.ts`, `cursor-local-models-schema.test.ts`, `cursor-mcp-manager.test.ts`, `cursor-mcp-stdio.test.ts`, `cursor-message-mapper.test.ts`, `cursor-native-exec-common.test.ts`, `cursor-native-exec-policy.test.ts`, `cursor-native-exec-shell.test.ts`, `cursor-native-exec.test.ts`, `cursor-oauth-shell.test.ts`, `cursor-oauth.test.ts`, `cursor-pool.test.ts`, `cursor-protobuf-events.test.ts`, `cursor-repetition-breaker.test.ts`, `cursor-request-builder.test.ts`, `cursor-silent-redirect.test.ts`, `cursor-static-catalog.test.ts`, `cursor-stream-health.test.ts`, `cursor-structured-edit.test.ts`, `cursor-tool-arg-decoding.test.ts`, `cursor-tool-choice.test.ts`, `cursor-tool-continuation.test.ts`, `cursor-tool-definitions.test.ts`, `cursor-tool-finalize-race.test.ts`, `cursor-tool-result-image.test.ts`, `cursor-tool-result-invocation.test.ts`, `cursor-tool-suspended-checkpoint.test.ts`, `cursor-toolresult-normalize.test.ts`, `cursor-transport-retry.test.ts`, `cursor-ultra-mode.test.ts`, `cursor-umbrella-rows.test.ts`, `cursor-uncallable-quarantine.test.ts`, `cursor-vision-wire-harness.test.ts`

#### `tests/responses/` (63)

`apply-patch-envelope.test.ts`, `chat-completions-endpoint.test.ts`, `citation-markers.test.ts`, `continuation-dedup.test.ts`, `custom-tool-compat.test.ts`, `empty-completion-core.test.ts`, `empty-completion-guard.test.ts`, `empty-completion-hardening.test.ts`, `eventstream-decoder.test.ts`, `legacy-shell-compat.test.ts`, `namespace-tool-compat.test.ts`, `openai-responses-passthrough.test.ts`, `passthrough-abort.test.ts`, `passthrough-headers.test.ts`, `passthrough-override.test.ts`, `responses-account-label.test.ts`, `responses-compaction-routing.test.ts`, `responses-compaction.test.ts`, `responses-context-overflow.test.ts`, `responses-custom-tool-guidance.test.ts`, `responses-custom-tool-repair.test.ts`, `responses-fetch-helpers-boundary.test.ts`, `responses-field-backfill.test.ts`, `responses-forward-dangling-call.test.ts`, `responses-forward-posit-continuation.test.ts`, `responses-forward-prompt-envelope.test.ts`, `responses-image-gen-repair.test.ts`, `responses-inbound-store-default.test.ts`, `responses-item-id-repair.test.ts`, `responses-json-events.test.ts`, `responses-native-main-refresh.test.ts`, `responses-opaque-blob-recovery.test.ts`, `responses-parser-agent-message.test.ts`, `responses-parser-malformed-content.test.ts`, `responses-parser.test.ts`, `responses-pool-401-refresh.test.ts`, `responses-reasoning-summary-passthrough.test.ts`, `responses-reasoning-summary-rewrite.test.ts`, `responses-routed-web-search-fields.test.ts`, `responses-self-named-namespace-scrub.test.ts`, `responses-shadow-intercept.test.ts`, `responses-snapshot-repair-server.test.ts`, `responses-snapshot-repair.test.ts`, `responses-state-write-amplification.test.ts`, `responses-state.test.ts`, `responses-stateless-dangling-call-repair.test.ts`, `responses-stream-tool-events.test.ts`, `responses-terminal-repair.test.ts`, `responses-tool-conformance.test.ts`, `responses-tool-groups.test.ts`, `responses-tool-search-repair.test.ts`, `responses-undeclared-tool-guard.test.ts`, `responses-usage-passthrough.test.ts`, `sse-client-frame-bounds.test.ts`, `sse-decoder.test.ts`, `sse-failed-tail.test.ts`, `sse-inspector-bounds.test.ts`, `sse-null-data-frame.test.ts`, `sse-payload-rewrite.test.ts`, `sse-unspaced-data-fields.test.ts`, `thought-signature-credential-scope.test.ts`, `ws-endpoint.test.ts`, `ws-upstream.test.ts`

#### `tests/lab/` (53)

`core-lab-boundary.test.ts`, `lab-activation.test.ts`, `lab-automation-coderabbit-regressions.test.ts`, `lab-automation-final-coderabbit-regressions.test.ts`, `lab-automation-ingwannu-regressions.test.ts`, `lab-automation-management-http.test.ts`, `lab-automation-persisted-cap-regression.test.ts`, `lab-automation-review-regressions.test.ts`, `lab-automation.test.ts`, `lab-community-evidence.test.ts`, `lab-community-filename-contract.test.ts`, `lab-community-mutation-lock.test.ts`, `lab-community-publisher-continuity.test.ts`, `lab-conformance-harness.test.ts`, `lab-conformance-runner-failures.test.ts`, `lab-evidence-ledger.test.ts`, `lab-evidence-sanitization.test.ts`, `lab-fabric-outcome-validation.test.ts`, `lab-fabric-persistence-boundary.test.ts`, `lab-fabric-task.test.ts`, `lab-installation-salt-cache.test.ts`, `lab-ledger-mutation-lock.test.ts`, `lab-live-pinned-timeouts.test.ts`, `lab-live-probe.test.ts`, `lab-live-receipt-integrity.test.ts`, `lab-live-review-regressions.test.ts`, `lab-live-sandbox.test.ts`, `lab-passive-production-evidence.test.ts`, `lab-passive-production-surfaces.test.ts`, `lab-paths-security.test.ts`, `lab-post-merge-hardening.test.ts`, `lab-post-merge-projection.test.ts`, `lab-private-file-consumer-recovery.test.ts`, `lab-private-file-durability.test.ts`, `lab-public-api-json.test.ts`, `lab-public-artifact-policy.test.ts`, `lab-public-coderabbit-regressions.test.ts`, `lab-public-core-contract.test.ts`, `lab-public-deep-review-regressions.test.ts`, `lab-public-evidence.test.ts`, `lab-public-export-transaction.test.ts`, `lab-public-file-safety.test.ts`, `lab-public-final-review-regressions.test.ts`, `lab-public-lifecycle-hardening.test.ts`, `lab-public-privacy-ipv6.test.ts`, `lab-public-provenance-recovery.test.ts`, `lab-public-review-fixes.test.ts`, `lab-public-route-registry.test.ts`, `lab-public-security-regressions.test.ts`, `lab-public-surfaces.test.ts`, `lab-public-wire-contract.test.ts`, `lab-read-filter-validation.test.ts`, `lab-read-surfaces.test.ts`

#### `tests/cli/` (45)

`agent-driven.test.ts`, `cli-account-pool-verbs.test.ts`, `cli-account.test.ts`, `cli-capabilities.test.ts`, `cli-catalog-prewarm.test.ts`, `cli-codex-cli-update.test.ts`, `cli-codex-log-guard-compact.test.ts`, `cli-codex-log-guard-protection.test.ts`, `cli-codex-log-guard.test.ts`, `cli-config-command.test.ts`, `cli-dispatch.test.ts`, `cli-dto-fidelity.test.ts`, `cli-export-command.test.ts`, `cli-head.test.ts`, `cli-headless-parity.test.ts`, `cli-help.test.ts`, `cli-json-contract.test.ts`, `cli-management-auth.test.ts`, `cli-models-reasoning.test.ts`, `cli-models-runtime-dispatch.test.ts`, `cli-models.test.ts`, `cli-native-profile.test.ts`, `cli-provider.test.ts`, `cli-ready-subprocess.test.ts`, `cli-ready.test.ts`, `cli-registry.test.ts`, `cli-restart-health.test.ts`, `cli-restore-back.test.ts`, `cli-start-journal-order.test.ts`, `cli-status-json.test.ts`, `cli-status-oauth-health.test.ts`, `cli-storage-inspect.test.ts`, `cli-transport-honesty.test.ts`, `cli-usage-report.test.ts`, `cli-version-skew.test.ts`, `ensure-desired-integrations-race.test.ts`, `interactive-confirm.test.ts`, `ocx-launcher-runtime.test.ts`, `ocx-launcher-source.test.ts`, `ocx-run.test.ts`, `restore-completes-shared-teardown.test.ts`, `route-explainability.test.ts`, `star-deferral.test.ts`, `system-restart-client.test.ts`, `uninstall.test.ts`

#### `tests/routing/` (34)

`cl01-claude-outbound-review-regressions.test.ts`, `cl01-openai-chat-review-regressions.test.ts`, `cl01-review-regressions.test.ts`, `combo-child-headers.test.ts`, `combo-management-api.test.ts`, `combo-stream-preflight.test.ts`, `compatibility-provider-equivalence.test.ts`, `destination-policy-resolved.test.ts`, `fastwire-characterization-routing.test.ts`, `fastwire-characterization-wire.test.ts`, `fastwire-observability.test.ts`, `fastwire-policy.test.ts`, `policy-execution.test.ts`, `router-discarded-baseurl-warning.test.ts`, `router-template-baseurl.test.ts`, `router.test.ts`, `routing-analytics.test.ts`, `routing-capability-catalog.test.ts`, `routing-capability-model-matching.test.ts`, `routing-compatibility-auth-identity.test.ts`, `routing-compatibility-boundaries.test.ts`, `routing-compatibility-model-matching.test.ts`, `routing-compatibility.test.ts`, `routing-policy-fallback.test.ts`, `routing-policy-pool-quota.test.ts`, `routing-policy-surface-parity.test.ts`, `routing-profile-management-editor.test.ts`, `routing-profile.test.ts`, `subagent-context-staleness.test.ts`, `subagent-defaults.test.ts`, `subagent-fallback-handle-responses.test.ts`, `subagent-model-fallback-api.test.ts`, `subagent-model-fallback.test.ts`, `subagent-roster-retention.test.ts`

#### `tests/gui/` (31)

`alibaba-intl-token-plan.test.ts`, `claude-manual-env.test.ts`, `codex-account-mode-state.test.ts`, `codex-auth-modal-status.test.ts`, `combo-workspace-data.test.ts`, `dashboard-uptime.test.ts`, `gui-api-error.test.ts`, `gui-management-session.test.ts`, `gui-pair-capability.test.ts`, `gui-pair-client.test.ts`, `gui-static.test.ts`, `integrations-invariants.test.ts`, `logs-model-tier-confirmation.test.ts`, `models-page-groups.test.ts`, `models-workspace-tabs.test.ts`, `oauth-first-add-hint.test.ts`, `oauth-tos-warning.test.ts`, `provider-payload.test.ts`, `provider-workspace-auth.test.ts`, `provider-workspace-data.test.ts`, `provider-workspace-rail.test.ts`, `provider-workspace-state.test.ts`, `quota-bars-rows.test.ts`, `qwen-cloud-endpoints.test.ts`, `rate-limit-reset-credits.test.ts`, `routing-intelligence-ui.test.ts`, `routing-profile-editor-data.test.ts`, `startup-health-ui.test.ts`, `tencent-siliconflow-providers.test.ts`, `vision-sidecar-timeout-bounds.test.ts`, `volcengine-providers.test.ts`

#### `tests/oauth/` (31)

`adapter-event-oauth-failover.test.ts`, `chatgpt-device-auth.test.ts`, `chatgpt-oauth.test.ts`, `chatgpt-token-expiry.test.ts`, `generic-oauth-failover.test.ts`, `key-login-live-update.test.ts`, `key-login-preserves-model-costs.test.ts`, `local-token-detect.test.ts`, `oauth-account-attribution.test.ts`, `oauth-account-id-collision.test.ts`, `oauth-accounts-api.test.ts`, `oauth-callback-binds.test.ts`, `oauth-callback-server.test.ts`, `oauth-device-code-contract.test.ts`, `oauth-health.test.ts`, `oauth-log.test.ts`, `oauth-login-cli-live-update.test.ts`, `oauth-login-open-browser.test.ts`, `oauth-login-summary.test.ts`, `oauth-manual-code.test.ts`, `oauth-open-browser-choice.test.ts`, `oauth-provider-reconcile.test.ts`, `oauth-public-surface.test.ts`, `oauth-reauth-bind.test.ts`, `oauth-refresh-generic-lock.test.ts`, `oauth-refresh-lock-multiprocess.test.ts`, `oauth-refresh.test.ts`, `oauth-status-privacy.test.ts`, `oauth-store-multi.test.ts`, `oauth-upsert-preserves-api-key.test.ts`, `state-store-sweeper.test.ts`

#### `tests/claude-integration/` (28)

`claude-529-mapping.test.ts`, `claude-agent-startup-sync.test.ts`, `claude-agents-inject.test.ts`, `claude-alias.test.ts`, `claude-auth-detect.test.ts`, `claude-auth-mode.test.ts`, `claude-authmode-migration.test.ts`, `claude-cli.test.ts`, `claude-code-thought-signature-scope.test.ts`, `claude-context-windows.test.ts`, `claude-desktop-1m.test.ts`, `claude-desktop-cli.test.ts`, `claude-desktop-config-path.test.ts`, `claude-desktop-native-context.test.ts`, `claude-desktop-policy.test.ts`, `claude-dotenv-provenance-transport.test.ts`, `claude-gateway-cache.test.ts`, `claude-inbound-debug.test.ts`, `claude-inbound.test.ts`, `claude-management-api.test.ts`, `claude-messages-endpoint.test.ts`, `claude-model-info.test.ts`, `claude-models-discovery.test.ts`, `claude-native-passthrough.test.ts`, `claude-outbound.test.ts`, `claude-shell-hook.test.ts`, `claude-sidecar-override.test.ts`, `claude-system-env-auto.test.ts`

#### `tests/ci-workflows/` (27)

`assert-mergeable-review.test.ts`, `build-release-changelog.test.ts`, `bump-dev-version.test.ts`, `bun-runtime.test.ts`, `ci-workflows.test.ts`, `cleanup-orphaned-workflows.test.ts`, `closed-pr-branch-cleanup.test.ts`, `compatibility-version.test.ts`, `docs-bun-source-requirement.test.ts`, `dsh-path-contract.test.ts`, `dsh-rc6-compat-script.test.ts`, `dsh-writer-lock.test.ts`, `fixture-dir-uniqueness.test.ts`, `install-scripts.test.ts`, `keyring-smoke.test.ts`, `package-tree-integrity.test.ts`, `privacy-scan-meta-key.test.ts`, `release-helper.test.ts`, `release-notes.test.ts`, `release-version-line.test.ts`, `repo-hygiene.test.ts`, `skill-ocx.test.ts`, `test-home-guard.test.ts`, `test-runner.test.ts`, `zz-ci-api-usage-isolation.test.ts`, `zz-ci-storage-policy-isolation.test.ts`, `zz-pr-coderabbit-readiness-revalidation.test.ts`

#### `tests/adapters/` (26)

`abort-race.test.ts`, `adapter-buffered-tool-conformance.test.ts`, `adapter-error-inline.test.ts`, `adapter-registry-authority.test.ts`, `adapter-tool-conformance.test.ts`, `adapter-usage.test.ts`, `bridge-legacy-shell-normalization.test.ts`, `bridge-lifecycle.test.ts`, `bridge-nonstreaming-terminal.test.ts`, `bridge-raw-reasoning-hidden.test.ts`, `bridge-reasoning-replay-batch.test.ts`, `bridge-terminal-singleness.test.ts`, `bridge.test.ts`, `buffered-response-shape-guards.test.ts`, `empty-tool-output-annotation.test.ts`, `identity-neutralize.test.ts`, `key-failover.test.ts`, `reasoning-replay-identity.test.ts`, `reasoning-replay-robustness.test.ts`, `run-turn-queue.test.ts`, `terminal-continuation-owner-rotation.test.ts`, `tool-argument-integers.test.ts`, `tool-catalog-nudge.test.ts`, `tool-choice-performance.test.ts`, `translator-budget.test.ts`, `upstream-http-error.test.ts`

#### `tests/adapters/google/` (25)

`antigravity-baseurl-override.test.ts`, `antigravity-static-catalog.test.ts`, `gcp-adc.test.ts`, `gemini-37-flash-migration.test.ts`, `gemini-web-search.test.ts`, `google-adapter.test.ts`, `google-antigravity-oauth.test.ts`, `google-antigravity-replay.test.ts`, `google-antigravity-wire.test.ts`, `google-buffered-stop-reason.test.ts`, `google-claude-prefill-guard.test.ts`, `google-empty-content.test.ts`, `google-errors.test.ts`, `google-hardening.test.ts`, `google-models-listing.test.ts`, `google-output-clamp.test.ts`, `google-provider-metadata-roundtrip.test.ts`, `google-signature-history-roundtrip.test.ts`, `google-tool-result-adjacency.test.ts`, `google-tool-schema.test.ts`, `google-vertex-http.test.ts`, `google-vertex-stream.test.ts`, `google-vertex-thought-signature.test.ts`, `google-wire-compiler.test.ts`, `vertex-catalog.test.ts`

#### `tests/usage/` (25)

`cost-cap-unknown-evidence.test.ts`, `cost-scoring.test.ts`, `quota-401-recovery-runtime.test.ts`, `quota-401-recovery.test.ts`, `quota-scoring.test.ts`, `request-decompress.test.ts`, `request-evidence.test.ts`, `request-history-index.test.ts`, `request-log-conversation.test.ts`, `request-log-estimate-cap.test.ts`, `request-log.test.ts`, `request-pacing.test.ts`, `usage-aggregate-cache.test.ts`, `usage-cost.test.ts`, `usage-debug.test.ts`, `usage-failure-persistence.test.ts`, `usage-ledger-scanner.test.ts`, `usage-log.test.ts`, `usage-provider-label.test.ts`, `usage-shape-extraction.test.ts`, `usage-summary.test.ts`, `usage-surfaces.test.ts`, `user-cost-overlay-coderabbit-regressions.test.ts`, `user-cost-overlay-live-reconcile.test.ts`, `user-cost-overlay-provider-delete.test.ts`

#### `tests/lib/` (21)

`abort-idle-deadline.test.ts`, `acl-error-classification.test.ts`, `bun-stream-caps.test.ts`, `clearable-deadline.test.ts`, `credential-redirect-guard.test.ts`, `debug.test.ts`, `optional-shutdown-hooks.test.ts`, `pinned-http.test.ts`, `privacy-mask-account.test.ts`, `process-control-graceful.test.ts`, `process-control.test.ts`, `reasoning-replay-scope-source.test.ts`, `redact.test.ts`, `remove-tree-helper.test.ts`, `self-launch-argv.test.ts`, `stall-timeout.test.ts`, `strict-semver.test.ts`, `system-restart-contract-security.test.ts`, `token-estimate.test.ts`, `transient-budget-scope-source.test.ts`, `upstream-retry.test.ts`

#### `tests/clients/` (20)

`client-connect.test.ts`, `client-export-modality-enum.test.ts`, `client-fingerprint.test.ts`, `client-hub-relay.test.ts`, `client-machine-listener.test.ts`, `desktop-3p-guard.test.ts`, `desktop-3p-removal.test.ts`, `desktop-3p.test.ts`, `desktop-app-restart.test.ts`, `desktop-profile.test.ts`, `integrations-journal.test.ts`, `integrations-serialize.test.ts`, `integrations-state.test.ts`, `integrations-writer.test.ts`, `omp-path-contract.test.ts`, `omp-yaml-source-inline-comments.test.ts`, `pi-path-contract.test.ts`, `prime-client.test.ts`, `remote-catalog.test.ts`, `sync-client-integrations.test.ts`

#### `tests/service/` (20)

`autostart-health.test.ts`, `crash-guard.test.ts`, `doctor-codex-envkey-readiness.test.ts`, `doctor-oauth.test.ts`, `doctor-provider-apikey.test.ts`, `doctor-service-memory-contract.test.ts`, `init-backup-cleanup.test.ts`, `init-eof.test.ts`, `process-state.test.ts`, `service-probe-docker.test.ts`, `service-secrets.test.ts`, `service-stop-verification.test.ts`, `service-tier-capability.test.ts`, `service.test.ts`, `shutdown-drain.test.ts`, `shutdown-launcher.test.ts`, `stale-state-purge.test.ts`, `stop-deferred-teardown.test.ts`, `systemd-install-cleanup-hardening.test.ts`, `winsw.test.ts`

#### `tests/windows/` (20)

`tray-proxy-deadline.test.ts`, `tray-proxy.test.ts`, `win-exec.test.ts`, `win-paths.test.ts`, `windows-atomic-replace.test.ts`, `windows-deploy-close-regressions.test.ts`, `windows-elevation-spawn.test.ts`, `windows-elevation.test.ts`, `windows-popup-fix.test.ts`, `windows-scheduler-install-verification.test.ts`, `windows-secret-acl.test.ts`, `windows-service-mutation-lock.test.ts`, `windows-service-wrappers.test.ts`, `windows-text-decoding.test.ts`, `windows-tray-restart-hardening.test.ts`, `windows-tray-run-limit.test.ts`, `windows-tray.test.ts`, `windows-user-principal-nonascii.test.ts`, `windows-user-principal.test.ts`, `winsw-stop-hardening.test.ts`

#### `tests/adapters/anthropic/` (19)

`anthropic-account-pool.test.ts`, `anthropic-agentrouter-language-framing.test.ts`, `anthropic-baseurl-override.test.ts`, `anthropic-compatible-stream.test.ts`, `anthropic-empty-content.test.ts`, `anthropic-eof-tolerance.test.ts`, `anthropic-error-body.test.ts`, `anthropic-error-stop-reason.test.ts`, `anthropic-hardening.test.ts`, `anthropic-image-guard.test.ts`, `anthropic-image-normalize.test.ts`, `anthropic-image-retry-e2e.test.ts`, `anthropic-image-retry.test.ts`, `anthropic-reasoning.test.ts`, `anthropic-stream-hardening.test.ts`, `anthropic-tail-guard.test.ts`, `anthropic-thinking-signature.test.ts`, `anthropic-tool-call-id.test.ts`, `anthropic-tool-schema.test.ts`

#### `tests/storage/` (18)

`api-storage-cleanup.test.ts`, `api-storage-policy-already-running.test.ts`, `api-storage-policy-mutation-busy.test.ts`, `api-storage-policy-put-race.test.ts`, `api-storage-policy-run.test.ts`, `api-storage-policy.test.ts`, `api-storage.test.ts`, `storage-cleanup.test.ts`, `storage-mutation-race.test.ts`, `storage-policy-config-race.test.ts`, `storage-policy-job-responsive.test.ts`, `storage-policy.test.ts`, `storage-restore-job-errors.test.ts`, `storage-restore-job-responsive.test.ts`, `storage-scanner.test.ts`, `storage-worker-lifecycle.test.ts`, `storage-worker-os-join-settle.test.ts`, `storage-worker-teardown-isolate.test.ts`

#### `tests/providers/xai/` (17)

`grok-attribution.test.ts`, `grok-config-inject.test.ts`, `grok-effort-inject.test.ts`, `grok-lifecycle.test.ts`, `grok-management-api.test.ts`, `grok-models-effort-list.test.ts`, `grok-orphan-adoption.test.ts`, `grok-selection.test.ts`, `grok-status.test.ts`, `grok-sync.test.ts`, `grok-writer-boundary.test.ts`, `xai-oauth-retry.test.ts`, `xai-refresh-lock.test.ts`, `xai-tool-schema.test.ts`, `xai-transport.test.ts`, `xai-web-search-compat.test.ts`, `xai-web-search.test.ts`

#### `tests/vision/` (17)

`sidecar-abort.test.ts`, `sidecar-auth.test.ts`, `sidecar-candidates.test.ts`, `sidecar-settings-vision-controls.test.ts`, `sidecar-settings-vision-filter.test.ts`, `sidecar-settings-web-search-gate.test.ts`, `sidecar-settings-web-search-stream.test.ts`, `sidecar-tracker.test.ts`, `vision-anthropic.test.ts`, `vision-backend-union.test.ts`, `vision-cache.test.ts`, `vision-eligibility.test.ts`, `vision-fail-closed.test.ts`, `vision-reasoning-contract.test.ts`, `vision-routed.test.ts`, `vision-sidecar-e2e.test.ts`, `vision-text-only-predicate.test.ts`

#### `tests/adapters/openai/` (16)

`openai-api-virtual-models.test.ts`, `openai-chat-dangling-toolcalls.test.ts`, `openai-chat-eof.test.ts`, `openai-chat-hardening.test.ts`, `openai-chat-invalid-tool-call-diagnostics.test.ts`, `openai-chat-model-suffix.test.ts`, `openai-chat-native-policy.test.ts`, `openai-chat-parallel-stream.test.ts`, `openai-chat-system-order.test.ts`, `openai-chat-tool-result-images.test.ts`, `openai-chat-url.test.ts`, `openai-provider-option-e2e.test.ts`, `openai-provider-option-migration.test.ts`, `openai-provider-option-startup.test.ts`, `openai-provider-option-tooling.test.ts`, `openai-provider-option.test.ts`

#### `tests/config/` (16)

`client-config-export-new-clients.test.ts`, `client-config-export.test.ts`, `client-config-new-clients.test.ts`, `config-load-degrade.test.ts`, `config-mutation-lock.test.ts`, `config-ownership-uninstall.test.ts`, `config-rebase-provenance-writers.test.ts`, `config-save-boundary.test.ts`, `config-user-edits.test.ts`, `expand-user-path.test.ts`, `settings-oauth-open-browser.test.ts`, `settings-startup-health-seam.test.ts`, `settings-stream-mode.test.ts`, `types-barrel-identity.test.ts`, `url-normalization.test.ts`, `yaml-fragment-source.test.ts`

#### `tests/providers/kiro/` (14)

`kiro-account-quota.test.ts`, `kiro-adapter.test.ts`, `kiro-builder-id-profile.test.ts`, `kiro-calibration.test.ts`, `kiro-images.test.ts`, `kiro-oauth.test.ts`, `kiro-pool-rank.test.ts`, `kiro-reasoning-roundtrip.test.ts`, `kiro-retry.test.ts`, `kiro-review-regressions.test.ts`, `kiro-stream.test.ts`, `kiro-usage-quota.test.ts`, `kiro-windows-cli-db-path.test.ts`, `kiro-windows-cli-executable-path.test.ts`

#### `tests/images/` (12)

`artifacts-prune.test.ts`, `artifacts-ssrf.test.ts`, `download-cap-default.test.ts`, `gemini-inline.test.ts`, `loop-reasoning-replay.test.ts`, `loop.test.ts`, `pinned-https-get.test.ts`, `plan.test.ts`, `synthetic-tool.test.ts`, `xai-client.test.ts`, `z-fulfill.test.ts`, `z-handler-activation.test.ts`

#### `tests/web-search/` (10)

`format-result.test.ts`, `web-search-anthropic.test.ts`, `web-search-backend-union.test.ts`, `web-search-candidates.test.ts`, `web-search-parse.test.ts`, `web-search-progress-stream.test.ts`, `web-search-sources.test.ts`, `web-search-timeout-contract.test.ts`, `web-search-timeout-plan.test.ts`, `web-search.test.ts`

#### `tests/update/` (9)

`update-badge.test.ts`, `update-job.test.ts`, `update-notify.test.ts`, `update-npm-cache-preflight.test.ts`, `update-npm-invocation.test.ts`, `update-stop-classification.test.ts`, `update-stop-first.test.ts`, `update-transactional.test.ts`, `update-tray-handoff.test.ts`

#### `tests/providers/ollama/` (8)

`ollama-native-parser.test.ts`, `ollama-native-reasoning-wire.test.ts`, `ollama-native-structured-output.test.ts`, `ollama-native-v4.test.ts`, `ollama-native.test.ts`, `ollama-show-enrichment-v7.test.ts`, `ollama-show-enrichment.test.ts`, `ollama-show-ignore-abort.test.ts`

#### `tests/providers/github-copilot/` (5)

`github-copilot-account-origin.test.ts`, `github-copilot-oauth.test.ts`, `github-copilot-sse-rewrite.test.ts`, `github-copilot-stream-contract.test.ts`, `github-copilot-wire-defaults.test.ts`

#### `tests/videos/` (3)

`fulfill-video.test.ts`, `plan-video.test.ts`, `xai-video-client.test.ts`

#### `tests/telemetry/` (2)

`telemetry-fingerprint.test.ts`, `telemetry-ledger.test.ts`

#### `tests/e2e-style/` (1)

`phase100-native-parity.test.ts`

## 3. Cross-cutting coupling

### 3.A tests/helpers imported by how many tests (unique files)

Parsed `from "../helpers/..."` / `from "./helpers/..."` / dynamic import across 1061 `*.test.ts`. Counts are unique test files, not occurrence counts. 549 / 1061 tests import at least one helper.

| unique tests | helper |
|---:|---|
| 405 | `tests/helpers/remove-tree` |
| 91 | `tests/helpers/translator-budget` |
| 83 | `tests/helpers/management-auth` |
| 52 | `tests/helpers/isolated-codex-home` |
| 29 | `tests/helpers/test-budget` |
| 25 | `tests/helpers/catalog-provider-fetch` |
| 14 | `tests/helpers/catalog-convergence` |
| 12 | `tests/helpers/ci-watchdog` |
| 10 | `tests/helpers/fake-chatgpt-jwt` |
| 7 | `tests/helpers/logs-api` |
| 6 | `tests/helpers/owned-service-home` |
| 5 | `tests/helpers/agent-task-recovery` |
| 5 | `tests/helpers/storage-policy-api` |
| 5 | `tests/helpers/owned-service-home-inspection` |
| 3 | `tests/helpers/dead-pid` |
| 3 | `tests/helpers/provider-registry-discovery` |
| 3 | `tests/helpers/startup-health` |
| 2 | `tests/helpers/enforce-pr-target-harness` |
| 2 | `tests/helpers/windows-power-shell-fixture` |
| 2 | `tests/helpers/codex-history-manifest-fixtures` |
| 1 | `tests/helpers/adapter-conformance/wire-drivers` |
| 1 | `tests/helpers/fabric-task-test` |
| 1 | `tests/helpers/management-route-scan` |
| 1 | `tests/helpers/responses-conformance` |

`remove-tree` is the migration bottleneck: 405 files keep compiling only if the relative import `../helpers/remove-tree` is rewritten (or a path alias is introduced) when those tests leave `tests/`.

### 3.B Helpers that are spawned, not imported (path-literal children)

These 15 helper files have zero ESM imports. Tests locate them with `join(import.meta.dir, "helpers", "...-child.ts")`, `new URL("./helpers/...")`, or `join(repoRoot, "tests", "helpers", ...)`. Moving either the parent test or the helper without updating the join breaks the child process.

| helper | spawned from |
|---|---|
| `account-login-pipe-child.ts` | `tests/cli-account.test.ts:389` (`new URL("./helpers/account-login-pipe-child.ts")`) |
| `account-login-device-child.ts` | `tests/cli-account.test.ts:436` |
| `codex-write-lock-child.ts` | `tests/codex-composed-acceptance.test.ts:48` (`resolve(repoRoot, "tests/helpers/codex-write-lock-child.ts")`); `tests/codex-write-lock.test.ts:283`; `tests/codex-inject-write-lock.test.ts:29` |
| `codex-inject-race-child.ts` | `tests/codex-inject-write-lock.test.ts:28` (`join(repoRoot, "tests", "helpers", "codex-inject-race-child.ts")`); `tests/loopback-listener-integration.test.ts:837` (`join(process.cwd(), "tests", "helpers", "codex-inject-race-child.ts")`) |
| `codex-adoption-crash-child.ts` | `tests/codex-transition-state-adoption.test.ts:14` |
| `native-main-claim-child.ts` | `tests/native-main-claim.test.ts:121` |
| `native-main-owner-child.ts` | `tests/native-main-owner-lifetime.test.ts:168` |
| `native-profile-lock-child.ts` | `tests/native-profile-manager.test.ts:158,179` |
| `native-profile-startup-child.ts` | `tests/native-profile-startup.test.ts:265`; `tests/native-profile-crash-boundaries.test.ts:193` |
| `native-profile-switch-child.ts` | `tests/native-profile-crash-boundaries.test.ts:163` |
| `responses-state-shutdown-budget-child.ts` | `tests/responses-state.test.ts:200` |
| `responses-state-never-settling-acl-child.ts` | `tests/responses-state.test.ts:239` |
| `windows-tray-inheritance-child.ts` | `tests/windows-tray.test.ts:403` (copied into a temp dir, then spawned) |
| `owned-service-home-preload.ts` | `tests/helpers/owned-service-home.ts:11`; copied in `tests/owned-service-home.test.ts:27-28` |
| `cursor-grumpy-fixture.png` | `tests/cursor-images.test.ts` six `new URL("./helpers/cursor-grumpy-fixture.png")` sites: 46, 246, 265, 313, 626, 647 |

`join(import.meta.dir, "helpers", ...)` is relative to the test file. Nested dirs (`tests/images/*.test.ts`) already use a different depth. A second nesting level (`tests/providers/cursor/`) will break every `import.meta.dir + "/helpers"` join unless rewritten to a repo-root helper.

### 3.C Tests that import other tests

Zero. No `*.test.ts` file from-imports another `*.test.ts`. Coupling is helpers, fixtures, and source-oracle reads, not test-to-test ESM.

### 3.D Fixture data reads (`tests/fixtures/...`)

These tests `readFileSync(join(import.meta.dir, "fixtures/..."))` (or spawn the TS fixture). Moving the test out of `tests/` without moving/rewriting the join is a hard fail.

| test | fixture |
|---|---|
| `baseten-provider.test.ts:21` | `fixtures/baseten-models.json` |
| `chutes-provider.test.ts:22` | `fixtures/chutes-models.json` |
| `commandcode-provider.test.ts:22` | `fixtures/commandcode-models.json` |
| `deepinfra-provider.test.ts:21` | `fixtures/deepinfra-models.json` |
| `novita-provider.test.ts:22` | `fixtures/novita-models.json` |
| `nscale-vultr-provider.test.ts:27-28` | `fixtures/nscale-models.json`, `fixtures/vultr-models.json` |
| `sambanova-nebius-provider.test.ts:23-24` | `fixtures/sambanova-models.json`, `fixtures/nebius-models.json` |
| `provider-model-discovery-contract.test.ts:27` | `fixtures/provider-model-discovery.json` |
| `cursor-effort-table.test.ts:14` | `fixtures/cursor-agent-exec-effort-table.min.js` |
| `cursor-integration-status.test.ts:97` | same effort-table fixture |
| `provider-outbound.test.ts:294` | `"tests/fixtures/provider-outbound-e2e.ts"` (string path, not import.meta.dir) |
| `translator-budget.test.ts:292,295` | `tests/fixtures/translator-budget-required.{invalid,valid}.ts` spawned via `Bun.spawnSync(["bun", ...])` |
| openai-provider-option scripts | `tests/fixtures/openai-provider-option-migration-child.ts` listed in `scripts/openai-provider-option-final-gates.ts:95` |

Also on disk and similarly fragile: `digitalocean-models.json`, `featherless-models.json`, `hyperbolic-models.json`, `scaleway-models.json`, `minimax-bridge-direct.ts`, `dsh-*.yaml`, `compatibility/openai-codex-forward-gpt56-sol-v1.json`, `fabric-executors/correct-patch.ts`.

### 3.E Source-oracle tests (read src/, gui/src, scripts/, .github/ as text)

`rg` for `readFileSync|Bun.file|readdirSync` in `tests/` produced 160 files that read something. Most of those read sandboxed `OPENCODEX_HOME` (`config.json`, `auth.json`, `responses-state.json`) and are not migration hazards. The hazards are the ones that resolve a repo-relative path.

High-hazard class: `Bun.file("src/...")` / `readFileSync(join(import.meta.dir, "../src", ...))` / `new URL("../src/...", import.meta.url)`. `import.meta.dir + "/../src"` is correct only while the test lives in `tests/`. Nested `tests/images/` already needs `../../src`. A domain move to `tests/codex-integration/foo.test.ts` silently starts reading the wrong path (or throws).

Confirmed source-oracle tests that resolve a repo-relative path:

`src/` as text (CLI/dispatch/server/oauth/adapters/update/windows): `api-keys-routes.test.ts:262`, `bounded-body.test.ts:284`, `cancel-body-on-abort.test.ts:73,86,104`, `chatgpt-oauth.test.ts:85-117` (`Bun.file("src/oauth/chatgpt.ts")` cwd-relative), `claude-shell-hook.test.ts:181`, `cli-account.test.ts:501`, `cli-capabilities.test.ts:30`, `cli-dispatch.test.ts:206`, `cli-models-runtime-dispatch.test.ts:43`, `cli-ready.test.ts:644,693,694,750,815,850`, `cli-registry.test.ts:131`, `cli-transport-honesty.test.ts:19,128,290,295`, `codex-app-server-processes.test.ts:705`, `codex-auth-api.test.ts:4118,5021-5045` (mix of `new URL("../src/...")` and `Bun.file("src/codex/auth-api.ts")`), `codex-convergence-contract.test.ts:383,398,409`, `codex-history-reachability.test.ts:129` (`join(SRC, "codex", "history-worker.ts")`), `codex-inject-history-wording.test.ts:10-12`, `codex-journal.test.ts` (21 reads; mix of home files + src), `codex-prompt-route.test.ts:806,811,820`, `codex-retained-root-serialization.test.ts:203,209,233`, `codex-shim.test.ts:237,243`, `codex-v2-gate.test.ts:997`, `config-rebase-provenance-writers.test.ts:27,42` (`readFileSync(join(import.meta.dir, "..", path))`), `config-save-boundary.test.ts:46,57,65` (`join(SRC, relative)`), `core-lab-boundary.test.ts:277,335` (walks `src/` files from `repoRoot`), `credential-redirect-guard.test.ts:80,84`, `cursor-oauth-shell.test.ts:35` (`Bun.file("src/oauth/cursor.ts")`), `cursor-silent-redirect.test.ts:20,28`, `oauth-callback-binds.test.ts:24`, `oauth-reauth-bind.test.ts:306` (`Bun.file("src/server/management/oauth-account-routes.ts")`), `ocx-launcher-source.test.ts:9-10` (also `bin/ocx.mjs`), `passive-route-linker.test.ts:68,77`, `process-state.test.ts:45`, `provider-quota.test.ts:104`, `reasoning-replay-scope-source.test.ts:6`, `relay-eager.test.ts:132-133`, `service.test.ts:894`, `stale-state-purge.test.ts:55,70,71`, `sync-client-integrations.test.ts:43,55,306`, `systemd-install-cleanup-hardening.test.ts:5`, `transient-budget-scope-source.test.ts:6`, `update-job.test.ts:1606`, `update-stop-classification.test.ts:10` (`readFileSync(join(repoRoot, rel))`), `update-stop-first.test.ts:64-67`, `update-tray-handoff.test.ts:56`, `windows-deploy-close-regressions.test.ts:10`, `windows-secret-acl.test.ts:592`, `windows-service-wrappers.test.ts:24`, `windows-tray-restart-hardening.test.ts:5`, `windows-tray.test.ts:330-332,491`, `winsw-stop-hardening.test.ts:7`, `winsw.test.ts:154,180,207`, `ws-endpoint.test.ts:40`.

`gui/src` as text (cwd-relative `Bun.file("gui/src/...")` — cwd-stable, less fragile than `import.meta.dir`, but still a hardcoded tree): `codex-auth-modal-status.test.ts:6-8`, `oauth-tos-warning.test.ts:45-49,82`, `provider-workspace-auth.test.ts` (25 reads), `provider-workspace-rail.test.ts:44-92`, `rate-limit-reset-credits.test.ts:281-308`, `routing-intelligence-ui.test.ts:29-100` (`join(guiRoot, "pages", ...)`).

`.github/` / `scripts/` as text: `ci-workflows.test.ts` (22 `tests/` literals plus workflow YAML splits), `zz-ci-api-usage-isolation.test.ts:31,40`, `zz-ci-storage-policy-isolation.test.ts:31-47`, `release-helper.test.ts:374,377`, `install-scripts.test.ts`, `privacy-scan-meta-key.test.ts`, `keyring-smoke.test.ts`, `dsh-rc6-compat-script.test.ts`, `build-release-changelog.test.ts`, `bump-dev-version.test.ts`, `closed-pr-branch-cleanup.test.ts`, `cleanup-orphaned-workflows.test.ts`, `compatibility-version.test.ts`, `release-notes.test.ts`, `release-version-line.test.ts:55` (`../package.json`), `repo-hygiene.test.ts:237` (`../package.json`; also `git ls-files` from `repoRoot = fileURLToPath(new URL("../", import.meta.url))` — `import.meta.url` parent must remain repo root, so this file cannot move into a subdirectory without rewriting `repoRoot`).

`skills/ocx` as text: `tests/skill-ocx.test.ts:18-19,29,93` (`join(import.meta.dir, "..", "skills", "ocx")`). Same repoRoot-via-parent hazard.

`bin/ocx.mjs` as text: `codex-cli-update-launcher-policy.test.ts:20`, `ocx-launcher-source.test.ts:9`, `update-stop-first.test.ts:65`.

`tests/` as data (tests reading other tests or the tests tree): `fixture-dir-uniqueness.test.ts` (walks fixture dirs), `openai-provider-option-e2e.test.ts:77` (`readdirSync` walk), `core-lab-boundary.test.ts` (reads listed `src/` files), `bun-runtime.test.ts:245` (`readFileSync(join(import.meta.dir, "..", relative))`).

Cwd-relative `Bun.file("src/...")` (chatgpt-oauth, cursor-oauth-shell, oauth-reauth-bind, codex-auth-api) survive a test-file move if the test runner cwd stays the repo root. `import.meta.dir + "/../src"` does not.

## 4. Path-literal hazards

Sweep: every line containing the substring `tests/` under `tests/`, `scripts/`, `.github/`, `src/`, `package.json`, `tsconfig.json`, `bunfig.toml`. **238 lines in 104 files.** `package.json` has **zero** `tests/` bytes (`"test": "bun scripts/test.ts"`, `"test:changed": "bun scripts/test.ts --changed=dev"`). `tsconfig.json` has **zero** (`"include": ["src"]` only; tests are not typechecked by the root tsconfig — `tests/cursor-blob.test.ts:3097` comments this). `docs/migration/runtime-test-inventory.md` **does not exist** on this HEAD.

Comments are included because several CI/oracle tests assert against comment text.

### 4.A bunfig / package / tsconfig

- `bunfig.toml:5` comment (`bun test tests/` substring filter)
- `bunfig.toml:6` comment (`devlog/opencode-cursor/tests/`)
- `bunfig.toml:9` comment (`bun test ./tests/`)
- `bunfig.toml:16` **`preload = ["./tests/preload.ts"]`** — must keep working after any layout change; Bun resolves this from repo root, not from `root = "tests"`
- `package.json` — none
- `tsconfig.json` — none
- `tests/tsconfig.doctor-service-memory-contract.json` — referenced as `tests/tsconfig.doctor-service-memory-contract.json`

### 4.B scripts/ (executable lists, not comments-only)

- `scripts/ci/run-bun-test-batches.sh:50` — `tests/api-storage-policy*.test.ts|tests/api-storage.test.ts|tests/api-usage.test.ts` exclusions
- `scripts/test.ts:321` — `args.push("./tests/")` full-suite root
- `scripts/test.ts:362` — `mainArgs.lastIndexOf("./tests/")` serial-lane splice point
- `scripts/test.ts:370` — `./tests/${file}` for `SERIAL_FULL_SUITE_FILES`
- `scripts/test.ts:405` comment (`tests/helpers/ci-watchdog.ts`)
- `scripts/test.ts:458` comment ("Twenty-five files under `tests/` import"; live count is 28)
- `scripts/release.ts:539-545` — isolated suite list: `./tests/api-storage-policy-already-running.test.ts`, `./tests/api-storage-policy-mutation-busy.test.ts`, `./tests/api-storage-policy-put-race.test.ts`, `./tests/api-storage-policy-run.test.ts`, `./tests/api-storage-policy.test.ts`, `./tests/api-storage.test.ts`, `./tests/api-usage.test.ts`
- `scripts/openai-provider-option-final-gates.ts:45-60` — 16 focused test paths: `tests/openai-provider-option.test.ts`, `tests/openai-provider-option-migration.test.ts`, `tests/openai-provider-option-startup.test.ts`, `tests/openai-provider-option-e2e.test.ts`, `tests/openai-provider-option-tooling.test.ts`, `tests/provider-registry-parity.test.ts`, `tests/provider-payload.test.ts`, `tests/codex-account-mode-state.test.ts`, `tests/router.test.ts`, `tests/codex-routing.test.ts`, `tests/server-auth.test.ts`, `tests/codex-catalog.test.ts`, `tests/codex-quota-prime.test.ts`, `tests/provider-quota.test.ts`, `tests/server-images.test.ts`, `tests/server-search.test.ts`
- `scripts/openai-provider-option-final-gates.ts:73` — `bun test tests/openai-provider-option-e2e.test.ts`
- `scripts/openai-provider-option-final-gates.ts:94-95` — rg/diff paths including `tests/openai-provider-option-e2e.test.ts`, `tests/openai-provider-option-tooling.test.ts`, `tests/fixtures/openai-provider-option-migration-child.ts`
- `scripts/privacy-scan.ts:14,102,103,131,148,164` — `file.startsWith("tests/")` allowlist (prefix, not a filename; still breaks if tests leave `tests/`)
- `scripts/generate-ocx-skill-surface.ts:6` comment (`tests/skill-ocx.test.ts`)
- `scripts/generate-model-metadata.ts:29,55` comments
- `scripts/bump-dev-version.ts:11,48,111` comments (`tests/release-version-line.test.ts`)
- `scripts/OCX-RUN.md:25` (`tests/request-log.test.ts`)

`SERIAL_FULL_SUITE_FILES` in `scripts/test.ts:325-332` stores **basenames only** (`codex-shim.test.ts`, `cursor-native-exec-shell.test.ts`, `issue-452-empty-503.test.ts`, `openai-provider-option-e2e.test.ts`, `release-helper.test.ts`, `update-stop-first.test.ts`) and interpolates `./tests/${file}`. After a domain move this interpolation is wrong even if the basename is unchanged.

### 4.C .github/

- `.github/workflows/ci.yml:31` path filter `"tests/**"`
- `.github/workflows/ci.yml:179` path filter `'tests/**'`
- `.github/workflows/ci.yml:270` comment `tests/release-version-line.test.ts`
- `.github/workflows/ci.yml:286` comment
- `.github/workflows/ci.yml:344-349` storage-policy isolated job file list (same 6 files as `scripts/release.ts`)
- `.github/workflows/ci.yml:381` `bun test --isolate ./tests/api-usage.test.ts`
- `.github/workflows/ci.yml:419` `bun x tsc --noEmit -p tests/tsconfig.doctor-service-memory-contract.json`
- `.github/workflows/ci.yml:428` comment `tests/skill-ocx.test.ts`
- `.github/workflows/ci.yml:474` comment `tests/release-version-line.test.ts`
- `.github/workflows/ci.yml:531` comment `tests/helpers/ci-watchdog.ts`
- `.github/workflows/ci.yml:619` comment `tests/release-version-line.test.ts`
- macOS suite step runs `bun test --isolate --timeout 60000 tests` (directory name `tests`, not a nested path)
- `.github/workflows/dev-version-bump.yml:5,101,177,187` — `bun test tests/release-version-line.test.ts`
- `.github/workflows/release.yml:62` comment `tests/ci-workflows.test.ts`
- `.github/workflows/react-doctor.yml:7` comment `tests/ci-workflows.test.ts`
- `.github/scripts/pr-hygiene.cjs:14` `TEST_PREFIXES = ["tests/"]`
- `.github/scripts/pr-hygiene.test.cjs:43,124,137,144,151,187,228`
- `.github/scripts/pr-quality.test.cjs:647,673,908,928,948,971,996,1020,1044` (`bun test tests/ci-workflows.test.ts` fixtures)
- `.github/scripts/pr-sponsored-surface.test.cjs:26,81`
- `.github/CODEOWNERS:40` comment `tests/core-lab-boundary.test.ts`

### 4.D src/ (almost all comments; still grep-stable references)

`src/AGENTS.md:25`; `src/service-manager-probe.ts:622`; `src/integrations/journal.ts:29`; `src/server/index.ts:511,515,1283`; `src/server/auth-cors.ts:65`; `src/server/responses/core.ts:3820`; `src/server/responses/responses-field-backfill.ts:177`; `src/server/management/config-routes.ts:699`; `src/server/management/agent-settings-routes.ts:380`; `src/server/management/route-registry.ts:11,17`; `src/cli/capabilities.ts:14,22`; `src/cli/dispatch.ts:352`; `src/cli/models-runtime.ts:326`; `src/clients/config-export.ts:743`; `src/types/config.ts:16` (false-ish: `tests/enterprise gateways` is prose, not a path); `src/providers/label.ts:39`; `src/providers/derive.ts:406`; `src/providers/registry.ts:635,691,1544`; `src/codex/catalog/provider-fetch.ts:720`; `src/codex/catalog/metadata.ts:674`; `src/adapters/openai-responses.ts:190`; `src/adapters/xai-web-search.ts:58`; `src/adapters/cursor/protobuf-request.ts:382,957`.

### 4.E tests/ self-references

Every remaining `tests/…:line` from the 238-line sweep (test files naming other test files, CI isolation oracles, helper comments):

`tests/codex-catalog-writer.test.ts:264`
`tests/codex-envkey-admission-substitution.test.ts:18`
`tests/management-route-registry.test.ts:219`
`tests/anthropic-baseurl-override.test.ts:12`
`tests/cli-export-command.test.ts:4`
`tests/test-runner.test.ts:167,175,181,205,206,213,215,216,217,218,219,224,226,227,228,235,239,246` — asserts `./tests/` argv; must land in the same PR as `scripts/test.ts`
`tests/codex-composed-acceptance.test.ts:48` — `tests/helpers/codex-write-lock-child.ts`
`tests/responses-forward-dangling-call.test.ts:4`
`tests/grok-lifecycle.test.ts:23,383`
`tests/claude-management-api.test.ts:711`
`tests/codex-model-entitlements.test.ts:1087`
`tests/translator-budget.test.ts:292,295`
`tests/antigravity-baseurl-override.test.ts:12`
`tests/service.test.ts:3658`
`tests/vision-eligibility.test.ts:118`
`tests/server-management-auth.test.ts:1584`
`tests/provider-outbound.test.ts:294`
`tests/web-search-anthropic.test.ts:5`
`tests/mimo-token-plan-provider.test.ts:126`
`tests/quota-401-recovery-runtime.test.ts:10`
`tests/cli-capabilities.test.ts:61`
`tests/router-discarded-baseurl-warning.test.ts:7`
`tests/cursor-adapter.test.ts:133`
`tests/responses-inbound-store-default.test.ts:14,15`
`tests/codex-restart-route.test.ts:6`
`tests/transient-budget-scope-source.test.ts:18`
`tests/codex-auth-api.test.ts:3439`
`tests/codex-journal.test.ts:547`
`tests/sidecar-settings-vision-filter.test.ts:304`
`tests/server-auth.test.ts:66,1558,3438`
`tests/update-stop-first.test.ts:333`
`tests/claude-messages-endpoint.test.ts:884`
`tests/bump-dev-version.test.ts:159`
`tests/cli-dispatch.test.ts:288`
`tests/api-catalog-route.test.ts:286`
`tests/integrations-invariants.test.ts:704`
`tests/zz-ci-storage-policy-isolation.test.ts:31,32,42,43,44,45,46,47` — asserts the batch-script exclusion glob and the ci.yml file list
`tests/cli-restart-health.test.ts:17,118`
`tests/aside-client.test.ts:109`
`tests/api-debug.test.ts:209,317`
`tests/desktop-3p.test.ts:26`
`tests/cancel-body-on-abort.test.ts:101`
`tests/ci-workflows.test.ts:161,162,201,449,1456,1479,1658,1695,2832,2867,2887,2913,2937,3000,3190,3222,3253,3324,3348,3373,3398,3423` — the CI contract test; moving files without updating this file fails CI on the PR that moves them
`tests/github-copilot-wire-defaults.test.ts:9`
`tests/chat-completions-endpoint.test.ts:1816`
`tests/zz-ci-api-usage-isolation.test.ts:31,40`
`tests/combo-management-api.test.ts:723`
`tests/cursor-oauth-shell.test.ts:7`
`tests/chatgpt-device-auth.test.ts:11`
`tests/config.test.ts:2585` (`bun test C:/work/opencodex/tests/config.test.ts` as a negative `isOcxStartCommandLine` case)
`tests/process-state.test.ts:74` (same)
`tests/cli-ready-subprocess.test.ts:4`
`tests/stop-deferred-teardown.test.ts:13`
`tests/cursor-blob.test.ts:3097`
`tests/release-helper.test.ts:374,377`
`tests/responses-undeclared-tool-guard.test.ts:920`
`tests/cli-ready.test.ts:642,855`
`tests/cursor-errors.test.ts:126`
`tests/native-main-claim.test.ts:218`
`tests/claude-cli.test.ts:34`
`tests/helpers/enforce-pr-target-harness.ts:286`
`tests/helpers/dead-pid.ts:14`
`tests/helpers/native-main-owner-child.ts:125`

AGENTS.md (repo root, not in the 238-file sweep roots but named by the brief): `AGENTS.md:15-16,44,96,154-155,175,190,195` all hardcode `tests/`, `tests/*.test.ts`, `tests/helpers/`, `tests/e2e-style/`, `bun test tests/<name>.test.ts`.

## 5. File sizes

`wc -l` over every `*.test.ts` (flat + images + videos + e2e-style).

- **Total lines:** 396378
- **Files > 800 lines:** **102**
- **> 1000:** 74
- **> 2000:** 25
- **> 3000:** 13

### Top 30 by lines

| lines | file |
|---:|---|
| 6807 | `tests/codex-catalog.test.ts` |
| 5279 | `tests/ci-workflows.test.ts` |
| 5139 | `tests/codex-auth-api.test.ts` |
| 4666 | `tests/management-provider-validation.test.ts` |
| 4426 | `tests/server-auth.test.ts` |
| 4069 | `tests/openai-responses-passthrough.test.ts` |
| 3682 | `tests/service.test.ts` |
| 3625 | `tests/responses-state.test.ts` |
| 3576 | `tests/cursor-blob.test.ts` |
| 3266 | `tests/config.test.ts` |
| 3254 | `tests/server-combo-failover-e2e.test.ts` |
| 3173 | `tests/chat-completions-endpoint.test.ts` |
| 3042 | `tests/codex-routing.test.ts` |
| 2803 | `tests/provider-quota.test.ts` |
| 2654 | `tests/web-search.test.ts` |
| 2574 | `tests/server-images.test.ts` |
| 2233 | `tests/windows-secret-acl.test.ts` |
| 2230 | `tests/codex-auth-context.test.ts` |
| 2210 | `tests/subagent-fallback-handle-responses.test.ts` |
| 2143 | `tests/storage-cleanup.test.ts` |
| 2139 | `tests/codex-shim.test.ts` |
| 2135 | `tests/codex-reset-credit-recovery.test.ts` |
| 2130 | `tests/cli-account.test.ts` |
| 2066 | `tests/kiro-stream.test.ts` |
| 2017 | `tests/codex-v2-gate.test.ts` |
| 1860 | `tests/responses-custom-tool-repair.test.ts` |
| 1842 | `tests/responses-undeclared-tool-guard.test.ts` |
| 1835 | `tests/usage-summary.test.ts` |
| 1734 | `tests/request-log.test.ts` |
| 1720 | `tests/codex-model-entitlements.test.ts` |

Remaining >800 (72 files), descending: `kiro-adapter.test.ts` 1717, `update-job.test.ts` 1707, `server-live.test.ts` 1691, `grok-orphan-adoption.test.ts` 1684, `responses-compaction-routing.test.ts` 1653, `server-management-auth.test.ts` 1628, `oauth-refresh.test.ts` 1615, `claude-messages-endpoint.test.ts` 1574, `cursor-structured-edit.test.ts` 1558, `relay-eager.test.ts` 1524, `cursor-request-builder.test.ts` 1501, `codex-prompt-route.test.ts` 1478, `bridge.test.ts` 1465, `native-profile-manager.test.ts` 1431, `codex-reset-credit-operation-ledger.test.ts` 1424, `subagent-model-fallback.test.ts` 1403, `codex-history-provider.test.ts` 1385, `native-profile-startup.test.ts` 1382, `codex-app-server-processes.test.ts` 1363, `integrations-writer.test.ts` 1350, `codex-account-store.test.ts` 1350, `multi-agent-compat.test.ts` 1311, `usage-cost.test.ts` 1292, `lab-fabric-task.test.ts` 1291, `windows-elevation-spawn.test.ts` 1284, `cursor-protobuf-events.test.ts` 1284, `codex-catalog-sync-hardening.test.ts` 1272, `kiro-oauth.test.ts` 1254, `provider-registry-parity.test.ts` 1224, `lab-evidence-ledger.test.ts` 1221, `combo-management-api.test.ts` 1211, `codex-convergence-account-selectors.test.ts` 1206, `combos.test.ts` 1199, `management-integration-routes.test.ts` 1180, `codex-service-manager-probe.test.ts` 1174, `cursor-hardening.test.ts` 1133, `google-antigravity-replay.test.ts` 1132, `claude-outbound.test.ts` 1112, `openai-chat-hardening.test.ts` 1078, `reasoning-effort.test.ts` 1038, `nous-oauth.test.ts` 1037, `codex-pool-rotation.test.ts` 1024, `deepseek-inbound-wire.test.ts` 1017, `codex-native-residue.test.ts` 1001, `ws-upstream.test.ts` 984, `codex-runtime.test.ts` 972, `release-notes.test.ts` 948, `codex-inject-integration.test.ts` 943, `test-runner.test.ts` 924, `usage-log.test.ts` 916, `config-user-edits.test.ts` 910, `cli-ready.test.ts` 909, `cli-headless-parity.test.ts` 905, `responses-opaque-blob-recovery.test.ts` 900, `doctor.test.ts` 899, `responses-pool-401-refresh.test.ts` 894, `native-model-toggle.test.ts` 891, `proxy-liveness.test.ts` 890, `google-antigravity-wire.test.ts` 883, `claude-management-api.test.ts` 883, `images/loop.test.ts` 880, `fastwire-observability.test.ts` 877, `api-usage.test.ts` 870, `google-signature-history-roundtrip.test.ts` 867, `client-config-export.test.ts` 867, `codex-quota-prime.test.ts` 865, `loopback-listener-integration.test.ts` 860, `system-restart.test.ts` 859, `responses-parser.test.ts` 853, `cursor-adapter.test.ts` 819, `api-keys-routes.test.ts` 816, `google-hardening.test.ts` 813.

The 102 files >800 lines are the split-inside-file candidates after directory moves, not instead of them. `codex-catalog.test.ts` (6807) and `ci-workflows.test.ts` (5279) dominate compile time of any shard that draws them.

## 6. How bun test discovers files

### 6.A bunfig + Bun glob

`bunfig.toml`:

```toml
[test]
root = "tests"
preload = ["./tests/preload.ts"]
```

Bun 1.4 `test.root` pins discovery to the `tests` directory so a bare `bun test` does not pick up vendored `*.test.ts` under `devlog/`. Discovery is recursive: any `*.test.ts` / `*.test.tsx` / `*.test.js` / `*.spec.ts` (and `_test.*` / `_spec.*` variants) under `tests/` is a candidate. Evidence: `tests/images/*.test.ts` (12), `tests/videos/*.test.ts` (3), `tests/e2e-style/*.test.ts` (1) are already nested and are already part of the 1061-file suite.

Helpers/fixtures are not picked up: they do not match `*.test.ts`. `tests/preload.ts` is a preload, not a test.

`bun test tests` and `bun test ./tests/` both select the directory. `bunfig.toml:5-6` warns that a substring filter `bun test tests/` also matches `devlog/opencode-cursor/tests/`; `root = "tests"` is the mitigation. Prefer `./tests/` (what `scripts/test.ts` passes).

Root `package.json` scripts:

- `test` → `bun scripts/test.ts`
- `test:changed` → `bun scripts/test.ts --changed=dev`

There is no `"test": "bun test"` npm script. A developer who types `bun test` still hits bunfig `root = "tests"`.

`tsconfig.json` `"include": ["src"]` — tests are not in the typecheck graph except the one-off `tests/tsconfig.doctor-service-memory-contract.json`.

### 6.B scripts/test.ts (`bun run test` / `bun run test:changed`)

Read in full (567 lines).

- Always injects `--isolate`. Default `--parallel=4` unless the caller passed `--parallel`.
- **Full suite** (`isFullSuiteRun`: no file args, no `--changed`) appends `./tests/` (`resolveBunTestArgs` line 321). That directory argument is recursive; nested `tests/images/` etc. are included.
- Full suite is split into lanes (`resolveBunTestPlan`):
  - parallel lane: `./tests/` plus `--path-ignore-patterns **/<file>` for each of `SERIAL_FULL_SUITE_FILES`
  - six serial lanes, each `./tests/${file}` with `--parallel=1`: `codex-shim.test.ts`, `cursor-native-exec-shell.test.ts`, `issue-452-empty-503.test.ts`, `openai-provider-option-e2e.test.ts`, `release-helper.test.ts`, `update-stop-first.test.ts`
- `--path-ignore-patterns **/${file}` is basename-glob, so it still ignores a moved file if the basename is unchanged. The serial lane path `./tests/${file}` does not — it requires the file to remain directly under `tests/`.
- `--changed=<ref>` is not implemented in this repo. `inspectChangedRun` validates the git merge-base, then rewrites the flag to `--changed=<merge-base-sha>` and lets **Bun's own `--changed` module-graph selector** pick tests. `changedSelectionFailure` refuses a green run that selected 0 tests / 0 files against a non-empty diff. Comment in AGENTS.md and in `changedSelectionFailure`: Bun follows only the parsed module graph; subprocess / read-as-data / golden-file dependencies are invisible. That is exactly the source-oracle set in §3.E.
- `ensureGuiDependencies` installs `gui/node_modules` because tests import `gui/src` (live: 28 files; the comment still says twenty-five).

Subdirectory verdict for `bun run test`: already picks up nested `tests/<dir>/*.test.ts`. Moving files into `tests/server/foo.test.ts` does not require a bunfig change. It does require updating `SERIAL_FULL_SUITE_FILES` interpolation, any `./tests/<basename>` argv, and `--changed` does not automatically follow `readFileSync("src/...")` oracles.

### 6.C scripts/ci/run-bun-test-batches.sh (Linux shards)

Read in full (242 lines).

Listing:

```bash
mapfile -d '' -t ALL_TEST_FILES < <(
  find tests -type f -print0 | LC_ALL=C sort -z
)
```

`find tests -type f` is recursive, so `tests/images/`, `tests/videos/`, `tests/e2e-style/`, and any future `tests/server/` are in `ALL_TEST_FILES`.

`is_general_test_file` (lines 46-64):

1. **Exclude** (return 1): `tests/api-storage-policy*.test.ts|tests/api-storage.test.ts|tests/api-usage.test.ts` — glob is unquoted in a `case` pattern, so it matches those **basenames at `tests/` root only**. After a move to `tests/storage/api-usage.test.ts` the exclusion stops matching, the file falls into a general shard, and the dedicated `api-usage` / storage-policy CI jobs would double-run it unless both the `case` and `.github/workflows/ci.yml` are updated together. `tests/zz-ci-storage-policy-isolation.test.ts` and `tests/zz-ci-api-usage-isolation.test.ts` pin the current strings.
2. **Include** (return 0): `*.test.ts`, `*.test.tsx`, `*.test.js`, `*.spec.ts`, and `_test` / `_spec` variants — **basename** globs, so nested files match.
3. Everything else (helpers, fixtures, preload, png, json) return 1 and are not sharded.

Sharding: `general_index % SHARD_COUNT == SHARD_INDEX - 1` over the filtered sorted list. Nested files change the sort order (`LC_ALL=C sort -z`) and therefore reshuffle every shard. That is expected and not a correctness bug, but it invalidates any timing baseline taken against the flat layout.

Batches run `"$BUN_BIN" test --isolate --timeout 60000 "${files[@]}"` with explicit file paths, so bunfig `root` is irrelevant for the shard invocation; the listed paths are.

### 6.D CI macOS / gates

- Linux general shards: `scripts/ci/run-bun-test-batches.sh <shard/total>` (recursive find, exclusions above).
- Linux isolated jobs: explicit `./tests/api-storage*.test.ts` and `./tests/api-usage.test.ts`.
- macOS control: `bun test --isolate --timeout 60000 tests` (directory, recursive).
- GUI package: `cd gui && bun test --isolate tests` — different tree (`gui/tests`), out of scope.
- `dev-version-bump.yml`: `bun test tests/release-version-line.test.ts` (explicit path).

### 6.E Discovery matrix

| Invocation | Nested `tests/<domain>/*.test.ts` picked up today? |
|---|---|
| `bun test` (bare, bunfig `root = "tests"`) | yes |
| `bun test tests` / `bun test ./tests/` | yes |
| `bun run test` → `scripts/test.ts` + `./tests/` | yes |
| `bun run test:changed` → Bun `--changed` graph | yes if the test file imports the changed module; no for source-oracle / fixture / child-spawn dependencies |
| `scripts/ci/run-bun-test-batches.sh` | yes (`find tests -type f`) except the 7 root-only exclusion globs |
| macOS CI `bun test … tests` | yes |
| serial lanes `./tests/${basename}` | **no** after move |
| ci.yml storage-policy / api-usage explicit lists | **no** after move |
| `dev-version-bump.yml` explicit path | **no** after move |

## Migration implications (for later wps, not this doc's job)

1. Directory moves are discovery-safe for the general suite today. The work is path literals + relative imports + child spawns + `--changed` blindness, not bun's glob.
2. Do not move `tests/preload.ts` without bunfig. Do not move the 7 isolated storage/usage files without a three-way edit (`ci.yml`, `run-bun-test-batches.sh`, `scripts/release.ts` + the two `zz-ci-*-isolation` tests).
3. `tests/helpers/remove-tree` (405 importers) should stay at a stable relative location or gain a path alias before the first large domain `git mv`.
4. `repo-hygiene.test.ts` and `skill-ocx.test.ts` compute `repoRoot` as `import.meta.dir/..`. They must stay at `tests/` maxdepth 1 or that expression must change in the same PR.
5. `docs/migration/runtime-test-inventory.md` is absent; do not plan an in-tree update against it.
