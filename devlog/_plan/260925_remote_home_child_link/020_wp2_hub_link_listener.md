# 020 — wp2: 허브 링크 리스너

브랜치: `codex/remote-link-2-hub-listener`
base: `codex/remote-link-1-core`
상위 문서: `000_prd.md`, `001_stack_plan.md`, `002_arch_plan.md`, `010_wp1_link_core.md`

## 범위

### IN

- `ServerIngress`에 `hub-link`를 추가하고, 링크 입구에서 고정된 경로 allowlist와 API key 인증을 적용한다.
- `src/server/index/optional-listeners.ts`가 Claude intercept와 링크 리스너의 수명, ingress 판별, 종료를 함께 소유한다.
- 링크 입구는 HTTP 전용이다. `linkRouteAllowed`는 `Upgrade` 헤더가 있는 모든 요청과 WebSocket upgrade를 선행 거부하며, 이 거부를 회귀 테스트로 고정한다.
- `links.json`에 링크가 있을 때만 `127.0.0.1:<listenerPort>`를 동기 바인드한다. `listenerPort`가 `null`이면 Bun의 `port: 0` 결과를 저장한다.
- 링크 입구의 정책 hostname은 비루프백 sentinel로 고정한다. `links.json`에 기록된 `apiKeyId`와 일치하는 `config.apiKeys` 항목만 허용하고 `OPENCODEX_API_AUTH_TOKEN`은 거부한다.
- `/v1` 데이터 경로, `GET /v1/catalog`, `GET /v1/hub-state`, `GET /v1/usage`, `GET /readyz`만 링크 소켓에 전달한다. `/api/*`, GUI, 세션 bootstrap, `/healthz`, 미지의 `/v1/*`는 404다.
- 링크 입구를 코어 경로와 분리하는 `tests/lab/core-link-boundary.test.ts`를 추가한다.

### OUT

- SSH 실행, 터널 감독자, 키 발급·회수, 관리 API는 wp4로 둔다.
- `ocx connect --link`, client machine listener 중계는 wp3로 둔다.
- GUI, docs-site 사용자 문서, Windows, 공개 HTTPS 연결은 후속 레이어로 둔다.
- 새 `LinkRecord` 필드는 추가하지 않는다. wp1의 `LinkStore` 계약을 그대로 소비한다.

## 파일 변경 지도

| 경로 | 종류 | 내용 |
|---|---|---|
| `src/server/index/optional-listeners.ts` | NEW | Claude intercept와 link listener를 묶는 `createOptionalListenerSet`; `ingressOf(server)`, 동기 `start(ctx)`, single-flight `ensureStarted()`, `close()`, `stop()` 및 supervisor 선행 종료 slot |
| `src/server/index/link-listener.ts` | NEW | `linkRouteAllowed`, `createLinkListenerLifecycle`; `hasLinks(linkStorePath())` 게이트, HTTP-only loopback bind, listenerPort 선택·저장, 링크 key id 집합, 즉시 `close()` |
| `src/server/index/serve-options.ts:202-210` | MODIFY | `ServerIngress`에 `hub-link`, 링크 route/policy callback과 선행 404 gate |
| `src/server/index.ts:198-200,623-634,691-737,751-785` | MODIFY | 직접 Claude lifecycle 연결을 optional listener set으로 교체하고 link ingress/policy/종료를 연결. 순증 0줄, 현재 890줄에서 baseline 893줄 이하 |
| `src/server/auth-cors.ts:295-323,397-417,554-595` | MODIFY | `RequestPolicyView.linkIngress`와 restrict-only `linkIngress` resolver option; sentinel hostname에서 환경 토큰 차단 |
| `src/server/audio-upstream.ts:31-40` | MODIFY | 직접 admission resolver 호출에 link 제한 전달 |
| `src/server/audio-client.ts:19-64` | MODIFY | audio HTTP 경로의 key carrier와 platform bearer fallback에 link 제한 전달; WebSocket upgrade는 link route에서 선행 거부 |
| `src/server/hub-usage.ts:9-43` | MODIFY | 두 번의 usage key 재검증에 link 제한 전달 |
| `structure/runtime.md:222-263` | MODIFY | 네 번째 socket인 hub-link, 정책, 시작·종료 계약을 현재형으로 기록 |
| `tests/lab/core-link-boundary.test.ts` | NEW | 무링크 미활성, bind/persist, 경로·인증·Upgrade 거부, ensureStarted single-flight, 마지막 링크 close, supervisor-first shutdown, 코어 import boundary |
| `scripts/test-layout/layout.json` | MODIFY | `explicit`에 `"core-link-boundary.test.ts": "lab"` 추가 |
| `tests/fixtures/test-layout-expected.json` | MODIFY | 같은 `core-link-boundary.test.ts` → `lab` 등록 |

`structure/manifest.json`은 수정하지 않는다. 기존 `runtime.md`가 `src/server/`의 owner이고, 새 파일은 그 기존 source area 안에 있다. `structure/INDEX.md`도 manifest 변경이 없으므로 재생성하지 않는다.

## 새 파일/변경 상세

### `src/server/index/optional-listeners.ts` NEW

외부에 노출하는 shape는 다음으로 고정한다. `ServerIngress`의 타입은 `serve-options.ts`에서 가져오며, 이 파일은 관리 API나 GUI를 import하지 않는다.

