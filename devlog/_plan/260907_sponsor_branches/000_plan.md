# 260907 sponsor branches

Goal: two sponsor branches from `origin/dev` (`8bc9e4ee2`, which carries SPONSORS.md and the README
Sponsors section), each ending in an open PR against `dev`. Neither merges here.

## Shared mechanism (010, applied identically on both branches)

- `ProviderRegistryEntry.sponsor?: { tier: "main" | "standard"; url: string }`.
- `DerivedProviderPreset.sponsor?: "main" | "standard"` via `entryToPreset`.
- `deriveProviderPresets()` keeps registry order; sorting is the picker's job.
- GUI catalog (`provider-presets.ts` + `ProviderCatalog.tsx`): sponsors first, alphabetical by label
  among sponsors (Main before Standard), then the existing usage/label order. Sponsor rows get a
  `Sponsor` chip (`badge-accent`) before the auth badge. i18n key `modal.badge.sponsor` in all
  nine locales.
- CLI `ocx provider presets` prints `(sponsor)` after the label for sponsor rows.
- Tests: derive test for the field, catalog ordering test for pinning + chip.

## OrcaRouter (020)

- Registry: `sponsor: { tier: "standard", url: "https://www.orcarouter.ai/?utm_source=opencodex" }`
  on the existing `orcarouter` entry. PKCE lands separately via #3908 (author akf66), untouched.
- README: first Standard row, uncomment the table. Logo `assets/sponsors/orcarouter.png` (from
  `gui/public/provider-icons/orcarouter.svg` rendered to PNG), blurb from the sponsor if delivered,
  else a neutral maintainer-written 60-word blurb marked for replacement.
- docs-site providers guide: OrcaRouter paragraph in section 3.
- Screenshots: dashboard Providers tab picker with OrcaRouter pinned, README section render.

## PackyCode (030)

- Registry: new `packycode` entry, `openai-chat`, baseUrl `https://cf.api.fan/v1` (from
  docs.packyapi.com Codex/Kimi guides; `/v1/models` answers 401 without a key so the host is live),
  `dashboardUrl https://www.packyapi.com/register?aff=k5KT`, sponsor standard. Model list from
  the docs token groups: Codex group (gpt-5.5, gpt-5.1-codex), CC group (claude), seeded conservatively.
- Icon: `gui/public/provider-icons/packycode.svg` from packyapi.com favicon.
- README: Standard row with the sponsor's EN blurb and the ZH blurb beneath.
- docs-site providers guide paragraph; screenshots as above.

## Order

010 on `sponsors/orcarouter`, cherry-picked to `sponsors/packycode`, then 020 and 030 in
parallel. Each branch: privacy:scan, typecheck, focused tests, push `--no-verify`, PR with template.
