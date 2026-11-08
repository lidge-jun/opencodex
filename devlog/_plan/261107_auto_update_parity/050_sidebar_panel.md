# Sidebar and update panel — draft unit

**Status:** pending architecture proposal, upstream engine contract and
independent roadmap audit. Do not implement from this draft yet.

## Outcome and boundaries

The proposed dashboard footer would expose desktop update state through the
existing download orb and open the planned update panel. For browser/package
installations, the existing dashboard update flow remains available. The native
update page retains sole native update-command authority
(`desktop/src-tauri/src/lib.rs:272` at the inventory baseline,
`desktop/src-tauri/src/window.rs:115`).
The footer's displayed version must fit ordinary stable versions; long versions
remain fully readable without overlapping action buttons, at normal and narrow
widths and in supported zoom modes.

## Proposed file map and contract changes

| Operation | Path | Before → after |
| --- | --- | --- |
| MODIFY | `desktop/src-tauri/src/updater.rs` | Six-field snapshot (`:159`) → versioned, bounded projection of the upstream engine's authoritative phase and progress; preserve session identity, heartbeat and stale-state semantics. The precise shape must be agreed with the engine unit. |
| MODIFY | `src/update/desktop-badge.ts` | Exact six-field parser and availability-only projection (`:31`, `:74`) → explicitly versioned decoder supporting old shell snapshots and the new projection; validate all phase/progress combinations and preserve unknown on missing or expired evidence. |
| MODIFY | `src/server/management/sidebar-routes.ts` | Keep authenticated/capability-bound snapshot publication, its body limit and existing read route (`:105`); only change if the agreed projection requires it. Never add an installation action to this endpoint. |
| MODIFY | `desktop/src-tauri/src/proxy.rs`, `src/update/badge.ts`, `gui/src/lib/desktop-shell.ts` | Negotiate snapshot schema from the bound publication response and use a distinct desktop badge v2 DTO; leave package badge and legacy DTO shapes unchanged. |
| MODIFY | `gui/src/components/sidebar-github-row.tsx` | Availability-only accent (`:133`) → localized and accessible current, available, downloading percentage, ready and failed indications. Unknown/checking is distinct from current. Continue using the existing download button. |
| MODIFY | `gui/src/App.tsx`, `gui/src/design/bridge.css` | Preserve desktop page navigation (`App.tsx:591`); fix footer version sizing and wrapping (`bridge.css:428`) without covering star, update or terminal buttons. Keep full version accessible on mobile. |
| MODIFY | `desktop/ui/update.html`, `desktop/src-tauri/src/lib.rs` | Existing check/install page → native panel consuming the engine's typed status and controls: channel, download and install preferences, release notes, restart and Later. New commands, if required, use the existing local update-page guard; no raw HTML insertion for release notes. |
| MODIFY | `gui/src/i18n/{en,ko,ja,zh,zh-TW,fr,de,ru,pt,tr,vi}.ts` and applicable desktop localization owner | Add every new visible label in all supported locales, with real translations; verify the desktop page's existing localization mechanism before selecting its implementation. |
| MODIFY | `tests/update/update-desktop-badge.test.ts`, `tests/server/sidebar-routes.test.ts`, `tests/clients/desktop-update-surface.test.ts`, `gui/tests/sidebar-version-layout.test.ts`, `gui/tests/desktop-shell.test.ts` | Add meaningful behavior cases for old/new snapshots, state projection, page authority, panel controls and version accessibility. Source-read tests must run explicitly because `test:changed` cannot follow file reads. Add a focused GUI behavior test if no current harness covers the footer. |
| MODIFY | Relevant `structure/` owners from `structure/INDEX.md`, `docs-site/src/content/docs/getting-started/installation.md` and corresponding translated pages | Record current behavior only after implementation; update each affected owner and avoid contradictory localized instructions. |

New repository test files belong in their `tests/<domain>/` directory and
require layout and expected-shard registration. Keep ratcheted files within their current line caps; move code to
appropriately owned siblings rather than increasing baselines. The complete
file map must be revalidated after the engine unit lands.

For package-owned browser installations, extend the existing dialog rather
than creating a second installer UI: `gui/src/pages/dashboard-dialogs.tsx`,
`gui/src/pages/use-dashboard-data.ts` and `gui/src/pages/dashboard-shared.ts`
read the versioned package policy/status, expose latest/preview/nightly and
check/download/install controls, and send revision-bound policy changes. Add
the separately versioned check/apply routes and owner-provenance consumers named
in `010`/`040`; the current two-channel routes and old dialog keep their exact
wire contract. An old client against a nightly installation gets an actionable
unsupported state, not an inferred preview update. Add focused GUI and
management tests for three-channel selection, changed revision, unavailable
provenance, old/new clients and explicit manual update. Update all eleven GUI
locale catalogs and the affected docs-site translations.

