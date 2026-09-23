# Log served-model echo — done

The Logs model column showed `claude-opus-5-5 → anthropic/claude-opus-5-5` on every Anthropic row
because the request logger stored ocx's own client-selector echo from `response.model` as the
upstream served model. `recordObservedServedModel` in src/usage/log.ts now refuses that echo at
capture, and `modelIdentityLogFields` drops it from rows persisted earlier, so hydrated history
renders `claude-opus-5-5` alone and the model filter loses its duplicate option.

Evidence: four new/strengthened assertions fail on the pre-fix source and pass after it
(tests/usage/request-log-served-model.test.ts, tests/server/response-model-identity.test.ts).
Typecheck, request-log, file-size ratchet, test layout, structure SSOT, GUI logs title/filter tests
and privacy scan pass. request-log.ts ends at 1996 lines (auditor blocker: 2000 threshold).

Did not improve / limits: on adapter paths the upstream's real model is not observable, so an
Anthropic-side reroute shows no arrow rather than a false one. passthrough-dispatch.ts still hands
the selector to `notifyResponseComplete` (recall, not logs). A local `test:changed` expanded to the
full suite and failed only in the ~/.codex worktree test-home guard; hosted CI is the broad verdict.

Subagents (devin/swe-2): architect (proposal + ALIGNED reflection), explorer (consumer map),
auditor (FAIL → folded → PASS). The swe-2 test worker hit Devin `resource_exhausted` before writing;
the main agent wrote the tests.

