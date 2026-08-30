# 070 — Outcome

Ten pull requests landed on `dev`, two issues closed, five contributor pull requests closed as
carried or superseded, and four Windows-only defects fixed that no `push` run could have seen.

## What landed

| Merge | PR | Subject |
|---|---|---|
| `dca16949b` | #2952 | README asset check tells files from directories |
| `b95dc5d42` | #2962 | test-run lock rooted in a machine-local user runtime dir (reimplements #2949) |
| `209e9f4b9` | #2961 | drop the paragraph Antigravity Gemini 3.7 Flash rejects (closes #2899) |
| `de4e846e8` | #2966 | namespaced MCP exec must not authorize bare shell aliases (carries #2953) |
| `dd3ff4231` | #2963 | skip the Windows ACL mutation when the DACL is proven compliant (closes #1298) |
| `eeedbb6a5` | #2967 | start when proxy settings hold unconstrained values (carries #2947) |
| `d4fe9caf1` | #2964 | install gui dependencies the local runner needs (carries #2957) |
| `d760f36f1` | #2955 | one log record per empty-completion notice |
| `41d7d4c3e` | #2968 | repair three dispatch-only Windows test failures |
| `d2a802275` | #2965 | capacity panel survives an unformattable expiry (carries #2950, supersedes #2951) |

Every merge went in with its full check set green and used `--admin`, because the `dev` ruleset
requires one approving review and GitHub will not let an author approve their own pull request.

## The Windows leg was the substantive finding

`platform-windows` runs only on `workflow_dispatch`, so the push CI that gates `release.yml` covers
Linux, macOS and the gates — and nothing else. Dispatching it against `dev` surfaced four real
failures that had been accumulating invisibly:

| Test | Mechanism | Layer |
|---|---|---|
| `claude-desktop-policy` | `path.join` follows the host, so an injected `win32` platform still produced posix separators in the fixture | test, plus `path.win32.join` in the win32 branch |
| `service.test.ts` launchd/systemd unit | `systemdQuote` correctly doubles backslashes, and raw `toContain` on a host-generated path did not expect that | test |
| `autostart-health` | the Windows startup probe has a 15s deadline and the test slept 30s expecting cache expiry; the deadline fired first and returned the designed stale fallback | test, via an injected clock |
| `codex-prompt-route` | two stacked defects, below | test |

None of the four was a product defect, which is worth stating plainly: the value of the dispatch was
not that it found broken code, it is that four tests were asserting things that are false on a
platform the project supports, and every one of them was invisible to the CI that gates releases.

### The prompt-route case took two passes

Worth recording because the first fix looked correct and was not. The test wrote
`model_instructions_file = "C:\Users\..."` as raw TOML; `decodeBasicString` accepts only `\\`, `\"`
and `\n`, so `\U` was rejected, the base was classified `default`, the external file's bytes dropped
out of the probe fingerprint, and the second request joined the stale flight — exactly the behavior the
case exists to forbid.

The first fix encoded the value properly and used a posix filename containing a literal backslash. On
POSIX that is a filename character; on Windows it is a **separator**, so `external\base.md` became a
nested path whose parent directory the test never created, and the case failed with `ENOENT`. The
duration falling from 243ms to 4ms is what identified it: the test was failing earlier, not passing.

The signal generalises. A cross-platform fix verified only by simulation needs the simulation checked
against what the other platform actually does with the value, not only against what the code does with
it.

## Issue triage was mostly a negative result

Fifteen issues audited, two implemented. Four are `NEEDS_INFO` — #2885, #2813, #1527, #1419 — and each
would have meant shipping a hypothesis as product behavior. #2885 in particular reads like an
actionable P1 and is not: the report is against Bun 1.3.14, `dev` bundles 1.4.0, and the open question
is whether pinning HTTP/1.1 fixes it, which is a measurement on Windows rather than a patch decision.
Seven more are genuine features needing their own design cycles.

## The contributor-PR mechanic

Five of the eight candidates needed a repair commit. Pushing one to a fork branch resets the
`enforce-target` readiness checklist and returns the PR to draft — correctly, since that checklist is an
author attestation bound to an exact head, and it is not a maintainer's to tick. #2952 merged directly
precisely because nothing was pushed to it.

So the repairs were carried on maintainer branches by cherry-pick, which preserves author metadata, and
each original was closed with a comment naming the carrying merge and the reason. Contributors keep
authorship in `git log`; the attestation stays theirs.

## Release readiness

In scope for this unit and done: the bug-PR disposition, the two fixable issues, the Windows repairs,
and the devlog record. Out of scope and deliberately not started: promotion to `preview` or `main`,
`release.yml`, and npm publication.

One pre-existing gate note: `service-lifecycle.yml` last failed on `dev` at `824a7affd` on a macOS
launchd 20-second startup timeout, before this train began. It has since passed on two later branch
heads, and the only service-path file touched since is `src/cli/index.ts` from #2924, so it reads as a
timing flake rather than a regression. It needs a green run on the final head before promotion, which
belongs to the release train rather than to this unit.
