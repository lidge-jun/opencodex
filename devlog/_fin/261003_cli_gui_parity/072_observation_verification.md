# wp7 — Observe changing state and use an explicitly supplied data key

Nine remaining implementation rows now have CLI coverage. Request-log followers preserve revisions and duplicate occurrences, with versioned snapshot/append events for observed-window consumers. Injection follow exposes its numeric sequence limitations. Timeline and key-scoped usage retain filter and completeness evidence. System health exposes ledger diagnostics. Key rename preserves scopes, and explicit-key model/audio operations use their own bounded data-plane client. The capability index reaches 325 entries.

## User-visible contracts

Existing one-shot and unkeyed outputs remain available. Event consumers can reconstruct each observed bounded log window, including resets/removals; legacy row consumers see new/revised occurrences. Empty polls remain silent, while initial/reset events can be empty. Injection lacks an epoch/gap marker; detectable runtime change stops following and undetectable loss remains disclosed. SIGINT130/SIGTERM143 propagate after invocation cleanup.

Timeline names model selection and provider exclusion separately and retains epoch-second buckets, missingMeasurements and truncated. Key-scoped usage requires echoed scope, and connected callers cannot request another key's management view. System health can report an ok endpoint with a degraded ledger. Rename resolves stable public identity and submits only id/name.

Selected-key model testing sends the fixed credentialless control and one bounded model request only after the native key-required observation. Its versioned report contains safe reply text/completion/optional counts. Policy changes between calls remain possible. Supplied keys are bounded printable-ASCII stdin inputs; management/enrolled credentials are never substituted. Projected dynamic text replaces the exact supplied key, and errors use fixed diagnostics.

Transcription bounds local file input, multipart size, response size and elapsed request time, then returns only the requested transcript. Live checking observes native readiness, requests closure and distinguishes confirmed normal closure from an unverified partial result. It sends no microphone/audio/delegation payload or reconnect. Cancellation begins response teardown without allowing an unsettled cancellation promise to retain the command's deadline or input lifetime.

## Verification

Pre-build evidence covered 47 real admission/handler tests and ten native Bun redirect scenarios. Worker tests exercised current server resolvers, parsers and handlers with synthetic state and owned endpoints. Data tests passed 109 cases, adjacent input/link regressions passed 73 with one explicitly excluded obsolete feature-denial fixture, audio ran 112 across its selected owner/CLI suites, observations ran 101 focused plus 41 server and four GUI protocol cases, and system/timeline ran 130. These overlapping scopes are not a unique-test sum.

Main updated the obsolete feature-denial fixture and the legacy follow harness that depended on throwing from Bun.sleep. The replacement retains the exact human row, observes one fetch, aborts after output and asserts exit130. The complete affected compatibility/input/audio set passed 199 tests across six files. Integrated typecheck passed after accurately typing freshly allocated byte arrays and Bun's native socket termination extension; runtime behavior was unchanged by those type refinements.

The first integrated run passed 411 of 412 tests; the remaining layout check required the server admission fixture to carry the server naming prefix. Its content was preserved as `tests/server/server-cli-key-probe-admission.test.ts`, both maps were updated, and the new-path/placement set passed 31 tests. No seed exception, assertion weakening, skip or size-cap increase was introduced. Historical worker logs retain the earlier fixture name.

Independent data/audio, observation, security and document reviews ended PASS. The cancellation regression failed before the final teardown correction; the corrected complete audio/live run passed 93 tests and 433 assertions. Independent security execution confirmed settlement before the fixture cancellation promise resolved, with input/signal cleanup and no late output. The ended-stream fixture checks the actual pause call because Bun can report isPaused false after automatic destruction. The report preserves that distinction instead of changing production to satisfy an invalid fixture assumption.

Privacy and structure checks passed. Generated skill/document consistency and size tests passed 65 cases; the docs build produced 561 pages and checked 78,049 internal links. All eleven new tests are registered in both layout maps. The full local suite was not repeated across concurrent worktrees; broad publication proof belongs to exact-head hosted CI.

The actual root-CLI candidate harness passed 62 invocations in 27 groups, including 39 negative invocations and seven SIGINT/SIGTERM paths. It captured separate stdout/stderr/exits, exact request metadata, synthetic state and teardown. Authentication resolvers are real; model replies and WebSocket behavior in this root harness are transport fixtures, while native socket/admission/handler evidence comes from the separate owner tests. The final source-bound rerun follows all source/record edits before D. Its current artifact root is recorded in `.tmp/cli-parity/wp7-qa-evidence.json`; raw reviews and logs remain in `.tmp/cli-parity/wp7-*`.

## Limits and next phase

The work used synthetic keys, owned temporary files/listeners and fake providers. No live user account, installed service, actual upstream model request, microphone or user upload was exercised. A successful local close does not certify server lease release; request token limits do not certify billing. UTF-8 validity alone does not guarantee the server's header carrier accepts a key, so the new CLI deliberately supports the printable-ASCII subset used by current issuance.

Observed-window reconstruction, numerical after cursors and between-request identity checks retain their stated limits. Any contradictory target, authority, partial-result or interruption observation reopens the corresponding row. Next is wp8: residual inventory acceptance, final skill/docs review, stack topology and successful current-head CI receipts for all six open PRs.
