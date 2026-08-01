# 090 — wp5: 스테일 생성 메타데이터 재동기화 + M3 video 랜딩

## 왜 이 work-phase가 생겼나

A-감사(260730)에서 wp4의 재생성 계획이 실행 불가능함이 실측으로 드러났다.
`src/generated/jawcode-model-metadata.ts`는 상위 소스와 **이미 어긋나 있고**, 재생성은
video와 무관한 변경을 대량으로 끌고 온다. 그 델타를 wp4의 곁가지로 처리하면 "가격은
건드리지 않는다"는 선언을 위반하므로, **독립 work-phase로 분리**한다
(LOOP-UNIT-CHAIN-01 — 루프 중 발견된 독립 유닛은 다음 work-phase로 append).

wp4는 jawcode 소스와 제너레이터 타입까지만 준비하고 생성물을 불변으로 둔다.
이 사이클이 그 위에서 생성물을 재동기화하고 video를 실제로 랜딩한다.

## 실측 델타 (감사 + 메인 세션 독립 재현)

| 항목 | 개수 |
|------|------|
| 필드가 바뀐 모델 | 95 |
| 가격(cost) 변경 | 63 |
| 신규 추가 모델 | 36 |
| 삭제 모델 | 0 |
| 입력 모달리티 변경 | 0 |

번들 단위로는 7개가 변경된다: `amazon-bedrock`, `anthropic`, `cerebras`, `google`,
`opencode-go`, `openrouter`, `xai`. 추가로 `PROVIDER_ALIASES` 순서가 재정렬된다
(`"zhipu-bigmodel"`이 마지막 → 31번째). 즉 파일은 `models.json`뿐 아니라
`PROVIDER_REGISTRY` 순서에 대해서도 스테일하다.

대표 가격 변경:

```
google/gemini-flash-latest        input 0.3 -> 1.5     output 2.5 -> 9
openrouter/moonshotai/kimi-latest input 0.66 -> 3      output 3.41 -> 15
opencode-go/qwen3.6-plus          input 0.5 -> 2       output 3 -> 6
```

### 사용자 가시 낙진 (감사가 특정한 3건)

```
opencode-go/minimax-m3   contextWindow 1000000 -> 512000    광고 컨텍스트 반토막
opencode-go/minimax-m3   cacheWrite 0 -> 0.375
opencode-go/kimi-k3      신규 등장, cost { input 3, output 15, cacheRead 0.3 }
```

> **재감사 정정 (라운드 2, NEW-2)**: 개정 1판은 "컨텍스트는 레지스트리가 이기므로
> 안전하다"고 썼다. 그 주장은 **`kimi-k3`에만 참**이고 `minimax-m3`에는 거짓이다.

레지스트리 오버라이드 실측:

```
src/providers/registry.ts:576   opencode-go   modelContextWindows: { "kimi-k3": KIMI_K3_STANDARD_CONTEXT_WINDOW }
                                              ← minimax-m3 항목이 없다
```

감사자가 두 행을 실제로 조립한 결과:

```
minimax-m3   hinted.contextWindow = undefined   row.context_window = 1000000
kimi-k3      hinted.contextWindow = 262144      row.context_window = 262144
```

즉 `opencode-go/minimax-m3`의 광고 컨텍스트는 **jawcode 행 단독**으로 결정되고,
상위 소스가 이미 `contextWindow: 512000`이므로 **재동기화하면 실제로 반토막 난다.**
`kimi-k3`만 `sync.ts:181-184`의 재적용 순서로 보호된다.

비용 행도 보호되지 않는다 — `findJawcodeCostByModelId`와 사용량 오버레이가 그대로 먹는다.
`opencode-go/kimi-k3`가 wp2와 같은 모델 계열이라는 점도 유의한다.

따라서 `minimax-m3`의 1,000,000 → 512,000은 "안전하다"가 아니라 **의도적 결정이 필요한
항목**이며, 아래 델타 분류 단계의 `context` 축에서 판정한다. 512,000이 맞다면 그대로
받고, 1M을 광고해야 한다면 `modelContextWindows` 오버라이드를 추가한다.

