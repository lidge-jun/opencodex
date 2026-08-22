# 000 — Windows stability: why "806/806 green" is not "stable"

Unit opened 2026-08-17, after v2.24.2 shipped.

## The gap this unit exists to close

The Windows campaign that preceded this unit took the local Bun suite from 53+
failures to 806/806 across 15 commits. That was real work on real defects — an
empty-string `LocalApplicationData`, unfinalized SQLite statements holding a
file open against unlink, TOML escapes doubling backslashes, per-process
identity lookups costing ~510ms each.

None of it proves the product is stable for a Windows user, and the reason is
structural rather than rhetorical: **the suite that went green is not a gate.**

```yaml
# .github/workflows/ci.yml:547-552
platform-windows:
  name: windows ${{ matrix.shard }}/4
  needs: select-windows-runner
  if: github.event_name == 'workflow_dispatch'
```

Windows runs only when a maintainer asks by hand. The aggregation job at
`.github/workflows/ci.yml:747-783` accepts `skipped` as an outcome, and
`.github/workflows/release.yml:181-201` requires a successful **push-event**
CI run before publishing. Since `platform-windows` always skips on push, a
release satisfies its own gate having executed zero Windows tests.

Issue #1059 tracks exactly this and is still open. Its stated end condition is
Windows restored as a required gate. The failure counts quoted there are now
stale in our favour; the workflow contract has not caught up.

## Evidence base for this unit

Three independent GPT-5 Pro audits were run on 2026-08-17 against a zip of the
v2.24.2 tree (`src/`, `tests/`, `scripts/`, `.github/`, `structure/`), each
with the GitHub connector attached and a distinct brief:

| Chat | Perspective | Conversation |
|---|---|---|
| P1 | Platform primitives: handles, locking, atomic publication, paths, ACLs | `chatgpt.com/c/6a82ebc4-48d4-83ee-a223-a6fc5a9556e5` |
| P2 | Runtime and distribution: install, spawn, service lifecycle, update, ports | `chatgpt.com/c/6a82ec28-86b4-83e8-86e4-a5477b6a9d91` |
| P3 | User-visible failure modes, diagnostics, and CI coverage | `chatgpt.com/c/6a82ec41-6b0c-83ee-93ab-3a96010a543f` |

Every finding carried into `001` was **re-verified against the working tree in
this session**. Claims that could not be reproduced locally were dropped rather
than recorded. That rule matters here because two of the three audits also
correctly identified defects as *already fixed* (#1843 elevation argv, #31
passthrough segfault) — an audit that cannot tell live from historical is not
usable as a roadmap input.

## What changed in the problem model

The pre-campaign model was "Windows has many small filesystem bugs." The
evidence no longer supports that as the dominant class. The surviving defects
cluster into three shapes:

1. **Synchronous Windows subprocesses on the request path.** `icacls` and
   PowerShell/CIM calls that block Bun's event loop. This is invisible to a
   test suite that never measures latency under concurrency.
2. **Lifecycle operations that are not transactional.** Update and native
   service migration both destroy working state before proving the replacement.
3. **Invariants enforced by prose or by a single-file test, so they drift.**
   The `-WindowStyle Hidden` case in `001` is the clearest example.

None of those three are things a per-file unit test naturally catches, which is
why 806 green files and an unhappy user base are consistent with each other.
