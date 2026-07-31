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

## P stale-check (WP2 cycle, current tree)

Re-read against current `src/web-search/*`:
- `executor.ts:84-100` and `anthropic-executor.ts` ALREADY degrade HTTP non-2xx
  and timeout/connect into `{ error }` and ALREADY `redactSecretString(...)` the
  body (`executor.ts:88`). So HTTP 429/401/403/5xx already degrade FAST — they are
  not the hang.
- The ONLY 200s source is the sidecar search deadline default:
  `index.ts:19 DEFAULT_TIMEOUT_MS = 200_000` → `index.ts:145 timeoutMs =
  cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS` → `settings.timeoutMs` →
  `executor.ts:73 signalWithTimeout(settings.timeoutMs)`. Vision already uses
  45_000 (`vision/index.ts:16`).
- `#398`'s observed `201,434ms` ≈ 200_000ms confirms the deadline is the cause.

### Scoped B for THIS cycle (direct 499/502 fix)

1. MODIFY `src/web-search/index.ts` — lower `DEFAULT_TIMEOUT_MS` 200_000 → 45_000
   (sidecar SEARCH deadline only; do NOT touch
   `DEFAULT_ROUTED_MODEL_STALL_TIMEOUT_MS`, which is the routed-model body
   inactivity budget, a different knob). `cfg.timeoutMs` override still honored;
   `webSearchStallTimeoutSec` recomputes from the smaller value automatically.
2. MODIFY `src/web-search/loop.ts` — defensive try/catch around the
   `runWebSearch`/`runAnthropicWebSearch` dispatch (~:430) so any future executor
   throw becomes a failed `SidecarOutcome` (executors are "never throws" today,
   but this makes the contract enforced, not assumed). Re-raise genuine parent
   aborts (signal.aborted) so real client cancel stays 499.
3. TEST `tests/web-search.test.ts` — assert the default sidecar deadline is now
   bounded (45s) and a thrown executor degrades to a failed cell + completed turn.

### Deferred to follow-up (NOT this commit)

The structured `failure{ kind,status,code }` metadata refactor (A-gate blocker
#1) is DEFERRED — since executors already redact+degrade, it is an enhancement,
not required for the 499/502 fix. Deferring it also removes the secret-safety
risk from this commit (no new raw-body handling is added). It becomes a THIRD
follow-up note in the #398 comment. This matches the "if B too large" clause above.
## A-gate (Halley) folds — GO-WITH-FIXES blockers=3

1. **Deadline 60_000ms, not 45_000.** Per-search deadline; maxSearches=3
   sequential; hosted-search p90 ≈ 43s (commit 11cc822e). 45s leaves no tail
   margin → use `DEFAULT_TIMEOUT_MS = 60_000`. `cfg.timeoutMs` override intact;
   stall watchdog still ≥230s (index.ts:52, stall-timeout.ts:8).
2. **Abort correctness.** Executors already catch parent abort and RETURN
   `{error}` (executor.ts:96, anthropic-executor.ts:179) — so checking
   `signal.aborted` only in a catch misses the fulfilled `{error}`. Check
   `signal.aborted` immediately AFTER the dispatch await (and in catch), and
   throw `LoopError(499, "client closed request during web-search")` to match
   loop.ts:320/341/377. Add a parent-abort-during-sidecar regression.
3. **Docs sync (SOT-SYNC-01).** 200s default is promised in
   `structure/04_transports-and-sidecars.md:129`,
   `docs-site/.../reference/configuration.md:380` (+ `:450-451` example) and
   translations (`zh-cn/.../configuration.md`). Update the `timeoutMs` default to
   60000 there or users override the fix back to 200s.
4. **Bonus security fold (Halley note):** `anthropic-executor.ts:168` places an
   UNSANITIZED HTTP body into `error`. Wrap it with `redactSecretString(...)` in
   THIS commit (small, real secret-leak) — matches `executor.ts:88`.

Final scoped B: `DEFAULT_TIMEOUT_MS 200_000 → 60_000`; loop.ts defensive
catch + post-await abort→LoopError(499); anthropic-executor body redaction;
docs sync (en + zh-cn + structure/04); regression tests.
