# Cycle 050 — Fixed Integration Matrix, SoT, and Runtime Proof

## Objective

Close the OpenAI hardening goal with one zero-network integration spine, isolated
runtime/client-history proof, maintained documentation, fresh exit-zero gates, and a
criterion-to-evidence ledger. No command may mutate or spend from the user's real
OpenCodex, Codex, or OpenAI state.

> Archive note: `_plan/260717_openai_hardening` paths in this execution record are
> historical; after Cycle C the same relative files live under `_fin/260717_openai_hardening`.

## NEW `tests/openai-three-tier-e2e.test.ts`

This file is a mandatory single canonical integration spine, not a replacement for
the focused unit and transport suites. Migration runs in the separately evaluated
`tests/fixtures/openai-three-tier-migration-child.ts`, which the spine launches with
`Bun.spawn` and reads as one JSON result. The two fixtures therefore share no evaluated
`CODEX_HOME` constants or process-global caches.

### Canonical three-tier fixture

Before dynamic imports, create fresh temporary `OPENCODEX_HOME`, `CODEX_HOME`, and
`CLAUDE_CONFIG_DIR` (audit fold-back: `/api/subagent-models` calls
`syncClaudeAgentDefsBestEffort`, which writes `ocx-*.md` under `CLAUDE_CONFIG_DIR` or
real `~/.claude`; the temp dir isolates that side effect and is removed in `finally`,
with the real Claude directory hash-compared before/after), set
all three environment variables, and install a saved-`fetch` interceptor. Configure Direct,
Multi, and API together with `liveModels: false`, fake main/pool/API credentials, and
preseeded quotas. Start one server only after interception and fixture persistence.

The interceptor constructs `new Request(input, init)` and uses a tuple allowlist:

- exact loopback origin plus the methods/paths used by `/healthz`, `/api/*`,
  `/v1/responses`, and `/v1/responses/compact` delegates to saved fetch;
- exact canonical ChatGPT `/backend-api/codex/responses` and
  `/backend-api/codex/responses/compact` return synthetic captured responses;
- exact OpenAI API `/v1/responses` and `/v1/responses/compact` return synthetic
  captured responses;
- explicitly activated WHAM quota URLs may return synthetic quota only in the test
  that names them;
- every unmatched scheme, host, path, or method throws. There is no public-network
  fallback.

`globalThis.fetch` does not own WebSocket handshakes. The test therefore uses one
test-owned WebSocket factory that accepts only the exact current loopback server origin
and `/v1/responses` path, rejects every other URL before construction, and then creates
the real socket.

The integration boundary covers:

- HTTP Direct, Multi, API, and all three Pro aliases;
- sequential real WebSocket Direct → Multi → API → Direct with registry ownership;
- compact Direct, Multi, API, and representative Pro (compact rewrites to base model
  and omits reasoning);
- main eligibility, one added-account cooldown/failover, and Multi-only outcome state;
- catalog plus disabled/subagent/injection public APIs preserving virtual selected ids;
- request log and persisted usage keeping the virtual id while resolved model is base;
- canonical captured URL, credential owner, account header, model body, and reasoning
  body for every request.

### Migration child fixture

`tests/fixtures/openai-three-tier-migration-child.ts` receives fresh home paths before
its first dynamic import. It creates an unmarked legacy fixture with `chatgpt` and one
pool account, runs startup migration twice, and returns only a redacted JSON result.
Assert one no-replace backup, then perform an ACTUAL restore (audit fold-back: copy
`${configPath}.pre-openai-tiers-v1.bak` over the migrated temp config, assert byte
identity plus legacy parse/default/provider state, then rerun migration to prove backup
reuse and re-migration), Direct/Multi projection, hidden legacy id, and second-start
idempotence.

The canonical spine is one test with `try/finally`: it stops the server, restores fetch
and environment variables, removes temp homes, and calls existing affinity, quota,
upstream-health, reauth, WebSocket-registry, usage, and model-cache reset owners. Add
`clearRequestLogsForTests()` to `src/server/request-log.ts`. Add
`resetCatalogRuntimeStateForTests()` to `src/codex/catalog.ts`; it clears
`bundledCatalogCache`, `lastDropWarnSignature`, OpenAI API collision warnings, and the
shared model cache. The migration child exits after its one result, so all its globals
die with the process.

