# 060 — wp6: 클라이언트 시작형 링크 (L6, `codex/remote-link-6-client-initiated`)

상위 문서: `000_prd.md` r2, `001_stack_plan.md`, `002_arch_plan.md`, `010_wp1_link_core.md`.
선행 레이어: L1 `src/link/`, L2 링크 리스너, L3 link transport, L4 링크 API와 감독자, L5 `RemoteLink` 화면.
현재 워크트리에는 L1–L5의 생산 코드가 아직 없고, 이 문서는 현재 소스와 선행 레이어 계약을 함께 고정한다.

## 범위(IN/OUT)

IN은 `runtimeRole === "standalone"`인 클라이언트의 대시보드에서 후보 Home을 고르고, SSH 호스트 키를 확인한 뒤, Home에서 `ocx link issue`를 실행하고, local `connect --link`를 완료하며, 재시작 후 클라이언트 프로세스가 `ssh -L`을 소유하는 흐름이다. 연결이 완료되면 기존 L3의 `localhost:<config.port>` Codex 경로와 503 재연결 상태를 사용한다.

OUT은 허브 시작형 `-R` 흐름, 링크 리스너의 데이터 인증 정책, L3의 link transport 스키마 자체, SSH 비밀번호·Windows, 원격 자동 설치, 공개 HTTPS 앞단, 원격 워크스페이스의 기능 변경이다.

## 파일 변경 지도

| 경로 | 종류 | 내용 |
|---|---|---|
| `src/client/link-state.ts` | NEW | 클라이언트가 소유하는 Home alias, `hubHostKeyFingerprint`, local P, Home L, link id를 권한 600으로 저장·검증·삭제한다. `links.json`과 분리한다. |
| `src/link/supervisor.ts` | MODIFY (L4 선행 파일) | 기존 허브 `-R` 감독자에 client-owned `-L` 사양과 종료·재연결 수명을 추가한다. |
| `src/server/management/link-routes.ts` | MODIFY (L4 선행 파일) | standalone에서 후보·probe·host 확인을 허용하고 `POST /api/link/join {alias}`를 추가한다. 기존 hub apply/delete 권한은 유지한다. |
| `src/server/management/route-registry.ts` | MODIFY | `POST /api/link/join`을 route registry에 선언한다. 현재 실제 기준은 `:366-374`의 Remote Workspace route 선언이다. |
| `src/server/management-api.ts` | MODIFY 조건부 | L4가 `/api/link/*`를 이미 lazy-load하지 않으면 `/api/link` namespace lazy loader를 추가한다. L4가 제공하면 변경하지 않는다. 현재 lazy-loader 형태는 `:170-184`다. |
| `src/client/connect.ts` | MODIFY | link 연결 해제 완료 시 `client-link.json`을 함께 소유 확인 후 삭제한다. 현재 disconnect의 config 정리 지점은 `:899-906`이다. |
| `src/client/runtime.ts` | MODIFY | `transport === "link"`인 machine-listener 프로세스에서 `-L` 감독자를 시작하고 종료 순서에 stop을 넣는다. 현재 listener 시작은 `:82-100`, 종료는 `:102-116`이다. |
| `gui/src/api-targets.ts` | MODIFY | 문서 meta의 runtime role 판독을 export하고 `isStandaloneRuntime()`을 제공한다. 현재 role 판독은 `:10-14`, client 판정은 `:23-25`다. |
| `gui/src/pages/RemoteLink.tsx` | MODIFY (L5 선행 파일) | standalone에서만 Find Home 단계와 후보·fingerprint 확인·join/restart 상태를 표시한다. client/hub 화면의 기존 상태 카드는 유지한다. |
| `gui/src/i18n/{en,de,fr,ja,ko,ru,tr,vi,zh,zh-TW}.ts` | MODIFY | Find Home, fingerprint 확인, SSH 실패, 재시작, 연결 상태 문구를 모든 locale에 추가한다. GUI 지침상 새 visible string은 전 locale에 있어야 한다. |
| `tests/clients/client-link-state.test.ts` | NEW | sidecar 왕복·권한·손상·필드 검증. `clients`에 명시 등록한다. |
| `tests/clients/client-link-join.test.ts` | NEW | route orchestration과 standalone/비standalone·probe·issue·connect·restart 분기. `clients`에 명시 등록한다. |
| `tests/clients/client-link-supervisor.test.ts` | NEW | `-L` argv, 재연결, stop, `link` 외 transport 미기동. `clients`에 명시 등록한다. |
| `gui/tests/remote-link-client.test.tsx` | NEW | standalone Find Home UI와 client/hub 비노출. GUI test layout에는 `tests/test-layout` 등록을 적용하지 않는다. |
| `scripts/test-layout/layout.json` | MODIFY | 위 세 Bun 테스트 파일을 `explicit`의 `clients`에 추가한다. |
| `tests/fixtures/test-layout-expected.json` | MODIFY | 위 세 파일을 `clients`로 같은 이름으로 추가한다. |
| `structure/remote-link.md` | MODIFY (L1 선행 문서) | client-owned `-L`, sidecar, 재시작 수명과 role gate를 현재형 계약으로 반영한다. |
| `docs-site/src/content/docs/guides/remote-link.md` | MODIFY (L5가 만든 경로 확인 필요) | Home 시작형과 Client 시작형을 분리해 사용자 흐름과 제한을 설명한다. 영어가 canonical이다. |

## 새 파일/변경 상세

### `src/client/link-state.ts` (NEW)

`ClientLinkState`는 K11의 sidecar 필드만 갖는다: `linkId: string`, `alias: string`, `hubHostKeyFingerprint: string`, `peerListenerPort: number`, `tunnelPort: number`. 키 원문과 admin token은 저장하지 않는다. `clientLinkStatePath()`, `readClientLinkState()`, `writeClientLinkState()`, `clearClientLinkState(expectedLinkId)`를 export한다.

이 파일은 약 130줄 이하의 새 순수 저장 모듈로 작성한다. 구현 형태는 다음과 같다.

