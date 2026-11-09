# Zero-Preinstall SSH Planting, Two-Tier `--purge` Detach, and `#remote` UX Complete Lightweight Ephemeral Child Onboarding

> Reader contract: For OpenCodex maintainers and reviewers evaluating stacked PR delivery on `feat/ocx-child-plant-ux` (based on `feat/ocx-child-ephemeral-link`, #8237). Document type: Decision & Roadmap Specification (`000`-range, zero implementation diffs per `LEXICO-SPLIT-01`).

PR #8237 introduced `native/ocx-child` (~0.9 MB standalone Rust binary) and Home discovery/enrollment support, yet operators connecting a bare SSH devbox, container, or VM still hit `502 remote_ocx_missing` unless they manually copy `ocx-child` onto the Child first, have no one-click or `--purge` option to remove the planted binary on disconnect, receive generic conflict errors when port `10100` or `~/.codex/config.toml` is already owned externally, and see no mode or settings-parity badges in `#remote`. How can OpenCodex deliver zero-preinstall SSH Child onboarding, clean two-tier disconnect (`fast detach` vs `--purge`), actionable conflict diagnostics, and full CLI + 11-locale `#remote` UX without touching release workflows or file-size ratchets? We extend Home host inspection to classify `runtimeKind` (`full` | `ephemeral` | `missing`) and `targetTriple`, verify local `ocx-child` artifacts by SHA-256 (`src/link/child-binary-source.ts`), stream atomic SSH `stdin` plants into the Child's user cache bin directory when authorized (`plant: true`), add safe managed-path `--purge` self-removal and structured conflict markers to `native/ocx-child`, persist `childKind` on `LinkRecord`, and redesign `#remote` + `ocx link add|revoke` across all 11 locales.

## Contents

1. [Loop Specification & HOTL Bounds](#1-loop-specification--hotl-bounds)
2. [Threat Model & Security Controls (`SEC-THREAT-01`)](#2-threat-model--security-controls-sec-threat-01)
3. [Architect Consultation & Design Dispositions](#3-architect-consultation--design-dispositions)
4. [Dependency-Ordered Work-Phase Map (`PHASE-SPLIT-01`)](#4-dependency-ordered-work-phase-map-phase-split-01)
5. [Cross-Boundary Field & Type Chains (`PLAN-FIELD-CHAIN-01`)](#5-cross-boundary-field--type-chains-plan-field-chain-01)
6. [Early-Warning & Boundary Guard Disclosure (`PLAN-BYPASS-NAMED-01`)](#6-early-warning--boundary-guard-disclosure-plan-bypass-named-01)
7. [Grounded Verifiers (`PLAN-VERIFIER-REAL-01`)](#7-grounded-verifiers-plan-verifier-real-01)
8. [Non-Goals, Alternatives Rejected, & Consequences](#8-non-goals-alternatives-rejected--consequences)

## 1. Loop Specification & HOTL Bounds

| Field | Specification |
|---|---|
| Loop archetype | `satisfy-spec` (Class C4 multi-cycle HOTL PABCD with docs-first `wp0` entry per `LOOP-DOCS-FIRST-01`) |
| Trigger | Dispatched GOAT task lane `lane-ocx-child-plant-ux` on branch `feat/ocx-child-plant-ux` stacked on open PR #8237 (`feat/ocx-child-ephemeral-link` at `c4d4d5d6311905bea62f065d7d04b9de7cdb5a86`) |
| Goal | Deliver zero-preinstall SSH binary planting, `--purge` managed-path removal, actionable `child_port_busy` / `child_external_provider_conflict` diagnostics, `LinkRecord.childKind` persistence/projection, CLI `--plant` / `--purge` flags, `#remote` GUI redesign across all 11 locales, `pr-assets` UI screenshots, and an unmerged stacked PR |
| Non-goals | Merging the PR (`authority.merge = false`), editing `.github/workflows/` or `scripts/release.ts`, touching `src/lab/` or `core-lab-boundary` protected files (`src/router.ts`, `src/server/lifecycle.ts`, `src/server/responses/core.ts`), raising file-size ratchets, committing PNGs onto `feat/ocx-child-plant-ux`, dispatching `lane=all` CI, mutating shared `.codexclaw` subagent configs, or calling `web_search` |
| Verifier | Grounded commands in [Section 7](#7-grounded-verifiers-plan-verifier-real-01): `cargo test` + `cargo build --release --locked`, `bun run typecheck`, `bun run test:changed`, `cd gui && bun run lint:i18n && bun run lint && bun test tests && bun run build`, `bun run build:gui`, `bun run structure:check`, `cd docs-site && bun run build`, `bun run privacy:scan`, and `gh pr checks` |
| Stop condition | All work-phases `wp0..wp4` and criteria `c-1..c-5` met with fresh receipts, UI screenshots pushed only to `origin/pr-assets`, stacked PR opened with `DEV-STACK-03` table, exact-head PR checks green and recorded via `cxc loop pr-record`, `goat_pull_request_unwatch` called, and `update_goal({ status: "complete" })` accepted |
| Memory artifact | `devlog/_plan/261107_ocx_child_plant_ux/` (`000_roadmap.md` + `010..040` PRDs) and `.codexclaw/goalplans/loop-archetype-satisfy-spec-class-c4-hotl-multi/goalplan.json` |
| Expected terminal outcomes | `DONE`: all `c-1..c-5` verified + green unmerged stacked PR recorded; `NOOP`: N/A; `BLOCKED`: reproducible CI/policy/toolchain refusal reported with `file:line` and command output without weakening checks; `UNSAFE`: unmitigated binary integrity, symlink, or path-deletion hazard; `NEEDS_HUMAN`: out-of-scope authority required; `BUDGET_EXHAUSTED`: host limit reached |
| Escalation condition | Any requirement to edit outside `writeScope` (`native/ocx-child`, `src/link`, `src/server/management`, `src/cli`, `gui`, `structure`, `docs-site`, `scripts`, `tests`, `devlog`), weaken a check, commit images to the PR branch, or merge. Subagents inherit `google-antigravity/gemini-4-argon` per user directive |
| HOTL resource bounds | Token/cost/wall-clock bounds: `none stated; host limits apply`. Tool/credential scope: local git/bun/cargo, headless browser for local `#remote` screenshot capture, `origin/pr-assets` upload, `gh pr create` / `gh pr view` / `gh pr checks`, GOAT PR link/watch/unwatch |

## 2. Threat Model & Security Controls (`SEC-THREAT-01`)

1. **Assets**:
   - Remote Child host filesystem integrity (`$HOME/.cache/opencodex/bin/ocx-child`, `%LOCALAPPDATA%\opencodex\bin\ocx-child.exe`, `$OPENCODEX_HOME/child/*`, `~/.codex/*`).
   - Integrity and authenticity of the `ocx-child` binary streamed from Home to Child over SSH `stdin`.
   - Operator consent before mutating a bare remote host (`plant: true` / `--plant` / explicit confirmation).
   - Existing SSH host-key pinning (`StrictHostKeyChecking=yes`, private `known_hosts`, `BatchMode=yes`, `ClearAllForwardings=yes`) and Windows `OcxJob` process containment.
2. **Entrypoints & Trust Boundaries**:
   - Home binary artifact resolution (`src/link/child-binary-source.ts`) reading `OPENCODEX_CHILD_BIN_DIR`, sidecar directories, local `target/release`, or `$OPENCODEX_HOME/cache/ocx-child/<version>/`.
   - Home `POST /api/link/probe`, `POST /api/link/confirm-host`, `POST /api/link/apply`, and `DELETE /api/link/:id` (`src/server/management/link-enrollment.ts`, `link-routes.ts`).
   - SSH `stdin` binary write & execution on POSIX (`sh -c`) and Windows (`powershell.exe -EncodedCommand` under `OcxJob`).
   - `ocx-child detach --purge` / `disconnect --purge` self-removal (`native/ocx-child/src/cli.rs`, `platform.rs`).
3. **Attacker Capabilities & Hazard Scenarios**:
   - Corrupted, truncated, symlinked, or unverified `ocx-child` binary in cache/override directory streamed onto a Child.
   - Pre-existing symlink at `$HOME/.cache/opencodex/bin` or `$HOME/.cache/opencodex/bin/ocx-child` (or Windows ReparsePoint) tricking plant or `--purge` into overwriting or deleting an unintended file.
   - `ocx-child detach --purge` invoked on a system/package-manager/user path (`/usr/local/bin/ocx-child`, `~/.local/bin/ocx-child`, Cargo target dir) deleting a binary Home did not plant.
   - Non-interactive CLI automation running `ocx link add <alias> --expect-fingerprint <fp>` against a bare host without intending to install software on it.
4. **Controls**:
   - **SHA-256 artifact verification & regular-file checks**: `child-binary-source.ts` rejects symlinks (`lstatSync`), group/world-writable binaries on POSIX, empty/oversized (> 32 MiB) files, and requires exact `SHA256SUMS` verification for cached/distributed artifacts (computing SHA-256 over the exact read `Buffer` streamed to `stdin` to eliminate TOCTOU between hash and stream).
   - **Explicit `plant` authorization**: `POST /api/link/apply` never plants unless `body.plant === true`; non-TTY `ocx link add` refuses bare hosts unless `--plant` is passed alongside `--expect-fingerprint`; GUI shows an explicit Ready-to-Plant card with architecture and byte size.
   - **Symlink-refusing atomic plant & Windows `OcxJob` containment**: POSIX plant runs under `umask 077`, refuses symlinked parent/target (`[ ! -L ... ]`), writes to `.ocx-child.tmp.$$.<rand>`, verifies exact byte count and `chmod 0700`, atomically `mv -f`s into `$HOME/.cache/opencodex/bin/ocx-child`, and verifies `--version` exit `0`. Windows plant runs inside packed PowerShell + `OcxJob` (`<= 8000` UTF-16LE base64 chars), rejects `ReparsePoint` attributes on parent/target, verifies exact byte length and SHA-256, moves atomically into `%LOCALAPPDATA%\opencodex\bin\ocx-child.exe`, and verifies `[OcxJob]::Ok`.
   - **Post-plant rollback**: If `apply` fails after planting a fresh binary in that enrollment attempt (`plantedFreshBinary === true`), Home runs bounded cleanup (`ocx-child detach --purge` / managed-path removal) before returning the error so failed enrollments leave zero orphan binaries or daemons.
   - **Managed-path-only `--purge`**: `native/ocx-child` inspects `current_exe` without following a final symlink (`symlink_metadata`), verifies the parent directory matches ONLY the managed plant location (`*/.cache/opencodex/bin/ocx-child` on POSIX; `*\opencodex\bin\ocx-child.exe` or `*/.cache/opencodex/bin/ocx-child.exe` on Windows), refuses symlinks/reparse points and foreign paths (treating non-managed paths as a safe no-op binary keep with a notice), removes `$OPENCODEX_HOME/child` only via `fs::remove_dir` (which fails safely if non-empty), and on Windows renames `ocx-child.exe` aside in the same directory before spawning a short detached `cmd.exe /d /c` deleter.

## 3. Architect Consultation & Design Dispositions

- **Proposals consulted**:
  - Initial read-only architect handle `01a1b2ea-432d-7001-8efc-89edb28881db` (retired after 145s timeout with zero workspace mutations per `DISPATCH-RETIRE-01`) and live read-only architect handle `01a1b2ed-664f-7180-99b1-fd1091864296` (both inherited `google-antigravity/gemini-4-argon`).
- **Main dispositions on `ARCH-01..ARCH-06`**:
  - **`ARCH-01` (Amended)**: Adopt `allowMissing?: boolean` on `POST /api/link/probe` (when `includeVersion: true`) and `POST /api/link/confirm-host`, returning `runtimeKind: "full" | "ephemeral" | "missing"`, `targetTriple: "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64" | "windows-x64" | null`, `ocxVersion: string | null`, `plantable: boolean`, `binarySizeBytes?: number`, and `plantUnavailableReason?: string`. **Amendment**: When `allowMissing !== true`, `confirm-host` preserves the exact legacy `remoteOcxArgv(["--version"], remotePlatform)` call and `{ alias, fingerprint, ocxVersion }` response shape so `tests/server/link-enrollment.test.ts:90` and Find Home (`role === "child"`) remain 100% unchanged; when `allowMissing === true`, a single framed inspection command (`src/link/remote-plant.ts`) reports OS/arch, selected candidate kind (`full` vs `ephemeral` vs `missing`), and `--version` output in one SSH round-trip.
  - **`ARCH-02` (Accepted)**: Implement `src/link/child-binary-source.ts` resolving `(1)` `OPENCODEX_CHILD_BIN_DIR`, `(2)` sidecar directories (`native-bin/<targetTriple>/` and beside `process.execPath`), `(3)` local `native/ocx-child/target/release/ocx-child(.exe)` when `targetTriple === hostTriple`, and `(4)` `$OPENCODEX_HOME/cache/ocx-child/<version>/` verified against `SHA256SUMS`. Read bytes once into memory and return `{ bytes, sizeBytes, sha256, targetTriple, sourceKind }`.
  - **`ARCH-03` (Amended)**: Implement POSIX and Windows SSH `stdin` atomic plant and post-plant failure rollback in `POST /api/link/apply` (`plant?: boolean`). **Amendment**: Reject reordering `REMOTE_OCX_CANDIDATES` / `OCX_CANDIDATES` ahead of full `ocx` when `child/state.json` is absent — `structure/remote-link.md:187` and `tests/clients/link-ephemeral-child-discovery.test.ts` lock the invariant that full `ocx` wins when detached while `child/state.json` pins `ocx-child` once attached. On a bare host no full `ocx` exists, so `$HOME/.cache/opencodex/bin/ocx-child` / `%LOCALAPPDATA%\opencodex\bin\ocx-child.exe` is already discovered first and then pinned by `child/state.json`.
  - **`ARCH-04` (Accepted)**: Implement `--purge` on `ocx-child detach` and `ocx-child disconnect` (`cli.rs` + `platform.rs`) with strict managed-path and non-symlink verification, empty `$OPENCODEX_HOME/child` directory removal, and Windows rename-aside + detached `cmd.exe /d /c` self-delete. Add deterministic conflict markers (`ocx-child-conflict:child_port_busy`, `ocx-child-conflict:child_external_provider_conflict`) and map both Home preflight and `connect` failures to `409 child_port_busy` and `409 child_external_provider_conflict` with zero Child file mutations.
  - **`ARCH-05` (Amended)**: Persist optional `childKind?: "full" | "ephemeral"` on `LinkRecord` (`src/link/store.ts`), project `childKind` on `LinkStatusDto["links"][number]` (`src/link/status-projection.ts`, omitting when undefined on legacy records so legacy exact-object fixtures stay untouched while GUI defaults legacy hub-initiated rows to `"full"`), expose `homeCodexSettingsDigest` on `GET /api/link/status` for `gui-session` callers (`src/server/management/link-routes.ts:300`), and extend `DELETE /api/link/:id` body to `{ force?: boolean, purge?: boolean }` (rejecting `force: true` combined with `purge: true` as `400 invalid_body`, and running `remoteOcxArgv(["disconnect", "--purge"], platform)` when `purge === true` on `record.childKind === "ephemeral"`).
  - **`ARCH-06` (Accepted)**: Extend `ocx link add [--plant]` and `ocx link revoke [--purge]`, extract modular GUI components (`gui/src/pages/RemoteLinkSheet.tsx` and `gui/src/pages/RemoteLinkDialogs.tsx`) so `RemoteLink.tsx` shrinks cleanly, style via `gui/src/styles-remote-link.css` (leaving baseline-capped `gui/src/styles.css` untouched), and update all 11 locale catalogs (`en`, `ko`, `ja`, `zh`, `zh-TW`, `de`, `fr`, `pt`, `ru`, `tr`, `vi`) in small 2–3 file batches.

### 3.1 Same-Architect Reflection Record

- **Submitted concrete plan revision**: `devlog/_plan/261107_ocx_child_plant_ux/{000_roadmap.md,010_wp1_rust_purge_and_conflicts.md,020_wp2_home_plant_store_and_api.md,030_wp3_cli_and_gui_remote_ux.md,040_wp4_docs_screenshots_and_pr.md}`.
- **Reflection handle `01a1b2ed-664f-7180-99b1-fd1091864296` verdict**: `ALIGNED` (zero material gaps).
- **Decision-ID mapping verified**: `ARCH-01` -> `000` §3, §5 + `010` §2.3 + `020` §2.1–§2.2; `ARCH-02` -> `000` §2–§3 + `010` §2.3; `ARCH-03` -> `000` §2–§3 + `010` §2.3 + `020` §2.2; `ARCH-04` -> `000` §3, §5 + `010` §2.1–§2.2 + `020` §2.2; `ARCH-05` -> `000` §3, §5 + `010` §2.3 + `020` §2.3; `ARCH-06` -> `000` §3 + `030` §1–§3 + `040` §1–§2.

## 4. Dependency-Ordered Work-Phase Map (`PHASE-SPLIT-01`)

| Work Phase | Decade Doc | Architectural Layer | Depends On | Key Deliverables & Verifiable Close |
|---|---|---|---|---|
| `wp0` | `000_roadmap.md`, `010..040` | Specification & Audit | — | Diff-level PRDs, architect reflection, independent A-gate review, verifier grounding; closes `D -> IDLE` with zero production edits |
| `wp1` | `010_wp1_rust_purge_and_conflicts.md` | Rust `ocx-child` & `src/link/` Foundations | `wp0` | `native/ocx-child` `--purge` + conflict markers; `LinkRecord.childKind`; `child-binary-source.ts`; `remote-plant.ts` + `remote-windows.ts` inspect/plant argv builders; Cargo + Bun unit tests green |
| `wp2` | `020_wp2_home_plant_store_and_api.md` | Home Management API & Status Projection | `wp1` | `probe` / `confirm-host` (`allowMissing`), `apply` (`plant` + rollback + `childKind` + `409` conflict codes), `status` (`childKind` + `homeCodexSettingsDigest`), `DELETE /api/link/:id` (`purge`); server & E2E plant/purge tests green |
| `wp3` | `030_wp3_cli_and_gui_remote_ux.md` | CLI & `#remote` Dashboard UX + 11 Locales | `wp2` | `ocx link add --plant`, `ocx link revoke --purge`, `RemoteLink.tsx` + sibling components, Ready-to-Plant card, mode/parity badges, conflict notices, Disconnect `--purge` modal, 11 locales; CLI + GUI `lint:i18n`, `lint`, `test`, `build` green |
| `wp4` | `040_wp4_docs_screenshots_and_pr.md` | SoT Docs, `pr-assets` Screenshots & Stacked PR | `wp3` | `structure/remote-link.md` + `docs-site/` sync, full gates, real `#remote` PNGs pushed ONLY to `origin/pr-assets`, stacked PR opened against `feat/ocx-child-ephemeral-link` (#8237), CI/review watch to green, `cxc loop pr-record` |

## 5. Cross-Boundary Field & Type Chains (`PLAN-FIELD-CHAIN-01`)

1. **`LinkChildKind` (`"full" | "ephemeral"`)**:
   - **Creation**: `src/server/management/link-enrollment.ts` (`apply` sets `childKind: ephemeralChild ? "ephemeral" : "full"` on hub-initiated `LinkRecord`). Client-initiated `/api/link/issue` sets `childKind: "full"` (legacy records omit).
   - **Serialization**: `src/link/store.ts` (`writeLinkStore` writes `links.json` with `"childKind"` added to `RECORD_KEYS`).
   - **Deserialization**: `src/link/store.ts` (`parseRecord` validates `raw.childKind === undefined || raw.childKind === "full" || raw.childKind === "ephemeral"`).
   - **Consumers**: `src/link/status-projection.ts` (`projectLinkStatus` copies optional `childKind` onto `LinkStatusDto["links"][number]`); `src/server/management/link-routes.ts` (`remove` checks `purge === true && record.childKind === "ephemeral"`); `src/cli/link.ts` (`validateStatus` accepts optional `"childKind"`, `runRevoke` uses status/store `childKind` to print `~/.cache/opencodex/bin/ocx-child detach` recovery on `--force`); `gui/src/remote-link-api.ts` (`parseRemoteLinkStatus` parses `childKind`); `gui/src/pages/RemoteLink.tsx` & `RemoteLinkDialogs.tsx` (Connected row badge, Disconnect `--purge` checkbox visibility, Force-remove command chip).
2. **`RemoteRuntimeKind` (`"full" | "ephemeral" | "missing"`) & `ChildTargetTriple` (`"darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64" | "windows-x64"`)**:
   - **Creation**: `src/link/remote-plant.ts` (`inspectRemoteChildRuntime` parses framed SSH stdout + `resolveChildBinarySource`).
   - **Serialization**: `src/server/management/link-enrollment.ts` (`probe` and `confirmHost` JSON responses when `allowMissing === true`, plus `ConfirmedLinkHost` in-memory state).
   - **Deserialization**: `src/cli/link-enrollment.ts` (`offered` & confirm validator) and `gui/src/remote-link-api.ts` (`parseConfirmation`).
   - **Consumers**: `src/server/management/link-enrollment.ts` (`apply` requires `plant === true` when `confirmed.runtimeKind === "missing"`, streams `targetTriple` binary); `src/cli/link-enrollment.ts` (TTY plant prompt vs non-TTY `--plant` gate); `gui/src/pages/RemoteLinkSheet.tsx` (Ready-to-Plant card vs Cached Ephemeral card vs Full OpenCodex card).
3. **Conflict Error Codes (`"child_port_busy"` | `"child_external_provider_conflict"` | `"remote_plant_failed"`)**:
   - **Creation**: `native/ocx-child/src/daemon.rs` (`ensure_port_available_for_attach`), `native/ocx-child/src/toml_surgeon.rs` (`detect_unowned_root_routing_conflict`), and `src/server/management/link-enrollment.ts` (`apply` preflight/plant/connect error mapping).
   - **Serialization**: `src/server/management/link-route-state.ts` (`fail(code, message, 409 | 502, hint)`).
   - **Deserialization**: `src/cli/link-enrollment.ts` (`PHASES` / specific error messages) and `gui/src/remote-link-api.ts` (`LINK_ERROR_CODES` + `LinkApiError`).
   - **Consumers**: `gui/src/pages/RemoteLink.tsx` (`ERROR_TKEY` -> localized `Notice` across all 11 `gui/src/i18n/*.ts` files) and `src/cli/link-enrollment.ts` (human-readable stderr recovery).
4. **Home Parity Digest on GUI Status (`homeCodexSettingsDigest` + `appliedCodexSettingsDigest`)**:
   - **Creation**: `src/server/management/link-routes.ts` (`GET /api/link/status` computes `codexSettingsDigest(projectHomeCodexSettings(ctx.config, "0.0.0").settings)` for `ctx.principal === "gui-session"`, alongside existing `LinkChildParity.appliedCodexSettingsDigest`).
   - **Serialization**: `Response.json(body)` on `GET /api/link/status` (omitted on `admin-token` responses so strict CLI `validateStatus` top-level keys stay unchanged).
   - **Deserialization**: `gui/src/remote-link-api.ts` (`parseRemoteLinkStatus` extracts `homeCodexSettingsDigest: string | null` and per-row `appliedCodexSettingsDigest: string | null`).
   - **Consumers**: `gui/src/pages/RemoteLink.tsx` (renders "Home settings synced" / "Sync needed" badge when both digests are non-null on a connected Child row).

## 6. Early-Warning & Boundary Guard Disclosure (`PLAN-BYPASS-NAMED-01`)

| Guard / Control | Tier | Executing Surface | Known Bypass Path | Residual Risk | Wording Policy | Final Layer |
|---|---|---|---|---|---|---|
| Managed-path check on `ocx-child detach --purge` | E2 (Runtime check) | `native/ocx-child/src/platform.rs` (`purge_managed_executable`) | Local Child user can manually `rm` any file they own over SSH | None for foreign paths: `ocx-child` refuses to unlink symlinks or paths outside `.cache/opencodex/bin` / `AppData\Local\opencodex\bin` | Described as a safety guard on `--purge`, never OS-level immutability | `native/ocx-child` `symlink_metadata` + parent path suffix match |
| `SHA256SUMS` check in `child-binary-source.ts` | E2 (Runtime check) | `src/link/child-binary-source.ts` | Same local OS user setting `OPENCODEX_CHILD_BIN_DIR` or rebuilding `native/ocx-child/target/release` locally | Local Home process user already owns SSH keys to Child; protects against corrupted/tampered downloads or cache files | Called artifact integrity verification against `SHA256SUMS` / local build | Exact byte-count + SHA-256 check on the Child plant script |
| Non-TTY `--plant` requirement in `ocx link add` | E2 (CLI check) | `src/cli/link-enrollment.ts` + `POST /api/link/apply` (`plant === true`) | Caller with admin token or paired GUI session explicitly passing `"plant": true` | Intentional: `plant: true` is the explicit opt-in contract | Called explicit plant opt-in guard | `POST /api/link/apply` server check (`body.plant === true`) |

## 7. Grounded Verifiers (`PLAN-VERIFIER-REAL-01`)

Every verifier below was executed or verified against the repository scripts on `2026-11-07`:

1. `cargo test --locked --manifest-path native/ocx-child/Cargo.toml` — baseline ran (`exit 0`, 8/8 tests passed); directly compiles and tests `native/ocx-child/src/**/*.rs` and `native/ocx-child/tests/*.rs`.
2. `cargo build --release --locked --manifest-path native/ocx-child/Cargo.toml` — builds the real `native/ocx-child/target/release/ocx-child` binary consumed by `child-binary-source.ts` and E2E SSH plant/purge tests.
3. `bun run typecheck` (`package.json` -> `bun check --no-script --noEmit`) — baseline ran (`exit 0`, 2,319 files checked); directly typechecks `src/**/*.ts`, `tests/**/*.ts`, and `gui/src/**/*.tsx` including all 11 `gui/src/i18n/*.ts` `TKey` exhaustiveness checks.
4. `cd gui && bun run lint:i18n` (`oxlint src/pages src/components src/App.tsx src/main.tsx src/ui.tsx src/provider-workspace-data.ts`) — baseline ran (`exit 0`); enforces zero hardcoded UI strings in `gui/src/pages/RemoteLink*.tsx` and locale catalog parity.
5. `cd gui && bun run lint && bun test tests && bun run build` (plus root `bun run build:gui`) — directly lints, runs `gui/tests/remote-link.test.tsx` + `remote-link-route.test.tsx`, and bundles `gui/dist`.
6. `bun run test:changed` + explicit focused suites (`bun test tests/clients/link-*.test.ts tests/server/link-*.test.ts tests/cli/cli-link*.test.ts tests/ci-workflows/file-size-ratchet.test.ts tests/ci-workflows/repo-hygiene.test.ts tests/test-layout.test.ts tests/test-layout-tooling.test.ts`) — exercises module-graph + subprocess/layout/ratchet/hygiene gates.
7. `bun run skill:surface:check` — baseline ran (`exit 0`); verifies `src/cli/capabilities*.ts` and `skills/ocx/` stay synchronized.
8. `bun run structure:check` — baseline ran (`exit 0`); verifies `structure/remote-link.md`, `structure/manifest.json`, and `structure/INDEX.md`.
9. `cd docs-site && bun run build` — Astro + Starlight build verifying `docs-site/` remote-link user docs.
10. `bun run privacy:scan` — baseline ran (`exit 0`); scans tracked `src/`, `gui/`, `tests/`, `docs-site/`, and `devlog/` for accidental credentials or PII.

## 8. Non-Goals, Alternatives Rejected, & Consequences

- **Rejected SFTP/SCP upload for `ocx-child` planting**: OpenSSH `scp -O` vs SFTP protocol availability varies across minimal Alpine/BusyBox containers and restricted Windows OpenSSH setups, whereas `ssh -T ... sh -c` / `-EncodedCommand` with piped `stdin` uses the exact transport already proven by `probe` and `connect --key-stdin` and works 100% air-gapped.
- **Rejected modifying `.github/workflows/` or `scripts/release.ts`**: Out of lane write scope and requires maintainer release-pipeline security sign-off; `child-binary-source.ts` cleanly supports `OPENCODEX_CHILD_BIN_DIR`, packaged sidecars, local `target/release`, and `SHA256SUMS`-verified `$OPENCODEX_HOME/cache/ocx-child/<version>/` today.
- **Rejected committing UI screenshots onto `feat/ocx-child-plant-ux`**: Prohibited by `AGENTS.md` and `tests/ci-workflows/repo-hygiene.test.ts`; screenshots are committed strictly to `origin/pr-assets` and referenced by immutable commit SHA in the PR description.

