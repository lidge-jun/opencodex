# Automatic update parity — roadmap draft

OpenCodex already checks for desktop updates and has a guarded package update
orchestrator. This unit extends those owners into a user-controlled automatic
update experience, with the existing sidebar download control as its entry
point. The [inventory](001_inventory.md) separates observed behavior from gaps;
the [gap ledger](002_gap_ledger.md) assigns completion evidence to each one.
The [contract map](003_contracts.md) tracks proposed fields and their owners.
The roadmap's architecture reflection and independent plan audit are complete
for the snapshot recorded below. Each implementation unit remains a proposal
until its own current-base plan audit, tests and applicable independent security
review have passed; no update behavior is claimed to be implemented.

## Loop specification

- **Archetype and trigger:** satisfy-spec, scoped HOTL; the requested GOAT
  parity work began on 2026-11-07.
- **Work class:** C4 for updater, signing, installation, release and authority
  changes; the docs-only roadmap is independently audited before code. GOAT's
  built-in discipline was read from the pinned reference revision at
  `packages/provider-core/src/server/builtinSkills/goatDiscipline.ts:7`.
- **Goal:** signed, user-controllable updates for desktop and eligible linked
  installations; useful progress, deferral and failure states in the sidebar.
- **Non-goals:** modify the user's installed app, services or running proxy;
  merge pull requests; publish releases; broaden workflow triggers or
  permissions; add optional-subsystem imports to core paths; add telemetry.
- **Verifier:** per-unit failing-first behavior tests, isolated homes and mock
  feeds, typecheck and privacy scan, ownership and locale checks, UI screenshots,
  exact-head required CI, and independent security review where applicable.
  Commands and the source each observes belong in each completed decade plan.
- **Stop:** report each PR ready for coordinator integration only after its
  exact-head checks and required reviews pass. Continue until every ledger gap
  is closed or a concrete blocker is reported.
- **Memory:** this public unit and the bound Codexclaw goalplan; security
  working notes belong in `.tmp/`, never in this directory.
- **Outcomes:** DONE requires the complete audited scope and evidence;
  BLOCKED or NEEDS_HUMAN identify missing authority, supply or capability;
  BUDGET_EXHAUSTED applies only to an actual bound.
- **Escalation and bounds:** report decisions outside the granted scope to the
  coordinator. No token or wall-time bound stated; host limits apply. Keep load
  moderate: no full root test suite. User authorized commits, pushes, PRs and
  platform proof when needed, but not merge or release publication. A PR-branch
  `lane=all` requires an explicit maintainer request on that PR; run it once on
  the exact intended head, never redispatch because the head moved or rerun to
  green, and cancel owned superseded runs. Ordinary full dispatches are batch
  checks on `dev`, as required by `AGENTS.md`.

## Draft dependency map

1. **Signed supply and channel contracts.** Determine and implement a
   verifiable artifact source for every automatic install surface. Extend
   release metadata only when it can preserve existing signing and CI policy;
   missing, invalid, or unverifiable signatures must refuse the automatic path.
   Desktop stable/preview/nightly labels must correspond to feeds that actually
   exist. npm provenance is a candidate for investigation, not yet a verified
   consumer contract. Existing explicit package commands keep their current
   behavior until a verified-supply migration ships. That migration should
   retain their interfaces but may refuse operations that previously succeeded;
   document the impact and supported alternatives for each manager.
2. **Automatic activation admission.** Extend the existing automatic restart
   fence and handoff (`src/server/management/system-restart.ts:385`) with an
   identity-bound, expiring update reservation that proves no work remains and
   transfers atomically into shutdown. Release its temporary fence before shutdown waits
   for temporary drains. A plain sample of activity is insufficient: the
   existing terminal drain aborts turns after its deadline
   (`src/server/lifecycle.ts:520`), and an unreleased temporary fence can make
   shutdown wait on itself (`src/server/lifecycle.ts:131`).
