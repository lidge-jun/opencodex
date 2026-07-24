# WP2 — #398 sidecar graceful degradation + 2 follow-up issues (010)

Issue #398: web-search/vision sidecar backend is fixed to openai/anthropic; when
that backend's account limit is exhausted, the turn hangs ~200s then fails whole
with 499/502; no graceful degradation to "continue this turn without search/vision".

## Findings (Sol explorer, read-only)

The branch ALREADY degrades ordinary sidecar HTTP/connect/timeout failures into
error markers — executors are "never throws" (`src/web-search/executor.ts:84-100`,
`anthropic-executor.ts:168-182`); `runSearchCall()` stores the failed outcome and
forces the routed model to answer without search (`loop.ts:430-457`,
`format-result.ts:30`). Vision similarly strips images with a marker
(`vision/index.ts:197-204,334-340`).

**The real defect is latency, not missing degradation.** The default sidecar
deadline is 200_000ms (`src/web-search/index.ts:134,145-157`). A hung sidecar
consumes up to 200s; the client cancels first → next routed op maps abort to
`LoopError(499)` (`loop.ts:320,341,377`), or the forced-answer iteration fails
as 502 (`loop.ts:343,379-389`, `lib/errors.ts:240`). So 499/502 is a symptom of
the 200s wait, not a direct sidecar emission.

Also: HTTP status/error-code is flattened into an untyped `error: string`, losing
429 (exhausted) / 401 / 403 / 5xx and Anthropic `max_uses_exceeded`
(`anthropic-executor.ts:49-55`), so we can't degrade *immediately* on a known
exhaustion status.

## Plan (scope boundary IN)

No new `degradeOnSidecarFailure` flag (default-on is already the contract).

MODIFY:
- `src/web-search/executor.ts` — KEEP the existing sanitized `error: string`
  (consumers depend on it) AND add optional structured metadata
  `failure?: { kind: "http"|"timeout"|"connect"; status?; code?; message }`.
- `src/web-search/anthropic-executor.ts` — preserve HTTP status +
  `web_search_tool_result_error.error_code`; raw response bodies enter outcomes
  at `anthropic-executor.ts:168-172` — SANITIZE before storing (never persist raw
  body/token into the outcome/tool-result/SSE/log).
- `src/web-search/loop.ts` — defensive try/catch at `runSearchCall()` dispatch
  (`~427-432`); on 429/401/403/5xx degrade immediately; preserve genuine parent
  abort as 499.
- `src/web-search/index.ts` — lower default sidecar degradation deadline from
  200_000ms to a bounded 30_000–45_000ms; keep `webSearchSidecar.timeoutMs`
  override; recompute `stallTimeoutSec` (already at `:152-157`).
- `src/vision/describe.ts` + `src/vision/anthropic-describe.ts` — structured
  failure metadata; keep marker degradation in `vision/index.ts`.

Activation scenario (C-ACTIVATION-GROUNDING-01): a test where all sidecar queries
return 429/502/connect/timeout must produce exactly one failed search cell, a
routed-model answer, `response.completed`, and NO `response.failed`; and an
internal sidecar timeout must degrade while a genuine parent abort stays 499.

TESTS:
- `tests/web-search.test.ts` — full-turn all-failed/timeout completion regression.
- `tests/sidecar-abort.test.ts` — sidecar deadline degrades vs parent abort = 499.
- `tests/vision-cache.test.ts` — timeout/429 marker, not cached.
- `tests/web-search-anthropic.test.ts` / `tests/vision-anthropic.test.ts` —
  preserve error_code/type in structured outcomes.

## Consumer compatibility (A-gate blocker #1 fold)

The `error?: string` field is REQUIRED by existing consumers — do NOT replace it:
- `src/web-search/executor.ts:32-40` (outcome shape)
- `src/web-search/format-result.ts:27-30` (renders failed result)
- `src/vision/index.ts:335-342` (catch → marker)
Add `failure?` alongside; every consumer keeps reading `error`. New structured
field is additive/optional.

## Secret-safety (A-gate blocker #1 fold, STRICT)

"reuse existing redaction" is NOT automatic on the Anthropic paths
(`anthropic-executor.ts:168-172`, `vision/anthropic-describe.ts:166-170` put raw
bodies into outcomes). Requirement: structured `failure.message` and `error`
MUST be sanitized (status/code/short reason only, no raw body, no headers, no
token). Add a sentinel-secret test: inject a fake token/secret into a mocked
error body and assert it never appears in the outcome, tool result, SSE frames,
or logs. `bun run privacy:scan` must stay green.

## Two follow-up issues to create (per user directive)

1. **feat(sidecar): add exa and other search providers as sidecar backends** —
   today backend ∈ {openai, anthropic} only; add exa (and pluggable search
   providers) so non-OpenAI/Anthropic accounts can back the search sidecar.
2. **feat(sidecar): investigate/enable search-api-capable providers (e.g. gemini)
   as sidecar backends** — evaluate Gemini (and similar) native search APIs as
   selectable sidecar backends.

Then comment on #398 linking both follow-ups and summarizing the degradation fix.

## Security boundary

Touches sidecar auth-adjacent paths but no credential logging/serialization is
added. Structured failure must NOT include tokens/bodies with secrets (reuse
existing redaction). Not a release-workflow change.

Terminal: DONE = degradation code + tests green + 2 issues created + #398 comment.
If B proves too large for one cycle, land the deadline-lowering + defensive catch
first (the direct 499/502 fix) and split structured-metadata into a follow-up.
