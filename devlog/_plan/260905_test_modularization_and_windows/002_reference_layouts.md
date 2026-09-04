# 002 — Reference layouts: Codex CLI (`codex-rs`) and Hermes Agent

Unit: `devlog/_plan/260905_test_modularization_and_windows/`
Survey date: 2026-09-05. Read-only against:

- (a) `/Users/jun/Developer/codex/120_codex-cli` (OpenAI Codex CLI; Rust workspace under `codex-rs/`)
- (b) `/Users/jun/Developer/codex/160_hermes-agent` (Nous Hermes Agent; Python pytest suite)
- OpenCodex checkout: `/Users/jun/.codex/worktrees/4b3a/opencodex` at `9c0e3ca80` (`codex/test-modularization-260905`)

Commands used (all read-only): `find`, `rg`, `ls`, `sed`, `python3` counters over `Cargo.toml` / `tests/` / `.github/workflows`, plus direct reads of `justfile`, `nextest.toml`, `AGENTS.md`, `CONTRIBUTING.md`, `pyproject.toml`, `bunfig.toml`, `scripts/test.ts`, `scripts/ci/run-bun-test-batches.sh`, `.github/workflows/ci.yml`.

`000_plan.md` cites "1053 flat files under `tests/`". Live count at this HEAD: **1061** `*.test.ts` under `tests/` (**1045** top-level + **12** `tests/images/` + **3** `tests/videos/` + **1** `tests/e2e-style/`). Treat 1053 as the plan snapshot, 1061 as the number to migrate.

Hermes is the closer analog (one language, one `tests/` tree, domain directories). Codex CLI is the analog for *ownership* (tests live next to the crate they prove) and for *CI sharding of a large native suite*. OpenCodex is a single Bun package, not a 138-crate workspace, so crate-per-directory does not copy 1:1.

---

## A. Codex CLI (`codex-rs`) — per-crate tests, nextest, compile-out OS gates

### Workspace shape

`codex-rs/Cargo.toml` declares **138 workspace members** (crates under `codex-rs/`, `ext/`, `utils/`, `memories/`). Top-level crate dirs with their own `Cargo.toml`: **99**. Of those, **26** have a `tests/` directory; the other **73** rely on in-crate unit tests only (or have none).

Two test *kinds*, in Cargo's sense:

1. **Unit tests** — `#[cfg(test)]` modules compiled into the crate. Convention (repo `AGENTS.md:165-178`): new test modules live in a sibling `*_tests.rs` with an explicit `#[path = "..._tests.rs"]`, not inline in the implementation file. Counts: **656** `*_tests.rs` files; **1155** files containing `#[cfg(test)]`.
2. **Integration tests** — `tests/*.rs` compiled as separate test binaries (`kind(test)` in nextest). **479** `*.rs` files under `*/tests/` excluding `common/` / `support/` / `vendor/`. Large crates collapse those files into **one binary** via `tests/all.rs` + `tests/suite/` so Cargo does not spawn one process per file.

### Integration-test placement (the pattern to steal)

Large crates use a single aggregator:

```
<crate>/tests/all.rs          # one integration binary; mod suite;
<crate>/tests/suite/          # one *.rs per scenario
<crate>/tests/suite/mod.rs    # mod foo; list, with #[cfg] gates
<crate>/tests/common/         # often its own Cargo package (test-support crate)
<crate>/tests/fixtures/       # optional data
```

Exact `all.rs` aggregators (9): `core`, `app-server`, `tui`, `linux-sandbox`, `mcp-server`, `apply-patch`, `exec`, `chatgpt`, `login`.

`core` is the canonical example:

- `core/tests/all.rs` — 5 lines, `mod suite;`
- `core/tests/suite/` — **141** scenario files (`abort_tasks.rs`, `apply_patch_cli.rs`, `cli_stream.rs`, …)
- `core/tests/suite/mod.rs` — **139** `mod` declarations; **12** of them are compile-excluded on Windows.

Gated module names in `core/tests/suite/mod.rs` (12): `abort_tasks`, `approvals`, `extension_sandbox`, `guardian_review`, `guardian_review_cancellation`, `guardian_subagent_authorization`, `hooks`, `hooks_executor`, `hooks_mcp`, `interrupt_hooks`, `request_permissions`, `request_permissions_tool`.

- `core/tests/common/` is workspace crate **`core_test_support`** (`[lib] path = "lib.rs"`). Exports `test_codex`, `responses`, `startup`, `test_environment` (`TestTargetOs`, remote-env / wine detection). `AGENTS.md:222-230` tells authors to prefer `core_test_support::responses` and `TestCodexBuilder::build_with_auto_env()`.
- `core/tests/fixtures/` and `core/tests/remote_env_windows/` exist; `core/Cargo.toml` `ignored-paths = ["tests/remote_env_windows/*.rs"]` so those files are not a second integration binary.

