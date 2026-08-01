# 000 — 버그 묶음 해결 유닛 계획

세션: `019fa53a-5c95-76d1-b616-faab73d044e2`
goalplan: `opencodex-bug-pr-6-7-pabcd-work-phase-wp1-docs-f`
기준: `origin/dev` = `f195e90bc`, 로컬 `dev` = `c17f51659`(미푸시 2건)
작성: 2026-07-28 (WP1 docs-only 사이클)

## 목표

`bug` 라벨이 붙은 열린 PR 6건·이슈 7건 중 **우리가 실제로 닫을 수 있는 것**을
PABCD 다중 사이클로 해결한다. 사용자가 커밋·푸시·머지를 명시 승인했다.

## 선행 조사 (재작성 금지, 참조만)

| 문서 | 내용 |
| --- | --- |
| `260727_owner_decision_ledger/009_ssh_remote_proxy_rootcause.md` | SSH 원격 프록시 근본 원인 — `isLoopbackRequestHost` |
| `260727_owner_decision_ledger/010_bug_bundle_fixability.md` | 버그 13건 해결가능성 전수 판정 |
| `260727_owner_decision_ledger/007_delta_260728.md` | 원장 델타 + Mind 감사 정정 |

두 문서 모두 Mind 감사를 거쳤다. 이 유닛은 재조사하지 않고 **stale check 후 활용**한다.

## 제약

- 브랜치: PR은 `dev` 대상. `main` 직접 변경 금지 (AGENTS.md Branch policy).
- 검증: `bun run typecheck` + 대상 `tests/*.test.ts` 실제 실행 출력.
- 조건부 분기는 C-ACTIVATION-GROUNDING-01 — 분기를 실제로 발화시키는 테스트가
  있어야 하며 "전체 green"은 불충분.
- 프라이버시: `bun run privacy:scan` 초록 유지. 요청 본문·API 키·계정 식별자
  로깅 금지.
- 보존: 로컬 `dev`의 미푸시 커밋 2건(`c17f51659`, `446e27884` star prompt)과
  다른 worktree 10곳의 작업.

## 스코프 밖 (건드리지 않음)

| 항목 | 이유 |
| --- | --- |
| PR #429 | dev가 쓰는 `CODEX_SHELL_*` 심볼을 삭제 — 리베이스가 아니라 재구현 |
| PR #528 | #424 선행 필요 + SSRF급 P1 5건 |
| PR #447 | Kiro 인증 경계 설계급 결함 4건 |
| 이슈 #92 / #241 / #417 | 업스트림 차단 — 우리가 닫을 수 없음 |
| 이슈 #543 / #418 | 리포터 캡처 대기 |

## work-phase 맵 (의존성 순, PHASE-SPLIT-01)

순서는 노력가 아니라 **의존 구조**다. 서버 인증 게이트(WP2)가 가장 아래에
있고, 그 위에 어댑터/응답 계층(WP3·WP4)이 얹히며, PR 정리(WP5·WP6)는 코드
기반이 정리된 뒤에 온다.

| # | decade doc | 대상 | 계층 |
| --- | --- | --- | --- |
| WP2 | `010_ssh_loopback_gate.md` | SSH 원격 프록시 — `auth-cors.ts` | 서버 인증 게이트 (최하부) |
| WP3 | `020_tls_altname_diagnosis.md` | 이슈 #553 — `responses/core.ts` | 응답/오류 계층 |
| ~~WP4~~ | `030_claude_system_dedup.md` | ~~이슈 #545~~ | **A 게이트에서 폐기** |
| WP5 | `040_pr527_rebase.md` | PR #527 리베이스+리타깃 | PR 정리 |
| WP6 | `050_pr557_boundary.md` | PR #557 머지 + #533 클로즈 | PR 정리 |

> **WP4 폐기 (2026-07-28 A 게이트, Critical).** 전제가 반전됐다 —
> `skipSystemPromptPrefix`는 "이미 넣었다"가 아니라 "붙이지 않는다"는 뜻이라
> 제안한 가드는 영원히 발화하지 않는다. 게다가 메인테이너가 이미 아웃바운드
> 캡처를 근거로 "OAuth identity 제거는 안전한 수정이 아니다"라고 판정했다.
> 근거 전문은 `030_claude_system_dedup.md` §폐기 근거. 이슈 #545는 열어둔다.

