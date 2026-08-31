# Provider marks

Unit opened 2026-09-01. The Integrations page now draws a logo beside every
client it names. The provider surface does not: 38 of 83 registry providers fall
back to a coloured initial tile, and the Add-Provider catalog draws no mark at
all for any provider.

## The measurement

```
PROVIDER_REGISTRY          83 entries
providerIconSrc() resolves 45
returns undefined for      38
```

Three of the 38 are not a sourcing problem at all -- the asset is committed and
the alias map simply never learned about it:

| provider | asset already on disk |
|---|---|
| `minimax` | `minimax.svg` |
| `minimax-cn` | `minimax.svg` |
| `xiaomi-mimo` | `xiaomi-color.svg` |

`minimax.svg` landed in #3082 for the MiniMax Code *client*. Nothing connected
it to the MiniMax *provider*, because the two maps are unrelated:
`CLIENT_MARKS` is keyed by `ExportClientId` and `PROVIDER_ICON_ALIASES` by
provider id. That is the whole defect, and it is the cheapest one in this unit.

The remaining 35 have no asset:

```
nous umans neuralwatt orcarouter bizrouter cerebras chutes deepinfra hyperbolic
nscale vultr baseten sambanova nebius digitalocean scaleway featherless novita
together venice zai zhipu-bigmodel zhipu-bigmodel-coding nanogpt synthetic
siliconflow tencent-coding-plan volcengine volcengine-coding-plan
volcengine-agent-plan parallel zenmux litellm kilo mimo
```

## Where a missing mark shows

`providerIconSrc` has exactly one consumer, `ProviderIcon` in `ProviderRail.tsx`,
which three surfaces render: the rail itself, `ProviderDetails`, and
`ProviderOverviewDashboard`. When it returns `undefined` the component falls back
to `ProviderFallbackMark` -- a deterministic hue-per-id initial tile. That
fallback is good; a page of them where competitors show logos is not.

`ProviderCatalog.tsx` is separate and worse: its preset rows draw a title, an
adapter chip and badges, and no mark whatsoever. This is the surface the user
picks a provider FROM, so it is the one place a logo does the most work.

## Sourcing has real targets

Every registry entry carries `baseUrl` and `dashboardUrl`, so no lane has to
guess where a vendor lives. `cerebras` is `cloud.cerebras.ai`, `sambanova` is
`cloud.sambanova.ai`, `nebius` is `tokenfactory.nebius.com`, and so on. Those
URLs are the lane inputs.

Three of the 35 are not independent brands and should be handled as aliases
rather than sourced twice: `zhipu-bigmodel-coding` is `zhipu-bigmodel`,
`volcengine-coding-plan` and `volcengine-agent-plan` are `volcengine`, and
`mimo` is the same Xiaomi MiMo brand as `xiaomi-mimo`.

## Work phases

| Phase | Doc | Deliverable |
|---|---|---|
| wp1 | this unit | Research and roadmap (docs only) |
| wp2 | 010 | Wire the three present-but-unmapped assets + the gap-class guard |
| wp3 | 020 | Aside lane A: sourcing the first half |
| wp4 | 030 | Aside lane B: sourcing the second half, vectorize raster-only |
| wp5 | 040 | Painting contract on the provider surface, measured in both themes |
| wp6 | 050 | Catalog marks + stack delivery |

## Ordering constraint

wp2 depends on nothing but the map and can land first. wp3 and wp4 are
independent of each other and of wp2 -- they only add files and alias rows -- so
they can run as parallel Aside lanes and land as sibling PRs. wp5 depends on both
sourcing lanes, because the mask decision needs the actual assets to measure. wp6
is last because the catalog change should draw the full set, not a partial one.
