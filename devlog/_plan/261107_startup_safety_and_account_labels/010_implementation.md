# Implementation: evidence, safe labels and presentation

Depends on the audited roadmap. Revalidate paths and current `origin/dev` at P.

## Desktop state contract

MODIFY `src/service/desktop-startup.ts`: retain `loginEnabled` and existing
fail-closed `viable` semantics; add additive `loginState: enabled | disabled |
unknown` to `DesktopStartupDiagnostic`. Creation: verified macOS registration
and launchctl evidence for the same app yields enabled; stable, unambiguous
disabled evidence for that app yields disabled; every mismatch, failure,
unsupported platform, race and older/default snapshot yields unknown. Never infer
disabled solely from `loginEnabled === false`. Establish the running app through
independent ownership/supervision evidence before attributing a negative registration.
Linux negatives and Windows are unknown until independently proven. Preserve
the existing protection credit and shared Rust/TS enabled-registration parity.
Map the existing two-capture Linux verified positive to enabled; never make the
presentation contradict its existing protection credit. Map both owned and unowned
supervised Linux positives to enabled; `tests/service/service-desktop-startup-linux.test.ts`
must cover the supervised path through health API and both UI presentations. The owned macOS path
currently derives executable identity from registration, so a missing registration
must use independently verified supervision plus durable ownership or stay unknown;
an install ID alone does not establish the executable.

For a disabled override require a uniquely parsed `disabled`/`true` override on
a valid registration for the independently identified app. Compare registration,
executable identities and override output across two captures, and revalidate
ownership revision and live parent/child process chain across the observation.
For absence require explicit `ENOENT`, independently established app ownership,
two absent observations and revalidated ownership and process identity. A dangling
link, permission error, another error, replacement, other copy or changed input is
unknown. If the required evidence cannot be obtained, absence stays unknown. Test
override changes, absent-to-created registration, ownership and parent changes,
and malformed/ambiguous `print-disabled` output. The tray's `Off` alone is not a
stable negative observation.

Field chain: creation in `src/service/desktop-startup.ts`; serialization via
`src/codex/autostart-health.ts`, its startup-health subprocess/cache and management
response; deserialization in `gui/src/pages/startup-shared.ts` and dashboard poll;
consumers in `gui/src/startup-health-ui.ts`, `gui/src/pages/startup-sections.tsx`,
`gui/src/pages/dashboard-core-poll.ts`, `gui/src/pages/use-dashboard-data.ts`,
`gui/src/pages/dashboard-overview-head.tsx`, `gui/src/pages/Startup.tsx`,
`gui/classic/src/pages/Startup.tsx`, `gui/classic/src/pages/startup-sections.tsx`,
`gui/classic/src/pages/dashboard-overview-head.tsx`, `gui/src/pages/Home.tsx`,
`gui/src/pages/SetupHub.tsx` and settings-seed types. Audit and test Home/SetupHub
checklist semantics against the evidence state. Search all
`loginEnabled`, `DesktopStartupDiagnostic`, `startupHealth` and status consumers
before coding. Missing/invalid field in an older response means unknown.

MODIFY GUI decision/presentation files above: a known desktop-owned or supervised
local proxy with unknown, stale, unavailable or missing login evidence presents a
neutral, accessible unverified state, not a warning or green protected verdict.
Verified disabled plus no independently verified protection displays action required;
verified enabled and viable displays protected. Service protection wins; custom
routing and independent real risks retain truthful handling. A total fetch failure
without reliable Desktop context remains an unavailable/error state, not an assumed
Desktop. Keep backend reboot safety conservative. Carry this classification through
settings seeds, dedicated polls, session cache and revisits; invalidate or safely
reinterpret old status-only cached entries. Exercise cold ownership-only fallback,
stale prior enabled/off, failed refresh, older payload, seed/poll ordering and an
independent risk. Preserve fast stale refresh and do not suppress unrelated risks.
Update parent-level stale/failure banners as well as section heroes in both editions;
Classic's dashboard must explicitly handle the new neutral presentation, never fall
through to the green/native state. Render tests for both editions must cover stale,
failed refresh and old cache, plus the other state cases above.
Use a single concise hero explanation and a clear menu action; cards give short
status and recovery contains commands, not repeated prose. An existing desktop
command may be used only if its availability and ownership safeguards are verified;
otherwise give the menu instruction without mutating login items. Preserve keyboard,
semantic status and live-region accessibility. Do not change shared label styles.
For verified-off guidance direct the user through the OpenCodex menu without claiming
that toggling the item resolves a macOS system-disabled override: the tray opens Login
Items settings for that case. Update the unconditional backend recommendation too.
Also update the separate CLI summary in `src/codex/autostart-health.ts` so it does
not claim a menu toggle can clear a system override.