```ts
export interface OptionalListenerStartContext<T> {
  config: OcxConfig;
  publicPort: number;
  requestedPort?: number;
  maxRequestBodySize: number;
  dispatch: (req: Request, server: Server<T>) => Promise<Response>;
}

export interface OptionalListenerSet<T> {
  ingressOf(server: Server<T>): ServerIngress | undefined;
  linkRouteAllowed(url: URL, req: Request): boolean;
  linkAdmissionKeyIds(): ReadonlySet<string>;
  start(ctx: OptionalListenerStartContext<T>): void;
  /** Concurrent callers receive the same in-flight bind promise; after bind this is idempotent. */
  ensureStarted(): Promise<void>;
  /** Close the link listener immediately while retaining the persisted listenerPort. */
  close(): Promise<void>;
  /** Register wp4's supervisor teardown; stop() invokes it before the link listener. */
  registerSupervisorStop(stop: () => Promise<void>): () => void;
  stop(): Promise<void>;
}

export function createOptionalListenerSet<T>(): OptionalListenerSet<T>;
```

구현 순서는 다음과 같다.

1. 생성 시 `createClaudeInterceptLifecycle<T>()`와 `createLinkListenerLifecycle<T>()`를 만든다. 생성자는 socket, timer, dynamic provider work를 시작하지 않는다.
2. `ingressOf`는 link listener를 먼저 검사하고, 그 다음 Claude intercept를 검사한다. 둘 다 아니면 `undefined`다.
3. `start(ctx)`는 link lifecycle을 먼저 동기 실행해 저장 링크의 첫 bind를 끝낸 뒤 Claude intercept의 기존 fire-and-forget start를 실행한다. Claude의 기존 `loadPickerRoutes`와 warning 동작은 `createClaudeInterceptLifecycle`에 남긴다.
4. `ensureStarted()`는 wp4가 첫 링크를 기록한 뒤 호출할 수 있도록 저장된 start context로 link listener만 재평가한다. 반환형은 `Promise<void>`이고, 동시 호출은 하나의 in-flight bind promise를 공유한다. bind가 끝난 뒤의 호출은 이미 소유한 socket을 재생성하지 않고 즉시 완료한다.
5. wp4 supervisor는 `registerSupervisorStop()`으로 teardown을 등록한다. `stop()`은 등록된 supervisor stop을 먼저 기다린 뒤 link listener를 닫고, 그 다음 Claude intercept를 정리한다. supervisor stop이 실패해도 listener close와 다른 cleanup은 건너뛰지 않는다.
6. `close()`는 마지막 link record 삭제가 끝난 즉시 wp4가 호출하는 listener-only close다. 현재 socket을 바로 닫고 소유 참조를 비우되 `listenerPort`와 start context는 유지해 이후 `ensureStarted()`가 재평가할 수 있게 한다. 전체 `stop()`은 모든 optional listener를 종료한다.

### `src/server/index/link-listener.ts` NEW

```ts
export const LINK_INGRESS_HOSTNAME = "opencodex-link.invalid";

export interface LinkListenerStartContext<T> {
  dispatch: (req: Request, server: Server<T>) => Promise<Response>;
  maxRequestBodySize: number;
}

export interface LinkListenerLifecycle<T> {
  ownsListener(server: Server<T>): boolean;
  start(ctx: LinkListenerStartContext<T>): void;
  ensureStarted(): Promise<void>;
  linkAdmissionKeyIds(): ReadonlySet<string>;
  close(): Promise<void>;
  stop(): Promise<void>;
}

export function linkRouteAllowed(url: URL, req: Request): boolean;
export function createLinkListenerLifecycle<T>(): LinkListenerLifecycle<T>;
```

`linkRouteAllowed`는 현재 `src/server/index.ts:402-433`의 loopback 데이터 allowlist에서 HTTP 경로만 선별해 허용한다. 함수 첫 단계에서 `req.headers.has("upgrade")`이면 경로·method와 무관하게 `false`를 반환한다. 따라서 `Upgrade: websocket`뿐 아니라 다른 upgrade 값도 거부되며, WebSocket 전용 `/v1/realtime`, `/v1/live`, `/v1/audio/transcriptions/stream` 경로도 링크 입구에서는 열리지 않는다. 그 위에 `GET|HEAD /v1/catalog`, `GET|HEAD /v1/hub-state`, `GET /v1/usage`, `GET /readyz`와 HTTP data route만 명시한다. `readyz`도 링크 입구에서는 key를 요구하며, 인증 후 기존 readiness handler의 sanitized 응답만 반환한다. `OPTIONS`, trailing slash `/readyz/`, `/api/*`, `/opencodex-session`, GUI fallback, `/healthz`, unknown `/v1/*`는 허용하지 않는다. audio/live/realtime의 직접 resolver는 HTTP route에 한해 아래의 `linkIngress` option을 받으므로 allowlist 밖으로 빼지 않는다.

lifecycle의 상태와 순서는 다음과 같다.

