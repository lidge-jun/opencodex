# Lane G — onboarding, update and screen improvements as one flow

Status: OPEN. Branch `codex/260920-lane-g-onboarding-update`, cut from `origin/dev`
`043aa435ff`. One branch, ordered commits, one pull request against `dev`.

Roadmap item 16 asks for connect → confirm → change → check state → recover as a single user
flow, built on the server-owned preview that landed in #5185 and #5197. Six targets were named:
#5016, #4560, #5068, #2811, #5215 and #5216.

## The finding that shapes the flow

The dashboard is served by the proxy. `startServer` binds the listener and that same listener
serves `gui/dist`, so when the proxy stops there is no surface left to render a recovery panel.
The state #5261 was reported in — injected routing pointing Codex's own built-in provider at a
dead loopback port — is therefore a state the dashboard cannot be part of getting out of.

That is not a reason to leave the failure state undesigned. It moves where the design has to
land:

- **Recovery belongs to the surfaces that survive the proxy.** #5267 already placed it there:
  `ocx status` names `ocx restore` when the proxy is down and the routing is ours, the routing
  marker in `config.toml` now reads `(undo: ocx restore)`, and the troubleshooting page covers
  the manual edit for someone without the CLI.
- **The dashboard's job is disclosure before the fact.** It is the only surface present at the
  moment the integration is applied, and it is the one that will be gone if the proxy later
  stops. Naming the offline undo path at apply time is what turns a lockout into an
  inconvenience.

## What each target needed, and what this lane did

### #5216 — compaction panel (delivered)

Two strings described behaviour the code does not have. The panel decided combo-ness by testing
a `combo/` prefix, so a combo reached through an alias was described as an ordinary provider and
none of its targets were named. It now asks what the selection resolves to, keyed by the public
model id the server already computes, read through `parseComboList` — the same reader the combo
workspace uses, so the selector rule is not written down twice.

The warning claimed a covered compaction goes to every target including failover targets.
`core-combo.ts` dispatches one target per loop iteration, returns as soon as one responds, and
advances only after a retryable failure. An operator reading the old text would budget fan-out
cost and latency for something that never happens.

### #5215 — hand-copied registry values (delivered)

Thirteen presets restate a byte ceiling and a row ceiling in eight guides, checked by nobody.
Each value is now read from that preset's `modelDiscovery`.

Two details worth keeping: sections are located by brand name plus the presence of a `KiB`/`MiB`
token rather than by a translated phrase, because a restated anchor is the same hand-copied value
the guard exists to remove; and the byte ceiling is compared as an exact token set, so a stale
number left beside the current one fails instead of passing on a substring.

The guard immediately earned its keep. `structure/ops/docs-and-release.md` asserted in prose that
the guides carry the same limits. That was false when it was written: the Korean guide had no
Featherless section, so it documented twelve of the thirteen limited presets. The section is
added and the prose is replaced by a description of what is actually asserted.

### #4560 and #5068 — the two workspace pull requests (analysed, not merged)

The instruction was to review the actual difference and consolidate only duplicated screens. They
are not the same feature and must not be treated as one.

- 46 files and 39 files, intersecting in 31. Only **nine** of those 31 are byte-identical.
- **#4560** is the UI foundation: responsive grid, dual collapsible rails, unified filter,
  Cockpit Tools import, the quota-analysis regression suite and its layout registrations.
- **#5068** is the pool follow-up: generic pool enablement and strategy persistence, strategy
  preview, per-account quota refresh, remaining-token estimates calibrated from request logs,
  plan badges, switch notifications, modal focus trapping.

Three findings decide the sequencing, and none of them is "they overlap":

1. **#5068 removes behaviour #4560 keeps.** Its `ProviderAccountCard.tsx` drops the Grok coupon
   badge and the `ProviderAccountQuota` fallback. Landing #5068 after #4560 would silently
   revert them.
2. **#5068 changes an email-masking decision.** `account-quota-analysis.ts` adds `rawEmail` and
   prefers an unmasked value, where #4560 deliberately uses the management API's projected
   email. That is a privacy boundary, not a display preference, and it needs explicit review
   against the `emailMaskingEnabled` policy before either version lands.
3. **#5068 cannot land as it stands.** It folds the collapsed-sidebar CSS into
   `gui/src/styles.css`, which carries a committed cap of 2,958 lines; its head is 3,186. The
   ratchet only moves downward, so the remedy is the move #4560 already makes — a sibling
   `sidebar-collapsed.css` — not a new number.

Both are 28 commits behind `dev` and conflict on all ten locale catalogs through #5197, and
#4560 additionally conflicts on the two test-layout registries. Neither is a rebase this lane
could carry without absorbing the privacy decision above, so the differential is recorded here
for the coordinator to sequence rather than half-landed.

### #5016 and #2811 — the Codex CLI update manager (not started here)

#5016 is phase 2 of #2811 and is an open contributor pull request carrying its own plan/apply
engine. Phase 3 is the dashboard integration. Both are left to their own lane: carrying an
unlanded engine and building its surface in the same branch would put the authorization boundary
#5016 is built around under review twice.

## Remaining scope, stated rather than closed

The one src/ defect this lane identified and did not fix: `codexStatus` in
`src/server/management/native-integration-routes.ts` derives `state` from
`config.clientIntegrations?.codex` alone. It reports desired configuration, not what is
currently applied — it does not read `config.toml`, the routing kind, or the catalog pointer,
all of which `src/codex/injected-marker.ts` already exposes predicates for. So the dashboard
cannot answer "what is applied right now", which is half of the completion condition, and it
names no undo path at apply time, which is the disclosure the #5261 state needs.

The bounded shape of that fix: report the applied routing state from the file rather than from
intent, carry the undo command beside it, and render both on the Codex tab. It is a change to a
DTO that every native client shares plus ten locale catalogs, so it is its own commit set rather
than an addendum to a documentation lane.

## Verification

Static source review plus exact-head hosted CI. Local suites, individual tests, typecheck,
build, install and live `ocx` execution were NOT RUN.

Both delivered changes were simulated statically against the real files before commit rather
than assumed: the discovery-limit guard was run as a Python transcription of its own logic over
all eight guides, which is how the Korean gap surfaced and how the byte and row values were
confirmed to already agree with the registry everywhere else.
