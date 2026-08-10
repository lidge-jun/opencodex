Codex app-server generate-ts schema summary (codex-cli 0.133.0)
Generated 2026-08-03. Version-pinned to this Codex version.

Thread primitives:
  thread/start (ThreadStartParams, ThreadStartResponse, ThreadStartedNotification)
  thread/resume (ThreadResumeParams, ThreadResumeResponse)
  thread/rollback (ThreadRollbackParams, ThreadRollbackResponse)  <-- NATIVE ROLLBACK
  thread/setName, thread/archive, thread/unarchive, thread/subscribe, thread/unsubscribe
  thread/shellCommand, thread/rollback

Turn primitives:
  turn/start (TurnStartParams), turn/interrupt (TurnInterruptParams), turn/steer (TurnSteerParams)
  TurnStartedNotification, TurnCompletedNotification
  TurnPlanUpdatedNotification (TurnPlanStep, TurnPlanStepStatus), TurnDiffUpdatedNotification

Approvals:
  ApplyPatchApprovalParams/Response, ExecCommandApprovalParams/Response

Events/state:
  FileChange, ThreadStatusChangedNotification, ThreadTokenUsageUpdatedNotification (TokenUsageBreakdown)
  ConversationGitInfo, ConversationSummary, ThreadSource/ThreadSourceKind, ThreadStatus
  ResponseItem, ContentItem, ReasoningSummary, MessagePhase

Auth/config:
  GetAuthStatus, ForcedLoginMethod, AuthMode, configRequirements/read (managed)
  WindowsSandboxSetupStart/Completed/Readiness (Windows sandbox support)

Conclusion: Codex IS externally manageable via JSON-RPC. thread/start+thread/resume+
thread/rollback map to startSession/resumeSession+handoff rollback. Approvals, plan,
file-change, usage, and terminal status events all present and versioned.
Live thread/start NOT executed (would incur model spend / use operator OpenAI auth
beyond the no-production-effect spike constraint); generate-ts is deterministic
primary evidence of the surface.
