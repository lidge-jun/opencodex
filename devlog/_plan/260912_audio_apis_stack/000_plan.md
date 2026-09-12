# Standalone audio APIs

Expose file transcription, streaming dictation and GPT-Live to external clients with OpenCodex credentials. Connections gains separate Dictation and Live Voice sections. Existing OpenAI account selection and transport lifecycle remain the integration points.

## Loop contract

- Archetype: satisfy-spec, C4 API/auth and C3 dashboard integration.
- Trigger: owner requested both audio capabilities, inherited subagent verification and a published dependent PR stack.
- Goal: three independently reviewable ordinary PRs with protocol tests, documentation and usable client controls.
- Non-goals: merge, release, deployment, account configuration, microphone capture during agent QA, paid upstream probes, Responses protocol conversion, native GitHub stack registration.
- Verification: focused Bun transport tests observe mock upstream requests and real loopback sockets; typecheck observes tsconfig source includes; GUI build/lint/i18n and browser smoke observe rendered controls. Final review readiness also requires repository test runner and exact-head remote CI.
- Stop: all three PRs published with final-head evidence and no unresolved actionable independent findings.
- Artifacts: this unit for functional design; ignored .tmp/audio-security for trust-boundary working notes; session-bound goalplan and test receipts for orchestration.
- Outcomes: DONE means all criteria met; external dependency failures remain unmet with evidence. No invented budget exhaustion or scope reduction.
- Escalation: main resolves technical review findings; no additional authority for destructive operations or external messages. Main reclaims a failed delegated packet after two distinct agents; implementation delegation requires an explicit plan amendment.
- Resources: existing shell/Git/GitHub and inherited model tools; task worktree only; no new paid services, billable voice calls or personal recordings. User set no token, cost or wall-clock cap and allowed unrestricted parallel subagents.

## Current ownership

Source root: task-owned linked worktree on origin/dev ec065aa0c6fb46b376a2f01873bd677327b99150. Native session state stays in the original checkout. Existing uncommitted user work stays there.

| Cycle | Plan | Branch / PR base | Output |
| --- | --- | --- | --- |
| wp0 | all documents in this unit | documentation checkpoint on first branch | audited complete roadmap |
| wp1 | 010_transcription.md | codex/audio-transcription -> dev | bounded file transcription and audio upstream contract |
| wp2 | 020_streaming_voice.md | codex/audio-streaming -> codex/audio-transcription | dictation stream and externally owned live sessions |
| wp3 | 030_connections.md | codex/audio-connections -> codex/audio-streaming | endpoint metadata, audio controls, examples and publication |

All layers include their own regression coverage and source-of-truth sync. The branch base is the dependency edge; no branch is merged in this task.

## Evidence and decisions

Local Codex reference: 095da4b7e8b70b01afb5c6131ef926dcb8c0d85d, realtime default gpt-live-1-codex. Installed desktop package 26.908.40834 has separate file and dictation-stream transports. File API interoperability reference: Soju06/codex-lb 82567556f9f75ea13986667fc5282f035b7ca8d2, app/modules/proxy/api.py and app/core/clients/proxy.py. Its gpt-4o-transcribe subscription model is a compatibility identifier, not proof of the backend model.

No native architect field is exposed by the host spawn schema. Main owns the plan; an inherited generic read-only design verifier supplies the consultation evidence. This is recorded as a transport deviation, not native architect completion. Independent A/code reviewers inherit the requested model/context; model-family independence is not claimed.

Configuration alone cannot create the missing audio endpoints. Reuse the existing sidecar selection, admission, response envelope, stream limits and API workspace instead of a separate service or provider registry.

## Progress

wp0: planning in progress. Production code unchanged.
