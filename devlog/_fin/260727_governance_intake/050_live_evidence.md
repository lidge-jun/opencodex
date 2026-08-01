# 050 — 실증: PR #527이 밝혀낸 워크플로 실제 동작

날짜: 2026-07-27 · WP3 실행 중 관측

## 무슨 일이 있었나

WP3에서 #518을 두 PR로 쪼개면서 스택 구조를 만들었다:

    #526  base=dev                            (신호 전달)
    #527  base=codex/catalog-written-signal   (프로세스 종료)

#527은 `dev`가 아닌 브랜치를 base로 하므로 `enforce-pr-target.yml`이
발동했다. **이건 우리가 문서에 적은 바로 그 동작을 실제로 관측할 기회였다.**

## 관측 결과

    gh pr view 527 --json isDraft,title
    # draft=false | [WRONG BRANCH] fix(codex): warn about stale Codex app-servers...

봇 댓글의 상태 마커:

    <!-- wrong-branch-enforcer-state:{"version":1,"active":true,
         "autoDraftedByBot":true,"titlePrefixedByBot":true} -->

즉 워크플로는 **draft로 바꿨다고 기록했지만 실제로는 바꾸지 못했다.**
워크플로 실행 자체가 실패했다:

    gh run list --workflow=enforce-pr-target.yml --limit 3
    # 01:43  codex/app-server-restart      failure
    # 01:42  codex/catalog-written-signal  success

    GraphqlResponseError: Request failed due to following response errors:
    response: { data: { convertPullRequestToDraft: null }, errors: [...] }

## 이게 계획을 어떻게 바꾸는가

계획 문서(010, 040)는 "non-dev PR은 draft로 강등되어 머지 불가"라고 적었다.
실제로는 **제목 접두사는 붙고 draft 전환은 실패**했다. 결과적으로 #527은
ready 상태로 남아 있다.

세 가지가 확인된다:

1. **제목 오염은 실제로 일어난다.** `[WRONG BRANCH]` 접두사가 붙었고,
   봇 댓글이 "dev로 retarget하라"고 요구한다. 스택 PR이라는 정당한
   구조인데도 그렇다.
2. **draft 강등은 조건부로 실패한다.** 이번엔 GraphQL mutation이 거부됐다.
   상태 마커는 성공했다고 기록하므로, 복구 로직이 실제 상태와 어긋난
   상태를 들고 있다.
3. **워크플로가 failure로 끝난다.** 즉 이 워크플로는 정당한 스택 PR에서
   빨간 체크를 남긴다.

## 문서 정정 필요

010과 040의 "draft로 강등되어 머지 불가"는 **관측과 부분적으로 다르다.**
정확한 서술은:

> non-dev PR은 제목에 `[WRONG BRANCH]`가 붙고 봇이 retarget을 요구한다.
> draft 강등이 성공하면 머지가 차단되고, 실패하면 워크플로가 빨간 체크를
> 남긴 채 PR은 ready로 남는다. 어느 쪽이든 정상 리뷰 흐름이 아니다.

## 040(WP5)에 추가된 요건

이 관측으로 게이트 재설계에 요건이 하나 늘었다:

4. **스택 PR을 깨뜨리지 않아야 한다.** 저장소 내부 브랜치를 base로 하는
   PR(스택 리뷰 패턴)은 외부 기여자의 잘못된 base와 다르다. 최소한
   `head`와 `base`가 모두 이 저장소 소유일 때는 다르게 다뤄야 한다.

5. **상태 마커와 실제 상태의 정합성.** 현재 코드는 mutation 성공 여부와
   무관하게 `autoDraftedByBot: true`를 기록한다. 복구 로직이 그 기록을
   믿으므로, 실패한 전환이 나중에 잘못된 복구를 유발할 수 있다.

이 두 가지는 관측으로 확인된 결함이며, 040이 다룰 범위에 포함된다.
