# Codex Desktop compatibility

## Explicit restart

`ocx system codex-restart` requests a full Codex app and app-server restart through
the management endpoint. `src/cli/capabilities.ts` and `src/cli/system-command.ts`
warn that unsaved drafts, picker selections and pending approvals may be lost.
The unconfirmed path sends no restart request; JSON output preserves refused outcomes.

Under the test preload's `OCX_TEST_HOME_GUARD=1`,
`src/codex/desktop-app-restart.ts` skips real restart without an injected executor.
`src/cli/restart-scope.ts` reports that skip. `NODE_ENV=test` alone does not control
this boundary. `tests/clients/desktop-app-restart.test.ts` covers the contract.

## Windows launch context

`src/codex/desktop-app/windows.ts` captures an already active loopback compatibility
PAC from the main package process. Helpers cannot override it and conflicting main
processes refuse before termination. No other process arguments are carried forward.
Captured command lines stay internal, outside restart results and diagnostic logs.

`src/codex/desktop-compatibility/windows-package-command.ts` validates the canonical
loopback URL shape, rechecks the discovered package manifest, activates with
`IApplicationActivationManager`, and verifies the package identity and actual PAC
argument. Normal launches keep the existing AppsFolder route. A standalone compatibility
launch refuses an already running app; it never quits an app or installs a watcher.
`tests/clients/desktop-compatibility-launch.test.ts` covers restart integration and the
real Windows parser/COM service without launching the user's app.

## Certificate persistence

`src/codex/desktop-compatibility/certificate-store.ts` is a separately callable store
for a 30-day authority constrained to `chatgpt.com`, with IP exclusions. An explicit
feature-owned directory and lifecycle lease protect one atomic envelope. Its public
certificate is bound to a CurrentUser-DPAPI-protected private payload.

Reopening reuses the same key and fingerprint. Corrupt, foreign-user and expired state
refuses instead of silently replacing a trusted identity. Renewal is reported within
the last seven days. The store does not register certificates, start listeners, enable
compatibility settings or change the running app. Management enable/disable and renewal
remain a separate integration layer.

`src/codex/desktop-compatibility/windows-key-protection.ts` uses trusted PowerShell
and bounded stdin/stdout, never command-line secrets or plaintext fallback. CurrentUser
protects against other OS identities, not another process using the same credentials.
`tests/clients/desktop-compatibility-authority.test.ts` covers persistence, refusal,
and a real Windows DPAPI round trip with synthetic data.
