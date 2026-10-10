# Windows synchronous runtime-selection control

This optional Rust control exercises `GET /v1/models` in a separate Bun process
using the repository's unchanged `tests/helpers/native-main-owner-child.ts`.
It does not connect to a running proxy, install accounts, or replay turns.
It is a reproducer, not a runtime fix or proof of a historical production cause.

The child gets a cleared environment, synthetic homes, fixed fixture-only
authentication values, and an ephemeral loopback listener. It is configured
with no real credentials and one unavailable loopback provider. Other network
egress is not blocked or audited.

```powershell
cargo test --locked --manifest-path scripts/diagnostics/windows-version-control/Cargo.toml --test async_contracts -- --test-threads=4
cargo clippy --locked --manifest-path scripts/diagnostics/windows-version-control/Cargo.toml --all-targets -- -D warnings
cargo build --locked --release --manifest-path scripts/diagnostics/windows-version-control/Cargo.toml
& <target>/release/ocx-version-control.exe <absolute-bun.exe> <absolute-repo> <new-absolute-fixture-root> <absolute-node_modules> [cumulative|pipe] | Out-String
```

Use the shared Cargo gate and an isolated target directory where required by
your environment. Check the actual executable exit code after the output pipe.
The fixture root must not already exist. Bun must support `--no-env-file`,
`--no-orphans`, and CPU profiling. A startup/profile flag failure is not evidence
of the catalog stall. This control has only been executed on Windows.

The fake Codex executables initially return their version and bundled catalog
immediately. After a successful model-list warmup and a 16-second memo-expiry
wait, the controller arms the chosen mode and sends one model-list request:

- `cumulative`: three version candidates take 7.5 seconds each; the first two
  return unrecognized versions and the last returns a valid version. This tests
  accumulation across synchronous candidates rather than one overlong process.
- `pipe`: each version launcher prints a valid version, starts a 25-second
  descendant inheriting stdout, and exits. This tests whether the per-candidate
  timeout remains bounded while EOF is delayed. Different spellings of a path
  and the bare fallback can resolve to the same executable; count the attempts
  from `fake-events.jsonl`, not from the number of copied files.

The root starts suspended, is assigned to a kill-on-close Windows Job, and is
then resumed. Only this root and its descendants are terminated at cleanup.
The controller retains its process handle and creation time, checks initial
and final health identity, and measures two sequential 20-second health probes.
It records the failed I/O stage and error kind, without preserving the OS error
number. A read-stage failure does not establish that zero bytes arrived.
Two probes alone do not establish the exact beginning and end of a stall.

Private output includes `health-samples.jsonl`, `result.json`, synthetic child
stderr, `opencodex/fake-events.jsonl`, and `version.cpuprofile`.
The final result is written after successful shutdown, so inspect samples and
fake events even when the executable fails before publishing it. A successful
executable exit is not an automatic assertion that a long stall occurred:
inspect the actual health outcomes, model-list status, fake sequence, and CPU
call chain. Keep profiles and fixture artifacts private; publish bounded scalar
results and repository-relative function names instead.

To compare installed source with the repository fixture, use a separately owned
scratch mirror containing a byte-identical copy of the helper and package
metadata, with `src` and `node_modules` links to the desired installation.
The fixture must perform no writes to that installation. Links alone do not
enforce read-only access. Verify the profile's source module paths and source
hashes, and describe the fixture version and source version separately.
Remove only the mirror's own links during cleanup; never recurse into targets.

## Regression assertions

Pass --expect-responsive after the mode to expire both memos (61 seconds), observe health for 45 seconds during armed probes, and require matching 200 health, responsive model-list output, stable fixture model identities and successful fixture shutdown. --pin-change additionally writes a valid explicit selection during an armed version probe and requires its bytes to remain unchanged. The public list in this credential-free fixture contains its local provider row; model identity stability alone does not prove native bundled publication. The separate Rust-driven Bun contracts cover bundled source priority and publication.

The assertion cases use no real AI, accounts or production listener. A success verifies this isolated path, not the original production stall or a persistent leak. The descendants are finite-lived and contained in the root Job; this is not a test of arbitrary production orphan cleanup.

The module contracts run by default on Linux, macOS and Windows with a portable Rust fake Codex executable. Bun must be installed on PATH; OCX_CATALOG_TEST_BUN and OCX_CATALOG_TEST_REPO can override the executable and repository. Defaults resolve the Bun executable before clearing the child environment and derive the repository from Cargo's manifest location. No ignored tests or real credentials are required. The Windows-only synchronous liveness controller remains separate. The catalog-async-contracts workflow runs these real Bun-module contracts on affected pushes and pull requests as well as manual dispatch.

The abort-lifetime contract uses synthetic response bodies whose cancellation remains pending. Both Responses and the shared HTTP finalizer release owned translator budgets on an already-aborted signal, a later abort, or explicit cancellation, while a live response retains its budget and successful EOF preserves bytes and response metadata.

Abort finalization changes accounting only; transports retain producer cancellation and terminal precedence. Prepared 200, 499 and 504 bodies remain unchanged.

The async executor contract waits for a real child to install its signal handler before abort or deadline. Caller-facing rejection remains prompt while an independent reaper owns actual exit; on POSIX the SIGTERM-ignoring child is still alive at rejection and must exit after escalation. Windows exercises the same owner with native termination.
