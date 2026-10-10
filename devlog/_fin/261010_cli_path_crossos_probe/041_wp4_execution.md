# 041 — wp4 execution: two fix PRs, two issues, closeout

Stale check: `origin/dev` 93ed1a40b4; none of the files below changed since `d17a9f2239`. Neither test file is in
`tests/fixtures/file-size-baseline.json`. `gh` is unauthenticated and `git push` has no credential on this Mac, so
branches, commits and PRs are created through the GitHub connector (blob → tree → commit on the `dev` head →
`create_branch` at that commit → `create_pull_request` to `dev`), from local commits made in lane worktrees.

## PR 1 — F5: real-shell evidence test survives system rc output

Lane worktree `.tmp/lanes/f5-real-shell-markers` (inside this worktree), branch `codex/real-shell-test-markers` from
`origin/dev`. MODIFY `desktop/src-tauri/src/cli_command_posix.rs` in `real_shell_selects_desktop_shim_on_temp_home`:

```diff
-                let output = command
-                    .args(["-i", "-c", "command -v ocx; ocx hello"])
+                // System rc files may print (Ubuntu's /etc/bash.bashrc sudo hint); only marked lines count.
+                let output = command
+                    .args([
+                        "-i",
+                        "-c",
+                        "printf 'OCX-PATH:%s\\n' \"$(command -v ocx)\"; printf 'OCX-OUT:%s\\n' \"$(ocx hello)\"",
+                    ])
                     .output()
                     .expect("cannot start real shell");
                 assert!(output.status.success(), "{shell}: command failed");
                 let stdout = String::from_utf8(output.stdout).expect("shell stdout is not UTF-8");
-                let lines: Vec<_> = stdout.lines().collect();
+                let marked = |tag: &str| stdout.lines().filter_map(|l| l.strip_prefix(tag)).collect::<Vec<_>>();
+                let (paths, outputs) = (marked("OCX-PATH:"), marked("OCX-OUT:"));
                 // Keep captured system-rc output and temporary HOME paths out of failure logs.
                 assert!(
-                    lines.len() == 2,
-                    "{shell}: expected exactly two stdout lines"
+                    paths.len() == 1 && outputs.len() == 1,
+                    "{shell}: expected exactly one marked path and one marked output line"
                 );
                 assert!(
-                    lines[0] == expected_path.to_str().unwrap(),
+                    paths[0] == expected_path.to_str().unwrap(),
                     "{shell}: command resolution selected the wrong executable"
                 );
-                assert!(lines[1] == expected_output, "{shell}: wrong CLI output");
+                assert!(outputs[0] == expected_output, "{shell}: wrong CLI output");
```

(final layout per `cargo fmt`). Verification: on lidge (Ubuntu, sudo-group user, the failing case) and on this Mac
(zsh + bash), `cargo test --manifest-path desktop/src-tauri/Cargo.toml cli_command_posix::tests::real_shell_selects_desktop_shim_on_temp_home -- --ignored --exact --nocapture`
must pass (lidge failed before with `expected exactly two stdout lines`); `cargo fmt --check` and
`cargo clippy --all-targets -- -D warnings` for the desktop crate (CI stubs as in ci.yml:1567-1573); plain
`cargo test ... cli_command` stays green. Activation: lidge's `/etc/bash.bashrc` sudo hint is the scenario; the
test only passes there if the extra stdout line is ignored.

## PR 2 — F6: Windows preflight assertions follow the env-indirect path rendering

Lane worktree `.tmp/lanes/f6-preflight-test-paths`, branch `codex/preflight-tests-env-indirect-paths`.

- MODIFY `tests/codex-integration/codex-shim-runtime-preflight.test.ts`: import
  `windowsEnvIndirectBatchValue` from `../../src/lib/win-paths`; add
  `const renderedRuntimePath = () => windowsEnvIndirectBatchValue(runtime.path, value => value);` with a one-line
  comment (wrappers write profile paths as `%LOCALAPPDATA%`/`%USERPROFILE%` tokens, `src/lib/win-paths.ts`); lines 86
  and 111 change `toContain(runtime.path)` → `toContain(renderedRuntimePath())`.
- MODIFY `tests/service/service-runtime-preflight.test.ts`: same import; line 120
  `toContain(runtime.path)` → `toContain(windowsEnvIndirectBatchValue(runtime.path, value => value))`.

