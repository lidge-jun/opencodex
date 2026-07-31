# 370 - CLI UX Research

## Goal

Make `ocx` feel friendly to both humans and command-line agents without changing core runtime behavior in the first pass.

This document records the current CLI state, comparison notes from `cli-jaw` and `agbrowse`, and the patch map for later PABCD passes.

## Repository Context

- Project root: `/Users/jun/Developer/new/700_projects/opencodex`
- Current CLI owner: `src/cli.ts`
- Current CLI tests: `tests/cli-help.test.ts`
- Public CLI docs: `README.md`, `README.ko.md`, `README.zh-CN.md`, `docs-site/src/content/docs/reference/cli.md`
- Structure source of truth: `structure/01_runtime.md`, `structure/06_docs-and-release.md`

## Current `ocx` Behavior

Captured commands:

```bash
bun run src/cli.ts --help
bun run src/cli.ts -h
bun run src/cli.ts help
bun run src/cli.ts -v
bun run src/cli.ts version
```

Findings:

- `--help`, `-h`, and `help` print the same top-level usage.
- `ocx help <command>` currently prints top-level help, not command-specific help.
- `restore --help` and `recover-history --help` are safe and do not mutate Codex state.
- Unknown commands print `Unknown command: <name>` and the full help, then exit 1.
- Unknown commands with a trailing help flag, such as `ocx restart --help`, print top-level help and exit 0.
- `-v`, `--version`, and `version` are not supported; `-v` and `version` are treated as unknown commands.
- `ocx status --json` exits 0 but prints human status text; there is no JSON contract yet.
- Help is compact but not task-oriented. It lists commands, but it does not answer "what should I run first?", "how do I diagnose a problem?", or "what is safe to run in scripts?".
- There is no `--json` contract for status/diagnostics, so agents must parse human text.
- `src/cli.ts` is doing command parsing, help text, runtime behavior, and dispatch in one file.

Detailed matrix:

```path
/Users/jun/Developer/new/700_projects/opencodex/devlog/370_cli-human-friendly/11_help_surface_matrix.md
```

## Reference CLI Patterns

### `cli-jaw`

Observed command:

```bash
cli-jaw --help
cli-jaw --version
cli-jaw goal --help
```

Useful patterns:

- Friendly branded header with version.
- Explicit `Usage:` line with command/args/flags shape.
- Quick-start commands at the top.
- Decision guide for agents.
- Commands grouped by domain, not only listed alphabetically.
- Global options documented in one place.
- `--version, -v` is a first-class global option.
- Subcommand help uses the same predictable style.

Do not copy:

- `cli-jaw` is broader than `ocx`; `ocx` should stay focused on Codex proxy setup, status, auth, service, and recovery.

### `agbrowse`

Observed command:

```bash
agbrowse --help
agbrowse --version
```

Useful patterns:

- Positioning section says what the tool is and is not.
- Quick start includes concrete commands.
- "Stuck? Run ..." diagnostic section.
- Common failures are phrased as exact error text -> next command.
- Agent decision loop is explicit.
- Complex command families are grouped with compact subcommand examples.

Do not copy:

- In the observed install, `agbrowse --version` printed full help instead of a short version line. `ocx` should not copy this; version should be stable and script-friendly.

## UX Principles For `ocx`

1. First screen answers the first-run path:
   - install done -> `ocx init` -> `ocx start` or `ocx codex-shim install` -> use `codex`.
2. Human help and agent help are related but not identical:
   - human help should explain workflows and recovery;
   - agent help should expose stable commands and `--json` availability.
3. `-v` / `--version` must be script-friendly:
   - no config load;
   - no network;
   - no mutation;
   - output one line.
4. Diagnostics should avoid hidden side effects:
   - help, version, and dry-run diagnostics must not touch Codex config.
5. Errors should teach the next command:
   - unknown command should suggest `ocx help`;
   - service/shim bad subcommands should suggest their exact usage;
   - troubleshooting should point to `ocx status`, `ocx doctor` once implemented, and docs.
6. Public docs should match actual CLI behavior.

## Proposed Work-Phase Map

### Phase 1 - Broad `--help` Surface Research

Documentation-only investigation pass.

- Enumerate every current `ocx` top-level command and nested `service` / `codex-shim` command.
- Capture `--help`, `-h`, and `ocx help <command>` behavior.
- Explicitly probe missing or empty candidate commands such as `restart`, `doctor`, `logs`, `commands`, `--json`, and `--version`.
- Compare actual behavior against README, docs-site, and `structure/` documentation.
- Produce a command matrix before any implementation patch.
- Avoid executing lifecycle commands without help flags during research because they can mutate service/shim/proxy/Codex state.

### Phase 2 - Help/Version Patch Plan

Implementation planning pass after Phase 1 evidence exists.

- Decide the first low-risk implementation slice from the Phase 1 matrix.
- Likely candidates: version output, top-level grouped help, or side-effect-free help aliases.
- Write a diff-level PABCD plan before touching `src/cli.ts`.

### Phase 3 - Agent-Friendly Diagnostics Contract

Public contract planning pass.

- Add `ocx status --json`.
- Consider `ocx doctor` as a read-only aggregate diagnostic command.
- Document machine-readable output schema in docs-site.
- Add tests that JSON output is valid and does not include secrets.

## Open Questions For Later Phases

- Should `ocx doctor` be implemented as a new command, or should `ocx status --verbose` cover the same need?
- Should all commands eventually support `--json`, or only read-only diagnostics?
- Should help output use color when TTY is present, or stay plain for copy/paste and CI logs?
- Should `ocx help <command>` be an alias for `ocx <command> --help`?
