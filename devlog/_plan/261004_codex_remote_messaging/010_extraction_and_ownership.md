# 010 — extraction and source ownership

## Source identities

Destination: upstream `dev` `a47a1b52a94ef3d65d8435944bd4e6bf34a2e622`.
Source reference: local `feat/claude-messaging`, including completed direct-RPC
hardening at `a665128c3`. This is responsibility-based extraction and narrow
rewriting, not a whole-commit cherry-pick or a copy of the deployed subsystem.

## Extraction decisions

| Responsibility | Contribution |
| --- | --- |
| Enrollment | Strict JSON state and SSH stdio control; explicit enable on both nodes, directional capabilities, recoverable transaction and local-first revocation. No mesh or auto-enable. |
| SSH | Reuse unchanged Remote Link argv/fingerprint/environment policy; messaging owns separate known_hosts and -L/-R children. |
| Bridge | Codex-only mutual-proof gateway, small RPC whitelist, projected metadata, bounded aggregate admission. No cross-harness/runtime feature imports. |
| Runtime | New explicit foreground owner with shared cancellation and accounting; no supervisor, proxy startup activation or automatic retries. |
| Send | Extend integrated same-connection direct queue RPC through a narrow authenticated socket attachment seam. Preserve the Unix-only local factory. |
| Envelope | Optional machine metadata and exact remote reply host; descriptive sender identity does not grant authority. |
| Fixtures | Standalone isolated native/SSH fixtures, not the broader experiment's fixtures. |

## Current ownership and paths

- `structure/remote-messaging.md` owns remote modules and CLI lifecycle/contracts.
- `structure/local-messaging.md` preserves local-only default and queue semantics.
- `structure/cli-management.md` accounts for explicit remote command dispatch.
- `structure/decisions/ADR-6480-remote-messaging-owner.md` records provisional
  foreground ownership. The manifest and generated structure index register it.
- `src/link/ssh-argv.ts`, `fingerprint.ts` and SSH environment policy remain
  unchanged and shared; messaging does not enroll Remote Link or reuse provider keys.
- `src/messaging/remote-process.ts` adds cancellation/join behavior the existing
  link runner does not expose. It does not silently change Remote Link behavior.
- `src/messaging/rpc.ts` accepts a caller-authenticated connected socket only
  through `attach`. Its local `connect` still refuses network URLs.
- `src/cli/message-command.ts` imports remote runtime only after pure syntax
  validation. Local commands without a host do not read remote state.
- English public CLI reference, registry, capabilities, help and generated
  operating surface describe implemented commands, not proposed HTTP routes.
- New tests are registered in both layout manifests. The contained test-temp
  directory now explicitly uses 0700 to honor private socket/store fixtures.

No source dependency/process graph or exhaustive downstream audit is claimed.
Callbacks, subprocesses, source-oracle guards and native contracts require explicit
regression coverage rather than import-graph coverage alone.