The rendered value equals `runtime.path` when no indirection variable prefixes it (macOS, Linux, CI's tool-cache Bun),
so the assertions keep their meaning there and become correct for a Bun under the profile. The identity escape is
enough because `process.execPath` contains none of `% ^ "`; a comment says so.

Verification: on mini (Windows, Bun under `%USERPROFILE%\.bun` — the failing case), `bun test
tests/codex-integration/codex-shim-runtime-preflight.test.ts tests/service/service-runtime-preflight.test.ts` with
isolated homes → 0 fail (was 3 fail); same two files on this Mac → 0 fail; `bun run typecheck`.

## Issues

| Issue | Template | Content |
|---|---|---|
| I1 Windows Desktop supervision (F2, F4) | `feature_request.yml` headings (Area, What are you trying to accomplish?, What prevents this today?, What should OpenCodex do?, Example usage or interface, Alternatives or workarounds, Additional context, Checks) | 029 W7/W8 evidence: `supervisor: unsupported` with the Win32 parent/child facts, status/doctor service advice, which #6802/#6809 paths stay inert; proposal: Windows process-identity proof (parent PID, both image paths in the install directory, session, creation time, two agreeing snapshots) feeding `inspectDesktopSupervision`; F4 as a related follow-up (name the Desktop CLI in launcher failure text off macOS: Windows `InstallLocation`, Linux deb `/usr/bin/ocx` only when it is the package's ELF) |
| I2 `machine-path-conflict` false positive (F7) | `bug_report.yml` headings (Client or integration, Area, Summary, Reproduction, Version, Operating system, Provider and model, Logs or error output, Screenshots and supporting files, Redacted configuration, Checks) | 029 W3/W4/W5 evidence; proposed direction: read `PATH` from `CreateEnvironmentBlock(token, NULL, FALSE)` and test whether any entry before the Desktop entry holds `ocx.{exe,com,cmd,bat}` |

Issue bodies are drafted in scratch (`.tmp/issues/`), contain no account data, and are created with the connector.

## Closeout (wp4 C/D)

1. Independent Sol review of both PR diffs (exact head) and of 019/029/040; record the verdict and rounds.
2. Exact-head CI for both PRs observed through the connector; Windows shards do not run on ordinary PR CI, so mini's
   run is the Windows evidence for PR 2 (stated in the PR).
3. Remove mini's `%TEMP%\ocx-probe-261010` and any lidge leftovers; final host table in 049.
4. 049_outcome.md: findings matrix summary, PR/issue links, heads, CI runs, reverts. The devlog unit itself is
   published as a third, docs-only PR from this branch (`codex/cli-path-crossos-probe`).

## Architect consultation (Sol 01a1229a-dfe4, proposal written before reading this doc)

| ID | Proposal | Disposition |
|---|---|---|
| P1 | Sentinel-prefixed result lines; capture each command and keep its failure status; shared bash/zsh syntax; reject `.hushlogin` (changes the tested environment) and stderr redirection (the hint is on stdout) | accepted; the `-c` script becomes `p=$(command -v ocx) \|\| exit 11; o=$(ocx hello) \|\| exit 12; printf 'OCX-PATH:%s\\nOCX-OUT:%s:OCX-END\\n' "$p" "$o"`, so a failing lookup or CLI still fails `status.success()`; final #6851 head `d785fb1b02` also requires `outputs[0] == format!("{expected_output}:OCX-END")`, so an extra CLI output line fails the comparison |
| P2 | Expected value from `windowsEnvIndirectBatchValue`; assert the complete `set "OCX_BUN=..."` line; keep the frozen-runtime and `unprobed.exe` checks | accepted; the three assertions check `set "OCX_BUN=<rendered>"` (the shim and the service script both emit that line), using the test-local `batchValue` escape for the literal suffix (see audit item 1) |
| P3a | Feature issue for Windows supervision with the observed trigger, the proof shape, `unknown` on inconclusive evidence; PATH-only handoff stays separate; F4 related, Linux needs deb-vs-npm-symlink distinction | accepted as I1 |
| P3b | Bug issue for F7; desired behaviour is fresh-logon PATH evaluation; validate `CreateEnvironmentBlock(FALSE)` against real new terminals before choosing it; no speculative PR | accepted as I2 (wording: candidate direction, to be validated) |
| P4 | No issue for F1; keep the observation and capture the lock holder on recurrence | accepted |

Reflection: the proposal and this plan match on every decision; the only amendments are the two concrete P1/P2 forms
above.

## Audit (independent Sol, 01a1229c-7b16): NEAR-PASS → dispositions

1. PR2 expected values use a test-local `batchValue` that applies the generators' own suffix escaping
   (`%` → `%%`, `^` → `^^`, drop `"`; `src/codex/shim-templates.ts:170`, `src/service/windows-taskxml.ts:14`) through
   `windowsEnvIndirectBatchValue(runtime.path, batchValue)`, and assert the complete `set "OCX_BUN=..."` line. The
   frozen-runtime and `unprobed.exe` checks stay.
2. Issues use `### <field label>` sections in form order, with the dropdown value or text under each, and the form's
   labels (`bug` / `enhancement`). The forms define no `title:` prefix; titles follow the repository convention
   (`[Bug] ...` / `[Feature]: ...`). `enforce-issue-quality` detects the kind from content and validates the body
   (`.github/scripts/issue-quality-core.cjs` `detectIssueKind`, `validateIssueBody`), not the submission route. Each
   PR body fills Summary, Verification and Checklist from `.github/PULL_REQUEST_TEMPLATE.md` with the host evidence.
3. Closeout step 1 records the actual review verdict and its round count rather than presupposing PASS; PR1's Rust
   literal keeps `\\n` and plain `||`.

## Audit round 2 (01a1229c-7b16): NEAR-PASS, one residual → rebuttal

The forms define no title prefix; the bug form adds the `bug` label and the feature form `enhancement`. Titles follow
the repository's existing convention (`[Bug] ...`, `[Feature]: ...`, e.g. #6720, #3191).

Residual: AGENTS.md asks agents to open issues through the template chooser. Issue forms can only be submitted through
the web UI and `gh` is unauthenticated here, so the issues are created through the GitHub connector with the body the
form would render (same `### <label>` sections in form order, dropdown values from the form's options, the Checks
section) and the form's label. `enforce-issue-quality` validates exactly those headings and labels; the deviation is
the submission route only, and each issue's closeout row says it was created through the API with a form-identical body.
