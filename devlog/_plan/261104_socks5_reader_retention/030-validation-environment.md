# Resolving the two baseline validation blockers

## Bun executable location

The pinned Bun 1.4.4 executable failed `build --compile` when the executable's
own absolute path contained non-ASCII characters. A minimal entry containing
only `console.log` reproduced executable-copy `ENOENT`.

A controlled location matrix used byte-identical binaries (SHA-256 checked):

| Executable location/form | Entry/output location | Result |
|---|---|---|
| Original npm executable under non-ASCII path | ASCII | ENOENT |
| Ordinary copied executable under non-ASCII path | ASCII | ENOENT |
| Ordinary copied executable under ASCII path | Non-ASCII | Pass |
| Ordinary copied executable under ASCII path | ASCII | Pass |

This separates executable location from hard-link installation and entry/output
location. It is a local observation on this pinned runtime, not a claim about
all Bun releases. No compiler flags, dependencies or installed production
runtime were changed. Validation uses the identical binary from an ASCII
scratch path. The original CodeBuddy MCP file then completed **5 pass / 0 fail**
with the existing assertions and an explicit CLI default budget of 60 seconds.

## Claude HTTP fixture teardown

Relative-time probes established that client abort reached the local server in
approximately 5 milliseconds. Two earlier tool-turn completions each blocked
for approximately 7.2 seconds. A minimal real-child experiment using the same
Windows `taskkill /PID <owned fixture> /T /F` operation took 7.557 seconds while
a 10-millisecond event-loop heartbeat made no progress. Multiple synchronous
OS tree scans consumed the HTTP test's 20-second budget.

The HTTP fixture creates a single synthetic CLI process with no descendants.
The test now supplies the adapter's existing `killWindowsProcessTree` hook,
looks up the PID in its own `ownedChildren` collection, refuses any unknown PID,
and terminates that real child. It still exercises the real HTTP request,
streaming abort, child exit/close and PID-disappearance assertions. The explicit
20-second test limit and the adapter's 5-second timeout are unchanged.

This isolates the HTTP contract from the host's tree-scan cost. It does not fix
or hide a production implementation change: production process-tree handling
is untouched. The separate CodeBuddy adapter case checks Windows tree-dispatch
through a mock hook; neither that case nor this HTTP fixture is claimed as a
real descendant-tree cleanup test.

Validation retained a negative control: making the injected termination a no-op
caused the unchanged close-count assertion to fail (three closed children out
of five). Restoring the terminating hook made the HTTP/tool-capture/CodeBuddy
adapter set complete **56 pass / 0 fail**, 178 assertions; the HTTP test took
about 2.15 seconds. Diagnostic timing code was removed before the final run.

## Final affected regression

With child proxy variables removed and the same pinned binary at an ASCII path,
this completed run reports **441 pass / 0 fail / 0 skip / 0 errors**, 41,679
assertions, across 22 files (97 seconds in the test lane). This includes all 15
files containing the original 66 failures, the five SOCKS lifecycle files, and
the two additional Claude/CodeBuddy adapter files. No fixture or assertion was
skipped to obtain this result.

Run from the checkout root with the pinned runner; `bun` below denotes that
runner. The repository wrapper/preload and home/service guards remain enabled.
Proxy variables are absent only in the invocation's child environment.

```sh
bun scripts/test.ts --parallel=4 --timeout 60000 \
  ./tests/providers/aistupidlevel-provider.test.ts \
  ./tests/providers/alibaba-token-plan-responses-optin.test.ts \
  ./tests/providers/alibaba-token-plan-wire-defaults.test.ts \
  ./tests/providers/claude-cli-client-http.test.ts \
  ./tests/providers/codebuddy-mcp-server.test.ts \
  ./tests/providers/command-code-credit-rotation.test.ts \
  ./tests/providers/command-code-plan-denial.test.ts \
  ./tests/providers/command-code-provider.test.ts \
  ./tests/providers/command-code-quota.test.ts \
  ./tests/providers/command-code-tool-text.test.ts \
  ./tests/providers/deepseek-image-files.test.ts \
  ./tests/providers/deepseek-inbound-wire.test.ts \
  ./tests/providers/deepseek-quota-currency.test.ts \
  ./tests/providers/deepseek-responses-item-id-repair.test.ts \
  ./tests/providers/dsh-account.test.ts \
  ./tests/lib/socks5-reader-lifecycle.test.ts \
  ./tests/lib/socks5-timeout-cleanup.test.ts \
  ./tests/lib/socks5-fetch.test.ts \
  ./tests/lib/socks5-tls-lifecycle.test.ts \
  ./tests/lib/socks5-upload-lifecycle.test.ts \
  ./tests/providers/claude-cli-tool-capture.test.ts \
  ./tests/providers/codebuddy-adapter.test.ts
```

