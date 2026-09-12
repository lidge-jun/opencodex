# Remote Workspace protocol

`src/remote-control/` is an inactive protocol library. Importing it registers no HTTP route, opens no connection and starts no process or timer. Existing Remote Hub provider routing remains in `src/remote/` and is a separate capability.

`src/remote-control/protocol.ts` owns versioned frame, identity and capability contracts. `src/remote-control/crypto.ts` uses Ed25519 signatures, P-256 ephemeral agreement and directional AES-GCM counters. `src/remote-control/workspace-agent-protocol.ts` bounds and parses control envelopes. `src/remote-control/workspace-tools.ts` describes the remote tool namespace and capability mapping.

`src/remote-control/workspace-rpc-framing.ts` fragments logical messages and bounds reassembly size, count and expiry. Expiry timers exist only after explicit incomplete-fragment acceptance. `src/remote-control/workspace-utf8.ts` bounds text without splitting surrogate pairs.

`src/remote-control/host.ts` accepts an explicitly supplied terminal factory. Authenticated application traffic can invoke that factory; no production factory is supplied here. `src/remote-control/relay.ts` forwards opaque envelopes after its caller authorizes the peer. Neither adapter is wired into server startup.

The public exports in `src/remote-control/index.ts` expose only this foundation. Device enrollment, executor operations and UI activation are not part of this layer. Tests in `tests/clients/remote-control-prototype.test.ts`, `tests/clients/remote-workspace-rpc-framing.test.ts` and `tests/clients/remote-workspace-protocol.test.ts` cover the protocol contracts; they do not prove platform command confinement.
