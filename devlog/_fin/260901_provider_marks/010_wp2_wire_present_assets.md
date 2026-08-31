# wp2 — wire the assets that are already committed

Three providers render an initial tile while their artwork sits in the repo. No
sourcing, no tracing, no vendor site: three map rows and a guard.

## The change

`gui/src/provider-icons.ts`, in `PROVIDER_ICON_ALIASES`:

```ts
  minimax: "minimax.svg",
  "minimax-cn": "minimax.svg",
  "xiaomi-mimo": "xiaomi-color.svg",
```

`minimax` and `minimax-cn` are one brand on two endpoints (`api.minimax.io` and
`api.minimaxi.com`), the same way `alibaba` and `alibaba-token-plan-intl`
already share `alibaba-color.svg`. `xiaomi-mimo` is Xiaomi's MiMo endpoint and
`xiaomi-color.svg` is already wired for `xiaomi` and `mimo-free`.

`mimo` (the token-plan id) belongs here too by the same argument, and takes
`xiaomi-color.svg`.

## The guard, and why this class needs one

The defect is not that someone forgot a row. It is that nothing could tell them:
`CLIENT_MARKS` and `PROVIDER_ICON_ALIASES` are different maps over different key
spaces, so committing `minimax.svg` for the client left no signal that the
provider of the same name was still bare.

New test, `gui/tests/provider-icons.test.ts`:

1. **Every registry id whose brand asset exists on disk is wired.** For each
   provider without an alias, probe `<id>.svg`, `<id>-color.svg`, and the same
   two for the id's first dash-segment. A hit is a failure with the filename
   named, because it means the artwork is present and the map is stale.
   Falsify by deleting the `minimax` row.
2. **Every alias points at a file that exists.** A typo'd filename renders a
   broken image, which is worse than the fallback tile it replaced. Falsify by
   pointing one alias at a name that is not committed.

Test 1 is the one that matters: it is the only thing that would have caught this
gap, and it will catch the next one automatically as wp3/wp4 add assets.

## Out of scope here

No new artwork, no README changes (nothing new is sourced), no painting-mode
decisions -- `minimax.svg` is a gradient wave and `xiaomi-color.svg` is
multi-colour, so both stay images under the existing rule.
