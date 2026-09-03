# 050 — WP5: Codex 설정 account cards — one primary action, the rest behind ⋯

Depends on: nothing.

## File change map

### MODIFY gui/src/components/codex-account-pool-cards.tsx (L95-160)

- Inline actions keep: 이 계정을 다음에 사용 (`codex-account-switch`), 재인증 (when shown),
  일시 중지/재개, doctor-copy (when shown).
- 별칭 편집 (L133-135) and ✕ 삭제 (L136-144) move into
  `<details className="codex-account-more"><summary aria-label={t("codexAuth.moreActions")}>⋯</summary><div className="codex-account-more-menu">{alias}{copyId}{remove}</div></details>`.
  Add a "ID 복사" button there: `navigator.clipboard.writeText(a.id)` via the existing
  `use-copy-feedback` hook.
- Identity line (L147): `{a.email}{plan}` only; the account id moves INTO the ⋯ disclosure as a
  visible mono line next to the "ID 복사" button (audit blocker 5: no title-only info).
- `AccountPriorityControl` (L148-158): render only when
  `normalizeAccountPriority(a.priority) !== 0 || moreOpen` where `moreOpen` is the details'
  open state (controlled via `onToggle`). When hidden and the value is default, render
  `<AccountPriorityBadge>` only if the badge is non-default (it already exists — L4 import).

### MODIFY gui/src/components/codex-account-pool-main-card.tsx (L130-150)

- Same identity/priority treatment for the main account card (`AccountPriorityControl` at L140).

### MODIFY gui/src/components/AccountPoolStrategyControls.tsx (L71-84)

- Keep `accountPool.strategyDesc`; move `STRATEGY_HINT_KEYS[strategy]` and
  `accountPool.unboundDefinition` into a `Tooltip` on an ⓘ after the title. The comment block
  above it says both lines were kept deliberately — the tooltip keeps both, just not inline.

### MODIFY gui/src/pages/codex-set-multiauth.tsx (L20-45)

- `OpenAiAccountModeBanner`: return `null` when `state === null` AND the description slot
  is empty (today it reserves space "while config is still unknown"; the reserved height is
  the noise R2 saw). Keep the pending badge behaviour only if a test pins it (`rg -n
  'accountModePool' gui/tests`).

### MODIFY gui/src/styles.css

- ADD `.codex-account-more` (inline-block), `.codex-account-more > summary` (24px orb, list-style none),
  `.codex-account-more-menu` (absolute, right 0, panel bg, gap 4px, z-index 2).

### MODIFY gui/src/i18n/*.ts (9)

- ADD `codexAuth.moreActions` ("More actions" / "추가 작업"), `codexAuth.copyId` ("Copy account ID" / "계정 ID 복사").

### Tests

- MODIFY gui/tests/account-priority.test.tsx, account-pool-strategy.test.tsx,
  codex-account*.test.tsx that assert the priority select is always present or the hint
  lines are inline.
- NEW gui/tests/codex-account-card-minimal.test.tsx: a card with default priority renders no
  `select` until ⋯ is opened; 별칭 편집 is inside `details.codex-account-more`; "ID 복사" writes
  the full id (clipboard stub); a card with priority 2 renders the select inline.

## Verifiers

`bun test ./gui/tests/account-*.test.tsx ./gui/tests/codex-account*.test.ts*`, `cd gui && bun test tests`, `cd gui && bun run lint:i18n`, build.

## Accept criteria

- ko 1440 #codex-set with 6 accounts: interactive count 51 → ≤ 30; each card shows ≤ 3
  inline buttons.
- All previous actions reachable via ⋯ (render test).

## Bypass fields

E2 · CI gates · `--no-verify` · none. ⋯ is a labelled disclosure (summary aria-label "추가 작업 표시"), controls revealed inline, DOM tab order, no menu role claimed (rule shared with 030) · "early warning".
