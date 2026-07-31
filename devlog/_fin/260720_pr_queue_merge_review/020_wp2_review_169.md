# 020 — WP2: #169 (Providers workspace follow-up) 딥리뷰

## 목표 verdict

1차 판정 `approve-after-rebase`(WP5 충돌 가이드의 입력). GUI ~1000라인을
전수 딥리딩해 회귀 복구의 완전성과 신규 버그를 가린다.

## 변경 인벤토리 (21 files)

백엔드 1: `src/codex/catalog.ts` (6줄, 1차 확인 완료).
테스트 2: `tests/provider-live-models.test.ts`, `tests/provider-workspace-state.test.ts`.
GUI 14: `App.tsx`, `pages/Providers.tsx`, `components/AddProviderModal.tsx`,
`provider-catalog/ProviderCatalog.tsx`, `provider-workspace/{ProviderDetails,
ProviderModels,ProviderOverviewDashboard,ProviderSettings,ProviderUsage,
ProviderWorkspaceShell}.tsx`, `provider-workspace/{catalog.ts,report.ts}`,
i18n 4: de/en/ko/zh. CSS 2: provider-overview-dashboard.css,
provider-workspace-shell.css.

## 딥리뷰 포커스 (sol explorer 병렬 레인)

레인 A — `pages/Providers.tsx` + `ProviderWorkspaceShell.tsx`:
Classic/Workspace 뷰 지속성(localStorage + hash sync)의 양방향 동기화 루프
위험, hashchange 리스너 정리, "safer hash↔preference sync" 주장의 실제 구현.
레인 B — `AddProviderModal.tsx` + `ProviderCatalog.tsx` + `catalog.ts`:
API-key row에서 OAuth 시작 금지 가드, OpenAI/Codex 로그인 와이어링,
remove/unsaved 다이얼로그 복구분.
레인 C — Overview/Details/Models/Usage + CSS: Rate Limits/Recently Used
나란히 배치, Models 칩 wrap + Default 배지 분리, Usage 메트릭 간격,
Anthropic needsReauth 시 configured-models 폴백 + reauth 배너.

## 검증 명령

```
bun test tests/provider-live-models.test.ts tests/provider-workspace-state.test.ts
cd gui && bun x tsc --noEmit && bun run lint
```

## C-ACTIVATION-GROUNDING-01 시나리오

- OAuth-no-token → configured 카탈로그 폴백: provider-live-models 테스트가
  이 분기를 직접 단언하는지 확인(없으면 블로커는 아니지만 verdict에
  "폴백 분기 미커버" 잔여로 기록).
- hash↔localStorage 동기화 **(A-gate fold #5 — 테스트 미커버 확인됨)**:
  provider-workspace-state.test.ts는 filterModels만 검사하고 hash↔localStorage
  분기를 실행하지 않음. Providers.tsx의 초기 마운트 시 hash가
  localStorage를 덮는 경로/그 반대 경로가 각각 존재하는지 코드 리딩으로 확인.
  verdict에 "hash↔preference sync는 자동화 테스트 미커버, 코드 리딩으로만
  검증" 잔여로 명시한다.

## 판정 규칙

- 테스트+tsc+lint 그린 & 레인 A-C 블로커 0 → `approve-after-rebase`.
- 기능 버그(상태 꼬임, 로그인 오동작) 1개라도 → `needs-work` + file:line.

---

## Verdict (WP2 결과) — `needs-work` (3 blockers)

sol reviewer Ptolemy(gpt-5.6-sol priority): 14/14 tests pass, tsc+lint 그린.

### P1 블로커 3건

1. **Deep-link 회귀** — `#providers/workspace`로 직접 접근 시 localStorage에
   classic이 있으면 `#providers`로 덮어씀. hash가 mount effect에서 localStorage
   우선으로 해석되어 workspace deep-link가 무시됨.
   `gui/src/App.tsx:130-135`, `gui/src/pages/Providers.tsx:110-131`.

2. **Unsaved Settings 가드 불완전** — 탭 변경과 Back 버튼만 가드. 레일에서 다른
   provider 클릭, Classic 전환, 사이드바 이동 시 ProviderDetails가 직접 unmount
   되어 draft 손실. `ProviderDetails.tsx:96-110`,
   `ProviderWorkspaceShell.tsx:401`, `Providers.tsx:757-767`.

3. **OAuth no-token 폴백의 글로벌 의미 확장** — `catalog.ts:1269-1273`의 변경이
   `gatherRoutedModels`(→ `/v1/models`, Claude discovery, Codex catalog sync)에
   실행 불가 모델을 노출. `resolveModelsAuthToken`(`oauth/index.ts:325-329`)의
   "로그아웃 시 skip" 계약과 모순. configured 폴백은 GUI 전용 뷰 데이터로
   한정해야 함.

### P2 잔여 2건 (non-blocking)

- 긴 모델 ID chip overflow (`provider-workspace-shell.css:810-851`).
- >40 모델 가상화 제거 (`ProviderModels.tsx:110-131`).

### P3 nit 1건

- `provider-workspace-shell.css:910` EOF 빈 줄 (`git diff --check` fail).
