# wp4 — `meta-muse` OAuth provider, import-only, behind a ToS warning

Branch `codex/meta-muse-device-oauth`, base `dev` at `ff1ac6b8c`. One PR.

Evidence: `003`. Authorization: the repository owner completed the login and payment
himself and asked for this to ship with a warning.

Revised after A-gate rounds 1 (FAIL, 5) and 2 (FAIL, 5). Fixes are marked `[A1]`…`[B5]`.

Round 2 also arrived with a **user-supplied disproof of my own research**: Meta *does*
expose quota, as a `response.subscription_usage` SSE event on streaming turns. My earlier
"no quota surface exists" came from non-streaming probes only. `003` §E is corrected and
§G records the method failure. What that enables is scoped at the end of this doc.

## Shape

**Import-only, macOS-only.** `[A2]` The first draft proposed spawning `muse login` and
polling for the credential file. That is unshippable for three reasons the reviewer
verified: the pointer file already exists, so "poll until it appears" returns instantly
with the *old* account on a force-login; `muse login` has no non-interactive mode, so a
spawned TUI can outlive cancellation; and the Keychain read is darwin-only, so on
Linux/Windows the spawn could succeed and the import still fail.

So the provider reads an existing credential and never spawns anything. If none is
present it fails with instructions.

## MODIFY `src/providers/registry.ts`

One entry after `meta-model`, reusing every `META_MUSE_*` constant #3321 introduced
(no duplication):

```ts
  {
    id: "meta-muse",
    label: "Meta Muse Code (CLI credential)",
    adapter: "openai-responses",
    baseUrl: "https://api.meta.ai/v1",
    authKind: "oauth",
    oauthId: "meta-muse",
    defaultModel: "muse-spark-1.3",
    models: META_MUSE_MODELS,
    liveModels: false,          // live roster carries image + voice rows (003 §C)
    modelContextWindows: Object.fromEntries(META_MUSE_MODELS.map(id => [id, META_MUSE_CONTEXT_WINDOW])),
    modelInputModalities: Object.fromEntries(META_MUSE_MODELS.map(id => [id, ["text", "image"] as ["text", "image"]])),
    modelReasoningEfforts: Object.fromEntries(META_MUSE_MODELS.map(id => [id, META_MUSE_REASONING_EFFORTS])),
    modelReasoningEffortMap: Object.fromEntries(META_MUSE_MODELS.map(id => [id, META_MUSE_REASONING_EFFORT_MAP])),
    note: "Reuses the API key the Muse Code CLI stores after `muse login` (macOS only; requires the CLI installed and signed in). Meta scopes that credential to the Muse Code CLI, so this is an UNSUPPORTED use: Meta does not authorize subscription coverage outside its own CLI, how these calls settle is not observable from the API, and you should treat every call as billable against your account. Meta reports subscription window usage inside streaming responses, but opencodex does not yet read or display it, and there is no endpoint to query it on demand. Rate limits apply per team, not per key. For a supported path use the meta-model provider with your own key (export it as META_MODEL_API_KEY).",
  },
```

`label` is stated explicitly `[A5]`, and the GUI needs its own entry `[B4]`: account rows
render `OAUTH_LABELS` in `gui/src/pages/providers-shared.ts`, so a registry `label` alone
leaves the raw id `meta-muse` on screen. Add `"meta-muse": "Meta Muse Code (CLI)"` there.

Three corrections to that `note`, from round 2:

- **Billing is stated as unobservable, not settled** `[B3]`. The vendor text proves the
  credential is CLI-scoped and that *separately created* keys are pay-as-you-go. It does
  not prove how this CLI-minted key settles when replayed elsewhere, and `003` §E found
  no billing surface to check. Asserting "bills pay-as-you-go" as fact would hand the
  user false certainty about which balance is charged; "treat every call as billable" is
  both honest and safe.
- **`META_MODEL_API_KEY`, not `MODEL_API_KEY`** `[B5]` — the exact env-name trap
  CodeRabbit caught on #3321. Repeating Meta's own name would send a user to export a
  variable opencodex never reads.
