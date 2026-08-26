# 020 — WP3: the login hint renders during a first add

**Issue:** bug report. **PR base:** WP2's head branch (stacked). **Screenshot:** required.

## The defect

Pain point 1, verbatim: *"이미 프로바이더가 추가된 상태에서는 링크를 복사할 수
있지만 → 첫 추가 때 못함."*

The hint is computed and stored. `use-providers-oauth.ts:93-96` reads
`url`, `instructions`, and `deviceCode` and calls `setLoginInfo`.
`Providers.tsx:365` passes `loginInfo` into `ProviderDetails`, which passes
it to `ProviderAuthPanel` — the workspace surface for a provider that already
exists.

During a first add there is no such provider. The modal is open, the panel is
not mounted, and `ProviderCatalog.tsx:205` renders
`t("prov.waitingBrowser")` with a Cancel button. The URL exists in React
state and has no renderer.

That is the whole bug. It is not "the modal cannot show a link" — it is
"nobody asked it to."

## The change

### 1. `ProviderCatalog.tsx` accepts and renders the hint

```diff
 export default function ProviderCatalog({
   presets, usageRank, presetsLoading, initialTier,
   onSelectPreset, onSelectCustom,
   accountRows, accountStatus, busyProvider,
+  loginHint = null,
+  paste,
   onLogin, onCancelLogin, onLogout, onManage,
 }: {
+  /** Hint for the account row whose login is in flight; ignored for other rows. */
+  loginHint?: CatalogLoginHint | null;
+  /** Paste state, owned by the modal so the catalog stays presentational. */
+  paste?: {
+    value: string; busy: boolean; message: string; ok: boolean;
+    onChange: (value: string) => void;
+    onSubmit: (provider: string) => void;
+  };
```

A controlled paste field needs its value and status, not just a submit
callback — an `onSubmitLoginCode` alone could not render one. The catalog
passes `row.id` back on submit so the modal posts to the right provider.

Inside the account-row map (`:148-212`), render the WP2 `<LoginHint>`
**below** the row rather than inside its badge strip: the strip is a
horizontal flex of buttons and a URL block belongs on its own line. See
section 5 for why that needs CSS, not just markup.

### 2. Paste state lives in the modal, not the catalog

`ProviderCatalog` is presentational by contract (its own header comment says
so). The paste value, busy flag, and message belong in `AddProviderModal`,
which already owns exactly those fields in its reducer for the preset pane
(`manualCode`, `manualCodeBusy`, `manualCodeMsg`, `manualCodeOk`).

Reusing them is sound because `/api/oauth/login/code` is **provider-keyed**:
the modal's `submitManualCode` can complete a login the *page* started. The
catalog receives a `paste` prop and calls `onSubmit(row.id)`.

A caveat the first draft of this doc oversold: this is not "no duplicated
state". Hint state genuinely exists twice — page-level `loginInfo` for account
rows, reducer `oauthUrl`/`oauthDeviceCode` for the preset pane. The two panes
cannot be mounted at once (the catalog renders only while `preset === null`),
so they cannot disagree on screen, but the duplication is real and this doc
should not pretend otherwise.

### 3. The hint comes from the PAGE, not the modal's reducer

This is the load-bearing fact of the phase, and getting it backwards would
produce a hint that is permanently empty.

An Accounts-tab login does **not** run `useAddProviderOAuth`:

```
ProviderCatalog onLogin(row.id)
  → AddProviderModal onAccountLogin
    → ProvidersPageModals onAccountLogin
      → Providers.onAccountLogin
        → codex / forward rows: opens AddCodexAccountModal
        → oauth rows: requestLoginOAuth → useProvidersOAuth.loginOAuth
                        → setLoginInfo({ provider, url, instructions, deviceCode })
```

`useAddProviderOAuth` runs only from the preset OAuth pane, after a preset is
chosen. For an account row it never runs, and `set-oauth-url` no-ops anyway
while `preset` is null. So the hint must be threaded from `Providers.tsx`'s
`loginInfo` — through `ProvidersPageModals` **and** `AddProviderModal`, which
is a hop the first draft of this doc skipped — down to the catalog.

### 4. Cancel already works

`onCancelLogin` is already wired on the account row and reaches the page's
`cancelLoginOAuth`, which POSTs `/api/oauth/login/cancel`. No change.

### 5. The row has to grow a second line

`.list-row` is `display: flex; align-items: center; justify-content:
space-between`, so a hint added as a third child lands on the **badge axis**,
beside the buttons. The row needs a head wrapper plus a waiting-state modifier:

```css
.provider-catalog-account-row-head { display: flex; align-items: center;
  justify-content: space-between; gap: 10px; width: 100%; }
.list-row.provider-catalog-account-row--waiting { flex-direction: column;
  align-items: stretch; gap: 10px; cursor: default; }
```

The waiting modifier **must** be qualified with `.list-row`. This stylesheet
is `@import`ed at the top of `styles.css` while `.list-row` is declared far
below it, and the two selectors have the same specificity — so source order
decides, and the unqualified modifier silently loses `align-items` and
`cursor`. The hint then renders as a shrink-wrapped centered column instead of
a full-width second line, which looks *almost* right and is easy to miss in a
screenshot.

The head wrapper is always present, so a non-waiting row is not *byte*-identical
markup — it is one extra div reproducing the same flex rules, and renders the
same. The earlier claim of byte-identical layout was wrong and is corrected
here.

### 6. A Codex row must never show an OAuth hint

`kind: "codex"` rows do not log in through `/api/oauth` at all: they open the
Codex account modal, and the page sets `busy = "openai"` while enabling the
OpenAI provider first. A provider-match check alone would let a stale
`loginInfo.provider === "openai"` paint an authorization URL onto a row whose
real flow is somewhere else, so the predicate excludes non-OAuth kinds
explicitly rather than relying on the ids never colliding.

## What this phase must not do

- **Do not** move `loginInfo` into a context or a store. One prop, one hop.
- **Do not** change `ProviderAuthPanel`. WP2 already reworked it; this phase
  only teaches a second surface to render the same component.
- **Do not** auto-open the modal to a provider's workspace on login start.
  `onLoginSettled` already does that on success, and doing it earlier would
  unmount the modal mid-login — which is a longer way of reintroducing this
  exact bug.

## Test

`tests/oauth-first-add-hint.test.ts` (new): a pure-function test over
`shouldShowLoginHint(row, busyProvider, hint)`, asserting that a hint renders
only for an OAuth row whose provider matches and only while that provider is
busy.

The predicate lives in a new `provider-catalog/login-hint-visibility.ts`, not
in `provider-presets.ts` — that module is the preset DTO / tier / search owner
and declares itself free of React concerns; login chrome does not belong in it.

Two cases matter: a hint for `anthropic` must never render on the `xai` row,
and a `codex` row must show nothing even while the page is busy on it.

## Acceptance

- Starting a login for a not-yet-added provider from the Accounts tab shows
  the URL with a copy button, the device code when the provider sends one, a
  paste input, and Cancel — without leaving the modal.
- The link can be copied and opened in a different browser profile.
- `bun run typecheck`, `bun run test`, `bun run lint:gui` green.
- Screenshot of a first-add waiting state showing the copyable link.