> goalplan의 wp2~wp6 번호와 decade doc 번호가 1:1 대응한다. 단 goalplan 초기
> 등록 순서(#527 먼저)는 **의존 순서로 재배열**됐다 — 로드맵 락은 이 문서다
> (LOOP-DOCS-FIRST-01: 초기 등록은 스켈레톤, 락은 docs-only D).

### 재배열 이유

초기 등록은 "기계 작업 먼저"라는 노력 기준이었다. PHASE-SPLIT-01은 이를
금지한다. 실제 의존은 이렇다:

- `auth-cors.ts`의 게이트는 `/v1/*` 전 경로가 통과하는 최하부다. 여기가 바뀌면
  그 위 계층의 테스트 전제가 바뀐다.
- `#553`(오류 메시지)과 `#545`(system 블록)는 서로 독립이지만 둘 다 게이트를
  통과한 뒤의 계층이다.
- PR #527/#557은 **우리 코드 변경이 없다**. 다른 사람의 diff를 정리하는
  일이므로 우리 변경이 다 끝난 뒤에 리베이스해야 재작업이 없다.

## 성공 기준

| id | 시나리오 | 증거 |
| --- | --- | --- |
| c1 | 이 유닛에 000 + 모든 decade doc이 diff-level로 존재하고 커밋됨 | `ls` + 커밋 해시 |
| c5 | 포트가 다른 루프백 Host가 게이트를 통과하고 비루프백은 여전히 거부 | 신설 테스트 출력 |
| c3 | `ERR_TLS_CERT_ALTNAME_INVALID`가 별도 메시지 + 복구 명령 | 분기 진입 assertion |
| ~~c4~~ | ~~Claude system 중복 가드~~ | **폐기 — WP4와 함께** |
| c2 | PR #527이 base=dev, mergeable, enforce-target pass | `gh pr view` + `gh pr checks` |
| c6 | PR #557 머지 + #533 클로즈, 또는 NEEDS_HUMAN 기록 | `gh pr view --json state` |

## SoT 동기화 대상 (SOT-SYNC-01)

| 변경 | 패치할 SoT |
| --- | --- |
| WP2 원격 접근 | `docs-site/src/content/docs/reference/configuration.md` "Remote access" 절 |
| WP3 오류 메시지 | 해당 없음 (오류 문자열은 코드가 SoT) |
| WP4 어댑터 | `structure/` 내 anthropic 어댑터 불변식 문서가 있으면 확인 |

## 터미널 판정 기준

- `DONE` — 커밋 + 검증 증거 + 실제 상태 변화(PR 생성/머지, 이슈 클로즈)
- `BLOCKED` — 업스트림/리포터 등 외부 의존
- `NEEDS_HUMAN` — 보안 경계 판단 등 오너만 내릴 수 있는 결정

**WP2와 WP6은 둘 다 `NEEDS_HUMAN` 가능이다.** WP2는 `src/server/auth-cors.ts`가
`.github/CODEOWNERS:13`의 인증 경계라 두 메인테이너 리뷰 대상이고, WP6은
의존성 설치 경계다. 두 경우 모두 PR을 올리는 데까지가 우리 몫이고 머지는
사람의 결정이다 — 회피가 아니라 정책 준수다.

## A 게이트 이력

2026-07-28, 독립 리뷰어 1회 (read-only, 코드베이스 실측).
`VERDICT: GO-WITH-FIXES (blockers=4)`.

| # | 심각도 | 지적 | 처리 |
| --- | --- | --- | --- |
| 1 | Critical | WP4 분기가 도달 불가 + 문자열 불일치 + 메인테이너 기판정 | **WP4 폐기** |
| 2 | High | `ssh -g`/devcontainer 잔여 위험이 009→계획으로 오면서 누락 | `010`에 명시적 수용 위험 절 추가 |
| 3 | High | WP2가 CODEOWNERS 보안 리뷰 경계를 선언하지 않음 | `010` + 이 문서에 `NEEDS_HUMAN` 가능 명시 |
| 4 | High | `OcxConfig` import 경로 오류 (`src/config`는 재export 안 함) | `../src/types`로 수정, `tsc` 실측 확인 |
| 5 | Medium | `NodeJS.ErrnoException` 해석 미보장 | `(err as { code?: unknown }).code`로 교체 |
| 7 | Medium | `1ba588eff` ≡ `9dd3c42da` 동등성이 미증명 | `040`에 `range-diff` 선행 증거 요구 추가 |
| 7b | Medium | #557 "전 매트릭스 초록"이 과장 (8 SUCCESS + 1 null) | `050` 정정 |
| 8 | Medium | WP2의 must-not-break 오라클이 무명 | `server-auth.test.ts:582-602` 명시 |

리뷰어가 확인해준 것: WP3의 세 호출 지점과 오류 도달 경로(Bun 실측), Bun이
생성 `Request`의 `Host` 헤더를 보존한다는 것(WP2 테스트 형태 유효),
`030`의 out-of-scope 판단(vision/web-search 경로)이 옳다는 것.