## 왜 드리프트가 생겼나 (근본 원인)

동기화를 강제하는 게이트가 없다. `rg -ln "jawcode-model-metadata" tests/`는
`provider-registry-parity`, `codex-catalog`, `slug-codec`만 반환하고, 그 어느 것도
재생성 후 비교를 하지 않는다. 소스가 갱신돼도 아무도 알려주지 않으므로 조용히 벌어진다.
→ **가드 없이 재동기화만 하면 같은 드리프트가 다시 쌓인다.** 가드를 이 사이클의
산출물에 포함한다.

## 변경 계획 (diff level)

### 1. 델타 분류 (코드 변경 아님, 산출물은 표)

격리된 임시 사본에서 재생성한 뒤 커밋된 파일과 비교해 변경 행 전부를 분류한다.
분류 축: `price` / `context` / `maxTokens` / `new-model` / `alias-order` / `modality`.

```bash
# 임시 사본에서만 실행 — 워크트리 생성물은 건드리지 않는다
ocxresync_dir=$(mktemp -d)
# src/ scripts/ 복사 + node_modules 심링크 후 제너레이터 실행
# 산출물을 커밋된 파일과 행 단위로 diff하여 분류표 작성
```

수용: 95행 전부가 표의 어느 한 축에 배정되고, 미분류가 0이어야 한다.

### 2. 가격 변경 63건의 성격 판정

각 가격 변경이 "상위 소스가 공식 가격을 따라잡은 것"인지 "할인/정가 혼입"인지 판정한다.
#706에서 배운 교훈이 여기 그대로 적용된다 — 상위 소스의 숫자가 곧 정답은 아니다.

판정 불가한 행이 남으면 그 행만 **현행 유지**하고 근거를 기록한다. 소스를 그대로
삼키지 않는다.

### 3. MODIFY `src/generated/jawcode-model-metadata.ts` — 재생성으로 반영

```bash
bun run generate:jawcode-metadata
```

wp4가 이미 jawcode 소스에 video를 넣고 제너레이터 타입을 넓혀뒀으므로, 이 재생성
결과에는 M3 video가 **자동으로 포함**된다. 확인 지점:

```
"minimax": [... ["MiniMax-M3",1000000,128000,"text,image,video",1,null,0.3,1.2,0.06,0]]
                                             ^^^^^^^^^^^^^^^^^  video
                                                                 ^^^^^^^^^ M3 가격은 불변
```

M3 행의 가격은 이 사이클에서도 바뀌지 않는다(상위 소스가 `0.3/1.2/0.06`을 유지).

### 4. ADD 동기화 가드

`tests/jawcode-metadata-sync.test.ts` (신규) — 제너레이터를 임시 출력으로 돌려
커밋된 파일과 바이트 비교한다. 불일치 시 실패하며, 실패 메시지는
`bun run generate:jawcode-metadata`를 실행하라고 안내한다.

구현 제약:

- 소스(`../jawcode/...`)가 없는 환경에서는 **skip**해야 한다. 컨트리뷰터와 CI는
  jawcode 체크아웃이 없다(`generate-jawcode-metadata.ts:31`이 throw). 존재 여부를
  먼저 확인하고 없으면 조용히 통과시킨다 — 그러지 않으면 CI가 전부 깨진다.
- 워크트리 생성물을 절대 덮어쓰지 않는다. `JAWCODE_MODELS_JSON`과 임시 출력 경로를
  쓰거나, 생성 로직을 함수로 임포트해 문자열만 비교한다.

이 제약 때문에 가드는 로컬/메인테이너 환경에서만 실효가 있다. 그것으로 충분하다 —
드리프트는 소스를 가진 사람이 만들기 때문이다.

## 검증

### wp4에서 미리 확인한 사실 (재생성 예행)

wp4 실행 중 격리 확인으로 다음을 실측했다 (확인 후 `git checkout HEAD --`로 복원,
생성물은 커밋하지 않음):

