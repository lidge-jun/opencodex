# 050 — closeout

Terminal record for the auth-auto unit. Round-5 review findings and their disposition,
evidence per criterion, and what did NOT improve.

## Round-5 independent review (fresh agent, whole-diff)

A fifth reviewer, uncontaminated by the plan, was run over `911373db..HEAD`. It
reproduced every claim empirically rather than reading for shape. Two BLOCKERs, three
MAJORs, three MINORs.

### BLOCKER 1 — the migration ate `auto` (REAL, fixed)

The sharpest failure in the unit, and the plan's own migration caused it.
`runClaudeAuthModeMigration` gates on "a `claudeCode` block with no `authMode`" and reads
that as a pre-upgrade subscriber. But post-upgrade:

- choosing **Auto** DELETES `authMode` (`agent-settings-routes.ts` PUT branch), and
- merely toggling Claude **on** creates the block (`gui/src/App.tsx:172` PUTs `{enabled}`).

Neither wrote `authModeMigratedAt`, so the sentinel could not tell pre- from post-upgrade
and the next `startServer` converted Auto into a sticky literal `subscription`.
Reproduced through the real HTTP surface: PUT `auto` → disk `{"enabled":true,...}` → one
restart → disk `authMode: "subscription"`.

Net effect: `auto` was reachable for exactly one proxy lifetime, then vanished with no
way back — the migration ate the feature it was written to protect.

**Fix:** stamp the sentinel on EVERY persist of the `claudeCode` block, not only in the
migration. Two regression tests drive a real restart (`startServer` → PUT → stop →
`startServer`), which the existing "unrelated PUT leaves auto on auto" test could not
catch because it never restarted.

### BLOCKER 2 — request-path save bypass (ALREADY FIXED before the report landed)

The reviewer found `codex/routing.ts:487` and `codex/auth-api.ts:220` calling bare
`saveConfig` on a live config. The A-phase sweep in `045` had found the same two
independently and converted them in `94509ebd`, with both added to the enforcement
test's guarded set. Confirms the audit finding rather than adding a new one.

### MAJOR 1 — our own admission key counted as user auth (REAL, fixed)

`detectExportedEnv` excluded only `PROXY_MARKER` from `ANTHROPIC_AUTH_TOKEN`, but
`system-env.ts` exports the CONFIGURED admission key into that same variable. So
opencodex read its own output back as proof the user can authenticate natively, and
`auto` resolved `subscription` for someone with no Claude login at all — the marker
feedback loop (002 §1) one variable over.

**Fix:** `AuthDetectDeps.ownTokens`, populated from `config.apiKeys` via
`ownAdmissionTokens`. Bound LAST at the `cli/claude.ts` call site and excluded from
`ClaudeEnvDeps` for the same reason `env` is: a test fake must not be able to replace it.

### MAJOR 2 — ambient-env dependence in a new test (REAL, fixed)

`claude-system-env-auto.test.ts` stubbed the keychain and redirected `HOME` but left
`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` inherited, so any runner exporting an
Anthropic key inverted the suite. Both are now cleared in `beforeEach` and restored in
`afterEach`. Same class as the bug that produced this test in the first place: the
detector reads more axes than the fixture isolated.

### MAJOR 3 — a shape assertion guarding the top security invariant (REAL, fixed)

"The probe never asks for secret material" was proved by slicing this file's source for
`"-w"` / `"-g"`, with a slice boundary that depended on an unrelated literal appearing
later. It would pass trivially against dynamically built args. Replaced with two
behavioural tests that observe the spawned argv and assert `stdio` stays fully ignored
(`-g` writes to stderr, so a captured pipe leaks even with correct args).

### MINORs — accepted, not actioned

Duplicate keychain-service literal and `CLAUDE_CONFIG_DIR` precedence differences versus
`oauth/local-token-detect.ts`, and the ~7-9 ms synchronous keychain probe on
`GET /api/claude-code`. The GUI does not poll that endpoint on an interval, so impact is
low; unifying the two detectors is a separate unit.

### Confirmed clean by the reviewer

No credential logging or serialization issue at BLOCKER or MAJOR severity. The probe
passes only `find-generic-password -s <service>` with all three stdio streams ignored,
and the `emailAddress` is never echoed. `buildClaudeEnv`'s 3-step ordering is correct,
detection cannot disagree with the spawned env, and `auto` cannot flip an authenticated
subscriber into proxy (`unknown` → `subscription` holds).

## What did NOT improve (LOOP-PESSIMIST-01)

- **F3 stands.** Subscription mode carries no `settings.json` env-hijack defence, by
  design: the host-managed flag without a token is the #253 failure itself.
- **Non-`claudeCode` subtrees stay unprotected.** A hand edit to `providers` is still
  clobbered by a service-time save. Asserted in a test so it cannot drift into an
  assumed guarantee.
- **The save TOCTOU window remains.** An edit landing between the raw read and the atomic
  write loses.
- **Daemon-vs-terminal detection divergence remains.** The daemon cannot see a key
  exported only in the user's shell; this is LABELLED via `detectionScope: "daemon"`, not
  eliminated.
- **`oauth/index.ts:601` (`runLogin`) is unarmed.** It saves a fresh `loadConfig()` long
  after startup, so it reads the hand edit off disk rather than clobbering from a stale
  in-memory snapshot — safe today, but it is outside the armed boundary and would break
  if it ever started holding the live config.

## Final gate evidence

`bun run test` 4709 pass / 0 fail (369 files) · `bun x tsc --noEmit` clean ·
`gui bun run test` 293 pass / 0 fail · `lint:gui` clean · `privacy:scan` passed ·
`build:gui` ok · docs-site build 131 pages.

Live smoke on this machine: real auth → `subscription` / `auto-present` /
`claude-json-oauth`, token unset; empty home → `proxy` / `auto-absent`, marker injected;
stale marker + auth present → marker stripped.