3. **Desktop staged update engine.** Extend the Tauri owner to check, download
   with progress, verify, retain a staged update, and apply through the existing
   restart/drain and recovery path. Persist user controls and channel state;
   account for stale checks, concurrent commands, unavailable feeds and failed
   or interrupted installs. Signature verification stays mandatory. The exact
   default is an audit decision; it must be justified against GOAT's defaults
   and the user's control requirement.
4. **npm preparation and activation.** Extract verified npm preparation
   from the existing transactional swap. Automatic paths
   must verify every artifact they execute, including installer dependencies;
   unsupported owners remain visible and never silently fall back.
5. **Sidebar and update panel.** Extend the existing session-scoped snapshot
   and sidebar download button to express current, available, downloading,
   ready and failed states; open a panel with channel, automatic download and
   installation controls, release notes, restart and Later. Preserve the native
   update-page command boundary and browser package-update behavior. Resolve the
   footer version truncation and validate accessibility, locales and geometry.
6. **Linked-machine orchestration.** Reuse Home–Child link identity, pinned
   sync and the orchestrated plan/apply path where their contracts fit, while
   adding signed-target verification, device-side controls, compatibility and
   idle admission, per-machine progress, and failure/recovery reporting. Treat
   unavailable identity, incompatibility, unverified signatures and offline
   machines as explicit non-success states. Do not equate catalog sync with an
   installation update.
7. **Standalone installation support.** Add a signed, owner-bound standalone
   adapter and platform-specific recovery after the common supply and admission
   contracts exist; do not treat the current standalone refusal as closure.
8. **Child-initiated link transport.** Add a separately authorized Child-pull
   update exchange for links without Home-to-Child SSH; keep the existing
   management relay read-only and preserve destination consent.
9. **pnpm-owned installations.** Implement and prove the selected global
   owner's offline signed preparation, manager-compatible transition and rollback
   in `090`; unsupported layouts remain open until proven.
10. **Bun-owned installations.** Implement and prove signed offline
    preparation, global metadata/bin ownership, activation and rollback in
    `100`; do not treat an ordinary global add as a staged transaction.

The later units extend the preceding integration contracts: `070` adds a
standalone owner to the linked update coordinator, `080` carries those owners
over the Child-initiated transport, `090` adds a pnpm adapter to both link
directions, and `100` reuses the resulting manager-stage interface for Bun.
Each still has its own local behavior and independently reviewable PR. This
dependency chain preserves the full goal even when an earlier owner is not yet
eligible for automatic activation.

Each unit will receive a decade-numbered document with its exact file map,
before/after behavior, public contracts, acceptance scenarios and fresh
verifiers. Each produces a separate PR against `dev`; dependency and base
strategy will be resolved in the audited plan. Any updater, package installation,
release, signing or workflow PR requires a separate independent security PASS.
The owner requested no full root suite; record focused coverage and the CI
coverage left outstanding rather than describing an unrun suite as passing.

## Delivery and base strategy

Each unit is a separate PR whose base is `dev`, as requested. Do not create a
stack whose child targets another PR. After the docs-only roadmap PR and each
implementation PR reaches exact-head readiness, report its URL, head, checks and
reviews to the coordinator. The coordinator alone decides whether and when to
merge. Once the prerequisite is actually on `origin/dev`, fetch and verify that
head before starting the next unit on a fresh branch from it; revalidate that
unit's prewritten plan against the resulting code. If a prerequisite is not yet
integrated, watch the PR through GOAT and wait for the coordinator rather than
manufacturing a downstream base or merging it here. A PR description uses the
repository's Summary, Verification and Checklist template. GUI PRs link a
reviewable screenshot hosted through `pr-assets`, never committed to the PR
branch. Add `ci:full` when subprocesses, files read as data or generated
outputs require coverage the changed-test import graph cannot discover
(`MAINTAINERS.md:65`). Required CI must complete on the current head.