```
JAWCODE_MODELS_JSON=/Users/jun/Developer/new/700_projects/jawcode/packages/ai/src/models.json \
  bun scripts/generate-jawcode-metadata.ts

-> ["MiniMax-M3",1000000,128000,"text,image,video",1,null,0.3,1.2,0.06,0]
                                 ^^^^^^^^^^^^^^^^^  video 실림
                                                     ^^^^^^^^^^^^^ 가격 불변 확인
-> input?: ("text" | "image" | "video")[];   인터페이스도 확장 반영
```

즉 wp4가 준비한 소스 + 타입 조합이 재생성 시 의도한 결과를 낸다는 것이 증명됐다.
wp5는 이 위에서 나머지 94모델 델타만 판정하면 된다.

**중요한 함정 (실측 중 발견)**: `JAWCODE_MODELS_JSON`을 지정하지 않으면 제너레이터는
`resolve(process.cwd(), "../jawcode/packages/ai/src/models.json")`을 쓴다
(`generate-jawcode-metadata.ts:22-24`). **워크트리에서 실행하면 이 경로가 존재하지 않는
디렉터리를 가리켜** throw한다(`:31-32`). 출력을 `>/dev/null 2>&1`로 숨기면 실패를
성공으로 오판하고 "video가 안 실렸다"는 잘못된 결론에 도달한다 — 실제로 이 라운드에서
한 번 겪었다. wp5에서는 **반드시 `JAWCODE_MODELS_JSON`을 명시**하고 stdout의
`wrote ... from ...` 줄로 어느 소스를 읽었는지 확인한다.

```bash
bun x tsc --noEmit
bun test tests/usage-cost.test.ts tests/codex-catalog.test.ts tests/provider-registry-parity.test.ts
bun test tests/slug-codec.test.ts tests/catalog-vision-sidecar-modalities.test.ts
bun test tests/jawcode-metadata-sync.test.ts
bun run generate:jawcode-metadata && git diff --exit-code src/generated/jawcode-model-metadata.ts
```

마지막 명령이 **재생성 멱등성** 게이트다 — 재동기화된 베이스라인 위에서는 이제
의미가 있다(wp4에서는 성립할 수 없었다).

비용 스위트가 63건 가격 변경으로 깨지면 **하나씩 화해**시킨다. 테스트를 느슨하게
고쳐 통과시키는 것은 금지 — 기대값이 왜 바뀌어야 하는지 근거를 남기고 갱신한다.

## 수용 기준

## 실행 결과 (wp5 사이클 1, 2026-07-30)

### 1. 델타 분류 — 미분류 0건 달성

`JAWCODE_MODELS_JSON`을 명시해 재생성한 뒤 필드 단위로 분류했다(JSON 파서로 행을
파싱해야 한다 — 정규식 쉼표 분할은 `"text,image"` 같은 값 때문에 오분류한다. 첫 시도가
그렇게 실패해 `modality 0`이라는 잘못된 결과를 냈다).

| 축 | 변경 필드 수 |
|----|-------------|
| price | 148 |
| maxTokens | 45 |
| context | 36 |
| modality | **1** |
| new model | 36 |
| removed | 0 |
| 미분류(other) | **0** |

**모달리티 변경은 우리 M3 수정 단 하나**다:
`minimax/MiniMax-M3:input 'text,image' -> 'text,image,video'`. 그 행의 가격
(`0.3,1.2,0.06,0`)은 불변임을 직접 확인했다.

### 2. 계획이 예측한 낙진 — 확인 및 정정

```
opencode-go/minimax-m3   contextWindow 1000000 -> 512000    (예측대로)
opencode-go/minimax-m3   maxTokens     131072  -> 128000    (추가 발견)
opencode-go/kimi-k3      신규 등장, context 1048576         (예측대로)
opencode-go/qwen3.5-plus contextWindow 262144  -> 1000000   (예측 못 한 항목)
```

정정: 감사 노트는 `kimi-k3`의 컨텍스트가 레지스트리(262,144)로 보호된다고 했는데,
`opencode-go` 카탈로그 테스트는 `kimi-k3`를 케이스에 포함하지 않으므로 이 실패와
무관하다. 실제 실패 원인은 `qwen3.5-plus`와 `minimax-m3`의 컨텍스트 변경이다.

### 3. 깨진 테스트 3건 — 전부 "기대값이 낡음", 회귀 아님

