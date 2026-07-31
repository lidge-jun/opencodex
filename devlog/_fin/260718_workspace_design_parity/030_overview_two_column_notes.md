# Phase 030 — Overview 탭 2-column 레이아웃 + Notes

선택된 프로바이더의 Overview 탭을 좌우 분할 레이아웃으로 변경.
현재: ConnectionCard + StatsSidebar가 세로로 쌓여 있음.
목표: 소스의 `pwi-overview-layout` 패턴 — 좌측 메인(CONNECTION + AUTH) / 우측 사이드바(STATS + NOTES).

## 소스 참고

`codex/source-pr139-d209dfd5:gui/src/components/ProviderWorkspace.tsx` 591-634줄
(TabOverview → `pwi-overview-layout` → `pwi-overview-main` + `StatsSidebar`)

## 현재 상태

```
┌─────────────────────────────────────────┐
│ CONNECTION                              │
│  Status: Connected                      │
│  Base URL: ...                          │
│  Auth: API key                          │
│  Default model: ...                     │
├─────────────────────────────────────────┤
│ PROVIDER STATS (aside, 세로로 쌓임)      │
│  Total requests: 90                     │
│  Quota updated: 8 min ago              │
└─────────────────────────────────────────┘
```

## 목표 (스크린샷 기준)

```
┌──────────────────────────────┬──────────────────┐
│ CONNECTION                   │ PROVIDER STATS   │
│  Status: Connected           │  Total req (30d) │
│  Base URL: ...               │  90              │
│  Last checked: Not checked   │                  │
│  Authentication: API key     │  > View usage    │
│  Default model: meta/...     │                  │
│                              │ NOTES            │
│  ✓ All systems operational   │  Add a note...   │
│         [Edit settings]      │                  │
├──────────────────────────────┤                  │
│ API KEYS                     │                  │
│  ● api key configured        │                  │
│  + Add API key               │                  │
└──────────────────────────────┴──────────────────┘
```

## 산출물

### MODIFY `gui/src/components/provider-workspace/ProviderOverview.tsx`

1. **레이아웃 구조 변경**: root `pws-overview`를 CSS grid 2-column으로:
   ```tsx
   <div className="pws-overview-layout">
     <div className="pws-overview-main">
       <ConnectionCard ... />
       {/* WP091의 ProviderAuthPanel은 Settings 탭에 있음 — 
           Overview 탭에는 요약만: "api key configured" / "Logged in" 한 줄 */}
       <AuthSummarySection item={item} ... />
     </div>
     <aside className="pws-overview-sidebar">
       <StatsSidebar ... />
       <NotesSection item={item} onUpdateNote={onUpdateNote} />
     </aside>
   </div>
   ```

2. **ConnectionCard 개선**:
   - "Last checked" 행 추가 (lastCheckedAt prop → formatRelativeTime)
   - "All systems operational" / "Needs setup" 상태 행 추가
   - "Edit settings" 버튼 추가 (onEditSettings → Settings 탭으로 전환)

3. **Auth 요약 섹션** (API KEYS / OAuth):
   - key auth: "● api key configured" + "+ Add API key" 링크 (Settings 탭으로)
   - oauth: "● Logged in as email@..." 또는 "○ Not logged in" + Login 버튼
   - forward: "● Codex passthrough" (추가 조작 없음)
   - 이 섹션은 WP091의 ProviderAuthPanel과 별개 — 읽기전용 요약이며,
     실제 편집은 Settings 탭의 AuthPanel에서 수행

4. **StatsSidebar 개선**:
   - "View detailed usage >" 링크 추가 (onViewUsage → Usage 탭으로 전환)
   - quota source label 표시

5. **NEW NotesSection**:
   - `item.note` 표시 / 없으면 "Add a note about this provider..." placeholder
   - 클릭 시 inline textarea로 전환, blur/enter 시 PATCH /api/providers?name= 로 저장
   - `onUpdateProvider(name, { note })` prop 재사용

### 추가할 props (ProviderOverview):
```typescript
onEditSettings?: () => void;          // → Settings 탭 전환
onViewUsage?: () => void;             // → Usage 탭 전환  
onUpdateProvider?: (name: string, patch: ProviderUpdatePatch) => Promise<{ok: boolean; error?: string}>;
lastCheckedAt?: number;               // Test connection 결과
```

### MODIFY `gui/src/components/provider-workspace/ProviderDetails.tsx`

ProviderOverview에 새 props 전달:
```tsx
<ProviderOverview
  item={item}
  usageTotals={usageTotals}
  quotaReport={quotaReport}
  oauthEmail={oauthEmail}
  onEditSettings={() => switchTab("settings")}
  onViewUsage={() => switchTab("usage")}
  onUpdateProvider={onUpdateProvider}
  lastCheckedAt={lastCheckedAt}
/>
```

### CSS 추가 (~40줄): `provider-workspace-detail.css`에 추가
- `.pws-overview-layout` — CSS grid `grid-template-columns: 1fr 280px`
- `.pws-overview-main` — 좌측 메인
- `.pws-overview-sidebar` — 우측 사이드바 (sticky top)
- `.pws-notes-section` — 편집 가능한 notes
- `@media (max-width: 768px)` — 1-column 폴백

### Locale keys (x4)
- `pws.editSettings`: "Edit settings"
- `pws.viewUsage`: "View detailed usage"
- `pws.allSystemsOk`: "All systems operational"
- `pws.apiKeyConfigured`: "api key configured"
- `pws.addApiKey`: "Add API key"
- `pws.notes`: "NOTES"
- `pws.notePlaceholder`: "Add a note about this provider..."

## 검증
- gui tsc + lint + build
- 브라우저: 프로바이더 선택 → Overview 탭에서 좌우 분할 확인
- 768px 이하에서 1-column 폴백 확인
- Notes 편집 → PATCH 요청 → 새로고침 후 유지 확인