The CLI default budget is 60 seconds; explicit test-level budgets still apply,
including the unchanged Claude HTTP 20-second limit. Typecheck also passed for
2,310 files. The final note and diff were checked for privacy and whitespace;
no file-size cap was raised.

## Full-run resource exception and observed failures

A full local attempt used `bun scripts/test.ts --timeout 60000` with the same
clean child environment and ASCII runner. Its default four-worker main lane
exceeded the repository's 900-second bound and exited **124** after about 904
seconds. The partial output has **2,224 pass / 28 fail / 48 skip lines**; these
are not a completed suite summary, and the later serial lanes were not reached.
The full local suite is **not passing** and is not represented as passing.

To account for its observed failures rather than dismiss them, the seven files
below were rerun together, base then PR, with the same pinned runner, environment,
`--parallel=4`, `--timeout 60000`, and wrapper/preload. The base is
`bc11b07de5148f6a00ac6465a3aafaaf107e6f89`; the PR runtime is unchanged from
`e819d6a22c2e0d216c9f2a56a9f6bd5beaee0398`, plus only the fixture isolation above.

| File | Base pass/fail/skip | PR pass/fail/skip |
|---|---:|---:|
| `tests/clients/link-diagnostics.test.ts` | 5 / 3 / 1 | 5 / 3 / 1 |
| `tests/lib/spend-ledger-owner.test.ts` | 23 / 9 / 2 | 26 / 6 / 2 |
| `tests/clients/link-pinned-sync-argv.test.ts` | 2 / 1 / 12 | 3 / 0 / 12 |
| `tests/clients/link-tunnel-history.test.ts` | 5 / 0 / 0 | 4 / 1 / 0 |
| `tests/clients/remote-workspace-server.test.ts` | 9 / 0 / 0 | 9 / 0 / 0 |
| `tests/codex-integration/active-turn-disconnect.test.ts` | 24 / 1 / 0 | 25 / 0 / 0 |
| `tests/oauth/key-login-live-update.test.ts` | 0 / 1 / 0 | 0 / 1 / 0 |
| **Total** | **68 / 15 / 15** | **72 / 11 / 15** |

Both runs additionally reported **1 unhandled error**, the same late key-login
assertion receiving `unavailable/unattested-target` instead of `reloaded`.
Neither subset run passed. Counts use Bun's completed summaries, not duplicated
failure lines from its end-of-run recap.

The failure families are bounded diagnostic flushing, child-readiness/version
probe deadlines, server lifecycle timeouts and subsequent cleanup/state errors.
For example, the full active-turn run timed out before later cases reported
spend-owner home conflicts; the smaller base/PR runs did not reproduce that
whole cascade. These are timing- and ordering-sensitive observations, not proof
that all full-run failures have identical causes.

Three cases initially failed only on PR in the comparable subset. A separate
three-case recheck on both trees gave base **1 pass / 2 fail** and PR **2 pass /
1 fail**:

- `filesystem and clock failures never escape the sink` also failed on base.
- `a retained shared ledger refuses mutation after its final lease releases`
  also failed on base, then passed on PR.
- `the diagnostics file keeps only the fixed tunnel fields` passed on both
  smaller rechecks. Its failing subset run returned after approximately 1,008ms
  with trailing expected records missing. `createLinkDiagnosticSink.flush()`
  explicitly returns after at most one second without promising persistence,
  while this case immediately reads the file. The unmodified baseline's two
  existing blocked-Windows-ACL tests pass and independently verify that flush
  may return before writes finish. This supports a timing-sensitive persistence
  assertion; it does **not** claim the exact tunnel failure was reproduced on
  baseline.

The three-case recheck selected those names with `-t` in the same three files
and the same wrapper/parallelism. The separate baseline contract command was:

```sh
bun scripts/test.ts ./tests/clients/link-diagnostics.test.ts --parallel=1 --timeout 60000 -t 'slow Windows ACL work yields and bounds the queue'
```

It reports **2 pass / 0 fail**. No unrelated runtime or test assertion was
changed to make these broader Windows cases pass.

The full-suite resource exception in `AGENTS.md` and `MAINTAINERS.md` is used
for review readiness: the complete Windows run was impractical within its
bounded lane, actual changed behavior is covered by the completed 441-test
selection, and observed failures were investigated against the unmodified base
and relevant timing contracts. Broader whole-suite, ordering and hosted-platform
coverage remains with CI. Required current-head CI must succeed before merge;
fork workflow approval remains an upstream responsibility. This is not a claim
of a green full suite or absence of every possible regression.

Raw probe/test logs, machine paths, proxy values, process IDs, request contents
and heap snapshots remain local.