```ts
import { chmodSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../config/paths";
import { atomicWriteFile, isMissingPathError } from "../config/atomic-write";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { hardenSecretDir, hardenSecretPath } from "../lib/windows-secret-acl";
import { assertSshAlias } from "../link/ssh-argv";

export interface ClientLinkState {
  linkId: string;
  alias: string;
  hubHostKeyFingerprint: string;
  peerListenerPort: number;
  tunnelPort: number;
}

export class ClientLinkStateError extends Error {
  constructor(message: string) { super(message); this.name = "ClientLinkStateError"; }
}

export function clientLinkStatePath(configDir: string = getConfigDir()): string {
  return join(configDir, "link", "client-link.json");
}

const validPort = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;

function parse(value: unknown): ClientLinkState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ClientLinkStateError("client-link.json is not an object");
  const raw = value as Record<string, unknown>;
  const fail = (field: string): never => { throw new ClientLinkStateError(`client-link.${field} is invalid`); };
  const allowedFields = new Set(["linkId", "alias", "hubHostKeyFingerprint", "peerListenerPort", "tunnelPort"]);
  for (const field of Object.keys(raw)) if (!allowedFields.has(field)) fail(field);
  if (typeof raw.alias !== "string") fail("alias");
  try { assertSshAlias(raw.alias); } catch { fail("alias"); }
  if (typeof raw.hubHostKeyFingerprint !== "string" || !/^[A-Z0-9]+:[A-Za-z0-9+/=]{16,128}$/.test(raw.hubHostKeyFingerprint)) fail("hubHostKeyFingerprint");
  if (!validPort(raw.peerListenerPort)) fail("peerListenerPort");
  if (!validPort(raw.tunnelPort)) fail("tunnelPort");
  if (typeof raw.linkId !== "string" || !/^lnk_[0-9a-f]{16}$/.test(raw.linkId)) fail("linkId");
  return raw as ClientLinkState;
}

export function readClientLinkState(path = clientLinkStatePath()): ClientLinkState | null {
  try { return parse(JSON.parse(readFileSync(path, "utf8")) as unknown); }
  catch (error) { if (isMissingPathError(error)) return null; throw error; }
}

export function writeClientLinkState(state: ClientLinkState, path = clientLinkStatePath()): void {
  const normalized = parse(state);
  const dir = dirname(path);
  assertNotRealHomeUnderTest(dirname(dir));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") hardenSecretDir(dir, { required: true });
  else chmodSync(dir, 0o700);
  atomicWriteFile(path, `${JSON.stringify(normalized, null, 2)}\n`);
  if (process.platform === "win32") hardenSecretPath(path, { required: true });
  else chmodSync(path, 0o600);
}

export function clearClientLinkState(expectedLinkId: string, path = clientLinkStatePath()): void {
  const current = readClientLinkState(path);
  if (!current) return;
  if (current.linkId !== expectedLinkId) throw new ClientLinkStateError("client link owner changed");
  unlinkSync(path);
}
```

저장 경로는 `<configDir>/link/client-link.json`이며 디렉터리 0700, 파일 0600이다. `alias`는 `assertSshAlias`, 두 포트는 1–65535, `hubHostKeyFingerprint`는 WP1 store와 같은 fingerprint 형식, id는 `lnk_[0-9a-f]{16}`으로 검증한다. 파일 없음은 `null`, 손상·소유자 변경·중복 링크 id는 오류다. write는 `atomicWriteFile`과 기존 secret-dir ACL helper를 재사용한다.

### `src/server/management/link-routes.ts` (MODIFY)

L4가 만든 handler의 standalone 분기에 다음을 삽입한다. 현재 파일은 아직 없으므로 적용 기준은 L4의 export와 `ManagementContext`이며, current management auth는 `ctx.principal === "gui-session"`과 paired session을 확인하는 `remote-workspace-routes.ts:12-15` 패턴이다.

기존 형태:

```ts
export async function handleLinkRoutes(ctx: ManagementContext): Promise<Response | null> {
  // L4: candidates/probe/confirm-host/apply/status/delete
}
```

변경 형태:

```ts
export async function handleLinkRoutes(ctx: ManagementContext): Promise<Response | null> {
  // GET candidates, POST probe, POST confirm-host: standalone와 hub에서 role별 허용
  if (ctx.url.pathname === "/api/link/join" && ctx.req.method === "POST") {
    return handleClientInitiatedJoin(ctx);
  }
  // L4의 hub apply/status/delete 및 공통 404
}
```

`handleClientInitiatedJoin`은 `sessionOnly`를 먼저 적용하고 `ctx.config.runtimeRole === "standalone"`이 아니면 409를 반환한다. body는 `exactBodyKeys(body, ["alias"])`로 제한하고 `assertSshAlias`로 검증한다. host key는 join 호출 자체가 신뢰하지 않는다. UI가 먼저 L4의 `POST /api/link/probe {alias}`로 fingerprint를 받고 `POST /api/link/confirm-host {alias,fingerprint}`를 성공시킨 뒤 join을 호출한다. 따라서 join 계약은 정확히 `{alias}`를 유지한다.

join 순서는 다음과 같다.

1. confirmed `known_hosts`와 후보 alias를 확인하고 `findAvailablePort(1, "127.0.0.1")`로 P를 고른다. 임의 원격 bind는 허용하지 않는다.
2. WP1 `buildExecArgv`로 Home에 `ocx link issue --alias <hostname()> --tunnel-port P`를 실행한다. 이 Home-side CLI는 Home의 기존 admin-token 관리 경로로 loopback `POST /api/link/issue`를 호출하며 dashboard session을 사용하지 않는다. stdout JSON은 `{linkId, apiKeyId, key, listenerPort}`로 bounded parse하고 key는 메모리에서만 사용한다. 현재 CLI의 admin-token 선택과 management credential 전달 패턴은 `src/cli/connect.ts:340-352,378-385`, 서버의 admin-token principal 판정은 `src/server/management-auth.ts:525-562`를 따른다.
3. `writeClientLinkState`에 alias, `hubHostKeyFingerprint`, P, 반환된 Home L(`listenerPort`), linkId를 기록한다.
4. WP3의 link credential 전략으로 `connectClient`를 호출한다. `serverUrl`과 `managementUrl`은 `http://127.0.0.1:P`, link block은 `{tunnelPort:P, linkId}`이며 remote key issue는 다시 하지 않는다.
5. 성공하면 `acceptSystemRestart()`를 예약하고 key를 zeroize한다. 응답은 202와 `{state:"restarting",linkId,apiKeyId}`만 반환한다. 실패하면 sidecar를 소유 확인 후 삭제하고 502를 반환한다.

remote issue 성공 후 local connect가 실패하면 같은 SSH runner로 Home에서 `ocx link revoke --link-id <id>`를 실행한다. 이 명령은 Home의 admin-token CLI 경로로 `DELETE /api/link/{id}`를 호출하며 dashboard session이나 L4 GUI delete를 사용하지 않는다. revoke 성공을 확인한 뒤에만 sidecar를 owner-check clear하고 502를 반환한다. revoke가 실패하면 orphan을 성공으로 가장하지 않고 `linkId`와 rollback 오류를 반환하며 sidecar는 명시적 복구가 가능하도록 보존한다. 이 rollback 계약은 K12에 따른다.

### `src/link/supervisor.ts` (MODIFY)

L4의 `createLinkSupervisor`에 client 사양을 추가하되 기존 hub record 경로의 `-R` 명령을 바꾸지 않는다.

기존 L4 기준:

```ts
createLinkSupervisor({ records, runner, storePath, knownHostsFile })
// LinkRecord.direction === "hub-initiated"만 -R로 spawn
```

추가할 export와 동작:

```ts
export interface ClientTunnelSpec {
  alias: string;
  tunnelPort: number;
  peerListenerPort: number;
  knownHostsFile: string;
}
export function createClientLinkSupervisor(options: {
  spec: ClientTunnelSpec;
  runner?: SshRunner;
  now?: () => number;
  random?: () => number;
}): LinkSupervisor;
```

