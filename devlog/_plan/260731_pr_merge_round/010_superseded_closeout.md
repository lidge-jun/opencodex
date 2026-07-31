# 010 — 이미 랜딩된 7건 정리

머지가 없는 사이클이다. HEAD가 이미 같은 결함을 고쳤다는 걸 커밋 단위로 확인하고,
PR과 이슈를 근거와 함께 닫는다.

## 확인 방법

`git cherry HEAD refs/prs/<N>`으로 patch-id 동등성을 보고, 동등하지 않으면 HEAD
소스를 직접 읽어 결함이 사라졌는지 확인했다. patch-id가 다른데 결함은 없어진
경우가 있다 — 메인테이너가 같은 문제를 다르게 고친 경우다. 이때는 PR을 머지하면
**더 나은 구현을 되돌린다.**

## 건별 근거

### #736 → #722 (FULL)

HEAD `1d9e196e7 fix(service): make Windows status locale independent`.

`git cherry`가 PR의 커밋 하나를 `+`(미적용)로 표시하지만 오해다. HEAD의 구현이 더
새롭다. 확인:

```
git diff HEAD refs/prs/736 -- src/service.ts
```

PR head 방향으로 가면 `decodeSchtasksOutput()` 전체(`src/service.ts:364-393`)와
XML 판독 실패 분기(`:607-619`)가 **삭제되고** `runFile()`이 `encoding: "utf8"`로
돌아간다. schtasks `/query /xml`은 UTF-16LE를 뱉기 때문에 그 상태로는 모든 health
check가 실패하고 성공한 elevated create를 롤백한다. 즉 이 PR을 지금 머지하면
#722를 다시 연다.

### #752 → #733 (FULL)

HEAD `c1ecbe1b5 feat(windows): add restart-safe tray controls`.
`src/tray/windows.ts:474-477`이 `stdio: "ignore"`로 띄운다. 소켓 핸들이 상속되지
않는다. PR 커밋은 patch-id 동등(`-`).

### #743 → #572 (PARTIAL)

HEAD `fd1933099 fix(providers): harden discovery path and test isolation`.
`src/providers/model-discovery.ts:93-95`가 백슬래시와 `%2e` 디코딩된 `..` 세그먼트를
거부한다. 두 커밋 모두 patch-id 동등.

#572는 닫지 않는다. 그 이슈는 OpenAI 호환 provider 배치 승격 전체이고 이건 discovery
경로 하드닝 한 조각이다.

### #610 → #606 (FULL)

HEAD `716f39cb6 fix(codex): key catalog cache by runtime and address CodeRabbit follow-ups`.
`src/codex/catalog/bundled.ts:153-168`이 주입된 executor만 전달하고
`discoverAlternatives`를 기본 `false`로 둔다. 두 커밋 patch-id 동등.

이전 라운드 문서가 이 PR head를 NOT-ON-DEV로 기록했는데, 그 뒤에 랜딩됐다.

### #734 → #721 (FULL)

HEAD `9b5c864ff merge: PR #734` — 이미 머지돼 있다. 열려 있는 건 GitHub 상태가
갱신되지 않아서다. 남아 있던 macOS 테스트 실패는 `f81e98aca`가 고쳤다:
`tests/bun-runtime.test.ts:7-9`가 `realpathSync`로 temp root를 먼저 해석한다.
이전 라운드가 이 PR을 뺀 이유가 그 실패였다. 지금 8/8 통과.

### #777 → #759 (PARTIAL)

HEAD `e64a00e9f`가 `src/codex/catalog/parsing.ts:274-285`에서 모든 카탈로그 엔트리의
`input_modalities`를 정규화한다. `text`/`image`/`audio`만 통과시키고, 전부 걸러지면
빈 배열 대신 `["text"]`로 둔다. 오염된 영속 행 복구는
`tests/codex-catalog-sync-hardening.test.ts:161-193`이 덮는다. `7a041e2bc`와
`299f35dc9`가 커스텀 모델 라우트 쪽 enum 경계를 추가로 막았다.

PR의 테스트는 지금 컴파일도 안 된다 — import하는 sanitizer 헬퍼가 HEAD에 없다.
#759는 열어둔다. 이슈가 더 넓은 enum 경계 점검을 명시적으로 남겨뒀다.

### #533 → #557로 대체

patch-id로 확인: #533의 update-recovery 14커밋이 #557에 전부 같은 patch-id로
들어 있고 #557이 하드닝 2건을 더 얹었다. 다만 `refs/prs/533`이 `refs/prs/557`의
**그래프 조상은 아니다** — 재작성된 같은 시리즈다. 둘 다 draft이고 250커밋 이상
뒤처져 있다. #557을 후속으로 남기고 #533만 닫는다.

#737(`62e937614`, 이미 dev에 있음)이 이 둘을 대체하지 않는다는 것도 확인했다.
#737은 `src/update/job.ts`와 그 테스트 86줄만 바꾼다. 캐시 소유권 preflight,
recovery-tree 검증, 프로세스 트리 정리는 들어 있지 않다.

## 이슈 처리

닫는다: #722, #733, #606, #721.
열어둔다: #572(부분), #759(부분).

## 이 사이클이 바꾸는 파일

없다. 문서만 추가한다. GitHub 상태만 정리한다.
