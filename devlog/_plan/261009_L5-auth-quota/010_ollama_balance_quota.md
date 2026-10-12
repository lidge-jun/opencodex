# 010 — wp2: carry #6739 Ollama Cloud quota from /api/balance

Original: #6739 by xingqi-gif, head `74a9ad0662`, merge-base `aeebf11e5a` (10 behind `dev` at `c15037b324`); merges cleanly.

## Decisions (architect Q1–Q5 → main disposition)

- **Q1 keep boundaries — accepted.** `/api/balance` first, `/api/usage` fallback; egress stays `quotaFetch` (Bearer only to https://ollama.com, `redirect: "error"`, timeout); eligibility unchanged.
- **Q2 apply onto current dev — accepted.** Squash the PR diff onto `origin/dev`; keep #6743's `quota.ts` changes and #6763/#6778 layout additions.
- **Q3 failure precedence — accepted.** (a) catch transport rejections per endpoint inside the probe so a failed `/api/balance` request falls through to `/api/usage` and never rejects the whole provider-quota response; (b) terminal status keeps today's rule (`src/providers/quota/vendor-probes-key.ts:503-505` on dev, hard 4xx other than 404/408/429) — not narrowed to 401/403 — and a terminal verdict from either endpoint wins unless the other endpoint returns a parsed report; a read failure after a terminal status returns the terminal verdict, not `null`; (c) cancel bodies of non-success responses that are not read; (d) comment that `creditsUsd` is the included allowance only.
- **Q4 coverage — accepted, with an explicit split.** New activation tests in this carry: `/api/balance` transport rejection → `/api/usage` success; 408, 429 and 5xx on balance → fallback (one parameterized case); balance 401 → usage unreadable body ⇒ terminal (row cleared); balance 401 → usage 200 parseable ⇒ usage report wins (conflicting outcomes); missing `resets_at` ⇒ window still reported; allowance plan with `period.until` ⇒ `creditsUsd.expiresAt`; mixed windows + credits in one payload ⇒ both published; parser cases for an invalid reset date and an out-of-range percent (clamped or dropped, asserted either way). URL-specific mocks for the monthly legacy case. Left to existing coverage, with the test named in B before relying on it: missing-key and disabled/non-key row exclusion (eligibility cases in `tests/providers/provider-api-keys.test.ts`) and streamed/stalled bodies (the shared bounded reader's own tests). If B cannot name such a test, the case is added here instead.
- **Q5 docs — accepted.** `structure/providers-and-adapters.md` has no Ollama quota sentence today; add one after the MiniMax quota paragraph (balance first, usage fallback, failure precedence, included-only credits). Public doc: add a short Ollama Cloud quota paragraph to `docs-site/src/content/docs/guides/providers.md` beside the MiniMax quota paragraph (English only; translations follow the repo's locale process). Other owners listed for `src/providers/quota` in `structure/INDEX.md` are read for contradictions and left alone unless one names `/api/usage` as the Ollama source.

## File change map

| File | Change |
|---|---|
| `src/providers/quota/vendor-probes-key.ts` | PR's `parseOllamaCloudBalance` + endpoint loop; Q3 precedence and transport catch |
| `src/providers/quota.ts` | PR's parser export (no line growth; cap 558) |
| `tests/providers/provider-quota-ollama-cloud.test.ts` | PR's moved tests + Q4 cases (stay < 2000 lines) |
| `tests/providers/provider-quota.test.ts` | PR's removal of moved Ollama tests (3602 ≤ cap 3763) |
| `tests/providers/provider-api-keys.test.ts` | PR's endpoint expectation update |
| `scripts/test-layout/layout.json`, `tests/fixtures/test-layout-expected.json` | register the new test file under `providers` |
| `structure/providers-and-adapters.md` | Q5 paragraph (new) |
| `docs-site/src/content/docs/guides/providers.md` | Q5 public paragraph |

## Acceptance (activation → observable effect)

1. Balance 200 with `included.weekly.remaining_percent: 56.48` → report `weeklyPercent` 43.52, source `ollama-cloud:balance`.
2. Balance 404 → usage 200 legacy `limits` → report source `ollama-cloud:usage`.
3. Balance fetch throws → usage 200 → report present; the provider-quota promise resolves.
4. Balance 401 → usage body oversized → terminal: previously published row cleared.
5. Balance 200 with neither a parseable window nor parseable credits, and `/api/usage` unavailable or unparseable (nonterminal) → no report, last-good kept.
6. Declared-oversize balance body → one request, no report, body cancelled (PR test).
7. Balance 401 → usage 200 legacy `limits` → usage report published (a successful fallback supersedes the terminal status).
8. Public doc and structure paragraph exist and `bun run structure:check` passes.

## Verifier

`bun test tests/providers/provider-quota-ollama-cloud.test.ts tests/providers/provider-quota.test.ts tests/providers/provider-api-keys.test.ts` (reads the changed probe directly); `bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts tests/ci-workflows/file-size-ratchet.test.ts` (reads both registries and the baseline); `bun run typecheck`; `bun run privacy:scan`; `bun run structure:check` (reads structure/). Then exact-head hosted CI.

## Commit and PR

One squash commit `fix(quota): read the Ollama Cloud quota from /api/balance` with `Co-authored-by: xingqi-gif <67894334+xingqi-gif@users.noreply.github.com>`; PR body "Carries #6739" with the template's Summary/Verification/Checklist.

## wp2 P revalidation (2026-10-09)

Previous D (wp1): roadmap locked, direction unchanged; origin/dev still c15037b324. Same architect re-read this doc: ALIGNED for Q1–Q5. Ordering for B: keep `terminalFailure` outside the endpoint loop; a narrow try/catch only around `await quotaFetch(...)` (transport rejection → next endpoint, terminal evidence kept); on non-success record the hard-4xx verdict, best-effort cancel the unread body, continue; on `QUOTA_JSON_READ_FAILURE` return `terminalFailure ? TERMINAL_QUOTA_FAILURE : null` (keeps the oversized-balance stop); a parsed report supersedes earlier terminal evidence; loop exhaustion returns the retained verdict. Parser cases assert one definite outcome (clamp or drop), chosen by reading the existing parser helpers.
