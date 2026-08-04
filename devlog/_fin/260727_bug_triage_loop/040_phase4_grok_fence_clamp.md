# 040 — WP2(재계획): orphan span을 fence 경계에서 클램프

대응: GitHub #511 (재개)
근거: `004_grok_orphan_adjacency_defect.md`

## 스코프

IN:

- `src/grok/inject.ts` — `findOpencodexOrphans`의 span 계산
- `tests/grok-orphan-adoption.test.ts` — fence 인접 회귀 테스트 추가

OUT: 소유권 판정식 변경, 문서 수동 레시피 문제(#511 리뷰 블로커 2), 고아 END wedge
(블로커 3), dangling default(블로커 4). 각각 독립 결정이 필요하므로 WP5로 분리한다.

## 결함 요약

`findOpencodexOrphans`는 orphan의 본문 끝을 다음 **테이블 헤더**로 잡는다:

```ts
const bodyEnd = headers[position + 1]?.index ?? content.length;
```

`ANY_TABLE_HEADER`(86행)는 테이블 헤더만 수집하고 `BEGIN_MARKER`(20행)는 주석이다.
따라서 orphan과 fence 사이에 다른 테이블이 없으면 span이 마커를 넘어간다.

## 수정

### `src/grok/inject.ts` — `findOpencodexOrphans`

함수 시작부에 fence 상한을 한 번만 계산한다. `findManagedRegion`은 `BEGIN_MARKER`가
없을 때만 `null`을 반환하므로, `region`이 `null`이면 fence도 없다 — 따라서 `indexOf`
폴백은 항상 `-1`을 재계산하는 죽은 코드다(A단계 감사 블로커 3). `-1`을 직접 쓰고
그 불변식을 주석으로 남긴다:

```ts
function findOpencodexOrphans(content: string, region: ManagedRegion | null): OrphanTable[] {
  const orphans: OrphanTable[] = [];
  // A pre-fence orphan's body must stop AT the fence. The managed block opens with a
  // comment, not a table header, so a span that runs to "the next table header" swallows
  // the BEGIN marker whenever no other table separates them — and removing the orphan
  // then deletes the fence opener itself (#511 follow-up).
  // region is null ONLY when BEGIN_MARKER is absent (see findManagedRegion), so -1
  // disables the clamp for marker-less files without a redundant scan.
  const fenceStart = region ? region.start : -1;
  const clampEnd = (start: number, end: number): number =>
    fenceStart >= 0 && start < fenceStart ? Math.min(end, fenceStart) : end;
```

본문 끝 계산에 적용:

```ts
-    const bodyEnd = headers[position + 1]?.index ?? content.length;
+    const bodyEnd = clampEnd(header.index, headers[position + 1]?.index ?? content.length);
```

하위 테이블 확장에도 동일 상한을 적용한다. 이걸 빠뜨리면 `[model.x.extra_headers]`를
따라가다 같은 방식으로 마커를 넘어간다:

```ts
-      end = headers[next + 1]?.index ?? content.length;
+      end = clampEnd(header.index, headers[next + 1]?.index ?? content.length);
```

자식 헤더가 fence 안쪽이면 순회를 멈춘다. **단, 부모가 fence 위에 있을 때만이다**
(A단계 감사 블로커 1):

```ts
       const child = headers[next]!;
+      if (fenceStart >= 0 && header.index < fenceStart && child.index >= fenceStart) break;
       if (child.segments.length <= 2) break;
```

### 왜 `header.index < fenceStart` 한정이 필수인가

한정 없이 `child.index >= fenceStart`만 쓰면 **fence 아래 orphan에서 첫 반복에 즉시
`break`한다** — 그 위치에서는 모든 헤더 인덱스가 `fenceStart`보다 크기 때문이다.
결과적으로 하위 테이블이 남고, `userModelAliases`가 그 별칭을 계속 예약해 `-2` 중복이
영구화된다. 이는 #511이 보고한 바로 그 루프의 재발이며, 현재 코드보다 나쁘다.

세 변형을 실제 실행해 확인했다. 픽스처는 fence 아래 orphan + `[model.<alias>.extra_headers]`
하위 테이블(Grok이 재직렬화할 때 만드는 형태):

| 변형 | 결과 테이블 | 판정 |
|------|-------------|------|
| 현재 코드 | `[model.ocx-gpt-5-6-sol]` | 정상 |
| plan040 초안(한정 없음) | `[model.ocx-gpt-5-6-sol-2]` + `[model.ocx-gpt-5-6-sol.extra_headers]` | **회귀** |
| 한정 추가 | `[model.ocx-gpt-5-6-sol]` | 정상 |

세 변형 모두 ADJACENT에서는 `BEGIN=1 END=1`, run2부터 `changed=false`로 수렴했다.
즉 초안도 원래 결함은 고치지만 다른 레이아웃을 깨뜨린다. 기존 테스트 55건은 이 회귀를
잡지 못한다 — fence 아래에 하위 테이블 달린 orphan을 둔 픽스처가 없기 때문이다.

### 백업 (A단계 감사 블로커 2)

`copyBackupOnce`는 `configExisted && !region` 조건이다. 현재 결함 코드가 이 레이아웃에서
백업을 남긴 건 **fence를 파괴해 `region`이 falsy가 됐기 때문**이며 의도된 동작이 아니다.
클램프가 fence를 지키면 그 우연한 백업이 사라진다. 사용자 파일의 테이블을 지우는
동작이므로 `orphans.length > 0`일 때도 백업하도록 조건을 넓힌다.

## 회귀 테스트

`tests/grok-orphan-adoption.test.ts`에 추가. 기존 픽스처가 전부 orphan과 fence 사이에
다른 테이블을 두고 있어서 이 결함을 놓쳤으므로, **인접**이 핵심 조건이다.

```ts
test("an orphan adjacent to the fence does not swallow the BEGIN marker (#511)", () => {
  // orphan 바로 다음 줄이 BEGIN 마커인 배치. 사이에 어떤 테이블도 없다.
  // 3회 연속 inject 후 단언:
  //   - BEGIN 1개, END 1개 (마커 파괴 없음)
  //   - run2부터 changed === false (수렴)
  //   - 모델 테이블 1개 (중복 제거됨)
  //   - default가 진동하지 않고 살아남은 별칭을 가리킴
});
```

수정 전 이 테스트가 실패함을 먼저 확인한다 — 통과하는 테스트를 추가하면 결함을 증명하지
못한다.

**필수 추가 케이스** (A단계 감사 블로커 4). 인접 픽스처만으로는 블로커 1을 잡을 수 없다:

```ts
test("a below-fence orphan still gets its sub-tables swept (guard regression)", () => {
  // fence 아래 orphan + [model.<alias>.extra_headers]
  // 단언: 하위 테이블이 남지 않고, default가 -2로 고정되지 않는다.
  // 이 테스트는 한정 없는 초안에서 반드시 FAIL 해야 한다.
});

test("a below-fence orphan whose alias collides does not pin default to -2", () => {
  // 단언: default === "ocx-gpt-5-6-sol" (not "...-2")
});
```

여력이 되면 추가: 인접 orphan에 빈 줄이 아예 없는 배치, 인접 orphan 2개 연속(다중 제거
오프셋), fence 위아래 동시, CRLF 인접, inject→strip 후 잔여 END 마커 없음, orphan과
fence 사이 사용자 주석.

## 수용 기준

| 기준 | 활성화 | 관측 |
|------|--------|------|
| c-grok-adjacency | fence 인접 orphan 3회 sync | `BEGIN=1 END=1`, run2부터 `changed=false`, 테이블 1개 |
| 가드 회귀 방지 | fence 아래 orphan + 하위 테이블 | 하위 테이블 제거, `default`가 `-2` 아님 |
| 무회귀 | 전체 스위트 | 4985 pass 기준선 대비 신규 실패 0건 |
| SEPARATED 보존 | 기존 레이아웃 | 기존 55건 계속 통과 |

## 이번 phase에서 다루지 않는 것

감사에서 확인된 선재 결함 2건은 WP5로 넘긴다. 클램프가 악화시키지 않음을 확인했다.

- inject→strip 후 `default`가 사라진 테이블을 가리킨다(SEPARATED에서 이미 발생).
- fence 아래 orphan이 파일의 마지막 테이블이면 span이 EOF까지 가서 뒤따르는 사용자
  주석을 삭제한다. 현재 코드와 모든 수정 변형이 동일하게 삭제한다. EOF 쪽 상한이
  필요하나 범위가 다르다.

## 검증

```bash
bun test tests/grok-orphan-adoption.test.ts tests/grok-config-inject.test.ts
bun run typecheck
bun run test
```

푸시는 하지 않는다. `dev`에 `e7d144fc` 충돌이 미해결 상태이므로 커밋까지만 하고
사용자 결정을 기다린다.
