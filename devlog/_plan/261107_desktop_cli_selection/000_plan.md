# Preserve Desktop selection when its executable is unavailable

An enabled Desktop terminal-command record should keep ordinary package-launcher commands bound to Desktop even when its executable is temporarily unavailable. This unit makes that condition an actionable error instead of silently continuing into the npm/Bun installation. Live Child synchronization recovery remains a separate acceptance obligation; private runtime evidence lives outside tracked documentation.

Archetype: satisfy-spec. Trigger: request for persistent Desktop-first CLI selection and reliable Child sync. Goal: no implicit package fallback after a valid enabled Desktop selection, plus verified live sync recovery. Non-goals: changing connection identity checks, package maintenance commands, explicit opt-out, Windows launcher policy, publication, or unapproved runtime interruption. Verifiers: focused launcher regressions, typecheck, structure/privacy gates, documentation build and fresh live sync evidence. Stop: full objective has observed proof; otherwise retain unresolved requirements. Artifacts: this unit, the bound CXC plan and private scratch evidence. Outcomes: DONE needs all acceptance evidence; NEEDS_HUMAN applies to unapproved disruptive recovery. Escalation: restart, connection reset or publication beyond authority. Resource bounds: none stated; host limits apply. Heavy checks run on an eligible remote host.

## Source evidence and scope

`src/lib/desktop-cli-handoff.mjs` currently returns continuation when target validation reports ENOENT, and again when spawning and a subsequent lstat both report ENOENT. An isolated invocation of the actual module reproduced handoff -> continuation -> handoff by changing only target availability. This is a demonstrated fallback path, not proof of the user's exact historical incident.

The existing regression file explicitly expects that fallback. `bin/ocx.mjs` consumes continuation by reaching package/Bun resolution. `src/client/sync-expectation.ts` is outside the patch and retains fail-closed ownership checks.

## File change map

- MODIFY `src/lib/desktop-cli-handoff.mjs`: target-validation errors, including ENOENT, return existing `target-unusable`; spawn errors always return existing `spawn-failed`. Remove the redundant lstat check and dependency. Keep explicit exclusions, missing/disabled record handling, successful handoff, signal forwarding and cleanup.
- MODIFY `src/lib/desktop-cli-handoff.d.mts`: remove `target-missing` continuation reason and transport continuation variant; remove unused lstat dependency type. No new serialized field or enum. Creation: existing error variants in helper. Consumer: `bin/ocx.mjs` already prints repair/opt-out guidance and exits. Serialization/deserialization: N/A, in-process result only.
- MODIFY `tests/cli/ocx-launcher-desktop-handoff.test.ts`: replace fallback expectations for validation and synchronous/asynchronous spawn ENOENT. Update existing real Node launcher fixture to assert nonzero exit, repair guidance and no Bun lookup when target is missing; restore a valid target and assert handoff. Keep explicit opt-out, disabled record, update-help, signal and mutex tests. Reuse this registered test file; do not raise size caps.
- MODIFY `structure/desktop-terminal-command.md` and `structure/runtime.md`: document durable enabled selection and explicit recovery/opt-out; remove the previous ENOENT-fallback promise.
- MODIFY the stale post-handoff fallback comment in `bin/ocx.mjs` without changing its successful-exit handling.
- MODIFY `docs-site/src/content/docs/guides/desktop-app.md`: uninstall guidance must explain that a stale enabled record blocks eligible package calls and explicit one-invocation opt-out does not repair the shim/record/PATH.
- MODIFY `docs-site/src/content/docs/getting-started/installation.md` and directly contradicting translations: explain that missing selected Desktop requires repair, disabling the terminal command or explicit per-invocation bypass. Do not imply package maintenance or Windows routing changed.

## Dependency order and acceptance

1. Architect reflection and independent plan audit. Resolve material objections before code edits.
2. Change regression assertions first and record failure on current helper. Implement the two refusal paths and aligned declarations. Verify real fixture recovery after restoring target.
3. Update owner/user docs and run focused tests, typecheck, structure/privacy and docs validation on the exact resulting tree. Full suite may remain NOT RUN under documented resource exception; focused coverage must run.
4. Independently review the patch and complete live runtime recovery under the existing safe connection/update flows. A passing launcher patch does not certify live Child sync or deployment.

Activation scenarios: ready record + missing target -> actionable error, no package execution; ready target lost after validation -> spawn failure, no package execution; restored target -> handoff with argv/stdio/exit preserved; missing/disabled record and explicit bypass -> existing package path; update/removal/inspection -> existing exclusions; mismatched Child owner -> exit 5 and no writes.

Verification commands are planned, not yet passing receipts: `bun test tests/cli/ocx-launcher-desktop-handoff.test.ts` directly reads both helpers and invokes the real launcher; `bun run typecheck` checks declarations/consumers; `bun run structure:check`, `bun run privacy:scan`, and docs-site build cover their respective artifacts. Exact executions and outcomes will be recorded before completion. No suite has been claimed green.

Enforcement tier: application runtime branch. Surface: package launcher. Known bypass: explicit opt-out, disabled/missing record, maintenance exclusions and direct alternate executable invocation. Residual: existing shells/aliases and Windows PATH behavior are not universally controlled. Wording: persistent eligible-command selection, not universal prevention of every alternative invocation. Final layer: none beyond the local launcher contract.

## Consultation

Terra architect decisions D1-D4 preserve durable connection authority and supported recovery. D5 covers the demonstrated missing-target fallback. Main accepts the narrow refusal change while keeping it distinct from unverified historical causation and Child recovery. Same-architect D5 reflection: ALIGNED, received from Terra on 2026-11-07. Accepted amendments: update runtime.md old fallback promise, stale launcher comment and Desktop uninstall guidance. The architect explicitly limits the guarantee to eligible POSIX calls with a settled enabled record. Independent A verdict remains pending; this document is not an audit approval.

## A disposition

Terra verdict: GO-WITH-FIXES (blockers=1), remote audit at 4fc870074e8030cd1e0a35a6a5c707f208e51b93. Main verified that commit exists locally and compared the complete helper/declaration diff against current HEAD553a6216f3. The differences add the capabilities-contract exclusion and sync-mutex onSpawn callback; the target/spawn ENOENT branches under review are unchanged. Current Node launcher error exits and post-handoff continuation were inspected. Preserve the newer onSpawn callback/delegate-error handling and all current mutex regressions. This resolves the revision-equivalence blocker for the reviewed behavior without claiming entire revisions equal.

Test amendment accepted: explicitly rewrite AM-8 post-spawn lstat expectations, preserve listener cleanup and missing-interpreter coverage, add an observable Bun marker to the real launcher fixture with a bypass control proving the marker works. Restore target and prove Desktop handoff again. Current baseline dependencies are absent; install pinned root dependencies before red-to-green checks. No test failure may be reported as passing. Main will request fresh exact-diff C review after implementation.
