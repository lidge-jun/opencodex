# wp5 — the painting contract on the provider surface

Depends on both sourcing lanes: the mask decision is a property of the artwork,
so it cannot be made before the artwork exists.

## The rule, and its record of shipping broken

A mark is drawn one of two ways. As an image it keeps its own colour, which is
correct for multi-colour art and for a single ink that IS the brand. As a themed
mask the file is used as a shape and filled with the surrounding text colour,
which is correct for a neutral silhouette that would otherwise vanish against one
of the two surfaces.

Getting this wrong is not hypothetical. It has shipped four times: `prime`
(white on transparent, invisible in light mode), `opencode` (#211E1E) and `kimi`
(#1A1A1A) invisible in dark, and then `grok` (#000000, ~1.9:1 on the dark card),
which survived two passes over the same file because a code comment argued it
away instead of measuring it.

## What the provider surface does today

`ProviderIcon` renders `<img src={src}>` unconditionally. There is no mask path
at all, so a neutral silhouette added by wp3/wp4 is invisible in one theme with
no mechanism to fix it short of editing the vendor's file.

The client side already solved this in `ClientMark` + `MASKED_MARKS`. The
provider side needs the same two-branch decision, and the sets must stay
DERIVED rather than restated -- two hand-maintained lists of the same fact drift,
and the drift is a mark masked on one surface and not another.

## The change

1. `provider-icons.ts` grows a masked-set export, keyed by asset path exactly as
   `MASKED_MARKS` is, so an asset reachable from both surfaces cannot be masked on
   one and not the other.
2. `ProviderIcon` branches on it: masked assets render a `<span>` with
   `mask-image` and `background: var(--text)`; everything else stays an `<img>`.
   The fallback tile is untouched.
3. The luminance guard from `gui/tests/integration-marks.test.ts` is generalized
   to cover provider assets: any single-ink, near-neutral mark (channel spread
   <= 24, luminance outside 0.12-0.75) that is NOT masked fails, and any
   multi-colour or gradient mark that IS masked fails.

## Verification is measurement, not reading

A hex string does not tell you what the user sees; the surface colour is half the
equation. Drive a headless browser over the built GUI, emulate
`prefers-color-scheme` light and dark, read `getComputedStyle` for each mark and
for the surface behind it, and compute the contrast ratio. Capture desktop (1440)
and mobile (390) in both themes.

That procedure is what found grok at 1.9:1 after two passes had declared it
acceptable. Any provider mark landing under 3:1 against its own surface is a
defect regardless of what the file's colours suggest.

## Three things the audit corrected in this doc

**The surface is the tile, not the page.** `.provider-icon` is a 31px tile with
`background: var(--raised)` and a border, so a provider mark is measured against
`light-dark(#f4f4f4, #303030)` -- not against the card or page background the
client marks sit on. Same numbers by coincidence today, different variables
tomorrow; the measurement must read the tile's computed background rather than
assume the client surface.

**The tile already sets `color: var(--text)`.** That is what a `mask` branch needs
for `background: var(--text)` to resolve correctly, so the mask path costs one
rule and no new custom property.

**A third painting mechanism already exists and must not become a fourth.**
`.usage-source-mark--mono` on the Usage page uses `filter: invert(1)` under a dark
theme -- a different technique from `ClientMark`'s CSS mask, applied to the same
`grok.svg` this repository just masked on the Integrations page. Inverting is not
equivalent: it maps #000 to #fff rather than to `--text`, and it inverts any
colour present rather than recolouring a silhouette. wp5 either brings that
call site onto the shared decision or documents why Usage differs. What it must
not do is add a third spelling of the same idea.
