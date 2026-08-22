# 007 — A-phase audit round 2: blockers and disposition

Same reviewer, re-dispatched against revision 2 (AUDIT-LOOP-01: blocker-closure rounds
reuse the same reviewer). Verdict: **FAIL**, 7 blockers. Round-1 folds for phase ordering
and conditional-path reachability were confirmed sound; the rest were incomplete.

All 7 were re-verified by the main agent against real code before folding. No rebuttals.

| # | Sev | Blocker | Disposition |
| --- | --- | --- | --- |
| 1 | High | Phase 1's provider chain still broken: `multi_agent_version` is TOP-LEVEL (`openai_models.rs:459-460`), not under `metadata`; and nothing wrote `OCX_MULTI_AGENT_FIELD`, so `applyMultiAgentMode` would never see it. Real seam is `applyCatalogModelMetadata` (`effort.ts:113`, called from `sync.ts:322`). GUI type without a renderer is not a consumer | **FOLDED (R2-1).** Both confirmed by reading the source. Bridge specified end-to-end; GUI marked `N/A + reason`. |
| 2 | High | G12 non-executable: no class type, no lookup, no signature; `selectAvailableSubagentModel` (`:269`) takes no catalog/capability; `applySubagentModelFallback` has TWO call sites (`core.ts:1768` **and `:1856`**), only one named; `tests/subagent-model-fallback.test.ts` absent from the verifier | **FOLDED (R2-2).** `SubagentCapabilityClass` + `subagentCapabilityClass()` defined; additive optional parameter; both call sites named; three fallback suites added. |
| 3 | High | Phase 2 missed a third mutation path `ejectRemainingOpencodexHistory` (`:586`, writes `:599`, bulk-updates `:608-618`, reachable from `:786`); `rememberOriginal` backs up rows before mutation (`:731`); restore clears the whole manifest (`:815`); the backup `historyMode` field was self-contradictory | **FOLDED (R2-1..R2-3 of 020).** Third path partitioned; backup scoped to mutated rows; manifest clears only restored entries; the contradictory field is **dropped**, not added. |
| 4 | High | `skippedUnknownMode` has no transport: worker DTO (`history-worker.ts:69,184`), message validation (`history-job.ts:152`), `CodexHistoryJobOutcome` (`:107`), classification (`:282`) all omit it; `history-transition.ts:28` would still classify partial work as `converged` | **FOLDED (R2-4 of 020).** Full 8-stage chain enumerated; partial work must not be recorded as converged. |
| 5 | High | Phase 4 missed live consumers: PUT DTO (`agent-settings-routes.ts:373`), CLI import (`cli/v2.ts:15`) and its **false boot-refusal warning** (`cli/v2.ts:127`), comment preservation (`features.ts:1342`), dotted-key rejection (`:1398`), duplicate detection (`:1416`), GUI `v2.enabled` gating, and `structure/05_gui-and-management-api.md:105` | **FOLDED (R2-2, R2-3 of 040).** All added. The CLI warning is the most user-visible instance of G7 — it ships a false claim today. GUI visibility settled: report the conflict regardless of `enabled`. |
| 6 | High | PLAN-VERIFIER-REAL-01 still violated: `tests/api-v2.test.ts` does not exist and Bun ignores it silently; Phase 1's command omitted the G12 suite; receipts recorded single-file output against multi-file commands; `lint:gui` receipts missing (real exit **127**, `oxlint: command not found`) | **FOLDED (R2-3 of 010, R2-5 of 020, R2-1 of 040).** Phantom test replaced with `tests/codex-v2-gate.test.ts`; commands corrected; receipts now record the exact named command; `lint:gui` exit 127 recorded with its `gui/` install precondition. |
| 7 | Medium | Three stale citations: `002:251` still said `compact.rs:35` is `CompactRequest::new`; `010:178` said upstream "discourages" overrides when `config/mod.rs:253` says they "do not accept" them; `history-provider.ts:165-175` excluded `failureReason` at `:176` | **FOLDED.** `002:251` corrected in place; the fork-guidance claim softened and Change 5 downgraded to optional; the range corrected to `:165-176`. |

## What round 2 changed about the conclusion

Round 1 fixed *what* to do; round 2 fixed *whether it could be done*. Three folds were
still unexecutable — a capability field with no producer, a fallback change with no
signature, and a result counter that could not cross a Worker boundary. It also caught a
false warning already shipping in `ocx v2 status` (`src/cli/v2.ts:127`), which is a live
user-facing defect rather than a roadmap flaw.

The receipts lesson generalizes: recording a single-file test result beside a multi-file
command is not a receipt, and `bun test` silently ignoring a nonexistent path means a
command can "pass through" while observing nothing.