Sidecar forward-candidate ordering IS re-owned here (audit fold-back): the E2E adds a
reversed-insertion permutation case — configure API/Multi/Direct in reverse order and
assert `listOpenAiForwardSidecarCandidates` still returns Direct then Multi
(`src/providers/openai-sidecar.ts:40` hardcodes the order; no existing test proves it
against reversed provider insertion). Detailed compact overflow/cancel and
Pro virtual validation remain owned by the Cycle-030 test files.

## NEW isolated runtime proof

### `scripts/openai-three-tier-runtime-child.ts`

A test-only child process sanitizes inherited `OPENAI_API_KEY`, `CODEX_API_KEY`,
`OPENCODEX_HOME`, and `CODEX_HOME`, then installs temporary home values and interception
before dynamic imports. It writes a mode-0600 temporary `auth.json` containing only a
fake Codex token. After starting `startServer`, it awaits
`syncModelsToCodex(actualPort, config, null)`, verifies the generated catalog contains
`openai-apikey/gpt-5.6-sol-pro`, and verifies injected config points to the actual local
port/catalog. Its synthetic upstream emits the COMPLETE Codex-compatible Responses
lifecycle (audit fold-back — `src/bridge.ts:287`: Codex does not commit message content
without `.done` events): `response.created`, `response.output_item.added`,
`response.content_part.added`, `response.output_text.delta` (`OCX_PROBE_OK`),
`response.output_text.done`, `response.content_part.done`, `response.output_item.done`,
then `response.completed` with usage. It
then emits one JSON readiness line containing PID/version/port and shuts down on a
parent signal. It never imports or reads the user's homes.

### `scripts/openai-three-tier-runtime-smoke.ts`

The parent creates temporary homes, a fresh temporary working directory, and capture state, starts the child twice in distinct
processes, verifies `/healthz`, distinct PIDs, version, and port, then runs asynchronous
`Bun.spawn`:

```sh
codex exec --skip-git-repo-check --ignore-rules \
  -C <temporary-working-directory> \
  --model openai-apikey/gpt-5.6-sol-pro --sandbox read-only --json \
  "Reply exactly OCX_PROBE_OK"
```

The script enforces a timeout and kill, parses the sole temporary rollout, and asserts:

- `turn_context.payload.model` is `openai-apikey/gpt-5.6-sol-pro`;
- `session_meta.payload.model_provider` is `openai`;
- captured upstream JSON uses `gpt-5.6-sol` plus `reasoning.mode: "pro"`;
- no prompt, credential, or full rollout is copied into evidence.

It records `codex --version` and writes redacted JSON only. It never uses `spawnSync`
while an in-process server must answer.

One sanitized spawn environment is shared by the runtime children and `codex exec`:
remove every inherited `OPENAI_*`, `CODEX_*`, and `OPENCODEX_*` variable, then add only
the temporary homes, fake fixture credentials, `OCX_SHIM_BYPASS=1`, and a non-secret
fixture admission value. Also remove uppercase/lowercase `HTTP_PROXY`, `HTTPS_PROXY`,
`ALL_PROXY`, and their lowercase forms; set `NO_PROXY` and `no_proxy` to exactly
`127.0.0.1,localhost,::1`. The Codex spawn uses the fresh temporary directory as both
spawn `cwd` and `-C`. Every spawn/listener lives under `try/finally`: kill and await
children, close capture listeners, restore nothing into the parent environment, and
remove temporary homes on success or failure.

Before and after the run, hash the real config path, Codex config path, and credential
store paths when present. Record only path labels, existence, and hashes; assert they
are unchanged. Never call `ocx start`, `ocx restart`, or `ocx stop` against real homes.

