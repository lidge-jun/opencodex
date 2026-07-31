# 020 — 열린 이슈 41건 처분

기준 `7132828b3`. `010`의 PR 처분을 입력으로 쓴다(`COVERED-BY-PR` 판정에 필요).

luna-max 6개 레인을 겹치지 않는 구획으로 파견했다. 레인 간 불일치와 오류가 셋 나왔고
전부 소스로 직접 재확인했다. 아래 "레인 오류" 절에 남긴다.

## 요약

| 판정 | 건수 |
|---|---|
| `FIXED-ON-DEV` (닫을 수 있음) | 3 |
| `PARTIAL` | 10 |
| `OPEN` | 8 |
| `COVERED-BY-PR` | 3 |
| `NEEDS-DECISION` | 7 |
| `UPSTREAM` | 5 |
| 로드맵/기능요청 (장기) | 5 |

## 지금 닫을 수 있는 것 3건

| 이슈 | 근거 |
|---|---|
| **#759** 카탈로그 video modality 거부 | `catalog/provider-fetch.ts:327-333`이 `text\|image\|audio`로 필터, `parsing.ts:281-285`가 재차 정리, `sync.ts:451-458`이 디스크 보존 행에도 적용. 세 경로 전부 막힘 |
| **#754** `ocx init` EOF busy-loop | `cli/init.ts:9-32`가 `close`에서 대기 중 프롬프트를 reject, `:213-223`이 EOF를 종료코드 1로. `bfa1a599c`가 HEAD 조상 |
| **#767** Claude Desktop native 모델 opt-out | `catalog/metadata.ts:126-129`가 `desktopNativeModels:false`일 때 native slug 미반환, `management/shared.ts:224-248`이 할당·기본값도 제거. `f72610027` |

세 건 다 보고된 실패 모드가 실제로 해소됐는지까지 확인했다. 같은 파일을 건드린
커밋이 있다는 것만으로 닫지 않았다.

## 레인 오류 3건 — 기록해두는 게 낫다

### 1. typecheck 실패는 트리 문제가 아니었다

게이트 레인이 `bun run typecheck` FAIL을 보고했다:

```
error TS2688: Cannot find type definition file for 'bun-types'.
```

이대로면 "dev 트리에 타입 오류가 있다"가 된다. 확인해보니 이 워크트리의
`node_modules`가 **비어 있었다**. `bun install` 후:

```
$ bun run typecheck
$ bun x tsc --noEmit
(exit 0)
```

새 워크트리에 의존성을 안 깐 것뿐이다. 환경 문제를 코드 결함으로 적을 뻔했다.

### 2. #570은 "고쳐졌다"와 "안 고쳐졌다"가 둘 다 맞다

한 레인은 `FIXED-ON-DEV`, 다른 레인은 `PARTIAL`을 냈다. 소스를 보면 둘 다 옳다.

`auth-cors.ts:37-51`:

```
export function isLoopbackRequestHost(value: string | null): boolean {
  const parsed = parseHttpHost(value);
  if (!parsed) return true;
  // Loopback is a trust boundary by hostname, not by port. `ssh -L 20100:localhost:10100`
  // legitimately arrives as `Host: localhost:20100`, and refusing it took the whole /v1/*
  // data plane down with it, not just CORS.
  return isLoopbackHostname(parsed.hostname);
```

포트 동등성 비교가 사라졌다. **#570이 보고한 실패 모드 — 포트 리맵 터널의 403 —
는 재현되지 않는다.** `#573`이 해결했다.

동시에 `myhost.lan` 같은 비-loopback 별칭은 `:85`에서 여전히 거부된다. 그건 사실이지만
**#570이 낸 질문이 아니다.** 별도 요청이다.

처분: `FIXED-ON-DEV`로 닫되, 별칭 호스트 신뢰 목록은 별건으로 분리한다. 원 보고자의
실패 모드가 해소됐는데 인접한 미구현 기능 때문에 계속 열어두는 건 트래커를 흐린다.

### 3. #764는 PR이 머지됐지만 이 HEAD에는 없다

#780은 05:17:31Z에 머지됐는데 머지 커밋 `12eae74ec`가 `7132828b3`의 조상이 아니다.
동결 HEAD 기준 판정은 그대로 두고, 다음 라운드가 새 HEAD에서 다시 본다.

## 심각도 높은 잔여 — 부분 수정된 것들

직전 라운드가 절반씩 고친 것들이다. **잔여를 정확히 적는 게 이 표의 목적이다.**
"고쳐졌음"으로 뭉뚱그리면 다음 사람이 남은 절반을 못 찾는다.