`start()`는 `buildTunnelArgv({alias, direction:"L", bindPort:tunnelPort, targetPort:peerListenerPort, knownHostsFile})`를 만들고 WP4 injectable runner로 실행한다. `tunnel-state.ts`의 `spawn/ready/exit/tick`, `dueForSpawn`, `classifySshStderr`를 사용하며 5분 후 `failed`를 terminal로 표시한다. `stop()`은 child를 TERM 후 bounded KILL하고 retry timer를 지운다. runner가 없는 실제 경로는 WP4의 `ssh-runner.ts`를 사용한다. client supervisor는 `links.json`을 읽지 않으며 `client-link.json`의 단일 상태만 사용한다.

### `src/client/runtime.ts`와 `src/client/connect.ts` (MODIFY)

현재 `startClientRuntime`는 연결 상태 확인 후 machine listener만 시작한다 (`src/client/runtime.ts:82-100`). 변경 후에는 state가 link이면 sidecar를 읽어 supervisor를 만든 뒤 listener bind 성공 후 supervisor를 시작한다. `transport === "hub"` 또는 transport 없음이면 supervisor를 만들지 않는다. 현재 shutdown closure (`:102-116`)는 `supervisor.stop()`을 먼저 호출하고 listener를 닫은 뒤 pid/runtime 정리를 실행한다.

현재 disconnect 정리는 `clearClientConnection` 후 hub-state cache를 지운다 (`src/client/connect.ts:899-906`). 변경 후 link transport이면 같은 lifecycle lock 아래 `clearClientLinkState(connection.link.linkId)`를 호출한다. sidecar가 없거나 이미 지워진 경우는 성공으로 취급하고, 다른 link id이면 conflict로 중단한다.

### GUI와 문서

현재 GUI는 runtime role meta를 읽지만 helper가 private다 (`gui/src/api-targets.ts:10-24`). `export function runtimeRoleFromDocument(): "standalone"|"hub"|"client"|null`과 `isStandaloneRuntime()`을 추가한다. 현재 내부 config도 `runtimeRole`에 `standalone|hub|client`를 사용한다 (`src/client/state.ts:90-104`). L5의 `RemoteLink.tsx`는 K16 status의 wire role을 아래 매핑으로 변환한 뒤 standalone에서만 Find Home panel을 렌더하고, client에서는 연결 상태·disconnect, hub에서는 기존 자식 관리 화면을 렌더한다.

Find Home은 candidates → probe fingerprint → explicit confirm → join → restarting → client connected 순서다. confirm 전에는 known_hosts와 sidecar가 변하지 않는다. join 응답은 secret을 포함하지 않는다. 상태 polling은 기존 page resource pattern을 따르고, 재시작 중에는 중복 POST를 막는다. 새 visible string은 `gui/src/i18n/en.ts`와 현재 `LOCALES` 10개(`gui/src/i18n/shared.ts:6-17`)에 같은 key로 추가한다.

영문 docs page에는 SSH key-only/BatchMode, macOS/Linux 제한, local P와 Home L의 loopback bind, known_hosts 확인, 연결 뒤 dashboard read-only, disconnect 복구, host가 offline일 때 503을 기록한다. translated docs는 이 레이어에서 새로 추가하지 않고 영어 페이지를 canonical link로 참조하거나 L5 번역 정책에 맞춘다.

### status wire DTO와 GUI role mapping (K16)

`GET /api/link/status`의 wire 응답은 K16을 그대로 사용한다. frontend가 `runtimeRole`이라는 이름으로 재직렬화하거나 link row를 축약하지 않는다.

```ts
type LinkStatus = {
  role: "standalone" | "home" | "child";
  listener: { state: "off" | "listening" | "failed"; port: number | null };
  links: Array<{
    id: string;
    alias: string;
    direction: "hub-initiated" | "client-initiated";
    state: "connecting" | "connected" | "reconnecting" | "failed" | "idle";
    since: string;
    reason: string | null;
    tunnelPort: number;
  }>;
  child: null | { alias: string; state: string; since: string; reason: string | null };
};
```

GUI 표시용 매핑은 다음 하나로 고정한다. `standalone → runtimeRole: "standalone"`, `home → runtimeRole: "hub"`, `child → runtimeRole: "client"`다. `listener`, `links[]`의 `direction/state/since/reason/tunnelPort`, `child`는 모두 parser와 화면 상태에 보존한다. 이 매핑은 현재 GUI가 `isConnectedRuntime()`에서 `client`를 읽는 경계(`gui/src/api-targets.ts:10-24`)와 client runtime의 GUI role tag(`src/client/machine-listener.ts:131-145`) 사이에 둔다. WP6 테스트는 세 wire role과 `child: null`/object를 모두 검증한다.

## MODIFY 적용 앵커와 before/after

아래 current snippets는 현재 워크트리에서 읽은 실제 소스다. L4/L5 선행 파일은 현재 HEAD에 없으므로, 그 항목은 선행 문서의 export를 기준으로 적용하고 임의의 현재 line을 주장하지 않는다.

`src/server/management/route-registry.ts`의 실제 before (`:366-374`):

```ts
// server/management/remote-workspace-routes
{ method: "GET", path: "/api/remote-workspace", module: "server/management/remote-workspace-routes", mutates: false, ... },
{ method: "POST", path: "/api/remote-workspace/pairing", module: "server/management/remote-workspace-routes", mutates: true, ... },
// server/management/system-routes
```

after에는 L4 link route 묶음 뒤에 다음을 추가한다.

```ts
// server/management/link-routes
{ method: "POST", path: "/api/link/join", module: "server/management/link-routes", mutates: true, exempt: { reason: "session-only", why: "A client-initiated link issues a Home key and changes this standalone runtime to client mode; paired dashboard session only." } },
```

`src/server/management-api.ts`의 실제 before는 `handleRemoteWorkspaceRoutesOnDemand`가 `:170-184`에서 namespace를 검사하고 dynamic import하는 형태이며, dispatch chain은 `:279-281`에서 `handleSessionRoutes` 다음 Remote Workspace를 호출한다. L4에 같은 namespace loader가 없다면 after는 다음 두 조각이다.

```ts
async function handleLinkRoutesOnDemand(ctx: ManagementContext): Promise<Response | null> {
  if (!pathInManagementNamespace(ctx.url.pathname, "/api/link")) return null;
  const { handleLinkRoutes } = await import("./management/link-routes");
  return handleLinkRoutes(ctx);
}

// dispatch
routed = handleSessionRoutes(ctx)
  ?? (await handleLinkRoutesOnDemand(ctx))
  ?? (await handleRemoteWorkspaceRoutesOnDemand(ctx))
```

`src/client/runtime.ts`의 실제 before는 `startMachineListener` 직후 `activeServer/activePort`를 설정하고(`:94-100`), shutdown에서 `server.stop(true)`만 호출한다(`:102-109`). after는 다음처럼 supervisor를 listener와 같은 process lifetime에 묶는다.