## Proposed desktop snapshot v2

The native publisher adds `schema: 2`, a monotonically increasing per-session
`sequence`, `phase`, `installedChannel`, `policyChannel`, `candidateChannel`
and a bounded integer `progressPercent` (0–100 or null) to the existing
session/current/latest/availability/check-time fields. Allowed
phases are `idle`, `checking`, `current`, `available`, `downloading`, `ready`,
`installing` and `failed`; failed requires a closed, non-sensitive `errorCode`,
while other phases use null, never raw errors or release notes. Enforce an exact key set and
phase-specific constraints under the existing 1 KiB request cap
(`src/server/management/sidebar-routes.ts:113`; native proxy cap must also be
kept). Sequence ordering is per session: a late lower sequence cannot overwrite
newer state; a heartbeat at the same sequence may extend expiry only for the
same payload. Unknown versions and stale/missing session evidence remain
unknown. Reject malformed v2 without changing a prior good state.

Each channel field is `latest`, `preview`, `nightly` or null. The native owner
populates `installedChannel` only from verified provenance bound to the current
installation and actual artifact, `policyChannel` from its valid selected
policy, and `candidateChannel` only from the verified candidate. These fields
can differ after an explicit channel switch. `candidateChannel` must be null
when `latestVersion` is null; it may be null for a retained target whose
provenance is unavailable. Null remains unknown and never implies preview from
the version spelling. The session-authenticated publisher sends the values in
the same bounded v2 body; the server parses and projects them only as display
observations, without granting install authority. A new runtime/session clears
the projection and renegotiates. Legacy v1 snapshots remain decodable but
their absent installed and candidate channel evidence projects unknown; their
availability-only behavior remains intact.

Upgrade the server decoder and projection before publishing v2. It accepts both
v1 and v2; a v1 shell keeps its existing availability-only behavior. Proposed
negotiation: a new shell first publishes a valid v1 snapshot. A new server's
successful response adds a bounded `snapshotSchemas: [1, 2]`; the old server's
existing `{ok:true}` means v1 only. The native publisher upgrades to v2 only
after a successful response from the currently attested runtime; when the
runtime identity changes it resets to v1 and negotiates again. Authentication,
transport and parsing failures do not count as negotiation or current status.
`desktop/src-tauri/src/proxy.rs:218` currently discards the success body and
must return the validated schema selection without weakening its body-bound
publication capability. Add old-shell/new-server, new-shell/old-server,
runtime-replacement, malformed-response and auth-failure tests. Add a separate
desktop projection DTO without changing package badges.

### Desktop badge response compatibility

The existing `GET /api/update/badge?surface=desktop&session=<uuid>` and its
`UpdateBadge` DTO retain their legacy field names and non-null two-channel type
(`src/update/badge.ts:6`). If the current snapshot has verified installed
provenance for `latest` or `preview`, the old endpoint would return the old
shape with that channel. For a v1 snapshot it would preserve the current
availability projection and legacy `defaultUpdateTag(currentVersion)` label;
that compatibility label is not verified provenance or installation authority.
Missing or expired snapshots retain the existing unknown response. A v2
snapshot whose provenance is absent or is `nightly` would return HTTP 409 with
bounded code `desktop_channel_unavailable`, rather than invent a third legacy
enum. The package endpoint without `surface=desktop` remains unchanged. Test
an old sidebar against a new server and both v1 and v2 shell snapshots.

Add separately registered `GET /api/update/desktop-badge-v2?session=<uuid>`
with the same dashboard-session read authorization as the existing GET. Its
closed `ocx.desktop.badge/2` object has exactly `schema`, `sessionId`,
`currentVersion`, `latestVersion`, `updateAvailable`, `unknown`, `phase`,
`progressPercent`, `errorCode`, `installedChannel`, `policyChannel`, and
`candidateChannel`. `schema` is the literal `ocx.desktop.badge/2`; `sessionId`
is the requested validated UUID or null when no session is supplied;
`currentVersion`, `latestVersion`, `phase`, `progressPercent`, `errorCode` and
the three channels are null when no current trusted snapshot supplies them.
`updateAvailable` is false and `unknown` true without a current snapshot.
With one, phase/progress/error and nullable channels obey snapshot v2 rules;
a v1 snapshot can retain available/current display state but supplies null
channels: v1 `error` and `install-failed` map to v2 `failed` with errorCode
`unknown`, while other v1 phases retain their names and progress is null.
No field is installation authority. Reject duplicate or unexpected
query keys and invalid UUIDs with a bounded 400 result; absent session returns
the unknown DTO. No cache may carry a projection between sessions.