- The quota sentence states only what wp4 ships `[C2]`: that Meta emits the data and
  opencodex does not yet surface it. Promising that opencodex can show the last observed
  percentages would advertise wp5 work in wp4 documentation.

## NEW `src/oauth/meta-muse.ts`

```
MUSE_POINTER   = ~/.config/muse/auth.json
KEYCHAIN_SVC   = "ai.meta.dev.credentials"
KEYCHAIN_ACCT  = "meta"
```

`loginMetaMuse(ctrl)`:

1. `process.platform !== "darwin"` → throw naming the limitation. `[A2]`
2. Read the pointer. Require `providers.meta.mechanism === "oauth"` and
   `storage === "keychain"`; a different `storage` means a shape we have not measured, so
   refuse rather than guess. `[A1]`
3. `security find-generic-password -s <svc> -a <acct> -w` — same mechanism as
   `readClaudeKeychain` in `local-token-detect.ts`, 5s timeout, stderr piped.
4. Parse; take `api_key`. Reject anything that is not `LLM|`-prefixed. **Never**
   `access_token` — it 401s (`003` §B).
5. `sanitizeApiKeyValue()` from `src/providers/api-keys.ts`. `[A1]`
6. Validate live: `GET /v1/models` must return 200.
7. Return `{ access: key, refresh: key, expires: Number.MAX_SAFE_INTEGER,
   email: normalizedEmail, source: "local-cli" }`.

`email`, **not** `accountId` `[A1]` — `src/oauth/index.ts` masks `email` for display, and
`store.ts` already falls back to `email` for slot identity, so the masking path is kept
and multi-account identity still works.

`refreshMetaMuseToken(token)` `[B2]` returns the supplied token unchanged with
`Number.MAX_SAFE_INTEGER`, exactly as `refreshCommandCodeToken` does. It must **not**
re-import from the Keychain: generic refresh writes its result into the slot being
refreshed, so if the user switched Muse accounts in between, a different identity would
silently overwrite the existing slot. Only an explicit login may import.

The validation fetch is bounded `[B2]`, and the guard matters `[C1]`:
`OAuthController.signal` is OPTIONAL (`src/oauth/types.ts`) and the CLI controller in
`login-cli.ts` supplies none, so `AbortSignal.any([ctrl.signal, ...])` throws a
`TypeError` before the fetch — every `ocx login meta-muse` would fail immediately after
printing its warning. Use the exact shape `command-code.ts:49` already uses:

```ts
signal: ctrl.signal
  ? AbortSignal.any([ctrl.signal, AbortSignal.timeout(10_000)])
  : AbortSignal.timeout(10_000),
```

so a stalled `/v1/models` cannot hang a login and cancellation is honored when offered.
Tests cover a controller with a signal, one without, an aborted signal, and a timeout. The reader, platform check, pointer path and `fetch` are
injected so tests stay deterministic and never touch the real Keychain.

### The warning must reach the CLI too `[B1]`

`src/oauth/login-cli.ts` calls `runLogin` and never reads the registry `note`, so
`ocx login meta-muse` would import a restricted credential in silence. It does pass
`onProgress: m => console.log(...)`.

So `loginMetaMuse` emits the full warning through `ctrl.onProgress` **before** touching
the pointer or the Keychain: the CLI-scope restriction, that settlement is unobservable
and calls should be treated as billable, that the key is copied into opencodex's auth
store, and that `meta-model` is the supported path. The GUI ignores progress text because
it already shows the modal. A focused test asserts the warning precedes credential access.

Every failure path throws a message naming what to do — install the CLI, run
`muse login`, retry — and **never includes the credential**.

### The key IS persisted, and the plan must say so `[A1]`

The first draft implied read-only access to Meta's store. That was wrong:
`runLogin` → `store.ts` writes `access` and `refresh` into `~/.opencodex/auth.json`
(0600, dir 0700), exactly as every other OAuth provider does. The doc now states it, the
note tells the user, and `privacy:scan` is extended below so the key shape is detectable
if it ever escapes into a tracked file.

## MODIFY `src/oauth/index.ts`

