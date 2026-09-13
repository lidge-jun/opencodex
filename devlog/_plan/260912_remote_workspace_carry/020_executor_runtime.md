# Phase 2: executor_runtime

Depends on: phase 1. Source: `ba6f822cae53fcc4c91575a4c78f86f9944b6644`. Main owns implementation; tests execute only on hosted CI.

## Exact file map

| Change | Source | Destination |
| --- | --- | --- |
| NEW | [native/remote-workspace-helper/Cargo.lock](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/native/remote-workspace-helper/Cargo.lock) | `native/remote-workspace-helper/Cargo.lock` |
| NEW | [native/remote-workspace-helper/Cargo.toml](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/native/remote-workspace-helper/Cargo.toml) | `native/remote-workspace-helper/Cargo.toml` |
| NEW | [native/remote-workspace-helper/src/main.rs](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/native/remote-workspace-helper/src/main.rs) | `native/remote-workspace-helper/src/main.rs` |
| NEW | [native/remote-workspace-helper/src/protocol.rs](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/native/remote-workspace-helper/src/protocol.rs) | `native/remote-workspace-helper/src/protocol.rs` |
| NEW | [native/remote-workspace-helper/src/sandbox/macos.rs](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/native/remote-workspace-helper/src/sandbox/macos.rs) | `native/remote-workspace-helper/src/sandbox/macos.rs` |
| NEW | [native/remote-workspace-helper/src/sandbox/mod.rs](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/native/remote-workspace-helper/src/sandbox/mod.rs) | `native/remote-workspace-helper/src/sandbox/mod.rs` |
| NEW | [native/remote-workspace-helper/src/sandbox/windows.rs](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/native/remote-workspace-helper/src/sandbox/windows.rs) | `native/remote-workspace-helper/src/sandbox/windows.rs` |
| NEW | [native/remote-workspace-helper/tests/live_confinement.rs](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/native/remote-workspace-helper/tests/live_confinement.rs) | `native/remote-workspace-helper/tests/live_confinement.rs` |
| NEW | [src/cli/remote-workspace.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/cli/remote-workspace.ts) | `src/cli/remote-workspace.ts` |
| MODIFY | [src/remote-control/index.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/remote-control/index.ts) | `src/remote-control/index.ts` |
| NEW | [src/remote-control/workspace-agent-connection.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/remote-control/workspace-agent-connection.ts) | `src/remote-control/workspace-agent-connection.ts` |
| NEW | [src/remote-control/workspace-claude-runtime.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/remote-control/workspace-claude-runtime.ts) | `src/remote-control/workspace-claude-runtime.ts` |
| NEW | [src/remote-control/workspace-codex-runtime.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/remote-control/workspace-codex-runtime.ts) | `src/remote-control/workspace-codex-runtime.ts` |
| NEW | [src/remote-control/workspace-codex-sandbox.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/remote-control/workspace-codex-sandbox.ts) | `src/remote-control/workspace-codex-sandbox.ts` |
| NEW | [src/remote-control/workspace-command-runner.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/remote-control/workspace-command-runner.ts) | `src/remote-control/workspace-command-runner.ts` |
| NEW | [src/remote-control/workspace-coordinator.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/remote-control/workspace-coordinator.ts) | `src/remote-control/workspace-coordinator.ts` |
| NEW | [src/remote-control/workspace-device.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/remote-control/workspace-device.ts) | `src/remote-control/workspace-device.ts` |
| NEW | [src/remote-control/workspace-executable.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/remote-control/workspace-executable.ts) | `src/remote-control/workspace-executable.ts` |
| NEW | [src/remote-control/workspace-executor.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/remote-control/workspace-executor.ts) | `src/remote-control/workspace-executor.ts` |
| NEW | [src/remote-control/workspace-hub.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/remote-control/workspace-hub.ts) | `src/remote-control/workspace-hub.ts` |
| NEW | [src/remote-control/workspace-pi-runtime.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/remote-control/workspace-pi-runtime.ts) | `src/remote-control/workspace-pi-runtime.ts` |
| NEW | [src/remote-control/workspace-process.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/remote-control/workspace-process.ts) | `src/remote-control/workspace-process.ts` |
| NEW | [src/remote-control/workspace-rpc.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/remote-control/workspace-rpc.ts) | `src/remote-control/workspace-rpc.ts` |
| NEW | [src/remote-control/workspace-runtime.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/remote-control/workspace-runtime.ts) | `src/remote-control/workspace-runtime.ts` |
| NEW | [src/remote-control/workspace-sessions.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/remote-control/workspace-sessions.ts) | `src/remote-control/workspace-sessions.ts` |
| NEW | [src/remote-control/workspace-tool-bridge.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/remote-control/workspace-tool-bridge.ts) | `src/remote-control/workspace-tool-bridge.ts` |
| NEW | [tests/remote-workspace-agent-wire.test.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/tests/remote-workspace-agent-wire.test.ts) | `tests/clients/remote-workspace-agent-wire.test.ts` |
| NEW | [tests/remote-workspace-app-server.integration.test.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/tests/remote-workspace-app-server.integration.test.ts) | `tests/clients/remote-workspace-app-server.integration.test.ts` |
| NEW | [tests/remote-workspace-claude.integration.test.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/tests/remote-workspace-claude.integration.test.ts) | `tests/clients/remote-workspace-claude.integration.test.ts` |
| NEW | [tests/remote-workspace-cli-runtimes.test.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/tests/remote-workspace-cli-runtimes.test.ts) | `tests/clients/remote-workspace-cli-runtimes.test.ts` |
| NEW | [tests/remote-workspace-cli.test.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/tests/remote-workspace-cli.test.ts) | `tests/clients/remote-workspace-cli.test.ts` |
| NEW | [tests/remote-workspace-codex-runtime.test.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/tests/remote-workspace-codex-runtime.test.ts) | `tests/clients/remote-workspace-codex-runtime.test.ts` |
| NEW | [tests/remote-workspace-command-runner.test.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/tests/remote-workspace-command-runner.test.ts) | `tests/clients/remote-workspace-command-runner.test.ts` |
| NEW | [tests/remote-workspace-device.test.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/tests/remote-workspace-device.test.ts) | `tests/clients/remote-workspace-device.test.ts` |
| NEW | [tests/remote-workspace-hub.test.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/tests/remote-workspace-hub.test.ts) | `tests/clients/remote-workspace-hub.test.ts` |
| NEW | [tests/remote-workspace-linux-confinement.test.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/tests/remote-workspace-linux-confinement.test.ts) | `tests/clients/remote-workspace-linux-confinement.test.ts` |
| NEW | [tests/remote-workspace-platform.test.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/tests/remote-workspace-platform.test.ts) | `tests/clients/remote-workspace-platform.test.ts` |
| NEW | [tests/remote-workspace-sessions.test.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/tests/remote-workspace-sessions.test.ts) | `tests/clients/remote-workspace-sessions.test.ts` |
| NEW | [tests/remote-workspace-tool-bridge.test.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/tests/remote-workspace-tool-bridge.test.ts) | `tests/clients/remote-workspace-tool-bridge.test.ts` |
| NEW | [tests/remote-workspace.test.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/tests/remote-workspace.test.ts) | `tests/clients/remote-workspace.test.ts` |
| MODIFY | [src/lib/windows-atomic-replace.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/lib/windows-atomic-replace.ts) | `src/lib/windows-atomic-replace.ts` |
| MODIFY | [tests/fake-codex-server.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/tests/fake-codex-server.ts) | `tests/fake-codex-server.ts` |
| NEW | [tests/fixtures/fake-claude-stream.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/tests/fixtures/fake-claude-stream.ts) | `tests/fixtures/fake-claude-stream.ts` |
| MODIFY | [package.json](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/package.json) | `package.json` |
| MODIFY | [.gitignore](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/.gitignore) | `.gitignore` |
| MODIFY | [.npmignore](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/.npmignore) | `.npmignore` |