```
(fail) resolveMatchedPrice > claude-opus-5 resolves to the user-derived Opus 4.6 price ...
(fail) Codex catalog routed normalization > opencode-go high-risk models use official jawcode metadata ...
(fail) Codex catalog routed normalization > opencode-go catalog sync appends official rows missing from /v1/models
```

**(a) claude-opus-5 가격 출처 승격.** 재동기화로 `anthropic/claude-opus-5`가 신규
행으로 들어왔고 그 가격이 `5,25,0.5,6.25` — 테스트가 기대하는 값과 **정확히 동일**하다.
실제 해석 결과:

```
anthropic  source=jawcode  status=verified          cost4 {5,25,0.5,6.25}
cursor     source=expected status=verified-derived  cost4 {5,25,0.5,6.25}
kiro       source=expected status=verified-derived  cost4 {5,25,0.5,6.25}
```

즉 가격은 그대로이고 `anthropic`만 오버레이 추정치에서 **공식 jawcode 행으로 승격**됐다.
이건 개선이며, 테스트의 `source: "expected"` / `status: "verified-derived"` 기대가
낡았다. 오버레이 자체는 cursor·kiro에 여전히 필요하다.

**(b) opencode-go 컨텍스트 기대값.** 상위 소스가 `qwen3.5-plus`를 262,144 → 1,000,000로,
`minimax-m3`를 1,000,000 → 512,000으로 갱신했다. 테스트는 이전 값을 하드코딩한다.

### 4. 판정 — 이 사이클에서 재동기화를 커밋하지 않는다

세 테스트 모두 기대값 갱신으로 해소할 수 있지만, 그러려면 **각 숫자가 공식 근거를
갖는지 확인**해야 한다. #706에서 배운 교훈이 정확히 여기 적용된다 — 상위 소스의 숫자가
곧 정답은 아니다. 특히:

- `opencode-go/minimax-m3` 512,000: MiniMax 공식 ≤512K 티어와 일치해 보이나,
  opencode.ai Zen Go가 실제로 어느 한도를 서빙하는지는 별도 확인이 필요하다
- `qwen3.5-plus` 1,000,000: Alibaba 공식 사양 확인 필요
- `claude-opus-5` jawcode 가격: Anthropic 공식 가격 페이지가 Opus 5 가격을 공개했는지,
  아니면 jawcode가 4.6에서 추정한 것인지 확인 필요 (후자라면 `verified` 라벨이 과장)

가격 148필드도 같은 성격이다. 표본 확인 결과 EU 리전 프리미엄(`costIn 1 -> 1.1`,
`5 -> 5.5`) 같은 정당한 갱신 패턴이지만, 148건 전부를 근거와 대조하지 않았다.

따라서 이 사이클의 산출물은 **분류표와 판정 근거**이고, 실제 커밋은 각 숫자의 출처를
확인한 다음 사이클로 넘긴다. 생성물은 `git checkout HEAD --`로 복원했다.

### 5. 남은 작업 (다음 사이클)

## 사이클 2 결과 — 랜딩 완료 (2026-07-30)

`dev` `67c731e65`로 랜딩했고 CI 실행 `30509630276`이 6개 잡 전부 success다.

### 가격 148필드 판정 — "표본 신뢰"를 인과 설명으로 대체했다

입력가 배수 분포를 전수 계산해 각 변경의 성격을 규명했다.

| 배수 | 대상 | 판정 |
|------|------|------|
| x1.1 (정확) | `amazon-bedrock/eu.*` 4행 | AWS EU 리전 프리미엄 (1→1.1, 5→5.5, 25→27.5) |
| x0.909 | `eu.anthropic.claude-sonnet-4-6` | 같은 리전 표의 반대 방향 조정 |
| x1.0~x1.3 | openrouter 약 40행 | 마켓플레이스 실시간 가격 — 드리프트가 정상 상태 |
| **x5.0** | `google/gemini-flash-latest` | **별칭 재지정** (아래) |
| **x2.5** | `google/gemini-flash-lite-latest` | **별칭 재지정** |
| x2~x4 | `opencode-go/qwen3.5-plus`, `qwen3.6-plus`, `qwen3.7-plus` | 상위 카탈로그 갱신 |