```ts
  "meta-muse": {
    login: ctrl => loginMetaMuse(ctrl),
    refresh: refreshMetaMuseToken,
    providerConfig: oauthConfig("meta-muse"),
    defaultModel: oauthDefaultModel("meta-muse"),
    // Static API key scoped by Meta to its own CLI. Never generate unattended traffic
    // on it — same posture as anthropic, for the same reason.
    defaultRefreshPolicy: "disabled",
  },
```

## MODIFY `scripts/privacy-scan.ts` `[A1]`

Its `token-looking` pattern matches `sk-`, `ghp_`, and JWTs — **not** `LLM|`. Add a
detector for `/LLM\|\d+\|[A-Za-z0-9_-]{10,}/` so a leaked Meta key is caught by the gate
this plan names as its protection.

That grammar is **measured, not guessed** `[B5]`: the real key is 48 chars in three
`|`-separated segments — `LLM`, a 16-digit id, a 27-char `[A-Za-z0-9_-]` tail — and the
pattern was verified against it (`003` §A). The `\d+` segment is the part a guess would
have gotten wrong.

`scanFile` is private and the script runs on import, so a test cannot call it `[C4]`.
Without a seam the regression degrades into re-declaring the same regex inside the test,
which stays green even if the production detector is deleted.

So extract an import-safe `export function scanText(file: string, text: string): Finding[]`
that `scanFile` then calls, and have `tests/privacy-scan-meta-key.test.ts` exercise **that
exact function**. The canary is assembled at runtime (`"LLM" + "|" + digits + "|" + tail`)
so the fixture is not itself a secret-shaped literal. Drive the test red once by removing
the detector, to prove it is not vacuous.

## MODIFY `src/usage/expected-prices.ts` + `tests/usage-cost.test.ts` `[A4]`

`cost.ts` resolves overlays by exact provider id, so `meta-muse` rows do not inherit
`meta-model`'s and both models currently resolve to `null`. A provider whose whole
warning is "this bills pay-as-you-go" must not report zero cost.

Extract the two `Cost4` tuples and the source string #3321 introduced into named
constants, reuse them for both providers, add two `meta-muse` rows, and move the pinned
count 66 → 68 with lookup assertions for both new ids.

## MODIFY the GUI warning path `[A3]`

Adding `"meta-muse"` to `HIGH_RISK` is necessary and **not sufficient**. Verified:
ordinary login goes through `requestLoginOAuth` (which checks `oauthTosRisk`), but
`onReauth` calls `loginOAuth` **directly** — so a user who already logged in can refresh
the risky credential without ever seeing the warning.

1. `gui/src/oauth-tos-risk.ts`: add `"meta-muse"` to `HIGH_RISK` — `high`, not
   `elevated`, because Meta restricts it in writing.
2. `gui/src/pages/Providers.tsx`: route `onReauth` through a warning-aware path,
   carrying `accountId` in the pending state so acknowledgement continues the *same*
   operation rather than a fresh login.
3. `gui/src/pages/providers-shared.ts`: add the `OAUTH_LABELS` entry, or the account row
   renders the raw id.
4. The executable regression goes in **`gui/tests/oauth-tos-warning-gate.test.tsx`**, not
   the root suite `[B4]`: React and `happy-dom` are `gui` dependencies and the root
   `tests/` tree cannot render components. It asserts login, add-account and reauth each
   call login zero times before acknowledgement and exactly once after. The root
   `tests/oauth-tos-warning.test.ts` keeps its map-level assertion for `"meta-muse"`.

CLI login (`ocx login meta-muse`) is outside the GUI warning map. Its warning surface is
`loginMetaMuse`'s `ctrl.onProgress` emission, which fires before any credential is read;
the registry `note` is duplicate persistent disclosure shown in the picker, not the CLI
gate.

## MODIFY `tests/provider-registry-parity.test.ts`

Add `meta-muse` to whichever roster enumerates OAuth providers, in registry order.

## NEW `tests/meta-muse-oauth.test.ts`

