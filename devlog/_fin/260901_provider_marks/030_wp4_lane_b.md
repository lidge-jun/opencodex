# wp4 — Aside sourcing lane B

The other half. Same acceptance rules, same vectorization path, same provenance
obligations as 020; this doc records only what differs.

## Lane B targets

| provider | domain to search |
|---|---|
| `zai` | z.ai |
| `zhipu-bigmodel` | bigmodel.cn |
| `volcengine` | volcengine.com (Ark) |
| `tencent-coding-plan` | cloud.tencent.com |
| `nous` | nousresearch.com |
| `nanogpt` | nano-gpt.com |
| `synthetic` | synthetic.new |
| `parallel` | platform.parallel.ai |
| `zenmux` | zenmux.ai |
| `kilo` | kilo.ai |
| `umans` | umans.ai |
| `neuralwatt` | neuralwatt.com |
| `orcarouter` | orcarouter.ai |
| `bizrouter` | bizrouter.ai |

## Aliases, not separate sourcing

Four ids are plan variants of a brand already in this lane and must NOT be
sourced independently -- a second search would either duplicate the file or
produce a different asset for the same company:

| variant | takes the mark of |
|---|---|
| `zhipu-bigmodel-coding` | `zhipu-bigmodel` |
| `volcengine-coding-plan` | `volcengine` |
| `volcengine-agent-plan` | `volcengine` |
| `mimo` | Xiaomi MiMo, wired in wp2 |

This mirrors how `alibaba`, `alibaba-token-plan` and `alibaba-token-plan-intl`
already share one asset: the plan is a billing arrangement, not a brand.

## The two that may legitimately come back empty

`nous` is Nous Research, whose desktop icon was already traced for the Hermes
client mark in the previous unit. If the portal publishes nothing better, reusing
`hermes-agent.svg` is WRONG -- that is the Hermes product mark, not the Nous
company mark, and the registry entry is the company's inference portal. Record
the distinction and prefer an empty result over a misattribution.

`litellm` (lane A) and `parallel` are the other likely empties: one is a
self-hosted proxy whose brand is a docs site, the other's `baseUrl` and
`dashboardUrl` are the same host, which usually means there is no separate
product identity to find.

A recorded empty is a result. Inventing a mark, or borrowing a neighbouring
brand's, is a misattribution that outlives the commit.