두 outlier가 핵심이었다. `gemini-flash-latest`의 신규 값 `1.5/9/0.15`가
`gemini-3.5-flash` 행과 **바이트 단위로 동일**하다 — 즉 가격 인상이 아니라 `-latest`
별칭이 2.5-flash에서 3.5-flash로 재지정된 것이고, 별칭이 최신을 따라가는 건 옳은 동작이다.

### 실제 회귀 발견 — `hy3-preview` 부활 (측정 사이클이 놓친 것)

상위 소스가 `tencent/hy3-preview`를 다시 넣어(`models.json:22604`) 재생성 시
`opencode-go/hy3-preview`가 되살아났다. 이 모델은 이슈 #82에서
`Provider error 400 ... model_not_supported`를 낸 바로 그 모델이다.

더 중요한 사실: **트리에 필터가 없었다.** #82는 상위 소스에서 사라져 "자연 해소"된
것이었고, 되살아나자 그대로 재발했다. `EXCLUDED_MODELS`를 제너레이터에 추가해
향후 재추가에도 막히게 했다. `hy3`(preview 아님)는 선택 가능하게 유지한다.

### 기대값 갱신 2건 (근거 포함)

- `claude-opus-5`: 상위 소스가 `anthropic` 행을 `5/25/0.5/6.25`로 게시 — 메인테이너가
  파생한 값과 **동일**. 그래서 `anthropic`만 `expected/verified-derived` →
  `jawcode/verified`로 승격됐고, `cursor`/`kiro`는 자체 행이 없어 오버레이가 계속 필요하다.
  가격은 불변이고 출처만 전진했다.
- `opencode-go` 컨텍스트: `qwen3.5-plus` 262,144 → 1,000,000,
  `minimax-m3` 1,000,000 → 512,000(MiniMax 공식 ≤512K 구간과 일치).

### 드리프트 가드

`tests/jawcode-metadata-sync.test.ts` 추가. 임시 파일로 재생성해 바이트 비교하므로
커밋된 산출물을 덮어쓸 수 없다(`JAWCODE_METADATA_OUT` 신설). 소스가 없으면 skip —
제너레이터가 throw하므로 무조건 단정하면 컨트리뷰터와 CI가 전부 빨개진다. 드리프트는
소스를 가진 사람만 만들 수 있으니 그곳에서만 발화하면 충분하다.

양방향 검증: 동기화 상태 1 pass, 한 필드 변조 시 1 fail, 소스 부재 시 skip.

### 이 사이클에서 얻은 교훈

측정 사이클(사이클 1)이 "미분류 0건"을 달성했는데도 `hy3-preview` 회귀를 놓쳤다.
이유는 분류 축이 **필드 변경**만 봤고 "신규 모델 36개"를 한 덩어리로 처리했기 때문이다.
신규 항목은 개수가 아니라 **각각이 왜 새로 등장했는지** 물어야 한다 — 그중 하나가
과거에 의도적으로 배제한 모델일 수 있다.

1. 가격 148필드·컨텍스트 36·maxTokens 45의 출처를 벤더 문서와 대조 (또는 표본 검증 +
   나머지는 소스 신뢰로 명시적 판정)
2. 세 테스트의 기대값 갱신 — 근거를 커밋 메시지에 남긴다
3. 동기화 가드 추가 (`tests/jawcode-metadata-sync.test.ts`, 소스 부재 시 skip)
4. 재생성 커밋 + 멱등성 확인

- 95개 변경 행 전부가 분류되고 미분류 0
- 가격 63건 각각에 "채택" 또는 "현행 유지 + 근거" 판정이 있음
- 생성물에 `MiniMax-M3` → `text,image,video`가 실제로 나타남
- 재생성 두 번째 실행에서 `git diff --exit-code` clean (멱등)
- 동기화 가드 테스트가 존재하고, 소스 없는 환경에서 skip됨을 확인
- `tsc` exit 0 + 비용/카탈로그/파러티/슬러그 스위트 green
- `opencode-go/minimax-m3`의 컨텍스트 1,000,000 → 512,000에 대해 **명시적 판정**이
  기록됨 (512,000 수용 또는 `modelContextWindows` 오버라이드 추가). "레지스트리가
  보호하므로 안전"이라는 주장은 이 모델에 성립하지 않으므로 쓰지 않는다
