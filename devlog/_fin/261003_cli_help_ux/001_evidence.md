# CLI help evidence

## Scope and provenance

The requested outcome is terminal command UX starting at `ocx --help`. The later
scope correction excludes new client integrations. Publishing a manual PR stack
is authorized; merging, releasing and changing the running proxy are not.

OpenCodex baseline: `4b98328dca` (`origin/dev`, fetched 2026-10-03).
Reference: https://github.com/yetone/magpie at
`b3ab3e42e9770a09a3ec29ac9c07511376d4e7fd`, cloned into ignored scratch space.
The reference informs interaction design; this is an original TypeScript
implementation using OpenCodex's existing command contracts.

## Observed help behavior

Source invocations used Bun with isolated, existing `OPENCODEX_HOME` and
`CODEX_HOME` directories, `NO_COLOR=1`, `TERM=dumb`, and `COLUMNS=80`.

| Invocation | Exit | Observation |
| --- | --- | --- |
| `ocx --help` | 0 | 92 lines; one flat command list mixes setup, diagnostics and advanced recovery. |
| `ocx models context --help` | 0 | 12-line parent models help; the requested nested path is lost. |
| `ocx help models context` | 0 | Same parent output; the second path component is ignored. |
| `ocx account --help` | 0 | Parent usage plus manually maintained detail rows. |
| `ocx help modles` | 1 | Unknown-command stderr followed by the entire 92-line root help on stdout. |

Local raw outputs: `.tmp/cli-ux/baseline/`. These scratch files are not published.
The first baseline attempt lacked installed dependencies and existing isolated
homes; those environmental failures are not product findings. Dependencies were
then installed from the frozen lockfile with lifecycle scripts disabled, and the
successful observations above were captured anew.

## Existing owners

- `src/cli/root.ts`: pure head classification and help/version exits before shim
  reconciliation. It currently stores only one `helpTarget` string.
- `src/cli/help.ts`: manual root banner and top-level registry help rendering.
- `src/cli/registry.ts`: command names, aliases, usage and summaries.
- `src/cli/capabilities.ts`: declarative command paths, flags and API semantics;
  intentionally imports no command modules. Coverage is explicitly incomplete.
- `src/cli/dispatch.ts`: canonical runners and aliases; ordinary dispatch remains
  separate from presentation.
- `docs-site/src/content/docs/reference/cli.md`: public command discovery contract.
- `structure/runtime.md`: entrypoint and CLI lifecycle contract.

## Baseline verification

`bun test tests/cli/cli-help.test.ts tests/cli/cli-registry.test.ts
tests/cli/cli-capabilities.test.ts tests/cli/cli-capabilities-arguments.test.ts`
completed with **55 pass, 0 fail, 705 assertions**. Each named test directly
observes the existing help, registry or capability surface.

## Concurrent work excluded

Open PR #6483 owns config flags-only defaults; #6436 owns usage-report row limits.
This unit does not change either command's runtime semantics.

Additional baseline gates: `bun run typecheck`, `bun run structure:check`,
`bun run skill:surface:check`, and `cd docs-site && bun run build` exited 0.
The docs build produced 561 pages and checked 77,923 internal links. Typecheck
includes src via tsconfig.json; structure checks ownership/doc contracts; skill
surface checks the generated capability inventory; docs build observes the CLI
reference page through the Astro content collection. These establish executable
verifiers, not proof of the not-yet-implemented UX.