`app-server` mirrors it: `tests/all.rs` + `tests/suite/` (**8** entries including `v2/` and `zsh/`) + workspace crate **`app_test_support`** at `app-server/tests/common` (depends on `core_test_support`). `mcp-server/tests/common` is **`mcp_test_support`**. `exec-server/tests/support` is workspace member **`codex-exec-server-test-support`**.

`cli/tests/` is the other style: **21** standalone `*.rs` files (`login.rs`, `plugin_cli.rs`, `mcp_list.rs`, …), **no** `all.rs`. Cargo auto-discovers each as its own integration binary. Use that only when the crate has few tests; `core`/`app-server` explicitly collapsed to one binary to keep nextest scheduling sane.

Integration-test `*.rs` files per crate (top of the histogram): core 160, app-server 141, tui 53, exec-server 31, cli 21, rmcp-client 20, exec 19, ext 14, otel 11, mcp-server 8, code-mode-host 8, login 6, apply-patch 6, linux-sandbox 5, then a long tail of 1–4.

### Dedicated test-support crates (not just `tests/common`)

| crate | path | role |
|---|---|---|
| `core_test_support` | `core/tests/common` | Codex turn builder, SSE mock, env |
| `app_test_support` | `app-server/tests/common` | JSON-RPC app-server harness |
| `mcp_test_support` | `mcp-server/tests/common` | MCP server spawn + wiremock |
| `codex-exec-server-test-support` | `exec-server/tests/support` | exec-server relay |
| `codex-app-server-test-client` | `app-server-test-client/` | **binary** client (`just app-server-test-client`); not a `tests/` dir |
| `codex-test-binary-support` | `test-binary-support/` | arg0 dispatch so the test binary can pretend to be `codex` / apply-patch / linux-sandbox (`test = false`) |
| `cloud-tasks-mock-client` | `cloud-tasks-mock-client/` | mock client crate |

`Cargo.toml` workspace.dependencies aliases: `app_test_support`, `core_test_support`, `mcp_test_support`, `codex-app-server-test-client`, `codex-exec-server-test-support`.

### Naming

- Unit: `<module>_tests.rs` next to `<module>.rs` (`parser_tests.rs`, `auth_tests.rs`).
- Integration (aggregated): `tests/suite/<scenario>.rs` — snake_case, behavior-named, not `test_*.rs`.
- Integration (cli-style): `tests/<scenario>.rs` — one file = one binary.
- Support: `tests/common/` or a `*-test-support` / `*-test-client` crate. `AGENTS.md:89`: "Keep crate API surfaces as small as possible. Avoid proliferating test-only helpers."

### How CI shards / filters

Two workflows, two cadences:

- **PR / merge-blocking** (`blocking-ci.yml` → `rust-ci.yml`): fmt, clippy-adjacent jobs, cargo-shear, argument-comment lint. **Does not run the suite.** The only `cargo test` in `rust-ci.yml` is the argument-comment-lint *package* itself (line 156).
- **Post-merge / full** (`postmerge-ci.yml` → `rust-ci-full.yml`): the real suite. Five platform jobs each call reusable `rust-ci-full-nextest-platform.yml`:

  - `tests_macos_aarch64` (`macos-15-xlarge`, `aarch64-apple-darwin`)
  - `tests_linux_x64_remote` (`ubuntu-24.04` self-hosted, `remote_env: true`)
  - `tests_linux_arm64`
  - `tests_windows_x64` (`test_threads: 8`)
  - `tests_windows_arm64` (archive built on x64, shards run on ARM64)

Reusable workflow pattern (the shard model):

1. Job `archive` runs `cargo nextest archive --archive-file nextest-<artifact_id>.tar.zst` once per platform.
2. Job `shard` is `matrix.shard: [1, 2, 3, 4]`, downloads the archive, runs:

```
cargo nextest run --no-fail-fast \
  --archive-file … \
  --workspace-remap … \
  --partition "hash:${{ matrix.shard }}/4"
```

3. Linux/Windows also stage helper binaries (`codex-linux-sandbox`, `codex-windows-sandbox-setup.exe`) next to the archive so tests can spawn them without a rebuild.
4. JUnit per shard: `nextest-junit-rust-ci-<artifact_id>-shard-<shard>`.
5. `results` fails if `needs.shard.result != success`.

Local: `just test` → `NEXTEST_PROFILE=local cargo nextest run --no-fail-fast` (unix + windows recipes in repo `justfile:87-92`). `AGENTS.md:66-68`: never `cargo test` directly; scope with `-p <crate>`; ask before the complete suite.