| 이슈 | 랜딩된 것 | 남은 것 |
|---|---|---|
| **#766** 대시보드 blank | GUI first-paint 분리(`dashboard-core-poll.ts:251-265`), stale 상태를 hard error로 매핑하지 않음(`startup-health-ui.ts:97-103`) | ACL 타임아웃은 여전히 503(`management-auth.ts:58-69,122-140,192-194`). startup 프로브가 여전히 5초 Bun 서브프로세스(`startup-health-cache.ts:10-12`). `/api/logs?surface=`가 서버에서 무시됨(`request-log.ts:741-763`) |
| **#765** anthropic 어댑터 | URL 정규화(`anthropic.ts:253-262`), JSON delta의 tool 블록 스코핑(`:835-836`), 없는 ID 합성(`:808-811`, `:903-907`) | 빈/공백 ID는 nullish 검사만이라 통과. terminal frame 없는 EOF는 여전히 에러(`:866-881`). malformed 접두 문자열 입력은 복구 대신 폐기(`:269-284`) |
| **#764** Windows 서비스 stop | 생존 프로세스 감지 후 native 복원 전 비정상 종료(`service.ts:1994-2006`) | `stopTrackedProxyIfRunning()`이 PID 없이 `"none"` 반환(`:1668-1679`). 식별 프로브 750ms 제한(`proxy-liveness.ts:69-87`). `uninstallWindows()`가 태스크 제거 검증 전에 자산 삭제(`:1431-1474`). WinSW 콘솔 프롬프트(`winsw.ts:90-96`) |
| **#796** Ark 구조화 content | Ark 호스트에 `[{type:"text",text:""}]` 전송(`openai-chat.ts:408-409`) | **여전히 미검증.** 소스가 `:396-403`에서 스스로 unverified로 표기. 실제 엔드포인트 확인 필요 |
| **#545** Claude Desktop 3P 분류기 | 거짓 502 로그 분류만 수정(`request-log.ts:641`이 200으로 기록) | 64토큰 incomplete가 `stop_reason=max_tokens`로 충실히 반환되어(`claude/outbound.ts:411`) 클라이언트 재시도를 그대로 유발 |
| **#753** GUI 로딩 상태 | 공유 로딩 프리미티브(`data-surface.ts:52-131`), 중복 quota 재조회 제거(`Providers.tsx:84-100`) | `App.tsx:307-319`이 여전히 페이지 언마운트. 계정 상태가 빈 값으로 시작(`useProviderAccountPools.ts:62-64`)해 잠시 blank. 요청 수는 38 → 31(`6d13736dd`)로 줄었을 뿐 |
| **#95** 다중 사용자 호스팅 | 비-loopback 수용(`auth-cors.ts:191-203`), LiteLLM preset(`registry.ts:1052-1057`) | **테넌트 격리 없음.** 요청 로그에 사용자 식별 필드 자체가 없음(`request-log.ts:34-126`, `usage/log.ts:41-78`) |

## 열린 PR이 덮는 것

| 이슈 | 덮는 PR | 현재 상태 |
|---|---|---|
| #760 TLS Origin 403 | #779 | `management-api.ts:82-85`가 인증 **전에** 거부. PR은 초록, 보안 리뷰만 남음 |
| #726 로그 200건 상한 | #784 | `request-log.ts:128-129` `MAX_LOG_SIZE=200` 그대로 |
| #724 stale plan | #750 | `auth-api.ts:140-147`이 `freshPlan`을 버리고 `account.plan`을 방출 |
| #723 Antigravity 탐색 실패 | #744 | `registry.ts:799`에 `liveModels` 없음 → `provider-routes.ts:84-90`이 live로 취급 |

## 우리가 고칠 수 있는 것

PR도 없고 오너 판단도 필요 없는 것들이다.

| 이슈 | 위치 | 성격 |
|---|---|---|
| **#719** Kiro 대형 MCP 카탈로그 | `adapters/kiro-tools.ts:144-171` | 설명만 절단하고 **총량 예산이 없다**. `kiro.ts:419-425`가 전체 목록 유지, `:562-563`이 그대로 업스트림 전송 |
| **#716** Kiro 설치 안내 Unix 전용 | `oauth/kiro.ts:360,378` + 5개 로케일 | `providers.md` en:88,156 / ko:83,106 / ja:83,106 / zh:77,98 / ru:91,116 전부 `curl \| bash`. `install.ps1` 없음 |
| **#753** 잔여 blank 렌더 | `useProviderAccountPools.ts:62-64`, `Providers.tsx:311` | 첫 페인트 전에 loading 초기화 |

