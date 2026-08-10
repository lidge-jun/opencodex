# Native main profile design-spike validation

Date: 2026-08-01

Branch: `experiment/656-native-profile-design`

## Validated artifact

The executable part of this spike is intentionally limited to the pure interrupted-switch recovery decision model in:

- `src/codex/native-profile-recovery.ts`
- `tests/native-profile-recovery.test.ts`

The model has no filesystem, credential, network, encryption, process-control, or runtime-state side effects.

## Runtime matrix

| Runtime | Exact revision | Focused tests | Typecheck |
| --- | --- | --- | --- |
| OpenCodex packaged Bun | `1.3.14+0d9b296af` | 18 passed, 0 failed | Passed |
| User-selected Bun 1.4 canary | `1.4.0-canary.1+5f65d3785` | 18 passed, 0 failed | Passed |

The canary executable reports the display version `1.4.0`; `bun --revision` confirms the exact canary build above.

## Commands

```powershell
& $packagedBun test tests/native-profile-recovery.test.ts
& bun test tests/native-profile-recovery.test.ts

& $packagedBun install --frozen-lockfile
& $packagedBun run typecheck
& bun run typecheck
```

The frozen install resolved 101 packages and did not require a lockfile update.

## Covered recovery decisions

Each journal phase was checked against exact and changed source/target observations:

- `prepared`
- `auth-replaced`
- `vault-committed`

The tests prove these pure decisions:

- A confirmed source identity converges to source ownership.
- A confirmed target identity before vault commit completes target ownership.
- A confirmed target identity after vault commit finalizes runtime reconciliation.
- An unreadable or otherwise unconfirmed auth state requires manual recovery and publishes no runtime transition.
- A third identity requires manual recovery and publishes no runtime transition.
- A changed digest with the expected identity follows the identity-safe recovery branch rather than overwriting an external refresh blindly.

## Recovery and durability scope

The hard-exit matrix covers an OpenCodex process exiting after each transaction file has been
published by rename. Version 1 does not claim durability across an OS or kernel crash or sudden
power loss. In particular, `atomicWriteFileAsync()` does not `fsync` either the file or its parent
directory. The validated claim is deterministic recovery from the published transaction phase
that a subsequent OpenCodex process can observe.

## Implemented validation surface

This document began as a pure decision-model spike. The implementation branch now includes and
exercises:

- A fail-closed native OS-keyring provider and full-fidelity encrypted profile envelopes.
- Effective credential-store mode resolution and restricted official Codex login staging.
- Home-scoped interprocess locking, exact-byte auth replacement, read-back, and restoration.
- Encrypted switch-journal persistence and idempotent recovery after an OpenCodex process exit.
- Native Codex process quiescence, `__main__` request drain, and confirmed runtime transition.
- Failure injection for ACL, rename, read-back, vault commit, restoration, and journal corruption.
- Byte-preservation checks for task/history and unrelated credential stores.

The focused suites cover these paths with mocked failure seams and real subprocess exits. They do
not widen the recovery and durability scope documented above.

## Remaining publication evidence

- Hosted cross-platform CI and live keyring smoke where each platform credential store is available.
- Manual end-to-end staged login, account switch, and required Codex client restart on supported desktops.
- Final integration with current `dev` and resolution of maintainer review feedback before ready-for-review status.
