# 030 — WP3: #171 (OAuth/Codex Re-authenticate) 딥리뷰

## 목표 verdict

백엔드는 1차에서 상당히 검증됨. 이 사이클은 GUI 잔여 hunks(대부분의
+1168)와 백엔드↔GUI 계약의 엣지케이스를 닫는다.

## 변경 인벤토리 (29 files)

백엔드 4(1차 확인): `src/codex/auth-api.ts`, `src/codex/auth-collision.ts`,
`src/oauth/index.ts`, `src/server/management-api.ts`.
테스트 6: codex-auth-api, codex-auth-collision, oauth-reauth-bind,
provider-workspace-auth, provider-workspace-data, provider-workspace-rail.
GUI 15: AddCodexAccountModal(1차 확인), CodexAccountPool, ProviderAuthPanel,
ProviderDetails, ProviderOverview, ProviderOverviewDashboard, ProviderRail,
ProviderWorkspaceShell, provider-workspace/{types,catalog,usage}.ts,
pages/Providers.tsx, styles.css + CSS 2. i18n 4.

## 백엔드↔GUI 계약 체크리스트 (대조표 산출)

| # | 백엔드 계약 | GUI 호출 지점 | 확인 |
|---|-------------|----------------|------|
| 1 | `/api/codex-auth/login` reauth는 `{id, reauth:true}` 필수, 미지정 시 400 | CodexAccountPool/AddCodexAccountModal의 Re-authenticate 버튼 | |
| 2 | reauth 대상이 configured pool account 아니면 404 | GUI가 임의 id를 별도 입력으로 볼 수 있는지 | |
| 3 | identity 앵커 불일치 시 flow error 상태 | GUI가 error 상태를 폴에서 표시하는지 | |
| 4 | `login-status?reauth=1`은 flow 없으면 credential 존재로 완료 안 함 | 폴 URL에 `&reauth=1` 포함(1차 확인) | |
| 5 | `/api/oauth/login` accountId 있으면 reauth 간주, 미존재 시 404 | ProviderAuthPanel의 계정 슬롯 호출 | |
| 6 | `runLogin` reauthAccountId는 기존 credential 없으면 throw | GUI가 첫 로그인에는 `accountId`를 보내지 않는지 | |

## 딥리뷰 포커스 (sol explorer 병렬 레인)

레인 A — CodexAccountPool.tsx: Re-authenticate CTA가 stale/needsReauth 행에만
뜨는지, 진행 중 취소가 polling/timer를 정리하는지, 여러 계정 동시 reauth 가능
상태인지(모달 단일 인스턴스 가정).
레인 B — ProviderAuthPanel + ProviderOverview(Dashboard) + ProviderRail:
needs-setup amber 표시의 소스 데이터, attention 배너 CTA 와이어링,
workspace overview 요약 정합성.
레인 C — Providers.tsx + i18n: 신규 키 4개 로케일 정합(누락 키),
classic/workspace 양쪽에서의 CTA 노출 조건.

## 검증 명령

