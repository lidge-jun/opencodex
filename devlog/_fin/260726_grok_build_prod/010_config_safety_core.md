---
created: 2026-07-26
status: plan
phase: wp1
blockers: [B3, B5]
tags: [grok-build, toml, data-safety]
---

# 010 — 설정 안전성 코어 (B3 인용 키, B5 개행 복원)

> **개정 2026-07-26 (A-게이트 감사 반영).** B5 초판 알고리즘은 실제로 버그를 고치지 못했고
> 중간 삽입 경로에서 사이클마다 개행이 늘어나는 퇴행을 유발했다. 아래는 감사에서 실행 추적으로
> 검증된 교정본이다. B3에는 미커버 충돌 철자 2종을 추가한다.

대상 파일: `src/grok/inject.ts`, `tests/grok-config-inject.test.ts`.
근거: `000_blocker_inventory.md` B3/B5, `001_grok_source_evidence.md` E1.

## B3 — 첫 키 세그먼트 정규화

### 현재

```ts
const header = /^\s*\[\s*model\s*\.\s*(?:([A-Za-z0-9_-]+)|"((?:[^"\\]|\\.)*)"|'([^']*)')\s*\]\s*(?:#.*)?$/gm;
```

첫 세그먼트 `model`이 리터럴이라 `["model"."x"]`, `['model'.x]`를 놓친다.

### 변경

두 세그먼트를 대칭적으로 다루는 형태로 재작성한다. 세그먼트 문법을 한 번만 정의하고 재사용:

