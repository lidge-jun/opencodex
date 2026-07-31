# 040 — WP1: 자격증명 경계 (A 감사 FAIL 반영 개정본)

`030_synthesis.md`가 첫 구현 사이클로 지목한 유닛. 여기 결함은 조용히 실패하고 그 실패가
위 계층 전부에 오진을 만들기 때문에 먼저 닫는다.

**초판은 A 감사에서 FAIL을 받았다.** 핵심 지적: "go provider flow가 이미 OAuth 오류 코드를
메시지에 담는다"는 초판의 전제가 **거짓**이었다. 그 전제 위에 세운 문자열 분류는 Kiro의
터미널 실패를 통째로 놓친다. 아래는 provider별로 실측한 뒤 다시 세운 계획이다.

## P 재검증: provider별 오류 메시지 실측

터미널 분류의 유일한 근거는 각 flow가 **실제로 반환하는 문자열**이다. 전수 확인했다.

| provider | 비-2xx 반환 문자열 | 코드가 들어가나 |
| --- | --- | --- |
| Anthropic | `safeOAuthHTTPError(op, status, body)` → `"%s failed: HTTP %d %s"`에 `error`+`error_description` 조인 (`providers.go:330-348`, 호출 `:222`) | **들어간다** |
| xAI | `payload.Error` 포함 (`xai.go:238-246`) | 들어간다 |
| GitHub Copilot | `invalid_grant`/`access_denied`/`expired_token`만 골라 포함 (`github_copilot.go:98-109`) | 들어간다 |
| **Kiro** | `"Kiro token refresh failed: HTTP %d"` — 본문을 읽고도 버린다 (`kiro.go:192-198`) | **안 들어간다** |
| Antigravity / Cursor / Kimi | 상태 코드만 | 안 들어간다 |

감사가 Anthropic도 미확인이라고 했으나, `safeOAuthHTTPError`를 직접 읽으니 본문의
`error`/`error_description`을 파싱해 메시지에 넣는다 — Anthropic·xAI·Copilot 세 provider는
문자열 층으로 충분하다. **Kiro만 소스에서 고쳐야 한다.** Antigravity/Cursor/Kimi는 이 사이클의
대상(Kiro·Copilot 배선)이 아니므로 범위 밖으로 명시하고 후속 유닛에 남긴다.

나머지 두 항목은 그대로 살아 있다:

```
internal/cli/oauth_guardian.go:26-41  switch: openai/chatgpt, anthropic, xai,
                                      google-antigravity, cursor, kimi  ← kiro/copilot 없음
internal/oauth/store_refresh.go:113   updated, err := refresh(...); if err != nil { return ..., err }
                                      ← 터미널 분류 없음, MarkNeedsReauth 호출 없음
```

## 감사가 정정한 것: Anthropic 풀 가드는 이미 있다

초판이 "go에 local-cli 채택 가드 없음"이라고 쓴 것은 **틀렸다**. `anthropic_pool.go:131-146`의
`credentialUsable`가 정확히 그 가드다 — 비-local-cli는 통과, 활성 local-cli는 통과, 그 외
local-cli는 토큰이 아직 유효할 때만 통과. `eligibleLocked`(`:148`)와
`accountUsableLocked`(`:167`)가 둘 다 호출한다. 주석도 "identity-adoption guard"라고 명시한다.

감사가 남은 절반으로 지목한 리졸버 측 게이팅(`authcontext.go:98-115`)도 확인한 결과
**도달 불가**다: `selectAccount`(`:134-137`)가 Anthropic 풀 경로에서 `selectAnthropicAccount`를
거치고, 그것이 `eligibleLocked`/`accountUsableLocked`를 통과한 계정만 반환한다. 만료된 배경
local-cli 슬롯은 애초에 선택되지 않으므로 `RefreshAccountIfGeneration`까지 가지 않는다.

**결론: 이 항목은 결함이 아니다.** `017_L8_oauth_providers.md`의 보안 발견 3번을 이 근거와 함께
반박 처리하고, 이 사이클에서 제거한다.

## 이 사이클이 다루는 것 (4건)

효과가 아니라 **의존 순서**로 잘랐다. 2번이 1번의 분류가 Kiro에서 동작할 수 있게 만들고,
4번이 1번의 호출 위치를 안전하게 못박는다.