For user-facing changes, compare the canonical English installation,
desktop-app and remote-link pages and their existing `fr`, `ja`, `ko`, `ru`,
`tr`, `zh-cn` and `zh-tw` translations; update every affected translation so
it does not contradict the English source. For any docs-site edit, run its
required `cd docs-site && bun install --frozen-lockfile && bun run build`
(`docs-site/AGENTS.md`). GUI has eleven locales and its own locale parity
checks. Review mapped `structure/` owners on each unit; `structure:check`
does not itself establish that the prose accurately describes new behavior.

## Consultation and audit

Architect task: `auto-update-parity-architect-01`, read-only, Codex
`gpt-6.1-sol` with xhigh reasoning. Proposal received 2026-11-07 at the pinned
revisions in `001_inventory.md`; the following dispositions are provisional until
the same architect reflects on the concrete plan and the independent audit passes:

| Decision | Main disposition |
| --- | --- |
| AU-001 installer ownership | Accept: retain distinct native and package owners and their existing mutation gates. |
| AU-002 controls | Accept: separate check, download and installation policy and revalidate before effects; preserve manual activation as the proposed default. |
| AU-003 candidate | Accept with amendment: exact candidate and provenance must satisfy the user's mandatory signature requirement, not just registry SRI. |
| AU-004 preparation | Accept conditionally: staged handles stay owner-held; npm, pnpm and Bun support must be proven individually, not assumed. |
| AU-005 admission | Accept: add a separate reservation unit and explicitly prove the shutdown handoff cannot race admission or wait on its own temporary lease. |
| AU-006 recovery | Accept: distinguish installation from a healthy serving target, preserve Stop/Resume intent and suppress repeat failed targets. Assess GOAT probation parity explicitly rather than treating it as automatic proof. |
| AU-007 Child authority | Accept with amendment: diagnostics do not finish the requested goal; the roadmap must include separately authorized and security-reviewed remote binary updates, not defer them out of scope. Preserve `ocx.sync.fanout/1`. |
| AU-008 channel and rollout | Accept: derive supported feeds from actual signed publication and never invent a nightly or preview channel. Document rollout and policy defaults. |

The same architect's reflection (`auto-update-parity-architect-reflection-01`)
returned **MISALIGNED**: supply/trust, activity fencing and stop-to-installer
handoff, manager-specific staging, remote authority and resumption, policy and
recovery, sidebar wire/cadence, and exact PR/test mapping were incomplete. The
unit docs subsequently addressed these findings as described below. In particular, the existing restart
route's handoff is not by itself an installer-stop handoff, and peer observations
are not authorization.

The user's authorization for platform proof operates within the unchanged
`AGENTS.md` CI policy stated above. Subsequent architect reflection and the
independent roadmap audit are recorded below.

The third reflection (`auto-update-parity-architect-reflection-03`) returned
**MISALIGNED** against the 14-file snapshot: executable manager transitions,
update-stop authority and complete activity fencing, platform recovery actor,
signing/rotation, destination authority and Child-pull transport, future-target
compatibility, and nightly source/CI binding and shared-contract ownership needed
decisions and evidence at that point. The manager units now explicitly require isolated
pre-audit research; `003` specifies a candidate capability descriptor and
`010` owns shared parser/test-vector delivery before `020`. These amendments
were proposals awaiting the later reflections and independent audit below.

The fourth reflection (`auto-update-parity-architect-reflection-04`) reviewed
snapshot `1498639d17aef1013f99e406fc8ae574588a8f3da558ca6b7a8c5c3456e54cc8`
and returned **MISALIGNED**. Its six material findings concerned bounded native
acquisition; retaining a verified stage and grouped notes; cross-process
admission/readback; platform guardian and remote Desktop handoff;
simultaneous Home/Child compatibility; and manager activation/recovery. The
main agent accepts these findings and has amended `003`, `010`, `020`, `030`,
`050`, `060`, `090` and `100` with candidate contracts and evidence from the
two completed isolated manager investigations. These amendments remain
unverified proposals at that point, not a security PASS. Subsequent architect
reflections and the independent roadmap audit are recorded below.