```ts
// bare | basic-string | literal-string — TOML이 허용하는 키 세그먼트 세 형태.
const KEY_SEGMENT = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
const MODEL_HEADER = new RegExp(
  String.raw`^\s*\[\s*(${KEY_SEGMENT})\s*\.\s*(${KEY_SEGMENT})\s*\]\s*(?:#.*)?$`,
  "gm",
);
```

그리고 세그먼트 → 실제 키 문자열로 되돌리는 단일 정규화 함수를 도입한다:

```ts
/** TOML 키 세그먼트(bare/basic/literal)를 그것이 가리키는 실제 키로 되돌린다. */
function canonicalKeySegment(raw: string): string | null {
  if (raw.startsWith('"')) return decodeTomlBasicString(raw.slice(1, -1));
  if (raw.startsWith("'")) return raw.slice(1, -1); // literal string: 이스케이프 없음
  return raw;
}
```

`userModelAliases()`는 이제 첫 세그먼트가 정규화 후 `model`인 헤더만 채택한다:

```ts
for (const match of outsideManagedRegion.matchAll(MODEL_HEADER)) {
  if (canonicalKeySegment(match[1]!) !== "model") continue;
  const alias = canonicalKeySegment(match[2]!);
  if (alias !== null) aliases.add(alias);
}
```

기존 `decodeTomlBasicString`은 그대로 재사용한다(이미 `\uXXXX`/`\UXXXXXXXX` 처리 검증됨).
리터럴 문자열(`'...'`)은 TOML상 이스케이프가 없으므로 디코드하지 않는 현재 동작이 옳다.

### 방출 측 대칭 확인

`buildGrokManagedBlock()`은 `ocx-` 접두 + `[^A-Za-z0-9_-]` 치환으로 alias를 만들므로 점이 남지
않는다(E1의 점-alias 함정에 해당하지 않음). 이 성질이 회귀하지 않도록 테스트로 고정한다.

### 회귀 테스트 (`tests/grok-config-inject.test.ts` 추가)

1. `["model"."ocx-gpt-5"]`를 소유한 설정 → 생성 블록이 `[model.ocx-gpt-5]`를 재사용하지 않고
   `[model.ocx-gpt-5-2]`로 회피.
2. `['model'.ocx-gpt-5]` 동일.
3. `[ "model" . 'ocx-gpt-5' ]` 공백/혼합 인용 동일.
4. 방출된 모든 alias에 `.`이 없음 (점-alias 함정 고정).
5. `[[model.ocx-gpt-5]]` (배열 테이블) 예약됨.
6. `[model.ocx-gpt-5.sub]` (하위 테이블) 예약됨.

### 추가 철자 커버리지 (감사 지적)

`tomllib` 실측 결과는 아래와 같다. **정정(구현 리뷰):** 초판은 `[model.x.sub]`도 충돌한다고
적었으나 실제로는 충돌하지 않는다. 하위 테이블 선언과 나중의 상위 테이블 헤더는 순서에 무관하게
유효하다. 예약 자체는 유지하되(비용은 alias 접미사 하나뿐이고 사용자 네임스페이스를 침범하지
않는 편이 낫다) 근거를 정확히 적는다.

| 사용자 철자 | 우리 블록과의 충돌 | 예약 |
|-------------|-------------------|------|
| `[[model.ocx-mine]]` | **duplicate key** | 필수 |
| `["model"."ocx-mine"]` | **duplicate key** | 필수 |
| `[model.ocx-mine.sub]` | 충돌 없음 (유효) | 보수적 선택 |
| `[model]` + `ocx-mine.k = 1` | **duplicate key** | 미커버(D7) |
| 루트 `model.ocx-mine.k = 1` | **duplicate key** | 미커버(D7) |

따라서 헤더 정규식을 다음으로 확장한다 — 여는 괄호를 1~2개 허용하고, 두 번째 세그먼트 뒤에
**추가 세그먼트가 이어져도** 두 번째 세그먼트를 예약한다:

```ts
const MODEL_HEADER = new RegExp(
  String.raw`^[ \t]*\[\[?[ \t]*(${KEY_SEGMENT})[ \t]*\.[ \t]*(${KEY_SEGMENT})[ \t]*(?:\.[^\]\r\n]*)?\]\]?[ \t]*(?:#.*)?$`,
  "gm",
);
```

**모든 문자 클래스는 개행을 배제해야 한다(구현 리뷰에서 발견된 실제 결함).**
초판의 `[^\]]*`는 개행을 포함하므로, 멀티라인 문자열 안의 닫히지 않은 `[model.…` 한 줄이
뒤따르는 줄들을 통째로 삼켜 **진짜 `[model.<alias>]` 헤더를 예약에서 누락**시킨다.
그 결과 우리가 중복 테이블을 방출해 grok이 설정 전체를 거부한다 — B3가 막으려던 사고가
B3 수정 자체에 의해 재발한다. 재현 입력(유효한 TOML):

```toml
prompt = """
[model.a.b
"""

[model.ocx-mine]
```

회귀 테스트로 고정한다.

세 세그먼트 헤더(`[model.x.y]`)는 이제 `x`를 예약한다. 초판은 이를 "예약하면 안 된다"고 적었으나
충돌하지 않더라도 사용자 네임스페이스를 피하는 편이 안전하므로 **예약을 유지**한다.
루트 dotted 키(`model.ocx-mine.x = 1`)와 `[model]` + dotted 키 형태는 실제로 충돌하지만
우선순위를 낮춰 `000`의 잔여 위험(D7)으로 남긴다.
멀티라인 문자열 안의 헤더가 헛되이 예약되는 경우도 같은 성격의 잔여 위험이며, 비용은 alias
접미사 하나뿐이다.

여는/닫는 괄호 개수 불일치(`[model.x]]`)는 어차피 유효하지 않은 TOML이며, 예약은 보수적 방향이라
무해하다.

## B5 — 주입 구분자의 정확한 복원

### 현재

inject: `const separator = content.endsWith("\n") ? "\n" : "\n\n";`
strip: `if (prefix.endsWith("\n\n")) prefix = prefix.slice(0, -1);` — 항상 하나만 제거.

원래 개행이 없던 파일은 `ocx stop` 후 개행 하나를 얻는다.

### 왜 strip만 고쳐서는 불가능한가

현재 inject는 `content.endsWith("\n") ? "\n" : "\n\n"`으로 구분자를 고른다. 결과 상태를 추적하면:

| 원문 | inject 후 |
|------|-----------|
| `"X"` (개행 없음) | `"X\n\n" + B + "\n"` |
| `"X\n"` (개행 하나) | `"X\n\n" + B + "\n"` |

**두 경우의 파일이 바이트 단위로 동일하다.** 어떤 strip 규칙도 둘을 구분할 수 없으므로,
inject를 그대로 둔 채 양쪽을 byte-for-byte 복원하는 것은 원리적으로 불가능하다.
따라서 **inject를 단사(injective)로 바꾸는 것**이 유일한 해법이다.

### 변경 (감사 검증 알고리즘)

inject — 구분자를 항상 정확히 하나로:

```ts
// 항상 개행 하나만 넣는다. 사용자 파일의 종결 상태가 그대로 보존되므로
// strip이 우리가 넣은 개행을 모호함 없이 되돌릴 수 있다.
const separator = "\n";
```

strip — 두 규칙으로 대칭 복원:

```ts
let prefix = content.slice(0, region.start);
const restOfFile = content.slice(removalEnd);
// 개행으로 끝나던 파일에 붙인 구분자.
if (prefix.endsWith("\n\n")) prefix = prefix.slice(0, -1);
// 개행 없이 끝나던 파일 끝에 붙인 구분자.
else if (restOfFile.length === 0 && prefix.endsWith("\n")) prefix = prefix.slice(0, -1);
```

감사에서 (a) 빈 파일, (b) 개행 없음, (c) 개행 하나, (d) 개행 둘, 개행 셋, 중간 삽입, 5회
inject/strip 반복까지 실행 추적으로 검증했다 — 불일치 0, 드리프트 0.

**감수하는 변화 두 가지(문서에 명시한다):**
- 개행 없이 끝나던 파일은 이제 fence 앞에 빈 줄이 생기지 않는다(외형만 달라짐).
- 이미 배포된 코드가 쓴 기존 블록은 (c) 의미로 복원된다. 구현 리뷰 실측: 개행 하나/둘로 끝나던
  원문은 정확히 복원되고, 개행 없이 끝나던 원문만 개행 하나가 남는다. 사용자 바이트를 **먹는**
  방향이 아니라 **더하는** 방향이므로 안전하다.

### 회귀 테스트

1. 개행 없이 끝나는 원문 → inject → strip → **원문과 바이트 동일**.
2. 개행 하나로 끝나는 원문 → 왕복 후 바이트 동일 (기존 테스트 강화).
3. 개행 두 개로 끝나는 원문 → 왕복 후 바이트 동일 (사용자 개행을 삼키지 않음).
4. 블록 뒤에 사용자 섹션이 있는 경우(중간 삽입) → 왕복 후 바이트 동일.
5. inject/strip을 **5회 반복**해도 파일이 자라지 않는다 (드리프트 가드).
6. **균일** CRLF 원문에서 1–4 반복.
   혼합 EOL은 `applyEol`이 정규화하므로 byte-for-byte 왕복이 설계상 불가능하다 —
   이 정규화는 의도된 동작이며 테스트는 균일 CRLF로 한정한다.

## 게이트

`bun test tests/grok-config-inject.test.ts` → `bun run typecheck`.