### 1. 터미널 리프레시 실패가 `needsReauth`를 남긴다

오라클 `src/oauth/index.ts:297-311`(`isTerminalRefreshError`), `:305-311`(`terminal`),
`:433-435`(`markAccountNeedsReauthIfGeneration` 후 `OAuthLoginRequiredError`).

오라클은 두 층으로 판정한다. 타입이 있는 오류는 provider별로
(xAI: `invalid_grant`/`refresh_token_reused`/`revoked_token`; Anthropic: HTTP 400/401 +
같은 코드 집합; Kiro: HTTP 400/401 + oauthError 존재), 그 외에는 메시지 문자열로
(`invalid_grant`, `refresh_token_reused`, `revoked`, `access_denied`, `expired_token`).

**여기서 결정적인 것은 `HTTP 400/401` 게이트다.** 오라클은 코드가 있다는 사실만으로 터미널로
보지 않는다 — 상태 코드가 400이나 401일 때만 그렇게 본다. 이유는 명확하다: 업스트림이 일시적
5xx를 내면서 본문에 `{"error":"invalid_grant"}`를 담을 수 있고, 그것을 터미널로 처리하면
**멀쩡한 계정이 잠긴다**. 오분류 방향이 비대칭이라 게이트가 필수다.

go는 provider flow가 타입 있는 오류를 반환하지 않고 포맷된 문자열을 내므로, 이 게이트를
문자열 층에서 재현할 수 없다. 따라서 분류기는 **상태 코드를 아는 타입 있는 오류**를 받아야
한다. 초판이 제안한 provider-무관 문자열 스캔은 그 게이트를 잃어버린다.

NEW `go/internal/oauth/refresh_error.go`:

```go
package oauth

// TerminalRefreshError marks a refresh failure that retrying cannot fix: the
// grant was revoked, reused, or expired. Providers construct it only when the
// upstream said so with a 400 or 401 -- a 5xx carrying the same body code is a
// transient failure, and treating it as terminal locks a user out of a working
// account (oracle: src/oauth/index.ts:307-310 gates on httpStatus).
type TerminalRefreshError struct {
	Provider   string
	HTTPStatus int
	OAuthError string
	Err        error
}

func (e *TerminalRefreshError) Error() string { return e.Err.Error() }
func (e *TerminalRefreshError) Unwrap() error { return e.Err }

// NewRefreshHTTPError wraps a provider refresh failure, marking it terminal only
// when the status is 400/401 AND the body carried an allowlisted OAuth code.
// An unrecognized code is dropped rather than echoed, so an upstream body can
// never smuggle text into our error surface.
func NewRefreshHTTPError(provider string, status int, oauthError string, err error) error {
	code := allowlistedOAuthErrorCode(oauthError)
	if code == "" || (status != http.StatusBadRequest && status != http.StatusUnauthorized) {
		return err
	}
	return &TerminalRefreshError{Provider: provider, HTTPStatus: status, OAuthError: code, Err: err}
}

func allowlistedOAuthErrorCode(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "invalid_grant", "refresh_token_reused", "revoked", "revoked_token",
		"refresh_token_revoked", "access_denied", "expired_token":
		return strings.ToLower(strings.TrimSpace(value))
	}
	return ""
}

// IsTerminalRefreshError reports whether the failure is durable. A typed
// TerminalRefreshError is authoritative. The substring fallback exists only for
// flows that do not yet construct the typed error, and it deliberately does NOT
// fire on its own for status-bearing errors.
func IsTerminalRefreshError(err error) bool {
	if err == nil {
		return false
	}
	var terminal *TerminalRefreshError
	return errors.As(err, &terminal)
}
```

문자열 폴백을 뺀 이유: 상태 코드를 모르는 채로 코드 문자열만 보고 판정하면 감사가 지적한
5xx 오분류가 그대로 남는다. 게이트를 지키는 유일한 방법은 provider가 상태를 넘겨주는 것이다.

MODIFY provider flow **네 곳**이 그 오류를 만들게 한다. 대상은 **리프레시 경로만**이다 —
device authorization은 리프레시가 아니므로 건드리지 않는다.

먼저 공유 헬퍼가 코드를 돌려주게 한다. 현재 `safeOAuthHTTPError`(`providers.go:330-348`)는
파싱한 `parsed.Error`를 메시지에만 넣고 버린다. 코드를 함께 반환하도록 나눈다:

```go
// NEW, same file
func parseOAuthHTTPError(operation string, status int, body []byte) (error, string) {
	var parsed struct {
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
	}
	_ = json.Unmarshal(body, &parsed)
	// ... existing detail assembly, unchanged ...
	return fmt.Errorf("%s failed: HTTP %d %s", operation, status, detail), parsed.Error
}

// safeOAuthHTTPError keeps its current signature so non-refresh callers are
// untouched.
func safeOAuthHTTPError(operation string, status int, body []byte) error {
	err, _ := parseOAuthHTTPError(operation, status, body)
	return err
}
```

호출부별 지시(정확한 지점, 감사 라운드3 블로커 2):
+
| 위치 | 무엇인가 | 조치 |
| --- | --- | --- |
| `providers.go:120` | **ChatGPTFlow.postToken** (Anthropic 아님) | 감싼다. `openai`/`chatgpt`는 이미 배선된 refresher이므로 대상 |
| `providers.go:222` | AnthropicFlow.postToken | 감싼다 |
| `deviceflow.go:89` | device authorization | **감싸지 않는다.** 리프레시 경로가 아니다 |
| `github_copilot.go:98-109` | Copilot refresh, 이미 `payload.Error` 보유 | 그 자리에서 감싼다 |
| `xai.go:238-247` `safeXAITokenError` | xAI refresh (`xai.go:103-113` → `postToken` → `:180-182`) | 감싼다 |
| `kiro.go:192-198` | Kiro refresh | 2번 항목에서 감싼다 |

**xAI를 빠뜨리면 회귀다 (감사 라운드3 블로커 1).** `xai`는 `oauth_guardian.go:33-34`에서
이미 배선된 refresher이고, 오라클은 `index.ts:307-309`에서 xAI의
`invalid_grant`/`refresh_token_reused`/`revoked_token`을 터미널로 본다. 문자열 폴백을 없앤
상태에서 xAI를 타입 있는 오류로 감싸지 않으면 지금 되는 판정이 사라진다.

### 공유 `postToken`은 교환 경로와 리프레시 경로를 함께 쓴다 (감사 라운드4)

ChatGPT(`providers.go:93` 교환 / `:96-101` 리프레시), Anthropic(`:183-190` / `:193-198`),
xAI(`xai.go:83-100` / `:103-113`)는 **같은 `postToken`을 공유**한다. 오류 반환 지점에서
무조건 감싸면 로그인 교환 실패까지 "터미널 리프레시 실패" 타입이 된다. 오늘 그것이
`MarkNeedsReauth`까지 가지는 않지만, 타입의 의미가 틀리고 나중에 그 타입을 보는 코드가
생기면 진짜 문제가 된다.

그래서 감싸는 위치를 **리프레시 호출부로 한정**한다. `postToken`에 리프레시 여부를 넘긴다:

```go
// providers.go — ChatGPT
func (f *ChatGPTFlow) postToken(ctx context.Context, values url.Values, operation string,
	terminalRefreshProvider string) (OAuthCredentials, error) {
	...
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		err, code := parseOAuthHTTPError(operation, response.StatusCode, body)
		if terminalRefreshProvider != "" {
			// Only a refresh failure can be terminal. An authorization-code
			// exchange failing does not mean a stored grant died -- there is no
			// stored grant yet.
			return OAuthCredentials{}, NewRefreshHTTPError(terminalRefreshProvider, response.StatusCode, code, err)
		}
		return OAuthCredentials{}, err
	}
```

`Exchange` 계열은 `""`를, `Refresh` 계열은 provider 이름을 넘긴다. Anthropic과 xAI도 같은
모양으로 고친다(xAI는 `safeXAITokenError`가 코드를 함께 반환하게 나눈 뒤 리프레시 분기에서만
감싼다 — 헬퍼 안에서 감싸지 않는다).

Copilot과 Kiro는 `Refresh` 전용 경로라 그 자리에서 감싸도 안전하다.

MODIFY `go/internal/oauth/store_refresh.go`:

```go
// before (:112-115)
	updated, err := refresh(ctx, current.Refresh)
	if err != nil {
		return RefreshResult{}, err
	}

// after
	updated, err := refresh(ctx, current.Refresh)
	if err != nil {
		// A revoked or rotated-away grant cannot be recovered by retrying, so the
		// account has to carry that fact durably -- otherwise the resolver keeps
		// retrying a dead credential and the user never learns to re-login
		// (oracle: src/oauth/index.ts:432-435).
		if IsTerminalRefreshError(err) {
			_, _ = s.MarkNeedsReauth(ctx, provider, accountID, expected)
			return RefreshResult{}, ErrLoginRequired
		}
		return RefreshResult{}, err
	}
```

`RefreshAccount`(같은 파일 앞쪽)에도 같은 처리를 넣되 generation은 `currentGen`을 쓴다.

### 2. Kiro가 터미널 오류 코드를 버리지 않게 한다 (감사 블로커 1)

`kiro.go:192-198`은 본문을 읽고도 상태 코드만 담아 반환한다. 오라클은
`src/oauth/kiro.ts:412-422`에서 본문의 허용목록 OAuth 코드를 추출하고,
`index.ts:307-311`이 HTTP 400/401 + 코드 존재를 터미널로 본다. 문자열 분류가 Kiro에서
동작하려면 **그 코드가 메시지에 있어야** 한다.

MODIFY `go/internal/oauth/kiro.go`:

```go
// before (:196-198)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return OAuthCredentials{}, fmt.Errorf("Kiro token refresh failed: HTTP %d", response.StatusCode)
	}

// after
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		code := kiroOAuthErrorCode(responseBody)
		base := fmt.Errorf("Kiro token refresh failed: HTTP %d", response.StatusCode)
		if code != "" {
			base = fmt.Errorf("Kiro token refresh failed: HTTP %d: %s", response.StatusCode, code)
		}
		// NewRefreshHTTPError applies the oracle's 400/401 gate: the same body code
		// on a 5xx is a transient upstream failure, not a revoked grant.
		return OAuthCredentials{}, NewRefreshHTTPError("kiro", response.StatusCode, code, base)
	}
```

NEW helper in the same file:

```go
// kiroOAuthErrorCode pulls the OAuth error out of a Kiro refresh failure body.
// The allowlist lives in refresh_error.go; anything else is dropped so an
// upstream body cannot smuggle text into our error surface
// (oracle: src/oauth/kiro.ts:412-422).
func kiroOAuthErrorCode(body []byte) string {
	var parsed struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(body, &parsed) != nil {
		return ""
	}
	return allowlistedOAuthErrorCode(parsed.Error)
}
```

허용목록이 본문 텍스트 유출을 막고, 400/401 게이트가 5xx 오분류를 막는다. 코드가 메시지에
실리는 것은 진단용이고, 터미널 판정의 근거는 타입 있는 오류다.

### 3. GitHub Copilot 리프레시 배선 (Kiro 배선은 이 사이클에서 뺀다)

**Copilot은 그대로 간다.** 감사가 확인해준 대로 `GithubCopilotFlow.Refresh(ctx, durableGrant string)`
(`github_copilot.go:75-117`)는 `RefreshFunc`(`types.go:94`)와 시그니처가 일치하고 생성자는
`NewGithubCopilotFlow`(`github_copilot.go:34-39`)다. 초판이 "P 실행 시 확인"으로 남긴 불확실성은
해소됐다.

MODIFY `go/internal/cli/oauth_guardian.go` switch:

```go
		case "github-copilot":
			refresh = oauth.NewGithubCopilotFlow(client).Refresh
```

컴파일 타임 보증을 함께 넣는다:

```go
var _ oauth.RefreshFunc = (&oauth.GithubCopilotFlow{}).Refresh
```

**Kiro 배선은 철회한다 (감사 블로커 5).** 초판의 어댑터는 `KiroImportedCredential`에 refresh
토큰만 채우는데, `NewKiroFlow`가 `Region: "us-east-1"`을 기본으로 넣으므로
(`kiro.go:38-42`, `:169-175`) 저장된 계정의 실제 리전과 무관하게 **항상**
`prod.us-east-1.auth.desktop.kiro.dev`로 POST한다. `aws_sso_oidc` 자격증명이면 OIDC 메타데이터
없이 엉뚱한 엔드포인트를 두드리고, 그 실패가 1번의 터미널 분류와 만나면 **어댑터가 만든 실패
때문에 계정이 재인증 필요로 표시된다.** 리프레시를 안 하는 것보다 나쁘다.
+
전제 조건: `OAuthCredentials`가 Kiro 메타데이터(`AuthType`/`ClientID`/`ClientSecret`/
`SSORegion`/`APIRegion`)를 저장·복원해야 한다. 그것은 저장 스키마 변경이라 별도 유닛이다.
`wp1b-credentials`에 "Kiro 자격증명 메타데이터 영속화 후 요청시 리프레시 배선"으로 append한다.