```ts
const supervisor = connection.transport === "link"
  ? createClientLinkSupervisor({ state: readClientLinkState()!, knownHostsFile: linkKnownHostsPath() })
  : null;
const server = startMachineListener(port, { state: connection });
supervisor?.start();
// ...
try { supervisor?.stop(); server.stop(true); } finally { cleanup(); process.exit(0); }
```

`src/client/connect.ts`의 실제 before (`:899-906`)는 다음과 같다.

```ts
if (clearClientConnection(receipt.owner) === "conflict") throw new Error("client_disconnect_owner_changed");
if (!disconnectAtLeast(receipt, "connection_cleared")) advance("connection_cleared");
removeHubStateCache();
requireDesktopResult(finishRemoteDesktopCleanup(held, receipt.owner));
```

after는 config owner clear 직후 link transport에 한해 sidecar owner를 검증해 지운다.

```ts
if (clearClientConnection(receipt.owner) === "conflict") throw new Error("client_disconnect_owner_changed");
if (!disconnectAtLeast(receipt, "connection_cleared")) advance("connection_cleared");
if (connection?.transport === "link" && connection.link) {
  clearClientLinkState(connection.link.linkId);
}
removeHubStateCache();
```

`gui/src/api-targets.ts`의 실제 before (`:10-25`)는 `runtimeRoleFromDocument`가 private이고 `isConnectedRuntime`만 export한다. after는 판정 함수를 공유한다.

```ts
export function runtimeRoleFromDocument(): "standalone" | "hub" | "client" | null {
  // existing meta lookup; invalid content returns null
}
export function isStandaloneRuntime(): boolean {
  return runtimeRoleFromDocument() === "standalone";
}
export function isConnectedRuntime(): boolean {
  return runtimeRoleFromDocument() === "client";
}
```

`src/server/management/link-routes.ts`, `src/link/supervisor.ts`, `gui/src/pages/RemoteLink.tsx`, `gui/src/i18n/*.ts`, `structure/remote-link.md`, `docs-site/src/content/docs/guides/remote-link.md`는 현재 HEAD에 없는 L4/L5 선행 산출물이다. 위 파일들의 before는 각각 선행 WP 문서의 계약이고, 이 문서의 파일 변경 지도와 앞선 상세 코드가 적용 가능한 after다. 선행 branch가 다른 path/export를 만들면 구현 전에 이 문서의 Contract deviations와 route registry를 갱신한다.

## 필드 체인 (PLAN-FIELD-CHAIN-01)

`OcxClientConnectionConfig.transport`와 `link.tunnelPort/linkId`는 L3가 추가한 기존 필드이므로 이 문서에서 새 타입 필드로 추가하지 않는다.

새 `ClientLinkState` 필드의 체인은 다음과 같다.

| 필드 | 생성 | 직렬화/검증 | 역직렬화 | 모든 소비자 |
|---|---|---|---|---|
| `alias` | join의 confirmed SSH alias | `writeClientLinkState`가 `assertSshAlias` | `readClientLinkState` | `createClientLinkSupervisor`의 SSH target |
| `hubHostKeyFingerprint` | probe 결과와 confirm 일치값 | fingerprint regex, known_hosts 이동 전에 비교 | sidecar read | join 전 확인과 supervisor가 쓰는 known_hosts의 identity |
| `tunnelPort` | standalone에서 loopback free-port 선택 | integer 1–65535 | sidecar read | L3 connect의 `link.tunnelPort`, `-L` bind |
| `peerListenerPort` | Home `ocx link issue`의 `listenerPort` | integer 1–65535 | sidecar read | `-L` target port |
| `linkId` | Home issue JSON | `lnk_` id regex | sidecar read | L3 config, disconnect ownership, 오류 표시 |
`ClientLinkState`는 key를 포함하지 않으므로 API key field chain은 N/A다. Home의 `LinkRecord`는 L1 계약의 `apiKeyId`만 계속 저장하고 key 원문은 저장하지 않는다. K16의 `since`는 supervisor/status projection이 생성하며 sidecar에 추가 필드로 저장하지 않는다.

## 테스트 사례

각 테스트는 임시 `OPENCODEX_HOME`, 임시 known_hosts, 합성 alias(`home.example.test`)와 injectable runner를 사용한다. 실제 SSH, 실제 provider, 실제 dashboard 계정은 사용하지 않는다.

| 활성화 시나리오 | 관찰 증거 |
|---|---|
| standalone + paired dashboard가 `GET candidates` | `ssh_config`의 concrete Host만 반환되고 wildcard/Match는 제외된다. |
| probe 전후 | probe는 temporary known_hosts와 `true`만 사용하고, confirm 전에는 permanent known_hosts가 비어 있다. |
| fingerprint 불일치 confirm | 409/403, permanent known_hosts·sidecar·config 모두 unchanged. |
| `client-link.json` sidecar 왕복·손상 | K11의 다섯 필드와 `hubHostKeyFingerprint`만 허용하며, 누락·잘못된 fingerprint·K11 이전의 레거시 지문 필드는 거부한다. 권한은 디렉터리 0700·파일 0600이다. |
| standalone에서 `POST /api/link/join {alias}` 성공 | runner argv에 `ocx link issue --alias <thisMachine> --tunnel-port P`, Home admin-token CLI 경로, local connect에 `http://127.0.0.1:P`, 응답 202, 응답 body에 key 없음, `acceptSystemRestart` 호출. |
| hub 또는 client에서 join | 409 `standalone_required`, SSH runner와 config writer가 호출되지 않는다. |
| session 없음 또는 Tailscale identity | 403, issue/connect/restart 모두 실행되지 않는다. |
| remote issue nonzero·malformed JSON·listenerPort 충돌 | 502, sidecar와 client config가 없다. secret은 log/response에 없다. |
| local connect 실패 | Home SSH runner가 `ocx link revoke --link-id <id>`를 실행하고 admin-token CLI 경로를 사용한다. revoke 성공 뒤 sidecar가 owner 확인 후 제거되고 config가 disconnected로 남는다. revoke 실패는 오류 receipt에 남고 sidecar를 보존한다. |
| 새 client process 기동 | `-L 127.0.0.1:P:127.0.0.1:L`, `BatchMode=yes`, `StrictHostKeyChecking=yes`, `HostKeyAlias`, link known_hosts가 관찰된다. |
| SSH network exit | `reconnecting`, backoff 후 재시도; L3 machine listener의 `/v1` 요청은 503과 `Retry-After`를 보낸다. |
| auth/hostkey/forward exit 또는 5분 outage | supervisor state가 해당 `failed` reason이고 추가 spawn이 없다. |
| hub transport client 기동 | client supervisor가 spawn되지 않는다. |
| disconnect | supervisor stop, sidecar 삭제, L3의 기존 catalog/token/config 복구 증거가 모두 존재한다. |
| GUI standalone | Find Home panel과 confirm 단계가 보이고 join 중 button이 잠긴다. |
| GUI client/hub | standalone Find Home action은 숨고 각각 L3 상태/L5 hub 화면만 보인다. |
| K16 status DTO | `standalone/home/child` 세 wire role, `listener`, 전체 `links[]` 필드, `child: null`과 object를 parser가 보존하고 GUI에 각각 `standalone/hub/client`로 표시한다. |