## Transformation contract

NEW files carry the complete immutable source body. For moved tests, rewrite source imports `../src/` to `../../src/`, helper imports `./helpers/` to `../helpers/`, and obsolete fake-server paths to their current fixture owner. Register every new test in both layout.json explicit and test-layout-expected.json. Source-file reads and subprocess fixture paths use tests/helpers/repo-root.ts. Shared existing files take only source PR hunks, preserving all newer dev behavior; resolve conflicts against the named owner before writing. All original adopted implementation receives the coauthor trailer.

Expand the public module exports to the immutable source index (plus any omitted workspace-runtime export only when a consumer requires it). Keep workspace-runtime lazily constructed and unattached to the core. Export win atomic-replace helper only if current owner remains unexported. Preserve newer package metadata and add only native source packaging entries/helper script names. Native source and lockfile are carried; no workflow modification is authorized.

Reachable negatives: unapproved root and traversal; symlink/hardlink alias; changed helper digest; absent confinement provider; cancelled pending RPC; offline executor with no local fallback; revoked token; expired/used pairing code; rate-limit threshold. Runtime session/fake-provider tests exercise interruption/reconnect and cleanup. Existing final hosted suite is the executable verifier. Native OS confinement not run by existing workflows stays an explicit unmet acceptance item.

## Data and enforcement chain

