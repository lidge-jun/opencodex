# Phase 1: protocol

Depends on: phase 0. Source: `ba6f822cae53fcc4c91575a4c78f86f9944b6644`. Main owns implementation; tests execute only on hosted CI.

## Exact file map

| Change | Source | Destination |
| --- | --- | --- |
| NEW | [src/remote-control/protocol.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/remote-control/protocol.ts) | `src/remote-control/protocol.ts` |
| NEW | [src/remote-control/crypto.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/remote-control/crypto.ts) | `src/remote-control/crypto.ts` |
| NEW | [src/remote-control/host.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/remote-control/host.ts) | `src/remote-control/host.ts` |
| NEW | [src/remote-control/relay.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/remote-control/relay.ts) | `src/remote-control/relay.ts` |
| NEW | [src/remote-control/workspace-tools.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/remote-control/workspace-tools.ts) | `src/remote-control/workspace-tools.ts` |
| NEW | [src/remote-control/workspace-agent-protocol.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/remote-control/workspace-agent-protocol.ts) | `src/remote-control/workspace-agent-protocol.ts` |
| NEW | [src/remote-control/workspace-rpc-framing.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/remote-control/workspace-rpc-framing.ts) | `src/remote-control/workspace-rpc-framing.ts` |
| NEW | [src/remote-control/workspace-utf8.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/src/remote-control/workspace-utf8.ts) | `src/remote-control/workspace-utf8.ts` |
| NEW | [tests/remote-control-prototype.test.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/tests/remote-control-prototype.test.ts) | `tests/clients/remote-control-prototype.test.ts` |
| NEW | [tests/remote-workspace-rpc-framing.test.ts](https://github.com/lidge-jun/opencodex/blob/ba6f822cae53fcc4c91575a4c78f86f9944b6644/tests/remote-workspace-rpc-framing.test.ts) | `tests/clients/remote-workspace-rpc-framing.test.ts` |

## Transformation contract

NEW files carry the complete immutable source body. For moved tests, rewrite source imports `../src/` to `../../src/`, helper imports `./helpers/` to `../helpers/`, and obsolete fake-server paths to their current fixture owner. Register every new test in both layout.json explicit and test-layout-expected.json. Source-file reads and subprocess fixture paths use tests/helpers/repo-root.ts. Shared existing files take only source PR hunks, preserving all newer dev behavior; resolve conflicts against the named owner before writing. All original adopted implementation receives the coauthor trailer.

Create a narrow src/remote-control/index.ts exporting only the eight foundation modules. Add structure/remote-workspace.md describing the inactive protocol library; register its ownership of src/remote-control/ in structure/manifest.json and regenerate INDEX using the existing generator. No runtime activation import belongs in this layer.

Reachable negatives: forged handshake key/signature, replayed sequence, malformed relay/frame length, unknown capability, out-of-order/overlarge RPC fragments. Existing prototype/framing tests cover authentication, replay and bounds; add protocol-only cases where the split omitted coverage. Observe thrown rejection and absence of plaintext delivery in hosted CI.

## Data and enforcement chain

Required acceptance (not an established property of the pinned source): identity/capability creation comes from protocol builders and device root approval; serializers carry bounded versioned messages; strict parsers recover them; handshake/coordinator/executor consumers enforce capabilities and roots. GUI only displays public state. Tier: runtime boundary; executing surface: parser/auth/executor code. Known bypass: a process with the operator account can invoke host tools directly. Residual: local operator compromise is outside this process boundary. Wording: bounded remote tools, no claim of host-user isolation. Final layer for commands: OS confinement probe; unavailable means exec is not advertised.

## Verification and rollback

Local tests/build/typecheck/install NOT RUN by user instruction. Text comparison and git diff --check observe this change but are not product tests. Existing hosted CI command definitions are inspected before dispatch; final SHA evidence is recorded in phase 4. Revert this layer before its parent; no persistent state migrations are performed by this carry task.

## Scope decision REMOTE-ARCH-004

Retain the eight-module public source and its existing prototype tests: host.ts and relay.ts preserve author protocol coverage. These are inactive adapters. RemoteControlHost may call an explicitly supplied terminal factory only after authenticated traffic; this carry does not supply or connect a production terminal factory. Phase 1 delivers cryptographic identity primitives and protocol contracts, not complete device authorization.

## Phase-1 revalidation

Previous D: roadmap locked; continue with inactive protocol library. Base HEAD is 3d5e7037b5, source library still absent. Original eight source files and prototype/framing assertions were read; no path drift affects their self-contained dependency closure. New protocol contract tests will exercise agent codec rejection and UTF-8 byte boundaries directly. Existing clients test domain and both manifest registration maps confirmed. Structure generator is scripts/structure-ssot.ts --fix; it writes INDEX from the manifest and is permitted documentation generation, not a product build or test suite.
