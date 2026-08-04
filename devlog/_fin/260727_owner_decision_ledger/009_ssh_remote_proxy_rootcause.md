# 009 — SSH 원격 프록시 "아예 안 됨" 근본 원인

확정: 2026-07-28. 오너가 증상을 `008`의 C2(SSH 원격 프록시)로 지목.
기준: `dev` @ `5f76d583a`

**제출됨: [#570](https://github.com/lidge-jun/opencodex/issues/570)** — 이 문서의
검증된 내용을 하드닝 계획 6항목으로 정리해 공개 이슈로 올렸다(라벨 `bug`).

## 결론 (한 줄)

**`isLoopbackRequestHost`가 "루프백 호스트"와 "포트가 서버 자기 포트와 같음"을
한 조건으로 묶어놨다.** `ssh -L`로 **포트를 바꿔** 포워딩하면 이 판정이 거짓이
되고, 관리 API와 `/v1/*` 데이터 플레인이 403으로 막힌다.

> **정정 (2차 감사).** 초안은 "SSH 원격이 전부 깨진다"고 썼으나 **틀렸다.**
> **동일 포트 포워딩(`ssh -L 10100:localhost:10100`)은 지금도 정상 동작한다.**
> 깨지는 건 **포트를 바꾸는 포워딩**뿐이다. 아래 재현 참조.

## 재현 (실측, 실제 서버 기동)

`startServer(0)`으로 루프백 바인드 서버를 띄우고 Host 헤더만 바꿔 측정:

```
SAME-PORT | GET /v1/models  | Host=localhost:56030 -> 200
SAME-PORT | GET /api/config | Host=localhost:56030 -> 200
REMAP     | GET /v1/models  | Host=localhost:29999 -> 403
REMAP     | GET /api/config | Host=localhost:29999 -> 403
REMAP     | GET /healthz    | Host=localhost:29999 -> 200
REMAP     | GET /           | Host=localhost:29999 -> 200
ALIAS     | GET /api/config | Host=myhost.lan:56030 -> 403
```

읽는 법:

- **동일 포트 포워딩은 문제없다.** `ssh -L 10100:localhost:10100`은 지금도 된다
- **포트를 바꾸면** 데이터 플레인과 관리 API가 전부 403
- `/`와 `/healthz`는 통과 → **대시보드 HTML은 뜨는데 모든 API 호출이 죽는다.**
  사용자 눈에는 "켜졌는데 아무것도 안 됨"으로 보인다
- **호스트 별칭(`myhost.lan`)은 포트가 같아도 거부된다** — 포트 조건만 풀어도
  Tailscale·mDNS·devcontainer 이름으로 접근하는 경로는 여전히 막힌다

Origin 헤더 유무와 무관하게 거부되므로 CORS 문제가 아니다 — Codex CLI·Claude
Code·curl도 똑같이 막힌다.

## 코드 경로

```
src/server/auth-cors.ts:34-39   isLoopbackRequestHost()
  → parsed.port === "" || parsed.port === configuredPort()   ← 여기가 원인
src/server/auth-cors.ts:60-77   isAllowedRequestOrigin()
  → isLoopbackRequestHost(Host) 가 false면 Origin 유무와 무관하게 거부
```

`isAllowedRequestOrigin`이 걸린 지점은 관리 API만이 아니다:

| 경로 | 위치 |
| --- | --- |
| `/v1/models` | `src/server/index.ts:373` |
| `/v1/responses` (POST) | `:518` |
| `/v1/responses/compact` | `:443` |
| `/v1/messages`, `count_tokens` | `:558`, `:573` |
| `/v1/chat/completions` | `:595` |
| `/v1/live`, realtime WS | `:618`, `:646` |
| Responses WebSocket upgrade | `:336` |

**데이터 플레인이 전부 같은 게이트 뒤에 있다.** 이것이 "아예 작동 안 된다"의
기계적 이유다.

## 같이 깨지는 두 번째 것 — OAuth 콜백

```
src/oauth/chatgpt.ts:9      const CALLBACK_PORT = 1455;
src/oauth/chatgpt.ts:67-71  redirectUri: `http://localhost:1455/auth/callback` (고정)
src/oauth/callback-server.ts:126-140  redirectUri가 있으면 랜덤 포트 폴백 비활성
```

콜백 리스너는 **원격 머신의** `localhost:1455`에 뜬다. 사용자는 보통 프록시
포트(10100)만 포워딩하므로 1455는 도달 불가다. 게다가 이걸 구제할 수동 코드
입력 경로(`/api/oauth/login/code`)가 **위와 같은 게이트 뒤에 있다** — 폴백이
필요한 바로 그 상황에서 폴백에 접근할 수 없다.

## 008의 오판 정정

| 008 기재 | 실제 |
| --- | --- |
| C2 = "저장소가 이 구성을 모델링하지 않음" (빈 땅) | **틀림.** `docs-site/.../configuration.md:139-168`에 "## Remote access" 절이 있다. 원격 접근은 모델링돼 있고, 미모델링인 건 **포트가 다른 SSH 로컬 포워딩** 하나다 |
| C2 강도 = "중" | **높음.** 데이터 플레인 전체 차단 |
| C1과 C2는 택일 | **아니다.** 원격 토폴로지는 로그인과 데이터 플레인을 각각 독립적으로 깬다 |
| C3(WSL2)의 해법은 `hostname` 설정 | **부분 정정.** 인증이 켜지는 건 맞다. 그러나 "Codex CLI가 그 헤더를 못 보낸다"는 **틀렸다** — `src/codex/inject.ts:101-120` `shouldInjectApiAuthHeader()`가 비루프백 바인드에서 `env_http_headers = { "x-opencodex-api-key" = ... }`를 provider table에 주입한다. 설계상 보낸다. 또한 `Authorization: Bearer` 수용은 PR #496에서 이미 **거부된 방향**이다(`auth-cors.ts:181-185`: 두 bearer 도메인 혼동 방지) |

## 술어를 고쳐도 남는 별개 장애물

포트 조건만 풀면 "이제 된다"고 말할 수 없다. 독립적으로 막는 것들:

| 장애물 | 근거 |
| --- | --- |
| 호스트 별칭 전면 거부 | 위 재현의 `ALIAS` 행. 루프백 이름이 아니면 포트가 같아도 403 |
| 대시보드가 알려주는 주소가 틀림 | `src/server/management/api-access.ts:72-75`는 **wildcard 바인드일 때만** 요청 Host를 반영한다. SSH 포워딩은 `127.0.0.1` 바인드라 원격 머신의 루프백 주소를 그대로 돌려준다. `gui/src/pages/api-keys-utils.ts:18-24`도 `http://127.0.0.1:10100/v1` 하드코딩 |
| 루프백 모드엔 인증 자체가 없음 | `auth-cors.ts:122-124` — 루프백 바인드면 `isApiAuthRequired`가 false이고 토큰을 켤 방법이 없다. 즉 완화는 중립이 아니다: `ssh -g -L`·devcontainer·Codespaces 포워딩은 이미 인증 없는 `/api/*` 접근을 준다 |

## 보안 경계 분류

`.github/CODEOWNERS`에서 `/src/server/auth-cors.ts`는 "Authentication,
credentials, and management API" 항목으로 `@lidge-jun @Ingwannu` 소유다.
`MAINTAINERS.md:29-30`과 `AGENTS.md`의 "Security boundary (highest priority)"에
따라 **명시적 보안 리뷰 대상**이다. 작은 술어 수정으로 다뤄선 안 된다.

## 테스트 공백 (정정)

초안은 "회귀 테스트 0건"이라고 썼으나 **이름 grep의 거짓 음성이었다.**
실제로는 종단 테스트가 있다:

- `tests/server-auth.test.ts:582-602` — "loopback management API rejects
  host-header same-origin rebinding". `Host: attacker.test:<port>` → 403 기대
- `tests/server-auth.test.ts:640-660` — 비루프백 바인드 + `x-opencodex-api-key` → 200

진짜 공백은 더 좁고 정확하다: **포트 동일성 절(`parsed.port === configuredPort()`)
만 겨냥한 테스트가 없다.** 그리고 위 rebinding 테스트가 존재하므로, 완화 작업은
**그 테스트를 깨지 않는 선에서만** 가능하다 — 이게 설계 제약이다.

## 이 조건은 왜 생겼나 (이력 확정)

```
c29ee783e (06-27) "harden opencodex release and runtime paths"
  → isLoopbackRequestHost(Host)와 isLoopbackOriginValue(Origin) 양쪽에
    포트 동일성 조건을 동시에 도입
e4e06125b (07-05) "fix: allow CORS from any loopback origin regardless of port"
  → Origin 쪽만 포트 무관으로 완화. 사유: "localhost 다른 포트에서 도는
    브라우저 앱(:6001 등)이 프록시에 요청 못 함"
  → Host 쪽(isLoopbackRequestHost)은 손대지 않음
```

즉 **DNS rebinding 전용 방어가 아니라 "대시보드와 동일 오리진"이라는 신뢰
규칙이었고, 07-05에 Origin만 완화되며 두 판정이 불일치 상태로 남았다.**
동일한 완화 논거가 Host에도 그대로 적용된다 — 이건 추측이 아니라 이력이다.

## 부수 확인

- GUI 요청 계층은 문제없다 — `gui/src/api.ts:4-13`이 `window.location` 상대
  경로를 쓴다. 다만 사용자에게 보여주는 복사용 스니펫은 `http://127.0.0.1:10100`을
  하드코딩한다(`gui/src/pages/api-keys-utils.ts:19-23`) — 포워딩 환경에서 틀린 안내.
- `ocx status`/`doctor`는 원격을 모른다. PID가 안 맞으면 **로컬** `127.0.0.1:<port>`를
  조용히 찌른다(`src/cli/status.ts:88-104`, `src/server/proxy-liveness.ts:46-51`) —
  에러가 아니라 **잘못된 보고**를 낸다.
- `assertServerAuthConfig`는 이 시나리오에서 발동하지 않는다. `ssh -L`은 원격
  프록시를 루프백에 그대로 두기 때문이다. 기동 거부는 별개 토폴로지(0.0.0.0) 얘기다.

## 감사 이력

2026-07-28, read-only Mind 2회.

1차(`mind_ssh_remote`) — 반증 4건: CORS 문제로 본 것, 기동 거부를 원인으로 본 것,
게이트를 관리 API로만 본 것, C1/C2를 택일로 본 것.

2차(`mind_hardening_scope`, 이슈 제출 전 검증) — 반증 6건:

- "SSH 원격이 전부 깨진다" → **동일 포트 포워딩은 정상 동작**
- "회귀 테스트 0건" → `server-auth.test.ts:582-602`에 종단 테스트 존재
- "포트 조건만 풀면 해결" → 호스트 별칭·베이스 URL·인증 부재가 별개로 남음
- "DNS rebinding 방어였을 것" → 이력상 "동일 오리진" 신뢰 규칙
- "Codex CLI가 헤더를 못 보냄" → `inject.ts`가 주입한다
- 연결/UX 버그로 분류 → **CODEOWNERS 보안 경계**

핵심 판정(동일 포트 200 / 포트 변경 403 / 별칭 403)은 실제 서버를 띄워 직접
재현했다.