## 제품 판단이 필요한 것

- **#690** `ocx claude` `bypassPermissions` 자동 주입 — Claude Code 도구 실행을 자동
  승인한다. 오해 없이 opt-in이어야 한다. `types.ts:339-346`에 필드 없음
- **#695** Antigravity 계정 자동 전환 — 자동 풀은 현재 Anthropic만
  (`oauth-account-routes.ts:241-268`). provider 정책 함의 있음
- **#755** 릴리스 큐 추적 — 본문의 "main is now an ancestor of dev"가 사실과 다르다.
  `origin/main`(`1adad3573`)은 HEAD 조상이 아니다(`rev-list --left-right --count` → `1 25`)
- **#561** Modelsell, **#201** TRAE, **#178** Factory, **#177** Warp, **#540** WordPress —
  전부 `MAINTAINERS.md:35` 증거 요건 미달. #178/#177은 provider가 아니라 에이전트
  실행 백엔드라 설계 결정이 먼저다

## 나머지 — 기능 요청과 장기 항목

분석은 했는데 위 절에 안 들어간 것들이다. 완결성을 위해 전부 적는다.

| 이슈 | 판정 | 현재 상태 |
|---|---|---|
| **#709** 카탈로그를 관리 API로 제공 | `FIXED-ON-DEV` | `management/model-routes.ts:101-112`이 `GET /api/catalog` 구현, 없으면 404, 버전 헤더 포함. `5d7ab0cb7`. 잔여는 raw 바이트 대신 재직렬화한다는 점과 `models_cache.json` 경로 미구현 — 원 요청 범위 밖 |
| **#650** GPT-5.6 Pro 라우팅 | `COVERED-BY-PR` (#757) | `registry.ts:607`에 virtual Pro ID는 있으나 `provider-registry-parity.test.ts:99`가 일반 `gpt-5.6-pro`를 명시적으로 거부. `adapter-resolve.ts:41`에 browser 어댑터 없음 |
| **#572** provider 12종 승격 (umbrella) | `PARTIAL` | 공유 discovery 계약(`48f2e8362`)은 dev에 있음. 12종 전부 canonical 미등록 — Baseten(#653) DeepInfra·Novita(#747) Hyperbolic(#751)만 PR 존재. Chutes SambaNova Nebius DigitalOcean Scaleway Nscale Vultr Featherless는 **PR 없음** |
| **#586** Pool/Direct 전환 UI | `NEEDS-DECISION` | 백엔드는 `provider-routes.ts:149`에 있음. `ProviderSettings.tsx:138`이 mode를 안 보내고 `types.ts:88` 패치 타입에 필드 없음. `CodexAuth.tsx:21`은 뱃지만 표시. **UI 위치 결정이 먼저** |
| **#657** 거부 기반 quota 회복 | `OPEN` | 현재 `responses/core.ts:237`이 429/402를 전부 재시도 대상으로 받음. reset credit 상환은 수동 엔드포인트(`auth-api.ts:926`)뿐. 자동 상환은 되돌릴 수 없는 크레딧을 소모하므로 정책 결정 필요 |
| **#656** 저장 계정을 native 로그인으로 | `NEEDS-DECISION` | native 자격증명은 `main-account.ts:22`에서 읽기 전용. 풀 자격증명은 `types.ts:1191`의 별도 4필드 레코드. `auth.json` 교체는 자격증명 생명주기 조작이라 보안 리뷰 대상 |
| **#425** 계정 네임스페이스 picker | `PARTIAL` | 검증(`config.ts:693`)과 셀렉터 생성(`account-namespaces.ts:80`)은 있는데 `server/index.ts:461`이 bare 모델만 방출. 소비자가 없다 |
| **#415** provider 네이티브 검색 sidecar | `OPEN` | backend 타입이 `"openai"\|"anthropic"` 2값 고정(`types.ts:848-870`), dispatch도 둘뿐(`web-search/loop.ts:475-485`) |
| **#414** Exa 등 검색 sidecar | `OPEN` | 같은 지점. `config-routes.ts:321-330` 검증과 `dashboard-shared.ts:154-166` GUI도 2값 |
| **#553** Copilot TLS hostname mismatch | `OPEN` | `fff8c369f`는 **진단만** 개선. `responses/core.ts:2119`이 TLS 에러를 502로 변환하는 건 그대로. 잘못된 인증서는 환경 문제라 인증서 검증 비활성화나 hostname 재작성은 **안전하지 않다** — 우리가 고칠 수 없다 |
| **#386** macOS 메뉴바 companion | `OPEN` | `apps/macos-menu-bar` 없음, `package.json:35-55`에 빌드 스크립트 없음. PR #387은 CLOSED |

