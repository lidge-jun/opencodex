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
legacy spelling opencode V1 reads, and the native V2 spelling. Both carry reasoning-effort
variants in the format their client reads. Extra arguments pass through:
`ocx opencode run "hello"`.

Routed models appear in the picker under the `opencodex` provider:

```text
opencodex/kiro/glm-5
opencodex/gpt-5.6-sol      # native slugs stay unprefixed
```

## Reasoning effort

opencode exposes reasoning effort as model *variants*. opencodex writes one variant per
declared effort, including `none` when the model explicitly supports disabling reasoning.
The selection reaches the proxy as a reasoning effort, not just a picker label. Existing
upstream effort pins in opencodex still apply.

Two provider blocks are generated for this:

| Block | Read by | Carries variants |
|---|---|---|
| `provider.opencodex` | opencode V1 (`npm` + `options`) | legacy options map |
| `providers.opencodex` | opencode V2 (`package` + `settings`) | native settings array |

V2 uses its native variant array rather than the legacy map. The blocks name the same provider
and model IDs and merge into one provider entry. No model appears twice. V2 always writes a
variant array, empty when no choices are declared, to suppress automatic low/medium/high
choices. Known fixed-depth reasoners in the legacy block disable every automatically generated
rung for the same reason; those disabled entries are not selectable efforts.

A known model default is exported; selecting a variant overrides that client default.
No default is invented when the catalog declares none. The launcher regenerates these
settings each time; refresh a managed integration or re-export a manual snapshot after
changing the default in opencodex.

## Images and attachments

opencode decides whether a model takes an image from the model entry itself, and it cannot ask
models.dev about `opencodex` — this provider is not there. The generated blocks therefore
carry per-model capability fields taken from the effective metadata the proxy reports at
`GET /api/models`. For example, the legacy block carries `attachment` and `modalities`:

```json
"gpt-5.6-luna": {
  "name": "gpt-5.6-luna (native)",
  "limit": { "context": 272000, "output": 128000 },
  "attachment": true,
  "modalities": { "input": ["text", "image"], "output": ["text"] }
}
```

V2 receives native `capabilities.input` and `capabilities.output` fields; known tool support
uses `capabilities.tools`. Legacy clients read the fields in the example above. When
the catalog reports image input for a model the vision sidecar covers, opencode lets the
attachment through so the sidecar can describe it before the upstream call.

V2 requires a `tools` boolean whenever the native capabilities object exists. When tool support
is unknown, that object is omitted; known input modalities still reach V2 through the legacy
block's migration. This avoids inventing tool support or invalidating the provider's native settings.

Unknown capabilities leave OpenCode's own fallback assumptions in place; they are not detected
provider facts. Explicit text-only metadata prevents image requests on the client side.

Custom models inherit known catalog metadata unless an explicit override is stored. A custom
entry declaring text only stays text-only. Unknown capabilities are omitted rather than
invented; an explicit empty reasoning ladder does not declare the model incapable of reasoning.

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
catalog. Re-run `ocx export` after you add a provider or change model visibility or metadata.
Alternatively, [enable the managed integration](/guides/integrations/): `ocx sync` safely
refreshes its already-owned blocks, leaving hand-edited or removed blocks untouched.

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
see [Remote access](/reference/configuration/server/#remote-access). This admission key is opencodex's
own, and is unrelated to the upstream provider keys configured under
[Providers](/guides/providers/).

## Reverting

Nothing to undo — no generated config file is written under `~/.opencodex`. Run plain
`opencode` and it reads your own config exactly as before.

## Model limits

`limit.context` is written only when the catalog reports an authoritative context window; when it
does not, the whole `limit` block is omitted and opencode keeps its own defaults.

Output limits use the model’s known maximum from catalog or generated metadata. Only unknown limits fall back to `32000`. The output limit is always clamped to the context window, including known limits below `32000`.

Known input limits are also carried and clamped to context; unknown input limits are omitted.
CLI export, dashboard export, managed refresh and the launcher share the effective metadata.

The `opencodex` provider block is regenerated on every launch, so per-model tweaks made inside it
will not survive. Keep custom entries under a provider key of your own instead.

## Requirements

opencode must be installed and on `PATH`:

```bash
npm install -g opencode-ai
```

The launcher reads the model catalog with the local admin token from the environment or the running proxy home. It connects directly to a loopback management listener and refuses redirects. A hub bound only to a nonlocal address needs its loopback `hub.managementIngress` enabled. The admin token is not passed into the OpenCode child; inference continues using its separate data key. If the local admin token is missing, the launcher reports the problem rather than retrying with a data key.