1. `start(ctx)`가 `hasLinks(linkStorePath())`를 동기 호출한다. false면 `Bun.serve`를 호출하지 않고 `linkAdmissionKeyIds()`는 빈 집합을 돌려준다.
2. true면 `readLinkStore`를 한 번 읽는다. `listenerPort`가 있으면 `Bun.serve({ hostname: "127.0.0.1", port: listenerPort, ... })`로 bind한다. `null`이면 `port: 0`으로 bind하고 반환된 concrete `server.port`를 같은 `LinkStore`에 `writeLinkStore`로 저장한다. `0`은 저장하거나 광고하지 않는다.
3. 저장 실패 또는 bind 실패는 링크 socket만 비활성으로 만들고 warning을 남긴다. public socket의 startup/rollback 의미는 기존과 같고, wp4의 status가 다음 조치를 결정한다. 이미 저장된 링크가 있는 첫 기동에서 listener가 없으면 성공으로 가장하지 않는다.
4. `linkAdmissionKeyIds()`는 매번 현재 `links.json`을 읽고 `links[].apiKeyId`만 반환한다. 손상 파일, 중복, 없는 파일, 링크 없는 파일은 빈 집합으로 fail closed한다. 실제 secret 비교는 `config.apiKeys`와 resolver가 맡는다.
5. `ensureStarted()`는 동일한 bind/persist 순서를 사용하되 `ensureFlight` promise를 둔다. 첫 호출만 store 재평가와 bind/persist를 수행하고, concurrent caller는 같은 promise를 await한다. 성공적으로 server를 소유한 뒤의 호출은 즉시 완료하며, 실패한 flight만 다음 호출이 재시도할 수 있게 해 bind 실패 상태를 숨기지 않는다.
6. `close()`는 server가 없으면 완료되고, 있으면 `server.stop()`을 즉시 await한 뒤 소유 참조만 비운다. 마지막 링크 삭제의 DELETE 처리 종료 지점에서 호출하며 `listenerPort`와 start context는 지우지 않는다. `stop()`은 같은 close flight를 공유한 뒤 lifecycle의 supervisor slot과 함께 최종 정리하고, 재시작 후 동일한 advertised port를 유지한다.

### `serve-options.ts` MODIFY

현재 `src/server/index/serve-options.ts:202-210`은 다음과 같다.

```ts
export type ServerIngress = "public" | "unauthenticated-loopback" | "hub-management" | "claude-intercept";

export function claudeInterceptRouteAllowed(url: URL, req: Request): boolean {
  return isClaudeInterceptedPath(url.pathname, req.method);
}
```

다음처럼 `hub-link`와 callback을 추가한다.

```ts
export type ServerIngress = "public" | "unauthenticated-loopback" | "hub-management" | "claude-intercept" | "hub-link";

export interface ServeOptionsContext {
  // existing fields...
  linkRouteAllowed: (url: URL, req: Request) => boolean;
  linkPolicy: () => RequestPolicyView;
}
```

`fetch`의 첫 route gate에 `hub-link`를 추가한다. 거부 응답은 기존 loopback/management와 동일한 JSON 404 shape이며 handler를 실행하지 않는다. 이후 policy 선택은 `hub-link ? linkPolicy() : ...`이고, `linkPolicy`의 hostname은 `LINK_INGRESS_HOSTNAME`이다. `resolveApiAuth`, `resolveResponsesApiAuth`, audio resolver, usage handler가 이 policy를 통해 같은 key-id 제한을 사용한다.

### `index.ts` MODIFY

현재의 직접 wiring은 `src/server/index.ts:626-634`, `:734-736`, `:775`, 그리고 `:198-200`의 `createClaudeInterceptLifecycle` import에 있다.

현재:

```ts
const claudeIntercept = createClaudeInterceptLifecycle<WsData>();
if (claudeIntercept.ownsListener(requestServer)) return "claude-intercept";
claudeIntercept.start({ config, publicPort: server.port ?? listenPort, ... });
() => claudeIntercept.stop(),
```

변경 후:

```ts
const optionalListeners = createOptionalListenerSet<WsData>();
const optionalIngress = optionalListeners.ingressOf(requestServer);
if (optionalIngress !== undefined) return optionalIngress;
optionalListeners.start({
  config, publicPort: server.port ?? listenPort, requestedPort: listenPort,
  maxRequestBodySize: inboundBodyLimitBytes,
  dispatch: (req, requestServer) => serveOptions.fetch(req, requestServer),
});
() => optionalListeners.stop(),
```

`createServeOptions`에는 `linkRouteAllowed`, `linkPolicy` callback을 전달한다. `linkPolicy`는 `requestPolicyView(config, LINK_INGRESS_HOSTNAME, { allowedKeyIds: optionalListeners.linkAdmissionKeyIds() })` 형태로 만든다. public, unauthenticated-loopback, hub-management 정책은 기존 값을 유지한다. `src/server/index.ts`는 현재 890줄이고 baseline cap은 893줄이므로 기존 Claude 호출을 set 호출로 치환해 순증 0줄을 지킨다. `Bun.serve`부터 Lab activation 사이의 동기 보장과 `startServer` 비동기 금지 규칙도 유지한다.

### `auth-cors.ts`, audio, usage MODIFY

현재 `RequestPolicyView`는 `src/server/auth-cors.ts:315`에서 `hostname`, CORS, `apiKeys`만 가진다. 다음 ephemeral field를 추가한다.

```ts
export interface LinkIngressPolicy {
  allowedKeyIds: ReadonlySet<string>;
}

export type RequestPolicyView = Pick<OcxConfig, "hostname" | "corsAllowOrigins" | "apiKeys"> & {
  linkIngress?: LinkIngressPolicy;
};

export type DataPlaneAdmissionOptions = {
  linkIngress?: ReadonlySet<string>;
};
```