### Test-tiering and platform-conditional

`codex-rs/.config/nextest.toml` is the tiering file. There is **no** fast/slow *marker* in the pytest sense. Instead:

- `slow-timeout = { period = "30s", terminate-after = 2 }` plus `retries = 1` on profile `default`.
- **test-groups** with `max-threads` to serialize subprocess-heavy work:
  - `app_server_protocol_codegen` (1)
  - `app_server_integration` (1 in CI, 4 in `profile.local`)
  - `core_apply_patch_cli_integration` (1)
  - `windows_sandbox_legacy_sessions` (1)
  - `windows_process_heavy` (2)
- **platform filters**: `platform = 'cfg(windows)'` overrides bump timeout and pin `windows_process_heavy` for `suite::resume::`, `suite::cli_stream::`, `suite::auth_env::`, a JSON-RPC Windows client test, and one Codex-home startup test.
- **kind filter**: `package(codex-app-server) & kind(test)` = integration binaries only, so library unit tests stay parallel.

Compile-time OS gates (`#[cfg(windows)]` / `#[cfg(unix)]` / `#[cfg(not(target_os = "windows"))]`) are the primary skip mechanism. File counts under `codex-rs/`: **151** files with `#[cfg(windows)]`, **217** with `#[cfg(unix)]`, **79** with `cfg(target_os = "macos")`, **64** with `cfg(not(windows))`. A handful of `#[ignore = "TODO: …"]` exist (e.g. `windows-sandbox-rs/src/unified_exec/tests.rs` ConPTY CI failures).

`AGENTS.md:319`: "Tests and features must support Linux, macOS and Windows unless feature is explicitly OS-specific." Windows exclusion in `core/tests/suite/mod.rs` is the documented exception: those modules never even compile on Windows, so nextest never sees them — no skip noise, no fake `cfg` inside the test body.

Bazel exists as a second runner (`just bazel-test`, `workspace_root_test_launcher.{sh,bat}.tpl`) but nextest is the suite authority.

---

## B. Hermes Agent — domain directories, shared conftest, OS markers, LPT slices

### Directory taxonomy (counts)

Root: `/Users/jun/Developer/codex/160_hermes-agent/tests/`. `AGENTS.md:308` still says "~17k tests across ~900 files as of May 2026"; live tree on 2026-09-05 is larger.

| first-level dir | `test_*.py` files | all files | notes |
|---|---:|---:|---|
| `gateway/` | 618 | 626 | nested `platforms/`, `relay/` |
| `hermes_cli/` | 574 | 577 | |
| `tools/` | 443 | 445 | |
| `agent/` | 364 | 368 | nested `lsp/`, `transports/` |
| `run_agent/` | 169 | 172 | |
| **`(root)` leftover `test_*.py`** | **164** | **166** | not yet filed into a domain |
| `cli/` | 106 | 108 | |
| `plugins/` | 98 | 110 | 10 subdirs: `browser`, `dashboard_auth`, `image_gen`, `memory`, `model_providers`, `platforms`, `transcription`, `tts`, `video_gen`, `web` |
| `tui_gateway/` | 57 | 58 | |
| `cron/` | 44 | 46 | |
| `skills/` | 36 | 36 | convention: `tests/skills/test_<skill>_skill.py` |
| `docker/` | 25 | 27 | |
| `acp/` | 14 | 16 | |
| `hermes_state/` | 14 | 14 | |
| `honcho_plugin/` | 11 | 13 | |
| `ci/` | 9 | 9 | |
| `computer_use/` | 9 | 10 | |
| `integration/` | 8 | 9 | external services; default-deselected |
| `stress/` | 8 | 11 | **not** in `run_tests.sh` |
| `providers/` | 7 | 8 | |
| `e2e/` | 4 | 8 | Telegram/Discord/relay; own CI job |
| `state/` | 6 | 6 | |
| `acp_adapter/` | 5 | 5 | |
| `monitoring/` | 5 | 6 | |
| `scripts/` | 4 | 4 | |
| `verify/` | 4 | 4 | |
| `secret_sources/` | 3 | 5 | |
| `website/` | 2 | 3 | |
| `conformance/` | 1 | 6 | `vectors/` data |
| `dashboard/` | 1 | 1 | |
| `openviking_plugin/` | 1 | 1 | |
| `fakes/` | 0 | 2 | `fake_ha_server.py` — support, not tests |
| `fixtures/` | 0 | 3 | `plugins/`, JSON blobs |
| `manual/` | 0 | 2 | human-run e2e scripts |
| `install/` | 0 | 1 | |

