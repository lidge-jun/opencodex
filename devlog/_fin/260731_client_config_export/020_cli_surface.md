# 020 — Phase 2: CLI surface

Consumes `010`. First user-visible phase. Serves the agent consumer (`--json`)
and the human consumer (framed text) from one payload, per `003` §2.

## Scope

IN
- NEW `src/cli/export-command.ts`.
- MODIFY `src/cli/index.ts` — dispatch `case "export"`.
- MODIFY `src/cli/help.ts` — usage entry.
- NEW `tests/cli-export-command.test.ts`.

OUT
- No management route (`030`), no GUI (`040`).
- No writing to the user's real config path without `--out`.
- No merging into an existing file. `--out` writes our block only; merging stays
  the user's decision (`003` §5).

## Command shape

```
ocx export --client <opencode|pi> [--json] [--out <path>] [--force]
```

Mirrors `src/cli/access.ts`: `takeOption`/`takeFlag` parsing, `CliUsageError` for
bad input, `runCliAction` wrapper, `printData` for the dual rendering.

### Agent path — `--json`

stdout is exactly the client config JSON, nothing else. No banner, no path hint,
no trailing prose. Diagnostics go to stderr. This is the contract that makes
`ocx export --client pi --json > models.json` safe.

### Human path — no flag

```
$ ocx export --client opencode
{
  "$schema": "https://opencode.ai/config.json",
  ...
}

Destination: ~/.config/opencode/opencode.json
Merge this provider block into that file; do not replace it.
Before launching: export OPENCODEX_OPENCODE_API_KEY=<your ocx_... key>
19 models; 2 omit context limits (the client applies its own defaults).
```

The JSON still leads so a human can pipe or eyeball it, and the framing follows.
The degraded-count line is the CLI expression of `003` §4's degraded state — the
same fact, rendered for a terminal.

### `--out <path>`

Writes the JSON to the given path. Refuses to overwrite an existing file unless
`--force`, because the common mistake is `--out ~/.config/opencode/opencode.json`
onto a populated config, which would silently destroy other providers. The refusal
message names the file and suggests printing + merging instead.

`--out` never defaults to the real destination. The destination is shown as text;
targeting it is an explicit act.

## Data flow

```
ocx export
  -> runtimeRequest("/api/models")        // same source as `ocx opencode`
  -> toExportModels(rows)                 // drop disabled, dedupe, sort (010)
  -> buildClientConfig(client, { baseUrl, models })
  -> printData(config, wantsJson, humanLines)
```

Base URL comes from the live proxy probe already used by the opencode launcher
(`findLiveProxy` + `opencodeProxyBaseUrl`), so an exported config always points at
the port the proxy is actually on.

### Proxy not running

The model list requires a live proxy. Fail with the existing runtime-api error
path rather than emitting a model-less config — a config with an empty `models`
block looks valid and silently offers nothing. Message names `ocx start`.

## File change map

| Path | Action |
|------|--------|
| `src/cli/export-command.ts` | NEW — `handleExportCommand(argv)` |
| `src/cli/index.ts` | MODIFY — `case "export": { const { handleExportCommand } = await import("./export-command"); process.exitCode = await handleExportCommand(args.slice(1)); break; }` |
| `src/cli/help.ts` | MODIFY — add `export` to the usage table |
| `tests/cli-export-command.test.ts` | NEW |

## Accept criteria

1. `--json` stdout parses as JSON with zero extra bytes. **Activation:** the test
   captures stdout and runs `JSON.parse` on the whole buffer.
2. Human output contains destination path, merge warning, and env export line.
3. `--out` onto an existing file exits non-zero without touching the file, and
   `--force` overwrites. **Activation:** the test pre-creates the file with known
   content and asserts the bytes are unchanged after the refusal.
4. Unknown `--client` exits with a usage error naming both valid values.
5. Proxy down produces the runtime-api error, not an empty-model config.
6. No stdout path in any mode contains `ocx_`.