The updated desktop sidebar constructs the v2 URL and strictly parses this
DTO in `gui/src/lib/desktop-shell.ts` and
`gui/src/components/sidebar-github-row.tsx`; a 404 from an old server, malformed
response, or unavailable session produces unknown while leaving the update
control clickable. It must not use the old inferred channel as a fallback.
The GUI must also use `lastAttemptOk` or an equivalent explicit freshness flag:
after a rejected request, malformed JSON or timeout, retained warm-cache data
is labelled stale/unknown and cannot be presented as a current successful
observation. An HTTP 409/404 or session change clears or isolates prior data;
an independently verified staged install remains controlled by its native
owner, not by the badge cache. Test a warm `current` and `ready` observation
followed by rejection, malformed JSON, timeout, 409 and runtime replacement.
Add explicit serialized-response, versioned GUI parser and route tests in
`tests/update/update-desktop-badge.test.ts`,
`tests/server/sidebar-routes.test.ts`, `gui/tests/desktop-shell.test.ts` and a
new `gui/tests/sidebar-desktop-badge-v2.test.tsx`. Cover old/new shells and
servers, missing/expired/v1/v2 snapshots, same version spelling with preview
versus nightly provenance, policy/candidate changes and runtime replacement;
assert the package and representable legacy responses retain their exact DTO.

The v2 decoder uses the existing UUID, version and checked-time bounds. The
new `sequence` is a nonnegative JSON safe integer, and `progressPercent` is null
or an integer from 0 through 100. `errorCode` is null or one of `network`,
`feed-unavailable`, `verification`, `ownership`, `busy`, `installation`,
`recovery` or `unknown`; the UI localizes codes and never renders raw errors.
All keys are required even when their value is null. `available` is exactly
whether `latestVersion` is non-null; any target requires `checkedAtMs`.

| Phase | Target and time | Progress | Error |
| --- | --- | --- | --- |
| `idle` | no target; no check time | null | null |
| `checking` | prior target/time may be retained; absent target may retain a prior check time | null | null |
| `current` | no target; check time required | null | null |
| `available` | target and check time required | null | null |
| `downloading` | target and check time required | integer or null while total is unknown | null |
| `ready` | target and check time required | null | null |
| `installing` | target and check time required | integer or null while total is unknown | null |
| `failed` | target and check time may be retained together; with no target, check time may be null | null | required code |

Reject a phase/field combination outside this table, a nonidentical payload at
the same sequence, and a lower sequence without replacing the last good
snapshot. A new session never inherits a prior session's sequence or state.
The exact size cap applies after serialization, including multibyte text.
Test equal `-preview.*` version strings with distinct authenticated preview and
nightly provenance; policy loss and channel switching; candidate invalidation;
session/runtime replacement; old v1 snapshots; malformed/oversized v2; and
stale ordering. Assert each v2 provenance channel separately and refuse inferred
preview as provenance or installation authority. Test the legacy v1 display-only
compatibility label and availability exception described above.

The v1 encoder uses only the existing exact six-field shape. `idle`,
`checking`, `current`, `available` and `installing` preserve their old
meanings; `downloading` and `ready` project as `available` with the target
and its successful check timestamp. `failed` projects as `install-failed`
when a target is retained, or `error` when none is known. `current` carries
no target and a successful check timestamp; `idle` carries neither. A failed
check with no known target stays unknown, never current. Validate these cases
against the existing v1 parser (`src/update/desktop-badge.ts:31`) and the
oldest supported shell/server combinations before locking the contract.

The desktop footer refreshes the session-scoped badge every five seconds and
every second during `downloading` or `installing`; package/browser polling stays
at its current ten-minute cadence. Apply resource deduplication and stop polling
when the component unmounts. Release notes are fetched from the trusted panel
status, not placed in the 1 KiB heartbeat. These schema and timing values are
proposals subject to audit, and must be tested against both shell/server orders.

## Proposed native panel commands

