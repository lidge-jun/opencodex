# 030 — wp3: 클라이언트 link transport와 /v1 relay

상위 문서: 000_prd.md r2, 001_stack_plan.md, 002_arch_plan.md, 010_wp1_link_core.md
대상 레이어: L3, 브랜치 codex/remote-link-3-client

## 범위(IN/OUT)

IN은 연결된 클라이언트의 link transport다. OcxClientConnectionConfig에 선택적 transport와 link를 추가하고, 저장 스키마가 두 필드의 결합을 검증한다. connectClient는 기존 허브 키 발급 경로와 stdin JSON으로 받은 링크 키 경로를 분리한다. 링크 경로는 serverUrl=managementUrl=http://127.0.0.1:<tunnelPort>를 사용하고, Codex의 라우팅 대상은 클라이언트 자신의 http://localhost:<config.port>/v1로 둔다. 클라이언트 machine listener는 link 모드에서 HTTP /v1/*를 중계하며 요청에 자격 증명을 추가하지 않는다. 터널 거부는 503과 Retry-After: 1로 표현한다. rotate, revoke, 기존 management relay는 link 모드에서 거부 또는 비활성화한다.

OUT은 wp1의 src/link/ 순수 모듈, wp2의 허브 link listener와 링크 입구 인증, wp4의 SSH supervisor 및 ocx link issue|port|status, wp5 GUI, wp6 클라이언트 주도 -L 흐름이다. link issue가 발급한 JSON의 소비만 이 레이어가 담당한다. WebSocket Upgrade는 이 단계에서 HTTP relay 대상이 아니며, 필요하면 별도 계약으로 올린다.

