# Native main profile implementation candidate

Date: 2026-08-01

Branch: `feat/656-native-main-profiles`

This increment turns the design spike into a CLI/backend-only implementation candidate. It adds an
OS-keyring-backed encrypted vault, restricted official-login staging, a home-scoped transaction
lock, encrypted switch journal for OpenCodex process-exit recovery, exact-byte auth replacement
and rollback, explicit recovery, and confirmed `__main__` runtime reconciliation.

The version 1 recovery scope is an OpenCodex process exit after a transaction file has been
published by rename. It does not claim durability across an OS or kernel crash or sudden power
loss. `atomicWriteFileAsync()` does not `fsync` either the file or its parent directory.

The management API carries profile labels, generated profile IDs, and staging IDs only. It never
accepts or returns auth envelopes, access tokens, refresh tokens, raw account IDs, or decrypted
payloads. All routes remain behind the existing local management origin and update-token gate.

The candidate intentionally excludes dashboard UI, Pool-to-native credential conversion, native
process termination, non-file Codex credential stores, and plaintext key fallbacks.

Required publication evidence:

- Focused native-profile and CLI tests on packaged Bun 1.3.14 and Bun 1.4 canary.
- Full typecheck and privacy scan.
- Security diff review covering key custody, journal integrity, rollback failure, process detection,
  management authorization, secret redaction, and task/history preservation.