`requestPolicyView`에 세 번째 인자로 `linkIngress?: LinkIngressPolicy`를 받아 복사한다. `resolveDataPlaneAdmissionSecret`는 `options: DataPlaneAdmissionOptions = {}`를 네 번째 인자로 받는다. `options.linkIngress`가 있으면 다음 두 규칙을 적용한다.

- 환경 변수 `configuredApiAuthToken(config)` 비교를 건너뛴다.
- `config.apiKeys`를 순회할 때 `options.linkIngress.has(k.id)`인 항목만 active/pending key를 비교한다.

option이 없을 때의 비교 순서와 결과는 byte-level로 유지한다. `resolveApiAuth`와 `resolveResponsesApiAuth`는 `RequestPolicyView.linkIngress?.allowedKeyIds`를 이 option으로 넘긴다. `isDataPlaneAdmissionSecret`의 기본 호출은 넓히지 않는다. 링크 policy를 만들 때만 sentinel hostname으로 `isApiAuthRequired`를 true로 만든다.

소스 감사상 `src/server/audio-upstream.ts:31-40`, `src/server/audio-client.ts:19-64`, `src/server/hub-usage.ts:9-43`는 `resolveApiAuth`를 거치지 않는다. 따라서 각각 `DataPlaneAdmissionOptions`를 받아 resolver와 platform-bearer fallback, usage의 두 번째 key 재검증에 전달한다. `/v1` 전체 allowlist를 유지하면서 기록되지 않은 key와 환경 토큰이 audio/live/usage로 새지 않게 하는 필수 연결이다.

## 필드 체인

### PLAN-FIELD-CHAIN-01 — `RequestPolicyView.linkIngress`

- 생성: `index.ts`의 `linkPolicy` callback이 현재 `links.json`의 `links[].apiKeyId` 집합과 `LINK_INGRESS_HOSTNAME`으로 매 request policy를 만든다.
- 직렬화: 없음. 이 field는 메모리의 policy view이며 config, links.json, API 응답에 기록하지 않는다.
- 역직렬화/검증: 링크 id와 listener port는 wp1 `store.ts`의 `readLinkStore`가 검증한다. policy 생성 시 손상/누락 store는 빈 key-id 집합으로 바뀌고, resolver는 config.apiKeys의 exact id만 비교한다.
- 소비자: `resolveApiAuth`, `resolveResponsesApiAuth`, `resolveAudioAdmission`, `resolveAudioClient`, `handleHubUsage`의 initial/current resolver가 모두 `DataPlaneAdmissionOptions.linkIngress`를 소비한다. `withCors`와 route handler는 같은 policy를 받아 CORS와 origin을 계산한다.
- 삭제/해제: wp4가 links.json에서 record를 제거하면 다음 request의 집합에서 id가 사라져 해당 key는 즉시 401이 된다. DELETE 처리가 끝나고 store가 비면 wp4는 `optionalListeners.close()`를 await해 listener를 즉시 닫는다. close는 `listenerPort`를 지우지 않으며, 이후 새 record가 기록되면 single-flight `ensureStarted()`가 같은 port를 재사용한다.

### PLAN-LIFECYCLE-01 — single-flight와 supervisor-first shutdown

- `ensureStarted(): Promise<void>`는 `ensureFlight`를 공유한다. 첫 호출이 저장 store를 읽고 bind/persist를 수행하는 동안 concurrent 호출자는 같은 promise를 받는다. 이미 listener를 소유한 뒤에는 bind를 반복하지 않고 완료한다. 실패한 flight만 slot을 비워 다음 호출이 재시도한다.
- `close(): Promise<void>`는 link listener만 즉시 닫는 idempotent operation이다. 마지막 link DELETE가 store 기록을 끝낸 직후 호출하며, key-id admission은 record 삭제 시점부터 fail closed이고 listener close가 끝날 때까지 새 bind를 시작하지 않는다.
- `registerSupervisorStop()`은 wp4가 나중에 supervisor teardown을 등록하는 optional-listeners의 순서 slot이다. `optionalListeners.stop()`은 supervisor callback을 먼저 await하고, 실패를 기록한 뒤에도 link `close()`와 Claude cleanup을 실행한다. 따라서 K14의 supervisor-before-listener 순서는 등록 시점과 무관하다.

`ServerIngress`의 `hub-link`는 persisted field가 아닌 compile-time union member이므로 별도 직렬화 체인은 N/A다. `LinkRecord`의 필드는 wp1 계약을 그대로 사용하므로 wp2 추가 체인은 N/A다.

## 테스트 사례

신규 파일 `tests/lab/core-link-boundary.test.ts`에 실제 서버와 임시 `OPENCODEX_HOME`을 사용하는 사례를 둔다. 기존 `tests/server/loopback-listener-integration.test.ts`의 public/auxiliary bind fixture 패턴을 따른다.

