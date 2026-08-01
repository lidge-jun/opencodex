# 000 — 리빌딩 유닛 계획

세션: `019fa826-aba9-7032-8b43-9fc0fbcb56f1`
goalplan: `opencodex-pr-devlog-plan-260728-pr-rebuild-unit`
기준: `origin/dev` = `7710185c0`, 로컬 `dev` = `9265d922d` (직전 유닛 문서커밋 1개 앞섬)
작성: 2026-07-28 (WP1 docs-only 사이클)

## 목표

정당한 결함 위에 서 있으나 기여자 PR을 그대로 머지할 수 없는 항목 중, **오너 설계
결정이 필요 없는 것**만 골라 우리가 다시 만든다. 사용자가 커밋·푸시를 명시 승인했다.

## 선별 기준 (4관문 전부 통과해야 대상)

| 관문 | 질문 |
| --- | --- |
| (a) 정당성 | 뒤에 실재하는 결함/이슈가 있는가 |
| (b) 리빌딩 필요 | 그대로 머지 못 하는 이유가 있는가 (CONFLICTING, 스코프 과다, 설계 불일치) |
| (c) 결정 불요 | 동작의 정답이 이미 명확해서 오너 판단이 필요 없는가 |
| (d) 경계 밖 | CODEOWNERS 경로 + MAINTAINERS.md 주제(인증·크리덴셜·Actions·릴리스·의존성) 밖인가 |

## 전수 심사 — 열린 PR 16건

> **A 게이트 정정.** 초안은 `mergeable=MERGEABLE`을 "건강함"으로 읽었다. 그건 머지
> 충돌이 없다는 뜻일 뿐 테스트가 돌았다는 뜻이 아니다. 아래 표는 `mergeStateStatus`와
> **실제 체크 롤업 내용**을 기준으로 다시 썼다.

| # | (a) | (b) | (c) | (d) | 판정 |
| --- | --- | --- | --- | --- | --- |
| 613 reset credit 만료시각 | ✅ | ❌ 저자 활발, 소품 5f | — | ✅ | 리뷰 대기 — **CI 미실행** |
| 611 Volcengine 프로바이더 | ✅ | ❌ | ❌ 채택 기준=오너 정책 | ✅ | 오너 결정 |
| 610 catalog probe 캐시 | ✅ #606 | ❌ P1을 저자가 `056aa2d6e`에서 해결 | — | ✅ | 리뷰 대기 — **CI 미실행** |
| 607 GUI chrome polish (draft) | ✅ | ❌ draft, 저자 작업중 | ❌ 시각 판단 | ✅ | 저자 진행 |
| 599 Spark 쿨다운 스코프 | ✅ #590 | ❌ | — | ❌ **`src/codex/auth-context.ts` = CODEOWNERS 인증 경로** | 보안 리뷰 필요 |
| 583 agent guidance 문서 | ✅ | ❌ CLEAN | ❌ 정책 문구 | ✅ | 오너 결정 |
| 582 Grok video bridge (draft) | ✅ | ❌ draft | ❌ 표면 확장 | ✅ | 오너 결정 |
| 581 zh-TW 로케일 | ✅ | ✅ CONFLICTING 57f | ❌ 로케일 채택=오너 정책 | ✅ | 오너 결정 |
| **576 stale app-server 경고** | ✅ | ✅ CONFLICTING + windows fail | ✅ 우리가 쓴 PR, 동작 확정 | ✅ | **대상 WP4** |
| 575 TLS altname 진단 | ✅ #553 | ❌ CLEAN, 우리 PR | — | ✅ | 머지 대기 |
| 569 /readyz 준비성 (draft) | ✅ | ✅ CONFLICTING | ❌ liveness/readiness 계약=설계 | ✅ | 오너 결정 |
| 565 계정 pause 정책 | ✅ | ✅ CONFLICTING 35f | ❌ 계정 정책=오너 | ✅ | 오너 결정 |
| 562 Modelsell 프리셋 | ✅ | ❌ draft | ❌ 채택 기준 | ✅ | 오너 결정 |
| 557 npm 캐시 복구 (draft) | ✅ | ✅ CONFLICTING | ❌ | ❌ **의존성 설치 경계** | 오너 결정 |
| 533 npm 캐시 원본 (draft) | ✅ | ✅ CONFLICTING | ❌ | ❌ 동일 경계 | 오너 결정 |
| 512 계정 네임스페이스 | ✅ #425 | ❌ CLEAN | ❌ 스키마 설계 | ✅ | 오너 결정 |

### CI 신호가 없는 PR 3건 (#613, #610, #599)

셋 다 `mergeStateStatus=UNSTABLE`이고 체크 롤업에 `enforce-target`/`label`/CodeRabbit만
있다. 전체 매트릭스(`windows-latest`, `ubuntu-latest`, `macos-latest`, `npm-global ×3`,
`linux-systemd`, `macos-launchd`, `windows-schtasks`)를 도는 #575와 대조된다.
포크 PR의 워크플로가 `action_required`로 승인 대기 중이기 때문이다.

**머지 판단 전에 워크플로 승인이 선행돼야 한다.** 특히 #599는 +1109/-130, 11파일이
`src/codex/routing.ts`와 `src/server/responses/core.ts`를 건드리는데 CI 증거가 0이다.