## 검증 명령

문서 작성 단계에서 실제로 실행한 명령만 기록한다. 전체 테스트는 실행하지 않는다.

| 명령 | exit | change target 읽음 | 결과 |
|---|---:|---|---|
| `test -f devlog/_plan/260925_remote_home_child_link/000_prd.md && test -f devlog/_plan/260925_remote_home_child_link/001_stack_plan.md && test -f devlog/_plan/260925_remote_home_child_link/002_arch_plan.md && test -f devlog/_plan/260925_remote_home_child_link/010_wp1_link_core.md` | 0 | 아니오 | 필수 선행 문서 모두 존재 |
| `test -f devlog/_plan/260925_remote_home_child_link/060_wp6_client_initiated.md` | 0 | 예 | 이 문서 존재 |
| `git diff --check -- devlog/_plan/260925_remote_home_child_link/060_wp6_client_initiated.md` | 0 | 예 | whitespace 오류 없음 |
| `bun run typecheck` | 0 | 아니오 | `bun x tsc --noEmit` 완료. 문서 변경은 typecheck 대상이 아니지만 현재 트리도 통과했다. |
| `bun run privacy:scan` | 0 | 예 | `Privacy scan passed`; 작성한 devlog를 포함해 통과했다. |

L6 구현 후 별도 실행할 명령은 `bun test tests/clients/client-link-state.test.ts tests/clients/client-link-join.test.ts tests/clients/client-link-supervisor.test.ts`, `bun test tests/server/management-route-registry.test.ts`, `cd gui && bun run lint:i18n && bun run build`, `bun run test:changed`, `bun run structure:check`, `cd docs-site && bun install --frozen-lockfile && bun run build`다. 이 문서 작성 단계의 검증 증거로 세지 않는다.

## 우회 경로 기록

| tier | surface | 우회 | 잔여 위험 |
|---|---|---|---|
| 1 | 호스트 key 확인 | 사용자가 이미 `~/.ssh/known_hosts`에 같은 alias/key를 넣으면 probe 확인 단계를 통과한다. | OpenSSH가 이미 신뢰한 key의 정확성을 이 흐름이 재판단할 수 없다. 의도된 시스템 SSH 동작이다. |
| 2 | local dashboard session | 같은 사용자의 local process는 loopback GUI session을 재현할 수 있다. | 저장소 규칙상 dashboard session은 사용자 동의 경계이며, OS 수준에서 agent와 사용자를 구분하지 못한다. Tailscale identity는 join을 우회하지 못한다. |
| 3 | Home CLI issue/revoke | 사용자가 Home shell에서 `ocx link issue` 또는 `ocx link revoke --link-id <id>`를 직접 실행할 수 있다. | SSH 계정 권한을 가진 사용자는 이미 Home의 local operator 권한을 가진다. 두 명령은 Home admin-token CLI 경로를 사용하며 issue key는 stdout JSON으로만 내보내고 파일·로그에는 쓰지 않는다. |
| 4 | tunnel | 모든 forward는 양 끝 127.0.0.1이고 link listener는 data route와 recorded key만 허용한다. | Home OS의 local process는 기존 loopback 신뢰를 갖는다. link가 그 신뢰를 management API로 확장하지 않도록 L2 정책이 계속 적용되어야 한다. |

## file-size ratchet headroom

현재 `tests/fixtures/file-size-baseline.json`에는 아래 기존 MODIFY 대상의 cap이 없다. 따라서 현재 cap과 headroom은 `N/A (baseline 미등록)`이다. L4/L5가 만드는 신규 경로와 테스트·문서도 baseline 신규 항목이 없으므로 같은 상태다. 이 레이어는 ratchet 숫자를 올리지 않는다.

| 파일 | 현재 라인 | baseline cap/headroom |
|---|---:|---|
| `src/client/connect.ts` | 948 | N/A |
| `src/client/runtime.ts` | 117 | N/A |
| `src/server/management-api.ts` | 467 | N/A |
| `src/server/management/route-registry.ts` | 401 | N/A |
| `gui/src/api-targets.ts` | 207 | N/A |
| NEW `src/client/link-state.ts` | 0 | 신규/N/A |
| L4/L5 선행 NEW files | 0 at current HEAD | 선행 레이어가 만든 뒤 확인 |

## test layout registration entries

`tests/clients/client-link-state.test.ts`, `tests/clients/client-link-join.test.ts`, `tests/clients/client-link-supervisor.test.ts`를 `scripts/test-layout/layout.json`의 `explicit`와 `tests/fixtures/test-layout-expected.json`에 각각 다음처럼 등록한다.

```json
"client-link-state.test.ts": "clients",
"client-link-join.test.ts": "clients",
"client-link-supervisor.test.ts": "clients"
```

GUI의 `gui/tests/remote-link-client.test.tsx`는 별도 GUI test runner 대상이며 core test-layout map에 넣지 않는다.

## structure/doc updates

`structure/remote-link.md`는 이미 L1이 `src/link/`의 소유 문서로 추가하고 L4가 supervisor/management route를 확장한다는 전제다. L6은 같은 문서에 client sidecar와 `runtimeRole` gate를 현재형으로 갱신한다. `structure/manifest.json`의 `remote-link.md` entry와 `documents: ["src/link/"]` 소유는 바꾸지 않는다. L6이 새 `src/client/` 소유 문서를 만들지는 않는다. 따라서 `bun run structure:index`로 생성되는 `structure/INDEX.md`의 entry 변경은 없다.

## docs-site impact

사용자에게 보이는 새 연결 흐름이므로 L5가 만든 canonical English remote-link page에 Client 시작형 절차를 추가한다. 기존 `remote-workspace` 페이지의 pairing 설명은 고치지 않는다. 번역 페이지를 이 L6에서 부분 갱신해 영어와 모순시키지 않으며, L5가 번역을 이미 만들었다면 같은 key facts를 각 번역에 반영한다. docs build는 `docs-site/AGENTS.md`의 명령으로 확인한다.

## PR title/body notes

제목: `feat(link): add client-initiated home discovery`

본문에는 standalone dashboard가 candidate → fingerprint confirmation → remote `ocx link issue` → local `connect --link`를 수행하고, 새 client process가 `-L`을 소유한다는 점을 쓴다. Verification에는 세 focused client tests, route registry test, GUI i18n/build, `typecheck`, `test:changed`, docs build의 실제 exit code를 적는다. GUI 변경이 있으므로 screenshot은 `pr-assets` branch를 통해 PR 설명에 첨부하고 작업 branch에는 파일로 넣지 않는다. auth/session, SSH host trust, API key issuance, restart lifecycle을 건드리므로 `MAINTAINERS.md`의 명시적 security review flag를 본문 Checklist에 남긴다.

## Contract deviations

