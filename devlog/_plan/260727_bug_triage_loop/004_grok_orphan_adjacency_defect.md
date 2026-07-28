# 004 — #511 종결 철회: fence 인접 orphan에서 sweep이 마커를 파괴한다

조사 시점: 2026-07-27
대상: GitHub #511 (Grok Build 200k), 커밋 `5ff20dc0` + `7ba0fec3`
판정 변경: **CLOSE-READY → 종결 불가 (신규 결함 발견)**

## 왜 철회하는가

`001_issue_triage_matrix.md`는 #511을 CLOSE-READY로 분류했다. 근거는 두 커밋이 `dev`에
있고 `findOpencodexOrphans` / `removeOrphanTables`가 구현되어 있다는 것이었다.
**코드가 존재한다는 것과 보고된 시나리오에서 동작한다는 것은 다르다.** 종결 감사에서
독립 리뷰어가 FAIL을 냈고, 재현으로 확정했다.

## 근본 원인

`findOpencodexOrphans`(`src/grok/inject.ts:189`)는 orphan 테이블의 끝을 이렇게 정한다:

```ts
const bodyEnd = headers[position + 1]?.index ?? content.length;
```

`headers`는 `ANY_TABLE_HEADER` 정규식(`src/grok/inject.ts:86`)이 찾은 **테이블 헤더**만
담는다. 그런데 관리 블록의 여는 마커는 테이블이 아니라 주석이다:

```ts
const BEGIN_MARKER = "# >>> opencodex managed block — do not edit (removed by `ocx stop`) >>>";
```

따라서 orphan이 fence 바로 위에 인접해 있으면 — 즉 그 사이에 다른 테이블이 없으면 —
orphan의 span이 `BEGIN_MARKER`를 **삼킨다.** `removeOrphanTables`가 orphan을 지우면서
fence의 여는 마커까지 함께 지운다.

그 다음 `findManagedRegion(content)`은 BEGIN을 찾지 못해 `null`을 반환하고, 새 블록이
파일 끝에 덧붙는다. 원래의 END 마커는 위쪽에 고아로 남는다.

## 재현

`injectGrokConfig(10100, [{ id: "gpt-5.6-sol", contextWindow: 372000 }], { grokHome })`를
동일 설정에 3회 연속 적용한 결과다. 두 레이아웃의 차이는 orphan과 fence 사이에
`[cli]` 테이블이 있는지 여부뿐이다.

```
[ADJACENT] BEFORE BEGIN=1 END=1 tables=2      ← 이슈 #511이 보고한 레이아웃
  run1: changed=true  BEGIN=1 END=2 tables=2 default=ocx-gpt-5-6-sol-2
  run2: changed=true  BEGIN=1 END=2 tables=2 default=ocx-gpt-5-6-sol
  run3: changed=true  BEGIN=1 END=2 tables=2 default=ocx-gpt-5-6-sol-2

[SEPARATED] BEFORE BEGIN=1 END=1 tables=2     ← 기존 테스트가 커버하는 레이아웃
  run1: changed=true  BEGIN=1 END=1 tables=1 default=ocx-gpt-5-6-sol
  run2: changed=false BEGIN=1 END=1 tables=1 default=ocx-gpt-5-6-sol
  run3: changed=false BEGIN=1 END=1 tables=1 default=ocx-gpt-5-6-sol
```

ADJACENT에서 세 가지가 동시에 깨진다.

1. **마커 중복**: `END=2`. fence 구조가 손상된다.
2. **미수렴**: `changed=true`가 영원히 반복된다. 매 sync마다 파일이 계속 바뀐다.
3. **`default` 진동**: `ocx-gpt-5-6-sol` ↔ `ocx-gpt-5-6-sol-2`를 교대로 오간다.
   테이블 수는 2개 그대로 — #511이 보고한 중복 할당 루프가 그대로 살아 있다.

SEPARATED는 정상이다. 2→1개로 수렴하고 run2부터 `changed=false`다. 즉 수정이 틀린 게
아니라 **한 레이아웃에서만 맞다.**

