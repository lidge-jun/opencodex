# 010 — WP2: one login-hint component on every surface

**Issue:** feature proposal. **PR base:** `dev`. **Screenshot:** required.

## The defect

Four GUI surfaces render a login-in-progress. Each renders a different subset
of what the server sent:

| Surface | URL | Device code | Paste |
|---------|-----|-------------|-------|
| `ProviderAuthPanel` | yes | yes | **no** |
| `AddProviderOAuthPane` | yes | **no** | yes |
| `ProviderCatalog` account row | **no** | **no** | **no** |
| `AddCodexAccountWaitingStep` | yes | **no** | yes |

No surface has all three. A Kimi login shows an empty box on every one of
them, because `kimi.ts:212` puts the user code in a prose `instructions`
string and never sets `deviceCode`.

## The change

### 1. `gui/src/components/login-url-block.tsx` → a full hint component

Keep `LoginUrlBlock` as-is (it has three callers and a clean contract) and add
a sibling in the same file that composes it.

**Naming, as landed:** `ProviderAuthPanel` already imports a `LoginHint`
*type* from `./types` (the `{ provider, url, instructions, deviceCode }`
shape). The new component therefore has to be aliased at that one call site —
`import { LoginHint as LoginHintView }` — or the identifier collides. Renaming
the existing type would touch more files than the feature does.

```tsx
export type LoginHintData = {
  url?: string;
  deviceCode?: string;
  instructions?: string;
};

export function LoginHint({ hint, paste }: {
  hint: LoginHintData;
  paste?: {
    value: string;
    busy: boolean;
    message: string;
    ok: boolean;
    onChange: (v: string) => void;
    onSubmit: () => void;
  };
}) { … }
```

Render order, which is the UX decision this phase is actually making:

1. **Device code first when present.** It is the thing the human has to type,
   and it is short. Copy button beside it, reusing `useCopyFeedback` and the
   existing `.pwi-device-code` styles lifted into
   `gui/src/styles/login-url-block.css`.
2. **Then the URL**, via the existing `LoginUrlBlock` — selectable text, copy,
   and the "didn't open?" external link.
3. **Then `instructions`**, if the provider sent prose.
4. **Then the paste row**, when the caller supplies `paste`.

`LoginUrlBlock` returns `null` on an empty URL today; `LoginHint` must not —
a device flow with no URL still has a code to show. Guard on
"nothing at all to render" instead.

### 2. `gui/src/components/use-add-provider-oauth.ts:53`

```diff
-const data = await res.json() as { url?: string; instructions?: string; error?: string };
+const data = await res.json() as { url?: string; instructions?: string; deviceCode?: string; error?: string };
-if (data.url) { setOauthUrl(data.url, providerId); setOauthMsg(t("modal.waitingLogin")); }
-else { setOauthMsg(data.instructions || t("modal.loggingIn")); }
+setOauthUrl(data.url ?? "", providerId, data.deviceCode, data.instructions);
+if (data.url || data.deviceCode) setOauthMsg(t("modal.waitingLogin"));
+else setOauthMsg(data.instructions || t("modal.loggingIn"));
```

**Reducer, as landed.** The plan first proposed replacing `oauthUrl` with an
`oauthHint` object. That was rejected during implementation: `set-oauth-url`
already carries the provider tag and the "switched away" guard, and swapping
the slot for an object would have rewritten that guard for no behavioral gain.

What shipped instead is the smaller change — two sibling fields beside the
existing one, carried by the same action and cleared by the same three cases:

```diff
   oauthUrl: string;
+  oauthDeviceCode: string;
+  oauthInstructions: string;
   oauthUrlProvider: string | null;

-  | { type: "set-oauth-url"; url: string; providerId: string }
+  | { type: "set-oauth-url"; url: string; providerId: string; deviceCode?: string; instructions?: string }
```

The leak guard is unchanged and still load-bearing: `set-oauth-url` returns
`state` untouched when `state.preset?.oauthProvider !== action.providerId`,
and `choose-preset` / `back` / `use-api-key-instead` clear all three fields
together. A hint for one provider cannot render under another.

### 3. `src/oauth/kimi.ts:212`

```diff
-ctrl.onAuth?.({ url: device.verificationUriComplete, instructions: `Enter code: ${device.userCode}` });
+ctrl.onAuth?.({
+  url: device.verificationUriComplete,
+  instructions: `Enter code: ${device.userCode}`,
+  deviceCode: device.userCode,
+});
```