## OAuth identity contract

MODIFY `src/server/management/oauth-account-routes.ts` and, if appropriate, a
small existing privacy helper: add a named masked label from the stored identity,
independent of `privacy.maskEmails`. Validate email shape before masking because
`src/lib/privacy.ts` returns malformed non-email input unchanged; absent, malformed
or ambiguous identities produce no label. Keep current email configuration behavior
for other consumers. Never log raw account identifiers or expose raw email through
the new label. Field chain: stored credential -> roster projection -> JSON response
(including quota projection) -> `OAuthAccount` in `gui/src/hooks/useProviderAccountPools.ts`
-> `gui/src/provider-workspace/auth.ts` -> `ProviderAuthPanel.tsx`, dialogs and
confirmation/notification consumers. Check secondary text for raw-email leaks.
Replace `ordinalOnly` with alias, the new masked label only, then localized ordinal
for all OAuth pools, including both Anthropic instances; an old server without the
field must not fall back to the config-dependent email. Update both `OAuthAccount`
and `OAuthAccountRow` in `gui/src/components/provider-workspace/types.ts`, row
headings, accessible names, threshold controls, coupon/grant dialogs and switch,
pause and remove confirmations and notifications. Remove raw `account.email` from
secondary identification and replace the no-roster `oauth.email` status fallback
with a safe label or generic localized status. Test these surfaces with masking off,
missing field, malformed identity, alias and both Anthropic instances. Never use
opaque IDs as labels.
Include `gui/src/pages/tray-data.ts`, both `gui/src/pages/Tray.tsx` and
`gui/classic/src/pages/Tray.tsx`, their accessible switch names and
`gui/tests/tray-data.test.ts`: OAuth rows use alias -> safe masked label -> localized
ordinal while preserving existing Codex and API-key behavior. Pass source kind and
translation context where necessary instead of treating all roster shapes alike.
OAuth secondary identification may use only the server-projected safe label or be
omitted; never derive it from the configurable email, including for older servers.
Render both editions' trays with alias, safe label and a missing safe field plus a
populated legacy email; verify secondary text and accessible switch names. Preserve
Codex and API-key secondary behavior.

## Regression and documentation map

MODIFY `tests/service/service-desktop-login-registration.test.ts`, shared login
fixtures as necessary, `tests/service/service-desktop-startup.test.ts`,
`tests/service/service-desktop-startup-health.test.ts`, and startup API/cache
tests (`tests/service/autostart-health.test.ts`, `tests/config/settings-startup-health-seam.test.ts`,
`tests/server/startup-health-packaged-probe.test.ts`) for enabled, verified off, missing/invalid evidence, races, another copy,
stale state and service protection. Preserve Rust fixture parity and run its tests
if the shared fixture or Rust contract changes. MODIFY `tests/gui/startup-health-ui.test.ts`
and dashboard render/poll tests for unknown/off/enabled and old payload, including
single explanation and Home/SetupHub checklist cases. MODIFY `tests/gui/provider-workspace-auth.test.ts` and OAuth
management tests (`tests/oauth/oauth-accounts-api.test.ts`,
`tests/server/account-pool-management-api.test.ts`, `tests/server/provider-account-quota-routes.test.ts`)
for both Anthropic instances, aliases, masked vs unmasked privacy
configuration, malformed identities, quota response and accessible labels. Write
the behavior regressions first, run them and record red before implementing.

MODIFY every GUI locale for new/changed copy; check complete key parity, not only
lint. MODIFY `docs-site/src/content/docs/guides/desktop-app.md` and relevant
translated descriptions to avoid contradiction; MODIFY the owners identified in
`structure/INDEX.md`, especially `structure/desktop-start-at-login.md`,
`structure/ops/service-and-sidecars.md`, and `structure/gui-and-management-api.md`.
Do not add a new test file without both layout registration and expected fixture.

