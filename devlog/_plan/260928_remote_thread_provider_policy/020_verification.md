# Verification

Current local check: 2026-10-02, Linux, Python 3.12.14 and aiohttp 3.13.5.
This integration preserves prior PR head
`b3ff2be3c65e84aac0ceeedb343d107359da114d` and merges trusted `dev`
`8b23fe340a53799aac5ad7654582a75df7ade7c8` without rewriting branch history.
The merge was conflict-free. Probe and workflow source is byte-identical to the
prior PR head; this follow-up updates verification metadata for that integration.
The PR difference from this `dev` snapshot remains nine research/workflow files.
All inputs, accounts, tokens, thread ids, and database rows are synthetic.
No native Codex process, user home, installed config, or real service was accessed.

From the repository root:

```sh
cd devlog/_plan/260928_remote_thread_provider_policy/probes
python3 -m unittest -v test_native_policy test_probe test_loopback_bridge
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
devlog-probes workflow added by this PR installs aiohttp as a required step (the
step fails the job if install fails) and discovers every devlog/**/probes
directory. The retained record for head `787ef30698` reports 61 hosted tests.
The later close-code regressions raised the count to 63. PR CI run `36492693336`,
job `109164783438`, is associated with head `f43e66b3`, but its checkout log records
the PR merge ref at `7b2ec3931dcd92f777a642c464d80990e7f38008`; that checked-out
merge ref passed all 63 tests. Run metadata's head SHA is not the checkout SHA.
The current local execution above independently ran all three suites. Each new
PR head needs its own associated hosted results; old runs do not attest to a new
integration commit. The workflow retains its normal merge-ref checkout behavior.

```sh
python3 -m unittest -v test_native_policy test_probe
```

The synthetic database has 5,200 `openai` rows, one `opencodex` row, and one `other`
row. Default filtering yields one; the two-id opt-in yields 5,201; all providers
yields 5,202. Page sizes 1, 37, and 1,000 are exercised. The fixture dump hash stays
unchanged after reads. This demonstrates the specification, not native SQLite
schema compatibility or actual mobile results.

## Repository checks

The current isolated Linux worktree uses repository Bun 1.4.0. These checks
passed on the integration above:

```sh
bun run typecheck
bun run structure:check
bun run privacy:scan
bun scripts/file-size-ratchet.ts
git diff --check 8b23fe340a53799aac5ad7654582a75df7ade7c8
```

The earlier Windows run (Python 3.14.3, aiohttp 3.14.3) and fixed-disk workaround
are historical environment evidence, not the environment used for this refresh.
The full local Bun suite was not rerun: this PR changes only the research unit
and probe workflow relative to `dev`, and concurrent worktrees share this
validation environment. All 63 focused probes and the applicable static gates
were run instead. Wider repository coverage remains for CI associated with the
new PR head, using the normal PR merge ref. No test budget or assertion was relaxed.

## Hosted checkpoint and review boundary

For the previous PR head `b3ff2be3c65e84aac0ceeedb343d107359da114d`, maintainer
review confirmed that probe job `110273026033` checked out merge ref `1b40f8a`
(incorporating that head into `0328373`) and ran all 63 tests successfully.
That is historical evidence; it does not attest to this new `8b23fe34` integration.
New associated run/job links, actual checkout SHA and tree must be recorded in
the PR checkpoint after those checks complete. Run metadata alone is not checkout
evidence, and no prior green result is relabeled as a new-head pass.

The 2026-10-02 maintainer response dismissed only superseded correctness requests.
It did not approve the RFC or waive independent workflow/boundary review.
The PR remains Draft pending that review and an exact-head readiness decision.

## Not executed / not established

- Native Rust implementation, compilation, config/schema generation, or native tests.
- Actual ChatGPT mobile pairing, full pagination, resume, token renewal, or reconnect.
- The full local OpenCodex Bun suite, and new current-head-associated hosted checks until that
  run completes. The earlier 52-test local run and 61-test hosted record remain
  historical evidence only.
- Production multi-segment relay support or management/security review.

The PR adds this research unit plus one workflow that runs it: devlog-probes.yml
is a new CI lane, so the executable contract now executes on the PR merge ref rather
than only locally. No executable configuration, release artifact, or native
storage is changed. Independent review remains outstanding even with green CI.
