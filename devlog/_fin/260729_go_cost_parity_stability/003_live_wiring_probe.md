# 003 — 라이브 프로브: 왜 프런트엔드에 비용이 안 뜨는가

측정 2026-07-29, 대상은 실제로 떠 있던 Go 런타임(`127.0.0.1:10100`), 브랜치 `dev2-go`.
`001`은 정적 대조였다. 이 문서는 **실행 중인 런타임을 때려서** 나온 것이고,
정적 대조가 놓친 결함 하나를 잡았다.

## 질문

"비용 구조가 안 옮겨진 건가, 배선이 안 된 건가?"

답은 **둘 다**인데, 화면을 직접 비우는 원인은 배선이다. 그리고 그 배선 결함은
`001`의 정적 감사가 **놓쳤다**. 라이브 응답을 찍지 않았으면 못 잡았을 종류다.

## 결함 W1 — JSON 태그 부재로 키가 대문자로 나간다 (신규, 최우선)

`go/internal/usage/cost.go:10-11`:

```go
type CostTokens struct{ Input, Output, CacheRead, CacheWrite int }
type CostBreakdown struct{ Input, Output, CacheRead, CacheWrite, Total float64 }
```

구조체 태그가 없다. Go의 `encoding/json`은 태그가 없으면 필드명을 그대로 쓰므로
`Total`, `Input`, `CacheRead`가 대문자로 직렬화된다. 바깥 구조체들은 태그를 갖고 있어서
(`cost.go:16-27`) `tokens`, `cost`, `price`는 소문자인데 **그 안쪽만 대문자**다.

실측 (`curl -s "http://127.0.0.1:10100/api/logs?limit=3"`):

```json
"cost":{"kind":"value","estimate":{
  "tokens":{"Input":2,"Output":228,"CacheRead":574757,"CacheWrite":450},
  "cost":{"Input":0.00001,"Output":0.0057,"CacheRead":0.2873785,
          "CacheWrite":0.0028125,"Total":0.29590099999999997},
  "price":{"provider":"anthropic","modelId":"claude-opus-5",
           "cost4":{"input":5,"output":25,"cacheRead":0.5,"cacheWrite":6.25},
           ...},
  "estimated":true,"priorityMultiplier":1}}
```

오라클 인터페이스는 소문자다(`src/usage/cost.ts:29-42`: `input`, `output`, `cacheRead`,
`cacheWrite`, `total`).

GUI는 소문자를 읽는다 — `gui/src/pages/Logs.tsx:53`이 타입을
`cost: { input: number; ...; total: number }`로 선언하고, `:208`이 게이트를 건다:

```ts
if (!result || result.kind === "unavailable"
    || !Number.isFinite(result.estimate.cost.total)
    || result.estimate.cost.total < 0) return "\u2014";
```

`cost.total`은 `undefined`, `Number.isFinite(undefined)`는 `false` → **em dash 반환**.

즉 위 로그의 `claude-opus-5` 요청은 Go가 `$0.2959`를 **정확히 계산해놓고도** 화면에는
`—`로 뜬다. `kind`는 `"value"`이므로 "가격 없음" 경로로 빠지지도 않는다. 조용히 비는 것이다.

같은 이유로 상세 패널의 5개 항목도 전부 빈다(`Logs.tsx:761-765`가
`cost.estimate.cost.total/input/cacheRead/cacheWrite/output`을 읽는다).
목록 칼럼도 마찬가지(`Logs.tsx:297-298`: `cost.estimate.cost.total`).

**이것이 `000`의 work-phase 지도를 바꾼 이유다.** 원래 `010`이었던 번들 생성기보다
먼저 와야 한다. 변경량은 두 줄인데 사용자 체감은 가장 크고, 무엇보다 이걸 안 고치면
`010`~`060`으로 가격을 아무리 정확하게 만들어도 **화면에는 계속 안 뜬다**.

## 결함 W2 — 이식 누락은 실재하며 규모가 크다

같은 응답의 두 번째 행:

```json
{"model":"gpt-5.5","provider":"openai", ...
 "displayMetrics":{"cost":{"kind":"unavailable","reason":"price_unmatched"}}}
```

`gpt-5.5`는 jawcode openai 번들에 있지만 Go 오버레이 48행에는 없다. `001`의 G1 그대로다.

집계 규모 (`curl -s "http://127.0.0.1:10100/api/usage?range=7d"`):

```json
"requests":90388, "measuredRequests":89479,
"estimatedCostUsd":8027.012535600039,
"pricedRequests":37771, "unpricedRequests":51708, "unmeteredRequests":909
```

측정된 89,479건 중 **51,708건(57.8%)이 unpriced**다. `estimatedCostUsd` $8,027은
나머지 42%만 반영한 값이다.

## 두 결함의 관계

겹쳐 있어서 증상이 하나로 보인다.

| 모델 부류 | 가격 계산 | 화면 표시 | 원인 |
| --- | --- | --- | --- |
| 오버레이 48행에 있음 (`claude-opus-5` 등) | 됨 | **안 됨** | W1 (JSON 키) |
| jawcode에만 있음 (`gpt-5.5` 등, 57.8%) | 안 됨 | 안 됨 | W2 (번들 부재) |

그래서 사용자에게는 "비용 칼럼이 통째로 비어 있다"로 보인다. W1만 고치면 42%가 살아나고,
W2까지 고치면 나머지가 살아난다.

## 재현

```bash
# W1: kind가 value인데 total 키가 없음을 확인
curl -s "http://127.0.0.1:10100/api/logs?limit=5" \
  | python3 -c 'import json,sys
for r in json.load(sys.stdin):
    c = (r.get("displayMetrics") or {}).get("cost") or {}
    if c.get("kind") == "value":
        print(r["model"], "| total 키:", "total" in c["estimate"]["cost"],
              "| Total 키:", "Total" in c["estimate"]["cost"])'

# W2: unpriced 비율
curl -s "http://127.0.0.1:10100/api/usage?range=7d" \
  | python3 -c 'import json,sys; s=json.load(sys.stdin)["summary"]
print(s["pricedRequests"], s["unpricedRequests"], s["measuredRequests"])'
```

## 방법론 메모

`260729_go_port_blindspot_sweep/000_findings.md`가 기록한 패턴이 여기서도 반복됐다:
"라우트는 200을 반환하는데 오라클이 담는 키 하나가 없다. 에러가 아니라 빈 화면으로
나타나기 때문에 아무도 버그로 신고하지 않는다."

W1은 그 변종이다 — 키가 **없는** 게 아니라 **대소문자가 다르다**. 정적 함수 대조로는
안 잡힌다. 두 구현이 같은 필드를 갖고 있고 로직도 같기 때문이다. 직렬화 경계에서만
갈린다. 앞으로 파리티 감사는 **함수 대조와 별개로 응답 바이트를 비교해야 한다.**
