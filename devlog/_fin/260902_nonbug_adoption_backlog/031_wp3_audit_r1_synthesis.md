# wp3 audit R1 — #2901 compaction provider selection

## Verdict

NEAR-PASS after plan amendment. The reported failure is real and the existing
routed-compaction bridge is the correct destination, but the initial plan's
`compact.ts`-only change would leave v2 `compaction_trigger` requests broken.
The amendment makes the routing decision shared and keeps its fallback narrowly
scoped to the failing, unqualified native-model case.

## Evidence reviewed

- `src/server/responses/compact.ts` routes the v1 handler through `routeModel`
  before it can choose the synthetic routed-compaction path.
- `src/server/responses/core.ts` performs a separate initial `routeModel` call
  in `handleResponsesInner`; its later `routedCompaction` branch cannot run if
  that call throws.
- `src/router.ts` raises `NoEnabledOpenAiProviderError` both for bare native
  model ids and for exact Codex account namespaces. The latter is an explicit
  account-selection boundary and must not be treated as a generic fallback.
- `src/server/responses/core.ts` already strips the private trigger and appends
  `COMPACT_PROMPT` for noncanonical routed compaction, so no new provider-side
  compaction protocol is needed.
- `src/codex/catalog/sync.ts` suppresses bare native rows in non-OpenAI-only
  catalogs, confirming that a bare native id without a canonical route is not a
  supported ordinary-turn destination; it does not cover client-selected
  compaction models.

## Accepted blockers and dispositions

1. **Missing v2 coverage — accepted.** Add a shared `routeCompactionModel`
   (name may follow repository conventions) and invoke it for both v1 compact
   routing and the initial v2 compaction route. Add an activation test that
   exercises the real `handleResponses` path with `compaction_trigger`.
2. **Account namespace over-catch — accepted.** Do not catch every
   `NoEnabledOpenAiProviderError`. The fallback predicate must require an
   unqualified bare OpenAI-family id and an active configured default provider;
   exact account-qualified ids and all other routing errors rethrow.
3. **Ordinary routing regression — accepted.** Keep `routeModel` unchanged for
   non-compaction requests and assert that the same GHCP-only native id still
   throws there. The new helper is an explicit request-surface choice, not a
   global relaxation of native model ownership.
4. **Configuration-key alternative — rejected for this cycle.** A pinning key
   would solve a different problem (choosing among working providers) and would
   add setup burden to a request currently failing solely because of an invalid
   native reservation. The fallback changes only a hard failure and is therefore
   safer than introducing a new default-on routing preference.
5. **Logging/privacy — accepted with guardrails.** Emit at most one warning from
   the v1/v2 request path, using sanitized model labels and no body, token, or
   account data. The route-decision reason remains the machine-readable audit
   signal for tests and request logs.

## Activation matrix

| Case | Expected result |
| --- | --- |
| GHCP-only + bare `gpt-*` + v1 compact | default provider receives routed summary |
| GHCP-only + bare `gpt-*` + v2 trigger | same routed summary bridge succeeds |
| canonical `openai` enabled + bare native id | canonical route unchanged; no fallback |
| configured account namespace + `side/gpt-*` | original canonical-auth error; no fallback |
| non-native unknown model | original 404/error unchanged |
| ordinary `/v1/responses` + GHCP-only bare native id | original native reservation error |

## Residual risk

The default provider may advertise a model alias that differs from the bare
native id. The helper must preserve the caller's model id as the routed model
unless the normal route result supplies an explicit effective id; focused tests
should assert the actual upstream body and provider, not merely a successful
HTTP status.