현재 근거는 다음과 같다. 기존 연결 타입에는 transport/link가 없다(src/types/config.ts:400-413). 스키마는 canonical origin과 허브 transport만 검증한다(src/config/schema/leaf-validators.ts:853-893). 연결은 항상 fetchHubReady 후 issueClientKey를 호출한다(src/client/connect.ts:497-540). catalog과 Codex 주입도 같은 serverUrl을 사용한다(src/client/connect.ts:552-589). machine listener는 /v1/*를 기본 거부한다(src/client/machine-listener.ts:42-55).

## 파일 변경 지도

| 경로 | 종류 | 변경 내용과 근거 |
|---|---|---|
| src/types/config.ts:400-413 | MODIFY | transport?: "hub"|"link", link?: { tunnelPort; linkId }와 내부 link credential 타입의 기준을 추가 |
| src/config/schema/leaf-validators.ts:853-893 | MODIFY | link 구조, 포트/ID, loopback origin, transport/managementTransport 결합을 superRefine에서 검증 |
| src/client/connect.ts:82-96,161-166,359-365,368-455,497-657,659-710,934-948 | MODIFY | credential 전략 분리, link catalog 경로, localhost Codex target, link mode의 rotate/revoke 거부, sync target 보정 |
| src/client/hub-client.ts:200-231,435-480,528-565 | MODIFY | link readiness에 선택적 key header를 추가하고 catalog/hub-state 호출이 link key를 `x-opencodex-api-key`로 계속 전송하도록 계약을 고정 |
| src/client/link-relay.ts | NEW | HTTP /v1 relay의 대상 URL, hop-by-hop header 제거, 응답 header 정리, 503 변환 |
| src/client/machine-listener.ts:42-55,81-153 | MODIFY | link mode route admission, relay 호출, management relay 비활성화 |
| src/cli/connect.ts:56-64,304-376,378-386 | MODIFY | ocx connect --link --key-stdin --tunnel-port P --link-id ID 파싱과 stdin JSON 검증 |
| tests/clients/client-connect-link.test.ts | NEW | connect transaction, local Codex target, issueClientKey 미호출, sync/disconnect |
| tests/clients/client-machine-listener-link.test.ts | NEW | header/Host relay, 503, management relay 차단, Upgrade 차단 |
| tests/config/config-client-link.test.ts | NEW | schema의 valid/invalid 조합 |
| tests/cli/cli-connect-link.test.ts | NEW | CLI flags, JSON stdin, secret 비출력, rotate/revoke refusal |
| structure/runtime.md | MODIFY | client link data relay와 link mode 관리면 차이를 현재형으로 기록 |
| structure/config.md | MODIFY | persisted client transport/link invariant와 validation을 현재형으로 기록 |
| structure/manifest.json | NO CHANGE | src/client/, src/cli/, src/config/, src/types/가 이미 문서 매핑에 포함되어 있다(structure/manifest.json:71-119,270-274) |
| structure/INDEX.md | NO CHANGE | manifest 변경이 없어 생성 결과도 변하지 않음 |
| docs-site/src/content/docs/guides/remote-hub.md 및 번역본 | FOLLOW-UP MODIFY | 사용자용 link connect 흐름과 rotate/revoke 제한을 문서화. 이 PR에서 구현하지 않으면 PR 본문에 후속 범위를 명시 |

## 새 파일/변경 상세

### src/types/config.ts

현재 블록은 serverUrl, managementUrl, managementTransport로 시작한다(src/types/config.ts:400-403).

변경 후 선언은 다음 모양이다.

~~~ts
export interface OcxLinkTransportConfig {
  tunnelPort: number;
  linkId: string;
}

export interface OcxClientConnectionConfig {
  serverUrl: string;
  managementUrl: string;
  managementTransport: "direct" | "relay";
  transport?: "hub" | "link";
  link?: OcxLinkTransportConfig;
  selectedClients: OcxConnectedClientId[];
  tokenEnv: "OPENCODEX_API_AUTH_TOKEN";
  apiKeyId: string;
  tokenFingerprint: string;
  protocolVersion: 1;
  connectedAt: string;
  // existing catalog, priorCatalog, catalogSyncedAt, pendingOperation fields remain
}
~~~

transport가 없으면 기존 설정을 hub로 해석한다. 새 connect commit은 명시적으로 "link" 또는 "hub"를 기록하되, 기존 파일을 일괄 재작성하지 않는다. linkId는 wp1의 LinkRecord.id 형식 lnk_[0-9a-f]{16}을 그대로 사용한다.

### src/config/schema/leaf-validators.ts

현재 clientConnectionSchema는 serverUrl부터 pendingOperation까지 strict object로 끝난다(src/config/schema/leaf-validators.ts:863-893).

추가할 leaf와 결합 검사는 다음이다.

~~~ts
const clientTransportSchema = z.enum(["hub", "link"]);
const linkTransportSchema = z.object({
  tunnelPort: z.number().int().min(1).max(65535),
  linkId: z.string().regex(/^lnk_[0-9a-f]{16}$/),
}).strict();

export const clientConnectionSchema = z.object({
  serverUrl: clientOriginSchema,
  managementUrl: clientOriginSchema,
  managementTransport: z.enum(["direct", "relay"]),
  transport: clientTransportSchema.optional(),
  link: linkTransportSchema.optional(),
  // existing fields
}).strict().superRefine((connection, ctx) => {
  const transport = connection.transport ?? "hub";
  if (transport === "hub" && connection.link !== undefined) {
    ctx.addIssue({ code: "custom", path: ["link"], message: "link is allowed only when transport is link" });
    return;
  }
  if (transport !== "link") return;
  if (!connection.link) {
    ctx.addIssue({ code: "custom", path: ["link"], message: "link is required when transport is link" });
    return;
  }
  if (connection.managementTransport !== "direct") {
    ctx.addIssue({ code: "custom", path: ["managementTransport"], message: "link transport requires direct management transport" });
  }
  if (connection.serverUrl !== connection.managementUrl) {
    ctx.addIssue({ code: "custom", path: ["managementUrl"], message: "link transport requires serverUrl and managementUrl to match" });
  }
  const origin = new URL(connection.serverUrl);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1"
    || origin.port !== String(connection.link.tunnelPort)) {
    ctx.addIssue({ code: "custom", path: ["serverUrl"], message: "link transport requires http://127.0.0.1:<tunnelPort>" });
  }
});
~~~

실제 구현에서는 기존 필드 전체를 유지한 뒤 이 superRefine를 마지막에 붙인다. clientOriginSchema가 이미 canonical origin을 반환하므로 비교는 변환 후 값으로 한다. malformed hand edit는 기존 진단/완화 흐름을 따르며, 유효하지 않은 link를 hub로 조용히 내리지 않는다.

### src/client/connect.ts

현재 ConnectOptions는 두 종류의 허브 credential 중 하나를 요구한다(src/client/connect.ts:82-96). 다음 내부 타입을 추가한다.

~~~ts
export interface LinkClientCredential {
  kind: "link";
  apiKeyId: string;
  key: string;
}

type ConnectCredential = OneTimeConnectCredential | LinkClientCredential;
~~~

ConnectOptions.credential을 ConnectCredential로 넓히고 transport?: "hub"|"link", link?: { tunnelPort: number; linkId: string }를 추가한다. link 분기에는 다음 순서를 고정한다.

1. transport ?? "hub"를 결정하고 link이면 link, LinkClientCredential, 포트, ID, ocx_data_[0-9a-f]{40}를 검증한다.
2. link branch는 첫 network fetch 전에 LinkClientCredential.key를 기존 `writeServiceApiTokenFile`로 service-api-token에 저장하고, 같은 lock 아래 `readServiceApiTokenState()`를 다시 읽는다. 결과가 `{ kind: "present" }`가 아니면 중단하며 파일 경로는 `serviceApiTokenFilePath()`가 정한다(src/lib/service-secrets.ts:19-49). 이 재독된 `serviceToken.token`만 link admission key로 사용한다.
3. serverUrl과 managementUrl을 정확히 `http://127.0.0.1:<tunnelPort>`로 만들고, `fetchHubReady(serverUrl, { fetchImpl: deps.fetchImpl, timeoutMs: options.catalogTimeoutMs, linkKey: serviceToken.token })`를 호출한다. `GET /readyz`에는 `x-opencodex-api-key: <serviceToken.token>`을 넣고 Authorization, URL credential, query parameter에는 key를 넣지 않는다. link ingress의 K7 key admission은 wp2가 소유하며, 현재 loopback policy가 auth를 우회할 수 있는 지점은 `src/server/auth-cors.ts:554-564`다.
4. link에서는 issueClientKey, pairing 교환, hub cleanup credential을 호출하지 않는다. `downloadClientCatalog(serverUrl, serviceToken.token, ...)`는 `GET http://127.0.0.1:<tunnelPort>/v1/catalog`, `fetchHubState(serverUrl, serviceToken.token, ...)`는 `GET http://127.0.0.1:<tunnelPort>/v1/hub-state`를 사용하고 둘 다 같은 `x-opencodex-api-key`를 보낸다. 두 route의 현재 key admission은 `src/server/index/serve-options.ts:668-680,755-777`에서 확인한다.
5. 기존 pending marker, service token, prior catalog, catalog compatibility gate는 동일한 순서로 수행한다(src/client/connect.ts:541-566).
6. Codex 주입에는 hub mode의 <serverUrl>/v1 대신 http://localhost:<config.port>/v1 target을 준다. catalog와 hub state/usage 같은 내부 client fetch는 link tunnel origin을 계속 사용한다.
7. commit object에는 transport: "link"와 link: { tunnelPort, linkId }를 저장한다. key 자체는 config나 links.json에 쓰지 않는다. hub mode는 기존 object를 유지한다(src/client/connect.ts:592-615).
8. rollback에서 원격 revoke는 issued && cleanupCredential인 hub 경로에서만 수행한다(src/client/connect.ts:617-646).

routingTarget은 현재 단일 serverUrl을 baseUrl로 만드는 함수다(src/client/connect.ts:161-166). 이를 routingTarget(serverUrl, localPort?: number)으로 바꾸고, link이면 http://localhost:<localPort>/v1, 아니면 기존 <serverUrl>/v1을 반환한다. syncConnectedClient의 주입 지점(src/client/connect.ts:674-710)도 persisted transport를 보고 같은 선택을 해야 한다.

rotate/revoke는 연결 상태를 읽은 직후 link transport를 검사한다. rotateConnectedClientKey와 pending rotation recovery, revokeConnectedClientKey 모두 connect key rotation/revocation is unavailable in link mode를 반환하고 네트워크 호출을 하지 않는다(src/client/connect.ts:359-365,380-407,934-948). 해제는 기존 로컬 복구/삭제를 수행하며 허브 링크 record 삭제는 wp4가 담당한다. desktopOwner의 기존 identity는 serverUrl/apiKeyId/connectedAt를 계속 사용하므로 Claude Desktop 소유권 판정은 link에서도 동일하게 유지한다.

link ingress 인증을 구현하는 `src/client/hub-client.ts`의 변경 surface는 다음으로 고정한다. 실제 signature 변경은 `fetchHubReady`의 `linkKey?: string` 추가이며, catalog/state signature도 함께 적어 caller가 기존 admission token 위치에 무엇을 전달하는지 고정한다. link에서는 반드시 위에서 service-api-token에서 읽은 `serviceToken.token`을 넘긴다.

~~~ts
export async function fetchHubReady(
  serverUrl: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch; linkKey?: string } = {},
): Promise<{ status: "ready" | "pending" | "failed"; metadata: RemoteReadyMetadata }>;

export async function downloadClientCatalog(
  serverUrl: string,
  admissionToken: string,
  options: { timeoutMs?: number; maxBytes?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ kind: "fresh"; body: string; keyId?: string }>;

export async function fetchHubState(
  serverUrl: string,
  admissionToken: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<HubStateDTO>;
~~~

`fetchHubReady`가 `linkKey`를 받은 경우에만 `Headers({ Accept: "application/json", "x-opencodex-api-key": linkKey })`를 만들어 `GET ${normalizeHubOrigin(serverUrl)}/readyz`에 붙인다. 401은 `HubClientError`의 status 401로 표면화한다. `downloadClientCatalog`와 `fetchHubState`는 기존 `admissionToken` 인자와 header 설정을 유지하되, link caller가 service token file에서 읽은 값만 전달하는 것을 contract로 한다(src/client/hub-client.ts:200-231,435-448,528-537).

### src/client/link-relay.ts NEW

새 파일은 250줄 이하의 순수 HTTP relay leaf로 둔다. 제안하는 exported surface와 동작은 다음과 같다.

~~~ts
export interface LinkRelayTarget {
  tunnelPort: number;
}

export interface LinkRelayDeps {
  fetchImpl?: typeof fetch;
}

export const LINK_RELAY_RETRY_AFTER_SECONDS = 1;

export function linkRelayDestination(url: URL, target: LinkRelayTarget): string;
export function forwardLinkRequestHeaders(source: Headers): Headers;
export function sanitizeLinkResponseHeaders(source: Headers): Headers;
export async function relayLinkDataRequest(
  req: Request,
  target: LinkRelayTarget,
  deps?: LinkRelayDeps,
): Promise<Response>;
~~~

구현 단계는 고정한다.

1. 호출자는 Upgrade가 없고 pathname이 /v1/로 시작하는 HTTP request만 넘긴다. `relayLinkDataRequest`도 `req.headers.get("upgrade")`가 있으면 upstream fetch 없이 기존 404 경계로 거부하고, `machineRouteAllowed`의 선행 거부와 함께 K9 HTTP-only를 보장한다.
2. destination은 http://127.0.0.1:<tunnelPort><pathname><search>로 만든다. 원 요청의 Host를 제거하고 destination host를 127.0.0.1:<tunnelPort>로 설정한다.
3. connection, keep-alive, transfer-encoding, upgrade, te, trailer, proxy-authenticate, proxy-authorization, host, content-length만 제거한다. authorization과 x-opencodex-api-key는 그대로 전달하고 새 credential은 만들지 않는다. body가 있으면 req.body, duplex: "half", req.signal, redirect manual을 사용한다. 요청 본문을 로그에 쓰지 않는다.
4. fetch 거부나 abort를 JSON 503으로 바꾸고 Retry-After: 1을 붙인다. upstream response는 status/statusText/body를 유지하되 fetch가 이미 decode한 body와 충돌하는 content-encoding, content-length 및 hop-by-hop response header를 제거한다.
5. 응답 stream은 caller가 취소할 때 upstream body도 취소한다. relay helper는 key, URL credential, request body를 오류 문자열에 넣지 않는다.

### src/client/machine-listener.ts

현재 machineRouteAllowed(url, req, relayEnabled)는 /v1/를 무조건 거부한다(src/client/machine-listener.ts:42-55). signature를 machineRouteAllowed(url, req, relayEnabled, linkMode)로 확장한다. linkMode && /v1//이면 Upgrade가 없는 경우만 허용하고, 다른 path에 대한 현재 allowlist는 유지한다.

startMachineListener는 connection.transport === "link"를 linkMode로 계산하고 relayEnabled = !linkMode && connection.managementTransport === "relay"로 바꾼다. fetch 내부에서 machine API와 GUI 처리 전에 link /v1/를 relayLinkDataRequest(req, { tunnelPort: connection.link!.tunnelPort })로 반환한다. link invariant가 깨진 state는 schema/state read 단계에서 실패하며 non-null assertion은 이 branch 직전의 guard로 보호한다. /api machine relay는 link mode에서 404가 된다.

### src/cli/connect.ts

현재 usage는 positional URL과 pairing/admin stdin만 표현한다(src/cli/connect.ts:56-64). 다음 줄을 추가한다.

~~~text
  ocx connect --link --key-stdin --tunnel-port <port> --link-id <id>
      [--clients codex,claude] [--catalog-timeout <seconds>] [--no-sync]
~~~

현재 runConnect는 첫 positional을 URL로 소비한 뒤 두 credential flag 중 하나를 요구한다(src/cli/connect.ts:326-356). link branch는 positional URL을 받지 않고 --tunnel-port, --link-id, --key-stdin을 모두 요구한다. stdin 한 줄을 기존 readSecretLine으로 읽고 JSON {apiKeyId:string,key:string}만 허용한다. ID와 key는 schema와 같은 bounded format으로 검증하고, key 값은 stdout, error, status JSON에 넣지 않는다. --link에서 pairing/admin, --management-url, --management-transport를 함께 주면 usage error다. link connect는 내부적으로 양쪽 URL을 동일한 loopback origin으로 만들고 transport: "link"를 전달한다.

기존 hub branch의 positional URL, pairing/admin, readiness report는 그대로 유지한다. runRotate와 runRevoke는 runtime guard가 link mode를 거부하는 결과를 사람이 읽을 수 있게 유지한다(src/cli/connect.ts:304-323,378-386).

## 필드 체인

### PLAN-FIELD-CHAIN-01: transport

생성: CLI의 --link가 link strategy를 선택하고 connectClient가 transport: "link"를 connection object에 넣는다. 기존 hub connect는 필드를 생략하거나 "hub"를 사용한다.

직렬화: commitClientConnection이 기존 config mutation/seed 경로로 client.transport를 기록한다(src/client/state.ts:197-223). key는 기록하지 않는다.

역직렬화/검증: clientConnectionSchema가 optional legacy를 hub로 해석하고, link일 때 link block, direct management, 동일 loopback origin을 함께 요구한다. readClientConnectionState는 validated diagnostics 결과만 반환한다(src/client/state.ts:81-112).

모든 consumer: connectClient와 syncConnectedClient가 Codex target과 tunnel origin을 분리한다. machine-listener가 link relay 및 management relay off를 선택한다. collectClientConnectionStatus는 transport와 link id/port를 status DTO에 추가한다. rotate/revoke/recovery가 link를 거부한다. disconnect의 기존 owner/CAS는 transport를 포함한 persisted snapshot을 그대로 비교하며 로컬 복구만 수행한다. desktopOwner는 기존 세 필드 identity를 유지한다.

### PLAN-FIELD-CHAIN-01: link

생성: wp4가 발급한 {linkId, apiKeyId, key, listenerPort} 중 CLI가 linkId와 local tunnelPort를 flags/state로 받고 key/id는 credential strategy로만 넘긴다.

직렬화: client.link = { tunnelPort, linkId }만 config에 쓴다. apiKeyId는 기존 top-level field에, key는 private service-api-token에 쓴다. links.json에는 key가 없다.

역직렬화/검증: link object의 port와 ID를 schema가 검증하고, transport와 origin 관계를 superRefine가 검증한다. 손상 state는 연결된 것으로 취급하지 않는다.

모든 consumer: machine-listener는 tunnelPort로만 relay destination을 만든다. CLI/status는 linkId와 port를 표시한다. connectClient와 syncConnectedClient는 link origin과 local Codex origin을 각각 사용한다. disconnect는 link record를 지우지 않고 로컬 client state만 해제한다. link record 삭제와 key revoke는 wp4의 허브 route가 담당한다.

## 테스트 사례

모든 fixture는 mkdtempSync, 127.0.0.1, alpha.example.test 같은 합성 값만 사용한다. key JSON은 테스트 안에서만 만들고 출력 캡처에 key가 포함되지 않는지를 확인한다.

| 활성화 시나리오 | 관찰 증거 |
|---|---|
| legacy config와 hub connect | transport가 없거나 hub인 config가 기존 schema를 통과하고, 기존 connect 테스트가 /api/keys 발급과 <serverUrl>/v1 주입을 계속 관찰한다 |
| valid link connect | --link 입력 후 ready/catalog만 link loopback P로 요청되고 /api/keys 요청은 0회이며 config에 link metadata와 기존 token fingerprint가 저장된다 |
| local Codex routing | link connect가 기록한 config.toml의 base URL이 http://localhost:<config.port>/v1이고 catalog fetch의 origin은 http://127.0.0.1:<tunnelPort>임을 각각 확인한다 |
| link ingress auth | 127.0.0.1의 stub listener를 port 0으로 띄우고 `/readyz`, `/v1/catalog`, `/v1/hub-state`의 GET만 `x-opencodex-api-key: link-secret`에 200으로 응답한다. service-api-token에서 읽은 `link-secret`을 세 helper에 전달하면 세 URL이 모두 `http://127.0.0.1:<tunnelPort>`이고 header가 정확히 일치한다 |
| missing-key 401 | 같은 stub listener에서 header가 없거나 빈 경우 `GET /readyz`, `GET /v1/catalog`, `GET /v1/hub-state`가 각각 401이 된다. `fetchHubReady`, `downloadClientCatalog`, `fetchHubState`가 401 status를 보존하고 ready/catalog/state 성공으로 처리하지 않는지 확인한다 |
| wrong-key 401 | 같은 stub listener에서 `x-opencodex-api-key: wrong-key`를 보내면 세 GET이 각각 401이 되고, upstream/stub가 받은 값과 오류 메시지에 service token 원문을 출력하지 않는지 확인한다 |
| invalid schema combinations | link 누락, hub+link, relay management, 서로 다른 URL, non-loopback URL, port/ID 형식 오류가 모두 candidate validation 실패가 된다 |
| machine listener relay success | /v1/responses?x=1 요청의 destination, query, body, x-opencodex-api-key가 보존되고 Host만 127.0.0.1:P로 바뀌며 upstream status/body가 그대로 돌아온다 |
| tunnel refused | injected fetch가 connection refusal을 내면 응답이 JSON 503이고 Retry-After: 1이며 request body나 key가 오류에 나타나지 않는다 |
| management isolation | link mode의 /api/machine/hub-relay/*는 404이고 GUI session/bootstrap이 management relay를 활성화하지 않는다 |
| Upgrade path | /v1/responses Upgrade request가 relay되지 않고 404로 끝난다. WebSocket 지원이 필요하면 별도 후속 계약으로 승격한다 |
| rotate/revoke | link state에서 두 명령이 원격 fetch 전에 deterministic error로 끝나고 key 회수 요청이 발생하지 않는다 |
| disconnect and restore | link mode disconnect가 기존 prior catalog/Codex journal/service token을 기존 ownership check로 복구하고 config client/runtimeRole을 제거한다. 허브 links.json 삭제는 수행하지 않는다 |
| malformed stdin | 빈 입력, malformed JSON, 누락 field, 잘못된 key/id가 usage error가 되고 stdout에 secret이 없다 |
| no-link core path | transport 없는 standalone/hub에서 link relay 모듈이 import되어도 socket/process/timer가 생기지 않고 machine listener의 기존 404 경계가 유지된다 |

## 검증 명령

이 문서 작성 시 실제 실행한 명령과 대상 문서와의 관계를 기록한다. 아래 source/test 명령은 새 설계 문서를 읽지 않으며, privacy scan과 target existence check만 change target을 읽는다. test:changed의 exit 1은 테스트 실패가 아니라 변경 문서가 module graph에 연결되지 않아 선택된 테스트가 0개였다는 wrapper 판정이다.

| 명령 | exit code | change target 읽음 | 결과 |
|---|---:|---|---|
| bun run typecheck | 0 | 아니오 | 현재 워크트리 strict TypeScript 통과 |
| bun test tests/clients/client-connect.test.ts tests/clients/client-machine-listener.test.ts | 0 | 아니오 | 59 pass, 0 fail |
| bun run privacy:scan | 0 | 예 | 문서 작성 후 target을 포함해 Privacy scan passed |
| 지정 문서·소스와 target test -f 묶음 | 0 | 예 | 필수 문서·source와 030 target 존재, 341 lines |
| bun run skill:surface:check | 0 | 아니오 | generated skill surface is current |
| bun run structure:check | 0 | 아니오 | structure/ SSOT checks passed |
| bun run test:changed | 1 | 아니오 | inner Bun run은 0 tests/0 fail이었지만 changed selection이 0이라 wrapper가 exit 1; focused tests가 보완 증거 |

구현 PR의 새 테스트 파일을 만들면 기존 domain의 clients, config, cli에 배치하고, 두 layout 파일의 explicit에 각각 다음을 등록한다.

~~~json
{
  "client-connect-link.test.ts": "clients",
  "client-machine-listener-link.test.ts": "clients",
  "config-client-link.test.ts": "config",
  "cli-connect-link.test.ts": "cli"
}
~~~

구현 완료 시에는 위 focused tests에 네 파일을 추가하고 bun run typecheck, bun run test:changed, bun run privacy:scan, bun run skill:surface:check를 다시 실행한다. WP3는 full test suite를 요구하지 않으며, full suite는 parent review gate가 필요할 때 수행한다.

## 우회 경로 기록

| tier | surface | bypass | residual risk |
|---|---|---|---|
| E-client | client machine listener | 같은 클라이언트 host의 로컬 프로세스가 10100에 직접 요청할 수 있는 기존 loopback 신뢰 | 기존 local process trust가 유지되며 link mode가 허브 권한을 추가하지 않음 |
| E-link | link /v1 relay | tunnel이 끊긴 동안 local listener를 우회해 provider에 직접 도달하는 경로는 없음 | 요청은 503으로 실패하고 local provider fallback을 사용하지 않음 |
| E-control | rotate/revoke | link key 수명 변경은 client CLI가 아니라 wp4 허브의 정식 관리 화면/route에서 수행 | link record와 hub key의 삭제는 wp4 구현과 세션 검증에 의존 |
| E-transport | HTTP-only relay | Upgrade/WebSocket은 relay하지 않음 | Codex/Claude가 link에서 WS를 요구하면 기능이 막히며 silent fallback은 없음 |

호스트 키 확인을 사용자가 직접 known_hosts에 넣는 우회는 wp1/002의 기록을 그대로 따른다. 이 문서에는 새 security finding을 추가하지 않는다.

## file-size ratchet headroom

현재 tests/fixtures/file-size-baseline.json에는 이 WP3의 기존 source/test 후보가 cap entry로 등록되어 있지 않다. 따라서 src/types/config.ts, src/config/schema/leaf-validators.ts, src/client/connect.ts, src/client/machine-listener.ts, src/cli/connect.ts, src/client/link-relay.ts와 네 신규 테스트는 현재 baseline cap이 없다. 문서 작성 시 확인한 baseline은 51개 tracked file에 대한 JSON이며, link 관련 파일 cap은 없다.

새 relay와 테스트는 기존 대형 파일에 붙이지 않고 sibling 파일로 둔다. 구현자가 기존 ratchet 파일에 테스트를 삽입하면 cap을 재확인하고, cap 초과 시 테스트를 새 domain 파일로 이동한다. baseline JSON 자체는 이 WP3에서 올리지 않는다.

## test layout registration entries

신규 테스트는 모두 기존 domain에 둔다.

- tests/clients/client-connect-link.test.ts → clients
- tests/clients/client-machine-listener-link.test.ts → clients
- tests/config/config-client-link.test.ts → config
- tests/cli/cli-connect-link.test.ts → cli

각 이름을 scripts/test-layout/layout.json의 explicit와 tests/fixtures/test-layout-expected.json에 같은 값으로 넣는다. 새 source 파일은 test layout 등록 대상이 아니다.

## structure/ doc updates

structure/manifest.json은 이미 source directory ownership을 충족하므로 entry나 tier를 바꾸지 않는다. structure/runtime.md의 “The client role owns no management plane” 단락에 link mode의 HTTP /v1 relay, 127.0.0.1:tunnelPort destination, direct-only management와 503 retry semantics를 추가한다. “Remote Hub hardening ownership”에는 src/client/link-relay.ts가 data relay를 소유하고 src/client/hub-relay.ts는 link mode에 사용하지 않는다는 문장을 추가한다. structure/config.md에는 client connection row 또는 client lifecycle 설명에 legacy hub default, link invariant, key-not-persisted 규칙을 추가한다.

구조 문서를 실제로 수정하는 구현자는 structure/AGENTS.md:114-121 절차대로 manifest 확인 후 bun run structure:index와 bun run structure:check를 실행한다. manifest에 새 source path를 넣지 않으므로 INDEX 재생성 결과가 바뀌지 않아야 한다.

## docs-site impact

사용자에게 보이는 새 CLI 사용법과 link mode 제약이 생기므로 문서 영향이 있다. 기준 문서는 docs-site/src/content/docs/guides/remote-hub.md, docs-site/src/content/docs/reference/cli/lifecycle.md, docs-site/src/content/docs/reference/configuration/server.md이며, 번역본은 영어 기준과 모순되지 않도록 후속으로 갱신한다. 이 L3 PR에서는 GUI 페이지와 screenshot을 추가하지 않는다. docs-site를 같은 PR에서 업데이트하지 않으면 PR 본문에 문서 후속 작업을 명시하고, 사용자가 실제로 복사할 link command와 link mode의 rotate/revoke 제한을 임시 README에 복제하지 않는다.

## PR title/body notes

제목: feat(link): add client link transport and /v1 relay

본문에는 다음을 기록한다.

- 문제: SSH link로 받은 client key를 기존 hub key issuance 흐름에 넣을 수 없고, client Codex가 local 10100을 통해 tunnel P로 요청할 수 없다.
- 변경: config/schema transport split, stdin JSON credential, local Codex target, HTTP /v1 relay, refusal 503, link mode management relay/rotate/revoke guard.
- Verification: 새 clients/config/cli focused tests, bun run typecheck, bun run test:changed, bun run privacy:scan; full suite를 실행하지 않았다면 그 사실과 남은 coverage를 적는다.
- Security review: 인증 경계와 key credential handling이 바뀌므로 MAINTAINERS.md 기준 explicit security review가 필요하다. link key는 stdout/log/config/links.json에 쓰지 않으며, link ingress의 최종 key admission은 wp2가 소유한다.
- Stack relation: base는 wp1/wp2 결과이며, wp4의 ocx link issue|port와 links.json lifecycle에 의존한다.

## Contract deviations

공유 인터페이스의 이름과 필드는 바꾸지 않는다. transport, link.tunnelPort, link.linkId, --link, --key-stdin, --tunnel-port, --link-id는 그대로 유지한다.

두 가지 구현 범위 보강이 있다. 첫째, 002의 WP3 파일 지도에는 CLI parser가 직접 적혀 있지 않지만 공유 계약의 명령 문법을 실제로 만들려면 src/cli/connect.ts 수정이 필요하다. 둘째, relay를 machine listener에 복사하지 않고 src/client/link-relay.ts leaf로 분리한다. 둘 다 public contract deviation이 아니라 기존 source boundary를 보존하기 위한 내부 계획 확장이다. ocx link issue|port와 capability/skill-surface 등록은 002의 정정대로 wp4에 남긴다.

## 열린 질문

1. Codex 또는 Claude의 link transport가 /v1/responses WebSocket Upgrade를 요구하는지 L3 실제 client trace로 확인해야 한다. 요구하면 HTTP-only 결정을 폐기하고 Bun WebSocket proxy의 owner와 cancellation contract를 별도 문서로 추가한다.
2. wp2의 /readyz 응답이 link ingress에서 client가 요구하는 RemoteReadyMetadata를 모두 제공하는지, fetchHubReady의 기존 protocol check와 함께 확인해야 한다.
3. config.port=0인 test fixture에서 link Codex target을 http://localhost:0으로 만들지, 실제 bound machine listener port를 주입하는 테스트 seam을 둘지 결정해야 한다. 운영 config의 기본 포트는 10100이다.
4. docs-site 영어 기준과 10개 GUI locale의 사용자 용어 “Home / Child” 동기화는 wp5 범위로 남긴다. 실제 목록은 `gui/src/i18n/shared.ts:6-17`의 `LOCALES`가 authoritative하다.


## MODIFY별 적용 전/후 shape

아래는 각 MODIFY 항목에 대한 적용 지점이다. 기존 코드를 삭제하는 경우에도 기존 허브 분기는 보존한다.

| 파일 | 적용 전 | 적용 후 |
|---|---|---|
| `src/types/config.ts:400-413` | `managementTransport: "direct" | "relay";` 다음에 `selectedClients`가 이어지고 transport discriminator가 없다 | `managementTransport` 다음에 `transport?: "hub" | "link";`와 `link?: { tunnelPort: number; linkId: string };`를 삽입하고 기존 필드는 그대로 둔다 |
| `src/config/schema/leaf-validators.ts:863-893` | `clientConnectionSchema`가 `managementTransport`, 기존 연결 필드, `pendingOperation`을 `.strict()`로 검사한다 | 같은 object에 `transport`와 strict `link` object를 넣고 `.superRefine((connection, ctx) => ...)`에서 legacy hub default, link required, direct-only management, loopback origin, port/id 결합을 검사한다 |
| `src/client/connect.ts:82-96` | `ConnectOptions.credential`이 `OneTimeConnectCredential`이고 `serverUrl`이 필수다 | credential union에 `{ kind: "link"; apiKeyId: string; key: string }`를 추가하고 link connect에는 `link`, `tunnelPort`, `linkId`를 받는 별도 strategy를 둔다 |
| `src/client/connect.ts:513-540` | `normalizeHubOrigin(options.serverUrl)` 후 `fetchHubReady`, pairing exchange 또는 admin authority, `issueClientKey`를 순서대로 수행한다 | hub strategy는 그대로 두고 link strategy는 `http://127.0.0.1:<tunnelPort>`를 두 URL로 설정한 뒤 `fetchHubReady`와 catalog fetch만 수행하며 `issueClientKey`와 pairing exchange를 호출하지 않는다 |
| `src/client/connect.ts:552-589` | `downloadClientCatalog(serverUrl, issued.key)`와 `routingTarget(serverUrl)`가 모두 같은 hub origin을 사용한다 | catalog는 link tunnel origin/key를 사용하고 Codex injection만 `http://localhost:<config.port>/v1`를 사용한다. `routingTarget` 호출부와 sync 호출부 모두 같은 선택 함수를 쓴다 |
| `src/client/connect.ts:592-646` | connection object에 issued key id/fingerprint를 기록하고 실패 시 `issued && cleanupCredential`이면 hub revoke를 시도한다 | connection object에 link의 `transport`와 `link` metadata를 기록하고 link key는 service-api-token에만 쓴다. rollback revoke 조건은 hub-issued credential이 있는 경우로 제한한다 |
| `src/client/connect.ts:359-455,934-948` | rotate/recover/revoke가 persisted managementUrl과 authority로 hub API를 호출한다 | link transport를 읽은 즉시 deterministic refusal을 반환하고 원격 rotate/revoke fetch를 하지 않는다. disconnect의 로컬 복구는 계속 허용한다 |
| `src/client/machine-listener.ts:42-55` | `req.method !== "GET" || path.startsWith("/api/") || path.startsWith("/v1/")`이면 404다 | `linkMode` 매개변수를 추가해 link에서만 non-Upgrade `/v1/`를 허용하고, link가 아니면 기존 404를 유지한다. Upgrade는 계속 거부한다 |
| `src/client/machine-listener.ts:81-124` | `relayEnabled = connection.managementTransport === "relay"`; `/api/machine/hub-relay/`를 먼저 처리한 뒤 `/api/machine/`과 GUI를 처리한다 | `linkMode`를 계산하고 `relayEnabled = !linkMode && ...`로 제한한다. link `/v1/`는 machine API와 GUI 분기보다 먼저 `relayLinkDataRequest`로 반환하고 management relay는 404로 닫는다 |
| `src/client/hub-client.ts:200-231,435-480,528-565` | readiness는 `Accept`만 보내고 catalog/state는 호출자가 준 admission token을 `x-opencodex-api-key`로 보낸다 | `fetchHubReady`에 `linkKey?: string` 옵션을 추가해 link에서만 service-api-token의 key를 header로 보내고, catalog/state는 `serviceToken.token`을 기존 admissionToken 인자로 받아 `http://127.0.0.1:<tunnelPort>`의 GET에 사용한다. missing/wrong key의 401은 helper가 성공으로 해석하지 않는다 |
| `src/cli/connect.ts:326-356` | positional URL을 꺼내고 pairing/admin 중 정확히 하나를 요구한 뒤 `connectClient`에 넘긴다 | `--link`를 먼저 판별한다. link는 positional URL, pairing/admin, management 옵션을 거부하고 `--key-stdin`, `--tunnel-port`, `--link-id`를 모두 요구해 bounded JSON credential로 변환한다. hub parsing은 기존 branch다 |
| `src/cli/connect.ts:56-64,304-323,378-386` | usage와 rotate/revoke 출력은 hub connection만 전제로 한다 | usage에 link invocation을 추가하고 link refusal은 secret을 포함하지 않는 기존 CLI error boundary로 출력한다 |
| `structure/runtime.md:265-285,350-385` | client listener는 `/api/machine/*`와 GUI만 제공하고 public data listener는 direct client→hub라고 기술한다 | client link의 `/v1` HTTP relay, tunnel destination, 503 retry, management relay off와 link rotate/revoke 경계를 현재형으로 추가한다 |
| `structure/config.md:86-100` 및 client lifecycle 단락 | client connection은 hub origin과 enrolled key를 중심으로 설명한다 | legacy transport의 hub default, link metadata validation, key가 config/links.json에 저장되지 않고 service-api-token에만 놓이는 흐름을 추가한다 |
| `docs-site/src/content/docs/guides/remote-hub.md` 및 번역본 | `ocx hub invite` 기반 HTTPS/management flow만 설명한다 | 구현 PR에서 link stdin command, localhost Codex routing, tunnel outage 503, link rotate/revoke 제한을 영어 기준에 추가하고 번역본을 동기화한다. WP3 구현 PR에 포함하지 않으면 후속 PR로 명시한다 |

## 감사 반영 (Pauli FAIL r1)

- K7: link readiness의 정확한 호출 signature와 `x-opencodex-api-key` 전송 규칙을 추가했다. key는 `service-api-token`에서 재독한 값이며 `/readyz`, `/v1/catalog`, `/v1/hub-state` 모두 `http://127.0.0.1:P`의 GET을 사용한다.
- K7 검증: port 0 stub listener 기준 missing-key 401, wrong-key 401, correct service-token key 경로를 세 endpoint에 추가했다.
- K9: `relayLinkDataRequest` 자체도 Upgrade를 upstream fetch 없이 404로 거부하도록 고정해 HTTP-only 경계를 유지했다.
- K17: stale한 locale 수 표기를 `gui/src/i18n/shared.ts:6-17`의 실제 10개 locale로 고쳤다.
