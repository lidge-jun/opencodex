# Cycle 1 Record

## Scope

This cycle creates the shared plan folder only. Runtime behavior changes are reserved for Cycle 2.

## Recorded Threads

### #62 Cursor native execution

Cursor server-driven built-in native execution bypasses Codex approval and sandbox semantics when executed directly by opencodex. The current local patch makes built-in fs/shell/fetch execution fail closed unless `unsafeAllowNativeLocalExec` is explicitly enabled, with `allowNativeLocalExec` kept as a deprecated transition alias.

Key files:

- `src/adapters/cursor/native-exec.ts`
- `src/adapters/cursor/native-exec-fs.ts`
- `src/adapters/cursor/native-exec-shell.ts`
- `src/adapters/cursor/native-exec-network.ts`
- `tests/cursor-native-exec.test.ts`

### #63 WSL Codex Desktop home

The WSL/Desktop path patch centralizes Codex home resolution so Linux shells can discover the Windows Codex Desktop home when appropriate, while preserving ordinary Linux `CODEX_HOME` behavior.

Key files:

- `src/codex-home.ts`
- `src/codex-paths.ts`
- `src/doctor.ts`
- `tests/doctor.test.ts`

### Ubuntu systemd unit-not-found

Observed error:

```text
Command failed: systemctl --user start opencodex-proxy
Failed to start opencodex-proxy.service: Unit opencodex-proxy.service not found.
```

Initial RCA: `installSystemd()` writes the unit and runs `daemon-reload`, `enable`, and `restart`, but `startSystemd()` directly calls `systemctl --user start opencodex-proxy` without checking whether the unit file exists first.

Cycle 2 will patch this to fail with an opencodex-owned instruction before shelling out.

