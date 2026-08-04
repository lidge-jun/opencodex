# 260726 PR close/rework 로드맵

기준점: `dev = origin/dev = 8756daa5`. 워크트리 `/Users/jun/.codex/worktrees/ebcd/opencodex`.
분석 스냅샷: 2026-07-26 09:00 KST. sol medium 3기 병렬 파견으로 열린 PR 17건과 열린 이슈 18건을 전수 대조했다.

조사 근거와 외부 원문 확인 결과는 [`001_research_pr_inventory.md`](./001_research_pr_inventory.md)에 분리했다.
이 문서와 010~090은 구현 지시만 담는다.

## 목표

열린 PR을 maintainer가 직접 rework해 dev에 통합하고, 통합된 PR과 그 PR이 닫는 이슈를
근거와 함께 close한다. 각 work-phase는 decade 문서 하나를 소비하는 완전한 PABCD 사이클이다.

## 분류 결과

`MAINTAINERS.md`의 보안 경계(인증/자격증명/OAuth/워크플로/릴리스 자동화) 규칙을 적용해
열린 PR을 세 갈래로 나눴다.

### A. 직접 통합 가능 (self-merge)

| PR | 원저자 | 내용 | 선행 |
|---|---|---|---|
| #437 | CooperSheroy | Bun 요구사항 문서화 (docs-only) | 없음 |
| #460 | mushikingh | Kiro native END_TURN + Opus 5 effort | 없음 |
| #468 | Wibias | Startup/Debug/Storage/Usage 정리 | #466 |
| #467 | Wibias | Combos 분할 | 없음 |
| #431 | H-H-E | MiniMax split reasoning (축소 슬라이스) | 없음 |
| #405 | HaydernCenterpoint | free-provider 디렉터리 (메타데이터 모듈만) | 없음 |

### B. 보안 리뷰 필요 — 직접 병합 금지, 리뷰만 게시

| PR | 경계 |
|---|---|
| #469 / #445 | OpenAI provider 재활성 게이트 (자격증명 목적지) |
| #461 | 사용자 config 복제 → 비밀 중복 |
| #464 | 자격증명 로깅/리댁션 |
| #426 | 계정→모델 자격증명 라우팅 |
| #355 | Google Antigravity OAuth 토큰 전송 |
| #424 | xAI OAuth + 유료 호출 |
| #408 | Windows UAC 권한 상승 |
| #403 | config 소유권 + lifecycle teardown (본인 작성 → 타 maintainer 승인 필요) |
| #429 | shell-tool 입력 경계 하드닝 (A-gate 재분류, 아래 참조) |

### 실행 중 발생한 분류 변경