All commands require the existing exact local update-page guard. Add
`update_panel_status()` returning `ocx.desktop.update/2` with current version,
candidate version/channel, phase, bounded progress/error code, policy and
revision, sanitized release-note text, and deferred state. Add
`update_panel_policy({expectedRevision, channel, check, download, install})`
with compare-and-swap semantics; a mismatch returns the current status without
changing it. The install control exposes manual, on-quit and when-idle policy
with the consent and Later semantics in `030`. Add `update_prepare({candidateId})`,
`update_defer({candidateId})`, and `update_activate({candidateId})` returning
the same status plus a bounded accepted/refused result. The native owner
validates IDs and rechecks candidate, policy and ownership; the caller cannot
supply a filesystem path or trust decision. Keep existing `update_status`,
`update_check`, `update_install` and `return_to_dashboard` compatibility and
route them to the same claim and verified installer owner. Exact result field
names and legacy compatibility tests must be frozen with the engine unit.

Proposed `ocx.desktop.update/2` is a closed result with `schema`,
`currentVersion`, `candidate`, `checkedAtMs`, `phase`, `progressPercent`, `errorCode`,
`stageReadiness`, `checkError`, `policyState`, `policyObservation`, `policy`, `releaseNotes`,
`omittedReleaseCount` and `deferred`. `stageReadiness` independently reports
`none`, `ready` or `unknown`; `checkError` is a bounded code or null. A failed
check may coexist with a retained ready stage, so the panel shows the error and
the valid install action together. `policyState` distinguishes valid, corrupt,
unreadable and missing-after-initialization policy; `policy` is null unless
valid. For a safely observed corrupt or missing-after-initialization record,
`policyObservation` is a bounded opaque owner-issued token;
otherwise it is null. It contains no record contents or credentials and expires
on owner restart. `candidate` is null or
`{id, version, channel}` where `id` is the lowercase SHA-256 identity of the
verified candidate; `policy` is `{revision, channel, check, download, install}`
with the values defined by `030`; `releaseNotes` is an array of at most six
`{version, items}` groups, each with at most eight plain-text items of at most
220 Unicode characters, and `omittedReleaseCount` is a nonnegative safe integer
or null when the total cannot be established. The whole encoded result is
bounded to 32 KiB; `deferred` is boolean and may be true only for a candidate.
Phase, progress and error follow the table above; a target-requiring phase must
have a candidate. Construct release links from an allowlisted release origin
and the validated exact version; do not navigate to a feed-supplied arbitrary
URL. A malformed or unavailable status is displayed as unknown.

For corrupt or missing-after-initialization policy, disable revision-bound preference changes and offer the
proposed `update_panel_repair_policy({expectedObservation, channel})` only from
the guarded local update page after a deliberate operator action. The native
policy owner serializes repair with normal writes, rechecks that the observation
still describes the same record or verified absence, preserves any recoverable prior data privately,
and atomically creates a valid policy with the explicitly chosen channel and
manual check, download and install settings, using a newly reserved revision
above the durable high-water mark described in `030`. If the mark cannot be
established, repair refuses; it never reuses an earlier revision. A changed observation refuses the
repair and returns fresh status. If the record cannot be read or safely
preserved, repair refuses and the panel shows recovery guidance; it never
silently replaces an unreadable record. Successful repair returns a valid policy
and revision before normal changes resume. Owner and panel tests must cover
corrupt, unreadable and lost records, refusal, successful repair, stale observations,
stale policy changes and prepared actions across repair, high-water loss,
concurrent writes and owner restart.

The signed release owner supplies same-channel notes for releases newer than
the installed version through the selected candidate. It verifies every
release record used to create a group, orders groups newest first, and reports
omitted groups when a complete bounded history is known; a missing or
unverifiable history gives a null omission count rather than inventing one.
`010` binds each record's notes to its exact version/channel. Render every
item as text. Preserve the staged candidate's previously verified notes when a
later check fails, reports no update or returns the same candidate without
notes (`030`). Test multi-version grouping, channel isolation, omissions,
truncation, malformed/unavailable history and retained ready state. GOAT's
reference groups and limits are `apps/desktop/src/updates/releaseNotes.ts:19`,
`:177`, `:208` at the pinned GOAT revision.

`update_panel_status` accepts no arguments and returns that object.
`update_panel_policy` accepts exactly `{expectedRevision, channel, check,
download, install}`; the revision is a nonnegative safe integer and the
values are closed enums. `update_panel_repair_policy` accepts exactly a valid
owner-issued `{expectedObservation, channel}`. `update_prepare`, `update_defer` and
`update_activate` accept exactly `{candidateId}`. Mutation commands return
`{schema: "ocx.desktop.update-command/1", outcome, reason, status}` where
`outcome` is `accepted` or `refused`, `reason` is a closed non-sensitive code
or null, and `status` is the freshly observed object above. The native owner
serializes and validates all arguments and uses its existing shared install
claim; an accepted request means accepted work, not installed/healthy.
Unparseable arguments or an origin rejected by the guard are command errors
without state mutation. Client timeout remains unknown until status is read;
the page does not resubmit activation automatically.

