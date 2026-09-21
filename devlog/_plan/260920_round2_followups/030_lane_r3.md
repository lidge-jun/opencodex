# R3 — the roster and login remainders

Status: implemented, awaiting review. Scope was #5292 and the two #5261 remainders.

## #5292 was already closed before this lane opened

The plan's table says `gui/src/pages/Logs.tsx` restates the recovery-kind union with nine of
thirteen members. That was true when the table was written and stopped being true two hours
earlier: `555f0cacdf` (#5300, 18:41) replaced the copy with the durable roster, and the plan
commit landed at 20:48 from a snapshot taken before it.

Current `dev` already has all of it. `Logs.tsx` imports `AttemptRecoveryKind` from
`src/usage/telemetry-contract.ts` and its label map closes with
`satisfies Record<AttemptRecoveryKind, string>`, so a fourteenth kind is a typecheck failure
there rather than an "Unknown recovery reason". All ten catalogs carry all thirteen labels plus
the fallback, and `tests/usage/request-outcome-agreement.test.ts` holds both: the label map has
to cover every member of `ATTEMPT_RECOVERY_KIND_ROSTER`, and every key it names has to exist in
every catalog. Verified by reading the tree, not by rerunning the suite.

Nothing was changed for it. The row is stale, not open.

## #5261, remainder one: the two CLI logins that discarded the launch

`src/oauth/login-cli.ts` called `void openUrl(...)` in both `handleOAuthLogin` and
`handleKeyLogin`. Each printed a URL, said it was opening a browser, and asked a question that
assumes it opened — indistinguishable from a login that is working.

The part that made this more than a missing `console.warn`: `OAuthController.onAuth` returns
`void` and every one of the thirteen provider call sites invokes it as `ctrl.onAuth?.(...)` and
moves on. The launcher's answer therefore arrives after the flow has continued, and on a
callback-server provider `#waitForCallback` has already called `onManualCodeInput` by then. A
warning written at that moment lands on the line the user is typing on.

Making `onAuth` awaitable would mean changing the controller contract and all thirteen call
sites, which is a much larger change than the defect deserves. Instead the launch reports itself
when it settles, and the two things that could collide with it wait on that report: the
manual-code prompt awaits it before asking, and the key login awaits it before it constructs a
reader at all. A polling provider that never prompts is still told before the login claims to
have worked.

`BROWSER_LAUNCH_FAILED_HINT` in `src/cli/account-auth.ts` kept its ChatGPT-specific second line
and now derives its first from `BROWSER_LAUNCH_FAILED_NOTICE`, so the sentence has one home
across all three logins.

The handlers took an optional deps object. The contract worth holding is an order, and an order
is only observable from something that records both events; spawning a launcher and attaching to
stdin to find that out would test the operating system. Production passes none of them.

## #5261, remainder two: the roster that kept last-good rows silently

`useCodexAccountPool` kept its rows after a failed read and also kept reporting `ready`. Keeping
the rows is right — blanking a populated pool because one 30s poll missed is its own defect — but
the surface then could not tell a list the server had just confirmed from one that predated a
failure. The reported shape: add an account, the read that would bring it over fails, and the
older accounts are on screen with the new one absent.

`refreshFailed` sits beside `loadState` rather than inside it, for the same reason `refreshing`
already does. `loadState` answers what the surface can draw and a warm failure does not change
that answer; folding it in would mean either flashing the cold skeleton over good data or saying
nothing. A cold failure still replaces the surface with the error it already had, and the banner
only renders when rows survived, so an empty cold failure is never annotated instead of explained.

## Verification

Static review and hosted CI at the exact head. The lane ran no local suite, no individual test,
no typecheck, no build, no install, no `ocx`, and changed no credential or configuration —
recorded as NOT RUN.

Checked by reading rather than running, because the ratchets are what a merge breaks:

- No file this lane touches appears in `tests/fixtures/file-size-baseline.json`. The ten i18n
  catalogs are in its `exempt` list.
- `tests/oauth/oauth-login-cli-browser-launch.test.ts` is registered in both
  `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`. The gui
  suite has no layout guard.
- The one new i18n key is in all ten catalogs, which `gui/tests/locale-parity.test.ts` and
  `gui/tests/claude-desktop-locale.test.ts` both require.
- `CodexAccountLoadState` gained no member. `CodexAccountPoolController` gained one, and the
  source-oracle roster in `gui/tests/codex-account-pool-controller.test.ts` names it.
- `CodexAccountPoolLoadStates` stopped restating the load-state union and derives it.

## The GUI screenshot gate

`enforce-target` requires a screenshot for a PR that touches `gui`. Producing one needs
`bun run build:gui` and a running proxy, both of which this lane is forbidden to do, so the pull
request says so and offers what can be checked instead: the rendered markup is asserted against a
mounted DOM in `gui/tests/codex-account-pool-stale-refresh.test.tsx` — the banner appears with
surviving rows, carries the catalog string, does not appear on a successful refresh, and does not
replace the cold error — and the new class reuses the existing `.pwi-auth-state` block with the
`--amber` pair already used elsewhere in the theme.
