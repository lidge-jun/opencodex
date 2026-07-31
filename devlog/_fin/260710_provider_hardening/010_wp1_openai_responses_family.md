# 010 — WP1: openai-responses family (openai, openai-apikey, azure-openai)

Loop-spec: archetype=spec-satisfaction repair; trigger=user hardening request;
goal=WP1 providers fail loudly/narrowly with current model data; non-goals=new
fallback layers, oauth flow changes, gui; verifier=`bun x tsc --noEmit` +
`bun test ./tests/` + targeted new tests; stop=C green; memory=this doc +
goalplan ledger; terminal=DONE or NOOP-per-provider; escalation=NEEDS_HUMAN if
a registry data change would break subscription contracts.

## Findings (code read 2026-07-10)

1. **azure.ts dead branch** ([azure.ts:24](../../src/adapters/azure.ts)):
   `if (!url.includes("/v1/"))` can never fire — the inner
   `createResponsesPassthroughAdapter` non-forward path always emits
   `${base}/v1/responses`. The api-version query fallback is unreachable by
   construction (verified: registry baseUrl `https://{resource}.openai.azure.com/openai`
   -> `.../openai/v1/responses` contains `/v1/`). Dead fallback => remove.
2. **Unresolved template placeholders pass config validation**: `new URL()` parses
   `https://{resource}.openai.azure.com/openai` and the cloudflare `{account-id}`
   URL fine (bun repro, PARSES). A user saving the preset unedited gets a late
   runtime DNS/404 failure instead of a config-time error.
3. **azure missing apiKey is silent**: adapter omits auth header entirely -> opaque
   upstream 401 instead of a loud local error.
4. **Model data**: openai + openai-apikey lineups UNVERIFIED per 001 research
   (docs redirect) => FREEZE, record NOOP evidence. No registry model edits in WP1.

## Diff-level changes (IN) — AMENDED after A-round 1 (Planck, GO-WITH-FIXES x2)

Audit synthesis (round 1):
- Blocker 1 (accepted): api-version branch IS reachable via custom-named provider
  with adapter azure + authMode "forward" (inner emits `${baseUrl}/responses`, no
  /v1/). Fix: azure adapter REJECTS forward mode loudly; then the branch is dead
  by construction and removed.
- Blocker 2 (accepted): config-load placeholder rejection would back-up/reset
  existing configs (loadConfig fallback) AND router forces registry placeholder
  baseUrl over the user's fixed baseUrl for registry-named azure/cloudflare
  entries — user cannot even fix it. Move rejection to request-build time; make
  router respect user baseUrl only when the registry baseUrl carries an
  unresolved placeholder (template entries are presets, not canonical endpoints).

Changes:
- MODIFY src/adapters/azure.ts:
  1. Throw at adapter build/buildRequest when `provider.authMode === "forward"`:
     azure-openai has no OAuth-forward mode ("azure-openai does not support
     forward auth mode").
  2. Throw when resolved URL still contains `{`/`}` placeholder segments:
     "baseUrl contains unresolved {placeholder} — set your real resource URL".
  3. Throw when apiKey absent/blank ("azure-openai requires a non-empty apiKey").
  4. Remove api-version query branch (now provably dead: non-forward inner always
     emits /v1/; forward is rejected). Keep explanatory comment.
- MODIFY src/router.ts `routedProviderConfig`: when
  `registryEntry.baseUrl` contains an unresolved `{placeholder}` AND the user
  config supplies a valid non-placeholder baseUrl, keep the user's baseUrl
  (narrow condition; all other registry entries keep forced canonical baseUrl).
- MODIFY src/config.ts: NO hard rejection. Add placeholder warning to the
  existing diagnostics path only (non-fatal), matching "diagnoses config with
  unsafe provider URLs" convention.
- ADD tests/azure-adapter.test.ts: api-key header swap (Authorization removed),
  URL shape `/openai/v1/responses` with no api-version param, missing-key throw,
  forward-mode throw, unresolved-placeholder throw (activation scenarios).
- MODIFY tests/ (router coverage file or new case): registry-named azure-openai
  with user baseUrl `https://myres.openai.azure.com/openai` routes with the USER
  baseUrl; non-template providers still get canonical registry baseUrl.

## OUT

- No changes to repairOrphanedInputItems/strip* passthrough repairs (existing,
  documented protocol-compat guards — narrow, not fallback chains; removing them
  breaks forward mode).
- No registry model edits (freeze evidence: 001_research_frontier.md).

## Activation scenarios (C-ACTIVATION-GROUNDING-01)

- Placeholder rejection: azure adapter test builds with the unedited preset
  baseUrl -> buildRequest throws naming the placeholder.
- Forward-mode rejection: azure adapter test with authMode "forward" -> throws.
- Router template respect: routed config test proves user baseUrl survives for
  azure-openai and cloudflare-ai-gateway, while e.g. anthropic keeps canonical.
- Missing-key throw: azure test builds adapter without apiKey -> buildRequest throws.
- Dead-branch removal: azure test asserts final URL contains `/openai/v1/responses`
  and NO `api-version` query; forward-mode rejection makes the old branch
  unreachable by construction before removal.

## Accept criteria

- `bun x tsc --noEmit` clean; `bun test ./tests/` green including new tests.
- rg proof: no new `fallback`-style branch added in the WP1 diff.
- NOOP evidence recorded for openai/openai-apikey model data.
