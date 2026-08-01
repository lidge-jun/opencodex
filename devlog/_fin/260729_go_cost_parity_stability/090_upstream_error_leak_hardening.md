# 090 — work-phase 10: 업스트림 에러 본문 유출 강화

근거: `002`의 남은 구멍 3번.

## 문제

업스트림이 비2xx를 반환하면 본문을 잘라 리댁션한 뒤 **클라이언트에게 그대로 전달**한다
(`go/internal/server/responses_core_port.go:523-527`):

```go
	message := string(clientPayload)
	...
	message = ocxlib.RedactSecretString(message)
```

이 문자열이 `writeClassifiedJSONError`로 클라이언트에 나간다(`:1149`).

패스스루 자체는 합리적이다 — 프로바이더 에러 메시지는 디버깅에 필요하다. 문제는
**리댁터가 무엇을 놓치는가**이고, 그건 추측할 게 아니라 읽으면 나온다.

## 리댁터 실측

`ocxlib.RedactSecretString`(`go/internal/lib/redact.go:22-26`)은 3단계다:

```go
func RedactSecretString(value string) string {
	value = copilotTokenPattern.ReplaceAllString(value, RedactedSecret)
	value = awsARNPattern.ReplaceAllString(value, RedactedSecret)
	return config.RedactString(value)
}
```

`config.RedactString`(`go/internal/config/redact.go:20-26`)이 4개 패턴을 더 적용한다.
전체 커버리지는 다음과 같다.

### 잡는 것

| 패턴 | 정의 | 예 |
| --- | --- | --- |
| Copilot 토큰 | `redact.go:15` `\btid=[A-Za-z0-9-]+...` | `tid=abc;exp=1;...` |
| AWS ARN | `redact.go:16` `\barn:aws:...:\d{12}:...` | `arn:aws:iam::123456789012:role/x` |
| Bearer | `config/redact.go:14` `\bBearer\s+[A-Za-z0-9._~+/=-]{8,}` | `Bearer eyJhbGci...` |
| OpenAI 계열 | `config/redact.go:15` `sk-[A-Za-z0-9][A-Za-z0-9._-]{6,}` | `sk-proj-...`, `sk-ant-...` |
| GitHub | 같은 줄 `gh[pousr]_[A-Za-z0-9_]{8,}`, `github_pat_[A-Za-z0-9_]{20,}` | `ghp_...`, `gho_...` |
| `key=value` 형태 | `config/redact.go:16` `\b(api[_-]?key|access[_-]?token|...)=(...)` | `api_key=abc123` |
| JSON 필드 | `config/redact.go:17` `("token"\|"apiKey"\|...)\s*:\s*"..."` | `{"access_token":"..."}` |

`sk-ant-`는 `sk-` 패턴에 포함되므로 별도 처리가 필요 없다. 확인됨.

### 놓치는 것

opencodex가 실제로 라우팅하는 프로바이더 기준으로 골랐다. 가상의 형식이 아니다.

| 형식 | 예 | 왜 안 잡히나 | 관련 프로바이더 |
| --- | --- | --- | --- |
| Google OAuth 액세스 토큰 | `ya29.a0AfB_by...` | `sk-`/`gh` 접두 아님. `Bearer` 없이 본문에 노출되면 통과 | google, google-antigravity, gemini |
| 맨몸 JWT | `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIx.abc` | `Bearer` 접두가 있어야만 잡힘 | 다수 OAuth 경로 |
| Google API 키 | `AIzaSyA...` (39자) | 해당 패턴 없음 | google |
| AWS 액세스 키 ID | `AKIAIOSFODNN7EXAMPLE` | ARN 패턴만 있고 키 ID는 없음 | amazon-bedrock, kiro |
| AWS 시크릿 액세스 키 | 40자 base64류 | 해당 패턴 없음 | amazon-bedrock, kiro |
| xAI 키 | `xai-...` | `sk-` 아님 | xai |
| Anthropic admin 키 | `sk-ant-admin...` | (잡힘 — `sk-` 포함) | — |
| JSON 필드명 변형 | `{"authorization":"..."}`, `{"sessionToken":"..."}` | `jsonSecretPattern` 키 목록에 없음 | 다수 |
| 쿼리스트링 내 키 | `?key=AIza...` | `assignmentPattern`의 키 목록에 `key` 단독이 없다 | google (`?key=` 관행) |

마지막 항목이 특히 중요하다. Google API는 `?key=<API_KEY>` 관행을 쓰는데
`assignmentPattern`(`config/redact.go:16`)의 키 목록은
`api[_-]?key|access[_-]?token|...|token|secret|password`이고 **`key` 단독은 없다**.
업스트림 에러가 요청 URL을 에코하면 그대로 나간다.

## 파일 변경 지도

| 파일 | 종류 | 위치 |
| --- | --- | --- |
| `go/internal/config/redact.go` | MODIFY | `secretTokenPattern`(15), `assignmentPattern`(16), `jsonSecretPattern`(17) |
| `go/internal/lib/redact.go` | MODIFY | 신규 패턴 추가(14-20 블록) |
| `go/internal/config/redact_test.go` | MODIFY/NEW | 형식별 회귀 |

리댁터를 고치면 `RedactHeaders`(`lib/redact.go:53`)와 `RedactSecrets`(`:28`)도 함께
강해진다 — 같은 함수를 타기 때문이다.

## 변경

`go/internal/lib/redact.go`의 var 블록에 추가:

```go
	// Provider credential shapes the shared redactor did not cover. Each entry
	// corresponds to a provider opencodex actually routes to (devlog 260729 090):
	googleOAuthPattern = regexp.MustCompile(`\bya29\.[A-Za-z0-9._-]{10,}`)
	googleAPIKeyPattern = regexp.MustCompile(`\bAIza[A-Za-z0-9_-]{35}\b`)
	awsAccessKeyPattern = regexp.MustCompile(`\b(?:AKIA|ASIA|AROA|AIDA)[A-Z0-9]{16}\b`)
	xaiKeyPattern       = regexp.MustCompile(`\bxai-[A-Za-z0-9]{16,}\b`)
	bareJWTPattern      = regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`)
```

`RedactSecretString`에 체이닝:

```go
func RedactSecretString(value string) string {
	value = copilotTokenPattern.ReplaceAllString(value, RedactedSecret)
	value = awsARNPattern.ReplaceAllString(value, RedactedSecret)
	value = googleOAuthPattern.ReplaceAllString(value, RedactedSecret)
	value = googleAPIKeyPattern.ReplaceAllString(value, RedactedSecret)
	value = awsAccessKeyPattern.ReplaceAllString(value, RedactedSecret)
	value = xaiKeyPattern.ReplaceAllString(value, RedactedSecret)
	value = bareJWTPattern.ReplaceAllString(value, RedactedSecret)
	return config.RedactString(value)
}
```

`config/redact.go:16`의 `assignmentPattern`에 `key` 단독을 추가한다.
다만 `key=` 는 일반 단어라 오탐이 크다 — `\bkey=` 대신 값 형태로 제한한다:

```go
	// `?key=AIza...` is Google's documented API-key form; matching bare `key=`
	// would redact ordinary prose, so the value shape carries the specificity.
	googleQueryKeyPattern = regexp.MustCompile(`(?i)\bkey=(AIza[A-Za-z0-9_-]{35})`)
```

`jsonSecretPattern`(`config/redact.go:17`)의 키 목록에 `authorization`,
`sessionToken`, `session_token`, `apiSecret`을 추가한다.

## 오탐 정책

리댁션은 과하면 디버깅을 죽인다. 두 규칙을 지킨다.

- 접두어와 길이가 **둘 다** 특정적인 패턴만 넣는다. `AIza`+35자, `AKIA`+16자처럼.
- 순수 길이 기반 패턴(예: "40자 hex는 전부 시크릿")은 넣지 않는다. 커밋 SHA, 해시,
  요청 ID가 전부 걸린다. AWS 시크릿 액세스 키를 이 사이클에서 다루지 않는 이유가 그것이다 —
  형태가 일반 base64라 안전한 정규식이 없다. **의도적 미해결로 문서에 남긴다.**

## 활성화 시나리오 (C-ACTIVATION-GROUNDING-01)

트리거: 각 형식이 박힌 가짜 업스트림 에러 본문을 만들어 실제 에러 경로에 태운다.
`httptest` 업스트림이 비2xx + 자격증명이 섞인 본문을 반환하게 하고,
`responses_core_port`가 클라이언트에 쓴 바이트를 읽는다.

발화 증명 (형식별로 각각):

1. 응답 바이트에 원본 자격증명 문자열이 **포함되지 않는다**.
2. 응답 바이트에 `[REDACTED]`가 **포함된다** — 리댁션이 실제로 일어났고,
   단순히 본문이 잘려서 사라진 게 아니라는 증거.
3. 자격증명 주변의 산문(예: `"invalid api key provided:"`)은 **보존된다** —
   과잉 리댁션이 아니라는 증거.

3번이 중요하다. 1·2만 보면 "본문 전체를 `[REDACTED]`로 치환"해도 통과한다.

오탐 회귀: 커밋 SHA(40자 hex), UUID, 요청 ID `ocx-19fad9151b1-3`,
일반 문장이 **변형되지 않는지** 단언한다.

## 테스트

`go/internal/config/redact_test.go` / `go/internal/lib/redact_test.go`:

- `TestRedactGoogleOAuthToken`, `TestRedactGoogleAPIKey`, `TestRedactAWSAccessKeyID`,
  `TestRedactXAIKey`, `TestRedactBareJWT`, `TestRedactGoogleQueryKey`
- `TestRedactPreservesSurroundingProse`
- `TestRedactDoesNotTouchCommitShaOrRequestID`

`go/internal/server/`:

- `TestUpstreamErrorBodyRedactedEndToEnd` — 실제 에러 경로 통과

```bash
cd go && go test ./internal/config/... ./internal/lib/... ./internal/server/... -count=1 -v
cd go && go build ./... && go vet ./... && go test ./... -count=1
```

`privacy:scan`도 돌린다(레포 CI 게이트): `bun run privacy:scan`.

## 위험

- **정규식 비용.** 리댁터가 에러 경로마다 7개 패턴을 더 돈다. 에러 경로는 핫패스가
  아니지만 `RedactHeaders`는 로깅에서 자주 불린다. 벤치마크로 확인하고, 문제되면
  전체 패턴을 하나의 alternation으로 합친다.
- **기존 테스트 기대값.** 리댁션이 강해지면 기존 스냅샷이 깨질 수 있다. 깨진 것이
  실제로 자격증명이었다면 그 스냅샷이 **유출을 고정하고 있었다는 뜻**이다. 확인하고 갱신한다.
- AWS 시크릿 액세스 키는 이번에 다루지 않는다(위 오탐 정책). 후속 후보로 남긴다.

## 완료 기준

6개 형식이 각각 리댁션되고, 산문이 보존되며, SHA/UUID/요청 ID가 무변형이고,
`privacy:scan`이 초록이다.
