# Remote Link

`src/link/` owns the building blocks for linking OpenCodex machines over SSH. In this release it contains pure modules only: importing them starts no process, opens no socket and schedules no timer. Nothing on the server, CLI or dashboard path imports them yet.

`src/link/ssh-argv.ts` builds every OpenSSH argument vector. All commands run with BatchMode and trust only the link known_hosts file, keyed by `HostKeyAlias=<alias>`: the global file is disabled with `GlobalKnownHostsFile=none`, and `KnownHostsCommand=none`, `VerifyHostKeyDNS=no` and `CheckHostIP=no` shut out every other source of host-key trust. Command-line options take precedence over `~/.ssh/config`, so a user config cannot re-enable them. Tunnel and exec commands use `StrictHostKeyChecking=yes`; only the probe uses `accept-new`, against an empty temporary file, so an offered key can be shown before it is trusted. The known_hosts path must be absolute and free of ssh expansion syntax. Forwards bind 127.0.0.1 on both ends, and aliases that could be parsed as options are refused.

`src/link/ssh-config.ts` lists host candidates from `~/.ssh/config`. Arguments are split with the rules of OpenSSH's `argv_split`. Pattern hosts, `Match` blocks and aliases that fail the alias check produce no candidates, and only top-level `Include` directives are followed, because an include inside a `Host` or `Match` block is conditional. A candidate is an offer, not trust.

`src/link/tunnel-state.ts` is the tunnel lifecycle reducer: connecting, connected, reconnecting with capped jittered backoff, and failed for auth, host-key and forward errors or after five minutes without a connection, whether or not an attempt is in flight.

`src/link/store.ts` persists link records in `<configDir>/link/links.json` with private permissions. Records hold aliases, ports, confirmed host-key fingerprints and data-key ids, never keys. The file is a trust boundary: unknown fields, malformed values and duplicate ids are errors, and `hasLinks` reports false for a damaged file. A null host-key fingerprint is accepted only for a client-initiated link, because the hub never opens SSH to that client.

Regression coverage lives in `tests/clients/link-ssh-argv.test.ts`, `tests/clients/link-ssh-config.test.ts`, `tests/clients/link-tunnel-state.test.ts`, `tests/clients/link-store.test.ts` and `tests/clients/link-boundary.test.ts`.
