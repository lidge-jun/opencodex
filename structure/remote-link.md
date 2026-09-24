# Remote Link

`src/link/` owns the building blocks for linking OpenCodex machines over SSH. The pure modules start no process, open no socket and schedule no timer on import.

`src/link/ssh-argv.ts` builds every OpenSSH argument vector. All commands run with BatchMode and trust only the link known_hosts file, keyed by `HostKeyAlias=<alias>`: the global file is disabled with `GlobalKnownHostsFile=none`, and `KnownHostsCommand=none`, `VerifyHostKeyDNS=no` and `CheckHostIP=no` shut out every other source of host-key trust. Command-line options take precedence over `~/.ssh/config`, so a user config cannot re-enable them. Tunnel and exec commands use `StrictHostKeyChecking=yes`; only the probe uses `accept-new`, against an empty temporary file, so an offered key can be shown before it is trusted. The known_hosts path must be absolute and free of ssh expansion syntax. Forwards bind 127.0.0.1 on both ends, and aliases that could be parsed as options are refused.

`src/link/ssh-config.ts` lists host candidates from `~/.ssh/config`. Arguments are split with the rules of OpenSSH's `argv_split`. Pattern hosts, `Match` blocks and aliases that fail the alias check produce no candidates, and only top-level `Include` directives are followed, because an include inside a `Host` or `Match` block is conditional. A candidate is an offer, not trust.

`src/link/tunnel-state.ts` is the tunnel lifecycle reducer: connecting, connected, reconnecting with capped jittered backoff, and failed for auth, host-key and forward errors or after five minutes without a connection, whether or not an attempt is in flight.

`src/link/routes.ts` holds the one route and method table for linked traffic; the hub-link listener and the client relay both decide admission from it.

`src/link/store.ts` persists link records in `<configDir>/link/links.json` with private permissions. Records hold aliases, ports, confirmed host-key fingerprints and data-key ids, never keys. The file is a trust boundary: unknown fields, malformed values and duplicate ids are errors, and `hasLinks` reports false for a damaged file. A null host-key fingerprint is accepted only for a client-initiated link, because the hub never opens SSH to that client.

## Client link transport

A client connected with `transport: "link"` reaches its hub through an SSH tunnel instead of a public origin. Its `serverUrl` and `managementUrl` are both `http://127.0.0.1:<link.tunnelPort>`, and `ocx connect --link --key-stdin` accepts the data key on bounded standard input instead of issuing one over HTTP. The key is stored only in the service token file and is sent on readiness, catalog, hub-state and usage reads. Codex keeps routing to the client's own `http://localhost:<port>`, with WebSockets forced off, and `src/client/link-relay.ts` forwards exactly the `linkRouteAllowed` routes from `src/link/routes.ts` through the tunnel. The relay adds no credential, rejects upgrades, keeps the hub-relay header and body bounds, streams SSE with caller-abort propagation and a 300-second idle limit, and answers 503 with Retry-After while the tunnel is down. Link mode binds the configured port or fails to start, turns the management relay off, and refuses key rotation and revocation, which belong to the hub.

Regression coverage lives in `tests/clients/link-ssh-argv.test.ts`, `tests/clients/link-ssh-config.test.ts`, `tests/clients/link-tunnel-state.test.ts`, `tests/clients/link-store.test.ts`, `tests/clients/link-boundary.test.ts`, `tests/clients/link-routes.test.ts`, `tests/clients/client-link-connect.test.ts`, `tests/clients/client-link-relay.test.ts`, `tests/clients/client-link-runtime.test.ts` and `tests/codex-integration/injection-link-websocket.test.ts`.