1. 공유 contract의 `OcxClientConnectionConfig.link`는 `{tunnelPort, linkId}`만 가진다. 재시작 후 `-L` target인 Home L을 복원해야 하지만 이 두 필드에는 L이 없으므로, L6은 K11의 `client-link.json.peerListenerPort`에 저장한다. sidecar의 허브 키 지문 필드는 K11의 `hubHostKeyFingerprint`로 고정한다. 이 sidecar는 `links.json`과 분리해 L2 hub listener의 `hasLinks()` gate를 오염시키지 않는다. `link` 이름과 필드는 변경하지 않는다.
2. 공유 contract는 join을 `POST /api/link/join {alias}`로 고정한다. host-key confirmation은 별도 기존 `probe`/`confirm-host` 호출로 완료한 뒤 join을 호출한다. join body에는 fingerprint를 추가하지 않는다.
3. status wire는 K16의 `role: standalone|home|child`와 `listener/links/child`를 canonical로 한다. 현재 GUI/internal `runtimeRole: standalone|hub|client`는 UI 경계에서 `standalone→standalone`, `home→hub`, `child→client`로 매핑한다.
4. L4 파일과 L5 GUI/docs 경로는 현재 HEAD에 없으므로 해당 MODIFY는 선행 branch가 만든 실제 export와 경로를 확인한 뒤 적용해야 한다. 현재 확인된 실제 anchor는 `src/server/management-api.ts:170-184`, `src/server/management/route-registry.ts:366-374`, `src/client/runtime.ts:82-116`, `src/client/connect.ts:899-906`이다.

## 열린 질문

- `acceptSystemRestart`가 standalone route에서 기존 service ownership·drain semantics를 모두 보장하는지 L6 실제 integration test와 macOS/Linux dogfood에서 확인해야 한다.
- 두 대의 실제 macOS/Linux에서 S1–S5를 수행해 Home offline, SSH key rotation, process restart 뒤 reconnect를 확인해야 한다.

## 감사 반영 (Pauli FAIL r1)

- K11에 맞춰 sidecar 필드와 검증·필드 체인을 `hubHostKeyFingerprint`로 통일하고, sidecar shape에서 비결정 필드를 제거했다.
- K12에 맞춰 local connect 실패 rollback을 Home SSH의 `ocx link revoke --link-id <id>` admin-token CLI 경로로 고정했다.
- K16 status DTO의 `role`, `listener`, `links`, `child` 전체를 고정하고 GUI의 `home/child`와 `hub/client` 매핑을 명시했다.
- K1에 맞춰 Home-side issue가 dashboard session이 아닌 Home 로컬 admin-token CLI 경로를 사용하도록 join 순서와 테스트 증거를 갱신했다.

## wp6 P 재검증 (아키텍트 Confucius, gpt-6-sol high, 2026-09-25) — 이 절이 앞선 내용보다 우선한다

| ID | 제안 | 처분 |
|---|---|---|
| W6-1 | `POST /api/link/join {alias}` 추가, 페어링 대시보드 세션 전용, standalone 전용, 인증 후 상태 해석, route-registry 등록 | 수용 |
| W6-2 | 로컬 `ocx link port` 계약(`{"port":P}`)과 원격 `ocx link issue --alias <this-machine> --tunnel-port P`(buildExecArgv + SshRunner). P는 1024-65535로 통일(runPort 수정) | 수용. this-machine 별칭은 `os.hostname()`을 별칭 규칙에 맞게 정규화한 값, 규칙 위반이면 `client-<8hex>` |
| W6-3 | 로컬 connect는 셸이 아니라 in-process `connectClient`(transport link, `http://127.0.0.1:P`), 실패 시 SSH로 `ocx link revoke --link-id <id>`, 회수 확인 후에만 sidecar 삭제 | 수용 |
| W6-4 | `src/client/link-state.ts` 신설: K11 다섯 필드, 0600, 손상 거부, 소유 확인 삭제, 시작 시 fail-closed 복구 | 수용 |
| W6-5 | 클라이언트 소유 `-L` supervisor: client 런타임(src/client/runtime.ts)이 시작·종료, 재시도·종결 실패, 한정 종료, 리스너보다 먼저 정지 | 수용. 기존 src/link/supervisor.ts 재사용(방향 L 레코드 추가 모드) 또는 같은 리듀서를 쓰는 작은 client supervisor 중 구현자가 선택하되 테스트는 동일 |
| W6-6 | issue(관리자 토큰+신뢰 루프백)와 연결된 machine listener의 읽기 전용 규칙 유지 | 유지 |
| W6-7 | GUI Child 역할은 standalone일 때만 활성(`isStandaloneRuntime` export), 서버는 hub/client에서 join 시 409 `standalone_required` | 수용. `standalone_required`는 LINK_ERROR_CODES에 추가되어 GUI parity 테스트가 따라온다 |
| W6-8 | 키 zeroize 표현 제거(K18) | 수용 |
| W6-9 | 8개 docs 가이드의 "coming soon" 문장을 실제 자식 시작 흐름으로 교체, 테스트 배치 등록, 줄 수 재측정 | 수용 |


## 감사 반영 (Anscombe FAIL r1, wp6 계획 감사) — 이 절이 앞선 모든 내용보다 우선한다

차단 1(join/게이트 부재)과 5(문서 미갱신)는 구현 전 상태를 지적한 것으로, 이 계획이 B에서 만들 산출물이다. 아래 7번 테스트와 8번 문서 목록으로 완료 조건을 고정한다.

1. join 순서(확정, 각 화살표 뒤 실패 시 되돌림 명시):
   a. 권한: 페어링 대시보드 세션, Tailscale 세션 거부, `runtimeRole`이 standalone이 아니면 409 `standalone_required`.
   b. probe → confirm-host(허브 호스트 키를 링크 known_hosts에 기록) — 실패 시 아무것도 남기지 않음.
   c. 로컬 포트 P 선택(공용 할당기, 1024 이상).
   d. SSH로 허브의 `ocx link issue --alias <this> --tunnel-port P` 실행, stdout JSON `{linkId, apiKeyId, key, listenerPort}` 파싱(키는 로그·오류에 쓰지 않음) — 실패 시 되돌릴 것 없음.
   e. sidecar `client-link.json` 기록(K11) — 실패 시 원격 revoke.
   f. 클라이언트 소유 `ssh -N -L 127.0.0.1:P:127.0.0.1:<listenerPort>` 시작 후, 인증된 `GET /readyz`가 `http://127.0.0.1:P`에서 응답할 때까지 최대 15초 대기 — 실패 시 터널 중지 → 원격 revoke → sidecar 삭제.
   g. in-process `connectClient`(transport link, key는 메모리에서 전달) — 실패 시 터널 중지 → 원격 revoke → sidecar 삭제(connectClient 자체 롤백은 기존대로).
   h. 성공 시 응답 후 standalone→client 전환 재시작 예약(기존 `acceptSystemRestart`/recycle 경로).
