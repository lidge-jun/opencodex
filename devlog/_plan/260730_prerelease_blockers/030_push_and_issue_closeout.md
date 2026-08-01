# 030 — dev 푸시와 이슈·PR 정리

앞의 두 단계가 커밋된 뒤에만 실행한다.

## 순서

서브모듈 먼저다. 순서가 뒤집히면 공개된 gitlink이 존재하지 않는 커밋을 가리킨다.

```
git -C devlog add _plan/260730_prerelease_blockers
git -C devlog commit -m "docs(plan): pre-release blocker unit for #701 and #688"
git -C devlog push
# 그 다음에야 부모의 gitlink
git add devlog
git commit -m "chore(devlog): advance the plan submodule"
```

푸시는 `prepush` 훅을 켠 채로 한다. `typecheck && lint:gui && test && privacy:scan &&
doctor:gui:if-changed`가 전부 돌아 4분쯤 걸린다. `--no-verify`는 쓰지 않는다.

현재 브랜치는 `codex/260730-ci-windows-timeout`이고 `origin/dev`와 동기화돼 있다.
Jun은 얼티밋 메인테이너라 PR 없이 `dev`에 직접 올린다.

```
git push origin HEAD:dev
```

푸시가 경합하면 `git pull --rebase origin dev` 후 재시도한다. force-push는 하지 않는다.

푸시 후 CI는 보지 않는다(사용자 상시 지시).

## 닫을 이슈

### #570 — 닫지 않는다 (wp3 감사에서 정정)

초안은 "이미 고쳐져 배포됐으니 닫는다"고 적었다. **틀렸다.**

`e2da6f6df fix(server): treat forwarded loopback ports as loopback`이 포트 대신 loopback
hostname만 검사하도록 바꾼 것은 맞고, `origin/dev`·`origin/main` 양쪽 조상이며 v2.7.43로
배포됐다. 회귀 테스트도 `tests/server-loopback-host-gate.test.ts:73`에 있다.

그런데 이슈의 마지막 코멘트가 **owner 본인의 상태 업데이트**이고, 제목이
"items 1(a) and 2 are merged; 3, 4, 5, 6 remain open"이다. 본문에 "Leaving this open,
because only part of the plan in this issue has shipped"라고 명시돼 있다.

즉 `e2da6f6df`는 6개 항목 중 1(a)와 2만 해소했다. 남은 것:

- item 4 — hostname alias는 여전히 거절된다
- loopback 인증·allowlist 정책 미결정
- forwarded base-URL 보고 미해결

포트 remap 하위 시나리오가 고쳐졌다는 사실을 이슈 전체가 끝났다는 근거로 쓸 수 없다.
**열어둔다.** 남은 항목을 별개 이슈로 쪼개는 것은 owner 판단 사항이라 이 유닛에서
하지 않는다.

### #701, #688 — 이번에 고침

각 커밋이 `origin/dev`의 조상임을 `git merge-base --is-ancestor <sha> origin/dev`로
확인한 **뒤에만** 닫는다. 기억으로 닫지 않는다. 푸시 전에는 둘 다 조상이 아닌 것이
정상이다.

코멘트에는 커밋 SHA, 바뀐 파일:줄, 회귀 테스트 이름, 그리고 회피 경로가 있었다면 그것도
적는다. #701은 auto 모드 동작이 유지된다는 점을 명시한다 — 신고자가 아닌 다른 사용자가
dotenv API 키를 쓰고 있을 수 있다. 셸 export는 모든 auth 모드에서 계속 이긴다는 것도
적는다.

**#688 코멘트에는 잔여 사항을 명시한다** (wp3 감사 지적). 리플레이는 고쳤지만
`src/web-search/loop.ts`가 2회차 이후 `LoopError`를 상태 없이 error 이벤트로 바꾸는
문제는 그대로다. #688의 재현 경로는 업스트림 400 자체가 발생하지 않으므로 해소되지만,
**무관한 후속 프로바이더 실패의 상태 전파는 별개 작업**이라고 코멘트에 쓴다. 고친 것보다
많이 고쳤다고 주장하지 않는다.

## PR 처분

| PR | 처분 |
|---|---|
| #610 | #606을 실제로 해소한다. head `056aa2d6`는 현재 dev의 조상이 **아니다**. 머지하면 #606이 함께 닫힌다. 별도 결정 사항으로 남긴다 — 이 유닛에서 자동 머지하지 않는다. |
| #616 | hosted image tool preference 버그 수정. 공유 경로라 전체 스위트 필요. |
| #707 | 손대지 않는다. 인증·GitHub Actions 경계로 `MAINTAINERS.md`가 명시적 보안 리뷰를 요구한다. |

READY PR 8개 전부 격리 bare repo `merge-tree --write-tree`에서 현재 dev에 clean하게
올라간다. #671과 #715는 `src/codex/routing.ts`를 함께 건드려 순서가 있다.

## 릴리스 장부 (기록용, 이번에 실행 안 함)

`dev`의 `package.json`은 2.7.41, `main`은 2.7.43이다. merge-base 이후 main-only 변경은
이 한 줄뿐이다.

앞선 판단을 정정한다. `scripts/release.ts`는 다음 버전을 **계산하지 않는다**. 버전은
CLI 첫 인자여야 하고(`scripts/release.ts:220`), `dev`에서는 `main`/`preview`만 허용하는
검사에서 즉시 중단된다(`:227`). npm·원격 태그·GitHub Release 조회는 사용자가 지정한
버전의 중복을 막는 preflight다(`:105`, `:256`). 따라서 2.7.41이 남아 있다고 해서 이미
배포된 태그와 충돌하지 않는다.

실제 문제는 충돌이 아니라 장부 불일치다. `main`을 `dev`로 back-merge하면 정리된다
(synthetic merge 결과 clean). 릴리스 트레인 결정이라 owner 판단 사항으로 남긴다.
