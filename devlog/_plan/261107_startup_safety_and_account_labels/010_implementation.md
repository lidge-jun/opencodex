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
`gui/classic/src/pages/dashboard-overview-head.tsx` and settings-seed types. Search all
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

## Regression and documentation map

MODIFY `tests/service/service-desktop-login-registration.test.ts`, shared login
fixtures as necessary, `tests/service/service-desktop-startup.test.ts`,
`tests/service/service-desktop-startup-health.test.ts`, and startup API/cache
tests for enabled, verified off, missing/invalid evidence, races, another copy,
stale state and service protection. Preserve Rust fixture parity and run its tests
if the shared fixture or Rust contract changes. MODIFY `tests/gui/startup-health-ui.test.ts`
and dashboard render/poll tests for unknown/off/enabled and old payload, including
single explanation. MODIFY `tests/gui/provider-workspace-auth.test.ts` and OAuth
management tests for both Anthropic instances, aliases, masked vs unmasked privacy
configuration, malformed identities, quota response and accessible labels. Write
the behavior regressions first, run them and record red before implementing.

MODIFY every GUI locale for new/changed copy; check complete key parity, not only
lint. MODIFY `docs-site/src/content/docs/guides/desktop-app.md` and relevant
translated descriptions to avoid contradiction; MODIFY the owners identified in
`structure/INDEX.md`, especially `structure/desktop-start-at-login.md`,
`structure/ops/service-and-sidecars.md`, and `structure/gui-and-management-api.md`.
Do not add a new test file without both layout registration and expected fixture.

Verification: run named focused tests, GUI tests/lint/build, root typecheck,
`bun run structure:check`, privacy scan, file-size ratchet and GUI i18n plus
React Doctor. Baseline commands and their target coverage are in `000_plan.md`;
revalidate additional commands against package scripts and tests before execution.
No full root suite: owner explicitly requires moderate host load. Run the GUI with
temporary isolated `OPENCODEX_HOME`, `CODEX_HOME`, Claude homes, a non-default
port and synthetic accounts; capture before/after using GOAT browser, upload only
through the `pr-assets` branch and link immutable commit SHAs. Never touch the real
app, service, login items or credentials. Check each conditional path through its
named tests and visually inspect both startup and account surfaces.

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