2. 재시작·해제 경로의 터널 정리:
   - 클라이언트 런타임(src/client/runtime.ts)은 시작 시 sidecar가 있고 client transport가 link이면 `-L` supervisor를 시작하고, 종료(정상 stop, `scheduleStandaloneRecycle` 경로 포함)에서 supervisor를 리스너보다 먼저 멈춘다(TERM 후 최대 5초 대기, 이어 KILL).
   - 로컬 `ocx disconnect`(src/client/connect.ts disconnect 경로)는 연결 상태를 지우기 전에 sidecar가 있으면 터널을 멈추고, SSH로 허브에 `ocx link revoke --link-id <id>`를 한 번 시도(실패해도 해제는 진행, 결과를 disconnect 출력과 receipt에 "home revoke failed: run ocx link revoke on the home" 형태로 남김, 키는 쓰지 않음), 그 뒤 sidecar 삭제.
   - sidecar가 있는데 시작 시 손상·권한 불량이면 fail closed: 터널을 띄우지 않고 status child.state failed, reason `sidecar_invalid`.
3. 포트 계약: `src/link/ports.ts`(NEW)에 `MIN_LINK_PORT = 1024`, `MAX_LINK_PORT = 65535`, `isLinkPort(n)`. `ocx link port` 할당, `ocx link issue --tunnel-port` 파싱, link-routes issue 본문 검증, sidecar 검증, connect 검증이 모두 이 함수를 쓴다. 테스트: 1023 거부, 1024 허용, 65536 거부(각 경로).
4. 문서 소유: `structure/remote-link.md`에 클라이언트 시작 흐름·재시작·해제 정리를 현재형으로 추가하고, `structure/runtime.md`(600줄 예산)에는 client 런타임을 서술한 기존 줄 끝에 "A client with a link sidecar owns its SSH tunnel; see [Remote Link](remote-link.md)." 한 문장만 덧붙여 줄 수를 늘리지 않는다.
5. 비차단: 앞 절의 key zeroize 표현(:146 부근)과 "L4/L5 파일 없음" 서술은 무효. connect.ts 1037줄, runtime.ts 129줄(상한 없음).
6. GUI: `gui/src/api-targets.ts`에서 `isStandaloneRuntime()` export, Child 역할은 standalone일 때만 선택 가능, "홈 찾기" 흐름은 wp5의 추가 시트를 재사용(후보 → probe → 지문 확인 → join), 진행 중·실패·재시도 상태, 성공 시 "이 컴퓨터가 재시작됩니다" 안내 후 재연결 대기. 새 문구 키 10개 로케일.
7. 테스트(파일과 등록):
   - `tests/server/link-join-route.test.ts`: 세션 없음 401/403, Tailscale 403, hub·client 역할 409, 순서 a→h를 가짜 SshRunner·가짜 터널·가짜 connectClient로 검증, 단계 e/f/g 실패마다 revoke 호출과 sidecar 부재.
   - `tests/clients/client-link-state.test.ts`: sidecar 필드·권한·손상 거부·소유 확인 삭제.
   - `tests/clients/client-link-tunnel.test.ts`: 런타임 시작 시 -L 시작, 재시작 경로에서 supervisor가 리스너보다 먼저 멈춤, TERM→KILL 한정 대기, 로컬 disconnect가 터널 중지·revoke 시도·sidecar 삭제, revoke 실패 시에도 해제 완료와 안내 문구.
   - `tests/clients/link-ports.test.ts`: 포트 계약.
   - gui `tests/remote-link.test.tsx`에 Child 활성 조건·join 흐름·standalone_required 문구.
   - 모두 layout.json explicit와 test-layout-expected.json에 등록.
8. 문서: docs-site 8개 로케일 remote-link 가이드의 "coming soon" 문장을 자식 시작 흐름(요구 사항: 자식에서 홈으로 SSH 키 로그인, 홈에 ocx 실행 중)과 재시작·해제 동작으로 교체.


## 감사 반영 (Anscombe FAIL r2) — 이 절이 앞선 모든 내용보다 우선한다

1. 해제 오케스트레이션: NEW `src/client/link-teardown.ts`의 `teardownClientLink(deps: { readSidecar, stopTunnel, runner, knownHostsFile, deleteSidecar }): Promise<{ homeRevoke: "revoked" | "failed" | "not_applicable" }>`. 순서: sidecar 읽기(없으면 not_applicable) → `stopTunnel()`(런타임 supervisor의 stop, TERM→최대 5초→KILL) → SSH로 허브의 `ocx link revoke --link-id <id>` 1회(30초 제한) → sidecar 삭제. 호출 지점 두 곳: (a) machine API의 disconnect 처리(src/client/machine-api.ts:131-134 부근)가 `disconnectClient`를 부르기 **전에** 런타임이 주입한 `linkTeardown`을 호출, (b) CLI `ocx disconnect`(src/cli/connect.ts의 disconnect 경로)는 런타임이 떠 있으면 machine API를 쓰고, 아니면 프로세스 안에서 같은 함수를 직접 호출(stopTunnel은 pidfile 기반 정지). 잠금: teardown은 client lifecycle 잠금 밖에서 실행하고, 이어지는 `disconnectClient`가 기존 잠금을 잡는다(teardown이 연결 상태를 건드리지 않으므로 경합 없음). 결과 필드: disconnect의 JSON 출력과 receipt에 `homeRevoke`, 사람용 출력은 failed일 때만 "Home revoke failed; run ocx link revoke --link-id <linkId> on the home." 키는 어디에도 쓰지 않는다.
2. 준비 확인: join f단계의 확인은 `GET http://127.0.0.1:P/readyz`에 `x-opencodex-api-key: <발급 키>`를 붙여 보내고 HTTP 200을 성공으로 본다(503은 준비 중으로 재시도, 401은 즉시 실패 `admission_failed`). 키는 로그·오류 문자열에 넣지 않는다.
3. 포트 계약 범위: `isLinkPort`(1024-65535)는 **클라이언트 쪽 터널 포트 P**에만 적용한다: `ocx link port` 할당, `ocx link issue --tunnel-port`, link-routes issue 본문, `LinkRecord.tunnelPort`(src/link/store.ts:77-82의 tunnelPort 검증), `link.tunnelPort` 설정 스키마와 connect, link-relay 목적지(src/client/link-relay.ts:44-48), sidecar의 tunnelPort. **허브 리스너 포트 L**(`LinkStore.listenerPort`, sidecar의 peerListenerPort)은 기존 1-65535 검증을 유지한다(OS가 고른 포트).
4. 테스트 파일 정본(앞 절의 client-link-join/client-link-supervisor 이름 폐기): `tests/server/link-join-route.test.ts`(server), `tests/clients/client-link-state.test.ts`, `tests/clients/client-link-tunnel.test.ts`, `tests/clients/client-link-teardown.test.ts`, `tests/clients/link-ports.test.ts`(clients) + gui `tests/remote-link.test.tsx`. 검증 명령은 이 다섯 파일과 기존 link·client-link·listener·routes·CLI 스위트를 모두 돌린다.
5. structure/runtime.md 줄 수(반박): 문장은 **기존 줄의 끝에** 덧붙이므로 파일 줄 수는 600 그대로다. C 단계에서 `wc -l structure/runtime.md`가 600, `bun run structure:check` 통과로 증명한다.
6. 비차단 반영: docs 8개 경로 = `docs-site/src/content/docs/guides/remote-link.md`, `docs-site/src/content/docs/{fr,ko,zh-cn,zh-tw,ru,ja,tr}/guides/remote-link.md`. join 라우트는 인증·Tailscale·역할 검사를 lifecycle 상태 조회(`stateFor`)보다 먼저 한다(현재 dispatch가 먼저 조회하므로 join은 그 앞에서 분기).