> **NOTE (A-gate fold #2):** `tests/oauth-reauth-bind.test.ts`는 #171 신규
> 파일이라 main에 없음. 반드시 #171 PR head를 scratch worktree에서 실행.

```
git fetch origin pull/171/head
git worktree add /tmp/ocx-pr171 FETCH_HEAD --detach
cd /tmp/ocx-pr171
bun install
bun test tests/oauth-reauth-bind.test.ts tests/provider-workspace-auth.test.ts \
  tests/codex-auth-api.test.ts tests/codex-auth-collision.test.ts
cd gui && bun x tsc --noEmit && bun run lint
cd /Users/jun/developer/new/700_projects/opencodex
git worktree remove --force /tmp/ocx-pr171
```

## C-ACTIVATION-GROUNDING-01 시나리오

- 앵커 없음 거부: chatgptAccountId도 pool email도 없는 슬롯으로 reauth →
  "Cannot verify account identity" 에러. **(A-gate fold #4):**
  `oauth-reauth-bind.test.ts`는 일반 OAuth `runLogin` identity mismatch만
  실행하며, Codex `auth-api.ts` 내부의 chatgptAccountId/pool-email 앵커
  분기와 앵커 없음→fail-closed 분기는 **테스트 미커버**. `codex-auth-api.test.ts`의
  관련 검사는 source-string assertion일 뿐 behavior test가 아님.
  verdict에 "Codex identity 앵커 3분기(일치/불일치/없음) 중 behavior test
  미커버 — 잔여 리스크"로 명시한다.
- 잘못된 identity: 다른 chatgptAccountId로 로그인 완료 시 flow error —
  위와 동일하게 미커버. 코드 리딩으로 계약 일치를 확인하되 verdict에 기록.

## 판정 규칙

- 계약 표 전부 ✓ & 테스트 그린 & 레인 블로커 0 → `approve-after-rebase`
  (#169 선행 머지 전제, WP5 가이드 참조).
- identity 우회/오표시 1개라도 → `needs-work` + file:line.

---

## Verdict (WP3 결과) — `needs-work` (2 blockers)

sol reviewer Galileo(gpt-5.6-sol priority): 계약 표 6/6 ✓, 82+63 tests pass,
tsc+lint 그린.

### 계약 표 결과

| # | 확인 |
|---|------|
| 1 | ✓ `AddCodexAccountModal.tsx:80-87` — `{id, reauth:true}` 전송 |
| 2 | ✓ pool row에서만 ID 파생 `CodexAccountPool.tsx:319-343`, 404 거부 `auth-api.ts:579-583` |
| 3 | ✓ identity 불일치 → flow error `auth-api.ts:635-670`, GUI 표시 `AddCodexAccountModal.tsx:107-119` |
| 4 | ✓ `&reauth=1` 포함 `AddCodexAccountModal.tsx:101-104`, 단축 억제 `auth-api.ts:774-785` |
| 5 | ✓ OAuth reauth `ProviderAuthPanel.tsx:147-155` → `Providers.tsx:398-405`, 404 `management-api.ts:1247-1260` |
| 6 | ✓ 첫 로그인은 accountId 미전송 `ProviderAuthPanel.tsx:88-91,172-175` |

### P2 블로커 2건

1. **Cross-provider 로그인 레이스** — `oauthLoginGenerationRef`가 글로벌이라
   provider A 로그인 중 B 시작 시 A의 backend flow가 orphan. 크리덴셜이 GUI
   cancel 경로 없이 persistence 가능. `Providers.tsx:74,372-390,408,416-418,913-975`.
   Fix: provider-keyed generation 또는 전역 직렬화+명시적 cancel.

2. **Codex 모달 조기 닫기 시 orphan flow** — `/api/codex-auth/login` 응답 전
   모달 unmount 시 `flowId`가 아직 없어 cleanup 누락. 이후 continuation이
   interval+timeout을 무조건 설치하고 done 분기에 `aliveRef` 가드 없음.
   5분간 stale 콜백 실행 가능. `AddCodexAccountModal.tsx:43-131`.
   Fix: start 요청 abort 또는 resolve 후 alive 체크+flow cancel.

### P3 nit 1건

- `codexAuth.reauthenticate` 키가 ko/zh/de에서 영어 그대로 (`ko.ts:463`,
  `zh.ts:463`, `de.ts:446`).

### Codex identity 테스트 커버리지 잔여 (A-gate fold #4 확인)

`oauth-reauth-bind.test.ts`는 일반 OAuth runLogin identity mismatch만 실행.
Codex auth-api.ts의 chatgptAccountId/pool-email 앵커 3분기(일치/불일치/없음)와
flow-error 전환은 behavior test 미커버. `codex-auth-api.test.ts`의 관련 검사는
source-string assertion. verdict에 잔여 리스크로 기록.
