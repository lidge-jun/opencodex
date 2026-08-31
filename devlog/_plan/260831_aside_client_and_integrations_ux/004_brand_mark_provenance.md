# First-party marks for the clients showing a monogram

`CLIENT_MARKS` (`gui/src/components/apikeys-workspace/client-config-clients.ts`)
covers 2 of 11 clients. The other nine render
`<span className="awi-clientconfig-monogram">{label.slice(0, 1)}</span>`
(`ClientConfigRow.tsx:91`).

The file's own rule: "a client with none falls back to a monogram tile rather
than borrowing another product's logo." So every entry below needs a mark that
belongs to that product, verified, or it stays a monogram.

## Verified sources

Each URL below was fetched in a real browser session on 2026-08-31 and returned
the content-type shown. This is live evidence, not a guess from a repo comment.

| Client | Product | Asset | Type |
|---|---|---|---|
| `omp` | Oh My Pi (`can1357/oh-my-pi`) | `https://omp.sh/favicon.svg` | `image/svg+xml` |
| `hermes` | Hermes Agent (`NousResearch/hermes-agent`) | `.../hermes-agent/main/website/static/img/favicon.svg` | `image/svg+xml` |
| `openclaw` | OpenClaw (`openclaw/openclaw`) | `.../openclaw/main/ui/public/favicon.svg` | `image/svg+xml` |
| `dsh` | DeepSeek Harness (`deepseek-ai/deepseek-harness`) | `.../deepseek-harness/master/website/public/favicon.svg` | `image/svg+xml` |
| `prime` | Prime Agent (`PrimeIntellect-ai/prime-agent`) | `.../prime-agent/main/assets/brand/prime-butterfly.svg` | `image/svg+xml` |
| `zcode` | ZCode (Z.ai) | `https://z-cdn.chatglm.cn/z-ai/static/logo.svg` | recorded in `_fin/260705` notes |

Two answers that settled open questions:

**`dsh` is first-party DeepSeek.** The repo never named a publisher, which is
why `deepseek-color.svg` could not simply be reused. Live check: DeepSeek
publishes `deepseek-ai/deepseek-harness` and scopes its packages
`@deepseek-ai/dsh-*`. The bare npm `dsh` package is unrelated
(`infusion/node-dsh`, 2016). So the harness has its own first-party favicon and
we use that rather than the provider logo.

**`prime` has its own mark.** The `prime-butterfly.svg` in the prime-agent repo
resolves the note in `config-export.ts` that Prime is "the pi coding agent
shipped under a different brand" — the brand has an asset, so `pi.svg` must not
be reused for it.

## Reuse instead of fetching

`kimi`: `gui/public/provider-icons/kimi-color.svg` is already committed and is
the same Moonshot AI brand as the Kimi Code client
(`_fin/260705_provider-quota-dashboard/svg-candidates/manifest.json:41`). Point
the client at the existing asset; add no file.

## Not resolved

`gajae` (Gajae Code, `Yeachan-Heo/gajae-code`) publishes a mascot PNG, a
vertical logo PNG, and a base64 PNG favicon — no SVG anywhere, and the npm
package ships no icon. Every committed asset in `provider-icons/` is SVG.

wp5 keeps `gajae` on the monogram and records the reason here. A PNG could be
committed, but it would be the only raster mark in the set and would not scale
with the 20px `<img>` at other densities. This is the one BLOCKED item in the
unit, and it is blocked on the upstream project having no vector mark rather
than on anything we can fix.

## Aside's own mark

Aside ships `/Applications/Aside.app/Contents/Resources/app.icns`, which is a
local macOS icon resource rather than a distributable brand asset, so wp5 checks
for a first-party web asset the same way as the others before assigning one. If
none is verified, Aside launches on the monogram and gains its mark later —
a missing mark must not block the client.

## README obligation

`gui/public/provider-icons/README.md` records provenance per asset, following
the `pi.svg` precedent: asset name, fetch date, source URL, what the project is,
and whether it was modified. Its licensing note points at
`devlog/_plan/260705_provider-quota-dashboard/...`, which has since moved to
`_fin/` — wp5 fixes that stale path while it is in the file.