## 감사 반영 (Anscombe FAIL r3) — r2 절 1번을 다음으로 대체한다

1. 해제는 CLI `ocx disconnect` 한 경로뿐이다(연결된 machine listener는 변경 요청을 403으로 막으므로 대시보드 해제 경로는 없다, src/client/machine-listener.ts:125). CLI는 프로세스 안에서 `teardownClientLink`를 부른다: sidecar 읽기(없으면 not_applicable) → sidecar의 linkId가 현재 `config.client.link.linkId`와 같은지 확인(다르면 건드리지 않고 not_applicable) → SSH로 허브의 `ocx link revoke --link-id <id>` 1회(30초) → 이어지는 `disconnectClient`가 잠금 아래에서 연결 상태를 지운 뒤, 같은 잠금 안에서 sidecar를 다시 읽어 linkId가 같을 때만 삭제. 터널 프로세스는 CLI가 죽이지 않는다: 소유자인 client 런타임이 해제 뒤 기존 재시작 경로(src/client/runtime.ts:44-79 recycle)에서 supervisor를 리스너보다 먼저 멈춘다(TERM→5초→KILL). 런타임이 떠 있지 않으면 터널도 없다.
2. `homeRevoke`는 disconnect의 JSON 출력(`--json`)과 사람용 출력에만 싣는다. Desktop receipt 스키마(src/claude/desktop-remote-store-state.ts:113)는 바꾸지 않는다. 사람용 문구는 failed일 때만 "Home revoke failed; run ocx link revoke --link-id <linkId> on the home."
3. 테스트(client-link-teardown.test.ts): revoke 성공·실패 두 경우 모두 해제 완료, 출력 필드, linkId 불일치 시 sidecar 보존, 잠금 안 재확인. client-link-tunnel.test.ts: recycle 경로에서 supervisor가 리스너보다 먼저 멈춤.


## 감사 반영 (Anscombe FAIL r4) — 터널 정지 트리거

- client 런타임의 `-L` supervisor는 기존 주기 타이머(1초)마다 `readClientConnectionState()`와 sidecar를 확인한다. 연결 상태가 connected가 아니거나, transport가 link가 아니거나, `link.linkId`가 sidecar의 linkId와 다르거나, sidecar가 없으면: 자식 ssh를 멈추고(TERM→5초→KILL) 기존 `scheduleStandaloneRecycle`(src/client/runtime.ts:44-79)을 예약한다. 새 인증 경로나 CLI→런타임 신호는 만들지 않는다. 런타임이 없으면 터널도 없다.
- 결과: CLI `ocx disconnect`는 원격 revoke 시도 → `disconnectClient`(잠금 안 sidecar 재확인·삭제)만 하고, 터널은 최대 한두 주기 안에 소유 런타임이 정리한다.
- 테스트(client-link-tunnel.test.ts): 실제 런타임 수명주기(가짜 SshRunner 자식, 주입 시계)에서 연결 상태를 disconnected로 바꾸면 2주기 안에 자식 정지와 recycle 예약이 일어남, linkId 불일치도 같음, 연결 유지 중에는 아무 일도 없음.



## 감사 반영 (Anscombe NEAR-PASS r5) — 고아 터널 잔여

- r4의 "런타임이 없으면 터널도 없다"는 보장이 아니다. 런타임이 SIGKILL로 죽으면 자식 `ssh -N -L`이 남을 수 있다. 계약을 다음으로 좁힌다.
- supervisor는 자식을 띄울 때 `<OPENCODEX_HOME>/client-link-tunnel.pid`(0600)에 `{ pid, linkId, argv }`를 쓰고, 정상 정지 뒤 지운다.
- 정리 시점은 두 곳이다. (a) client 런타임 시작 시 supervisor가 자식을 띄우기 전, (b) CLI `ocx disconnect`의 teardown. 두 곳 모두 같은 함수 `reapOrphanTunnel()`을 부른다.
- 확인 방법: Linux에서만 `/proc/<pid>/cmdline`을 NUL로 나눈 argv가 pidfile의 argv와 **정확히** 같을 때 TERM→최대 5초→KILL 후 pidfile을 지우고 `tunnel: "reaped"`. 다르거나 프로세스가 없으면 pidfile만 지우고 `tunnel: "absent"`. Linux가 아니면(macOS·Windows) 프로세스를 건드리지 않고 pidfile을 남긴 채 `tunnel: "unresolved"`와 pid를 보고한다.
- CLI 출력: `--json`에 `tunnel` 필드, 사람용 출력은 unresolved일 때만 "A link tunnel (pid <pid>) may still be running; stop it if it is." 한 줄.
- 남은 위험: macOS의 고아 터널은 자동 정리하지 않는다. 허브 revoke 뒤에는 발급 키가 무효라서 고아 터널로 들어오는 요청은 허브 리스너에서 401로 막힌다.
- 테스트(client-link-teardown.test.ts): 주입한 플랫폼·procfs 읽기로 Linux 일치(reaped), 불일치(absent, 프로세스 미접촉), 비Linux(unresolved, pidfile 유지) 세 경우.



## 구현 정정 (B 착수, 2026-09-25) — r3와 r5의 충돌 해소

- r3는 "CLI는 터널을 죽이지 않는다", r5는 "disconnect teardown에서 고아 터널 회수"라서, 런타임이 살아 있을 때 Linux에서 회수하면 런타임 소유 터널까지 argv가 일치해 죽는다.
- pidfile 경로는 `<configDir>/link/client-tunnel.pid`, 본문은 `{ version: 1, linkId, pid, argv, ownerPid }`다. `ownerPid`는 터널을 띄운 프로세스(client 런타임 또는 join 중인 standalone 프로세스)다.
- `reapOrphanTunnel()`은 `ownerPid`가 살아 있으면 아무것도 건드리지 않고 `{ tunnel: "owned" }`를 돌려준다. 소유자가 죽었을 때만 r5 규칙(Linux 정확 argv 일치 → reaped, 불일치·부재 → absent, 비Linux → unresolved)을 적용한다.
- 공용 인터페이스: `src/link/ports.ts`, `src/client/link-state.ts`, `src/client/link-tunnel.ts`(시그니처)를 B 첫 커밋에서 고정하고 병렬 실행자가 이 시그니처에 맞춰 구현한다.

