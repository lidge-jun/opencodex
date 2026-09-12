# 003 — Blocker 1 resolved: import-first login, oauth classification kept

`002` proposed dodging the request-path coupling by leaving `authKind: "local"`
and registering in `OAUTH_PROVIDERS` anyway. The operator rejected the premise:
devin-cli is not a local runtime. It is a CLI that requires a vendor account —
demonstrated by installing it and signing in, after which
`devin auth status` reports `Logged in (via Devin)` with its credential at
`~/.local/share/devin/credentials.toml`. Ollama, vLLM and LM Studio have no
account at all; grouping devin-cli with them was a taxonomy error.

So the classification is `oauth`, and blocker 1 has to be solved rather than
avoided.

## The resolution

Blocker 1 said: with `authKind: "oauth"`, `src/router.ts:317-318` forces
`authMode`, `src/server/responses/core.ts:4323` calls
`getValidAccessTokenSnapshot`, and that throws `OAuthLoginRequiredError` when no
account set exists.

That is only a defect while no credential is stored. Once the login entry has
run, a credential exists, the snapshot resolves, `apiKey` is stamped onto a
provider config the adapter never reads, and the turn proceeds exactly as it does
today. Requiring one sign-in before an account provider answers is not a
regression — it is what an account provider means, and it is what the operator
asked for.

**No change to `core.ts` or `router.ts` is needed.** The boundary in `000` holds.

> **Superseded in part by `020`.** Audit round 2 disproved the startup-import half
> of this section: `projectStartupConfigRepairs` is a synchronous projector
> persisted through `mutatePersistedConfig`, which writes `config.json` only,
> while `getValidAccessTokenSnapshot` reads the auth store. A boot pass there
> cannot mint a credential, so existing installs DO need one sign-in after
> upgrade. `020` carries the corrected, honest version. The login-time
> import-first design below stands unchanged; only the boot-import claim is dead.

## What does have to be built: import-first, so nobody is broken mid-flight

A user who has `devin-cli` configured today and is signed into the CLI must not
wake up to 401s. Kiro already solves this shape (`src/oauth/kiro.ts:335-429`):
login imports an existing CLI session rather than starting a browser flow.

wp2 therefore builds `loginDevinCli` import-first:

1. `devin auth status` — confirmed present and non-interactive on 3000.10.21,
   printing `Logged in (via Devin).` plus the credential path. This is the probe;
   the subcommand is no longer a guess (`001` recorded it as unconfirmed).
2. already signed in -> return the marker credential immediately, no browser.
3. signed out -> run `devin auth login` with kiro's piped-spawn shape
   (blocker 3), surfacing the CLI's own `Visit <url> ... paste the code` prompt
   through `ctrl.onAuth`/`onManualCodeInput` — that flow is confirmed: the CLI
   prints a PKCE URL and accepts a pasted one-time code, which is exactly the
   shape `onManualCodeInput` exists for.

And wp3 adds a startup import for existing installs: when `devin-cli` is
configured, has no stored credential, and `devin auth status` says signed in,
store the marker so the first turn after upgrade succeeds without a click. Same
repair pass as the other two migrations
(`src/providers/model-rename-startup.ts`).

## Blocker 2, 3, 4 — unchanged from `002`

`dashboardPreset: false`; piped spawn; `OAUTH_LABELS` in
`gui/src/pages/providers-shared.ts` is the Accounts label, not
`provider-icons.ts`. The `로컬` badge disappears on its own once `auth` stops
being `"local"` (`ProviderCatalog.tsx` badge ladder), which is the mark the
operator asked to have removed.

## Corrections to earlier docs from the live install

- credential path is `$XDG_DATA_HOME/devin/credentials.toml`
  (`~/.local/share/devin/...`), not `~/.config`. `010`'s path resolver changes.
- `devin auth status` exists and is non-interactive. `010`'s "unconfirmed
  subcommand" hedge is replaced by a real probe, and its test case 4 becomes a
  regression guard rather than a guess.
- A separate live defect was found and already landed on `dev` outside this unit:
  the adapter passed `DEVIN_PERMISSION_MODE=ask`, which the CLI rejects with exit
  2, so every default-configuration turn failed (PR #4332, `e7f7487b3d`). This
  unit assumes that fix is present.

