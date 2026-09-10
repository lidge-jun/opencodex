# 002 — Audit resolution: the reclassification is the wrong mechanism

Independent adversarial audit of `000`/`010`/`020`/`030` returned **VERDICT: FAIL**
with four blockers. Three are fixable in place. The first invalidates the central
decision, and the roadmap changes rather than arguing with it.

## Blocker 1 (fatal to the original design)

Flipping `authKind` to `oauth` couples the REQUEST path to a credential that
carries no meaning. `src/router.ts:317-318` forces `authMode` from the registry
for oauth entries, and `src/server/responses/core.ts:4323` then always calls
`getValidAccessTokenSnapshot`, which throws `OAuthLoginRequiredError` when no
account set exists (`src/oauth/index.ts:576-578`) and stamps
`apiKey: resolved.accessToken` at `:4401`.

Today a configured `devin-cli` row answers with no opencodex credential at all,
because the child authenticates itself. Under the original plan every turn would
401 until someone clicked Login, and a dashboard logout would break inference
while the CLI stayed signed in. `020`'s boundary forbids touching
`responses/core.ts`, so the plan could not have special-cased its way out.

The audit also killed a claim in `000`: reclassifying does NOT make the row vanish.
`providerTier` only puts the canonical OpenAI forward provider in `accounts`
(`gui/src/provider-workspace/catalog.ts:160-181`), so an oauth preset with a
non-loopback base URL lands in **Paid**, which is rendered. The original
motivation sentence was wrong about the failure mode while being right that the
Accounts tab is unreachable from the preset catalog.

## The corrected mechanism

Accounts-tab admission is `OAUTH_PROVIDERS` membership — `listOAuthProviders()`
is `Object.keys(OAUTH_PROVIDERS)` minus `chatgpt`
(`src/oauth/index.ts:369-371`, `src/server/management/oauth-account-routes.ts:139-140`).
Nothing in that path reads `authKind`.

`authKind: "oauth"` was only needed because `oauthConfig(id)` derives
`providerConfig` through `deriveOAuthProviderConfig`, which filters on it
(`src/providers/derive.ts:350-353`). But `providerConfig` is an ordinary
`OcxProviderConfig` field — it can be built from the registry row directly.

**So: register `devin-cli` in `OAUTH_PROVIDERS` and leave `authKind: "local"`
alone.** The Accounts row appears; the request path keeps seeing a local
provider, demands no token, and behaves exactly as it does today. The
`auth-cors` migration in `020` and its whole new migration module become
unnecessary, because no persisted `authMode` ever mismatches.

This also resolves the honesty problem that made the original design
uncomfortable: opencodex no longer needs a marker to stand in for a bearer
token on the request path, because the request path never asks. The stored
credential exists only so the Accounts row has a state to show.

The residual risk moves to `isOAuthProvider("devin-cli")` becoming true, which
switches on `ocx login` (`src/oauth/login-cli.ts:86-88`), changes `ocx account`
(`src/cli/account-api.ts:83-93`), and admits the row to generic 429 failover
(`src/oauth/generic-account-failover.ts:97-98`). wp2 must prove each of those
three is either intended or inert for a stdio adapter, and `openUrl("")` in the
CLI login path must not be reached.

## Blocker 2 — preset duplication

`dashboardPreset: true` keeps the row in `deriveProviderPresets`
(`src/providers/derive.ts:365`), so it would show on a preset tab as well as
Accounts. Set `dashboardPreset: false`, matching `devin` and `cursor`, and update
the assertion at `tests/providers/devin-cli-adapter.test.ts:33` that currently
pins it true. With `authKind` staying local the preset tab would otherwise be
Free, not Paid, but the duplication is the same defect either way.

## Blocker 3 — login cannot inherit stdio

`010` said to run `devin auth login` with inherited stdio. Dashboard login is
`POST /api/oauth/login` inside the proxy, typically a launchd process with no
TTY. Use kiro's working shape instead: piped spawn with `stdin: "ignore"`
(`src/oauth/kiro.ts:151-156`), surface the CLI's own output through
`ctrl.onProgress`, and treat a login that cannot complete without a terminal as
a reported failure rather than a hang. If the CLI turns out to require a TTY, the
honest end state is an Accounts row that reports signed-in status and tells the
operator to run `devin auth login` in their own terminal — wp2 decides this
against the real binary and records which it was.

## Blocker 4 — wrong label file

Accounts rows use `oauthLabel` → `OAUTH_LABELS[id] ?? id`
(`gui/src/pages/providers-shared.ts:49-59`), not `formatProviderDisplayName`.
Without an `OAUTH_LABELS` entry the row reads `devin-cli`. `030`'s write set
moves from `gui/src/provider-icons.ts` to `gui/src/pages/providers-shared.ts`.

## Structure obligation the plan missed

`structure/AGENTS.md:49` binds changes in `src/oauth/` and `src/providers/` to
`runtime.md`, `subagents.md`, `transports/inventory.md`, and
`providers/xai-grok.md`, not only `adapters/registry.md`. wp4 checks each for a
sentence this change falsifies.

## Effect on the work-phase map

wp2 and wp3 swap emphasis: wp2 still builds `src/oauth/devin-cli.ts` (now with a
piped spawn and no marker-as-bearer concern), wp3 becomes registration plus the
`dashboardPreset` flip and the three `isOAuthProvider` consequences, with the
`authKind` flip and its migration DELETED. wp4 is unchanged apart from the label
file and the structure docs.

