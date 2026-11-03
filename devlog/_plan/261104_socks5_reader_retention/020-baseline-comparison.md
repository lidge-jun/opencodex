# Baseline comparison of the 66 captured failures

## Result and scope

The original `test:changed --parallel=2 --timeout 60000` attempt exceeded its
900-second lane budget. Its partial output contained 66 failure lines; it was
not a completed suite with only 66 failures.

All 66 named failures were matched against fresh executions of their 15 files:
64 now pass on both trees with proxy variables removed from test subprocesses;
the other two fail on both trees. Each tree reports **307 pass / 2 fail** across
those files. There are **no HEAD-only failures in this comparison**. The existing
SOCKS5 regression set separately passes **77 / 0** in the same clean environment.
No additional runtime fix was indicated by this comparison.

- Unmodified upstream base: `bc11b07de5148f6a00ac6465a3aafaaf107e6f89`.
- Tested PR code: `e819d6a22c2e0d216c9f2a56a9f6bd5beaee0398`.
- Both checkouts were clean, with frozen dependencies and pinned Bun 1.4.4 on
  the same Windows host. Production installation and service state were untouched.
- Each file ran in a fresh process from its checkout root, base then HEAD,
  using `bun test ./tests/providers/<file> --timeout 60000`. The repository
  preload and home/service guards remained enabled. No assertion or test-defined
  timeout was changed. The outer diagnostic watchdog was 180 seconds per file;
  it did not fire.
- Only test-child `ALL_PROXY`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and their
  lowercase aliases were removed; no persisted proxy configuration was changed.

## File matrix

Counts are pass / fail for the complete file, not just the original failures.
All paths below are under `tests/providers/`.

| File | Original failure lines | Base | PR |
|---|---:|---:|---:|
| `aistupidlevel-provider.test.ts` | 2 | 16 / 0 | 16 / 0 |
| `alibaba-token-plan-responses-optin.test.ts` | 3 | 27 / 0 | 27 / 0 |
| `alibaba-token-plan-wire-defaults.test.ts` | 9 | 27 / 0 | 27 / 0 |
| `claude-cli-client-http.test.ts` | 1 | 0 / 1 | 0 / 1 |
| `codebuddy-mcp-server.test.ts` | 1 | 4 / 1 | 4 / 1 |
| `command-code-credit-rotation.test.ts` | 2 | 2 / 0 | 2 / 0 |
| `command-code-plan-denial.test.ts` | 7 | 21 / 0 | 21 / 0 |
| `command-code-provider.test.ts` | 1 | 61 / 0 | 61 / 0 |
| `command-code-quota.test.ts` | 11 | 14 / 0 | 14 / 0 |
| `command-code-tool-text.test.ts` | 1 | 40 / 0 | 40 / 0 |
| `deepseek-image-files.test.ts` | 3 | 17 / 0 | 17 / 0 |
| `deepseek-inbound-wire.test.ts` | 17 | 41 / 0 | 41 / 0 |
| `deepseek-quota-currency.test.ts` | 6 | 6 / 0 | 6 / 0 |
| `deepseek-responses-item-id-repair.test.ts` | 1 | 7 / 0 | 7 / 0 |
| `dsh-account.test.ts` | 1 | 24 / 0 | 24 / 0 |
| **Total** | **66** | **307 / 2** | **307 / 2** |

## Proxy environment control

The representative `command-code-quota` case named
`maps billing credits windows plus subscription-scoped spend into quota`
failed with the same `expected length 1, received 0` on both base and PR when
inheriting the host proxy environment. On the PR, removing only the proxy
variables made that same single case pass. In the subsequent clean-environment
file runs it also passed on base, completing the base/PR control.

The shared code explains the environment sensitivity: `scripts/test.ts`
`createIsolatedTestEnvironment` preserves proxy variables;
`src/lib/proxy-env.ts` `configuredOutboundFetch` reads inherited SOCKS
`ALL_PROXY` and can call `socks5Fetch` directly instead of the test's replaced
`globalThis.fetch`. The quota and provider paths use that selector. The original
log included empty mock capture arrays and authentication/permission responses
instead of the fixture's responses. None of these environment-selection paths
changed in this PR.

The 64 recovered failures span 13 provider files. The individual proxy A/B
experiment establishes the mechanism for the representative case; the matched
clean-environment results and shared call paths support the broader environment
attribution. We did not rerun all 64 with inherited external proxies, and do not
claim a separate one-variable experiment for every case. Per-file execution also
removes cross-file contention from the original parallel run.

For a clean-environment reproduction, run this from either checkout root and
repeat with the file paths in the matrix. This launcher changes only the child
environment and still loads the repository's ordinary test preload:

```sh
bun -e 'const env = { ...process.env }; for (const key of Object.keys(env)) if (/^(all|https?|no)_proxy$/i.test(key)) delete env[key]; const result = Bun.spawnSync([process.execPath, "test", process.argv[1], "--timeout", "60000"], { env, stdout: "inherit", stderr: "inherit" }); process.exit(result.exitCode);' ./tests/providers/command-code-quota.test.ts
```

## Two failures reproduced on the unmodified base

**CodeBuddy compiled executable:** both trees fail at the existing
`compiled.exitCode === 0` assertion before executing the generated binary.
Repeating its core `bun build --compile` command with captured stderr produces:

```text
error: failed to copy bun executable into temporary file: ENOENT
```

The same host/runtime also fails to compile a one-line `console.log` entry with
that error, after successfully bundling its single module. This isolates the
observed failure from the SOCKS5 source and MCP protocol. It does not identify
why executable copying fails on this host, nor establish a general Bun/platform
bug. No compiler/runtime workaround was added to this transport PR.

**Claude CLI client HTTP:** both trees hit the test's own 20-second limit
(approximately 20.01 seconds), despite the CLI's default 60-second budget.
The original run and clean PR run also report a late child-close assertion with
four closed children out of five. The test covers several real local fixture
subprocesses and abort cleanup. Its underlying timing/cleanup cause has not been
fully diagnosed; reproducing its timeout on the unmodified base is sufficient
to establish that this observed failure does not require the SOCKS5 patch.
No timeout was raised, assertion removed, or test skipped.

## Validation boundary

This is a complete accounting of the **66 captured failures**, not a green full
suite or a repeat of the entire interrupted changed-test selection. It does not
rule out every order-dependent regression. The two baseline failures remain
open validation limitations, and hosted cross-platform CI remains separately
subject to upstream approval. Raw logs, machine paths, proxy values, accounts,
request contents and heap snapshots are not included in this note.
