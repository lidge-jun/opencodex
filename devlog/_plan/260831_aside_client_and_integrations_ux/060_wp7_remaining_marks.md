# wp7 — the three remaining marks

Depends on nothing in this unit that is not already merged. Provenance and
conversion parameters are in 005; this document is the diff.

## New assets

`gui/public/provider-icons/minimax.svg` — the MiniMax symbol, fetched not
traced. Two edits to the upstream file: the `<title>资源 2</title>` and the
`data-name` layer wrappers go (authoring-tool residue), and the gradient id
becomes `minimax-wave` so it cannot collide and carries no non-ASCII.

`gui/public/provider-icons/hermes-agent.svg` — one `currentColor` path,
`viewBox="0 0 823 823"`. Named `hermes-agent` rather than `hermes` because
Hermes is also a provider name in this repo and `provider-icons/` is one flat
namespace.

`gui/public/provider-icons/gajae-code.svg` — seven fill layers, largest area
first, `viewBox="0 0 128 128"`-class square box produced by centering the
traced bounds.

## gui/public/provider-icons/README.md

The "Two export clients deliberately have NO mark" section is now false and is
replaced. `gajae` and `hermes` move into the provenance list with their trace
parameters; `mcode` joins them. The section that remains explains the tracing
rule from 005 — a raster may be traced, a wordmark may not be squeezed into a
square slot, and a full-frame silhouette is rejected.

## gui/src/components/apikeys-workspace/client-config-clients.ts

`CLIENT_MARKS` gains three entries:

```ts
hermes: "/provider-icons/hermes-agent.svg",
gajae: "/provider-icons/gajae-code.svg",
mcode: "/provider-icons/minimax.svg",
```

`MONOCHROME_CLIENT_MARKS` gains `hermes` only. `gajae` is seven inks and
`mcode` is a gradient; masking either would flatten it.

The block comment above `CLIENT_MARKS` currently says two clients are absent on
purpose. That is now wrong in a way a reader would trust, so it is rewritten to
state the tracing rule and that every client has a mark.

## Tests

`gui/tests/client-marks-assets.test.ts` already covers more than the plan
originally credited it with. It asserts file existence, README provenance, the
no-`<text>`/no-`<image>`/must-have-geometry rule, that no multi-color mark is
masked, that the four known-invisible marks ARE masked, and that `dsh` is not.
Every one of those extends to the three new files without an edit, so the
"new guard: no `<text>` element" the plan proposed would have been a duplicate
of an existing test rather than new coverage.

What is genuinely uncovered is the completeness of the map. Nothing asserts that
every id in `CLIENTS` has a mark, so an entry dropped in a merge degrades to a
monogram silently and looks identical to a client that never had one. That guard
is new, and it was driven red by removing the `mcode` entry.

Second new guard: a traced mark must record its raster source and its tracer
invocation in the README. A fetched mark has a URL to check; a traced one has
nothing to reproduce it from unless the parameters are written down. Driven red
by replacing the word `potrace` in the README.

The mask-set expectations do need extending: `hermes` joins the pinned list of
marks that must be masked, while `gajae` and `mcode` are caught by the existing
multi-color assertion the moment they are added to the set by mistake.

## Verification

`cd gui && bun test tests/client-marks-assets.test.ts` plus the mask guard.
A 20px render of each new mark on `#ffffff` and on `#0d1117`, which is the check
that caught the Hermes dark-mode invisibility in the first place.