The script also has read-only `--check-live-key`: parse raw config locally, resolve
`$VAR`/`${VAR}`, and print JSON with only status `AVAILABLE`,
`NOT RUN (credential unavailable)`, or `NOT RUN (live spend not authorized)`. All three
non-live `AVAILABLE`/`NOT RUN` states exit 0. When explicit opt-in authorizes live mode,
exit 0 only if both calls return accepted 2xx outcomes and exact base/Pro selected and
resolved identities. Transport failure, non-2xx, or identity mismatch atomically retains
the redacted attempted outcomes but exits nonzero. Malformed config is also nonzero. Check mode atomically
merges a schema-limited `liveKey` object into `050_runtime_smoke.json`: status,
`liveCalls: 0 | 2`, and, only when authorized, redacted status/request-id/selected-id/
resolved-id outcomes. The scanner rejects a missing tri-state. Live
OpenAI calls require both a resolved key and explicit `OCX_ALLOW_LIVE_OPENAI_SMOKE=1`.
Without that opt-in, make zero live calls. If authorized, run one base and one
representative Pro request only; all three Pro aliases remain mandatory in mock E2E.

## Durable source-of-truth updates

Leave `docs/` archival records unchanged.

### Maintainer invariants

- ADD `structure/08_openai-provider-tiers.md` with exact three-tier ontology,
  credential/routing ownership, migration/backup restore, model identity, 1.05M/922K
  API metadata, Pro wire behavior, compact behavior, and management/UI contracts.
- MODIFY `structure/00_overview.md` to index the new invariant document and remove
  stale single-forward wording.
- MODIFY `structure/03_catalog-and-subagents.md`,
  `structure/04_transports-and-sidecars.md`, and
  `structure/05_gui-and-management-api.md` only where the landed implementation makes
  their OpenAI claims stale.

### User/public docs

- MODIFY `README.md`, `README.ko.md`, and `README.zh-CN.md` with the same three-tier
  table, main-in-Multi rule, selection examples, hidden legacy `chatgpt`, migration
  behavior, backup restore command, API metadata, and Pro virtual behavior.
- MODIFY English/Korean/Chinese copies of:
  - `docs-site/src/content/docs/guides/providers.md`
  - `docs-site/src/content/docs/guides/model-routing.md`
  - `docs-site/src/content/docs/guides/codex-app-models.md`
  - `docs-site/src/content/docs/guides/codex-integration.md`
  - `docs-site/src/content/docs/reference/configuration.md`
  Only OpenAI claims change; other providers remain untouched.

### Chase notes

Update only stale OpenAI claims in:

- `devlog/_chase/_model/001_provider_inventory.md`
- `devlog/_chase/_model/003_auth_routing_flow.md`
- `devlog/_chase/_model/007_model_id_delta.md`
- `devlog/_chase/_model/008_logic_delta.md`

## Fresh automated gates

Pre-Cycle-B full-suite baseline (non-gating receipt, 2026-07-17, HEAD `df740d84`):
plain `bun test` exits 1 with 2734 pass / 14 pre-existing failures (11 OAuth-refresh
cases plus provider discovery, OAuth-status privacy, and Claude passthrough logging;
tail preserved at `/tmp/opencodex-cycle-b-full-test.log`). These failures predate this
unit and are NOT attributable to Cycle B. The gating full-suite command for this cycle
is `bun test --isolate tests`, which must exit 0.

Every command must exit 0. Historical flaky/nonzero evidence is invalid.

ADD `scripts/openai-hardening-final-gates.ts`. This is the receipt owner: it runs the
internal manifest below in order with `Bun.spawn`, streams bounded progress, stops on
the first nonzero exit, extracts only command, exit code, pass/fail total, and build
status, and atomically writes `050_gate_summary.txt`. It never stores raw stdout,
environment values, paths outside the repository, or credentials. After atomic summary
publication it invokes the evidence scanner once. The script never invokes itself.

