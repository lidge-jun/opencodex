# Antigravity Hardening Whole-Branch Review

Base: `git merge-base origin/dev HEAD`  
Head: `9757b66f9c8d76b94a21da0218d1c2b4bca31450`  
Branch: `feat/antigravity-hardening`

## Strengths

- The branch ports the planned quota, geoblock, process-local cooldown, Claude
  CCA wire, always-SSE, and daily/production failover behavior in focused
  modules rather than adding another provider path.
- CCA unary requests now share the streaming parser, and the focused
  Antigravity/Google tests cover the normal unary, host-failover, tool-pair,
  geoblock, quota, and cooldown paths.
- The implementation preserves PKCE, does not add `src/lab` imports to the
  protected core files, and keeps request bodies, tokens, and account data out
  of diagnostics. `bun run privacy:scan` passed.
- `git diff --check` passed, and the focused Antigravity run passed: 160 tests,
  0 failures across 8 files. Typechecking also passed in the task validation
  runs.

## Issues

### Critical

None found.

### Important

1. **The CCA probe byte cap can be exceeded by one upstream read**
   - File: `src/adapters/google-http.ts:90-107, 170-207`
   - Issue: `CcaProbeBuffer.append()` grows its backing array to `required`
     even when `required` is greater than `CCA_STREAM_PROBE_MAX_BYTES`. The
     read loop only checks the limit before the next read, so a single large
     `ReadableStream` chunk can allocate and retain more than the advertised
     100 MiB cap; line 207 then returns that oversized buffer to the parser.
   - Impact: The new protection against oversized CCA streams is not a hard
     memory bound. A large upstream chunk can impose an avoidable process-wide
     memory spike before the parser's later frame checks run.
   - Fix: Make the probe stop buffering at the cap and pass the current chunk
     through without copying it into the probe, or otherwise use a bounded
     prefix plus a stream that preserves the unread bytes. Add a regression
     test where one read crosses the cap.

2. **Standalone Antigravity image failover can duplicate a paid POST**
   - File: `src/server/images.ts:230-249`
   - Issue: A failed `fetch()` to the first host is followed by a second
     `POST /v1internal:generateContent` to the peer. A transport failure is
     ambiguous: the first host may have accepted and processed the generation
     before the response was lost.
   - Impact: The request can generate twice or incur duplicate provider-side
     work/charges. This also contradicts the repository invariant in
     `structure/04_transports-and-sidecars.md:153-159`, which says each paid
     standalone Images POST receives one upstream attempt.
   - Fix: Do not retry image-generation POSTs after an unknown transport
     outcome unless the upstream provides a verified idempotency key. If host
     candidates are retained for images, restrict fallback to a response that
     is known to precede request acceptance and document that exception in the
     structure note.

3. **Inline SSE quota/rate-limit errors bypass cooldown and account rotation**
   - Files: `src/adapters/google-http.ts:66-76`,
     `src/adapters/google.ts:619-632`, `src/server/responses/core.ts:3890-3932`
   - Issue: The always-SSE path can receive an HTTP-200 stream whose first data
     frame is `{ error: { code: 429, status: "RESOURCE_EXHAUSTED", ... } }`.
     The probe treats this as terminal and the Google parser emits an error,
     but cooldown recording is only performed for HTTP 429/403 responses and
     the account carousel only enters on `upstreamResponse.status === 429`.
   - Impact: An account that is quota-exhausted or rate-limited in an inline
     SSE error is immediately selected again, defeating the new process-local
     cooldown and failover behavior.
   - Fix: Preserve the classified inline error status/reason through the
     adapter response path, record the same cooldown for inline 429/geo
     errors, and feed inline pre-stream 429 errors into the existing bounded
     account carousel. Keep geoblock non-rotating as required by the plan.
     Add an HTTP-200 SSE error regression test.

### Minor

No remaining Minor finding beyond the documentation-table triage item below.

## Documentation-table triage

The leftover Task 1 docs-table Minor is **not still real**. The English
`guides/providers.md` table and the fr/ja/ko/ru/tr/zh-cn/zh-tw mirrors have
matching header/separator structure and the updated
`google-antigravity` rows contain the expected number of cells. No malformed
pipe-delimited row or locale contradiction was found. The known Astro build
extraction issue is therefore not evidence of a markdown defect.

## Validation

- Focused Antigravity/Google validation: **160 passed, 0 failed**.
- `bun run typecheck`: passed in task validation.
- `bun run privacy:scan`: passed.
- `git diff --check`: passed.
- A full `bun run test` was also attempted, but the repository-wide run
  returned nonzero because of unrelated environment/baseline failures,
  including missing GUI React runtime packages, macOS `/bin/ps` permission
  failures, and unrelated auth/Lab regression tests. No Antigravity-focused
  failure appeared in that run.

## Assessment

**Ready to merge? No — needs changes.**

The planned feature set is substantially present and the focused tests are
strong, but the probe cap is not actually hard, image failover can duplicate a
paid operation, and inline SSE quota errors bypass the cooldown carousel.
Resolve those Important findings and rerun the focused suite plus the
repository gates before merging.

## Fix pass

- Finding 1 resolved: `CcaProbeBuffer` now refuses writes beyond the 100 MiB
  cap, and the probe forwards an oversized read's unread bytes without copying
  them into the probe buffer or failing over.
- Finding 2 resolved: standalone CCA image generation now performs exactly one
  upstream POST. Ambiguous transport, 404, and 503 outcomes are surfaced rather
  than replayed on the peer host; the one-attempt invariant is documented in
  `structure/04_transports-and-sidecars.md`.
- Finding 3 resolved: inline CCA quota and geoblock SSE frames are converted to
  cooldown-aware synthetic 429/403 responses. Quota enters the existing bounded
  Antigravity account carousel; geoblock remains non-rotating.

Fix-pass validation: the requested Antigravity, quota, routing, wire, hardening,
and image tests passed (**175 passed, 0 failed**), and `bun run typecheck`
passed.