Totals: **2814** `test_*.py` files, **2876** `*.py` under `tests/`, **2650** nested + **163-164** still at the root. Hermes is a *partial* migration: the big domains moved, a leftover root bucket remains. That is the failure mode OpenCodex should not copy.

### conftest / fixture sharing

| path | lines | role |
|---|---:|---|
| `tests/conftest.py` | **1683** | suite-wide hermetic invariants |
| `tests/gateway/conftest.py` | 554 | adapter mocks, antipattern scan |
| `tests/e2e/conftest.py` | 450 | Telegram/Discord/Slack fakes, `make_runner` |
| `tests/tools/conftest.py` | 111 | web-provider registry |
| `tests/cli/conftest.py` | 50 | prompt_toolkit cache reset |
| `tests/stress/conftest.py` | 37 | collection hooks + CLI options |
| plus `cron/`, `docker/`, `hermes_cli/`, `honcho_plugin/`, `run_agent/`, `acp/` | — | domain-local |

Root `conftest.py` is the analog of OpenCodex `tests/preload.ts` + `scripts/test.ts` isolation, enforced **before collection imports**:

1. Blank credential-shaped env vars (`*_API_KEY`, `*_TOKEN`, …).
2. Redirect `HERMES_HOME` to a tempdir (`_isolate_hermes_home` autouse). Never write `~/.hermes/`.
3. `TZ=UTC`, `LANG=C.UTF-8`, `PYTHONHASHSEED=0`.
4. Write-guards for the real kanban / state.db.
5. OS-marker skip application in `pytest_collection_modifyitems`.
6. Reject tests that carry two of `{linux_only, macos_only, windows_only}`.

`tests/fakes/` and `tests/fixtures/` are data/support only — pytest does not collect them as tests. Domain `conftest.py` files add fixtures; they do not re-implement isolation.

### Markers and skip policy

`pyproject.toml` `[tool.pytest.ini_options]`:

```
testpaths = ["tests"]
addopts = "-m 'not integration'"
markers = [
  integration,          # external services; excluded from default CI
  real_concurrent_gate, real_agent_prewarm,  # opt out of autouse stubs
  requires_wal, no_isolate, ssh,
  linux_only, macos_only, windows_only,
]
```

Live file counts (files containing the marker name): **27** `linux_only`, **15** `macos_only`, **48** `windows_only`, **12** `pytest.mark.integration`, **1** `ssh`.

Hard rule (`AGENTS.md:1372-1404`, `CONTRIBUTING.md:834-841`, `tests/conftest.py:1038+`):

- **Do not fake the host OS.** If the test needs the interpreter to believe it is on Windows, mark `windows_only` and run it on Windows.
- **Use the named marker, never a bare `skipif(sys.platform != "win32")`.** `scripts/ci/list_os_marked_tests.py` greps for the marker *name* to decide which files the macOS/Windows lanes even import. A `skipif` skips on Linux *and* is never imported on the Windows lane, which is silent zero coverage.
- Pure functions that take `is_windows=True` as data stay unmarked and run on Linux.
- Symlinks / `0o600` mode assertions: skip on Windows (`CONTRIBUTING.md:778-782`).
- Stress: `tests/stress/README.md` — **not run by `scripts/run_tests.sh`**; 30+ second subprocess battles. Manual only.

Canonical runner: **always** `scripts/run_tests.sh` (`AGENTS.md:1321`). Per-file subprocess isolation via `scripts/run_tests_parallel.py` (no xdist). File-level retry once (`--file-retries`, default 1). Scoped: `scripts/run_tests.sh tests/gateway/` or `tests/agent/test_foo.py -k test_x`.

### How CI runs them

`.github/workflows/ci.yml` change-classifies, then:

| job | workflow | when | how |
|---|---|---|---|
| `tests` | `tests.yml` | Python changed | **12 LPT slices** on `ubuntu-latest` |
| `tests-os` | `tests-os.yml` | Python changed | **unsliced** `macos_only` on macos-latest, `windows_only` on windows-latest |
| `js-tests` | `js-tests.yml` | frontend changed | vitest (desktop/web) |
| `installer-tests` | `installer-tests.yml` | `install.ps1` | Windows-only |
| `e2e-desktop` | `e2e-desktop.yml` | currently `false &&` disabled | Playwright desktop |

`tests.yml` shard model (better analog for OpenCodex than nextest hash):

1. Job `generate` restores `test_durations.json` cache, runs `python3 scripts/run_tests_parallel.py --generate-slices ${{ inputs.slice_count }}` (default 8, CI passes **12**). LPT: sort files longest-first, greedy-assign to the slice with the smallest accumulated time. New files without timings still distribute.
2. Job `test` matrix is the JSON file lists. `fail-fast: false`, 30 min/slice. Each slice: `scripts/run_tests.sh --files '<list>'` (per-file pytest subprocesses).
3. Each slice uploads `test-durations-slice-N`; `save-durations` merges on `main` so the next run rebalances.
4. Separate `e2e` job: `python -m pytest tests/e2e/ -v --tb=short`.