ADD `tests/openai-hardening-tooling.test.ts`. Negative activation covers every scanner
leak class, unknown keys, missing/empty artifact and missing/empty 051 audit; and covers
the final-gate runner's exact-once ordering, first-failure stop, atomic summary
publication, scanner-after-summary order, and raw-output exclusion.
It also covers all live-key branches, authorized two-call success, failure of each live
call, and selected/resolved identity mismatch; rejects a missing tri-state; injects inherited
uppercase/lowercase proxy and base-URL sentinels, and proves none reaches either mock
subprocess while the exact loopback `NO_PROXY` and temporary cwd do.

```sh
# Internal final-gates manifest (not invoked manually one-by-one for the receipt):
OCX_EVIDENCE_DIR=devlog/_plan/260717_openai_hardening/evidence bun test tests/openai-three-tier-e2e.test.ts
bun test tests/openai-provider-tiers.test.ts tests/openai-provider-tier-migration.test.ts tests/openai-tier-startup.test.ts tests/provider-registry-parity.test.ts tests/router.test.ts tests/codex-catalog.test.ts tests/codex-auth-context.test.ts tests/codex-routing.test.ts tests/codex-main-rotation.test.ts tests/codex-websocket-registry.test.ts tests/codex-quota-prime.test.ts tests/provider-quota.test.ts tests/server-auth.test.ts tests/server-search.test.ts tests/server-images.test.ts tests/web-search-anthropic.test.ts tests/vision-anthropic.test.ts tests/sidecar-abort.test.ts tests/web-search.test.ts tests/web-search-timeout-plan.test.ts tests/claude-sidecar-override.test.ts tests/e2e-style/phase100-native-parity.test.ts tests/vision-cache.test.ts tests/oauth-public-surface.test.ts tests/chatgpt-oauth.test.ts tests/oauth-login-summary.test.ts
bun test tests/openai-api-virtual-models.test.ts tests/config.test.ts tests/provider-registry-parity.test.ts tests/umans-provider.test.ts tests/codex-catalog.test.ts tests/request-log.test.ts tests/usage-log.test.ts tests/usage-summary.test.ts tests/provider-payload.test.ts tests/codex-multi-state.test.ts tests/openai-hardening-tooling.test.ts
bun scripts/openai-three-tier-runtime-smoke.ts --evidence-dir devlog/_plan/260717_openai_hardening/evidence
bun scripts/openai-three-tier-runtime-smoke.ts --check-live-key --evidence-dir devlog/_plan/260717_openai_hardening/evidence
bun x tsc --noEmit
bun test --isolate tests
bun run privacy:scan
cd gui && bun run lint:i18n && bun run build
cd docs-site && bun install --frozen-lockfile && bun run build
git diff --check -- README.md README.ko.md README.zh-CN.md structure docs-site/src/content/docs devlog/_chase/_model tests/openai-three-tier-e2e.test.ts tests/openai-hardening-tooling.test.ts tests/fixtures/openai-three-tier-migration-child.ts scripts/openai-three-tier-runtime-child.ts scripts/openai-three-tier-runtime-smoke.ts scripts/openai-hardening-evidence-scan.ts scripts/openai-hardening-final-gates.ts src/server/request-log.ts src/codex/catalog.ts devlog/_plan/260717_openai_hardening/050_integration_verification.md devlog/_plan/260717_openai_hardening/190_consolidated_finish_plan.md
# External receipt command:
bun scripts/openai-hardening-final-gates.ts --evidence-dir devlog/_plan/260717_openai_hardening/evidence
```

If `git diff --quiet 9bba3605 -- gui/src src/server/auth-cors.ts
src/server/management-api.ts` succeeds, reuse the Cycle-040 screenshots and hashes. If
nonempty, rerun the complete Cycle-040 browser matrix. Documentation-only changes do
not justify opening the real user GUI.

## Persisted evidence

Artifact ownership is fixed:

- `tests/openai-three-tier-e2e.test.ts` writes `evidence/050_e2e.json` only when
  `OCX_EVIDENCE_DIR` is set.
- `scripts/openai-three-tier-runtime-smoke.ts` writes
  `evidence/050_client_history.json` and `evidence/050_runtime_smoke.json`.
- `scripts/openai-hardening-final-gates.ts` writes `evidence/050_gate_summary.txt` from exit codes and pass
  totals only; it contains no raw test output.

