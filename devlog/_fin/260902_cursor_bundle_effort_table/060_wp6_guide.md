# 060 — wp6: guide — identify the build, isolate it, wire the gateway, read the table

Depends on: 010, 030, 040 (documents what they shipped). Own PR against `dev`. Docs only.

Loop-spec: spec-satisfaction; trigger = the guide names the table but not how to tell which
build you have, where the table lives, or the env-var path; goal = a reader with the app already
installed can identify it, keep it apart from regular Cursor, connect opencodex, and understand
every "—"; non-goals = hosting/linking a download (`rg 'downloads.cursor.com|cursor-local/'`
stays 0), other locales; verifier = `bun run privacy:scan`, `cd docs-site && bun run build`,
the rg check; stop = green + exact-head CI.

## MODIFY `docs-site/src/content/docs/guides/cursor-private-inference.md`

### 1. New section after "Before you start": "Identify the installed build"

```md
## Identify the installed build

Both builds are named "Cursor" in the Dock and share the bundle id, so check `product.json`:

| Platform | product.json |
|---|---|
| macOS | `/Applications/Cursor Private Inference.app/Contents/Resources/app/product.json` |
| Windows | `%LOCALAPPDATA%\\Programs\\cursor-private-inference\\resources\\app\\product.json` |
| Linux | `<install root>/resources/app/product.json` (an AppImage must be extracted first) |

`nameLong` is `"Cursor Private Inference"` for the local-agent build and `"Cursor"` for the
regular one; `version` is the build (3.18.25 at the time of writing). The dashboard's
Integrations > Cursor card runs the same check and lists what it found. Local mode is switched
on inside the workbench bundle, not in `product.json`, so there is no flag to flip: if
`nameLong` says regular Cursor, that install cannot reach a loopback gateway.

opencodex does not distribute this build and Cursor does not document it. If you do not have it,
this page does not apply; use the [`ocx-cursor`](https://www.npmjs.com/package/ocx-cursor) bridge
with a public HTTPS endpoint instead.
```

### 2. "Configure the gateway": add the environment path and precedence (after the Settings steps)

```md
### Through the environment

`CURSOR_LOCAL_AGENT_BASE_URL` and `CURSOR_LOCAL_AGENT_API_KEY` are read when no gateway has
been saved in Settings. They must be in the login environment (launchctl setenv on macOS, the
user environment on Windows, the session on Linux), not only in an interactive shell rc file,
because a GUI-launched app does not read your shell.

Precedence, highest first: per-model credentials → the saved Settings gateway →
`CURSOR_LOCAL_AGENT_*` → `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` (compatibility
fallback). Clear the saved gateway before switching through the environment.

`CURSOR_LOCAL_AGENT_HEADERS` is optional: newline-separated `Header-Name: value` lines
(`User-Agent` and unresolved `{...}` placeholders are rejected; `{gitOrgRepo}` and
`{gitBranch}` are expanded).
```

Fix the existing sentence that describes `CURSOR_LOCAL_AGENT_HEADERS` as `key=value` pairs if
present (001 §"Configuration inputs").

### 3. "Models and reasoning effort": replace the intro and the closing paragraph

Before:
```md
2. The model id, after stripping everything up to the last `/`, must match Cursor's own
   effort table. Cursor decides the ladder, not opencodex:
```
After:
```md
2. The model id, after stripping everything up to the last `/` and any `@…` suffix, must
   match Cursor's own effort table. That table is compiled into the app at
   `<install>/…/app/extensions/cursor-agent-exec/dist/main.js`; opencodex reads it from the
   detected install so the dashboard prediction follows a Cursor update (the card says which
   build it read, or "static mirror" when none was found). Cursor decides the ladder, not
   opencodex, and no `/v1/models` field can add a model to that table:
```

Before (closing paragraph):
```md
So `anthropic/claude-opus-5` works, and opencodex's `max`/`ultra` tiers for GPT-5.6 are not
reachable from this picker. For a model with no control, set a default in opencodex instead
(`modelDefaultReasoningEfforts` on the provider); that default applies when Cursor sends no
effort.
```
After:
```md
So `anthropic/claude-opus-5` works, and opencodex's `max`/`ultra` tiers for GPT-5.6 are not
reachable from this picker.

### Models with no control

`anthropic/claude-fable-5-1`, `cursor/kimi-k3`, and anything else outside the table get no
Reasoning control, and Cursor logs one line per such id when the gateway advertises
`supports_reasoning`: "Local provider advertises reasoning support for a model with no
hardcoded Bottlerocket effort family". Two ways to still choose an effort:

- **Effort rows** (`cursorEffortRows: true` in opencodex config, default off): the gateway
  publishes one picker entry per effort for table-less models, `anthropic/claude-fable-5-1--high`,
  `cursor/kimi-k3--max`, and routes each to the base model with that effort. Models Cursor
  already renders get no extra rows. Press Refresh model list after turning it on.
- **A fixed default** (`modelDefaultReasoningEfforts` on the provider): applies when Cursor
  sends no effort.
```

### 4. "Max is two different things": append the wire caveat (from 001)

```md
With a `/v1` Base URL Cursor sends turns to `/v1/responses`, so GPT/Grok/Gemini effort travels
as `reasoning.effort`; Claude's `output_config.effort` is Messages-only and is dropped on that
wire, which is why a Claude row that does show a control still runs at the provider default.
A Base URL ending in `/messages` reverses it: Claude effort is sent, OpenAI-family effort is
dropped. One gateway entry cannot serve both families; effort rows (above) side-step this
because opencodex applies the effort itself.
```

### 5. "Verify": two table rows

```md
| models listed but no Reasoning control | opencodex older than v2.41, or the id is not in Cursor's table (dashboard shows —); turn on `cursorEffortRows` or set a provider default |
| a schema change is not picked up | Cursor caches `/models` per Base URL string with no expiry; Refresh model list re-reads, otherwise restart or temporarily change the URL spelling (`localhost` vs `127.0.0.1`) |
```

### 6. Configuration reference

`docs-site/src/content/docs/reference/configuration/providers.md` (or the top-level config
reference, verified at P): one entry for `cursorEffortRows` (boolean, default false, grammar
`<id>--<effort>`, reserved suffix warning).

## Accept criteria

- `rg -n 'downloads.cursor.com|cursor-local/' docs-site/src/content/docs/guides/cursor-private-inference.md` → 0 hits.
- `bun run privacy:scan` 0; `cd docs-site && bun run build` 0.
- Every claim about the bundle cites 001 (bundle path, precedence, header format, cache).
