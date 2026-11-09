# Ephemeral Rust Child Link (`native/ocx-child`) Eliminates Full-Proxy Child Footprint While Preserving Exact Link, Sync, and Offline Restore Parity

> Reader contract: For OpenCodex maintainers and reviewers evaluating Remote Link Child architecture, security boundaries, and phased execution on `feat/ocx-child-ephemeral-link` targeting `dev`. Document type: Decision & Roadmap Specification (`000`-range, zero implementation diffs per `LEXICO-SPLIT-01`).

Remote Link today requires every Child machine (`src/server/management/link-enrollment.ts:147-180`) to pre-install and run a full standalone Bun OpenCodex proxy (~100-217 MB runtime footprint) and recycles back into a persistent standalone daemon on disconnect (`src/client/runtime.ts:133`), which is unsuitable for disposable SSH devboxes, containers, and lightweight VMs. How can OpenCodex attach a Remote Link Child with a megabyte-scale, zero-Bun/zero-Node footprint that relays inference/SSE traffic, participates byte-for-byte in Home `ocx sync` fan-out and OCX-6 parity, and restores native `~/.codex` state 100% offline with zero leftover daemon? We introduce `native/ocx-child` (standalone Rust crate compiling to a stripped ~1-2 MB `ocx-child` binary) paired with minimal Home-side discovery and detached-preflight support in `src/link/` and `src/server/management/`, locked to TypeScript behavior via a shared golden conformance fixture (`tests/fixtures/link/ocx-child-conformance.json`).

## Contents

