# 001 — 실측 증거: GPT-5.6 네이티브 컨텍스트 상한

측정 시각: 2026-08-17 (KST). 자격증명: `~/.opencodex/auth.json` chatgpt 계정 1개(Codex login).
프로브 스크립트는 스크래치(`/tmp/ocxprobe/`)에서 실행했고 저장소에 남기지 않았다.
토큰 값은 어디에도 기록하지 않는다.

## E1 — 라이브 네이티브 카탈로그 응답

`GET https://chatgpt.com/backend-api/codex/models?client_version=<v>`
(Authorization: Bearer <Codex login>, originator codex_cli_rs).

`client_version` 쿼리는 필수다. 없으면 400
`{'type': 'missing', 'loc': ('query', 'client_version')}`.

| client_version | 반환 모델 수 |
| --- | --- |
| 0.60.0 | 0 |
| 0.142.2 | 5 |
| 0.144.0 이상 (0.146 / 0.150 / 0.155 / 0.160 / 0.170 / 0.180 / 1.0.0) | 8 |

0.144.0 이상에서 반환되는 gpt-5.6 행 (모든 버전 동일):

```
slug            context_window   max_context_window   minimal_client_version
gpt-5.6-sol     272000           872000               0.144.0
gpt-5.6-terra   272000           872000               0.144.0
gpt-5.6-luna    272000           872000               0.144.0
gpt-5.5         272000           272000               0.124.0
gpt-5.4         272000           1000000              0.98.0
gpt-5.4-mini    272000           272000               0.98.0
gpt-5.3-codex-spark  128000      128000               0.100.0
codex-auto-review    272000      872000               0.98.0
```

관측 사실: 라이브 upstream은 372,000을 **어디에서도 반환하지 않는다**. 번들 스냅샷
`src/codex/data/upstream-models.json`과 `NATIVE_GPT56_CONTEXT_WINDOW`의 372,000은
과거 PR #31684 스냅샷 값이며 현재 라이브와 불일치한다.

## E2 — 실제 요청으로 측정한 입력 상한

`POST https://chatgpt.com/backend-api/codex/responses`, stream=true, store=false.
단일 `input_text`에 필러 텍스트를 채우고 `response.completed`의
`usage.input_tokens` 또는 `response.failed`의 `error.code`를 읽었다.

gpt-5.6-sol:

| 요청 규모 | 결과 |
| --- | --- |
| input_tokens 342,880 | 성공 |
| input_tokens 771,448 | 성공 |
| input_tokens 900,028 | 성공 |
| input_tokens 912,688 | 성공 |
| input_tokens 919,012 | 성공 |
| input_tokens 920,680 | 성공 |
| **input_tokens 921,508** | **성공 (관측된 최대)** |
| 목표 922,013 | `context_length_exceeded` |
| 목표 925,014 / 950,000 / 1,000,000 / 1,020,000 / 1,040,000 / 1,200,000 | `context_length_exceeded` |

gpt-5.6-terra / gpt-5.6-luna:

| 모델 | 결과 |
| --- | --- |
| gpt-5.6-terra | input_tokens 900,028 성공 / 목표 1.2M `context_length_exceeded` |
| gpt-5.6-luna | input_tokens 900,028 성공 / 목표 1.2M `context_length_exceeded` |

실패 메시지는 세 모델 모두 동일하다:
`"Your input exceeds the context window of this model. Please adjust your input and try again."`

## E3 — 측정값의 해석

관측된 최대 입력 921,508은 저장소가 이미 API 키 경로에 대해 선언한 값과 정확히 맞는다.

- `src/providers/registry.ts:338` `OPENAI_API_GPT56_CONTEXT_WINDOW = 1_050_000`
- `src/providers/registry.ts:344` GPT-5.6 계열 `maxInputTokens = 922_000`

즉 총 컨텍스트 1,050,000 = 입력 922,000 + 출력 128,000이고, 측정된 실패 경계
(921,508 성공 / 922,013 실패)가 922,000을 사이에 두고 갈린다. Codex-login 네이티브
경로도 같은 모델 계약을 쓴다는 것이 이 측정의 결론이다.

라이브 필드 `max_context_window: 872000`은 측정된 입력 상한 922k보다도 작으므로,
"실제로 넣을 수 있는 최대"를 뜻하는 값이 아니다. 클라이언트 측 표시/컴팩션 힌트로 보는 것이
관측과 모순이 없다.

## E4 — 채택하는 계약

| 필드 | 값 | 근거 |
| --- | --- | --- |
| context_window | 1,050,000 | E3, registry API 계약과 동일 |
| max_context_window | 1,050,000 | 네이티브 override 구조가 두 필드를 같은 광고 단위로 다룸 |
| auto_compact_token_limit | 922,000 | E2 측정 상한. `floor(1.05M*0.9)=945,000`은 **측정 상한 초과**라 사용 불가 |

945,000을 쓰면 클라이언트가 컴팩션 전에 922k를 넘겨 `context_length_exceeded`를 맞는다.
이것이 이 유닛에서 상수 한 개만 바꾸면 안 되는 첫 번째 이유다.

