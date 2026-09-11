# 001 — Live host probe evidence (Codex 0.153.2, 2026-09-07)

Research record backing the incident table in 000_plan.md. Every row was executed from this
session's own code-mode isolate (`custom_exec` → `tools.apply_patch`) against
`/Users/jun/.codex/worktrees/ec3e/opencodex/.tmp/`; scratch files were deleted afterwards.

## Binary strings

`strings -n 8` over the installed binaries under
`@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/`:

| Binary | String |
|---|---|
| `codex` | `\` expects a string input` (preceded by the tool name) |
| `codex` | `The first line of the patch must be '*** Begin Patch'` |
| `codex` | `The last line of the patch must be '*** End Patch'` |
| `codex` | `Script running with cell ID ` |
| `codex` | `Session identifier to pass to write_stdin when the process is still running.` |
| `codex` | `Bytes to write to stdin. Defaults to empty, which polls without writing.` |
| `codex-code-mode-host` | `Unsupported import in exec: ` and `unsupported import in exec` |

## apply_patch argument probes

| Argument passed to `tools.apply_patch` | Result |
|---|---|
| `{ input: "*** Begin Patch\n*** End Patch" }` | throws `tool \`apply_patch\` expects a string input` |
| `"*** Begin Patch ***\n*** Add File: …\n+z\n*** End Patch ***"` | throws `apply_patch verification failed: invalid patch: The first line of the patch must be '*** Begin Patch'` |
| `"\n*** Begin Patch\n*** Add File: …\n+x\n*** End Patch"` | accepted; file written |
| `"\n\n*** Begin Patch\n…"` | accepted; file written |
| `"  *** Begin Patch\n…"` (two-space indent) | accepted; file written |
| `"…*** End Patch\n\n"` | accepted; file written |
| a patch with two operations on the same path | throws `invalid patch: multiple operations target <path>` |
| two `*** End Patch` lines (envelope pasted twice) | throws `The last line of the patch must be '*** End Patch'` |

Conclusion carried into the wording: the host strips surrounding whitespace before checking the
marker lines, so "no leading newline" is not a rule. The rule is that the first non-blank line is
exactly `*** Begin Patch` and the last is exactly `*** End Patch`, undecorated.

## Long-running command protocol

The `exec_command` schema in this session: `yield_time_ms` "Wait before yielding output. Defaults to
10000 ms; effective range is 250-30000 ms"; `session_id` "Session identifier to pass to write_stdin
when the process is still running". `write_stdin`: `chars` "Defaults to empty, which polls without
writing"; empty polls wait 5000-300000 ms. A shell `for i in 1..20; sleep 1` inside one call
produces no error string; it simply spends the call's yield budget blocked.

## Isolate globals

The `exec` description in this session lists `exit`, `text`, `image`, `audio`, `generatedImage`,
`store`/`load`, `notify`, `setTimeout`/`clearTimeout`, `ALL_TOOLS`, `yield_control`, plus `tools.*`.
The list varies by client version, which is why the pre-call sentence names a few examples and
defers to the description rather than enumerating.