1. [Loop Specification & HOTL Bounds](#1-loop-specification--hotl-bounds)
2. [Scope](#2-scope)
3. [Architect Consultation & Design Dispositions](#3-architect-consultation--design-dispositions)
4. [Dependency-Ordered Work-Phase Map (`PHASE-SPLIT-01`)](#4-dependency-ordered-work-phase-map-phase-split-01)
5. [Cross-Boundary Field & Type Chains (`PLAN-FIELD-CHAIN-01`)](#5-cross-boundary-field--type-chains-plan-field-chain-01)
6. [Verification scope](#6-verification-scope)
7. [Grounded Verifiers (`PLAN-VERIFIER-REAL-01`)](#7-grounded-verifiers-plan-verifier-real-01)
8. [Non-Goals, Alternatives Rejected, & Consequences](#8-non-goals-alternatives-rejected--consequences)

## 1. Loop Specification & HOTL Bounds

| Field | Specification |
|---|---|
| Loop archetype | `satisfy-spec` (Class C4 multi-cycle HOTL PABCD with docs-first `wp0` entry per `LOOP-DOCS-FIRST-01`) |
| Trigger | Dispatched GOAT task lane `lane-ocx-child-ephemeral-link` on branch `feat/ocx-child-ephemeral-link` + user steering requiring seamless `ocx sync` fan-out, OCX-6 runtime freshness/parity, and full sibling CLI compatibility |
| Goal | Deliver `native/ocx-child`, Home-side ephemeral-child Remote Link integration, shared TS/Rust golden conformance vectors, updated `structure/` and `docs-site/` documentation, and a verified unmerged PR targeting `dev` |
| Non-goals | Merging the PR (`authority.merge = false`), force-pushing, dispatching manual `lane=all` CI, mutating `.codexclaw` subagent configs, editing `.github/` workflows, touching `src/lab/` or `core-link-boundary` protected files (`src/router.ts`, `src/server/lifecycle.ts`, `src/server/responses/core.ts`), raising file-size ratchets, or implementing Child-initiated (`ssh -L` `join`) / web-dashboard modes inside `ocx-child` |
| Verifier | Baseline & gate commands enumerated in [Section 7](#7-grounded-verifiers-plan-verifier-real-01): `bun run typecheck`, `cargo test --locked --manifest-path native/ocx-child/Cargo.toml`, `cargo build --release --locked --manifest-path native/ocx-child/Cargo.toml`, focused Bun conformance/unit/E2E suites, `bun run test:changed`, `bun run structure:check`, `cd docs-site && bun run build`, and `bun run privacy:scan` |
| Stop condition | All work-phases `wp0..wp4` and criteria `c-1..c-6` met with fresh command receipts, PR opened against `dev` and linked via `goat_pull_request_link`, exact-head PR checks green and recorded via `cxc loop pr-record`, `goat_pull_request_unwatch` called, and `update_goal({ status: "complete" })` accepted |
| Memory artifact | `devlog/_plan/261107_ocx_child_ephemeral_link/` (`000_roadmap.md` + `010..040` decade PRDs) and `.codexclaw/goalplans/loop-archetype-satisfy-spec-class-c4-hotl-multi/goalplan.json` |
| Expected terminal outcomes | `DONE`: all `c-1..c-6` verified + green unmerged PR recorded; `NOOP`: N/A (greenfield subsystem); `BLOCKED`: reproducible toolchain/CI/policy refusal reported with `file:line` and command output without weakening gates; `UNSAFE`: unmitigated credential/smuggling/restore defect; `NEEDS_HUMAN`: out-of-scope permission needed; `BUDGET_EXHAUSTED`: host limit reached |
| Escalation condition | Any requirement to edit outside `writeScope` (`native/ocx-child`, `src/link`, `src/server/management`, `src/cli`, `structure`, `docs-site`, `scripts`, `tests`, `package.json`, `devlog`), weaken a check, or merge the PR. Subagent recovery follows `DISPATCH-RETIRE-01` (inherit `google-antigravity/gemini-4-argon` per user directive) |
| HOTL resource bounds | Token/cost/wall-clock bounds: `none stated; host limits apply`. Tool/credential scope: local git/bun/cargo, `gh` PR creation/inspection on `feat/ocx-child-ephemeral-link`, GOAT PR link/watch/unwatch |

## 2. Scope

Security working analysis is kept outside the tracked repository.

## 3. Architect Consultation & Design Dispositions

- **Proposals consulted**:
  - Initial read-only architect handle `01a1b183-8618-7280-bcc9-f1da84898e7d` (retired after wait timeout, completed text captured on `close_agent`) and replacement live read-only architect handle `01a1b18b-a2f3-7b53-971a-9b2c9cccecf7` (both inherited `google-antigravity/gemini-4-argon`).
- **Main dispositions on `ARCH-01..ARCH-07`**:
  - **`ARCH-01` (Amended)**: Adopt standalone `native/ocx-child` crate with `std::net` + bounded `std::thread` worker pool, surgical line/span TOML module, and minimal audited dependencies (`serde`, `serde_json`, `sha2`, `hmac`, `base64`, Unix `libc`, Windows `windows-sys`) matching `native/remote-workspace-helper` and `desktop/src-tauri`. Reject `tokio`/`hyper`/`rustls`/`toml_edit` because `ocx-child` speaks loopback HTTP/1.1 only (never TLS), keeping dependency count minimal and stripped release binary ~1-2 MB.
  - **`ARCH-02` (Amended)**: Adopt strict HTTP/1.1 framing + `linkRouteAllowed` / `linkManagementRouteAllowed` + `CALLER_CREDENTIAL_HEADERS` stripping + `/healthz` + `/readyz` + `child-parity` reporter. Reject upstream socket pooling: Home's `src/server/index/link-relay-sessions.ts:105` consumes each `nonce` once (`consume(nonce)`), so each relayed request opens one `TcpStream` and runs `preflight 204 -> single data request` on that exact socket, matching `SingleConnectionAgent` (`src/client/link-relay-transport.ts:41`).
  - **`ARCH-03` (Amended)**: Adopt `0600` journal + ordered locks (`$OPENCODEX_HOME/child/lifecycle.lock` -> `$CODEX_HOME/.opencodex-write.lock`) + fail-closed checks (full-`ocx` runtime/journal, foreign listener, external `model_provider`, user-owned root `openai_base_url`) + two-tier offline detach (byte-exact restore when `untouchedByExternalWriter` holds across attaches/syncs; surgical value-matched strip surviving `#1798` comment-stripping rewrites; fail-closed exit `4` on ambiguous/conflicting edits). Reject `[model_providers.opencodex]` table injection: scope strictly to Design B loopback root keys + Home `codex-settings` (`[features]`, `[agents]`, `web_search`) + `models_cache.json` refresh with websockets disabled.
  - **`ARCH-04` (Amended)**: Adopt unified native (`attach`, `sync`, `detach`, `serve`, `status`, `port`) and `ocx`-compatible (`--version` -> `opencodex 2.98.0`, `link port`, `config show --json`, `connect --link --key-stdin`, `restart`, `disconnect`, `sync [--expect-link <id>] [--json]`, `status [--json]`, `connect status [--json]`) CLI verbs. Enforce exact `src/cli/sync-expectation.ts:55` stderr mismatch JSON `{"phase":"child_link_mismatch","reason":"..."}` with exit `5` (including `pending_operation` on lock contention) and post-sync live daemon rollover + immediate `child-parity` POST.
  - **`ARCH-05` (Amended)**: Adopt ordered remote candidate fallback (all full-`ocx` paths first, then `ocx-child` in `~/.local/bin`, `~/.cache/opencodex/bin`, Windows `%LOCALAPPDATA%\opencodex\bin`, and `PATH`, keeping Windows encoded PowerShell `< 8000` chars) and detached `ocx-child` preflight in `src/server/management/link-enrollment.ts`. Reject adding new fields to persisted `LinkRecord` in `links.json` (`src/link/store.ts:16` enforces closed `exactKeys`, and `remoteOcxArgv(["disconnect"])` + `remotePinnedSyncArgv` already operate uniformly once `ocx-child` is in candidate discovery).
  - **`ARCH-06` (Accepted)**: Shared golden conformance fixture `tests/fixtures/link/ocx-child-conformance.json` (`schema: "ocx.child.conformance/1"`) executed by both `bun test` and `cargo test`.
  - **`ARCH-07` (Accepted)**: Place new TS helper at `src/link/ephemeral-child.ts`, keep zero edits in `src/cli/index.ts` or any `file-size-baseline.json` file, keep `core-link-boundary` and `core-lab-boundary` untouched, register all new TS tests in `scripts/test-layout/layout-clients.json` + `tests/fixtures/test-layout-expected.json`, and update `structure/remote-link.md` + `docs-site/`.
- **Same-architect reflection (`01a1b18b-a2f3-7b53-971a-9b2c9cccecf7`)**:
  - Submitted concrete plan revision: `devlog/_plan/261107_ocx_child_ephemeral_link/{000_roadmap.md,010_wp1_conformance_contract.md,020_wp2_rust_ocx_child.md,030_wp3_home_link_integration.md,040_wp4_docs_gates_and_pr.md}` (recorded in Section 3.1 immediately after reflection response).

### 3.1 Reflection Record

- **Handle `01a1b18b-a2f3-7b53-971a-9b2c9cccecf7` reflection verdict**: `ALIGNED`.
- **Decision-ID mapping verified**: `ARCH-01` -> `000` §3 + `020` §1.1–§1.2; `ARCH-02` -> `000` §3 + `020` §1.2.3–§1.2.4; `ARCH-03` -> `000` §3, §5 + `020` §1.2.5; `ARCH-04` -> `000` §3, §5 + `020` §1.2.6; `ARCH-05` -> `000` §3, §8 + `030` §1.1–§1.3; `ARCH-06` -> `000` §5 + `010` §1.2–§1.3 + `020` §1.3; `ARCH-07` -> `000` §3, §7 + `010` §1.1 + `030` §1.5 + `040` §1.1–§1.2.
- **Minor notes folded into `020_wp2_rust_ocx_child.md`**:
  - `Gap-1` (Accepted): `ChildJournalV1` snapshots `preAttachModelsCacheExisted` / `preAttachModelsCacheBytesB64` / `latestModelsCacheSha256` so offline `detach` restores pre-attach `models_cache.json` (or unlinks an unchanged cache `ocx-child` created) and never leaves stale Home slugs in Codex's model picker.
  - `Gap-2` (Accepted): `native/ocx-child/Cargo.toml` includes `Win32_Security_Authorization` on `windows-sys` and `write_private_atomic` on Windows hardens `$OPENCODEX_HOME/child` and its `0600`-equivalent secret/journal files with an owner-only protected DACL.

## 4. Dependency-Ordered Work-Phase Map (`PHASE-SPLIT-01`)

Phases follow strict dependency order (shared wire/golden contracts -> standalone Child binary -> Home orchestration & E2E integration -> SoT documentation & publication):

| Work Phase | Decade PRD | Depends On | Deliverable & Independent Verification Closure |
|---|---|---|---|
| `wp0` | `000_roadmap.md` + `010..040` | — | Complete roadmap and diff-level PRDs audited and closed with zero production edits (`LOOP-DOCS-FIRST-01`) |
| `wp1` | `010_wp1_conformance_contract.md` | `wp0` | `src/link/ephemeral-child.ts` pure helpers + `tests/fixtures/link/ocx-child-conformance.json` + `tests/clients/link-ocx-child-conformance.test.ts` registered in dual test-layout maps; passes `bun test` + `bun run typecheck` |
| `wp2` | `020_wp2_rust_ocx_child.md` | `wp1` | `native/ocx-child/` crate (`Cargo.toml`, `Cargo.lock`, `src/**`, `tests/conformance.rs`, `tests/relay_and_lifecycle.rs`) passing `cargo test --locked`, `cargo clippy --locked --all-targets -- -D warnings`, and `cargo build --release --locked` (~1-2 MB stripped binary) |
| `wp3` | `030_wp3_home_link_integration.md` | `wp2` | Home candidate discovery (`src/link/ssh-argv.ts`, `src/link/remote-windows.ts`), detached `ocx-child` enrollment preflight (`src/link/remote-probe.ts`, `src/server/management/link-enrollment.ts`), `package.json` scripts/files, and focused + real-binary E2E tests (`tests/clients/link-ephemeral-child-discovery.test.ts`, `tests/server/link-enrollment-ephemeral-child.test.ts`, `tests/clients/ocx-child-e2e.test.ts`) |
| `wp4` | `040_wp4_docs_gates_and_pr.md` | `wp3` | `structure/manifest.json` + `structure/remote-link.md` + `structure/overview.md` (`INV-LINK-01` or bound invariant) + `docs-site/` updates, full verification matrix, branch push, unmerged PR targeting `dev` with Security Review Summary, `goat_pull_request_link`, green checks, and `cxc loop pr-record` |

Single-PR delivery decision (`DEV-STACK-01`): Delivered as a single focused PR targeting `dev` because `native/ocx-child`, its golden conformance vectors, and the ~60-line Home discovery/preflight integration form one cohesive feature slice within the lane's authorized branch `feat/ocx-child-ephemeral-link`.

## 5. Cross-Boundary Field & Type Chains (`PLAN-FIELD-CHAIN-01`)

| Field / Schema | Creation | Serialization | Deserialization | Consumers |
|---|---|---|---|---|
| `ephemeralChild: true` on Child `config show --json` (`EphemeralChildConfigProjection`) | `native/ocx-child/src/cli.rs` (`cmd_config_show`) | `serde_json::to_string` on `ocx-child` stdout over SSH | `JSON.parse` in `src/server/management/link-enrollment.ts` -> `isDetachedEphemeralChildConfig` in `src/link/ephemeral-child.ts` | `src/server/management/link-enrollment.ts` (`apply` preflight branching between live standalone `ocx` vs clean detached `ocx-child`); full `ocx` omits field -> defaults to existing standalone branch |
| `ephemeralChild: true` on Child `GET /healthz` | `native/ocx-child/src/relay.rs` (`handle_healthz`) | `serde_json::to_vec` HTTP `200` body | `parseChildHttp` (`src/link/remote-probe.ts:30`) / `Response.json()` in `src/cli/link-apply-restart.ts:36` & `src/server/proxy-liveness.ts` | `isChildHealth(..., "client", childPort)` (`src/link/remote-probe.ts:35` ignores extra fields and verifies `service`, `port`, `pid`, `role === "client"`), `readClientRuntimeStartedAt`, E2E/diagnostic callers |
| `ChildStateV1` (`schema: "ocx.child.state/1"`) | `native/ocx-child/src/state.rs` (`write_state_atomic`) | `serde_json::to_vec_pretty` into `$OPENCODEX_HOME/child/state.json` (`0600`) | `serde_json::from_slice` (`#[serde(deny_unknown_fields)]`) in `native/ocx-child/src/state.rs` | Internal to `ocx-child` (`serve`, `sync`, `detach`/`disconnect`, `restart`, `status`, `config show`); N/A outside `ocx-child` because full `ocx` uses `config.json` and fail-closed guards forbid mixing |
| `ChildJournalV1` (`schema: "ocx.child.journal/1"`) | `native/ocx-child/src/journal.rs` (`create_or_update_journal`) | `serde_json::to_vec_pretty` into `$OPENCODEX_HOME/child/codex-journal.json` (`0600`) | `serde_json::from_slice` (`#[serde(deny_unknown_fields)]`) in `native/ocx-child/src/journal.rs` | `ocx-child` `sync` (updates `latestInjectedConfigSha256`, `ledger`, `latestCatalogSha256`) and offline `detach`/`disconnect` (Tier-1 hash restore or Tier-2 surgical value strip); also conformance harness in `native/ocx-child/tests/conformance.rs` |
| `ConformanceSuite` (`schema: "ocx.child.conformance/1"`) | Checked-in JSON fixture `tests/fixtures/link/ocx-child-conformance.json` verified against TS oracle functions | Static UTF-8 JSON file in git | `JSON.parse` in `tests/clients/link-ocx-child-conformance.test.ts` AND `serde_json::from_str` in `native/ocx-child/tests/conformance.rs` | Both `bun test` and `cargo test` conformance runners asserting identical outputs across route admission, framing/stripping, HMAC v2, OCX-6 digest, child-parity validation, and TOML/catalog round-trips |
| `ClientSyncMismatchReason` stderr JSON (`{"phase":"child_link_mismatch","reason":"..."}`) | Existing closed union in `src/client/sync-expectation.ts:17` (no new enum members added); emitted by `native/ocx-child/src/cli.rs` on `--expect-link` mismatch/busy lock | `serde_json::to_string` as final stderr line with exit code `5` | `JSON.parse(last ?? "")` in `src/cli/sync-fanout.ts:62` checking `mismatchReasons` set | Home `ocx sync [--json]` fan-out classifier (`classifySyncResult` -> `skipped("child-link-mismatch:<reason>")`) |

## 6. Verification scope

The work packages record implementation and conformance-test status.

## 7. Grounded Verifiers (`PLAN-VERIFIER-REAL-01`)

Every existing repository gate below was executed on the clean worktree before authoring this roadmap:

| Verifier Command | Baseline Exit Today | How It Reads This Unit's Change Target |
|---|---|---|
| `bun run typecheck` (`bun check --no-script --noEmit`) | `0` (`2,318 files`) | `tsconfig.json` includes `src/**/*.ts`, `scripts/**/*.ts`, and `tests/**/*.ts`, directly typechecking `src/link/ephemeral-child.ts`, `src/server/management/link-enrollment.ts`, and all new `tests/**/*.test.ts` |
| `bun scripts/structure-ssot.ts` (`bun run structure:check`) | `0` | Reads `structure/manifest.json`, `structure/INDEX.md`, `structure/overview.md`, `structure/remote-link.md`, and `git ls-files` (`scripts/structure-ssot.ts:315-635`), validating `src/link/` & `native/ocx-child/` path references and invariant bindings |
| `bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts` | `0` (`28 pass`) | Walks `tests/**/*.test.ts`, `scripts/test-layout/layout.json` + `explicitShards` (`scripts/test-layout/layout-clients.json`), and `tests/fixtures/test-layout-expected.json` (`tests/test-layout-tooling.test.ts:28,287`) |
| `bun test tests/lab/core-lab-boundary.test.ts tests/lab/core-link-boundary.test.ts` | `0` | Walks static imports from `src/router.ts`, `src/server/lifecycle.ts`, and `src/server/responses/core.ts` (`tests/lab/core-link-boundary.test.ts:9-48`) |
| `bun test tests/clients/link-pinned-sync-argv.test.ts tests/clients/link-ssh-argv.test.ts tests/clients/link-ssh-argv-discovery.test.ts` | `0` | Directly imports `src/link/ssh-argv.ts` and `src/link/remote-windows.ts` and executes `REMOTE_OCX_SCRIPT`, `REMOTE_PINNED_SYNC_SCRIPT`, `windowsOcxArgv`, and `windowsPinnedSyncArgv` (`POWERSHELL_ENCODED_MAX = 8000`) |
| `bun run privacy:scan` (`bun scripts/privacy-scan.ts`) | `0` (verified in `wp0` Check) | Scans tracked git files across `devlog/`, `src/`, `native/`, `tests/`, and `docs-site/` |
| `cargo test --locked --manifest-path native/ocx-child/Cargo.toml` & `cargo build --release --locked --manifest-path native/ocx-child/Cargo.toml` | Phase-created in `wp2` (`rustc 1.99.0` / `cargo 1.99.0` verified present) | Compiles and executes `native/ocx-child/src/**` and `native/ocx-child/tests/**` directly from `native/ocx-child/Cargo.toml` |
| `cd docs-site && bun install --frozen-lockfile && bun run build` | Executed in `wp4` when `docs-site/` changes | Astro/Starlight build reading `docs-site/src/content/docs/guides/remote-link.md` and `reference/cli/lifecycle.md` |

## 8. Non-Goals, Alternatives Rejected, & Consequences

- **Non-goals**:
  - SCP/SFTP binary auto-upload from Home during `ocx link add` (`ocx-child` is discovered on the remote host like `ocx`).
  - Child-initiated (`POST /api/link/join` / local `ssh -L` tunnel supervisor) or local web dashboard on `ocx-child`.
  - Provider-table (`[model_providers.opencodex]`) auth-header injection on `ocx-child` (loopback Design B needs no local bearer token).
- **Alternatives rejected**:
  - *Compiling `src/` with `bun build --compile` for Children*: Still ~100-217 MB and embeds the full proxy/GUI/provider runtime.
  - *Async `tokio` + `hyper` + `toml_edit` Rust stack*: Adds ~60+ crates and megabytes of binary weight for loopback-only HTTP/1.1 streams and line-oriented TOML edits.
  - *Adding `childKind` to `links.json`*: Breaks strict `exactKeys` compatibility in `src/link/store.ts:16` on downgrade while providing zero benefit once `remoteOcxArgv` and `remotePinnedSyncArgv` discover `ocx-child` in fallback order.
- **Consequences**:
  - Ephemeral SSH hosts need only a single ~1-2 MB static-friendly Rust binary (`ocx-child`) and `curl` (POSIX) / PowerShell (Windows).
  - Both `bun test` and `cargo test` must keep `tests/fixtures/link/ocx-child-conformance.json` green whenever Link routes, relay-auth v2, or OCX-6 settings digests evolve.
