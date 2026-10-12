# 040 — wp4: Integrations > Cursor shows ladder provenance and a table-less hint

Depends on: 010 (status fields `effortTable`, `family`), 030 (`tableLess`, `effortRows`). Own PR;
title/description mention "gui", so the PR must carry a screenshot (enforce-target).

Loop-spec: spec-satisfaction; trigger = "—" in the Reasoning column explains nothing; goal = the
user sees WHY a row has no control (Cursor's table, which build) and WHAT to do (turn on
`cursorEffortRows`, or set a provider default); non-goals = new pages, other locales than en/ko;
verifier = `bun run lint:gui && bun run build:gui` + a rendered screenshot; stop = green +
exact-head CI.

## File change map

### MODIFY `gui/src/pages/integrations/cursor-api.ts`

```ts
export interface CursorIntegrationStatus {
  // ...existing
  effortTable: { source: "bundle" | "static"; version: string | null; families: number | null };
  models: Array<{
    id: string;
    reasoning: string[] | null;
    family: string | null;
    tableLess: boolean;
    effortRows: string[];
    context: { defaultWindow: number; longWindow: number } | null;
  }>;
}
```

### MODIFY `gui/src/pages/integrations/CursorIntegrationPage.tsx`

1. Under the "What Cursor will show" heading (line ~141), replace the static hint paragraph with a
   provenance line:
```tsx
<p className="muted">
  {status.effortTable.source === "bundle"
    ? t("integrations.cursor.ladderFromBundle", { version: status.effortTable.version ?? "?" })
    : t("integrations.cursor.ladderFromStatic")}
</p>
```
2. Reasoning cell (line ~155): when `model.reasoning` is null render
```tsx
<td>
  <span className="cursor-no-control" title={t("integrations.cursor.noControlTitle")}>—</span>
  {model.effortRows.length > 0
    ? <span className="cursor-effort-rows">{t("integrations.cursor.effortRowsOn", { n: model.effortRows.length })}</span>
    : <span className="cursor-effort-rows muted">{t("integrations.cursor.effortRowsOff")}</span>}
</td>
```
   otherwise the existing `join(" · ")`.
3. After the table, one paragraph (only when any row is table-less):
```tsx
{status.models.some(m => m.tableLess) && (
  <p className="muted" data-cursor-tableless-hint>{t("integrations.cursor.tableLessHint")}</p>
)}
```

### MODIFY `gui/src/styles-integrations.css`

`.cursor-effort-rows { margin-left: .5rem; font-size: .85em; }` — nothing else.

### MODIFY `gui/src/i18n/en.ts` (after `integrations.cursor.modelsHint`)

```ts
"integrations.cursor.ladderFromBundle": "Reasoning ladders read from the installed Cursor Private Inference {version} bundle. Cursor decides them; opencodex only reports its table.",
"integrations.cursor.ladderFromStatic": "Reasoning ladders are a static mirror of Cursor 3.18.25 (no Private Inference install found to read). Context lists the default and the opt-in window.",
"integrations.cursor.noControlTitle": "This id is not in Cursor's built-in effort table, so Cursor shows no Reasoning control.",
"integrations.cursor.effortRowsOn": "{n} effort rows published",
"integrations.cursor.effortRowsOff": "no effort rows",
"integrations.cursor.tableLessHint": "Rows marked — get no Reasoning control in Cursor. Turn on cursorEffortRows to publish one picker entry per effort (id--effort), or set modelDefaultReasoningEfforts on the provider for a fixed default.",
```

### MODIFY `gui/src/i18n/ko.ts` (same keys)

```ts
"integrations.cursor.ladderFromBundle": "Reasoning 사다리는 설치된 Cursor Private Inference {version} 번들에서 읽었습니다. 사다리는 Cursor가 정하고 opencodex는 그 표를 보여줄 뿐입니다.",
"integrations.cursor.ladderFromStatic": "Reasoning 사다리는 Cursor 3.18.25의 정적 미러입니다(읽을 Private Inference 설치를 찾지 못함). Context는 기본 창과 옵트인 창입니다.",
"integrations.cursor.noControlTitle": "이 id는 Cursor 내장 effort 표에 없어서 Cursor가 Reasoning 컨트롤을 보여주지 않습니다.",
"integrations.cursor.effortRowsOn": "effort 행 {n}개 게시됨",
"integrations.cursor.effortRowsOff": "effort 행 없음",
"integrations.cursor.tableLessHint": "—로 표시된 행은 Cursor에서 Reasoning 컨트롤이 없습니다. cursorEffortRows를 켜면 effort마다 picker 항목(id--effort)을 하나씩 게시하고, 고정 기본값은 provider의 modelDefaultReasoningEfforts로 정합니다.",
```

Other locales are untouched; `t()` falls back to en for missing keys (verify in
`gui/src/i18n/index.ts` at P of this cycle; if there is no fallback, add the en strings to the
other locale files verbatim).

### MODIFY `tests/cursor-integration-status.test.ts`

No new server behaviour; keep. GUI evidence is the screenshot (C-RENDER-GROUNDING-01): run
`bun run build:gui`, start the proxy from this checkout on a temp `OPENCODEX_HOME`, open
`/#/integrations/cursor` in agbrowse at 1280x720, capture with a table-less row visible and
attach to the PR and to `041_wp4_screenshot.png` in this unit.

## Accept criteria

- `bun run lint:gui` 0; `bun run build:gui` 0; typecheck 0.
- Screenshot shows the provenance line reading "3.18.25 bundle" on this machine and the hint
  paragraph under the table.
- With `cursorEffortRows` off nothing else on the page changes.
