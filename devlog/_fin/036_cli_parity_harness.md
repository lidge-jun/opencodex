# Issue #36 — CLI parity harness

Date: 2026-09-06
Status: DONE

The ADR-0008 Go migration now has a subprocess differential harness in
`tests/go-cli-parity.test.ts`. It builds `go/cmd/ocx` with `CGO_ENABLED=0`,
runs the TypeScript and Go CLIs with the same argv and isolated
`OPENCODEX_HOME`, and compares stdout, stderr, and exit status byte-for-byte
for Go-owned version aliases and ready usage failures. The table also names
`status` and `config show` as TS-only until their Go implementations exist, so
the matrix records the incomplete surface rather than treating it as parity.

The harness is part of the Go CI job's differential-oracle step alongside the
existing sidecar oracle. It skips only when a local developer has no Go
toolchain; CI installs Go before executing it.

The Go CLI was aligned with the TypeScript contract for full help, command help,
unknown-command output/exit status, health output, and ready parser status
messages. `skills/ocx` is generated solely from the TypeScript capability
registry and has no Go-specific surface, so no generated skill file changed.

Verification: `go test ./...`; `bun test tests/go-cli-parity.test.ts`;
`bun run typecheck`; `bun run test`.
