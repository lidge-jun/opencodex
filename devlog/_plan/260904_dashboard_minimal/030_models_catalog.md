# 030 — WP3: Models catalog — one advanced disclosure, per-provider ⋯ disclosure

Depends on: 020 (dashboard copy of the v1/base/v2 switch is gone, so Subagents becomes the
single owner when this phase moves Models' copy there).

## File change map

### MODIFY gui/src/pages/Models.tsx

1. Page head (L2200-2213): delete `.page-head-actions` with the Codex-restart orb. The sidebar
   orb (App.tsx:355) and `CodexStaleBanner` (with its own restart button) remain.
2. Subtitle (L2226 `<p className="page-sub">{t(SUBTITLE_TKEY[tab])}</p>`): render only when
   `tab !== "catalog"` AND the tab's workspace is empty (combos: `combos.length === 0`; routing:
   `profiles.length === 0`; compatibility: keep as is — one line). For catalog, replace with an
   ⓘ `Tooltip` (existing `Tooltip` component, used at L1596) appended to the tab strip's right
   edge, content = `t("models.subtitle")` (the current 4-line copy).
3. Controls block (L1580-1750 `controlsBlock`): wrap the whole `.models-control-top-row`
   + the 기본 창/상한 row + paragraph in
   `<details className="models-advanced"><summary className="muted text-label">{t("models.advanced")}</summary>…</details>`.
   The v1/base/v2 row (L1603-1625) is CUT from here and PASTED into
   `gui/src/components/subagents-workspace/SubagentDelegationSection.tsx` as the first setting
   row (audit blocker 4: the endpoint is `/api/v2`. Models.tsx:888-931 reads/writes it, and
   Subagents.tsx:38-90 ALREADY loads `/api/v2` into `ultraMode` and writes it via
   `saveUltraMode(patch)` PUT `/api/v2`. NO new hook: the radiogroup in SubagentDelegationSection
   receives `ultraMode.multiAgentMode` (added to `UltraModeState` in 020) +
   `onModeChange={(mode) => saveUltraMode({ multiAgentMode: mode })}` from Subagents.tsx.
   Contract change IN THIS PHASE (round-3 blocker 2): `use-subagent-delegation.ts:29-31`
   `UltraModePatch` becomes `{ multiAgentModeHintText?: string | null; multiAgentMode?: "v1" | "default" | "v2" }`
   (both optional; the server route already accepts partial bodies — Models.tsx:888-931 PUTs
   `{ multiAgentMode }` alone today). Existing `saveUltraMode({ multiAgentModeHintText })`
   callers are unchanged. Models.tsx KEEPS `v2`, `v2Busy`, `loadV2` and the `/api/v2` writer (round-2 blocker 3:
   keep-native-ChatGPT-on-v1 L998 and the thread controls L1006-1051 still write it); only the
   radiogroup JSX (L1603-1633) and `setMultiAgentMode` (L930) leave Models. The effort-cap
   section was already rehomed to Subagents in 020 (EffortCapSection).)
4. Order hint (L1752-1755 `.models-order-hint`): delete the row; add
   `title={t("models.orderHint")}` to the `.models-collapse-controls` wrapper and an ⓘ
   Tooltip after 모두 펼치기.
5. Provider group header (L1240-1350 region; `models.useDefaultAliases` L1252, 커스텀 모델 추가,
   `allOn/allOff` L1342, per-provider 기본 창/상한 + 사용자 지정 창): keep the edit pencil and
   모두 켜기/끄기 inline; move 기본 별칭 사용, 커스텀 모델 추가, 기본 창/상한, 사용자 지정 창 into
   a `<details className="models-group-more">` with a "⋯" summary (aria-label
   `t("models.groupMore")`). Semantics (audit blocker 6): this is a DISCLOSURE, not a menu, and is labelled as one:
   `<summary aria-label={t("models.groupMore")}>` (native details exposes aria-expanded) with
   the revealed controls laid out inline in the header row, not a floating popover. Tab order
   is DOM order; no arrow-key/Escape model is claimed. The string reads "추가 작업 표시", never
   "메뉴". Same rule for every ⋯ in this unit (050).

### MODIFY gui/src/styles.css

- ADD `.models-advanced > summary`, `.models-group-more` (inline-flex, summary as a 24px orb).
- The `.models-shadow-row`, `.models-v2-mode-row` rules stay (still used inside details /
  Subagents).

### MODIFY gui/src/i18n/*.ts (9)

- ADD `models.advanced` ("Advanced" / "고급"), `models.groupMore` ("More provider actions" /
  "프로바이더 추가 작업").
- `models.v2Label`, `models.v2Mode_*` keys: still used (Subagents now) — keep.

### Tests

- MODIFY gui/tests/*models*.test.ts* that assert the restart orb / subtitle / order hint in
  the catalog DOM (list at P with `rg -n 'orderHint|page-head-actions|models.subtitle' gui/tests`).
- NEW gui/tests/models-advanced-disclosure.test.tsx: catalog renders `details.models-advanced`
  closed; opening it reveals the 별칭 Switch and shadow-call Switch; the v1/base/v2 radiogroup
  is NOT in Models and IS in SubagentDelegationSection.
- NEW gui/tests/models-group-more.test.tsx: a provider group renders 모두 켜기/끄기 inline and
  the 4 secondary actions inside `details.models-group-more`.

## Verifiers

`bun test ./gui/tests/models-*.test.ts* ./gui/tests/subagent*.test.ts*`, `cd gui && bun test tests`, `cd gui && bun run lint:i18n`, build.

## Accept criteria

- ko 1440 #models: interactive count 135 → ≤ 60 with all groups expanded; ≤ 30 collapsed.
- Subagents page shows the v1/base/v2 radiogroup; Models does not; Dashboard does not.
- PUT to `/api/v2` with `{ multiAgentMode }` fires from the Subagents control (render test with fetch stub).

## Bypass fields

E2 · CI gates · `--no-verify` · residual: the ⋯ is a labelled disclosure, not a menu role · "early warning".
