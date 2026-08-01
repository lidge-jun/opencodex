# Phase 010 — 집계 Overview 대시보드

프로바이더를 선택하지 않았을 때 ProviderWorkspaceShell의 메인 영역에 렌더링되는 집계 화면.
현재는 `pws.selectPrompt` placeholder만 보임.

## 소스 참고

`codex/source-pr139-d209dfd5:gui/src/components/ProviderWorkspace.tsx` 2700-2791줄
(EmptyState 이전의 메인 패널 — 프로바이더 0개일 때 EmptyState, 1개 이상이면 overview)

## 산출물

### NEW `gui/src/components/provider-workspace/ProviderOverviewDashboard.tsx` (≤250줄)

Props:
- `sections: WorkspaceSections` (from buildProviderWorkspace — ready/needsSetup/disabled)
- `quotaReports: Record<string, ProviderQuotaReportView>` (from /api/provider-quotas)
- `usageTotals: Record<string, ProviderUsageTotals>` (from /api/usage?range=30d)
- `onSelectProvider: (name: string) => void` (클릭 시 해당 프로바이더 선택)
- `defaultProvider?: string`

렌더링 구조 (스크린샷 기준):
```
┌─────────────────────────────────────────────────────┐
│ Providers overview                      {Edit JSON} │
│ Manage all your model providers in one place.       │
├──────────┬──────────┬──────────┐                    │
│ 5 Ready  │ 0 Setup  │ 0 Disab  │ ← summary cards   │
├──────────┴──────────┴──────────┘                    │
│ RATE LIMITS                                         │
│  ChatGPT         Checked 16 min ago >               │
│    5-hour limit   ████████░░  42%  Resets 08:15      │
│    Weekly limit   ██████████░ 67%  Resets 21 Jul     │
│  Anthropic       Checked 8 min ago >                │
│    5-hour limit   ███░░░░░░░  18%  Resets 09:15      │
│    Weekly limit   █████████░░ 51%  Resets 22 Jul     │
│ RECENTLY USED                                       │
│  ChatGPT                    1.3k requests >         │
│  Anthropic Claude            642 requests >         │
│  NVIDIA NIM                   90 requests >         │
└─────────────────────────────────────────────────────┘
```

구현 세부:
1. **Summary cards**: `sections.ready.length` / `sections.needsSetup.length` / `sections.disabled.length`
   3개의 숫자 카드. 클릭 없음 (정보 전용).
2. **RATE LIMITS**: `Object.entries(quotaReports)` 순회. 각 프로바이더 행:
   - 프로바이더 아이콘 + 이름 (ProviderIcon + formatProviderDisplayName)
   - "Checked N min ago" (formatRelativeTime)
   - 클릭 시 `onSelectProvider(name)` → 해당 프로바이더의 Usage 탭으로
   - 하위에 QuotaBars 컴포넌트 (기존 `<QuotaBars>` 재사용, `layout="compact"`)
3. **RECENTLY USED**: `buildMostUsedProviders(usageTotals)` 결과를 렌더링.
   각 행: 아이콘 + 이름 + "N requests" + chevron. 클릭 시 `onSelectProvider`.

### MODIFY `gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx`

현재 `pws-detail-placeholder` → `<ProviderOverviewDashboard>` 교체:
```diff
- <div className="pws-detail-placeholder">
-   <p className="muted">{t("pws.selectPrompt")}</p>
- </div>
+ <ProviderOverviewDashboard
+   sections={sections}
+   quotaReports={quotaReports}
+   usageTotals={usageTotals}
+   onSelectProvider={onSelect}
+   defaultProvider={defaultProvider}
+ />
```

### NEW CSS: `gui/src/styles/provider-overview-dashboard.css` (~60줄)
- `.pws-dashboard` root
- `.pws-dashboard-summary` flexbox (3 cards)
- `.pws-dashboard-section` (RATE LIMITS / RECENTLY USED 헤더)
- `.pws-dashboard-row` (프로바이더 행 — 클릭 가능)
- `@import` 추가 in `styles.css`

### Locale keys (x4)
- `pws.dashboard.title`: "Providers overview"
- `pws.dashboard.subtitle`: "Manage all your model providers in one place."
- `pws.dashboard.rateLimits`: "RATE LIMITS"
- `pws.dashboard.recentlyUsed`: "RECENTLY USED"
- `pws.dashboard.requests`: "{count} requests"

## 검증
- `cd gui && bunx eslint src/components/provider-workspace/ProviderOverviewDashboard.tsx && bun x tsc -b --noEmit && bun run build`
- 브라우저: `#providers/workspace` → 프로바이더 미선택 시 대시보드 렌더링 확인
