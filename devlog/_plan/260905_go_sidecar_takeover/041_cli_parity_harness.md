# 041 — Ticket #36: CLI parity harness

Unit: `260905_go_sidecar_takeover`
Date: 2026-09-06
Ticket: [#36](https://github.com/waxiangzi/opencodex/issues/36) (spec #5: CLI parity harness)
Blocked-by (#35): merged — Go CLI scaffold + local HTTP transport landed on `dev-go`.

## Scope discipline

A reusable subprocess differential harness lives in
`tests/go-cli-parity.test.ts`. It builds `go/cmd/ocx` with `CGO_ENABLED=0`, runs
the TypeScript and Go CLIs with the same argv and an isolated `OPENCODEX_HOME`,
and compares stdout, stderr, and exit status byte-for-byte for Go-owned version
aliases, help, unknown-command, health, and ready paths. Live cases use a
shared local HMAC-attested loopback fixture; health's PID is normalized
narrowly because TS liveness deliberately returns an unkillable PID as `null`
while Go validates the attested PID. The matrix also names `status` and
`config show` as TS-only rows until their Go implementations exist, recording
the incomplete surface rather than treating it as parity.

The harness runs in the Go CI job's differential-oracle step alongside the
existing sidecar oracle. It skips only when a local developer has no Go
toolchain; CI installs Go before executing it.

The Go CLI observable surface was aligned with the TypeScript contract for full
help, command help, unknown-command output/exit status, health output, and
ready parser status messages. `skills/ocx` is generated solely from the
TypeScript capability registry and has no Go-specific surface, so no generated
skill file changed.

## Verification

`go test ./...`; `bun test tests/go-cli-parity.test.ts` (23 pass);
`bun run typecheck`; full `bun run test` suite.