- `opencode-go/kimi-k3`의 컨텍스트는 레지스트리 값 262,144를 유지함을 조립 결과로 확인

## 활성화 근거 (C-ACTIVATION-GROUNDING-01)

두 가지를 실제로 발화시켜 관측한다.

1. **video 모달리티 노출**: 생성물의 M3 행에서 `text,image,video`를 확인하고, 카탈로그
   조립을 거친 뒤 `inputModalities`에 `video`가 남는지 확인한다. 데이터가 파일에 있는
   것과 카탈로그가 노출하는 것은 다르므로 후자까지 본다.
2. **동기화 가드의 실패 경로**: 가드가 실제로 불일치를 잡는지 증명한다. 생성물을 임시로
   한 글자 바꿔 테스트가 **실패하는 것**을 확인한 뒤 복원한다. 통과만 확인하면
   "항상 통과하는 테스트"와 구별되지 않는다. 소스 부재 시 skip 경로도 별도로 밟는다.

## 범위 경계

- IN: 생성물 재동기화, 델타 분류·판정, M3 video 랜딩 확인, 동기화 가드 추가
- OUT: jawcode 상위 소스의 가격 수정(별건), MiniMax M3 카탈로그 가격 정책 변경,
  깨진 기대값을 근거 없이 느슨하게 고치기, 레지스트리 컨텍스트 오버라이드 변경
- OUT: **`video_url` 요청 파트 생성** — `src/`에 비디오 전송 경로가 없다는 사실은
  이 라운드에서 확인됐고(NEW-3), 카탈로그 광고와 와이어 구현은 별개다. 후속 이슈로
  분리해 추적한다. 이 사이클의 video 관련 주장은 "카탈로그가 광고한다"까지이며
  "비디오를 보낼 수 있다"가 아니다

## video 광고의 실제 실패 모드 (메인 세션 실측)

"광고만 하고 와이어가 없으면 사용자에게 무슨 일이 생기나"를 코드로 추적했다.

```
src/types.ts:122   export type OcxContentPart = OcxTextContent | OcxImageContent;
                   → 비디오 파트를 표현할 타입이 애초에 없다
src/responses/parser.ts:222-234
                   → 인바운드 파서는 output_text/text/input_text/refusal/input_image/
                     encrypted_content만 받고 그 외 블록은 조용히 버린다 (else 없음)
src/adapters/openai-chat.ts:164-166
                   → 파트 매핑은 `p.type === "image"`가 아니면 전부 텍스트로 취급하고
                     `(p as OcxTextContent).text`를 읽는다
```

판정: **조용한 무시(silent drop)** 다. 비디오 블록은 파서 단계에서 버려지므로
`openai-chat.ts`의 텍스트 캐스트까지 도달하지 않는다. 즉 업스트림 400/500 같은
요란한 실패는 나지 않고, 사용자는 "첨부는 받아들여졌는데 모델이 비디오를 못 본" 상태를
겪는다.

심각도 판단: 나쁜 크래시는 아니지만 **조용한 데이터 손실**이라 사용자 입장에서 더
헷갈릴 수 있다. 다만 이는 video 광고가 *새로* 만드는 문제가 아니라 비디오 파이프라인이
없다는 기존 사실의 노출이다. 그래서 wp5에서 광고 자체를 막지는 않되, **후속 이슈에
이 실패 모드를 명시**한다 — "타입 유니온 확장 + 파서 + `video_url` 생성"이 한 묶음이며
그 전까지 광고는 앞서 나간 상태로 남는다.

대안 판단(기록): 와이어가 준비될 때까지 `noVisionModels` 유사 장치로 비디오만 가리는
방법도 있으나, 그런 축이 현재 존재하지 않아(모달리티는 문자열 배열) 새 메커니즘을
만들어야 한다. 이번 라운드 범위를 넘으므로 채택하지 않고 후속으로 넘긴다.