Reflection 05 reviewed snapshot
`21bdadc2bc897481027b534a43f48de8704a97b1fb2eb11250c5edf04daa132f`
and returned **MISALIGNED**. The main agent accepted its six remaining
findings: installed channel provenance and browser policy, locale Back
navigation, quit/stopped-runtime health semantics, Windows app/installer
handoff, cross-runtime registry interoperability, and manager-generated output
authority. `003`, `010`, `020`, `030`, `040`, `050`, `090` and `100` now
describe proposed resolutions and falsifiable tests. The installed SQLite
dependency and Node/Bun broker are proposed new reviewed boundaries, not
existing capabilities.

Reflection 06 reviewed snapshot
`cd9d7c20127a19fc08452c3203f9320ccdbe3d17a81d50aee942fa18d5145b5b`
and found the six preceding design amendments addressed, while requiring the
CI-policy wording above and the native-to-badge channel transport in `003`
and `050`. The main agent accepted both findings. The subsequent audit is
recorded below; implementation proofs, Rust 1.90 and Node 18 interop and the
platform matrix remain gates.

The independent roadmap audit of that snapshot returned **GO-WITH-FIXES** with
two medium blockers: the desktop badge's old non-null channel DTO lacked an
unknown-provenance migration, and linked-update dashboard actions lacked an
end-to-end management and GUI contract. The main agent accepted both findings;
`003`, `050`, `060` and `080` now propose separate versioned badge and linked
dashboard DTOs, precise legacy/old-server behavior, authorized actions and
future regression tests. The same independent reviewer re-audited these
amendments as recorded below.

The independent follow-up accepted the badge DTO correction and identified a
remaining Retry A→B request-correlation blocker plus a non-blocking warm-cache
failure presentation issue. The same architect independently identified the
Retry gap. The main agent accepted both; `060` and `080` now specify durable
request-ID readback and replay behavior, while `050` requires stale badge data
to be visibly unknown after a failed latest observation. The subsequent
architect reflection and independent re-audit are recorded below.

## Roadmap audit disposition

The same architect's reflection 09 returned **ALIGNED** and independent audit
round 03 returned **PASS** for the 14-file snapshot
`251f5fc6aebd2c28d3c88096caa3033266587c55db3b56f613180b9275350cf9`.
The review closed the badge DTO, linked dashboard action/readback and stale
cache findings; its final round found no new high or critical blocker. The
reviewer checked staged whitespace, the privacy scan, citation ranges and
the changed consumer paths. This disposition records a plan audit only: no
proposed update implementation, artifact signature, platform install,
security review or exact-head PR CI is claimed to have passed.

Before a PR is marked ready, fetch the current `origin/dev` and revalidate the
inventory and implementation plans on its exact resulting base. The last
audited fetched base was `35d5010f502a8efd973d75c9e7a1b44eecfde777`; its
WebSocket turn admission attaches a workflow lease and its binary GUI switch
uses `role="switch"` and `aria-checked`. Later upstream changes need a new
impact assessment. Every implementation unit remains subject to its own
failing-first tests, required checks and independent security review where
applicable; this roadmap audit is not permission to skip those gates.

The independent roadmap reviewer must receive the original goal and hard
constraints, the exact plan revision, and the pinned source revisions. The
review must challenge the full file and field chains, reachable negative cases,
cross-version compatibility, source-to-artifact verification, destination
authority, recovery and PR dependency order. It must verify existing commands
and identify candidate commands that do not yet exist or do not observe the
proposed change. Record each finding's acceptance or evidence-backed rebuttal,
amend the plan, and re-review with the same reviewer until blockers are closed;
an architect reflection is not the independent audit. Security-sensitive
working notes remain in `.tmp/`. The review packet will attach the code-review
and search skills and require a normalized verdict.
