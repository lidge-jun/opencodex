# wp3 — Aside sourcing lane A

Half the unsourced providers. Lane A and lane B (030) are independent: each only
adds files under `gui/public/provider-icons/`, alias rows, and README entries, so
they can run as parallel Aside dispatches and land as sibling PRs.

## Lane A targets

The registry gives each one a canonical domain, so no lane guesses where a vendor
lives.

| provider | domain to search |
|---|---|
| `cerebras` | cloud.cerebras.ai |
| `together` | together.xyz |
| `deepinfra` | deepinfra.com |
| `sambanova` | sambanova.ai |
| `baseten` | baseten.co |
| `nebius` | tokenfactory.nebius.com |
| `hyperbolic` | hyperbolic.ai |
| `novita` | novita.ai |
| `featherless` | featherless.ai |
| `venice` | venice.ai |
| `chutes` | chutes.ai |
| `nscale` | nscale.com |
| `vultr` | vultr.com |
| `digitalocean` | digitalocean.com |
| `scaleway` | scaleway.com |
| `siliconflow` | siliconflow.cn |
| `litellm` | litellm.ai (BerriAI/litellm) |

## Acceptance per asset

An accepted mark is a square-ish brand mark with real path geometry. Rejected on
sight, with the rejection recorded:

- a `<text>` element standing in for a glyph (the Hermes favicon case: 113 bytes,
  renders per-machine, blank where the font lacks the character);
- a `<image>` or base64 raster inside an SVG wrapper -- that is a PNG wearing a
  costume, and it will not scale or mask;
- a horizontal wordmark where a square slot needs a mark. The rail draws a 19px
  box; a 129x32 lockup renders as an illegible smear. This is what disqualified
  the MiniMax docs asset in the previous unit.

When the vendor publishes only raster -- a favicon PNG, an app icon, an OG image
-- vectorize it. That path is already proven in this repository:
`hermes-agent.svg` is `potrace -s --flat --turdsize 8 --alphamax 1.0` over an
alpha+luma mask, and `gajae-code.svg` is seven k-means colour layers at a 128px
box. Single-ink silhouette takes potrace; multi-colour art takes the layered
trace. Downsample before tracing or upscaled pixel art produces a megabyte of
staircase geometry.

## Naming

`<provider-id>.svg` for a mark that carries its own colour, `<provider-id>-color.svg`
only where the directory's existing convention already uses that suffix for the
same brand. The directory is one flat namespace shared with client marks, so a
name that collides with a client gets the vendor-qualified form (`hermes-agent.svg`
is the precedent).

## Provenance

Every accepted asset gets a README entry: source URL, fetch date, whether it is
the product's mark or the publisher's, every modification made, and every
candidate rejected with the reason. A provider with nothing usable upstream gets
an entry too -- what was searched, what was found, why it was refused -- and keeps
its fallback tile. That is a recorded partial and a legitimate outcome.