Matches `nous.ts:660-663` and `github-copilot.ts:396-400`, and `instructions`
is unchanged so the CLI keeps printing what it printed.

**This is not purely additive, and the PR must say so.** The management route
gates its browser-open on that exact field:

```ts
// oauth-account-routes.ts:170
if (authUrl && !deviceCode) { openUrl(authUrl); }
```

Before this change Kimi set no `deviceCode`, so the proxy auto-opened
`device.verificationUriComplete` — a **provider-supplied** URL. Setting the
field means Kimi stops being auto-opened, exactly like Nous and Copilot
already are.

That is the correct direction on both counts. It ends an inconsistency where
two device providers are treated as device flows and the third is not, and it
stops handing a server-supplied URI to a local process spawn — the very thing
`github-copilot.ts:392-394` refuses to do. The operator does not lose access
to the link: WP2 is the phase that puts that URL on screen with a copy button
on every surface, which is strictly more reach than an auto-open into whatever
profile happens to be default.

It still must be **stated in the PR description as a behavior change**, with
the before/after in the Summary section, rather than buried under "additive".
A reviewer who reads only the diff to `kimi.ts` will not see the route.

**Not in this phase:** allowlisting `verificationUriComplete` before it
reaches `onAuth` at all, for Kimi and Nous. That is a separate security
change with its own issue (`002`). Note the ordering benefit: after WP2, no
device provider's server-supplied URL reaches `openUrl`, so that issue governs
what is *displayed*, not what is *executed*.

### 4. Call sites

- `add-provider-oauth-pane.tsx:59-99` — replace `LoginUrlBlock` + the inline
  paste block with one `<LoginHint hint={hint} paste={…} />`.
- `provider-workspace/ProviderAuthPanel.tsx:392-402` — replace the inline
  device-code block and `LoginUrlBlock` with the aliased `<LoginHintView>`,
  **and pass `paste`**. This is the first time the workspace panel can accept
  a pasted code; it gets its own `submitManualCode` pointed at
  `/api/oauth/login/code`.
- `add-codex-account-waiting-step.tsx:38-69` — same swap. Its submit goes to
  `/api/codex-auth/login/code`, so `paste.onSubmit` stays caller-owned —
  sharing a renderer does not merge two backends.

**Still not covered by this phase:** the add-provider Accounts-tab rows render
no hint at all. That is WP3's whole subject (`020`), not an omission here.

## i18n

**No new keys were needed.** `prov.deviceCode`, `prov.copyCode`,
`prov.codeCopied`, `prov.pasteRedirect`, `prov.pasteRedirectHint`,
`prov.pasteSubmit`, and `prov.pasteSubmitting` already exist in all nine
locale files, because both halves of this component already shipped — just on
different surfaces. Unifying them is a wiring change, not a copy change, so no
locale is left with an untranslated English string.

## Test

Two new files, split by what they lock:

`tests/oauth-device-code-contract.test.ts` — `loginKimi` calls `onAuth`
with `deviceCode` equal to the user code, against a faked
device-authorization response. This is the assertion that would have caught
the original gap. It was driven red against the pre-fix `kimi.ts` before
being accepted, so it is not vacuous. `loginNous` and
`loginGithubCopilot` already have equivalent `onAuth` assertions in
`tests/nous-oauth.test.ts` and `tests/github-copilot-oauth.test.ts`, so
re-asserting them here would duplicate rather than protect.

`tests/oauth-login-open-browser.test.ts` — the route consequence, both
directions: with `deviceCode` present, `POST /api/oauth/login` does not call
the opener and still returns the URL and code; with a plain browser flow it
opens exactly as before. The second case is the compatibility guard.

Two existing seam tests were **updated, not relaxed**:
`tests/provider-workspace-auth.test.ts` still demands a device-code widget,
now pointed at its new owner, and gains an assertion that the workspace can
reach `/api/oauth/login/code`; `tests/codex-auth-modal-status.test.ts` still
locks the same four-part submit guard and the distinct submitting copy, now as
props rather than a JSX string.

GUI rendering is verified by screenshot in the PR; this repo has no component
test harness and this phase is not the place to introduce one.

## Acceptance

- A Kimi login shows a copyable code on all three surfaces.
- The workspace panel accepts a pasted redirect URL for the first time.
- `bun run typecheck`, `bun run test`, `bun run lint:gui` green.
- Screenshot of the waiting state with a device code visible.