`tests-os.yml` is the Windows/macOS lesson:

- Deliberately **not** sliced — "tens of tests, not thousands".
- Two-step selection: `list_os_marked_tests.py <marker>` narrows **which files are imported** (collection of ~900 unrelated modules on Windows would fail the job on an ImportError that is not the job's subject); then `pytest -m "${{ matrix.marker }} and not integration"`.
- **Fails if pytest exit 5** (zero tests selected). A renamed marker must not report green over nothing.
- Command-line `-m` replaces pyproject `addopts`, so they repeat `not integration`.

`AGENTS.md:1357-1367`: CI change classifier runs jobs by touched paths. A Python test that regexes `package.json` / `.ts` source will not run on a JS-only PR. Place those tests in the JS suite. (OpenCodex already has this trap in `tests/repo-hygiene.test.ts` and skill-surface tests.)
---

## C. OpenCodex today (the thing being reorganized)

Single Bun package. `bunfig.toml`:

```
[test]
root = "tests"
preload = ["./tests/preload.ts"]
```

Discovery is recursive under `tests/` for `*.test.ts` / `*.spec.ts` / `*_test.ts`. `root` exists because a substring filter `bun test tests/` also matched `devlog/opencode-cursor/tests/` and pulled hundreds of foreign failures. Nested directories **do not** break discovery as long as they stay under `tests/` and keep the `*.test.ts` suffix.

Live layout at `9c0e3ca80`:

```
tests/                  1045 *.test.ts (flat)
tests/images/             12
tests/videos/              3
tests/e2e-style/           1   (phase100-native-parity.test.ts)
tests/helpers/            39 files (not collected)
tests/fixtures/           24 files (not collected)
tests/preload.ts          isolation for bare bun test
```

`src/` already has the domain map the tests should follow (847 `src/**/*.ts`): `codex` 117, `lab` 117, `server` 114, `adapters` 90, `lib` 71, `cli` 62, `providers` 51, `oauth` 35, `routing` 24, `responses` 20, `integrations` 18, `claude` 17, `web-search` 13, `storage` 11, `images` 10, `usage` 9, `vision` 8, `grok` 7, `config` 7, plus smaller dirs. Test filename prefixes at the top level (first hyphen token, top 15 of 241 unique): `codex` 118, `cursor` 63, `lab` 52, `responses` 38, `cli` 34, `claude` 29, `provider` 25, `oauth` 24, `server` 22, `native` 20, `anthropic` 19, `google` 19, `openai` 17, `api` 16, `windows` 15.

CI today (`.github/workflows/ci.yml`):

- Linux `test` job: matrix `shard: [1,2,3,4]`, `scripts/ci/run-bun-test-batches.sh "$TEST_SHARD"` — sorted round-robin matching Bun `--shard`, then batches of 12 files, each a fresh Bun process. Excludes `tests/api-storage-policy*.test.ts`, `tests/api-storage.test.ts`, `tests/api-usage.test.ts` into dedicated jobs.
- macOS `platform-macos`: **unsharded** `bun test --isolate --timeout 60000 tests`.
- Windows `platform-windows`: `workflow_dispatch` only, `bun test --isolate --timeout 60000 tests --shard=${shard}/4`, crash-retry once.
- `scripts/test.ts` `SERIAL_FULL_SUITE_FILES` (6 files: `codex-shim.test.ts`, `cursor-native-exec-shell.test.ts`, `issue-452-empty-503.test.ts`, `openai-provider-option-e2e.test.ts`, `release-helper.test.ts`, `update-stop-first.test.ts`) run as `--parallel=1` lanes with `--path-ignore-patterns **/${file}` on the main lane. Paths are currently `./tests/${file}` (basename, top-level assumption).

Platform skips today are ad hoc: **29** files use `test.skipIf` / `describe.skipIf` / `test.if(`; **103** files mention `process.platform`; **129** mention `win32`. Some fake `process.platform` (`windows-elevation-spawn.test.ts`); some pass platform as data (`windows-atomic-replace.test.ts`, `cursor-integration-status.test.ts`); some skip host-only paths (`codex-app-server-processes.test.ts` `test.skipIf(process.platform !== "win32")`). There is no grep-able marker vocabulary and no OS-only CI lane that fails on zero selection.

There are already **15** `tests/windows-*.test.ts` files, plus `gui/` holding **220** `*.test.ts`/`*.test.tsx` in a separate job (`cd gui && bun test --isolate tests`).

---

## D. Lessons for OpenCodex (Bun test, 1061 files under `tests/`)

### D.1 Which reference maps to what

```
codex-rs crate                    ->  OpenCodex src/<domain>/
codex-rs <crate>/tests/suite      ->  tests/<domain>/*.test.ts
codex-rs tests/common crate       ->  tests/helpers/<domain>/  (keep one helpers tree)
codex-rs #[cfg(windows)]          ->  named skip helper + tests/windows/
codex-rs nextest --partition      ->  already have bun --shard + run-bun-test-batches.sh
hermes tests/<domain>/            ->  the directory taxonomy to copy
hermes tests/conftest.py          ->  tests/preload.ts + tests/helpers/ (already)
hermes @pytest.mark.windows_only  ->  tests/helpers/platform.ts + tests/windows/
hermes LPT slices                 ->  optional upgrade over round-robin once timings exist
hermes leftover root test_*.py    ->  anti-pattern; finish the move
```

Do **not** invent Cargo-style one-binary aggregators. Bun's unit of isolation is the **file** (`--isolate`); `run-bun-test-batches.sh` already restarts Bun per batch of 12. Splitting large files helps; concatenating them would hurt.

Do **not** put tests next to `src/` (`src/codex/foo.test.ts`). `bunfig.toml` `root = "tests"` is load-bearing; GUI tests already live under `gui/` (220 files) and are a separate job. Keep the production import graph free of test files (`tests/core-lab-boundary.test.ts` walks that graph).

### D.2 Recommended taxonomy

One directory per *test domain*, matching `src/` where a src dir exists, plus a few test-only buckets. Keep current support dirs. Empty dirs are not created "just in case"; the list below is the migration target for the 1061 files, sized from the prefix histogram + `src/` map.

```
tests/
  preload.ts                 # stays at root (bunfig preload path)
  helpers/                   # stays; may grow per-domain subdirs
    adapter-conformance/
    platform.ts              # NEW: windowsOnly / posixOnly / darwinOnly / linuxOnly
  fixtures/                  # stays
  e2e-style/                 # stays; broader in-process scenarios
  images/                    # already 12; maps src/images
  videos/                    # already 3
  adapters/                  # adapter-*.test.ts
  cli/                       # cli-*, doctor-*, ocx-*, install-scripts, command-*
  claude/                    # claude-*
  client/                    # client-* (src/client + src/clients)
  codex/                     # ~118; maps src/codex (largest)
  cursor/                    # ~63; no src/cursor — integration surface
  lab/                       # ~52; maps src/lab (keep off the core import path)
  oauth/                     # ~24
  providers/                 # provider-*, anthropic, google, openai, grok, ollama,
                             # kiro, alibaba, deepseek, muse, xai, azure, ...
  responses/                 # ~38; maps src/responses
  routing/                   # ~14
  server/                    # server-*, api-* (except the three CI-split files)
  storage/                   # storage-*, api-storage*
  native/                    # native-profile-*, native-*
  windows/                   # 15 windows-*.test.ts — host-specific + Windows unit
  update/                    # update-*
  usage/                     # usage-*, api-usage.test.ts (CI already splits this file)
  vision/
  web-search/
  sidecar/
  integrations/              # github, desktop, tray, service
  config/
  bridge/                    # bridge-*, sse-*, request-*
  catalog/                   # catalog-*, model-*
  hygiene/                   # repo-hygiene, skill-ocx, core-lab-boundary,
                             # privacy, startup-prompt, agent-driven
  compatibility/             # maps src/compatibility + translator
```

Rough first-wave buckets (enough to un-flatten the 1045): `codex` ~118, `cursor` ~63, `lab` ~52, `providers` ~120 (merge anthropic/google/openai/grok/ollama/kiro/provider/xai/alibaba/...), `responses` ~38, `cli` ~40, `claude` ~29, `oauth` ~24, `server` ~40, `native` ~20, `windows` ~15, remainder split across the smaller dirs. Exact assignment belongs in `001_test_inventory.md` / wp3; this file locks the *shape*.

**Leave at `tests/` root:** only `preload.ts`. Hermes's 164 leftover root files are the warning.

### D.3 Helper / fixture placement

Copy Hermes, not Codex-rs crates:

- **Shared runtime isolation** stays in `tests/preload.ts` (already the `conftest.py` equivalent). Do not add a second preload.
- **Shared factories** stay in `tests/helpers/`. Split by owner when a helper is imported by one domain only (`helpers/native-profile-*.ts` -> `helpers/native/` or stay put if many domains use them). Do not create `helpers.ts` / `utils.ts`.
- **Static JSON / golden blobs** stay in `tests/fixtures/`. Domain-specific fixtures may nest (`fixtures/compatibility/` already exists).
- **Child-process fixtures** (`*-child.ts`) stay next to the helper that spawns them; they are not `*.test.ts` so Bun will not collect them.
- Do **not** introduce a `tests/common` package. Bun has no crate graph; a package would only add a publish/tsconfig surface.

`scripts/test.ts` `SERIAL_FULL_SUITE_FILES` and `run-bun-test-batches.sh` path literals (`tests/api-storage-policy*.test.ts`, `tests/api-usage.test.ts`) must be rewritten in the **same PR** as the move (`000_plan.md` constraint). Prefer globs (`**/api-usage.test.ts`) so a later nested move does not break CI.

### D.4 Naming rule

Keep Bun's collector happy and `git log --follow` cheap:

1. Filename: `<domain-topic>.test.ts` (current style). **Do not** switch to pytest `test_<name>.py` or Rust `*_tests.rs`.
2. After the move, the directory carries the domain; drop a redundant prefix only when it is the directory name (`tests/codex/log-guard.test.ts` not `tests/codex/codex-log-guard.test.ts`). First migration PRs may keep the old basename (`git mv tests/codex-log-guard.test.ts tests/codex/codex-log-guard.test.ts`) to preserve blame; a later mechanical rename is optional.
3. One file is one subsystem slice. Do not re-aggregate `core`-style `all.rs`. If a file is a CI isolate victim (`api-usage`, storage-policy), it can live in its domain dir; the batch script matches by basename/glob, not by parent.
4. GUI stays `gui/**/*.test.ts`; never fold into `tests/`.

### D.5 Platform-conditional convention (Bun)

Bun has no `#[cfg]` and no pytest markers. Invent a **grep-able, CI-selectable** stand-in and ban the silent `skipif` trap Hermes documented.

**Helper** (`tests/helpers/platform.ts`; names must appear as whole words so a future `list_os_marked_tests` equivalent can grep):

```ts
export const windowsOnly = test.skipIf(process.platform !== "win32");
export const posixOnly   = test.skipIf(process.platform === "win32");
export const darwinOnly  = test.skipIf(process.platform !== "darwin");
export const linuxOnly   = test.skipIf(process.platform !== "linux");
```

Rules, mapped from Hermes `_OS_MARKS` + Codex `#[cfg]`:

| Kind of test | Do | Do not |
|---|---|---|
| Pure function of a platform flag | Pass `"win32"` as data; run on every OS | `Object.defineProperty(process, "platform", ...)` unless the unit under test has no seam |
| Needs real Win32 APIs / ACL / schtasks / ConPTY | `windowsOnly(...)` **and** live in `tests/windows/` | inline `test.skipIf(process.platform !== "win32")` (un-grepable; Hermes silent-zero-coverage bug) |
| Needs POSIX mode bits / symlink / signals | `posixOnly(...)` | Assert `stat().mode & 0o777` on Windows |
| Needs the macOS keychain / darwin snapshot path | `darwinOnly(...)` | Fake `darwin` on Linux CI |
| Compile-out analog (Codex `#[cfg(not(windows))]` whole module) | Put the file in `tests/windows/` or gate the **whole file** with `windowsOnly` at the first `test`/`describe` | Mix host-faking and host-required in one file |

CI mapping once the helper exists:

- Linux shards: run everything; `windowsOnly` tests skip (same as Hermes Linux lane).
- Optional `tests-os` job (Hermes `tests-os.yml`): `bun test tests/windows` on `windows-latest`, and fail if the file list is empty. Until Windows is push-gated, this job can stay `workflow_dispatch` like `platform-windows`.
- Do **not** rely on `bun test --shard` to "cover Windows." Sharding splits files, it does not select OS tests.
- A later hygiene test can grep `tests/` for `process.platform !== "win32"` / `=== "win32"` skipIf and require the helper name instead (Hermes `list_os_marked_tests.py` + `_reject_multiple_os_marks`).

Existing fakes (`windows-elevation-spawn.test.ts` rewriting `process.platform`) are the Hermes anti-pattern. wp1/wp3 should split: host-native cases under `windowsOnly` on Windows; seam-tested cases pass platform as an argument.

### D.6 How each lesson maps to Bun discovery and sharded CI

Bun discovery (`bunfig.toml` `root = "tests"`, recursive `*.test.ts`):

- `bun test` and `bun test ./tests/` keep collecting nested files. **Confirmed by existing `tests/images/` (12) and `tests/videos/` (3) already being in the suite.**
- `bun test tests/codex` becomes the analog of `just test -p codex-tui` / `scripts/run_tests.sh tests/gateway/`.
- `bun run test:changed` walks the **import graph**, not the filesystem prefix. Moving a test file does not drop it from `--changed` as long as it still imports the changed `src/` module. Tests that read `tests/foo.test.ts` as *text* (hygiene, skill-surface) must be inventoried before `git mv`.
- Bare `bun test tests/codex-shim.test.ts` breaks after the move; `SERIAL_FULL_SUITE_FILES` must store repo-relative paths (`codex/codex-shim.test.ts` or `**/codex-shim.test.ts`). `--path-ignore-patterns **/${file}` already works if `file` is the basename.

Sharding:

| Mechanism | Codex CLI | Hermes | OpenCodex now | After domain dirs |
|---|---|---|---|---|
| Split algorithm | nextest `hash:N/4` on test *names* | LPT on file *durations*, 12 slices | Bun sorted round-robin on file *paths*, 4 shards (`run-bun-test-batches.sh`) | **Keep round-robin** initially — path sort still works on nested paths |
| Archive / compile once | `nextest archive` then shard | each slice installs deps | each shard `bun install`s | unchanged |
| Heavy isolates | nextest test-groups `max-threads=1` | stress dir excluded; `integration` marker deselected | dedicated jobs + `SERIAL_FULL_SUITE_FILES` | keep; globs not parent dirs |
| OS lane | full suite on 5 platforms, cfg-out | tiny marked set on macOS/Windows | Windows dispatch 4 shards; macOS full unsharded | add optional `bun test tests/windows`; shard macOS the same 4-way (`bun test --shard=N/4 tests`) |
| Empty-selection guard | N/A (cfg-out) | pytest exit 5 fails the job | none | required for any OS-only job |
| Duration feedback | none (hash) | `test_durations.json` cache | none | optional later; Hermes LPT is the upgrade if shard wall-times diverge after the move |

Practical CI recipe that does not require new Bun features:

1. **Do not shard by directory in v1.** Directory shards unbalance (`codex` 118 vs `tray` 1) and couple CI to the taxonomy. Keep file-level `--shard` / `run-bun-test-batches.sh` so a move is a path change, not a matrix change.
2. **Do** use directories for *human and focused CI*: a codex-only PR can run `bun test tests/codex` locally; a workflow `paths:` filter can still run the full suite (OpenCodex already has a `changes` job).
3. **macOS shards** (plan wp4): `bun test --isolate --timeout 60000 tests --shard=${{ matrix.shard }}/4` — same flag Windows already uses. Nested dirs are invisible to `--shard` because it hashes/round-robins the discovered file list.
4. **Windows host tests**: either stay inside the dispatch 4-shard full suite (skipped on Linux via `windowsOnly`) or gain a small unsliced job on `tests/windows/` modeled on Hermes `tests-os.yml`.
5. **Batch script `is_general_test_file`**: today it accepts any `*.test.ts` under the tree and special-cases three `tests/api-storage*` / `api-usage` prefixes. After the move, keep the special-case as a glob (`**/api-usage.test.ts`) so the dedicated jobs still peel those files out of general shards.

### D.7 Migration constraints this survey adds

- One PR per domain directory (`000_plan.md`), `git mv`, update path literals in the same PR.
- First PRs: the already-nested `images/` + `videos/` are proof that Bun + the batch script tolerate nesting; next, `windows/` (15 files, platform helper lands here), then `codex/` (largest, most SERIAL/CI path risk).
- Do not leave a Hermes-style leftover root. Hygiene test: `tests/*.test.ts` count == 0 after the last PR (only `preload.ts` at root).
- Do not add pytest-style `conftest.py` per directory; Bun has no collection hooks. Domain setup goes in helpers imported by the tests that need it.
- Do not copy nextest test-groups into Bun — `SERIAL_FULL_SUITE_FILES` + dedicated CI jobs already are that mechanism.

### D.8 Commands to re-verify later

```bash
# OpenCodex live counts
find tests -name '*.test.ts' | wc -l
find tests -maxdepth 1 -name '*.test.ts' | wc -l

# Codex-rs
rg -l --glob '*.rs' '#\[cfg\(test\)\]' /Users/jun/Developer/codex/120_codex-cli/codex-rs | wc -l
ls /Users/jun/Developer/codex/120_codex-cli/codex-rs/core/tests/suite | wc -l
sed -n '268,370p' /Users/jun/Developer/codex/120_codex-cli/.github/workflows/rust-ci-full-nextest-platform.yml

# Hermes
find /Users/jun/Developer/codex/160_hermes-agent/tests -name 'test_*.py' | wc -l
sed -n '427,445p' /Users/jun/Developer/codex/160_hermes-agent/pyproject.toml
sed -n '1,55p' /Users/jun/Developer/codex/160_hermes-agent/.github/workflows/tests-os.yml
```