Required acceptance (not an established property of the pinned source): identity/capability creation comes from protocol builders and device root approval; serializers carry bounded versioned messages; strict parsers recover them; handshake/coordinator/executor consumers enforce capabilities and roots. GUI only displays public state. Tier: runtime boundary; executing surface: parser/auth/executor code. Known bypass: a process with the operator account can invoke host tools directly. Residual: local operator compromise is outside this process boundary. Wording: bounded remote tools, no claim of host-user isolation. Final layer for commands: OS confinement probe; unavailable means exec is not advertised.

## Verification and rollback

Local tests/build/typecheck/install NOT RUN by user instruction. Text comparison and git diff --check observe this change but are not product tests. Existing hosted CI command definitions are inspected before dispatch; final SHA evidence is recorded in phase 4. Revert this layer before its parent; no persistent state migrations are performed by this carry task.

## Session contract adaptation

The executor endpoint receives explicit immutable sessionId, rootId and granted capabilities from the session owner. The agent connection constructs these options from the selected session and accepted capability set. The RPC boundary compares each request with that binding before invoking file or command tools. Test constructors provide the same explicit bindings; negative fixtures cover each mismatch and capability reduction. Keep detailed review evidence in ignored scratch.

## Design reflection amendments

REMOTE-ARCH-001/002: Add required per-session capabilities to HubAgentConnection.openSession; initial SessionService.create and ensureRemoteTransport pass their session capability subset. The signed hello carries that subset; accepted.hello.capabilities is copied into endpoint state. Selected root is conveyed by authenticated WSS under the explicitly trusted paired Hub; endpoint snapshots rootId and sessionId and validates locally approved root before session acceptance. Encrypted requests must match session/device/root and tool capability. Zero-executor-invocation negatives vary each independently, including an otherwise-approved second root. No opaque untrusted relay is introduced for workspace control frames.

REMOTE-ARCH-003: Separate persisted enrollment capabilities from current connection availability. Presence may reduce effective connection authority but cannot expand the enrollment grant. Preserve the enrollment set in persisted device state, compute public effective capabilities as its intersection with current connection capabilities, and intersect new presence before acknowledgement. Device advertisement and acknowledgement accept reduced capabilities. Test downgrade, reconnect restoration inside grant, and attempted expansion beyond grant.

REMOTE-ARCH-006: Use existing required private-file/Windows ACL primitives for new identity and bearer stores. Check permission setup failures and refuse loading/saving secrets when enforcement fails. Do not change global config-store behavior. Record exact selected existing helper in phase-2 P after reading the owner; no best-effort function is accepted as proof.

REMOTE-ARCH-007: Codex real App Server tests depend on OCX_CODEX_BIN; Claude real integration on OCX_CLAUDE_BIN; Pi on OCX_PI_BIN. The Linux confinement case can return without execution unless OCX_REQUIRE_LINUX_REMOTE_WORKSPACE_CONFINEMENT=1 or bwrap is available. Current generic CI alone does not prove those paths. Mock tests prove lifecycle and tool-routing contracts only; native Hub isolation and executor confinement stay explicit final acceptance gaps when not activated. For each adapter separately record denied local tools, inherited plugins/hooks/config, offline refusal and teardown; inspect source plus hosted mocks, no claims of live CLI confinement from flags alone.