### Cycle B execution receipt — 2026-07-17, base `df740d84`

The canonical spine passed with `1 pass / 0 fail / 82 assertions`. Its deny-by-default
capture admitted only the four canonical response/compact URLs and the exact current
loopback origin. The real `~/.claude` tree hash matched before and after the run.

| Scenario | Result |
|---|---|
| Direct / Multi / API HTTP plus all three Pro aliases | PASS — 6 cases |
| Sequential real WS Direct → Multi → API → Direct | PASS — 4 turns; pool registry ownership entered and cleared at the expected turns |
| Direct / Multi / API / representative-Pro compact | PASS — 4 cases; Pro resolved to base and all compact bodies omitted reasoning |
| Multi main eligibility and added-account cooldown/failover | PASS — preseeded quota selected the added account, mocked 429 cooled it, then main handled the next Multi turn |
| Selected-id management round trips | PASS — disabled, subagent, and injection APIs retained `openai-apikey/gpt-5.6-sol-pro` |
| Request log and persisted usage identity | PASS — selected virtual `model`/`requestedModel` retained; `resolvedModel` was `gpt-5.6-sol` |
| Reverse provider insertion | PASS — sidecar candidates stayed Direct then Multi |

Migration ran in a fresh child process. The first migration created one mode-0600
`${configPath}.pre-openai-tiers-v1.bak`, the second start was byte-idempotent, copying
the backup over the migrated config restored byte-identical legacy `chatgpt` state,
and startup then reused the existing backup and re-migrated successfully. The redacted
receipt is `evidence/050_e2e.json`.

The isolated runtime proof used two cold-start children and never addressed port 10100.
Both reported version `2.7.23` with distinct PIDs and ephemeral loopback ports; the current redacted
artifact is the source of truth for those volatile values. Direct resolved with caller ownership, Multi resolved
through the main fixture account, and API Pro resolved to `gpt-5.6-sol` with
`reasoning.mode=pro`. Real OpenCodex/Codex config and credential-store hashes were
unchanged. `codex-cli 0.144.4` completed one temp-home activation turn; the redacted
rollout excerpt retains selected id `openai-apikey/gpt-5.6-sol-pro`, provider `openai`,
and one rollout. During fixture development, two attempts first failed on an invalid
fake ID-token format; after correcting only that synthetic fixture, the fresh recorded
run passed in one attempt. Receipts: `evidence/050_runtime_smoke.json` and
`evidence/050_client_history.json`.

Live-key inspection printed exactly `NOT RUN (credential unavailable)` and made zero
live calls. No credential value was printed or persisted.

GUI runtime-facing sources are byte-identical to Cycle 040 under
`git diff --quiet 9bba3605 -- gui/src src/server/auth-cors.ts src/server/management-api.ts`,
so reopening the user's real GUI was unnecessary and the four inspected Cycle-040
screenshots are reused. Their SHA-256 values remain:

- `040_codex_auth_ko_390x844.png`: `b6380e8adcde6bd35ad0c988c7d657307009c279d9bc66a920c9802994db8316`
- `040_models_en_1280x720.png`: `3086c9ecedf48a2f9087df09cad16f55eebb7c0e7f04f68b1b277cc0a968b1e1`
- `040_providers_en_1280x720.png`: `f9a8281d7aa83fcb9a7000c51f40d53bc708eb1afea99fcdaa978fac9821a663`
- `040_providers_ko_1280x720.png`: `142579c7cd8fb68c154c23c4b2d0a3dd9e68833f95fed8a04360a08c85795ae2`

Fresh gates:

- `bun test tests/openai-three-tier-e2e.test.ts`: exit 0, 1 pass, 0 fail, 82 assertions.
- `bun x tsc --noEmit`: exit 0.
- Focused Cycle 020 / Cycle 030-040-tooling: exit 0, 404 / 234 pass, 0 fail.
- `bun test --isolate tests`: exit 0, 2,760 pass, 0 fail (authoritative counts in `evidence/050_gate_summary.txt`).
- `bun run privacy:scan`: exit 0, `Privacy scan passed`.
- `cd gui && bun run lint:i18n && bun run build`: exit 0; 51 modules transformed, build completed in 111 ms; only the existing >500 kB chunk advisory remained.

