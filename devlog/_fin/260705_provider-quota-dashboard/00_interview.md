# Interview — Provider quota dashboard

## Current ask

Add quota reporting for every quota-capable provider already available from the
local quota sources (`../jawcode` and `../cli-jaw`), but display only providers
with an active quota result.

The quota UI belongs on the Providers page, directly under each provider card.
The visual format must match the current Codex Auth pool quota rows exactly:
same compact row layout, reset labels, bar, color rules, and percentage value.

## Classification

- Work class: C4 for auth/quota surfaces, with C3 UI integration.
- Loop archetype: spec work. Done is verifier-defined: endpoint returns normalized
  quota reports for supported logged-in providers, the Providers page renders only
  successful quota windows under matching active provider cards, and tests cover
  auth/normalization/display behavior.

## Known decisions

- Location: `gui/src/pages/Providers.tsx`, below each provider card.
- Display rule: hide inactive or unsupported quota reports from the UI.
- UI contract: reuse/refactor the existing Codex Auth `QuotaBars` / `QuotaRow`
  presentation instead of reimplementing a second copy.
- Provider scope: include all available adapters, but only quota-capable and
  successfully fetched results appear.
- Source scope: port provider quota logic from `../jawcode` first, then use
  `../cli-jaw` reverse quota routes where jawcode has no real quota provider.
- Branding: provider logos/icons may be added where available from `../cli-jaw`,
  but quota row layout remains the pool quota layout.

## Contradictions resolved

- "Active" means a live quota result with at least one percent/window value, not
  merely an enabled configured provider.
- "All providers" means all adapters are implemented or explicitly classified,
  not that every configured provider renders an empty row.
- "Same as pool" means same quota row component and CSS contract, with provider
  windows normalized into the same row shape.

## OPEN ASSUMPTIONS

- API-key-only providers generally cannot expose subscription quota unless their
  upstream has a documented quota endpoint; they should return no active quota.
- Reverse-engineered providers such as Kiro/Cursor/Antigravity must be flagged in
  backend metadata even if the UI hides failed/inactive reports.
- Provider-specific quota windows that are not named `5h`, `weekly`, or `monthly`
  may still use the same row layout with their own label if they carry a percent
  and optional reset timestamp.
- Cursor dashboard quota requires dashboard/session credentials, not just a
  normal Cursor model login; it should stay inactive unless the required local
  credential exists.

## Evidence

- Current pool quota presentation lives in `gui/src/pages/CodexAuth.tsx`.
- Shared styling lives in `gui/src/styles.css` under `.quota-compact` and
  `.quota-row`.
- opencodex OAuth providers include xAI, Anthropic, Kimi, Kiro,
  google-antigravity, Cursor, and ChatGPT in `src/oauth/index.ts`.
- Existing opencodex quota code is ChatGPT/Codex-account specific: WHAM usage
  for main/pool accounts. There is no generic provider quota backend yet.
- `../jawcode/packages/ai/src/usage` has quota/usage providers for Claude,
  Gemini, GitHub Copilot, Google Antigravity, Kimi, MiniMax, OpenAI Codex, xAI,
  and ZAI, with MiniMax acting as a non-capable stub.
- `../cli-jaw/src/routes` has reverse quota routes for Kiro, Cursor dashboard,
  OpenCode Go, and Antigravity.

## Final rescan

Remaining high contradictions: none.

Medium risks carried into Plan:

- Normalizing heterogeneous provider windows into the pool row format can lose
  provider-specific units unless metadata is preserved.
- Some providers require local CLI state or reverse-engineered endpoints, so
  tests must isolate network fetches and credential reads.
- The existing quota component is local to Codex Auth; Plan must extract it
  before UI integration to prevent display drift.
- opencodex's registry has a `local` preset concept, but runtime auth mode is
  only key/forward/oauth. Reverse/local quota readers must be explicit quota
  adapters, not assumed to exist as a provider auth mode.
