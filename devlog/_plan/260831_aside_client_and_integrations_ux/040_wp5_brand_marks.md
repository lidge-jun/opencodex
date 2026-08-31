# wp5 — Brand marks

Sources verified live in 004. Independent of wp2/wp3; branches off `dev`.

## Assets to add

Fetched into `gui/public/provider-icons/`, each verified `image/svg+xml`:

Fetched 2026-08-31, each verified as real vector markup with `xmllint` and a
render probe:

| File | Client | Source | Bytes | viewBox |
|---|---|---|---:|---|
| `oh-my-pi.svg` | `omp` | `https://omp.sh/favicon.svg` | 434 | `0 0 64 64` |
| `openclaw.svg` | `openclaw` | `openclaw/openclaw` `ui/public/favicon.svg` | 3271 | `0 0 120 120` |
| `deepseek-harness.svg` | `dsh` | `deepseek-ai/deepseek-harness` `website/public/favicon.svg` | 3546 | `0 0 50 50` |
| `prime-agent.svg` | `prime` | `PrimeIntellect-ai/prime-agent` `assets/brand/prime-butterfly.svg` | 4105 | `0 0 178 178` |
| `zcode.svg` | `zcode` | `https://z-cdn.chatglm.cn/z-ai/static/logo.svg` | 11037 | `0 0 30 30` |

Five, not six. `hermes` is covered below.

Named after the PRODUCT, not the client id, matching `opencode.svg` and
`pi.svg`. Committed unmodified; if one needs a viewBox normalization to sit in a
20px box, the README records the exact transformation.

`prime-agent.svg` and `zcode.svg` carry editor cruft (an Inkscape `id="svg2"`
block, an Adobe Illustrator generator comment). Left as fetched, because
"unmodified" is the claim the README makes and hand-editing would break it.

## Rejected: the Hermes favicon

`NousResearch/hermes-agent` `website/static/img/favicon.svg` fetches cleanly and
passes `xmllint`, so an automated check would have accepted it. Its entire body:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <text y=".9em" font-size="90">U+2695</text>
</svg>
```

113 bytes drawing one unicode glyph as text. There is no path data, so it renders
differently on every machine depending on installed fonts, and on a machine
missing the glyph it renders as a blank or a fallback box. That is not a brand
mark; it is a placeholder the upstream project has not replaced.

`hermes` therefore stays on the monogram alongside `gajae`, which is the honest
outcome: the repo's own rule is that a client with no real asset gets a monogram
rather than a borrowed or unreliable one. Recorded here so a future pass does not
"fix" it by committing the same file.

## Reuse, no new file

`kimi` points at the committed `kimi-color.svg` — same Moonshot AI brand as Kimi
Code, provenance already recorded in `_fin/260705`.

## Staying on the monogram

`gajae`: Gajae Code publishes only raster marks (mascot PNG, vertical logo PNG,
base64 PNG favicon) and its npm package ships no icon. Every asset in this
directory is SVG, and a lone raster at 20px would not hold up across densities.
Blocked upstream, recorded in 004; revisit if the project ships a vector.

`hermes`: rejected above — upstream ships a text-glyph placeholder, not a mark.

`aside`: `aside.com/favicon.svg` returns 404 and only `favicon.ico` exists
(`image/vnd.microsoft.icon`). The app bundle carries `app.icns`, a local macOS
resource rather than a distributable web asset. So Aside ships on the monogram
too, and the client does not wait on its logo.

Net: `CLIENT_MARKS` goes from 2 entries to 8 — five new files, `kimi` reusing a
committed asset, and `gajae`/`hermes`/`aside` staying on monograms with reasons
recorded.

## client-config-clients.ts

`CLIENT_MARKS` gains `omp`, `openclaw`, `dsh`, `prime`, `zcode`, and `kimi`. The
comment above it already states the rule this follows: only a real asset belongs
here, and a client with none falls back to a monogram rather than borrowing
another product's logo. All three exceptions honor that.

## README

One provenance entry per new asset, following the `pi.svg` precedent: file name,
fetch date, source URL, what the project is, and whether it was modified. Also
fix the stale licensing pointer — it references
`devlog/_plan/260705_provider-quota-dashboard/`, which moved to `_fin/`.

## Verification

`bun test gui/tests/client-config-panel.test.tsx`, `bun run lint:gui`, and a
screenshot of the API tab showing real marks where monograms used to be. Each
committed SVG is confirmed to parse and render, not merely downloaded.
