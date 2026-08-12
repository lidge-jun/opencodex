# Cycle 2 (wp2, Bug B #879) — star-prompt deferral bound (C4 care: consent surface)

## Non-goals (consent invariant — a diff touching any of these is a C-gate FAIL)

- `src/server/management/sidebar-routes.ts` — `403 agent_consent_required` and the
  `isAgentDriven() && !hasBrowserSessionEvidence(req)` shape stay byte-untouched.
- The human interactive path: TTY gate, `ghAvailable()` gate, Yes/No selector,
  marker `.star-prompted` written BEFORE the question, `if (!yes) return;`.
- `hasStarPromptRun()` semantics — `src/update/notify.ts:135` yield behavior unchanged.
- An agent never answers, auto-dismisses, or stars; the `gh api -X PUT` instruction
  stays gated on an explicit user yes.

## Root cause (code-verified in issue #879; no external claims — no search lane needed)

1. Agent path leaves `.star-prompted` unwritten → every agent-driven start re-prints
   `printAgentDeferral()` (`src/cli/star-prompt.ts:139`).
2. Deferral text + AGENTS.md demand repeat-forever relay ("at the top of your next
   reply, unchanged" / "Silence is not a No").
3. Agent PTYs pass the TTY gate → fires during routine edit/test cycles.

## Design

New deferral record `.star-deferred` in `getConfigDir()` holding
`"<ISO> <version>"`. The agent path becomes: if the record is current, print
nothing; otherwise print the deferral once and write the record. "Current" =
same ocx version (never re-ask for a version already asked on) OR younger than
7 days (bound while version is unreadable). Net effect: at most one agent-facing
relay per version, and at most one per week across upgrades — instead of every
start, forever.

The relay text itself is bounded to a single relay: ask once in the reply
following the start that printed it; an unanswered question is NOT repeated in
later replies — the CLI re-arms on a later version. AGENTS.md changes in
lockstep (the repeat-forever bullets are the other half of the bug).

## Diff-level file map

- MODIFY `src/cli/star-prompt.ts`
  - ADD `const DEFERRAL = ".star-deferred"` + `DEFERRAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000`.
  - ADD exported pure helper `isDeferralCurrent(record: string | null, version: string, now: number): boolean`
    (exported for tests; no I/O). Semantics (audit-pinned): parse `<ISO> <version>`;
    malformed/NaN → false; same version → true ONLY when version !== "?" (a "?"
    sticky match would suppress re-arm forever); age rule requires
    `0 <= age < DEFERRAL_MAX_AGE_MS` — negative age (future-dated/corrupt record)
    fails toward re-asking.
  - IMPORT `currentVersion` from `../update/index` (audit blocker 1: the claimed
    import cycle does not exist — update/index's closure never reaches
    cli/star-prompt; notify.ts importing both is a diamond, not a cycle. No local
    readOwnVersion duplication).
  - MODIFY `maybeShowStarPrompt()` agent branch: `if (isDeferralCurrent(readRecord, version, Date.now())) return;`
    then `printAgentDeferral()` + best-effort record write (`recordOwnedConfigPath`
    + `writeFileSync`, mirroring the marker write).
  - MODIFY `printAgentDeferral()` text: single-relay instructions. Keep verbatim:
    do-not-answer rule, `"Star ${REPO}? Yes / No"` naming, `gh api -X PUT` gated on
    explicit yes, answer-settles-it, the `<details>` fold, dim single visible line.
    Remove: "Silence is not an answer... top of your next reply, unchanged".
- MODIFY `AGENTS.md` — user-consent section: keep the three Do-NOT bullets and
  "An answer settles it"; replace the "Do relay it / Silence is not a No" bullets
  with the single-relay rule and the re-arm-on-later-version note.
- MODIFY the full docs surface carrying the same repeat-forever wording (audit
  blocker 2 — 10 files, 5 languages; keep each locale's surrounding text and the
  test-locked strings `agent_consent_required` / `never an agent`):
  `README.md`, `readme/README.ko.md`, `README.zh-CN.md`, `README.ja.md`,
  `README.ru.md`, and `docs-site/src/content/docs/**/getting-started/for-agents.md`
  (en/ko/zh-cn/ja/ru). Korean edits follow the repo Korean-prose rules (no
  translationese, one register).
- MODIFY `tests/startup-prompt.test.ts`
  - Update the two wording-locked tests to the bounded text. KEEP or equivalently
    re-lock every existing consent guard (audit blocker 4): `/soft aside/`,
    "Ask the user, in your reply, whether to star", `"Star ${REPO}? Yes / No"`,
    gh-command assertion, fold structure, guard-before-marker order,
    `if (!yes) return;`, `not.toMatch(/declined/i)`, `not.toMatch(/remind the user/i)`.
    ADD positive locks for the new semantics: deferral text states a non-answer
    settles nothing (silence = deferred, never a Yes, never a recorded No) AND the
    re-arm rule (re-appears on a later version), instead of only deleting the three
    repeat-forever strings.
  - ADD source assertions: agent branch checks `.star-deferred` BEFORE
    `printAgentDeferral`; `.star-prompted` marker write still gated behind the agent
    guard (existing order assertion stays); `hasStarPromptRun` still reads only
    `.star-prompted`.
- MODIFY `tests/agent-driven.test.ts` — no change expected (pure env detection);
  confirm green.
- ADD runtime tests for `isDeferralCurrent` (in `tests/startup-prompt.test.ts` or a
  new `tests/star-deferral.test.ts`): null record → false; malformed → false; same
  version (non-"?") → true; version `"?"` + `"?"` record → age rule only;
  different version + 0 <= age < 7d → true; age > 7d → false; future-dated
  (negative age) → false.

Note (audit, non-blocking): the agent branch becomes the first config-writing
path in agent-driven runs (record write); acceptable — it writes only the
deferral record, never the marker, and `recordOwnedConfigPath` covers uninstall
cleanup dynamically.

## Activation scenarios (C)

1. Red: new `isDeferralCurrent` tests fail before the helper exists; updated
   wording tests fail while the old repeat-forever text is present.
2. Green: all updated + new tests pass after the change.
3. Invariant sweep: `tests/startup-prompt.test.ts` (management-endpoint refusal,
   human-prompt gates), `tests/agent-driven.test.ts`, `tests/sidebar-routes.test.ts`
   all green; `git diff --stat` shows NO change to `sidebar-routes.ts`,
   `interactive-confirm.ts`, `agent-driven.ts`.
4. Full `bun run test` + `bun run typecheck`.
