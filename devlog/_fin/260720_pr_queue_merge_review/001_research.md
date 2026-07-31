# 001 — PR 큐 리서치 (1차 트리아지 확정분)

## 큐 스냅샷 (2026-07-20 08:00 KST, `gh pr list`)

| PR | 저자 | 변경 | CI 상태 | 비고 |
|----|------|------|---------|------|
| #173 storage diagnostics | Chang-Jin-Lee (fork, 첫 기여) | +869/-3, 12f | **체크 없음** (워크플로 승인 필요) | issue #42 Phase 1, 계획서 21/31-33 준수 주장 |
| #172 react-doctor CI fix | Wibias (fork) | +27/-13, 5f | **전부 그린** (react-doctor 포함) | 다른 PR의 CI 실패 원인 수정 |
| #171 reauth OAuth/Codex | Wibias (fork) | +1168/-151, 29f | react-doctor FAIL(인프라), 나머지 그린 | #169와 3파일 충돌 |
| #170 stall timeout 300s | Wibias (fork) | +66/-21, 14f | react-doctor FAIL(인프라), 나머지 그린 | Kimi k3 ~105s 무음 쓰기 502 사례 |
| #169 providers follow-up | Wibias (fork) | +1005/-233, 21f | react-doctor FAIL(인프라)×2, 나머지 그린 | #139 리빌드 후속 복구 |
| #150 (draft) | codex 봇 브랜치 | — | — | 5h quota 롤백 세이프티넷, 이번 스코프 아님 |

## CI 실패 분석 (확정)

- #169/#170/#171의 react-doctor 실패는 **전부 같은 인프라 버그**: 구 액션
  v2.1.0이 CLI 0.7.8의 `schemaVersion: 3` 리포트를 거부해 `SCAN_STATUS=1`
  강제 종료 (`exit "${SCAN_STATUS:-1}"`, run 29722659296 로그). 실제 지적
  사항이 아니다.
- #172가 정확히 이 버그를 고친다: `pull-requests: read` 추가(fork PR에서
  PR 파일 목록 조회 실패 → changed-files ENOENT) + 액션 v2.2.7 범프.
- 액션 핀 검증: v2.2.7 annotated 태그(964622bf…)의 커밋이 PR이 핀한
  `938008119a288f2fb47c66a69cd9279a21f31784`와 일치 (`gh api
  repos/millionco/react-doctor/git/tags/964622bf…`).
- #172 자체 런에서 react-doctor 그린 → 수정 유효성 CI 입증.
- main은 branch protection 없음(404) — 머지 게이트는 관례상 CI 그린.

## 1차 트리아지 발견사항 (이미 확보한 증거)

- **#170**: `src/stall-timeout.ts` 신설로 기본값 중앙화. 구 코드는
  `Math.max(1, NaN)` → NaN → 워치독 묵묵히 비활성화. 신 코드는 non-finite를
  300으로 폴백(하드닝). web-search 마진 산수 330 = max(300,…)+30으로 갱신.
  부수효과: 소규모 유닛 버짓 조합의 stall 하한이 120s → 330s로 상승(의도된
  기본값 변경의 귀결).
- **#171 백엔드**: reauth는 configured pool account만 허용(404), identity
  앵커(chatgptAccountId → pool email 순) 대조, 앵커 없으면 fail-closed 거부,
  collision 체크 자기 자신 제외, `login-status`에서 `reauth=1`이면
  "credential 존재=성공" 단축 폐기. GUI(`AddCodexAccountModal`)가
  `{id, reauth:true}` + `&reauth=1` 폴로 계약 일치.
- **#169 백엔드**: `src/codex/catalog.ts` 6줄 — OAuth 토큰 없음(미로그인/
  needsReauth) 시 빈 배열 대신 configured 카탈로그 반환(Cursor 경로와 동일
  저하). 나머지는 GUI.
- **#173 스캐너**: 계획서 21/31과 버킷 키/envelope/newest-versioned-DB 규칙
  일치. 테이블명 하드코딩(`threads`/`logs`)은 실기 `state_5.sqlite`/
  `logs_2.sqlite`와 일치 확인. read-only 불변식을 mtime+inode 스냅샷으로
  테스트. 커밋 Co-Author: Claude Fable 5.

## 충돌 지도 (git merge-tree 확정)

#169 × #171: **content conflict 3파일** —
`gui/src/components/provider-workspace/ProviderOverviewDashboard.tsx`,
`gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx`,
`gui/src/pages/Providers.tsx`.
i18n 4파일(de/en/ko/zh)과 `catalog.ts`, CSS 2파일은 auto-merge 가능.
#173은 `App.tsx`+i18n만 건드려 위 둘과 독립. #171/#173 둘 다
`src/server/management-api.ts`를 만지지만 영역이 달라 충돌 없음( import
부근 인접 변경뿐).

## 오픈 퀘스천 → 어느 WP에서 닫는가

- #171 GUI 잔여 hunks(CodexAccountPool/ProviderAuthPanel/Providers.tsx 등
  ~1400라인)의 UX/상태 버그 유무 → WP3.
- #169 GUI ~1000라인의 회귀 복구 완전성(특히 hash↔preference sync) → WP2.
- #173 GUI Storage.tsx 품질 + 미검증 "3142 테스트 통과" 주장 + CI 없는 상태의
  병합 리스크 → WP4.
- #169 먼저 머지 시 #171 리베이스의 실제 충돌 해소 난이도 → WP5.
- #170의 330s 하한 상승이 web-search 행 동작에 미치는 영향 재확인 → WP1.
