# Plan — Provider quota dashboard

## Goal

Show live quota rows under each active provider card on the Providers page,
using the exact same compact quota display as the Codex Auth pool account rows.

## Non-goals

- Do not show empty quota placeholders for unsupported providers.
- Do not poll quota on every request.
- Do not expose raw quota response bodies or secrets in the GUI/API payload.
- Do not make API-key-only providers look quota-capable when only token usage is
  available.

## Data contract

Add a normalized provider quota report shape:

- `provider`: configured provider id, e.g. `xai`, `anthropic`, `kiro`.
- `label`: display name.
- `source`: stable adapter/source id.
- `quota`: pool-compatible row data:
  - `fiveHourPercent?`, `fiveHourResetAt?`
  - `weeklyPercent?`, `weeklyResetAt?`
  - `monthlyPercent?`, `monthlyResetAt?`
  - `customWindows?` for percent/reset rows that do not map cleanly to the
    three Codex Auth windows.
- `updatedAt`.
- `capable`: internal/debug capability flag.
- `reverseEngineered?`: true for local/reverse sources.
- `inactiveReason?`: retained in API/debug payload only; not rendered as a row.

The Providers page renders only reports where `quota` has at least one
percentage window.

## Provider phases

### Phase 1 — jawcode-style OAuth quota

Port/adapt quota providers that map naturally to opencodex OAuth credentials:

- Anthropic Claude OAuth.
- xAI/Grok OAuth.
- Kimi OAuth, if the jawcode endpoint still works with opencodex credentials.
- Google Antigravity OAuth/CLI-backed usage where available.
- ChatGPT/OpenAI Codex by reusing the existing WHAM quota path.

### Phase 2 — reverse/local quota sources

Add provider-specific adapters from `../cli-jaw` where jawcode has no default
usage provider:

- Kiro via CodeWhisperer `GetUsageLimits`.
- Cursor dashboard quota only when the dashboard/session credential exists.
- OpenCode Go usage API if reachable.
- Antigravity reverse route if the CLI path is the only reliable source.

### Phase 3 — classification-only providers

Register providers known to be non-capable or unavailable:

- MiniMax Coding Plan: authenticated but no exposed quota API.
- API-key-only variants where no subscription quota endpoint exists.

These return inactive results and do not render on provider cards.

## Backend implementation

1. Add `src/provider-quota/` with shared types, normalization helpers, cache, and
   provider adapter registry.
2. Reuse existing OAuth token resolution from `src/oauth/index.ts`; do not create
   new token storage.
3. Treat the existing ChatGPT/Codex WHAM quota path as the first adapter, not as
   a generic provider quota system.
4. Add a cached endpoint, likely `GET /api/provider-quotas?refresh=1`, returning
   redacted normalized reports.
5. Use short timeout, bounded concurrency, 5-minute cache, and last-good fallback.
6. Keep raw upstream bodies out of the normal API response.
7. Treat credential expiration as inactive plus refresh/reauth metadata, not as a
   hard server failure.
8. Implement reverse/local readers as quota adapters that read their required
   local state explicitly; do not model them as a new `authMode: "local"` at
   runtime.

## Frontend implementation

1. Extract `QuotaBars`, `QuotaRow`, reset formatting, and quota types from
   `gui/src/pages/CodexAuth.tsx` into a shared GUI module.
2. Keep the existing `.quota-compact` and `.quota-row` CSS contract unchanged.
3. Fetch provider quota reports in `gui/src/pages/Providers.tsx`.
4. Under each provider card, render the shared quota component only when that
   provider has a successful quota report.
5. Add a Providers-page quota refresh action if needed, but avoid noisy status
   text inside each card.
6. Add provider logos/icons only as card decoration when assets are already
   available and do not alter the quota row layout.

## Documentation

Update docs to describe:

- Which providers can report quota.
- Which credential type is required.
- Which sources are reverse-engineered.
- Why unsupported providers are hidden rather than shown as empty quota rows.

Candidate docs:

- `docs-site/src/content/docs/ko/guides/web-dashboard.md`
- `docs-site/src/content/docs/index.mdx`
- README provider/auth section if provider quota becomes a headline feature.

## Tests

Backend:

- Normalization tests for xAI, Anthropic, Kiro, and inactive providers.
- Endpoint tests for redaction, caching, refresh bypass, failed adapter isolation,
  and logged-in-only behavior.
- Credential-mode tests: OAuth capable, API-key inactive, missing credential
  inactive.

Frontend:

- Shared quota component tests preserve pool display behavior.
- Providers page renders quota rows only under matching provider cards.
- Inactive/unsupported reports do not render.
- Existing Codex Auth page still renders pool quota rows unchanged.

## Verification commands

- `bun test`
- `bun run typecheck`
- `cd gui && bun run build`

## Acceptance

- xAI and Anthropic logged-in OAuth providers show quota rows below their cards
  when upstream quota fetch succeeds.
- Existing ChatGPT/Codex main/pool quota behavior continues to work and can feed
  provider-card quota for the `openai`/`chatgpt` providers.
- Kiro shows quota only when local Kiro auth/profile state can fetch
  `GetUsageLimits`.
- Unsupported or failed providers are absent from the Providers card UI.
- Codex Auth pool quota display is visually unchanged.
- No raw secrets or raw quota payloads are exposed through the dashboard API.
