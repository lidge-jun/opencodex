# 030 — WP3: maintenance-panel dedupe + plain-Korean delegation copy

## Slice A — maintenance panel

`gui/src/pages/dashboard-overview-sections.tsx:167-185` renders a dedicated panel row
for "모델 동기화" + "업데이트 확인". Once the sidebar owns the update entry point
(WP1), the panel's primary "업데이트 확인" button is a second door to the same dialog
and the heavier of the two visually (`btn-primary`).

MODIFY: demote the update button to `btn-ghost` so model sync and update read as peer
maintenance actions, and keep the sidebar orb as the surface that signals *when* an
update exists. The panel keeps the button (it is where the version/channel context
lives), it just stops competing for attention.

## Slice B — delegation copy

User feedback on the delegation panel: "이거 너무 어려워 1번 2번 3번이 뭘하는지 좀
쉽게 설명해봐". The three controls today:

| # | Key | Current Korean | Problem |
|---|-----|----------------|---------|
| 1 | `dash.injectionHint` | "아래 두 제어가 함께 사용할 모델과 선택적인 추론 강도를 고릅니다." | "아래 두 제어", "선택적인 추론 강도" — refers to UI position, not the job |
| 2 | `dash.syncCodexSubagentDefaultsHint` | "기본적으로 꺼져 있습니다. OpenCodex가 Codex 라우팅을 관리하는 경우 동기화하거나 재시작하면 선택한 모델과 추론 강도를 새 Codex 작업의 네이티브 Codex [agents] 기본값으로 적용합니다..." | one 70-word sentence, config-file vocabulary |
| 3 | `dash.multiAgentGuidanceHint` | "OpenCodex가 작성한 위임 안내를 추가합니다. 위의 네이티브 Codex 기본값과 별개이며 v1/v2 표면, 서브에이전트 로스터, 라우팅, effort 상한은 바꾸지 않습니다." | negative-space definition; says what it does NOT do before what it does |

MODIFY: rewrite all three to lead with the user-visible effect, in short sentences,
keeping the technical qualifier as a trailing clause. Update
`gui/src/i18n/{en,ko,ja,de,zh,ru}.ts` — `en.ts` owns `TKey`, so every locale must carry
the same keys or `lint:i18n` fails.

Korean style constraints (per repo Korean-prose rules): no `~에 대해` / `~를 통해` /
`~함으로써` translationese, no `첫째/둘째` enumeration, one consistent register.

## TESTS

Copy-only change: covered by `bun run lint:i18n` (key parity across locales) plus the
existing dashboard tests. No new behavioral test.

## Verification (C)

```
cd gui && bun run lint:i18n && bun run lint && bun run build   # exit 0
```

Rendered proof: screenshot the delegation panel and the maintenance panel in Korean.
