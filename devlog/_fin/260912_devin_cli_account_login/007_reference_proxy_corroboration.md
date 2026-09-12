# 007 — Independent corroboration from a working Devin CLI proxy

A second reference implementation was supplied by the operator
(`server (1).mjs`, 851 lines, "Devin CLI proxy: OpenAI-compatible /v1 API backed
by `devin acp`"). It is an ACP proxy, so it is not the transport this unit
chose — but it independently confirms the credential half of `011`.

## Same path, same key, same parse

```js
// server (1).mjs:173-176
? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "devin", "credentials.toml")
: join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "devin", "credentials.toml"));
...
return readFileSync(path, "utf8").match(/windsurf_api_key\s*=\s*"([^"]+)"/)?.[1] ?? null;
```

That is the resolver `011` specifies, arrived at independently: `%APPDATA%` on
Windows, `$XDG_DATA_HOME ?? ~/.local/share` elsewhere, and a line match for
`windsurf_api_key` rather than a TOML dependency. Three sources now agree on the
path and key name — this file, `wakamex/devin-cli-usage`, and the live probe in
`004` — so `011`'s parser is not a guess.

Its `readFileSync(...).match(...) ?? null` also returns null rather than throwing
on a missing file, which is the shape `011` uses for
`readDevinCliCredentialFile`.

## What it does NOT corroborate

It reads the key and then still spawns `devin acp` (`:329`), keeping one live
child per session and compacting inside it. So it is evidence for where the
credential lives, not for what to do with it. `005` is the evidence that the same
key works directly against `server.codeium.com`, which this proxy never tries.

Worth noting for anyone comparing: an ACP proxy inherits the CLI's agent loop and
its per-session process, which is what makes session lifecycle, compaction and
`--permission-mode` its own problem — the same class of defect PR #4332 fixed in
opencodex's ACP adapter. The cloud route has none of that surface.

