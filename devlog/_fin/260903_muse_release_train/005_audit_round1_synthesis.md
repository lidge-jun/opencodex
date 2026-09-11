# Audit round 1 — synthesis

Reviewer: delegated read-only auditor (gpt-5.6-sol, high). Verdict: **FAIL**,
seven findings. Every one was re-derived against the tree before folding; the
outcome is six folded and one rebutted-with-a-carve-out.

## 1. "ToS enforcement is bypassable" — REBUTTED as a release blocker, RECORDED as a known limit

The reviewer is right about the mechanism and wrong about what it means for
this release.

The mechanism, confirmed: `loginMetaMuse` emits its warning through the
optional `ctrl.n` progress callback (`src/oauth/meta-muse.ts:128`). The CLI's
own OAuth path wires that to `console.log` (`src/oauth/login-cli.ts:87`), so
`ocx login meta-muse` prints it. The management API's flow, by contrast,
installs `n: () => {}` (`src/oauth/index.ts:1720`) and drops it on the floor —
which means `POST /api/oauth/login` and `ocx account login meta-muse`, which
goes through that same endpoint, never surface the warning text. The GUI shows
`OAuthTosWarningModal` client-side, so the acknowledgement is enforced by the
browser, not by the server.

Why it does not block:

- **It is not a regression and not Muse-specific.** `n: () => {}` predates this
  work by a long way, and `anthropic` and `google-antigravity` — the other two
  `HIGH_RISK` ids in `gui/src/oauth-tos-risk.ts:10` — have carried exactly the
  same client-side-only gate since `fbac9f05e`. Shipping v2.41.0 changes the
  exposure for none of them.
- **The credential path itself is clean.** The reviewer looked for a leak and
  found none: no Keychain stderr surfaced, no response bodies in errors, a fixed
  public error vocabulary, atomic 0600 persistence.
- **The bypass requires the user's own admin token.** `/api/oauth/login` is
  behind management auth. The actor who can call it is the account holder, who
  is the only party the ToS warning protects, and who has already installed and
  signed into the Muse Code CLI on that machine.

What it is: a real server-side consent gap across all three high-risk
providers, worth its own unit. It is recorded here and in
`050_followups.md` rather than folded into a release cycle, because a
backend consent boundary is a behaviour change for `anthropic` and
`google-antigravity` users too, and that does not belong in a release train
the user asked to ship today.

## 2-5. Release-path corrections — FOLDED

All four are correct and all four are now in the phase docs:

- **Version availability before the bump.** `scripts/release.ts:513` checks
  unused-version and channel-forward ordering BEFORE mutating anything; the
  workflow's own duplicate check at `release.yml:303` runs only after dispatch.
  Doing this by hand means proving the version unused first, not discovering it
  from a failed publish. Live state at audit time: `latest=2.40.0`,
  `preview=2.40.0-preview.20260902`, `2.41.0` unused.
- **Exact-SHA is stricter than "CI passed".** `release-dispatch-guard.cjs:14`
  requires a lowercase 40-char SHA, an allowed ref, a `workflow_dispatch`
  event, and equality with `GITHUB_SHA`; `release.yml:222` requires a
  successful **push-event** CI run on the release branch — PR CI does not
  satisfy it.
- **`dev` already carries `2.41.0`.** `package.json:3`. The main bump in the
  original 040 was a no-op step; promotion carries the version with it. The
  post-release workflow is `dev-version-bump.yml`, and its PR moves `dev` to
  `2.42.0`.
- **Publishing is OIDC Trusted Publishing.** `release.yml:119` (`id-token:
  write`), `:153` (npm >= 11.5.1), `:285`. No `NPM_TOKEN`; verify provenance
  and `gitHead` after publish.

## 6. Risk classification — FOLDED

`7ce0ba518` (#3262) grants `contents: write` + `pull-requests: write`
(`release.yml:67`) and `7a529a2e8` (#3318) changes `pull_request_target`
processing, a declared trust boundary (`.github/AGENTS.md:16`). Both move R2 ->
R3. `3c7c021ec` (#3296) touches provider credential admission and also gets R3.

## 7. Icon wiring — FOLDED

The set is `MASKED_PROVIDER_ICONS` (`gui/src/provider-icons.ts:188`), not
`MASKED_MARKS`; `020` named the client-side set by mistake. `meta.svg` carries
three gradients, so the masking question does not arise — the mark is colour and
is drawn as an image. Provenance goes in the asset README, and the two ids get
explicit assertions rather than relying on the generic wiring check.

Reviewer's own non-blocking note, confirmed: no test enumerates every registry
provider's display name, and `tests/provider-workspace-data.test.ts` does not
need changing.