**#466 — OBSOLETE.** WP1 push 시점에 동료가 `d9e5102a`로 직접 머지했다.
우리 040 문서가 지적한 결함 3(폴링 abort)·5(캐시 미제거)는 동료 커밋
`971e0564`·`3616d2ae`가 같은 방향으로 해소했고, 우리가 보안 사유로 제외했던
`gui/src/api.ts`도 `afc99ec6`·`138751f7`로 별도 처리됐다. WP4는 수행하지 않는다.
WP5(#468)는 선행이 이미 dev에 있으므로 현재 dev 소스 기준으로 델타를 재계산한다.

**#429 — self-merge → 보안 보류.** A-gate 리뷰어가 `MAINTAINERS.md:22-23`의
"and other security-boundary changes"를 근거로 재분류를 요구했고 이를 수용했다.
이 변경이 검증을 넣는 지점은 모델 생성 인자가 shell 실행 도구로 진입하는 경계다.
방향이 하드닝이라도 경계는 경계다. 구현 계약(020 문서)은 완성해 두되 병합은
사용자 승인 후로 미룬다.

### C. 통합 없이 close

| PR | 사유 |
|---|---|
| #459 | dev의 2-provider 분리 설계와 정면 충돌. Beijing provider를 override 가능하게 만들면 자격증명이 registry 정체성과 불일치하는 목적지로 나간다. |

### 이슈 인벤토리 결론

열린 이슈 18건 중 **dev에서 이미 고쳐졌는데 안 닫힌 것은 0건**이다.
#457/#443/#425 세 건은 열린 PR이 다루는 중이고, 나머지 15건은 실제 미구현이다.
따라서 이번 루프에서 이슈 close는 통합 PR이 실제로 닫는 건에 한정한다.
통합 대상 중 closing keyword를 가진 PR은 없으므로, 이슈 close 대상은 현재 없다.

최초 self-merge 분류는 8건이었으나 실행 중 두 건이 빠졌다(#466 동료 머지, #429 보안
재분류). 현재 대상은 6건이다: #437(완료) #460 #468 #467 #431 #405.

## work-phase 맵 (의존성 순서)

PHASE-SPLIT-01에 따라 공수가 아니라 의존 구조로 나눴다. 기반(문서/계약) → 코어 런타임 →
GUI 기반 → GUI 소비자 순이다.

| WP | decade 문서 | 대상 | 의존 |
|---|---|---|---|
| WP0 | 000 | 로드맵 (이 문서) | — |
| WP1 | 010 | #437 docs-only | — |
| WP2 | 020 | #429 Cursor 계약 | — |
| WP3 | 030 | #460 Kiro stop reason | — |
| WP4 | 040 | #466 GUI 공용 기반 | — |
| WP5 | 050 | #468 GUI 페이지 정리 | WP4 |
| WP6 | 060 | #467 Combos 분할 | — |
| WP7 | 070 | #431 MiniMax 축소 슬라이스 | — |
| WP8 | 080 | #405 메타데이터 모듈만 | **WP7** |
| WP9 | 090 | 보안보류 리뷰 게시 + #459 close | WP1–WP8 |

WP8의 WP7 의존은 A-gate에서 발견됐다. 둘 다 `tests/provider-registry-parity.test.ts`를
수정하고, WP7이 바꾸는 `src/providers/registry.ts`의 불변조건을 WP8이 잠근다.

## 공통 수용 기준

각 구현 work-phase는 다음을 모두 만족해야 D로 닫힌다.

1. **B 단계 첫 동작으로 `PRE_APPLY_HEAD` 재확인** — `gh pr view <n> --json headRefOid`로
   그 시점 head를 다시 읽고, 문서의 before 블록이 아직 살아있는지 하나씩 대조한다.
   이미 고쳐진 항목은 건너뛰고 문서에 기록한다.
2. decade 문서의 before/after를 실제 코드에 반영
3. 신규 회귀 테스트가 수정 전 실패 / 수정 후 통과 (RED→GREEN 증거 제시)
4. `bun run typecheck` 통과
5. 해당 영역 `bun test` 통과 출력 첨부
6. `Co-authored-by`로 원저자 보존한 커밋
7. dev push 후 대상 PR을 영수증 코멘트와 함께 close

## A-gate blocker 반영 기록

독립 리뷰어 1라운드 판정 `FAIL`, blocker 9건. 전량 문서에 반영했다.

| # | 심각도 | 내용 | 반영 위치 |
|---|---|---|---|
| 1 | High | WP1 테스트가 GREEN 불가 (README 줄바꿈/문구 불일치) | 010 회귀 테스트 재작성 |
| 2 | High | WP4가 이동한 head 기준 (`9c7e922e`→`7b0bcda7`) | 040 PRE_APPLY_HEAD 규칙 |
| 3 | High | WP5 테스트가 미정의 헬퍼 3종 참조, 컴파일 불가 | 050 전체 파일 계약 확정 |
| 4 | Medium | WP4가 비동기 계약 7개 중 1개만 테스트 | 040 추가 케이스 6종 |
| 5 | Medium | WP6 테스트가 TargetEditor 경로 미검증 | 060 컴포넌트 테스트 추가 |
| 6 | Medium | WP7 RED 근거가 사실과 다름 | 070 근거 정정 + 요청 게이트 테스트 |
| 7 | Medium | WP8이 근거 없는 균일 검증일자를 반입 | 080 lastVerified 정정 규칙 |
| 8 | Medium | WP7/WP8 의존 누락 | 000 의존 표 + 080 선행 명시 |
| 9 | Medium | 연구/구현 혼재, WP5가 개요 수준 | 001 연구 문서 신설 + 050 확장 |

리뷰어가 blocker 없다고 확인한 부분: WP2/WP3 분기 도달 가능성, 범위 제외 후
잔여 import 무결성, self-merge 집합의 보안 경계 미침범, 파일명 규칙.

## A-gate 라운드2 blocker 반영 기록

2라운드 판정도 `FAIL`, blocker 7건. 근본 원인은 하나다 — **테스트 헬퍼와 타입을
실제 소스 확인 없이 썼다.** 이번엔 전부 `git show`로 실물을 읽고 고쳤다.

| # | 심각도 | 내용 | 반영 |
|---|---|---|---|
| 1 | High | `PRE_APPLY_HEAD`를 기록만 하고 움직이는 ref에 적용 | 040: fetch 선행 + `rev-parse` 동일성 단언 + 모든 명령에 SHA 직접 사용 |
| 2 | Medium | falsy 테스트가 loader 호출을 봤지만 실제 영향은 `loading` | 040: 구독 유지 상태에서 falsy 스냅샷 가시성 관찰로 교체 |
| 3 | High | WP5의 Storage/Usage가 "동일 구조"로만 서술됨 | 050: 두 본문 전량 작성, Usage는 요청 수 하한 비교 |
| 4 | High | `TargetEditor` props/셀렉터가 실제와 불일치 | 060: `strategy` 필수, 객체형 props, `select[aria-label]` + `change` 이벤트 |
| 5 | High | `configWithMiniMax`/`parsedWith`는 존재하지 않는 헬퍼 | 070: 실제 `minimaxRoute()`/`body()` 기반으로 재작성 |
| 6 | High | `verification`에 `"verified"` 값이 없음 (TS2367) | 080: 실제 union `official/primary/unverified`로 규칙 재정의 |
| 7 | Medium | provenance 드롭 규칙과 `qoder` 유지 요구가 충돌 | 080: 드롭 대신 `unverified` 강등, `documentationUrl`을 provenance로 승격 |

추가 지적(WP1 `git stash`가 무관한 더티 작업을 삼킴)도 경로 한정 역적용으로 교체했다.

교훈: 계획 문서에 테스트 본문을 적을 때는 반드시 대상 파일의 기존 헬퍼와 타입 정의를
먼저 읽는다. "B 단계에서 확인"으로 미루면 그게 그대로 다음 라운드의 blocker가 된다.

## 범위 경계

IN: `src/**`, `gui/src/**`, `gui/tests/**`, `tests/**`, `docs-site/src/content/docs/**`,
`CONTRIBUTING.md`, `README.md`, `devlog/_plan/260726_pr_close_rework/**`.

OUT: `.github/workflows/**`, `scripts/release.ts`, `package.json` version, main/preview 승격,
신규 의존성. 보안 경계 PR의 코드 변경.

## 리스크

- #466의 `gui/src/api.ts`는 자격증명 보관을 `sessionStorage`에서 모듈 메모리로 바꾼다.
  이 파일을 통합하면 보안 리뷰 대상이 되므로 **반드시 제외**한다. #467/#468은 이 파일에
  의존하지 않는다.
- #405의 registry 병합 훅은 `qoder` 같은 디렉터리 ID를 canonical runtime ID로 만들어
  사용자 정의 provider를 덮어쓴다. 메타데이터 모듈만 취한다.
- #431의 OAuth/login-cli/auth-cors 전파 훅은 런타임 동작에 불필요하므로 제외한다.
