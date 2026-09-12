# What omo actually reads

Evidence: `omo-ai` version `5.0.0-0.beta.53` unpacked at `/tmp/omoprobe2/package`,
and `@code-yeongyu/senpi` version `2026.9.10-2` unpacked at
`/tmp/senpiprobe/package`. Schema
claims below were executed against that tarball's own TypeBox compiler
(`typebox@1.3.18`), not read off documentation.

## omo parses nothing

`bin/omo.js` either runs setup or `runLauncher()`, and the launcher brands senpi
and spawns it. The catalog is senpi's. Branded with `configDir: ".omo"` and
`flatLayout: false`, senpi resolves `getModelsPath() = join(getAgentDir(),
"models.json")` (`senpi dist/config.js:506-508`), which with omo's default agent
directory (`bin/lib/agent-dir.js:41-43`) is `~/.omo/agent/models.json`.

omo's own setup only *inspects* that path — `setup-detect.js:139-143` lists it in
`detectedFilePaths`, and `setup-models.js:19` tells the user to define the
provider `baseUrl` in it. Setup writes `auth.json`, never `models.json`, so
opencodex is not fighting omo's installer for the file.

## Path precedence

The launcher resolves, first non-empty trimmed value winning:
`OMO_CODING_AGENT_DIR`, `SENPI_CODING_AGENT_DIR`, `PI_CODING_AGENT_DIR`, else
`~/.omo/agent` (`agent-dir.js:15,33-38`). It then *overwrites* the first two with
the resolved absolute path before spawning senpi, so senpi's own lookup — which
reads the same three names in the same order (`brand.js:126-140`,
`config.js:456-457`) — always finds the launcher's answer and never reaches its
project-local `.omo/agent` walk.

Home is `env.HOME || env.USERPROFILE || os.homedir()` (`agent-dir.js:27-30`).

That third variable is Pi's. omo honors it deliberately, so `omoAgentDir` reading
it is reporting omo's contract rather than asserting a shared one.

## The provider block senpi validates

`providers` is a keyed object; each provider's `models` is an **array** whose
identity is `id`, not a keyed object — a keyed object fails with `must be array`
(`model-config-schema.js:201-220`). That is Pi's shape, not OpenCode's.

Accepted provider keys include `baseUrl`, `apiKey`, `api`, `headers`
(`Record<string, string>`), `compat`, `models`, and `modelOverrides`. `api` is a
bare string at schema time rather than an enum; an unknown value loads and then
fails at stream time (`provider-composer.js:274-277`). `openai-completions` is a
known api (`types.d.ts:25`) and validates.

`thinkingLevelMap` accepts exactly the keys the Pi builder emits — `off`,
`minimal`, `low`, `medium`, `high`, `xhigh`, `max` — each `string | null`
(`model-config-schema.js:65-72`), so emitting `max: "ultra"` as a *value* is
fine.

`input` accepts `text`, `image`, `video` (`model-config-schema.js:170`). `audio`
is rejected — and rejection is not local: a schema failure empties the whole
`models.json` snapshot (`model-config.js:483-487`), so one bad row takes every
custom provider down. This is Pi's failure mode exactly, and it is why
`buildPiClientConfig` drops an audio-only row instead of claiming `text` for it.

`cost` is optional, but a *partial* `cost` is a schema failure: all four rates
are required (`model-config-schema.js:141-155`). The Pi builder omits `cost`
entirely, which is the safe side of that line.

## Verdict

**The bytes `buildPiClientConfig` emits are accepted verbatim.** Nothing needs
renaming, adding, or removing. That was confirmed by running the document
through senpi's compiled validator, not inferred from the family resemblance.

`compat.sendSessionAffinityHeaders` also validates
(`model-config-schema.js:111,210`), so omo takes the builder's
`sendSessionAffinityHeaders` flag as `true`, the way `pi` does and `prime` and
`aside` do not.

## Why omo is still loopback-only

senpi's provider block *does* accept `headers`, and it interpolates `$ENV` and
`${ENV}` in values (`provider-api-key-auth.js:107-117`), so unlike Aside there is
somewhere an `x-opencodex-api-key` could live. What does not exist is a builder
that emits it: `buildPiClientConfig` writes no `headers` at all
(`src/clients/config-export.ts:854-866`), which is exactly why `pi` itself is
loopback-only.

So `loopbackOnly: true` for omo is OMP's and Prime's stance rather than Aside's:
the field exists, the remote credential wiring is deferred, and a non-loopback
bind refuses instead of generating a config that 401s. Adding `headers` to the
shared Pi builder would change four clients at once and is out of this unit's
scope.

## Left unverified

- Whether the dummy `apiKey` is copied into an `Authorization` header at stream
  time (would need `pi-ai/dist/api/openai-completions.js`). Irrelevant for a
  loopback bind, which admits without a key.
- `oauth: "radius"` appears in senpi's `docs/models.md:139` but not in the live
  schema. Not used here.
