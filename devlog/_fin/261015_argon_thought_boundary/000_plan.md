# Gemini Argon output separation

A report of reasoning-looking assistant output prompted comparison of the Google response
classifier with CLIProxyAPI and cc-switch. The inspected classifier already separates marked
thoughts. This unit verifies that separation through every client protocol using synthetic
markers, and documents the boundary without claiming the original observation is reproduced.

## Loop specification

- Archetype: satisfy-spec; one C3 verification/documentation work phase.
- Trigger/goal: investigate Argon output separation and deliver an evidence-backed PR to dev.
- In scope: synthetic Argon integration tests, their layout registration, and current Google docs.
- Non-goals: heuristic text censorship, runtime changes without a demonstrated defect, private
  session transcripts, user configuration changes, deployment, other worktrees, native PR stacks.
- Verifier: new protocol test plus adjacent Google/direct-encoder tests; typecheck, test layout,
  file-size, privacy and structure gates; docs build; required CI at the PR head.
- Stop: coverage/docs merged with passing relevant checks, or a concrete blocker recorded.
- Memory artifact: this unit and local `.tmp/argon-protocol/` evidence; no memory-store writes.
- Outcomes: DONE for the verification PR; runtime NOOP if marked thoughts remain separated.
  Do not claim the reported live symptom fixed merely because synthetic tests pass.
- Escalation: a demonstrated defect changes the plan before patching; unavailable live evidence
  remains an explicit limitation. Existing user authority includes push/PR/merge, no release.
- Bounds: none stated; host limits apply. Tools: local Bun, read-only public Aside/GitHub research,
  repository-scoped GitHub publication. No production credentials are needed for tests.

## Evidence and hypotheses

- H1: the adapter converts marked thoughts to answer text. Falsifier: mixed marked/unmarked
  synthetic parts preserve separate channels in streaming and buffered responses.
- H2: a client converter collapses channels. Falsifier: actual Responses, Chat and Messages
  handlers keep thought markers out of ordinary answer fields with direct routing on and off.
- H3: upstream ordinary text or client rendering explains the observation. Static tests cannot
  establish this; never reclassify prose by its wording or infer a root cause from test success.

Source anchors: `src/adapters/google.ts:716`, `:989`, `:1378`, `:1654`;
`src/protocols/encoders/chat.ts:133`; `src/protocols/encoders/messages.ts:135`.
CLIProxyAPI `5fc580b1d72d87a7bcfe5cfb6f479c1aea5625b3` maps `thought` to
`reasoning_content`; cc-switch `76f99d41a66e24a5ed2e8982bc494399f306bfe6` filters
marked thoughts from visible text. Public Aside reads succeeded with complete=true,
truncated=false, contentVerified=true for Google thinking docs and CLIProxyAPI #6607.
Those docs distinguish thought signatures from ordinary text visibility; #6607 is a buffering
decision, not evidence of text leakage. Argon upstream behavior is not independently certified.

Baseline: `bun test tests/adapters/google/google-hardening.test.ts
tests/adapters/google/google-adapter.test.ts tests/adapters/google/gemini-4-argon-antigravity.test.ts
tests/responses/responses-show-thinking-summary.test.ts`: exit 0, 158 pass at 7640a942b3.
Work then refreshed to dev 0b13396af4; adjacent checks will run on the final patch.
Typecheck's `include: ["src"]` does not validate new tests; Bun execution does.

## Consultation

Architect proposal and reflection are retained in the local coordinator evidence.
- ARGON-SEP-01/02 accepted: keep one classifier and existing output channels.
- ARGON-SEP-03 accepted: provenance is not proof of observed upstream behavior.
- ARGON-SEP-04 amended: add handler-level coverage and current contract clarification.
  Preserve historical ADR-0055 per `structure/AGENTS.md`; do not rewrite the old decision.
- Same-architect reflection: ALIGNED against `010_verification.md`; require assertions on both
  deltas and final accumulated payloads, and correct tool signature attachment where exposed.
  Independent plan audit: PASS. Refreshed-base adjacent direct/encoder baseline: 131 pass, 0 fail.

No new runtime fields or enums. No new runtime enforcement: tests are regression checks only;
they can be bypassed by skipping tests, and cannot certify external client rendering.

## Verification result

The investigation's runtime outcome is NOOP: the tested marked thoughts stay out of ordinary
answer fields. New coverage adds 75 cases. Deliberately changing the classifier to emit marked
thoughts as text fails all 75; byte-for-byte restoration returns all 75 to green. No classifier
mutation is part of the patch. The live observation's cause remains unresolved.

Final focused validation on the repository-pinned Bun 1.4.3: 364 pass / 0 fail across the new
matrix and eight adjacent Google/direct-protocol files; layout/tooling/size: 36 pass / 0 fail.
`bun run test:changed` selects the new file only and passes all 75 cases. `bun run typecheck`,
`bun run structure:check`, and `bun run privacy:scan` pass. `cd docs-site && bun run build`
builds 577 pages and checks 81,202 links. Raw logs stay in local `.tmp/argon-protocol/`.
An initial layout run under the shell's Bun 1.4.0 failed the pinned-runner check; using the
already-installed Bun 1.4.3 resolved it without source changes.

Initial fixture expectations incorrectly treated a disabled provider display default as a
client opt-out and omitted the Messages thinking opt-in. The current tests explicitly request
the protocol's display state, matching `core-normalize.ts` and `claude/inbound.ts`; they still
force upstream marked thoughts when hidden to test output suppression, not just request flags.

The full 2,330-file suite is not run locally: this tests/docs-only change has bounded integration
coverage and shares the host with concurrent coding workloads. Broader coverage remains with
the PR's required CI. Neither this exception nor synthetic tests certify external harness UI.

Fresh independent final review: PASS, no actionable defects. The fresh reader identified the
result as synthetic regression coverage, with the live symptom explicitly unverified. No prose
change was requested. The investigation is closed with that limitation; PR integration is
tracked by the coordinator. Runtime source is unchanged.

Hosted review follow-up: restore all fixture globals in finally if spend-lease release throws;
add independent client-only opt-outs with provider opt-in still true for all three protocols.
A Chat opt-out mutation fails 18 cases; a Messages display-omitted mutation fails 6. All
production files were restored byte-for-byte. These probes confirm the added cases detect
the independent client preference, rather than passing only because the provider default is off.