#572가 중요하다. umbrella에 12종이 걸려 있는데 PR이 있는 건 4종뿐이고, 나머지 8종은
아무도 안 하고 있다. 이걸 열어둔 채로 개별 preset PR을 증거 미달로 계속 돌려보내면
양쪽 다 안 움직인다. `030`에서 다룬다.

## upstream-tracking 4건 — 전부 유효

오래됐다고 닫지 않는다. 조건이 살아 있는지만 확인했다.

| 이슈 | 조건 | 확인 |
|---|---|---|
| #417 한국어 음성 U+FFFD | 업스트림 `openai/codex#35161` | 여전히 OPEN. 릴레이는 `server/index.ts:164-207`에서 재디코딩 없이 전달, `server-live.test.ts:642-735`가 바이트 동일성 고정 |
| #241 Desktop picker 누락 | Desktop 클라이언트 allowlist | ocx는 `sync.ts:162-185`에서 `visibility:"list"`로 기록하고 `/v1/models`(`index.ts:447-463`)로 노출. 필터는 외부 |
| #92 V2 NEW_TASK 암호문 | Fernet 암호문 복호 불가 | `encrypted-payload.ts:182-231`이 감지, `:261-307`이 보존. `sub-agent-surface.md:20-28`에 한계 문서화 |
| #418 V2 custom→custom 위임 | 자식 요청이 프록시에 도달하기 전 실패 | 로컬 구현 없음. `collaboration.ts:234-250`은 안내만 |

## #658 — 수정 지점이 확정됐다

직전 라운드는 "진짜 수정 지점은 어댑터가 아니라 bridge"라고만 남겼다. 이번에 그
지점을 정확히 찾았고, 별도 레인에서 확인한 #781의 내용과 **같은 곳으로 수렴한다.**

현재 동작(`anthropic.ts:866-881`):

```
if (!emittedDone) {
  // Fail closed on transport EOF.
  if (pendingStopReason !== undefined) { ... yield done ... }
  else {
    yield { type: "error", message: "upstream stream ended before message_stop — possible truncation" };
  }
```

`stop_reason` 없이 EOF가 오면 무조건 에러다. AgentRouter는 정확히 그렇게 끝낸다.
레인이 리다이렉트된 프로브로 `text_delta → error → response.failed`를 재현했고,
Anthropic 출력에 `message_stop`이 없었다.

어댑터에서 이걸 완화하려던 시도는 `95d8ed77f`로 리버트됐다. 어댑터는 프로토콜
계약을 지키는 게 맞고, 완화는 프로토콜 위반이기 때문이다.

`bridge.ts:771`의 `case "error"`가 실제 지점이다. 지금은 에러를 받으면
`closeCurrentMessage()`류로 열린 블록을 닫는데, tool call의 경우 이게
`function_call_arguments.done`과 `status:"completed"`를 **먼저** 내보낸 뒤
`response.failed`가 나간다. 클라이언트는 발행된 tool call을 본 상태가 된다.

**#781이 이미 이걸 고친다.** `010`에서 확인한 `failCurrentToolCall()`이 정확히
`status:"incomplete"`로 취소하는 경로다. 즉 #658의 잔여와 #765의 잔여와 #781의
bridge 변경이 한 지점에서 만난다.

남는 설계 질문 하나: EOF에 `stop_reason`이 없을 때 **버퍼된 텍스트가 유효하면
완료로 내보낼 것인가**. 이건 provider 스코프 호환 모드(AgentRouter 한정)로
`responses/core.ts:2475` 호출부에서 넘겨야 한다. 전역으로 완화하면 진짜 절단을
놓친다 — 직전 라운드가 `#773`에서 겪었을 가능성이 있는 실패 모드다.

## 보안 관련

수용 경계(#760/#570/#766) 상세 분석은 `AGENTS.md` 규칙에 따라 **이 저장소에 쓰지
않는다.** 미공개 상태의 인증 경계 분석이다. 스크래치 경로:
`.tmp/260731-acceptance-boundary-notes.md` (gitignore 확인함).

여기 적는 건 중립적 사실뿐이다: #760은 `management-api.ts:84`, #766은
`management-auth.ts:138-140`에서 갈린다. #779와 #782는 서로 충돌하지 않고 필수
랜딩 순서도 없지만, 랜딩 후 결합 검증이 필요하다.
