# 000 — 다음 배포 전 블로커: 목표, 제약, 작업 순서

기준 커밋: `origin/dev = 0666b4169`, `main = d1f544bbc (v2.7.43)`.
선행 조사: `devlog/_fin/260730_issue_triage_dev_head/000_triage_matrix.md`.

## 목표

2026-07-30 트리아지에서 BLOCKER로 판정된 7건 중, 한 파일 50줄 이내로 끝나는 두 건을
먼저 dev에 올린다. 나머지 다섯 건(#724 #702 #719 #658 #733)은 M 사이즈로, 이 유닛의
범위 밖이다. 절반만 올리는 것보다 손대지 않는 게 낫다.

| 이슈 | 한 줄 요약 | 작업 단계 |
|---|---|---|
| #701 | `ocx claude`가 프로젝트 dotenv의 `ANTHROPIC_API_KEY`를 구독 인증 위에 덮어씀 | `010` |
| #688 | web-search 이어받기가 `reasoning_raw_delta`를 버려 DeepSeek V4가 실패 | `020` |
| 정리 | dev 푸시, 이미 고쳐진 이슈 닫기, PR 처분 기록 | `030` |

## 왜 이 순서인가

의존 순서다. 효율이나 난이도 기준이 아니다.

`010`은 인증 경계다. 사용자가 구독 요금제를 쓰는데 API 과금 경로로 조용히 넘어가는
문제라, 잘못 고치면 돈이 나간다. 다른 작업과 파일이 겹치지 않아 먼저 독립적으로
검증할 수 있다.

`020`은 스트리밍 리플레이 경계다. `src/web-search/loop.ts` 하나만 만지고 `010`과 파일이
겹치지 않는다. 순서를 바꿔도 상관없지만, `010`의 위험도가 높아 먼저 끝내고 넘어간다.

`030`은 앞의 둘이 커밋된 뒤에만 의미가 있다. 푸시 게이트가 두 변경을 함께 검증하고,
이슈 닫기는 커밋이 `origin/dev`의 조상임을 확인한 다음에만 정당하다.

## 제약

`prepush` 훅이 전체 게이트를 돌린다: `typecheck && lint:gui && test && privacy:scan &&
doctor:gui:if-changed`. 푸시 한 번에 4분쯤 걸린다. `--no-verify`는 쓰지 않는다. 게이트가
막으면 게이트를 통과시키는 게 일이다.

`devlog/`는 비공개 서브모듈(`lidge-jun/opencodex-internal`)이다. 서브모듈에 먼저 커밋하고
푸시한 다음, 부모 저장소의 gitlink을 별도 커밋으로 올린다. 순서가 뒤집히면 공개된
포인터가 존재하지 않는 커밋을 가리킨다.

Jun이 같은 트리에서 동시에 작업한다. 그의 더티 파일은 보존하고, force-push는 하지
않는다. 푸시가 경합하면 rebase한다.

테스트는 각 단계에서 반증 가능해야 한다. `git stash push -- <소스파일>`로 수정을 빼고
돌려서 **실패하는 것을 확인**한 뒤 `git stash pop`으로 되돌린다. 통과만 확인한 테스트는
아무것도 증명하지 않는다.

## 범위 밖

PR #707은 인증·GitHub Actions 경계를 건드려 `MAINTAINERS.md`가 요구하는 명시적 보안
리뷰 대상이다. 손대지 않는다.

`dev` → `main` 승격, 릴리스 컷은 하지 않는다.

보안 취약점 서술은 `devlog/`에 쓰지 않는다(`AGENTS.md`). 스크래치 공간만 쓴다.

## 조사에서 확정된 사실

두 건 모두 Sol 서브에이전트 두 대를 병렬로 파견해 조사하고, 결정적 사실은 직접 재확인했다.

**#688의 "502"는 실제로는 DeepSeek의 400이다.** `prepareIterationEvents()`가
`LoopError(400, ...)`을 만들지만(`src/web-search/loop.ts:321`), 2회차 이후에는 이미 SSE가
열려 있어 예외가 어댑터 error 이벤트로 변환되면서 `LoopError.status`가 버려진다
(`loop.ts:564`). 상태 코드가 없으니 `adapterFailureFromMessage()`가 메시지로 추론하는데
`"Provider error 400"` 접두사를 인식하는 recognizer가 없어 기본값 502로 떨어진다
(`src/lib/errors.ts:265`). 이슈 제목의 502는 프록시의 표현이고 업스트림 거절은 400이다.
이 유닛은 400→502 오분류까지 고치지 않는다. 리플레이가 성공하면 에러 자체가 사라지고,
상태 코드 전파는 별개 표면이다. `020`에 별도 관찰로 남긴다.

**#701의 provenance는 런처 경계에서 복구 가능하다.** 직접 측정했다:

```
node sees:                [undefined]
bun default sees:         [from-dotenv]
bun --no-env-file sees:   [undefined]
bun --no-env-file+export: [real-export]
```

`bin/ocx.mjs`는 Node로 실행되므로 dotenv를 보지 못하고, 자식 Bun만 본다. 즉 "사용자가
진짜 export한 값"과 "프로젝트 dotenv 오염"은 런처 시점에는 구분 가능하다. 그럼에도
`010`은 런처 플래그를 쓰지 않는다. 이유는 `010`에 적었다.

## 성공 기준

단계마다 `bun run typecheck` 통과, `bun run test` 통과(0 fail), 반증 증명이 붙은 회귀
테스트, 그리고 커밋. 마지막에 전체 게이트를 통과한 `origin/dev` 푸시.
