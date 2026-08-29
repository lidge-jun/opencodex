# 140 — #2884: match the shim's launcher backups, and only those

Contributor PR #2884 reported a real defect with `ps` output from an affected host. This
completes it. The plan below is the second version: an independent audit rejected the
first, and the rejection was correct.

## Scope

IN: `src/codex/app-server-processes.ts` (`isCodexExecutableToken`,
`WINDOWS_CODEX_BASENAME_CANDIDATE_RE`), `tests/codex-app-server-processes.test.ts`.

OUT: the shim itself, and `.ps1` process-shape support beyond admitting the basename —
proving a PowerShell launcher's real command line needs a Win32 reproduction.

## The defect

`backupPathFor` (`src/codex/shim.ts`) renames the original launcher when the autostart
shim installs, inserting `.opencodex-real` before the extension. On a shimmed host the
running process is

```text
/home/ubuntu/.local/bin/codex.opencodex-real -c features.code_mode_host=true app-server --listen unix://
```

`isCodexExecutableToken` admitted `codex`, `codex.exe`, `codex.cmd` and target triples,
so `ocx sync --restart-codex` matched nothing, reported zero processes stopped, and left
app-servers alive holding stale in-memory model catalogs.

## What the first plan got wrong

It claimed `backupPathFor` also produces target-triple backups such as
`codex-x86_64-unknown-linux-gnu.opencodex-real`, and proposed stripping an optional
`.opencodex-real` segment before the existing checks so any stem would match.

Both halves were wrong.

**The triple case is unreachable.** Unix discovery accepts only a PATH entry named
`codex`. Windows discovery refuses a real `codex.exe` outright and targets `codex.cmd`,
`codex.ps1` and the extensionless Git-Bash launcher. Nothing hands a triple-named binary
to `backupPathFor`.

**The normalisation would have been unsafe.** Stripping the suffix before
`CODEX_TARGET_TRIPLE_BASENAME_RE` turns `codex-report-generator-worker.opencodex-real`
into a syntactically valid triple, making an unrelated process a kill target. In a code
path whose job is sending SIGTERM, widening the matcher to be tidy is the wrong trade.

## The fix

An exact basename set, kept separate from the triple pattern rather than folded into it.

`.ps1` is added because `findWindowsCodexTargets` shims `codex.ps1` alongside
`codex.cmd`, and #2884 omitted it. `.exe` is kept as breadth, not as an observed shape:
current installation refuses to rename a native `codex.exe`, so matching that name costs
nothing while missing one leaves a process alive.

The Windows prefilter's optional suffix goes where `backupPathFor` writes it — after the
stem, before the extension. #2884 placed it before the triple, which admits
`codex.opencodex-real-x86_64-pc-windows-msvc.exe`: a name nothing produces, paying
GetOwner for it. The regex source is embedded into PowerShell, so every addition stays
within plain character classes that .NET reads identically.

## Verification

Named mutations, each observed red:

- Backups not admitted at all — the reported command line fails.
- Reversed suffix/triple ordering — the prefilter negative assertion fails.

Positive coverage uses the exact command line from the report. Negative coverage holds
the line the fix is at risk of crossing: a subcommand, an argument position, and
`codex-report-generator-worker.opencodex-real`, which must never match.
