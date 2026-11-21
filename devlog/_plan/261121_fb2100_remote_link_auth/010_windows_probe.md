# 010 #8972: Windows Child probe answers `Windows_NT"`

Problem: `WINDOWS_OS_PROBE` is `cmd /c echo %OS%`. Win32-OpenSSH with cmd.exe as the default shell runs the exec
request as `cmd.exe /c "<command>"`. cmd keeps the surrounding quotes when the quoted string starts with a runnable
name (`cmd`), so the inner `echo` sees and prints the closing quote. Reproduced on this Windows host with verbatim
command lines (`.tmp/probe/cmdquote.ts`):

| Command line | stdout |
|---|---|
| `cmd.exe /c "cmd /c echo %OS%"` | `Windows_NT"\r\n` |
| `cmd.exe /c "cmd /c echo hello"` | `hello"\r\n` |
| `cmd.exe /c "cmd.exe /c echo %OS%"` | `Windows_NT\r\n` |
| `cmd.exe /s /c "cmd /c echo %OS%"` | `Windows_NT\r\n` |

`requireRemotePlatform` compares the whole answer with `Windows_NT`, falls back to `sh -c uname` (a localized
error on Windows), and throws a plain `Error`; `probe()` maps it to `502 probe_failed` with no hint.

Diff:

- `src/link/ssh-argv.ts`: `WINDOWS_OS_PROBE = "cmd.exe /c echo %OS%"`; comment records the quote rule.
- `src/link/remote-platform.ts`: one `isWindowsNtAnswer(line)` (`Windows_NT` with at most one trailing `"`,
  surrounding whitespace ignored) used by `confirmWindowsShell`, `requireRemotePlatform` and
  `requireRemotePlatformFramed`, so an older probe literal or a shell that still adds the quote is understood.
  Platform failures throw `SshDiagnosticError` carrying a bounded hint from the failing call's stderr.
- `src/link/ssh-runner.ts`: `SshDiagnosticError`; `sshRunnerErrorHint` reads its hint, so `probe_failed`,
  `version_probe_failed` and the other enrollment/cleanup catch sites report why.
- Tests: `tests/clients/link-ssh-argv.test.ts` (literal, parser, hint), `tests/server/link-enrollment.test.ts`
  (a quoted answer enrolls as Windows; an unknown platform answers `probe_failed` with a hint). Test fixtures that
  match the old literal follow the constant.

Verification: those two files plus the fixture files that changed, `bun run typecheck`, `bun run test:changed`.