| 활성화 시나리오 | 관찰 가능한 증거 |
|---|---|
| store 없음 또는 `links: []`로 `startServer` | 추가 `127.0.0.1` socket이 없고 `ingressOf`가 `hub-link`를 반환하지 않는다. core import graph에 link listener가 request path로 들어오지 않는다. |
| 링크 1개, 고정 `listenerPort` | 해당 port가 `127.0.0.1`에서만 열리고 non-loopback 주소 bind는 관찰되지 않는다. `GET /readyz`는 기록 key 없이는 401, 기록 key로는 기존 readiness status를 반환한다. |
| 링크 1개, `listenerPort: null` | bind 후 store에 OS가 선택한 1..65535 port가 저장되고 `0`은 남지 않는다. 재기동 시 저장 port를 다시 사용한다. |
| `POST /v1/responses` 또는 `POST /v1/messages` | key 없음 401, `OPENCODEX_API_AUTH_TOKEN`만 있음 401, links.json에는 있지만 config.apiKeys에 없는 id 401, links.json id와 config key가 모두 일치하면 handler 단계의 정상 응답 또는 provider fixture 응답을 얻는다. |
| catalog/state/usage | `GET|HEAD /v1/catalog`, `GET|HEAD /v1/hub-state`, `GET /v1/usage`가 link 입구에서 route miss가 되지 않는다. usage는 기록된 configured key만 200/fixture 결과를 얻고 환경 key는 401이다. |
| 모든 기존 HTTP `/v1` data route | responses compact, images, context, search, models, artifacts, audio/live/realtime의 HTTP method를 allowlist에 대조한다. `Upgrade: websocket` 및 임의의 `Upgrade` 값이 있는 요청은 허용 경로와 무관하게 404로 선행 차단되고 handler에 도달하지 않는다. HTTP auth-compatible request는 handler에 도달하고 wrong method은 404 또는 기존 route의 401만 관찰한다. |
| 관리/GUI 차단 | `/api/config`, `/`, `/opencodex-session`, `/healthz`, `/missing`, unknown `/v1/no-such`가 모두 404 JSON이며 management session이나 GUI handler가 실행되지 않는다. |
| 기존 key rotation 상태 | 기록된 id의 active key와 유효한 pending key는 허용되고, 다른 id의 active/pending key는 401이다. key id가 삭제된 config에서는 즉시 401이다. |
| 첫 링크를 store에 기록한 뒤 `ensureStarted()` | process restart 없이 listener가 bind되고, 기존 public server와 동일한 port가 아닌 link listener port를 관찰한다. 빈 store의 `ensureStarted()`는 bind하지 않는다. |
| `ensureStarted()` concurrent callers | 동시에 여러 caller가 호출해도 하나의 bind/persist flight와 동일한 promise를 공유하고, 성공 후 반복 호출은 idempotent하게 완료한다. 실패 후 재호출은 새 flight로 재시도한다. |
| 마지막 링크 삭제와 shutdown | DELETE가 record를 제거한 직후 key admission은 401이 되고 `optionalListeners.close()`가 link port를 즉시 닫는다. `registerSupervisorStop()`으로 나중에 등록한 supervisor callback이 link listener보다 먼저 실행되며, supervisor 실패 뒤에도 listener close가 실행된다. |
| bind 실패 | 점유 port에서는 link listener만 warning/실패 상태가 되고 public listener를 잘못된 port로 재시도하지 않는다. 실패한 ensure flight 뒤 재호출은 명시적 재시도이며, `close()` 뒤 link port를 재bind할 수 있다. |
| core boundary | `src/router.ts`, `src/server/lifecycle.ts`, `src/server/responses/core.ts`의 parsed import graph에 `src/link/` 또는 link listener가 없다. 링크 없는 startup은 link bind/timer/process를 만들지 않는다. |

## 검증 명령

이 문서는 docs-only 산출물이다. 아래 실행 결과는 문서 작성 후의 현재 worktree 증거이며, wp2 production/test 파일이 아직 없는 사실도 함께 기록한다.

| 명령 | exit | change target을 읽는가 | 결과 |
|---|---:|---|---|
| `test -f devlog/_plan/260925_remote_home_child_link/000_prd.md && test -f devlog/_plan/260925_remote_home_child_link/001_stack_plan.md && test -f devlog/_plan/260925_remote_home_child_link/002_arch_plan.md && test -f devlog/_plan/260925_remote_home_child_link/010_wp1_link_core.md && test -f src/server/index.ts && test -f src/server/index/serve-options.ts && test -f src/server/auth-cors.ts && test -f src/server/index/claude-intercept-lifecycle.ts` | 0 | 아니오 | 필수 입력과 현재 source 모두 존재 |
| `test -f devlog/_plan/260925_remote_home_child_link/020_wp2_hub_link_listener.md` | 0 | 예 | 작성 대상 존재 |
| `wc -l src/server/index.ts src/server/index/serve-options.ts src/server/auth-cors.ts structure/runtime.md` | 0 | 아니오 | 각각 890, 1883, 1237, 600줄 |
| `bun run typecheck` | 0 | 아니오 | `$ bun x tsc --noEmit` |
| `bun run structure:check` | 0 | 아니오 | `$ bun scripts/structure-ssot.ts`; `structure/ SSOT checks passed` |
| `bun run privacy:scan` | 0 | 예 | `$ bun scripts/privacy-scan.ts`; `Privacy scan passed` |

wp2 구현 완료 시 추가로 `bun test tests/lab/core-link-boundary.test.ts`와 `bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts`를 실행한다. 이 두 명령은 현재 신규 테스트가 없으므로 이 문서 작성 단계의 실행 증거로 주장하지 않는다. full suite와 `bun run test:changed`는 이 bounded docs-only task에서 실행하지 않는다.

## 우회 경로 기록

