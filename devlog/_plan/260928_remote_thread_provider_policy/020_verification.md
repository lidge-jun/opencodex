# Verification

Status: local evidence for an RFC. The probes are executable specifications that
run on demand; no CI workflow runs them, and nothing in the OpenCodex build, test,
or runtime path imports them. All inputs, accounts, tokens, thread ids, and
database rows are synthetic. No native Codex process, user home, installed
config, or real service is accessed.

## How to run

From the repository root:

```sh
cd devlog/_plan/260928_remote_thread_provider_policy/probes
python3 -m unittest -v test_native_policy test_probe
```

The socket suite needs aiohttp. Install it into a scratch directory, not the
repository or a system site-packages:

```sh
python3 -m pip install --target "$SCRATCH_DIR" aiohttp
PYTHONPATH="$SCRATCH_DIR" python3 -m unittest -v test_native_policy test_probe test_loopback_bridge
```

## Inventory

63 tests across three suites:

- 23 tests (`test_native_policy`) specify the proposed native policy: opt-out,
  trusted-origin scoping, explicit arrays, null semantics, parent/ancestor
  exceptions, immutable policy, exact ids, UUID thread-id validation, and
  synthetic paginated fixture reads.
- 29 raw-frame tests (`test_probe`) cover the relay alternative's
  ordinary/single-chunk rewrites, byte-identical pass-through, limits, and
  unsupported inputs.
- 11 localhost HTTP/WebSocket tests (`test_loopback_bridge`) use a mock host and
  mock backend, checking two-way traffic, fixture auth/headers, explicit filters,
  enrollment, unrelated HTTP, fixture endpoint restrictions, and both directions
  of close-code forwarding.

The first 52 use the Python standard library only.

The synthetic database has 5,200 `openai` rows, one `opencodex` row, and one
`other` row. Default filtering yields one; the two-id opt-in yields 5,201; all
providers yields 5,202. Page sizes 1, 37, and 1,000 are exercised. The fixture
dump hash stays unchanged after reads. This demonstrates the specification, not
native SQLite schema compatibility or actual mobile results.

## Recorded runs

| Date | Environment | Suites | Result |
| --- | --- | --- | --- |
| 2026-09-28 | author, local | native policy + raw frame | 52 passed |
| 2026-10-13 | Linux, Python 3.12.14, aiohttp 3.14.4 | all three | 63 passed |
| 2026-10-15 | macOS, Python 3.9.6, aiohttp 3.13.5 | all three | 63 passed |

Each run reflects the probe source at that time; a later edit to a probe needs a
fresh local run.

## Not executed / not established

- Native Rust implementation, compilation, config/schema generation, or native tests.
- Actual ChatGPT mobile pairing, full pagination, resume, token renewal, or reconnect.
- Production multi-segment relay support or management/security review of a relay.