### WP2가 `dev`의 결함이 된 경위 (A 게이트 2라운드)

1라운드에서 리뷰어가 #610의 미해결 P1을 찾아냈다. 2라운드에서 같은 리뷰어가 그
P1이 **이미 저자에 의해 해결됐음**을 확인했다 — `056aa2d6e` "fix(test): address
runtime cache review feedback", 09:16 KST. GitHub UI가 미해결로 보이는 건 resolve
버튼을 누른 사람이 없어서다.

그런데 저자는 자기가 손댄 테스트만 고쳤다. 같은 결함 패턴이
`origin/dev:tests/codex-runtime.test.ts:360`과 `pull/610/head:514`에 남아 있다.
이건 `dev`에 원래 있던 것이고 #610이 만든 게 아니다.

그래서 WP2의 대상은 **PR이 아니라 `dev` 자신**이다. 4관문으로 보면: (a) `PATH=""`에서
런처가 exit 127로 죽는 실재 결함, (b) 이 결함에 대응하는 PR이 아예 없어 우리가 쓸 수밖에
없음, (c) 정답이 명확(셸 빌트인 사용 — 저자가 이미 CI로 검증한 형태), (d) `tests/`는
기본 리뷰어 범위.

**대상 2건: `dev` 런처 결함(WP2), #576(WP4).** WP3는 심사 중 발견한 별개 테스트 결함이다.
나머지 15건은 (b)·(c)·(d) 중 하나에서 탈락한다.

### #576이 4관문을 통과하는 이유

- (a) `codex/app-server-processes.ts` — 카탈로그 기록 후 stale app-server를 경고하지
  않으면 사용자가 옛 모델 목록을 계속 본다. 이슈 #241 계열의 실사용 불편.
- (b) `origin/dev`와 **3파일 로직 충돌** — `src/cli/index.ts`,
  `src/server/management/config-routes.ts`,
  `gui/src/pages/dashboard-overview-sections.tsx`. 헝크 단위 해소가 필요하다
  (상세는 `030`). 더해 windows-latest 체크가 실패 중이다.
- (c) 우리가 직접 쓴 PR이고 동작은 이미 리뷰로 확정됐다. 새 결정이 없다.
- (d) `src/codex/`, `src/cli/`, `gui/`, `docs-site/` — 전부 기본 리뷰어 범위.

## work-phase 맵 (의존 순, PHASE-SPLIT-01)

테스트 안정성이 먼저다. #576의 windows 실패가 무관한 테스트 결함이라면, 그것을 먼저
고쳐야 리베이스 결과의 CI 신호를 믿을 수 있다.

| # | decade doc | 대상 | 계층 |
| --- | --- | --- | --- |
| WP1 | 이 문서 | 심사 + 로드맵 락 | docs-only |
| WP2 | `010_pr610_posix_launcher.md` | #610 P1 — POSIX 런처 `PATH` | 테스트 기반 (최하부) |
| WP3 | `020_usage_debug_flake.md` | `tests/usage-debug.test.ts` Windows 타임아웃 | 테스트 기반 |
| WP4 | `030_pr576_rebase.md` | #576 리베이스 + 푸시 | PR 정리 (최상부) |

WP2·WP3가 먼저인 이유는 둘 다 **CI 신호의 신뢰성**을 다루기 때문이다. 테스트가
환경 의존적으로 깨지는 상태에서 리베이스하면, 그 결과의 빨간불이 리베이스 탓인지
기존 결함 탓인지 구분할 수 없다.

## 제약

- 브랜치: `dev` 대상 PR만. `main` 직접 변경·force push 금지.
- 검증: `bun run typecheck` + 대상 `tests/*.test.ts` 실제 출력.
- 푸시: 사용자 승인 범위 = 이 유닛의 작업. 타인 브랜치 푸시 금지.
- 보존: 다른 worktree 11곳, 로컬 미푸시 커밋.

## 성공 기준

| id | 시나리오 | 증거 |
| --- | --- | --- |
| c1 | 이 유닛에 000 + 010 + 020 + 030이 존재하고 커밋됨 | `ls` + 커밋 해시 |
| c2 | 수정 **전**에 런처가 exit 127 + `dirname: No such file or directory`를 내는 것이 캡처되고, 수정 **후**에는 사라지며, 그 차이를 잡아내도록 강화된 단정이 통과한다 | 전후 stderr 캡처 + `bun test tests/codex-runtime.test.ts` 출력 |
| c3 | usage-debug 테스트가 결정적으로 통과하고 회전 계약 불변 | `bun test tests/usage-debug.test.ts` 출력 |
| c4 | typecheck + GUI 빌드 통과 | `bun run typecheck` / `bun run build:gui` 출력 |
| c5 | #576이 MERGEABLE로 갱신되고 푸시됨 | `gh pr view 576 --json mergeable` |
| c6 | 원 PR에 리빌딩 내역 코멘트 | 코멘트 URL |

## 터미널 판정 기준

- `DONE` — 커밋 + 검증 출력 + 푸시 + PR 상태 변화
- `BLOCKED` — CI 인프라/업스트림 외부 의존
- `NEEDS_HUMAN` — 진행 중 오너 설계 결정이 드러난 경우 그 항목만 중단
