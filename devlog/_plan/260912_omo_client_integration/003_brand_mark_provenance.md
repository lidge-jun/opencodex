# The omo mark

## Source

`gui/public/provider-icons/omo.svg` is `https://omo.dev/brand/omo-mark.svg`
unmodified: 4021 bytes, MD5 `c33f72d7c4612c290834ba860f644557`,
`viewBox="0 0 1024 1024"`. The identical file is committed as
`.github/assets/omo-icon-light.svg` in `code-yeongyu/oh-my-openagent` and
rendered as that README's logo, so the same artwork is both the site header mark
and the repository logo. First-party either way.

**Correction.** The first draft of this doc cited the GitHub raw path on `main`.
That URL 404s: the repository's default branch is `dev`. The asset is real and
the bytes match — verified by downloading both and comparing MD5 — but the
branch in the citation was wrong, which is the kind of unreproducible provenance
the README exists to prevent. Both citations now name a URL that resolves.

The project's SUL-1.0 licence says trademark use is "subject to applicable law"
and imposes no distribution ban of the kind that disqualified an earlier
candidate elsewhere in this directory.

## Rejected candidates

- `https://omo.dev/icon.svg` — a single `<text>O</text>` glyph. The client-mark
  asset test refuses `<text>`, the same rule that sent Hermes to a trace.
- `omo-logo.png` — a superseded 3D rock illustration, and a raster.
- `omo.png` — a landscape screenshot, not a mark.
- The npm tarball carries no `.svg`, `.png`, or `.ico` at all.

## Which maps it joins

`CLIENT_MARKS.omo` — yes.

`MONOCHROME_CLIENT_MARKS` — no. The artwork is two inks: an `#F4F4F4` rounded
plate with an `#041617` face on it. Masking a plated mark discards the plate and
the face together and renders a filled square at 20px, which is the failure the
monochrome set exists to avoid rather than an instance of it.

Provenance is recorded alongside the file in
`gui/public/provider-icons/README.md`, in both the per-file source list and the
masked/not-masked ledger. That was done in wp1 rather than wp3: the asset landed
in this cycle, and an uncited file in that directory is exactly what the README
exists to prevent.