Registry shape and `oauthId`; the reused ladder, window, modalities and identity wire
map; `liveModels === false`; `meta/muse-spark-1.3` still routes to `command-code` with
all three Meta-adjacent providers configured; the note carries the CLI-scope,
treat-as-billable, auth-store and `META_MODEL_API_KEY` disclosures;
`defaultRefreshPolicy === "disabled"`; `supportsPerAccountQuota("meta-muse") === false`
[B4]; refresh returns its input unchanged and performs no Keychain read [B2].

Importer, against an **injected reader** — never the real Keychain, never the network:
non-darwin refuses; missing pointer refuses; `storage !== "keychain"` refuses; malformed
JSON refuses; a payload with only `access_token` refuses; a valid payload yields
`email` set and `accountId` unset; a synthetic canary key appears in **no** thrown
message, log line, or returned status object. `[A1]`

## MODIFY `docs-site/src/content/docs/guides/providers.md`

English only. A `meta-muse` section stating: macOS plus the Muse Code CLI signed in; the
key is imported and copied into OpenCodex’s auth store; Meta scopes that credential to its
own CLI so this is an unsupported use; settlement is not observable from the API, so
treat every call as billable; opencodex shows no quota for this provider and cannot
refresh one on demand; and `meta-model` with your own `META_MODEL_API_KEY` is the
supported path.

The docs copy must match the registry note exactly on those three points `[C2]` — no
pay-as-you-go settlement claim, no quota-display promise, and the correct env var.

## Quota and multi-account

From `003` §E-F, as corrected by the SSE finding:

- **Reactive 429 failover: free.** `isGenericFailoverProvider` arms for any OAuth
  provider outside `{openai, anthropic}` once two usable accounts exist. `meta-muse`
  inherits it with no new code. The only obligation is that upstream exhaustion reaches
  the router as HTTP 429.
- **Quota display: possible, passively — and OUT OF SCOPE for this PR.** The
  `response.subscription_usage` event fits `ProviderQuota`
  (`fiveHourPercent` / `fiveHourResetAt` / `weeklyPercent` / `weeklyResetAt`) without a
  schema extension — though not as a literal copy `[C5]`: `updatedAt` is generated
  locally, percentages and Unix-second resets go through `normalizePercent` /
  `normalizeResetAt`, `tier` is dropped, `window_duration_mins === 300` must be checked
  before the five-hour slot is assigned, either window may be absent, and a turn with no
  event at all is normal rather than an error. But there is no endpoint to poll: the value arrives only as a
  side effect of a real streaming turn, so it needs a passive read-and-cache seam rather
  than the probe-shaped `maybeFetchProviderQuota` dispatch every other provider uses.
  That touches the streaming path, the quota cache and account attribution — a distinct
  unit. It is registered as **wp5** with its own diff-level document
  (`050_wp5_passive_muse_quota.md`) `[C3]`, since a declared work-phase without one
  violates DIFFLEVEL-ROADMAP-01. Folding it into a credential PR would make both harder
  to review.
- **`supportsPerAccountQuota` stays false**, and a test asserts it `[B4]`. That path calls
  `fetchAccountQuota`, whose fallback branch sends any non-Kiro/non-Antigravity bearer to
  `fetchAnthropicUsageQuota`. Flipping the allowlist without a dedicated branch would ship
  a Meta key to Anthropic; the assertion locks that guard.
- Subscription windows are per-subscription, so they WOULD be sound for per-account
  ranking in wp5. The RPM/TPM limits are per-team and would not be.


## Verification

```bash
bun test tests/meta-muse-oauth.test.ts tests/meta-model-api-provider.test.ts \
         tests/oauth-tos-warning.test.ts tests/provider-registry-parity.test.ts \
         tests/usage-cost.test.ts
bun run test:changed
bun x tsc --noEmit
bun run privacy:scan
bun run lint:gui
bun test gui/tests/oauth-tos-warning-gate.test.tsx
cd gui && bun run build          # gui/AGENTS.md requires this for GUI changes
cd docs-site && bun install --frozen-lockfile && bun run build
```

No repository-wide suite. No test may read the real Keychain or reach the network.

## Terminal outcome

`DONE` when the PR is green at its exact head SHA and merged, login imports the CLI
credential on macOS, every GUI login path is gated behind the high-risk warning, and both
models resolve a price.
