# Phase 020 — 디테일 헤더 액션

선택된 프로바이더의 디테일 헤더에 Test connection / 삭제 / Enabled 토글을 추가.
현재 헤더: 아이콘 + 이름 + 상태 + "Back" 버튼만 있음.

## 소스 참고

`codex/source-pr139-d209dfd5:gui/src/components/ProviderWorkspace.tsx` 1544-1660줄
(DetailPanel return JSX — `providers-workspace-detail-head` + `providers-workspace-detail-actions`)

## 산출물

### MODIFY `gui/src/components/provider-workspace/ProviderDetails.tsx`

현재 헤더:
```
┌──────────────────────────────────────────────┐
│ [icon] Provider Name  status     [Back]      │
│ [Overview] [Models] [Usage] [Settings]       │
└──────────────────────────────────────────────┘
```

목표 헤더 (스크린샷 기준):
```
┌───────────────────────────────────────────────────────────────┐
│ [< Provider Overview]  [icon] NVIDIA NIM [Free]              │
│                              [Test connection] [🗑] [Enabled ●]│
│ [Overview] [Models] [Usage & limits] [Settings]              │
└───────────────────────────────────────────────────────────────┘
```

추가할 props:
```typescript
apiBase: string;              // 이미 있음
defaultProvider?: string;     // 기본 프로바이더 표시용
onSetDisabled: (name: string, disabled: boolean) => void;
onRemoveProvider: (name: string) => void;
onTestDone?: () => void;      // Test connection 성공 후 모델 캐시 refresh
```

추가할 상태:
```typescript
const [testing, setTesting] = useState(false);
const [testMsg, setTestMsg] = useState<{ok: boolean; text: string} | null>(null);
const [removeOpen, setRemoveOpen] = useState(false);
```

추가할 UI 요소:
1. **"< Provider Overview" 백 버튼**: 현재 `t("modal.back")` → `t("pws.allProviders")` + 좌향 chevron
2. **Free/Local 뱃지**: `isFreeProvider(item)` → Free 뱃지, `isLocalProvider(item)` → Local 뱃지
3. **Test connection 버튼**: POST `/api/providers/test?name=` (WP040에서 구현 완료)
   - 결과 메시지를 `testMsg`로 표시 (ok → 녹색, fail → 빨간색)
   - `lastCheckedAt` 갱신 → ProviderOverview의 "Last checked" 업데이트
4. **삭제 버튼 (🗑)**: 클릭 시 `removeOpen=true` → `RemoveConfirmDialog` (WP091에서 이미 구현)
5. **Enabled 토글**: `<Switch>` 컴포넌트 (gui/src/ui.tsx에 이미 존재) + `onSetDisabled`

### MODIFY `gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx`

`detail` render-prop에 새 props 전달:
- `onSetDisabled`, `onRemoveProvider` — Providers.tsx에서 이미 가진 핸들러를 shell로 전달
- `onTestDone` — `fetchModelCounts()` 재호출

### MODIFY `gui/src/pages/Providers.tsx`

Shell에 `onSetDisabled`, `onRemoveProvider` props 전달 (현재 classic 뷰에서만 사용 중)

### CSS 추가 (~30줄): `provider-workspace-detail.css`에 추가
- `.pws-detail-actions` flexbox (gap 8px, align-items center)
- `.pws-test-cluster` (메시지 + 버튼 inline)
- `.pws-test-msg--ok` / `.pws-test-msg--err` 색상
- `.pws-enabled-toggle` (라벨 + Switch)

### Locale keys (x4)
- `pws.allProviders`: "< Provider Overview"
- `pws.testConnection`: "Test connection"
- `pws.testing`: "Testing…"
- `pws.enabledLabel`: "Enabled"
- `pws.enableFirst`: "Enable the provider first"
- `pws.removeProvider`: "Remove provider"
- `pws.connectionFailed`: "Connection failed"
- `pws.checking`: "Checking…"

## 검증
- gui tsc + lint + build
- 브라우저: Test connection → ok/fail 메시지, Enabled 토글, 삭제 confirm dialog