| tier | surface | bypass | residual risk |
|---|---|---|---|
| E1 | server code, `hub-link` ingress | 같은 허브 호스트의 local process가 public/ordinary loopback ingress를 직접 사용 | 허브의 기존 local trust와 public auth 정책이 그대로 남는다. link ingress가 이 trust를 child에게 전파하지 않는다. |
| E2 | link listener activation | links.json이 없거나 손상되면 listener를 열지 않는다 | 잘못된 store를 자동 복구하지 않으므로 wp4 status가 operator 조치를 요구해야 한다. |
| E3 | API admission | 환경 API token이나 미기록 key id로 link ingress를 통과할 수 없다 | config.apiKeys의 동일 id가 재발급되면 key material이 바뀌는 기존 rotation semantics를 따른다. |
| E4 | route enforcement | 새 `/v1` route는 `linkRouteAllowed`에 명시하지 않으면 404 | allowlist와 handler의 drift를 boundary test가 잡아야 하며, 새 data route PR은 이 테스트를 갱신해야 한다. |

## file-size ratchet headroom

`tests/fixtures/file-size-baseline.json`에 등재된 touched file은 `src/server/index.ts` 하나다. 현재 890줄, cap 893줄, headroom 3줄이다. `src/server/index/serve-options.ts` 1883줄, `src/server/auth-cors.ts` 1237줄, `src/server/audio-upstream.ts`, `src/server/audio-client.ts`, `src/server/hub-usage.ts`, `structure/runtime.md`, 신규 파일, layout fixture는 baseline entry가 없어 cap이 기록되어 있지 않다. `index.ts`는 직접 Claude lifecycle wiring 삭제와 optional set wiring 추가의 net zero를 지켜야 한다.

## 테스트 layout 등록

`tests/lab/core-link-boundary.test.ts`는 `scripts/test-layout/layout.json`의 `explicit`와 `tests/fixtures/test-layout-expected.json`에 각각 다음 exact entry를 추가한다.

```json
"core-link-boundary.test.ts": "lab"
```

`lab.match`의 `core-` regex만으로 통과시키지 않는다. 기존 domain 밖의 새 test file을 만들지 않으며, 다른 tests file은 추가하지 않는다.

## structure / doc updates

`structure/runtime.md`의 `startServer` socket paragraph(`:222-235`) 뒤에 다음 현재형 사실을 추가한다.