ADD `scripts/openai-hardening-evidence-scan.ts`. Before final review it accepts the four
artifact paths; after final review it additionally accepts
`051_audit_wp050_implementation.md`. It validates expected JSON/text schemas, rejects
absolute home paths, email addresses, bearer/API/token-shaped values, prompt text, and
unknown keys, and fails on missing or empty inputs. This dedicated scanner complements
(does not replace) `privacy:scan`.
Before final review, stage the complete explicit Cycle-050 source/docs manifest and
force-add `190_consolidated_finish_plan.md` plus the four evidence files. Inspect
`git diff --cached --name-status`, scan the four artifacts, and run
`git diff --cached --check`. After the independent PASS creates
`051_audit_wp050_implementation.md`, force-add 051, scan all five ignored inputs, inspect
the cached manifest again, and rerun the cached check before commit.

Append a criterion table mapping every still-open goal criterion to its landed commit,
named activation test, independent audit, and final-suite result. The required final
state is clean only for Cycle-050-owned paths; unrelated user-owned deletions and the
pre-existing `000_plan.md` edit remain untouched.

## Criterion ledger

| Required gate | Terminal evidence | Result |
|---|---|---|
| Three public tiers and credential isolation | Cycle-020 focused suite; `openai-three-tier-e2e` HTTP and sequential WS matrix; `050_e2e.json` | MET |
| Direct avoids pool state; Multi includes main plus added accounts with cooldown/failover | E2E main-eligibility and 429 failover scenario; Cycle-020 auth/routing tests | MET |
| API owns exactly eight ids with 1.05M context / 922K max input | Registry/catalog parity tests; Cycle-030/040 focused suite; maintained README/docs-site/structure owners | MET |
| Pro selected identity and base wire identity across HTTP/SSE/WS/compact/logs/usage | `tests/openai-api-virtual-models.test.ts`; E2E selected/resolved assertions; `050_e2e.json` | MET |
| Migration hides legacy `chatgpt`, preserves backup, restores, and reruns idempotently | Migration child scenario in `tests/openai-three-tier-e2e.test.ts`; `migrationRestore: PASS` | MET |
| Selected virtual id survives management state and real Codex history | E2E disabled/subagent/injection round trips; `050_client_history.json` | MET |
| Sidecar ordering is Direct then Multi regardless of provider insertion | E2E reverse-insertion scenario; `reverseInsertionOrder: PASS` | MET |
| Isolated cold-start runtime proves Direct/Multi/API-Pro without touching port 10100 or user state | `050_runtime_smoke.json`; distinct ephemeral PIDs/ports and unchanged state hashes | MET |
| Credential-gated live API status is explicit | `050_runtime_smoke.json`: `NOT RUN (credential unavailable)`, zero live calls | MET (gated omission) |
| GUI contract remains verified on the final runtime-facing source | Cycle-040 four-screenshot inspection; Cycle-B byte-identity recheck and reuse rationale | MET |
| All 13 final commands pass and evidence remains sanitized | `evidence/050_gate_summary.txt`; privacy scan; final `051` audit | MET |

## Terminal rule

Final C requires an independent implementation review in
`051_audit_wp050_implementation.md` with `VERDICT: PASS`, all goal criteria populated,
`cxc loop validate` exit 0, all gates above at exit 0, and isolated runtime evidence.
Then commit Cycle 050, close C→D→IDLE, and move the completed unit to `_fin` only if the
goalplan archive contract permits it. No push, release, tag, deployment, or live spend
without explicit opt-in.

## Terminal closeout

`done` — Cycle B landed in `ae485f4b`; Cycle C reran the 13-command gate owner, completed
the status/source-of-truth sweep, and produced `051_audit_wp050_implementation.md` before
the archive move. The live paid sub-gate remained honestly credential-unavailable; no
push, release, deployment, port-10100 action, or live spend occurred.
