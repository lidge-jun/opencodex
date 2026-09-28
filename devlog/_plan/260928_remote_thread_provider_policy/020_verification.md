# Verification

Date: 2026-09-28. Environment: Python 3.13.5, aiohttp 3.13.3, Linux.
All inputs, accounts, tokens, thread ids, and database rows are synthetic.
No native Codex process, user home, installed config, or real service was accessed.

From the repository root:

```sh
cd devlog/_plan/260928_remote_thread_provider_policy/probes
python -m unittest -v test_native_policy test_probe test_loopback_bridge
```

**Inventory: 61 tests across three suites.**

- 23 tests specify the proposed native policy: opt-out, trusted-origin scoping,
  explicit arrays, null semantics, parent/ancestor exceptions, immutable policy,
  exact ids, UUID thread-id validation, and synthetic paginated fixture reads.
- 29 retained raw-frame tests cover the relay alternative's ordinary/single-chunk
  rewrites, byte-identical pass-through, limits, and unsupported inputs.
- 9 retained localhost HTTP/WebSocket tests use a mock host and mock backend,
  checking two-way traffic, fixture auth/headers, explicit filters, enrollment,
  unrelated HTTP, and fixture endpoint restrictions.

The 23 + 29 offline tests use the Python standard library only. The 9 socket tests
need aiohttp; no production dependency manifest is changed.

Author-local execution on 2026-09-28 covered the 52 standard-library tests
(test_native_policy + test_probe); the socket suite was not part of that recorded
run. Hosted exact-head execution is authoritative for the remaining 9: the
devlog-probes workflow added by this PR installs aiohttp deterministically (the
step fails the job if install fails) and discovers every devlog/**/probes
directory. On head 787ef30698 the hosted unittest job ran all 61 tests with 0
failures.

```sh
python -m unittest -v test_native_policy test_probe
```

The synthetic database has 5,200 `openai` rows, one `opencodex` row, and one `other`
row. Default filtering yields one; the two-id opt-in yields 5,201; all providers
yields 5,202. Page sizes 1, 37, and 1,000 are exercised. The fixture dump hash stays
unchanged after reads. This demonstrates the specification, not native SQLite
schema compatibility or actual mobile results.

## Not executed / not established

- Native Rust implementation, compilation, config/schema generation, or native tests.
- Actual ChatGPT mobile pairing, full pagination, resume, token renewal, or reconnect.
- OpenCodex Bun typecheck, full suite, structure gate, or repository privacy gate:
  Bun and a full checkout are unavailable in the execution environment. A git
  checkout attempt failed at DNS resolution. Focused Python tests are not a
  substitute for required repository gates; the PR must remain draft.
- Production multi-segment relay support or management/security review.

The PR adds this research unit plus one workflow that runs it: devlog-probes.yml
is a new CI lane, so the executable contract now executes on exact head rather
than only locally. No executable configuration, release artifact, or native
storage is changed. Independent review remains outstanding even with green CI.
