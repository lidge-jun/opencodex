# Bounded repairs

Depends on: coordinator roadmap `995dee54a0`, train `da40c734a5` and Lane A discovery.

1. A1: modify `src/server/responses-terminal-repair.ts` to remember a consumed delimiter ending in CR only when its buffer is empty. Consume exactly one following LF as a delimiter continuation while forwarding its byte unchanged. Empty chunks retain pending state; any non-LF content settles it. Do not relax genuinely unframed suffix rejection or lifecycle eligibility.
   Extend `tests/responses/responses-terminal-repair.test.ts`: complete terminal-less CRLF lifecycle split before final LF versus unsplit, repeated CRLF splits, empty intervening chunks, CR/CR and LF/CR delayed-LF delimiters, a second LF, bare CR, non-LF suffix, real terminal, and budget/timer release. Update `structure/transports/responses-wire-shapes.md`.
2. A2: modify `src/web-search/run-turn-loop.ts` to check the remaining iteration before empty-answer recovery side effects (retry state, warning, heartbeat and dispatch). Keep the existing cap and terminal error. Extend `tests/web-search/web-search-forced-declaration.test.ts` with search/search/search/empty at maxSearches=1: exactly four model attempts, one physical search, terminal cap error, no fifth dispatch. Also preserve recovery below the ceiling. Update `structure/runtime.md`; the fetch loop does not dispatch eagerly and needs no production change.
3. A3: modify only `logs.detail.reason.decode_window_too_short` in `gui/src/i18n/pt.ts` to describe the measured output window. Existing metric calculation and all other locales remain unchanged.

No new persisted fields, enums or interfaces. The pending-LF flag is request-local parser state only; it is created false, set at consumed CR delimiter boundaries, consumed by the next nonempty fragment, and discarded with the relay. No serialization boundary exists.

## Verification

- Baseline: `bun test tests/responses/responses-terminal-repair.test.ts tests/web-search/web-search-forced-declaration.test.ts`; output in private recovery evidence.
- Red/green for added regressions, followed by `bun test tests/responses/responses-terminal-repair.test.ts tests/responses/sse-rewrite-line-endings.test.ts tests/responses/chat-sse-framing-guard.test.ts`.
- `bun test tests/web-search/web-search-forced-declaration.test.ts tests/web-search/web-search-run-turn-loop.test.ts`.
- Existing header/replay and generation-window focused regressions, including management metric consumers, within the eight-file batch limit.
- GUI locale tests with `--isolate` and `bun run lint:i18n`; no rendered layout is changed and no build is authorized.
- `bun run structure:check`, file-size ratchet, layout guards, privacy scan and `git diff --check`.
- Root/GUI typechecks and full cross-platform CI are deferred to the coordinator's frozen union. Tests only establish their exercised local/mock contracts.
