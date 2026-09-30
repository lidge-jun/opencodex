# Verification

Current local check: 2026-09-30, Linux, Python 3.12.14 and aiohttp 3.13.5.
The branch incorporates `dev` at `592c5cfc043cd5b69e8aea0f12b9a0644cc50612`.
Probe source is unchanged from `f43e66b395b82b05620bc1bdbf8eb332af16b116`;
this follow-up corrects verification metadata after integrating current `dev`.
All inputs, accounts, tokens, thread ids, and database rows are synthetic.
No native Codex process, user home, installed config, or real service was accessed.

From the repository root:

```sh
cd devlog/_plan/260928_remote_thread_provider_policy/probes
python -m unittest -v test_native_policy test_probe test_loopback_bridge
```

**Current inventory and local execution: 63 tests, 0 failures, across three suites.**

- 23 tests specify the proposed native policy: opt-out, trusted-origin scoping,
  explicit arrays, null semantics, parent/ancestor exceptions, immutable policy,
  exact ids, UUID thread-id validation, and synthetic paginated fixture reads.
- 29 retained raw-frame tests cover the relay alternative's ordinary/single-chunk
  rewrites, byte-identical pass-through, limits, and unsupported inputs.
- 11 localhost HTTP/WebSocket tests use a mock host and mock backend,
  checking two-way traffic, fixture auth/headers, explicit filters, enrollment,
  unrelated HTTP, fixture endpoint restrictions, and both directions of close-code
  forwarding.

The 23 + 29 offline tests use the Python standard library only. The 11 socket tests
need aiohttp; no production dependency manifest is changed.

Historical author-local execution on 2026-09-28 covered the 52 standard-library tests
(test_native_policy + test_probe); the socket suite was not part of that recorded
run. The then-current socket inventory was 9 tests. The
devlog-probes workflow added by this PR installs aiohttp deterministically (the
step fails the job if install fails) and discovers every devlog/**/probes
directory. The retained record for head `787ef30698` reports 61 hosted tests.
The later close-code regressions raised the count to 63: exact-head CI run
`36492693336`, job `109164783438`, executed all 63 successfully at `f43e66b3`.
The current local execution above independently ran all three suites. New-head
hosted evidence must be checked separately; old hosted runs do not attest to a
new integration commit.

```sh
python -m unittest -v test_native_policy test_probe
```

The synthetic database has 5,200 `openai` rows, one `opencodex` row, and one `other`
row. Default filtering yields one; the two-id opt-in yields 5,201; all providers
yields 5,202. Page sizes 1, 37, and 1,000 are exercised. The fixture dump hash stays
unchanged after reads. This demonstrates the specification, not native SQLite
schema compatibility or actual mobile results.

## Repository checks

The current Linux checkout supports the repository checks; the earlier DNS/Bun
availability limitation no longer describes this environment. Typecheck,
structure, privacy and file-size checks are recorded with the current PR
checkpoint. The full Bun suite was not rerun for this research-only integration:
the complete 63-case probe set is the focused behavioral scope, and wider
repository coverage remains for exact-head CI. No test budget was relaxed.

## Not executed / not established

- Native Rust implementation, compilation, config/schema generation, or native tests.
- Actual ChatGPT mobile pairing, full pagination, resume, token renewal, or reconnect.
- The full local OpenCodex Bun suite, and new exact-head hosted checks until that
  run completes. The earlier 52-test local run and 61-test hosted record remain
  historical evidence only.
- Production multi-segment relay support or management/security review.

The PR adds this research unit plus one workflow that runs it: devlog-probes.yml
is a new CI lane, so the executable contract now executes on exact head rather
than only locally. No executable configuration, release artifact, or native
storage is changed. Independent review remains outstanding even with green CI.
