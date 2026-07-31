# WP9 — 보안보류 리뷰 게시 + #459 close

선행: WP1–WP8. dev가 최종 상태에 도달한 뒤 실행한다.
이 work-phase는 코드를 바꾸지 않는다. GitHub 상태만 정리한다.

## 1. #459 통합 없이 close

`git merge-tree` 충돌 3파일:

```
src/providers/base-url-choices.ts
src/providers/registry.ts
tests/provider-registry-parity.test.ts
```

세 건 모두 의미 충돌이다. dev는 `alibaba-token-plan`을 Beijing Personal Edition으로
고정하고(`src/providers/registry.ts:813`), `alibaba-token-plan-intl`이 Singapore/국제
라우팅과 override 선택지, 별도 15개 모델 계약을 소유한다(`:839`).
Beijing ID에 `allowBaseUrlOverride: true`를 주면 그 provider의 API 키가 임의 목적지로
나갈 수 있고, 라벨/모델 계약이 실효 endpoint와 어긋난다.

이슈 #457이 말하는 `config.json.bak-before-alibaba-provider-rename-*` 마이그레이션은
이 저장소에 존재하지 않는다. 소유자와 충돌 의미를 특정하기 전에는 추측성
`loadConfig()` 마이그레이션을 작성하지 않는다. 그런 마이그레이션은 API 키,
`defaultProvider`, 라우팅된 모델 참조, `disabledModels`, `providerContextCaps`,
provider 키 풀을 원자적으로 옮겨야 하고 이는 별도 보안 리뷰 대상이다.

close 코멘트 요지:

- dev가 Beijing/International을 의도적으로 분리된 provider 계약으로 모델링한다
- Beijing을 override 가능하게 하면 그 계약이 무너지고 자격증명이 registry 정체성과
  불일치하는 목적지로 갈 수 있다
- #464가 독립적으로 silent-routing 진단을 담당한다
- **이슈 #457은 열어둔다.** PR 본문에 `Fixes #457`이 있지만 실제 마이그레이션
  복구 경로 추적을 위해 유지한다

## 2. 보안보류 — 리뷰만 게시, 병합 금지

실행 중 재분류로 보류 대상이 늘었다.

- **#429 추가 (A-gate 재분류).** 모델이 생성한 인자가 shell 실행 도구로 진입하는
  경계에 검증을 넣는 변경이다. `MAINTAINERS.md:22-23`의 "and other security-boundary
  changes"에 해당하므로 self-merge 대상에서 제외했다. 구현 계약은 020 문서에 완성돼
  있으나, 명시적 보안 리뷰와 사용자 승인 전까지 **열어 둔다.**
- **#466 제외.** 동료가 `d9e5102a`로 직접 머지해 이미 종료됐다.

오늘 이미 상세 리뷰를 게시한 PR은 재게시하지 않는다. 이번 분석에서 **새로 발견된**
결함만 추가로 남긴다.

| PR | 신규 발견 | 조치 |
|---|---|---|
| #355 | `src/server/images.ts:48-165`가 raw 저장 `baseUrl`을 써서 Google OAuth 토큰이 공격자 URL로 갈 수 있음. `guessExtFromMagic()`이 미지 바이트를 `png`로 폴백. `arrayBuffer()` 사후 크기 검사는 OOM 보호가 아님 | 신규 리뷰 게시 |
| #424 | `src/images/plan.ts:39`가 `bridgeEnabled === false`만 차단해 유료 브리지가 기본 ON. raw 저장 xAI destination으로 자격증명 전송 | 신규 리뷰 게시 |
| #408 | `windowsSchedulerTaskInstalled()`가 모든 query 실패를 `false`로 접어 권한 실패를 "작업 없음"으로 오판, 설치 락이 풀림 | 신규 리뷰 게시 |
| #403 | `src/bridge.ts` usage observer 예외 전파, `src/grok/inject.ts` 실패한 정리를 성공으로 보고, `src/cli/index.ts` 일반 stop 실패에도 teardown 진행, `process-control.ts` 충돌은 dev의 포트 회수와 409를 **둘 다** 보존해야 함 | 신규 리뷰 게시 + 4분할 요청 |
| #469 #445 #461 #464 #426 | 오늘 이미 게시 | 재게시 없음 (단 #469는 동료가 머지 완료) |
| #429 | 위 재분류 사유 | 보류 사유를 코멘트로 남기고 열어 둠 |

#403은 본인(lidge-jun) 작성이라 CI 통과와 무관하게 다른 maintainer 승인이 필요하다.

## 3. 이슈 close 대상

**없음.** 열린 이슈 18건 중 dev에서 이미 고쳐졌는데 안 닫힌 건은 0건이다.
#457/#443/#425는 열린 PR이 다루는 중이고, WP1–WP8 통합 대상 가운데
closing keyword를 가진 PR이 없다.

