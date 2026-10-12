# 020 — TokenLab third Standard sponsor PR

Branch `codex/tokenlab-sponsor`, started on the #6221 head and rebased onto `dev` after 010 lands.
Pattern: #3914 (OrcaRouter, mechanism) and #3915 (PackyCode, second sponsor). Assets come from
TokenLab's corrected pack (`TokenLab-OpenCodex-assets-corrected.zip`), artwork unchanged.

## Diff

- `src/providers/registry/entries-extended.ts` — the `tokenlab` entry gains
  `sponsor: { tier: "standard", url: "https://tokenlab.sh/?utm_source=opencodex&utm_medium=readme" }`
  with a comment naming SPONSORS.md and the signing date. No routing, default or discovery change.
- `assets/sponsors/tokenlab-light.png`, `assets/sponsors/tokenlab-dark.png` — the pack's 500×125
  lockups, unchanged (`-light` = for light page backgrounds, as in the pack). Listed in
  `package.json` `files` beside the OrcaRouter/PackyCode logos.
- `README.md` — third row of the `sponsors:standard` table, in signing order after PackyCode.
  Logo in `<picture>` with a `prefers-color-scheme: dark` source so the dark lockup shows in
  GitHub dark mode; the `<img>` fallback is the light lockup (npm). Text: "Thanks to TokenLab for
  sponsoring this project!", the sponsor's English blurb verbatim, then the picker /
  `ocx provider add tokenlab` line.
- `readme/README.{ko,ja,zh-CN,zh-TW,ru,fr,tr}.md` — the same row, translated like the existing
  rows, image paths `../assets/...`. Keep the README drift gate green.
- `gui/public/provider-icons/tokenlab.svg` — the pack's symbol mark; `gui/src/provider-icons.ts`
  maps `tokenlab` to it, sets the display name, and applies dark-mode treatment like other
  monochrome marks.
- `gui/src/components/provider-workspace/ProviderSponsor.tsx` — replace the hardcoded
  OrcaRouter/PackyCode ternaries with a small brand table so a sponsor is one row; add TokenLab.
  i18n keys `pws.sponsor.tokenlabTitle` / `pws.sponsor.tokenlabDescription` in every
  `gui/src/i18n/*.ts` locale (the closed catalog must stay exhaustive).
- `docs-site/src/content/docs/guides/providers.md` — sponsor paragraph after PackyCode, and the
  base-URL table row if #6221 has not already added it. Translated locales must not contradict it.
- Tests — `tests/providers/sponsor-presets.test.ts` stays generic; the GUI sponsor overview test
  covers the TokenLab card. Respect the file-size ratchet: move rather than grow capped files.

## Verification

## Audit folds (reviewer, NEAR-PASS)

- `desktop/src-tauri/src/provider_icons.rs`: `("tokenlab", "tokenlab.svg")` in `ALIASES`, the same paint
  arm as `MASKED_PROVIDER_ICONS`, and `svg!("tokenlab.svg")` (`gui/tests/provider-icons-native.test.ts`).
- `readme/i18n-manifest.json`: refresh all seven `sourceSha256` values to the new LF-normalized README hash
  (`docs-readme-translation-parity.test.ts`).
- `<picture>` is gate-compatible: only `src=`/`href=` are asset-tracked, so each locale's `<img src>` must be
  `../assets/sponsors/tokenlab-light.png`; include the dark `<source>` too.
- Icon provenance row in `gui/public/provider-icons/README.md`; `structure/dashboard-and-usage.md` owns the
  `ProviderSponsor` description — update it for the brand table.
- Docs: extend the existing TokenLab section in `guides/providers.md` with the sponsor link; do not add a
  second paragraph.
- `SPONSORS.md`: fix the stale "picker follows registry order" and "translated READMEs carry one linking
  line" sentences.
- Branch: after #6221 squashes, move only the sponsor commits onto `dev`
  (`git rebase --onto origin/dev fb565b7c48`).

## Verification (commands)

Focused: sponsor-presets, provider-registry-parity, tokenlab-provider, README drift/translation
gates, GUI sponsor tests, `bun run typecheck`, `bun run lint:gui`, `bun run privacy:scan`,
`bun run structure:check`, `bun run build:gui`. Then `bun run test` or the documented focused
exception. Screenshot of the dashboard sponsor card and picker uploaded to the `pr-assets` branch
and linked by SHA in the PR description, never committed to the PR branch.

## Out of scope

Responses-first adapter and the `X-TokenLab-Delivery-Policy` header (pack `integration-notes.md`).