## 왜 테스트가 잡지 못했는가

`tests/grok-orphan-adoption.test.ts` + `tests/grok-config-inject.test.ts`는 55건 전부
통과한다. 리뷰어 확인에 따르면 모든 픽스처가 fence를 아예 두지 않거나, orphan과 fence
사이에 빈 줄과 다른 테이블을 끼워 둔다. **이슈가 문자 그대로 기술한 레이아웃
(모델 테이블이 195행까지, fence가 196행)을 재현한 픽스처가 하나도 없다.**

이슈 본문의 "line 23, OUTSIDE the managed block" / "line 196" 기술을 그대로 픽스처로
옮겼다면 첫 커밋에서 걸렸을 문제다.

## 리뷰어가 함께 제기한 인접 결함

재현으로 확정하지는 않았으나 근거가 구체적이라 기록한다.

| # | 심각도 | 내용 |
|---|--------|------|
| 2 | High | `docs-site/src/content/docs/guides/grok-build.md:82-88`이 사용자에게 fence 밖에 `api_key = "opencodex-loopback"` + loopback `base_url` 테이블을 직접 쓰라고 안내한다. 그 형태가 정확히 sweep의 소유권 조건이므로 다음 sync에 삭제된다. 같은 문서가 "fence 밖 설정은 건드리지 않는다"고 약속한다 |
| 3 | High | 손상된 sync 후 `ocx stop`이 덧붙은 블록만 제거하고 고아 END 마커를 남긴다. 다음 inject가 begin-without-end를 보고 `orphaned-marker`로 거부해 수동 복구 전까지 통합이 멈춘다 |
| 4 | Medium | 카탈로그에서 사라진 orphan의 `default`가 존재하지 않는 테이블을 가리키게 된다. 이를 덮는 테스트가 `default` 문자열만 확인하고 테이블 생존은 확인하지 않는다 |
| 5 | Medium | 부모와 떨어진 `[model.x.extra_headers]` 하위 테이블은 자식 스캔이 첫 불일치에서 `break`하므로 쓸리지 않는다. 별칭이 예약된 채 남아 `-2` 중복이 고정된다 |
| 6 | Low | `api_key = "opencodex-loopback" # ours`(주석 꼬리)나 작은따옴표 리터럴이 `tableBodyKeys`를 통과하지 못해 영구 `-2` 중복을 만든다 |

## 결론

#511은 닫을 수 없다. 보고자가 기술한 레이아웃에서 원래 증상(중복 `-2` 별칭)이 그대로
재현되며, 여기에 fence 파괴와 미수렴이 더해진다. 이는 원래 버그보다 나쁘다 — #511은
"동작하지만 값이 틀린" 설정을 남겼고, 이 결함은 파일 구조 자체를 손상시킨다.

또한 두 커밋 모두 아직 릴리스 태그에 포함되지 않았다(`v2.7.41` 미포함). 사용자가 아직
실행하지 않았다는 뜻이므로, 지금 고치면 실제 피해 없이 넘어갈 수 있다.

## 수정 방향

orphan의 span을 fence 시작점에서 잘라야 한다. `region`이 있으면 `region.start`로,
`null`이면 `BEGIN_MARKER`의 인덱스로 상한을 건다:

```ts
const fenceLimit = region ? region.start : content.indexOf(BEGIN_MARKER);
const rawEnd = headers[position + 1]?.index ?? content.length;
const bodyEnd = fenceLimit >= 0 && header.index < fenceLimit
  ? Math.min(rawEnd, fenceLimit)
  : rawEnd;
```

하위 테이블 확장(`end`) 계산에도 같은 상한을 적용해야 한다. 회귀 테스트는 반드시
**fence 인접 픽스처**를 포함하고, 3회 연속 실행으로 멱등성(run2부터 `changed=false`)과
마커 수(`BEGIN=1 END=1`)를 단언해야 한다.

이 작업은 WP5로 goalplan에 추가한다.
