# wp2 — A Meta/Muse mark for the provider catalog

## Current state

`gui/src/provider-icons.ts` maps a provider id to a file under
`gui/public/provider-icons/`. Two ids landed today with no entry:

- `meta-model` — the direct Meta Model API provider.
- `meta-muse` — the Muse Code CLI credential import.

Neither has a row in `PROVIDER_ICON_ALIASES` or `PROVIDER_DISPLAY_NAMES`, so
the dashboard renders them with the generic fallback and an unlabelled id.
Every other first-class provider in that file carries both.

## Change

1. Add `gui/public/provider-icons/meta.svg` — the Meta infinity mark, lifted
   from the `aria-label="Meta symbol"` inline SVG that `dev.meta.ai` renders in
   its own navigation header, read through a signed-in browser session. This is
   the vendor's first-party mark on the vendor's own developer console, which is
   the same provenance standard every other entry in the asset README meets.
   Meta publishes no `favicon.svg` (`dev.meta.ai/favicon.svg` and
   `/icon.svg` both 404; the site's declared icon is a 32x32 `.ico`), so the
   rendered header mark is the best available vector.

   Normalization applied, and nothing else: the three gradient ids are renamed
   from React's generated `_r_d_`/`_r_e_`/`_r_f_` to stable
   `meta-mark-a`/`-b`/`-c` (a generated id collides when several documents are
   inlined), the presentational `height`/`width`/`role`/`aria-label` are
   dropped in favour of the `viewBox`, and `xmlns` is added so the file stands
   alone. Every `d` attribute and every stop colour is verbatim.
2. Alias both ids to it:

   ```ts
   "meta-model": "meta.svg",
   "meta-muse": "meta.svg",
   ```

3. Add display names:

   ```ts
   "meta-model": "Meta Model API",
   "meta-muse": "Muse Code",
   ```

   `meta-muse` is named for what the user recognizes — the Muse Code
   subscription whose credential it imports — not for its config id.
4. The mark carries three linear gradients in Meta brand blue
   (#0064E0 -> #0278F1), so it does NOT join `MASKED_PROVIDER_ICONS`
   (`gui/src/provider-icons.ts:188`) — that set is for single-ink neutral
   artwork that vanishes against one theme, and masking would flatten a
   gradient to one ink. `gui/tests/provider-marks-assets.test.ts` enforces both
   directions, so this is checked rather than asserted.

   (The first draft of this doc named `MASKED_MARKS`, which is the client-side
   set in `gui/src/components/integration-marks.ts`. Audit round 1 caught it.)

## Verification

- `bun run typecheck` (the alias maps are typed `Record<string, string>`; a
  duplicate key is a type-level no-op, so the real check is the test below).
- `bun test tests/provider-icons.test.ts tests/provider-marks-assets.test.ts`
  from `gui/`. The generic checks already cover a missing file and an unwired
  committed asset; an explicit assertion pins the two new ids by intent, the
  way the MiniMax/MiMo rows are pinned.
- Provenance recorded in `gui/public/provider-icons/README.md`. That file is
  the only place a later reader can learn where a mark came from, and an
  undocumented asset is indistinguishable from an invented one.
- `tests/provider-workspace-data.test.ts` needs no change: nothing enumerates
  every registry provider's display name (confirmed in audit round 1).

## Out of scope

Re-theming the catalog, touching other marks, and any docs-site asset.