Keep the legacy commands' existing five-field `PageUpdateStatus`
(`desktop/src-tauri/src/updater.rs:263`) and legacy failure behavior for older
bundled pages, with one engine/claim behind both versions. The new page must
detect an unavailable v2 command, display an actionable compatibility state,
and never issue a second install after an uncertain old-command result. Test
legacy/new pages with old/new shell APIs and concurrent old/new command calls.

## Locale handoff

The dashboard owns its selected locale (`gui/src/App.tsx:152`) and persists it
on the dashboard origin (`gui/src/i18n/provider.tsx:13`). The trusted bundled
update page is a different origin (`gui/src/lib/desktop-shell.ts:36`), so it
cannot rely on that local storage. Proposed navigation passes only the selected
closed-set locale as an encoded query value to the existing `/update.html`
path. The bundled page validates it against the eleven supported locale IDs
(`gui/src/i18n/shared.ts:6`), falls back to `en` for missing/invalid input, and
sets the matching HTML language. Locale is display data and grants no native
authority; `require_update_page` must continue to check the exact bundled
origin and path (`desktop/src-tauri/src/window.rs:115`).

The existing Back command uses a stricter settings-page guard that rejects all
queries (`desktop/src-tauri/src/lib.rs:301`, `desktop/src-tauri/src/window.rs:134`).
Change its update-page branch to accept either no query or exactly one `locale`
query whose decoded value is one of the eleven supported IDs. Continue to
require the main window, exact app origin/path, no userinfo or fragment, and
reject duplicate or unknown query keys. The CLI settings page keeps its
existing no-query rule. Add Rust URL-predicate tests and desktop-page tests for
`/update.html?locale=ko` returning to the dashboard, invalid/duplicate values,
other origins and CLI-page queries. The current guard is not assumed to accept
the new navigation without this change.

Produce `desktop/ui/update-locales.json` deterministically from a React-free
typed table `gui/src/i18n/desktop-update-copy.ts` using
`scripts/generate-desktop-update-locales.ts`; include a `--check` mode in the
desktop build to detect drift. Bundle all eleven translations and keep the
source table as the single owner of panel copy. Render only text, never
HTML from release notes or locale input. Add a test that every locale has each
key and that invalid locale inputs cannot change origin or inject markup.
Test the generator, build check and bundled Tauri asset loading. Do not add a
runtime network fetch for translations.

## Activation scenarios and evidence

- Old desktop snapshot is accepted by the newer server and preserves its prior
  available/unknown meaning; unknown phases and malformed fields are rejected.
- Missing, expired or another session's snapshot shows unknown; a check failure
  never displays up-to-date; a retained ready stage stays installable while the
  check error is shown. A current result, available version, progress,
  staged result and failure each produce distinguishable labels and states.
- A browser dashboard click reaches its existing package dialog; a desktop click
  reaches the bundled panel. Requests from a non-update page cannot invoke
  privileged native update commands.
- Preferences survive reopening; Later defers activation and does not erase the
  verified staged update. Release notes render as safe text with an appropriate
  release link. A failed download or install gives a retryable, accurate state.
- At normal and narrow desktop widths, mobile drawer width, 90% and 100% zoom,
  the footer text and all controls remain visible and usable; test long version
  identifiers, keyboard focus and screen-reader labels. Capture before/after
  UI screenshots through the authorized `pr-assets` path, never in the PR branch.

## Candidate validation

Baseline discovery has run the two badge test files (17 pass) and, from `gui/`,
the sidebar version and row tests (12 pass); see `001_inventory.md`. During
implementation run failing-first focused tests, the explicit desktop surface
and sidebar-route files, `bun run typecheck`, `bun run privacy:scan`,
`bun run structure:check`, and from `gui/` `bun run lint:i18n`, `bun run lint`,
`bun test tests` and `bun run build`, plus rendered browser/native proof. These
commands are candidate gates; establish their exact change coverage and record
fresh results before the roadmap is locked or the PR is review-ready. No full
root suite. PR CI must be evaluated at the exact head; request the separate
security review if any authority, updater or installation surface changes.

Baseline on 2026-11-07: `bun test tests/server/sidebar-routes.test.ts
tests/server/link-management-relay.test.ts` passed 31 tests (exit 0) with
isolated test homes and ephemeral listeners. The sidebar file exercises the
existing six-field snapshot's route, session separation, input limits and
authorization. The relay file exercises the existing passive link boundary.
Neither test proves the proposed v2 snapshot or native panel; add those cases
and demonstrate their initial failure before implementation.