#42는 Phase 1(`src/storage/scanner.ts`, `/api/storage`)만 의도적으로 전달된 상태라
부분 완료이며 close 대상이 아니다.

## 4. 통합 PR close

WP1–WP8에서 dev에 실제로 반영된 PR만 영수증 코멘트와 함께 close한다.

현재 확정된 통합 대상은 #437(완료, `803807a4`), #460, #468, #467, #431, #405이다.
#429는 보안 보류로 빠졌고, #466은 동료가 이미 머지했다.
각 work-phase의 실제 결과에 따라 이 목록은 갱신한다. 코멘트에 포함할 것:

- 통합 커밋 SHA
- 우리가 추가로 고친 결함 목록
- 신규 회귀 테스트 이름
- 전체 게이트 결과
- `Co-authored-by`로 원저작자를 보존했다는 사실

## 검증

```bash
gh pr list --state open --limit 60
gh issue list --state open --limit 60
```

종료 시점에 열린 PR은 보안보류 8건 + 이번에 다루지 않은 건만 남아야 한다.

---

# 실행 영수증

## 통합 (dev push 완료)

| WP | PR | 통합 커밋 | 원저자 | 결과 |
|---|---|---|---|---|
| WP1 | #437 | `803807a4` | CooperSheroy | closed |
| WP3 | #460 | `74ddd96d` | mushikingh | closed |
| WP5 | #468 | `bcaf029e` (후속 테스트) | Wibias | 동료 머지 후 보강 |
| WP7 | #431 | `82a47dbe` | H-H-E | closed |
| WP8 | #405 | `be16c1d8` | HaydernCenterpoint | closed |

WP0 로드맵 `895b0f4f`, WP2 보류 문서 `d6ef2f42`.

## 상황 변경으로 무효화

- **WP4 (#466)** — 동료가 `d9e5102a`로 직접 머지. 우리가 지적한 결함 3·5를
  `971e0564`·`3616d2ae`가 동일 방향으로 해소했다.
- **WP6 (#467)** — 동료가 `5cb3a11f`로 머지. `clientKey` DTO 누출과 dialog dismissal을
  `76a0fc13`이 해소했다.

두 건 모두 우리 분석과 동료 수정이 같은 결론에 도달했다.

## close

- 통합 close 4건: #437 #460 #431 #405
- 통합 없이 close 1건: #459 (설계 충돌, #457은 OPEN 유지)
- 이슈 close: **0건.** dev에서 이미 고쳐졌는데 안 닫힌 이슈가 없었고,
  통합 대상 중 closing keyword를 가진 PR도 없었다.

## 보안 보류 — 리뷰만 게시

| PR | 신규 발견 |
|---|---|
| #429 | shell 실행 도구 입력 경계로 재분류 (WP2에서 게시) |
| #355 | `images.ts:48-165`가 저장 `baseUrl`을 써서 Google OAuth 토큰이 임의 호스트로 전송 가능 |
| #424 | 유료 브리지가 기본 ON(`=== false`만 차단), xAI 자격증명 목적지 미고정 |
| #408 | `windowsSchedulerTaskInstalled()`가 query 실패를 부재로 접어 설치 락이 풀림 |
| #403 | 본인 작성 — 4분할 요청 + 결함 6건. 타 maintainer 승인 필요 |

#469 #445 #461 #464 #426은 이번 배치 전에 이미 상세 리뷰를 게시해 재게시하지 않았다.

## 최종 게이트

```
$ git rev-list --left-right --count dev...origin/dev
0	0
$ bun x tsc --noEmit           (pass)
$ bun run lint:gui             (pass)
$ bun scripts/privacy-scan.ts  Privacy scan passed
```

## 배운 것

A-gate가 매 사이클 3~5라운드를 돌았고, 반복된 근본 원인은 하나였다 —
**계획 문서에 테스트 본문이나 코드를 적을 때 실물 소스를 확인하지 않은 것.**
존재하지 않는 헬퍼(`configWithMiniMax`), 없는 enum 값(`"verified"`),
틀린 파일 경로(`cursor-protobuf.test.ts`), 잘못 인용한 5개 조건 중 2개만 적은 가드가
전부 그렇게 나왔다. "B 단계에서 확인"으로 미룬 항목은 예외 없이 다음 라운드 blocker가 됐다.

가장 값진 감사는 WP3이었다. 리뷰어가 계획의 테스트를 PR head에서 **실제로 실행해**
제안한 분기가 도달조차 못 한다는 것을 밝혔다. truncation sniffer가 switch 이전에
`MAX_TOKENS`를 가로채고 있었다. 그대로 구현했다면 통과하는 테스트와 함께
아무 효과 없는 코드를 머지할 뻔했다.