### 4. 락 순서 계약 (감사 블로커 7)

`MarkNeedsReauth`(`store.go:334`)는 내부에서 `s.mutate`를 부르고, `mutate`는
`s.path+".lock"`을 잡는다(`store.go:144-149`). 리프레시 경로가 잡고 있는 것은
`s.refreshLockPath(provider, accountID)`(`store_refresh.go:211-215`)로 **다른 락**이므로
자기 교착은 없다. 다만 이 안전성은 호출 위치에 의존하므로 계약으로 못박는다:
**`MarkNeedsReauth`는 refresh-intent 락 아래에서만 호출하고, `s.mutate` 콜백 안에서는 절대
호출하지 않는다.**

generation 인자도 확인했다: `RefreshAccount`는 `currentGen`(`:48-55`),
`RefreshAccountIfGeneration`은 `expected`(`:103-110`) — 둘 다 락 획득 후 계산한 값이고
`beginRefresh`/`mergeRefreshed`에 넘기는 것과 같다.

## 이 사이클이 다루지 않는 것 (`wp1b-credentials`로 이월)

- Kiro 자격증명 메타데이터 영속화 + 요청시 리프레시 배선 (위 3번에서 철회)
- Antigravity/Cursor/Kimi의 상태 코드만 반환하는 오류 경로 (같은 계열 후속 작업)
- API 키 429 transport 재구성, Kiro 강제 로그인 롤백, pre-multiauth 백업,
  Copilot base URL 허용목록

## 검증 계획

- `go build ./... && go vet ./...`
- NEW `go/internal/oauth/refresh_error_test.go`: `NewRefreshHTTPError`의 상태 게이트와
  허용목록. **음성 사례 필수** — 5xx + 허용 코드, 400 + 비허용 코드, 코드 없는 400은 전부
  비터미널이어야 한다.
- **provider flow 활성화 테스트 (감사 블로커 9, C-ACTIVATION-GROUNDING-01).** 합성
  `errors.New("invalid_grant")`로는 부족하다. stub `HTTPDoer`로 실제 flow를 구동한다:
  - Kiro 400 + `{"error":"invalid_grant"}` → 터미널
  - **Kiro 500 + `{"error":"invalid_grant"}` → 비터미널** (감사 라운드2 블로커 1: 이 사례가
    터미널로 분류되면 일시적 업스트림 장애가 사용자를 계정에서 잠근다)
  - **Anthropic 500 + `{"error":"invalid_grant"}` → 비터미널** (같은 이유)
  - Kiro 네트워크 실패 → 비터미널
  - Copilot 400 `invalid_grant` → 터미널
  - **xAI 400 `invalid_grant` → 터미널, xAI 500 `invalid_grant` → 비터미널** (감사 라운드3
    블로커 1: 폴백 제거가 만든 회귀를 막는 증거)
  - Anthropic 400 + `{"error":"invalid_grant"}` → 터미널
  - Kiro 400 + `{"error":"something_else"}` → 코드가 드롭되고 비터미널
- device authorization 경로(`deviceflow.go:89`)가 `TerminalRefreshError`를 만들지 않는지.
- **교환 경로 음성 테스트 (감사 라운드4)**: ChatGPT / Anthropic / xAI의 authorization-code
  교환이 400 + `invalid_grant`로 실패해도 `TerminalRefreshError`가 되지 않는지.
- 저장소 통합: refresh가 터미널 오류를 반환하면 계정이 `NeedsReauth=true`가 되고
  `ErrLoginRequired`가 나오는지. 비터미널이면 표시되지 않는지.
- NEW `oauth_guardian` 테스트: `github-copilot` provider 설정에서 refresher가 반환되고,
  `kiro`는 (의도적으로) 반환되지 않는지.
- 라이브 OAuth 호출은 하지 않는다.

## 범위 밖

실제 로그인/토큰 갱신 네트워크 호출, 자격증명 파일 열람, 오라클 수정.
