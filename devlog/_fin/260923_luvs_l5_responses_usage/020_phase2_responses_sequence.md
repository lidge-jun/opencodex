# wp3: #5560, #5542, #5553 on the shared Responses dispatch path

Applied after wp2 in this order. Each hunk on `passthrough-dispatch.ts` is disjoint.

## #5560 (head `2ec0cd12f5`)

1. Combine `71a9fe575b` and `ffd50f485c` (both Yeonwoo Choi) into one commit authored by
   Yeonwoo Choi: `git cherry-pick -n 71a9fe575b ffd50f485c`, then restore
   `src/adapters/xai-web-search.ts` to `origin/dev` (dev `b20acc79d2` already owns the selector
   rule), keeping the net Cursor continuation, blob-estimate, xAI custom item-ID repair, extracted
   tests and docs. The net diff leaves `tests/providers/cursor/cursor-blob.test.ts` at 3,657 lines
   and `tests/responses/openai-responses-passthrough.test.ts` at 4,809.
2. `git cherry-pick -x 31f21f0370 a326b67338 7e8fb09b39 57407be416 c7781bf81c fbecefa18b 82a5f6da81 aac783fe8d 2ec0cd12f5`
   Layout-map conflicts resolve by union.

## #5542 (head `b57d7c5da0`)

Skip `43f1c19fbe`, `10bf60cea3`, `d61ec2e603` (on dev in `53654291cd`) and `7f3f18aed8` (merge).

1. `git cherry-pick -x e555e7305b`. Its decision record is added as ADR-0097 and renamed to
   ADR-0099 by `b57d7c5da0` below (dev's ADR-0097 is unrelated); the head has no duplicate.
2. `git cherry-pick -x 7cbbf44f6c 19a2005e41 9662528195`.
3. `git cherry-pick -x b57d7c5da0`. As a single-commit pick it carries only its own delta (the
   ADR rename and the combined JSON/SSE regression), so dev's #5508 versions of
   `docs-site/.../guides/codex-integration.md`, `structure/transports/streaming-health.md` and
   `tests/responses/ws-native-injection.test.ts` stay intact. A dry run on `a4bdc03054` applied
   every wp3 commit without conflict.

## #5553 (head `67c4f579e4`)

Skip `35fb727ddf`, `940b318292` (on dev in `b7351ddef3`) and `67c4f579e4` (merge).

1. `git cherry-pick -x b8f9a45761 808dd85a9f db854bf306 b037810fe2 e6f9339f83 f86a53437c 76b40f9fd0 385f338d82 feb0c160aa 466c75c89c 9050722914 b2eda92b1b 1069b541f7 37a006e223`
2. Conflicts in `src/lib/upstream-retry.ts`, `src/lib/errors.ts`, `tests/lib/upstream-retry.test.ts`,
   `tests/usage/request-log.test.ts` keep dev's #5575 side (`invitesResendAfterReplacement`, the
   whole-sentence refusal matcher and its status table).
3. `git cherry-pick -x be1fee99aa`, then a follow-up commit (luvs01 co-author trailer) rewrites
   the transport-doc paragraph so it references dev's broader replacement fence instead of a
   5xx-only rule. The dry run applied it without conflict; the wording is the only repair.

Cap checks after the phase: `src/server/responses/core.ts` 210,
`tests/responses/responses-compaction-routing.test.ts` at most 2,776.

## Outcome (wp3)

All planned commits applied on `a077087b74` after resolving the conflicts above. Review follow-ups:
`test(cursor): pin exact host-wrapper classification in continuation scope` (exact summary and
ambient wrappers are classified by shape, matching the Codex client; documented in
`structure/providers/cursor.md`) and `test(server): prove a suppressed same-workspace alternate is
never sent` (exact one-send assertion; the transport contract now limits suppression to the
in-request move). A later request can still select a same-workspace sibling that was not itself
refused; that selection behavior predates this carry and is reported to the maintainer.
Local checks: NOT RUN. Static gate passed; hosted CI verifies in wp5.