Verification: run named focused tests, `bun run test:changed`, GUI tests/lint/build, root typecheck,
`bun run structure:check`, privacy scan, file-size ratchet and GUI i18n plus
React Doctor. Baseline commands and their target coverage are in `000_plan.md`;
revalidate additional commands against package scripts and tests before execution.
No full root suite: owner explicitly requires moderate host load. Run the GUI with
temporary isolated `OPENCODEX_HOME`, `CODEX_HOME`, Claude homes, a non-default
port and synthetic accounts; capture before/after using GOAT browser, upload only
through the `pr-assets` branch and link immutable commit SHAs. Never touch the real
app, service, login items or credentials. Check each conditional path through its
named tests and visually inspect both startup and account surfaces.

Concrete focused commands (in repository root): `bun test tests/service/service-desktop-login-registration.test.ts tests/service/service-desktop-startup.test.ts tests/service/service-desktop-startup-linux.test.ts tests/service/service-desktop-startup-health.test.ts tests/service/autostart-health.test.ts tests/config/settings-startup-health-seam.test.ts tests/server/startup-health-packaged-probe.test.ts`; `bun test tests/oauth/oauth-accounts-api.test.ts tests/server/account-pool-management-api.test.ts tests/server/provider-account-quota-routes.test.ts tests/gui/provider-workspace-auth.test.ts tests/gui/startup-health-ui.test.ts`; and from `gui/`, `bun test tests/startup-minimal.test.tsx tests/startup-revisit-cache.test.tsx tests/dashboard-contracts.test.ts tests/tray-data.test.ts` plus affected account render tests. The named tests import their targets directly; the baseline startup/UI and OAuth commands ran successfully as recorded in 000, while the added suite commands must be run and recorded before relying on them. Add main/Classic rendered regressions through the real Vite Classic overlay, not raw Bun imports: `vite.classic.config.ts` resolves Classic files to overrides or shared `src` dependencies. Exercise the built `/classic/` through the fixture-backed proxy in GOAT alongside the main edition; assert stale, failed refresh and old cache there, and record observable DOM and screenshots. `bun run build` in `gui/` builds both editions using the overlay.

Baseline command `bun test tests/config/settings-startup-health-seam.test.ts tests/server/startup-health-packaged-probe.test.ts tests/server/account-pool-management-api.test.ts tests/server/provider-account-quota-routes.test.ts tests/service/service-desktop-startup-linux.test.ts` exited 0 with 110 passing tests; these files directly import the named backend modules. This validates baseline targets, not the future change.

Isolation must account for `src/config/owner-registry.ts`: a custom OpenCodex
home alone still writes its locator under the default home. Use the existing test
guard and a temporary `OCX_OWNER_REGISTRY_DIR`, and verify all client and service
paths are isolated before starting any proxy. macOS `homedir()` may still resolve
the real account; do not rely on a HOME rewrite alone. A guard refusal is a test
setup failure, not permission to use the real installation.

Use a fixture-backed test proxy rather than a real desktop process: the existing
management reader seam in `src/server/management/context.ts` injects controlled
startup-health data, and the settings seed and dedicated startup endpoint must both
return the same chosen enabled, disabled or unknown fixture. Seed synthetic OAuth
accounts through test-owned state; block external quota/network probes. Confirm the
real GUI is served by that isolated proxy and inspect the relevant two pages in GOAT.

## Implementation-cycle planning

Prior D: roadmap audit passed; the original assumption that the configured email
projection was always masked was rejected. At `51db5cd279` the implementation
architect proposed P-ARCH-01 through P-ARCH-06: accept the additive conservative
contract, independently anchored negative evidence, shared neutral presentation,
state-specific guidance, dedicated masked roster projection and fixture harness.
The plan incorporates the existing Linux positive, Home/SetupHub checklist and CLI
summary. The same architect returned ALIGNED on all six decisions; its `test:changed`
verification omission was accepted and added above. Implementation audit round 1
identified three medium findings: tray consumer chain, unowned Linux positive and
specific verification targets. All were accepted and added above. Same-architect
reflection initially found missing secondary tray identity coverage; that was added,
and its targeted recheck returned ALIGNED. Same-reviewer re-audit returned PASS,
with all three findings closed and no new high or critical gaps.

