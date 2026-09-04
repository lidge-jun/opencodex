# Follow-ups this unit deliberately does not do

## Server-side consent for high-risk OAuth providers

Audit round 1 (`005` §1) established that the Terms-of-Service acknowledgement
for `HIGH_RISK` providers is enforced in the browser, not at the API boundary:

- `gui/src/oauth-tos-risk.ts:10` lists `anthropic`, `google-antigravity`, and
  `meta-muse`, and `OAuthTosWarningModal` gates the GUI button.
- `POST /api/oauth/login` performs no acknowledgement check, and the controller
  it builds installs `n: () => {}` (`src/oauth/index.ts:1720`), so even the
  provider's own warning text is discarded on that path.
- `ocx account login <provider>` posts to that endpoint
  (`src/cli/account-auth.ts:142`), so it inherits the gap. The older
  `ocx login <provider>` path does print the warning, because
  `src/oauth/login-cli.ts:87` wires `n` to `console.log`.

This is pre-existing and provider-wide, not introduced by the Muse work, which
is why it is not a v2.41.0 blocker. It is still a real gap and should get its
own unit: move the acknowledgement to the backend so every entry point is
covered, with the acknowledgement recorded per provider rather than per browser
session.

The design question that unit has to answer first: an acknowledgement gate on
`/api/oauth/login` changes behaviour for `anthropic` and `google-antigravity`
logins that work today, so it needs a migration story rather than a flag flip.

## Muse subscription usage display

`050_wp5_passive_muse_quota.md` in the `260903_muse_spark_plan_oauth` unit
records that Meta emits subscription window usage inside streaming responses
and that OpenCodex does not yet read it. The provider note says so plainly.
Unchanged by this release.
