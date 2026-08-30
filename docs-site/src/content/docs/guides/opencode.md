---
title: opencode
description: Use any routed model from opencode — opencodex injects a runtime provider block and leaves your own opencode config untouched.
---

opencode reads its providers from merged JSON config layers rather than environment
variables, so there is no `ANTHROPIC_BASE_URL`-style slot to inject. `ocx opencode`
bridges that gap: it ensures the proxy is running, builds a provider block from the
visible catalog, and injects it through OpenCode's inline runtime layer
(`OPENCODE_CONFIG_CONTENT`).

## Quickstart

```bash
ocx opencode
```

This ensures the proxy is running and launches opencode with the generated
`provider.opencodex` and `providers.opencodex` blocks injected for that process — the
legacy spelling opencode V1 reads, and the V2 spelling that carries the reasoning-effort
variants. Extra arguments pass through:
`ocx opencode run "hello"`.

Routed models appear in the picker under the `opencodex` provider:

```text
opencodex/kiro/glm-5
opencodex/gpt-5.6-sol      # native slugs stay unprefixed
```

## Reasoning effort

opencode exposes reasoning effort as model *variants*. opencodex writes one variant per
declared effort for every model that advertises a ladder — `none` is skipped, because the
chat ingress has no wire effort for it — so the effort is selectable in opencode's model
picker instead of being pinned by the proxy.

Two provider blocks are generated for this:

| Block | Read by | Carries variants |
|---|---|---|
| `provider.opencodex` | opencode V1 (`npm` + `options`) | no |
| `providers.opencodex` | opencode V2 (`package` + `settings`) | yes |

Only the V2 spelling applies `variants`; a variant written under the legacy block is parsed
and then dropped, which is why both blocks are emitted. They name the same provider and
model ids, and opencode V2 merges them into a single provider entry, so no model appears
twice in the picker. Models with no declared effort ladder carry no `variants` key at all.

No model-level default effort is written. The proxy keeps applying its own configured
default whenever a request carries no effort, so a default you change in opencodex stays
in force instead of being frozen into the config.

## Your own config is never modified

The launcher does not copy or rewrite `~/.config/opencode/opencode.json`,
project `opencode.json` / `opencode.jsonc`, or any other on-disk config layer. It may
read global or project config to detect a provider override — under `provider.opencodex`
or `providers.opencodex` — while your existing providers, agents, keybinds, MCP entries,
and relative `{file:…}` references keep resolving from their original files.

For this launch only, opencodex adds both generated blocks — `provider.opencodex` and
`providers.opencodex` — through OpenCode's inline runtime layer. That layer merges after global/custom/project config
and overrides only conflicting keys for the child process.

| Layer | Behavior with `ocx opencode` |
| --- | --- |
| Global / custom / project config | Left on disk exactly as you wrote it |
| Inline runtime (`OPENCODE_CONFIG_CONTENT`) | Receives the generated `provider.opencodex` and `providers.opencodex` blocks (merged into any inherited inline config) |
| Relative `{file:…}` paths | Still resolve against the config file that originally defined them |

If a global or project config also defines the provider under `provider.opencodex` or
`providers.opencodex`, the launcher prints an informational note: the runtime layer from
`ocx opencode` overrides it for that launch.

## Putting the block into your own config

`ocx opencode` injects the provider block for one launch only, which means plain `opencode` still
knows nothing about the proxy. When you want routed models available from plain `opencode` — or
from an editor extension that never goes through the launcher — `ocx export` prints the same
provider block for you to merge into your own config:

```bash
ocx export --client opencode
```

The proxy must be running. The command prints the config, the canonical destination
(`~/.config/opencode/opencode.json`, or under `XDG_CONFIG_HOME` when that is set), the merge
warning, and the env export line. It never touches that file — the section above stays true, and
moving the block into your config is your explicit act.

:::caution[Merge, never replace]
Merge both blocks — `provider.opencodex` and `providers.opencodex` — into your existing config.
Replacing the whole file with the exported one destroys your other providers, agents, keybinds,
and MCP entries. `ocx export --out` refuses to overwrite an existing file for exactly this reason,
so point `--out` at a scratch path and copy the blocks across:

```bash
ocx export --client opencode --out ~/opencodex-opencode.json
```
:::

Unlike the launcher's runtime block, a merged block is a static snapshot: it does not follow your
catalog. Re-run `ocx export` after you add a provider or change model visibility.

Once merged, export the admission key before launching opencode — unless the proxy is on loopback,
where none is needed:

```bash
export OPENCODEX_OPENCODE_API_KEY=<your key>
```

## The admission key is not written to disk

When the proxy requires an API key, the inline runtime config carries opencode's
`{env:…}` reference rather than the secret. Loopback binds use that reference as
`apiKey`; non-loopback binds send it only through `x-opencodex-api-key` so proxy
admission stays separate from any upstream `Authorization` header.

Loopback example:

```json
"options": {
  "baseURL": "http://127.0.0.1:10100/v1",
  "apiKey": "{env:OPENCODEX_OPENCODE_API_KEY}"
}
```

Non-loopback example:

```json
"options": {
  "baseURL": "http://192.168.1.10:10100/v1",
  "headers": {
    "x-opencodex-api-key": "{env:OPENCODEX_OPENCODE_API_KEY}"
  }
}
```

The real value is passed only through the child process environment.
`OPENCODEX_API_AUTH_TOKEN` takes precedence, then the hardened service token file, then
a configured API key — which is what a non-loopback bind requires.

A loopback bind (`127.0.0.1`, the default) authenticates nothing, so the `{env:…}` reference is
inert and you can leave the variable unset. It matters only when `hostname` is set beyond loopback;
see [Remote access](/reference/configuration/#remote-access). This admission key is opencodex's
own, and is unrelated to the upstream provider keys configured under
[Providers](/guides/providers/).

## Reverting

Nothing to undo — no generated config file is written under `~/.opencodex`. Run plain
`opencode` and it reads your own config exactly as before.

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
