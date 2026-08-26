# 001 — Current-state inventory of every login surface

Read at `bb89eafbe`. Every claim below is a file:line read, not a memory.

## Three surfaces, three renderers

There are three places a human can start an OAuth login in the GUI, and they
do not share a renderer.

### A. Workspace auth panel — an already-added provider

`gui/src/components/provider-workspace/ProviderAuthPanel.tsx`

- `:242` picks the hint for this row: `loginHint?.provider === item.name`.
- `:392-401` renders the device code with a copy button.
- `:402` renders `<LoginUrlBlock url={hintForThis.url ?? ""} />`.
- `:403-408` renders Cancel.
- A search for `paste`, `manual`, or `submitManual` across all 568 lines
  returns nothing. **This surface cannot accept a pasted code.**

### B. Add-provider modal, OAuth pane — a first add via a catalog preset

`gui/src/components/add-provider-oauth-pane.tsx`

- `:59` renders `<LoginUrlBlock url={oauthUrl} />`.
- `:60-99` renders the paste input and submit button.
- No device code is rendered anywhere. The prop does not exist.
- When a device flow returns no `url`, `LoginUrlBlock` returns `null`
  (`login-url-block.tsx:16`), so the pane shows a spinner label and an empty
  paste box with nothing to act on.

The hook behind it, `gui/src/components/use-add-provider-oauth.ts:53`:

```ts
const data = await res.json() as { url?: string; instructions?: string; error?: string };
```

`deviceCode` is not in the type and is never read, although
`src/server/management/oauth-account-routes.ts:176` returns it:

```ts
return jsonResponse({ url: authUrl, instructions, deviceCode });
```

### C. Add-provider modal, Accounts tab — a first add via an account row

`gui/src/components/provider-catalog/ProviderCatalog.tsx:148-212`

The account rows call `onLogin(row.id)`, which is `Providers.tsx`'s
`requestLoginOAuth`. That path stores the hint:

- `gui/src/pages/use-providers-oauth.ts:93-96` reads `url`,
  `instructions` **and** `deviceCode`, then calls `setLoginInfo`.
- `gui/src/pages/Providers.tsx:365` passes `loginInfo` to
  `ProviderDetails` → `ProviderAuthPanel`.

`ProviderAuthPanel` is the workspace surface for an **existing** provider.
During a first add the modal is open and no panel is mounted for that
provider, so the hint has no renderer. The row renders
`t("prov.waitingBrowser")` and a Cancel button, and that is all the operator
gets: no URL, no code, no paste box.

**This is pain point 1 exactly.** The data arrives; nothing draws it.

### D. Codex account modal — a fourth, near-duplicate surface

`gui/src/components/add-codex-account-waiting-step.tsx:38-69` renders
`LoginUrlBlock` plus its own paste input against
`/api/codex-auth/login/code`. `src/codex/auth-api.ts:2077` returns only
`{ flowId, url, instructions }` — no device code on this path either.

## What each provider actually returns

`startLoginFlow` (`src/oauth/index.ts:1420-1504`) resolves
`{ url, instructions?, deviceCode? }` from the provider's `onAuth` call.

| Provider | Shape | Produced at |
|----------|-------|-------------|
| xAI, Anthropic, ChatGPT, Cursor, Antigravity, Kiro | browser redirect + loopback callback | `OAuthCallbackFlow.login()`, `callback-server.ts:116` |
| Kimi | device flow | `kimi.ts:212` — `instructions: "Enter code: …"`, **no `deviceCode` field** |
| Nous | device flow | `nous.ts:660-663` — sets `deviceCode: device.userCode` |
| GitHub Copilot | device flow | `github-copilot.ts:393-402` — locally constructed verify URL, `deviceCode: device.userCode` |
| local-token import | no browser | `index.ts:1473` resolves `{ url: "" }` with an explanatory string |

Two observations that matter for WP2:

1. Kimi puts the user code inside a free-text `instructions` string instead of
   the structured `deviceCode` field, so no surface can render it as a code.
2. `github-copilot.ts:170` refuses to trust `verification_uri_complete` and
   builds the URL itself. That invariant is not negotiable in WP4.

## The manual-paste path, end to end

1. `POST /api/oauth/login/code` — `oauth-account-routes.ts:202-213`.
   Caps input at 4096 chars, calls `submitManualLoginCode`, returns 409 on
   failure.
2. `submitManualLoginCode` — `index.ts:1329-1360`. Rejects empty, rejects
   >4 KiB, rejects when no login is in progress, then `parseCallbackInput`.
   Rejects when no `code` is found; for `url`/`query` shapes enforces
   state once the flow has registered `expectedState`.
3. `parseCallbackInput` — `callback-server.ts:273-300`. Three shapes:
   a parseable URL, a string containing `code=`, or a raw code with optional
   `#state`.
4. `OAuthCallbackFlow.#waitForCallback` — `callback-server.ts:238-261`
   re-parses and loops on a bad paste.

The flow **does** survive a rejected paste — the loop re-prompts. What it does
not do is tell the operator anything useful: the GUI shows
`t("prov.pasteFail", { error })`, and only surface B has a paste box at all.

Accepted today: `https://…/callback?code=X&state=Y`, `?code=X&state=Y`,
`code=X&state=Y`, `X`, `X#Y`. Whitespace is trimmed at three separate
layers. A URL missing `state` is rejected with a specific message.

## Server-side browser opening

`oauth-account-routes.ts:170-175`:

```ts
if (authUrl && !deviceCode) {
  const { openUrl } = await import("../../lib/open-url");
  openUrl(authUrl);
}
```

Unconditional for browser flows. `src/codex/auth-api.ts:1844` does the same
on the Codex path. `src/lib/open-url.ts:11-24` spawns the platform opener,
which resolves the **default** browser and therefore the default profile. It
swallows spawn errors deliberately (a headless host emits ENOENT
asynchronously), so a failed open is indistinguishable from a successful one
from the GUI's perspective.

There is no opt-out: no request field, no config key, no environment variable.
Grepping `openUrl` finds callers in `login-cli.ts:85`, `dispatch.ts:305`,
`auth-api.ts:1844`, and `oauth-account-routes.ts:173`; none is conditional.

## Existing tests

`tests/oauth-manual-code.test.ts` covers the paste path;
`tests/oauth-callback-server.test.ts` and `oauth-callback-binds.test.ts`
cover parsing and binding; `tests/github-copilot-oauth.test.ts`,
`nous-oauth.test.ts`, `kimi-oauth-identity.test.ts` cover device flows;
`tests/oauth-public-surface.test.ts` and `oauth-status-privacy.test.ts`
cover the management surface and its redaction.

Not covered anywhere: what the GUI *renders* during a login. Every gap in this
unit lives in that hole.
