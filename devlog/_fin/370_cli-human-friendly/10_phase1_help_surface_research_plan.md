# Phase 1 - Broad `--help` Surface Research

## Objective

Do not implement CLI behavior yet. Produce a detailed, evidence-backed map of every current `ocx` command/help surface, including missing or empty command candidates such as `restart`, `doctor`, `--json`, and `--version`.

The output of this phase is documentation only: a command matrix, gap analysis, and later implementation recommendations.

## Classification

C2 documentation/research slice:

- no source behavior changes;
- broad enough to need systematic command enumeration;
- safe to verify with read-only CLI invocations and typecheck;
- must not stage unrelated dirty service/runtime work.

## Investigation Targets

### Current `ocx` Help Surface

Capture outputs and exit behavior for:

```bash
ocx
ocx help
ocx --help
ocx -h
ocx --version
ocx -v
ocx version
ocx help <command>
ocx <command> --help
ocx <command> -h
```

Commands to enumerate:

- `init`
- `start`
- `stop`
- `restore`
- `eject`
- `recover-history`
- `uninstall`
- `remove`
- `status`
- `ensure`
- `login`
- `logout`
- `sync`
- `sync-cache`
- `gui`
- `service`
- `codex-shim`
- `update`

Nested service/shim commands:

- `service install`
- `service start`
- `service stop`
- `service status`
- `service uninstall`
- `service remove`
- `service restart`
- `codex-shim install`
- `codex-shim status`
- `codex-shim uninstall`
- `codex-shim remove`
- `codex-shim restart`

### Missing / Candidate Commands

Investigate whether these should exist, or whether help should explicitly say they do not:

- `ocx restart`
- `ocx service restart`
- `ocx doctor`
- `ocx status --json`
- `ocx doctor --json`
- `ocx logs`
- `ocx service logs`
- `ocx usage`
- `ocx help <command>`
- `ocx commands`

### Reference CLIs

Use `cli-jaw` and `agbrowse` only as reference UX material, not as source to copy blindly.

Capture:

- top-level help grouping;
- global `--help` / `-h` / `--version` / `-v` behavior;
- subcommand help consistency;
- diagnostic commands (`doctor`, `status`, `logs`);
- JSON conventions;
- restart/start/stop lifecycle naming;
- common failure guidance.

Known preliminary findings:

- `cli-jaw --help` has a strong grouped layout and `--version, -v`.
- `cli-jaw service --help` currently reports unknown option while still printing usage; do not copy that inconsistency.
- `agbrowse --help` has strong quick-start, stuck/failure, and agent decision loop sections.
- Observed `agbrowse --version` printed full help; do not copy that for `ocx`.

## Planned Files

### ADD `devlog/370_cli-human-friendly/11_help_surface_matrix.md`

Content:

- command matrix;
- observed output class;
- exit status;
- side-effect risk;
- doc coverage;
- recommendation.

### MODIFY `devlog/370_cli-human-friendly/00_cli_ux_research.md`

Content:

- update phase map to clarify Phase 1 is research-only, not implementation.
- move implementation ideas into later candidate phases.

### OPTIONAL MODIFY `devlog/370_cli-human-friendly/20_phase2_subcommand_help_plan.md`

Only if Phase 1 research reveals a better implementation order.

## Acceptance Criteria

- No production source files are changed by this phase.
- `11_help_surface_matrix.md` covers all current top-level commands and the explicit missing candidates above.
- The matrix distinguishes "document existing behavior" from "recommended future patch".
- Unrelated dirty files remain unstaged.
- `bun run typecheck` still passes.

## Verification

```bash
git diff --cached --stat
bun run typecheck
git status --short --branch
```

## Suggested Commit

```text
docs(cli): map help surface gaps
```