```md
`startServer`는 링크 store에 하나 이상의 record가 있을 때만 네 번째 `hub-link` socket을
`127.0.0.1:<listenerPort>`에 연다. 이 socket은 기존 HTTP data-plane route와 catalog, hub-state,
usage, readiness의 고정 allowlist만 통과시키며 모든 `Upgrade` 헤더와 WebSocket handshake,
`/api/*`, GUI, session bootstrap, health와 미지의 `/v1/*`를 거부한다. link policy는
non-loopback sentinel hostname을 사용하고 links.json에 기록된 configured key id만 허용한다.
환경 API token은 이 ingress에서 admission credential이 아니다. `ensureStarted()`는 single-flight
promise이고, 마지막 link 삭제는 listener `close()`를 즉시 호출한다. `optional-listeners.ts`가
supervisor stop slot을 listener보다 앞에 실행한 뒤 이 socket과 Claude intercept를 정리한다.
```

이 문장은 `runtime.md`가 새 source path `src/server/index/optional-listeners.ts`와 `src/server/index/link-listener.ts`를 이름으로 포함하므로 기존 manifest의 `src/server/` ownership을 만족한다. `structure/manifest.json` ownership 배열과 생성 `structure/INDEX.md`는 변경하지 않는다.

## docs-site impact

없음. wp2는 사용자에게 노출되는 link setup flow를 완성하지 않고, wp5의 GUI와 docs-site가 최종 CLI/UI 흐름을 문서화한다. 이 문서는 public docs가 아니라 `devlog/_plan/` 구현 계획이다.

## PR title/body notes

제목: `feat(link): add authenticated hub link listener`

본문은 다음을 포함한다.

- Summary: saved link가 있을 때만 loopback hub-link socket을 열고, 고정 allowlist와 link-recorded configured key id로 child data traffic을 제한한다. Claude intercept lifecycle은 optional listener set으로 이동한다.
- Verification: `bun run typecheck`, `bun test tests/lab/core-link-boundary.test.ts`, layout tests, `bun run structure:check`, `bun run privacy:scan`의 exact-head 결과와 scope를 기록한다. full suite를 하지 않았으면 그렇게 적는다.
- Checklist: `index.ts` 893-line cap, link 없는 core import boundary, shutdown, env token refusal, unknown route 404를 명시한다.
- **Security review required:** authentication and credential handling boundary가 바뀌므로 `MAINTAINERS.md:74-85` 정책에 따라 명시적 security review와 CODEOWNERS 검토가 필요하다. link key material은 links.json에 기록하지 않는 wp1 계약을 재확인한다.

## Contract deviations

없음. shared contract의 이름과 경로를 유지한다. `audio-upstream.ts`, `audio-client.ts`, `hub-usage.ts`를 추가 MODIFY로 포함한 것은 `resolveDataPlaneAdmissionSecret`의 실제 직접 소비자를 빠뜨리면 link ingress가 환경 token 또는 다른 credential carrier를 허용하게 되므로 필요한 구현 범위 확장이다.

## 열린 질문

없음. K5의 bind 실패 degrade, K7의 key-authenticated `/readyz`, K8의 HEAD 허용, K9의 HTTP-only 입구, K14의 single-flight·supervisor-first shutdown, K6의 마지막 link 삭제 직후 close를 이 문서의 구현·테스트 계약으로 확정한다.

## 감사 반영 (Pauli FAIL r1)

- BLOCKER 4: `linkRouteAllowed` 첫 단계에서 모든 `Upgrade` 헤더를 거부하고 websocket 및 임의 upgrade 값의 404 회귀 테스트를 추가했다.
- BLOCKER 6 wp2: `ensureStarted(): Promise<void>` single-flight와 bind 후 idempotence, 마지막 link 삭제 직후 `close()`, wp4 supervisor가 나중에 등록해도 먼저 멈추는 optional-listeners stop slot을 명시했다.
- K6/K14에 맞춰 field chain, lifecycle 순서, 테스트 표, `structure/runtime.md` 반영 문구의 기존 모호성을 제거했다. `003_decisions.md`와의 남은 불일치는 없다.

## wp2 P 재검증 (아키텍트 Bacon, gpt-6-sol high, 2026-09-25)

| ID | 제안 | 처분 |
|---|---|---|
| W2-1 | 앵커와 before 스니펫 현재 코드와 일치, wp1 API 일치 | 유지 |
| W2-2 | `/readyz`는 현재 인증 없이 응답(serve-options.ts:592-627). 링크 입구만 GET 게이트 뒤, readiness 반환 전에 `resolveApiAuth(req, policy)` 추가. HEAD /readyz 404 유지(K8) | 수용. 테스트: 키 없음 401, 다른 키 401, 기록된 키는 인증을 통과해 기존 readiness 의미대로 200 또는 503(pending/failed, serve-options.ts:608-626)을 받는다 |
| W2-3 | 일반 경로는 policy로 해석(serve-options.ts:536,678,774,839,1257,1294,1316,1352,1379,1404,1470,1489,1521,1581,1629; 구현 체크리스트로 유지). 직접 소비자 audio-upstream, audio-client, hub-usage 두 호출 모두에 링크 제한 전달 | 수용 |
| W2-4 | serve-options.ts:1871이 GUI 제공에 `isApiAuthRequired(config)`를 넘긴다. 허용 목록 게이트가 모든 분기보다 앞서 있어야만 도달 불가 | 수용: 그 인자를 `policy`로 바꾸고 `/`와 GUI 경로 404 테스트 추가 |
| W2-5 | 동기 구간 검사(tests/lab/core-lab-boundary.test.ts:1010-1025)의 수신자 호출 허용 목록에 `optionalListeners.start()` 없음 | 수용: 허용 목록에 추가, start 구현이 동기임을 테스트로 고정 |
| W2-6 | index.ts 순증 0 주장은 근거 부족(현재 890, 상한 893) | 수용: 최종 줄 수를 재서 893 이하 확인. 넘으면 배선을 optional-listeners.ts로 옮긴다 |
| W2-7 | structure/runtime.md:260-263의 "선택 리스너 바인드 실패 시 앞선 소켓 롤백" 문장이 K5와 충돌 | 수용: hub-link는 경고 + failed{bind}로 남고 공용 리스너는 유지된다고 고친다 |
- 반영 확인(Bacon): ALIGNED. 남은 틈 2개(W2-3 전체 줄 목록, W2-2 readiness 상태 허용)를 위 표에 반영.

## 감사 반영 (Gibbs FAIL r1, wp2 계획 감사)

1. 조기 링크 인증 게이트 (차단 1). `serve-options.ts`에서 `ingress === "hub-link"`이면 경로 게이트(`linkRouteAllowed`)와 `policy = linkPolicy()` 생성 직후, 패키지 트리 검사(현재 :348-380), OPTIONS(:383-400), 드레인 응답, readiness보다 먼저 `resolveApiAuth(req, policy)`(기존 두 인자 서명, policy는 `linkIngress`를 가진 링크 정책)를 실행하고 실패하면 401을 반환한다. 이후의 모든 기존 resolver 호출(:536,678,774,839,1257,1294,1316,1352,1379,1404,1470,1489,1521,1581,1629와 직접 소비자)은 그대로 링크 제한을 받는다(경합 대비 이중 검사). W2-2의 `/readyz` 전용 검사는 이 게이트로 대체되지만, readiness 응답 의미(200/503)는 유지.
2. 자격 증명 거부 행렬 (차단 2). `tests/server/link-listener-admission.test.ts`에서 실제 Bun.serve 링크 리스너(127.0.0.1:0, 임시 OPENCODEX_HOME, links.json에 id 하나)에 요청한다. 경로: `POST /v1/responses`, `POST /v1/chat/completions`, `POST /v1/messages`, `POST /v1/messages/count_tokens`, `GET /v1/models`, `POST /v1/images/generations`, 이미지·아티팩트·컨텍스트·검색 경로(현재 loopbackRouteAllowed 허용 집합 중 링크 허용 집합에 포함되는 것 전부, 구현 시 배열로 고정), `POST /v1/audio/transcriptions`, 라이브 오디오 캐리어, `GET /v1/usage`(hub-usage 두 검사). 자격 증명 4종: (a) OPENCODEX_API_AUTH_TOKEN 환경 변수 값, (b) links.json에 없는 활성 apiKeys 키, (c) pendingRotation 키, (d) links.json에 있는 키. (a)(b)(c)는 전부 401, (d)는 401이 아님(핸들러 도달: 업스트림 없는 설정에서 핸들러 고유 오류 코드로 판별). 추가로 모든 경로에 `Upgrade: websocket`, `Upgrade: h2c` → 거부, `/`, `/dashboard`, `/api/config`, `/opencodex-session` → 404, `HEAD /readyz` → 404, `HEAD /v1/catalog`(키 포함) → 200.
3. 실패·경합 (차단 3). `tests/server/link-listener-lifecycle.test.ts`: (i) 점유된 포트로 첫 바인드 실패 → 상태 failed{bind}, 공용 리스너 `/healthz` 200 유지; (ii) `writeLinkStore`를 주입 가능한 의존성으로 만들어 listenerPort 저장 실패를 일으키면 링크 소켓이 닫히고 상태 failed{bind}, 공용 리스너 유지; (iii) 동시 `ensureStarted()` 두 번이 같은 Promise 객체를 반환(`toBe`); (iv) `close()` 진행 중 `ensureStarted()` 호출 → close 완료 전에는 재바인드하지 않고, close 뒤 새 호출에서만 바인드; (v) 마지막 링크 삭제 후 `close()` → 즉시 연결 거부.
4. 동기 구간 (차단 4). `tests/lab/core-lab-boundary.test.ts`의 수신자 허용 목록에 `optionalListeners.start`를 추가하고, 같은 파일에 소스 검사를 추가한다: `src/server/index/optional-listeners.ts`의 `start`와 `src/server/index/link-listener.ts`의 첫 바인드 경로 함수 선언이 `async`가 아니고 본문에 최상위 `await`가 없음을 기존 스캐너(주석·문자열·중첩 함수 무시)로 확인한다. 동적 import는 `ensureStarted` 경로에만 허용.
5. 비차단: index.ts 줄 수와 structure/layout 게이트는 B 끝에서 추적 파일 기준으로 다시 잰다.


## 감사 반영 (Gibbs FAIL r2) — 위 r1 반영 절을 다음처럼 확정한다

1. 호출 모양(본문 "auth-cors.ts, audio, usage MODIFY" 절의 계약을 그대로 따른다): 조기 게이트는 `resolveApiAuth(req, policy)` 두 인자로 호출하고, 링크 제한은 `RequestPolicyView.linkIngress: { allowedKeyIds }`가 들고 간다. `resolveApiAuth`/`resolveResponsesApiAuth`는 그것을 `resolveDataPlaneAdmissionSecret(token, config, source, { linkIngress: policy.linkIngress?.allowedKeyIds })`의 네 번째 인자 `DataPlaneAdmissionOptions`로 넘긴다. 직접 소비자는 `config`만 받던 서명에 선택 인자 `options: DataPlaneAdmissionOptions = {}`를 추가하고(`resolveAudioAdmission(headers, config, options)`, audio-client의 해당 함수, `handleHubUsage`의 두 resolver 호출), `serve-options.ts`의 각 호출 지점이 링크 입구일 때 `{ linkIngress: policy.linkIngress?.allowedKeyIds }`를 전달한다. 옵션이 없으면 기존 동작과 같다. r1 절과 이전 판의 `linkAdmission`·세 번째 인자 표기는 폐기한다.
2. 테스트 파일과 등록: 새 테스트는 `tests/server/link-listener-admission.test.ts`, `tests/server/link-listener-lifecycle.test.ts`, `tests/lab/core-link-boundary.test.ts` 세 개. 앞의 둘은 `scripts/test-layout/layout.json` explicit와 `tests/fixtures/test-layout-expected.json`에 "server"로, 셋째는 "lab"으로 등록(파일명이 lab 도메인 `^core-` 정규식과 맞으므로 explicit 없이도 배치되지만 명시 등록). 파일 변경 지도에 이 세 파일을 추가한 것으로 본다. 경로 행렬에 `GET /v1/catalog`, `GET /v1/hub-state`, `POST /v1/responses/compact`, `POST /v1/realtime/calls`를 추가하고, `GET /readyz`는 키 없음 401·다른 키 401·링크 키 200 또는 503을 확인한다.
3. 주입 지점: `createLinkListenerLifecycle(deps: LinkListenerDeps = {})`, `interface LinkListenerDeps { storePath?: string; readStore?: (path: string) => LinkStore; writeStore?: (path: string, store: LinkStore) => void; serve?: (options: Parameters<typeof Bun.serve>[0]) => Server; warn?: (message: string) => void }`. 기본값은 `linkStorePath()`, `readLinkStore`, `writeLinkStore`, `Bun.serve`, `console.warn`. 테스트는 writeStore에서 throw, serve에서 EADDRINUSE를 주입한다. optional-listeners는 이 deps를 그대로 넘기는 선택 인자를 받는다.
4. 동기 검사: 스캐너가 대상 파일에서 `start`를 다음 세 형태 모두로 찾는다: 메서드 단축형(`start(...) {`), 속성(`start: (...) =>`, `start: function`), 선언(`function start`). 찾은 모든 정의에서 `async` 수식어가 없고, 본문 최상위(중첩 함수·주석·문자열 제외)에 `await`가 없음을 확인한다. 정의를 하나도 못 찾으면 실패(공허한 통과 방지). 대상은 `src/server/index/optional-listeners.ts`와 `src/server/index/link-listener.ts`.