## Implementation evidence so far

The new UI regressions first failed on the unknown Desktop "Action required" banner
and on an Anthropic alias rendered as an ordinal; the new API regression failed on
the absent masked label. Focused reruns passed after implementation. The GUI suite
ran 3,950 tests with zero failures before the final target-switch guard; that guard was
subsequently covered by `gui/tests/dashboard-resource-deadline.test.tsx` (2 pass).
The latest focused backend run had 296 pass, and the latest GUI slice had 55 pass.
Root typecheck, GUI build/lint/i18n, locale parity, file-size ratchet, privacy scan,
structure check and React Doctor changed-file scan passed. The full root suite was
not run as requested. `bun run test:changed --parallel=1` exceeded the runner's
900-second limit and exited 124; it did not complete, and one GUI classifier edit
occurred during the run. Do not describe it as passing. The focused files and
`ci:full` cover the pending verification; exact-head hosted results are still needed.

The isolated browser reproduced the old warning and ordinal labels, then observed a
neutral unknown state and masked synthetic account names in both main and Classic.
The proxy ran with temporary homes, test guard, an in-memory provider keychain,
loopback-only sandbox networking, and denied `security` and `launchctl` execution;
quota requests failed under that deliberate network restriction. Before/after images
are stored at the `pr-assets` commit 90a1122d79edcf3ae74d8b3cccc15dd70d9d9f4f.
GOAT's credential expired after its server restarted, so enabled/disabled browser
scenarios and the required fresh independent implementation/security review remain
unverified. The fixture-based tests cover those state mappings, but do not replace
the requested review or the remaining browser observation.

The implementation also verifies a consistently absent macOS login item for the
independently observed running Desktop, including owned and supervised cases. Its
failing-first regression initially returned unknown; after the fix, 159 desktop/login
registration tests passed. A reappearing item, dangling link or changed ownership
does not receive a disabled verdict. Typecheck, the file-size ratchet, privacy scan
and structure check passed after this addition. The draft PR remains subject to the
same pending review and exact-head CI gates.

A further presentation regression showed that a verified enabled login item with
an independent viability problem was incorrectly treated as unverified. The focused
UI test failed first (expected `at-risk`, received `unverified`); after restricting
the neutral classification to unknown or stale evidence it passed, 20 tests total.
This does not change the conservative backend protection calculation.

An interim independent implementation review requested follow-up for the native
tray's account projection, stale readings without Desktop context, process/owner
races, and checklist retries. The new stale and enabled-evidence race regressions
failed before their fixes and pass afterward. A later recheck found that an exception
during the final process read could still retain enabled credit; its regression also
failed first and passed after the fix. Native tray tests passed in an isolated Rust
harness (11 tests); the rendered Home/Setup checklist tests passed (5 tests), including
stale-to-protected and stale-to-disabled transitions. The native panel follows its
existing English UI convention for ordinal fallback. The required fresh GOAT review
on the final head remains pending.

After those fixes, `cd gui && bun test tests` exited 0 with 3,956 tests and
`cd gui && bun run build` exited 0 for both editions. The focused startup and
checklist suites, root typecheck, GUI lint and i18n lint, privacy scan, structure
check, and file-size ratchet also passed. The root full suite remains unrun by
owner request, and the timed-out `test:changed` run is not passing evidence.

The branch was combined with `origin/dev` at `35d5010f502a` after the dashboard
layout change landed. The sole documentation conflict was resolved with both
contracts preserved. On that combined tree the GUI suite passed 3,965 tests;
typecheck, GUI lint and i18n lint, structure check and file-size ratchet passed.
Final-head CI, refreshed browser observations and the fresh GOAT review are still
required before integration.

Exact-head Ubuntu shard 5 on `91f86939c4` found three Windows fixture assertions
that omitted the additive `loginState: "unknown"` field. The Windows supervision
suite reproduced all three failures locally; after updating those expectations,
all 17 tests passed, including the conservative claim-only cases. The failed CI
run remains failed evidence and must be replaced by checks on the corrected head.
