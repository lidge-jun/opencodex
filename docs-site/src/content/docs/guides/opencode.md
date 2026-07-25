---
title: opencode
description: Use any routed model from opencode — opencodex generates a provider config and points OPENCODE_CONFIG at it, leaving your own opencode.json untouched.
---

opencode reads its providers from a JSON config rather than environment variables, so there is
no `ANTHROPIC_BASE_URL`-style slot to inject. `ocx opencode` bridges that gap: it generates a
provider block from the proxy's visible catalog and points `OPENCODE_CONFIG` at the result.

## Quickstart

```bash
ocx opencode
```

This ensures the proxy is running, writes `~/.opencodex/opencode-config.json`, and launches
opencode with `OPENCODE_CONFIG` set to that file. Extra arguments pass through:
`ocx opencode run "hello"`.

Routed models appear in the picker under the `opencodex` provider:

```
opencodex/kiro/glm-5
opencodex/gpt-5.6-sol      # native slugs stay unprefixed
```

## Your own config is never modified

The launcher does not write to `~/.config/opencode/opencode.json`. Instead it reads your
effective config, merges it forward into the generated copy, and overwrites only the
`opencodex` provider key. Every other provider, plus unrelated top-level fields (`model`,
`agents`, `keybinds`, `mcp`, …), is preserved verbatim.

| Source | Behavior |
| --- | --- |
| `OPENCODE_CONFIG` already exported | Used as the base config, then superseded by the generated path |
| `~/.config/opencode/opencode.json` (or `$XDG_CONFIG_HOME`) | Used as the base config when no explicit export exists |
| Neither exists | A standalone config containing only the `opencodex` provider |
| Base config is malformed | The launch is refused rather than silently dropping your settings |

Comments and trailing commas are fine — opencode documents `opencode.json` as JSONC, and the
launcher parses the same syntax the client accepts.

Carrying your config forward means the command behaves identically whether opencode merges the
`OPENCODE_CONFIG` layer or replaces it.

### Project configs still win

opencode loads a project-level `opencode.json` *after* the `OPENCODE_CONFIG` layer. If your
project config defines `provider.opencodex`, it overrides the generated block and the child may
talk to a stale base URL. The launcher cannot outrank that layer without writing to one of your
files, so it prints a warning instead. Rename the project-level key to resolve it.

## The admission key is not written to disk

When the proxy requires an API key, the generated config carries opencode's `{env:…}` reference
rather than the secret:

```json
"options": {
  "baseURL": "http://127.0.0.1:10100/v1",
  "apiKey": "{env:OPENCODEX_OPENCODE_API_KEY}"
}
```

The real value is passed only through the child process environment. `OPENCODEX_API_AUTH_TOKEN`
takes precedence over a configured API key, which is what a non-loopback bind requires.

## Reverting

Nothing to undo — the generated file lives in the opencodex config dir and is only consulted
when the launcher sets `OPENCODE_CONFIG` for the child process. Run plain `opencode` and it
reads your own config exactly as before.

## Model limits

`limit.context` is written only when the catalog reports an authoritative context window; when it
does not, the whole `limit` block is omitted and opencode keeps its own defaults.

opencode's schema rejects a `limit` block carrying `context` without `output`, and the catalog has
no authoritative per-model output field, so an `output` budget of `32000` is emitted alongside it,
clamped down to the context window so a small-context model is never given `output > context`.
That figure exists to satisfy the schema — it is not a claim about any specific model's true
maximum.

The `opencodex` provider block is regenerated on every launch, so per-model tweaks made inside it
will not survive. Keep custom entries under a provider key of your own instead.

## Requirements

opencode must be installed and on `PATH`:

```bash
npm install -g opencode-ai
```
