---
title: Pi
description: Use any routed model from Pi — ocx export writes a custom provider block for Pi's models.json, wired to the running proxy.
---

Pi reads its providers from a single global JSON file rather than environment variables, so
opencodex does not launch it. Instead, `ocx export` serializes the `opencodex` provider block —
base URL, model list, and a placeholder admission key — and you merge it into your own config.

## Quickstart

Start the proxy, then print the config:

```bash
ocx start
ocx export --client pi
```

The output leads with the JSON, then prints the destination path, the merge warning, and how many
models carry authoritative context limits.

```json
{
  "providers": {
    "opencodex": {
      "baseUrl": "http://127.0.0.1:10100/v1",
      "api": "openai-completions",
      "apiKey": "opencodex-loopback",
      "models": [
        {
          "id": "anthropic/claude-opus-5",
          "name": "Claude Opus 5 (anthropic)",
          "input": ["text"],
          "contextWindow": 200000,
          "maxTokens": 32000
        }
      ]
    }
  }
}
```

Model ids are the proxy's canonical selectors, so routed models appear as `provider/model`
(`anthropic/claude-opus-5`) and native OpenAI slugs stay unprefixed (`gpt-5.6-sol`). The `name`
suffix — `(anthropic)`, `(native)`, `(routed)` — is what makes two same-named models from
different upstreams distinguishable in Pi's picker.

## Where it goes

Pi's global model config is:

```text
~/.pi/agent/models.json
```

:::caution[Merge, never replace]
`ocx export` never writes that file. Merge the `providers.opencodex` block into it — replacing the
file destroys every other provider you have configured there. `--out` exists for a scratch path
and refuses to overwrite an existing file without `--force`:

```bash
ocx export --client pi --out ~/opencodex-pi-models.json
ocx export --client pi --json > ~/opencodex-pi-models.json   # or redirect the byte-exact JSON
```
:::

The exported block is a static snapshot, not a live view. Re-run `ocx export` after adding a
provider or changing model visibility, and merge the new block over the old one.

## The admission key

**A loopback proxy needs no key at all.** opencodex binds `127.0.0.1` by default and authenticates
nothing there, so the exported block carries the literal placeholder `opencodex-loopback` rather
than a real credential — no environment variable is involved.

The placeholder is load-bearing, not cosmetic: Pi resolves `apiKey` while building its model list
and hides the whole provider when the value is an env reference that is not set. A literal keeps
every routed model visible, and the proxy never checks it on loopback.

Your provider keys are a different matter — the Anthropic / OpenAI / OpenRouter key lives in
opencodex's own config, per [Providers](/guides/providers/), and never appears in this file.

## Model metadata

`contextWindow` and `maxTokens` are emitted only when the catalog reports an authoritative context
window. When it does not, both fields are omitted for that model and Pi applies its own defaults;
`ocx export` prints how many rows fell into that case.

`maxTokens` is a schema-satisfying budget of `32000`, clamped down to the context window so a
small-context model is never given more output than context. It is not a claim about any specific
model's true maximum.

Two fields are deliberately absent. `cost` requires all four price fields and opencodex has no
price data for routed models — emitting zeros would assert that every model is free. `reasoning` is
a boolean in Pi while the catalog carries an effort ladder, and mapping one onto the other would be
a guess.

## Schema status

:::note[Verified against a real install]
The shape above has been verified against Pi 0.83.x on a real `~/.pi/agent/models.json`: the block
validates and every routed model appears in Pi's picker. If a newer Pi rejects the exported
block, the mismatch is on our side — please
[open an issue](https://github.com/lidge-jun/opencodex/issues) with what Pi reported.
:::

## Requirements

A running opencodex proxy (`ocx start`) and Pi installed. `ocx export` reads the live catalog
through the proxy's management API, so a config can never be emitted with an empty model list.
