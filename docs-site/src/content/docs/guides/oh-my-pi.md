---
title: Oh My Pi
description: Use any routed model from Oh My Pi (omp) — ocx export writes a custom provider block for omp's ~/.omp/agent/models.yml, wired to the running proxy.
---

Oh My Pi (`omp`) reads custom providers from `~/.omp/agent/models.yml`, so
opencodex does not launch it. Instead, `ocx export` serializes the `opencodex`
provider block — base URL, model list, and the env reference omp interpolates —
and you merge it into that file.

## Quickstart

Start the proxy, then print the config:

```bash
ocx start
ocx export --client omp
```

The output leads with the YAML, then prints the destination path, the merge
warning, the env export line, and how many models carry authoritative context
limits.

```yaml
providers:
  opencodex:
    baseUrl: http://127.0.0.1:10100/v1
    api: openai-completions
    apiKey: "$OPENCODEX_OMP_API_KEY"
    models:
      - id: anthropic/claude-opus-5
        name: "Claude Opus 5 (anthropic)"
        input:
          - text
        contextWindow: 200000
        maxTokens: 32000
```

Merge the `providers.opencodex` block into `~/.omp/agent/models.yml` (do not
replace the rest of the file), then start a new omp session. The models appear
under the `opencodex/` prefix.

## Credential

The config references `$OPENCODEX_OMP_API_KEY` and never holds the real key.
Export it before launching omp:

```bash
export OPENCODEX_OMP_API_KEY=<your key>
```

Like Pi, omp's provider block has no place for the `x-opencodex-api-key` header
a non-loopback bind requires, so this integration works against a loopback
bind. Reach a remote opencodex through an SSH tunnel or a local forwarder that
adds the header instead.

The dashboard's **Integrations → Oh My Pi** tab does the same thing with a
switch, and takes a backup before every write so the change can be undone.
