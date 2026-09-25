# 040 — wp4: L4 supervisor, management API, CLI

상위 문서: `000_prd.md`(r2), `001_stack_plan.md`, `002_arch_plan.md`, `010_wp1_link_core.md`.
대상 브랜치: `codex/remote-link-4-api`, base `codex/remote-link-3-client`.

## 범위

### IN

- 허브 프로세스가 `LinkRecord.direction === "hub-initiated"`인 링크마다 `ssh -N -T -R 127.0.0.1:<P>:127.0.0.1:<L>`을 소유하도록 `src/link/ssh-runner.ts`와 `src/link/supervisor.ts`를 추가한다.
- `/api/link/status`, `/api/link/candidates`, `/api/link/probe`, `/api/link/confirm-host`, `/api/link/apply`, `/api/link/{id}`, `/api/link/issue`를 lazy management route로 연결한다.
- route별 권한을 고정한다. dashboard session은 status/candidates/probe/confirm-host/apply/DELETE를 사용하고, 관리자 토큰은 루프백 요청에서 issue/status/DELETE를 사용한다. Tailscale identity session은 모든 link route에서 403이다.
- `apply`의 순서를 고정한다: remote `ocx link port` → 허브 프로세스 안에서 데이터 키 발급 → `links.json` 기록 → `await ensureStarted()` → `-R` 시작 → remote `ocx connect --link --key-stdin ...` 실행 → K13의 두 조건을 모두 관찰한다.
- `ocx link port`, `ocx link issue --alias A --tunnel-port P`, `ocx link status`, `ocx link revoke --link-id <id>`를 dispatch, registry, capability surface에 등록한다.
- 고아 pidfile은 pid와 기록된 argv가 현재 링크가 요구하는 argv와 모두 일치할 때만 정리한다. 불일치하면 남겨 두고 `failed` 증거로 표시한다.

### OUT

- wp1의 `paths`, `ssh-argv`, `ssh-config`, `tunnel-state`, `store`의 이름과 의미 변경.
- wp2 link listener의 ingress/auth 구현과 wp3 client `connect --link` 및 machine-listener 중계.
- GUI, 현재 `gui/src/i18n/shared.ts:6-17`의 10개 locale, docs-site 사용자 안내, client-initiated `-L` 흐름의 완성.
- 비밀번호 SSH, 원격 자동 설치, Windows client, 공개 HTTPS 앞단.
- unreleased security finding 또는 exploit 재현 기록. 이 문서는 PRD에 공개된 auth 경계와 검증 조건만 기술한다.

## 파일 변경 지도

| 경로 | 종류 | 내용 |
|---|---|---|
| `src/link/ssh-runner.ts` | NEW | `Bun.spawn`을 감싼 injectable one-shot 실행기와 장수 tunnel process seam. one-shot 결과는 `{code, stdout, stderr}`. |
| `src/link/supervisor.ts` | NEW | record별 `-R` 생성·spawn·재연결·pidfile·argv identity check·orphan reap·shutdown. |
| `src/server/management/link-routes.ts` | NEW | link API handler, session gate, probe confirmation state, apply/remove transaction. |
| `src/server/management-api.ts` | MODIFY | `/api/link` namespace를 lazy import하고 기존 `??` route chain의 link listener 앞에 삽입. 현재 `:170-185`, `:276-306`이 수정 지점이다. |
| `src/server/management/context.ts` | MODIFY | route test가 실제 config/key 파일을 건드리지 않도록 `link` 상태·키 발급·listener·supervisor seam을 `ManagementApiDeps`에 추가. 현재 `:36-133`이 의존성 표면이다. |
| `src/server/management/oauth-account-routes.ts` | MODIFY | 기존 `/api/keys` POST의 발급·persist 부분(`:952-968`)을 재사용 가능한 in-process helper로 추출하고 기존 route가 같은 helper를 호출. |
| `src/server/management/route-registry.ts` | MODIFY | 7개 `/api/link` route 선언. 현재 `src/server/management/route-registry.ts:366-374`의 remote-workspace 묶음 앞에 추가하며 handler import는 하지 않는다. auth matrix는 handler에서 적용한다. |
| `src/server/index/optional-listeners.ts` | MODIFY (wp2 base) | hub link supervisor를 optional listener stop 목록에 listener보다 먼저 등록한다. supervisor stop이 끝난 뒤 link listener를 닫고, `src/server/index.ts:746-799`의 기존 shutdown 경계를 깨지 않는다. 현재 dev 기준 파일은 아직 없으며 `002_arch_plan.md`의 wp2 산출물을 전제로 한다. |
| `src/cli/link.ts` | NEW | `port`, `issue`, `status`, `revoke --link-id` parsing과 stdout JSON 계약. 실행 중 proxy의 status/revoke는 루프백 admin-token management API를 사용하고, proxy가 없으면 status만 local store를 읽는다. |
| `src/cli/registry.ts` | MODIFY | `link` canonical command와 help grammar. 기존 `connect`/`remote-workspace` 인접 구간 `:119-148`에 추가. |
| `src/cli/dispatch.ts` | MODIFY | `link` runner를 lazy import. 기존 `connect` runner `:538-545` 인접 지점에 추가. |
| `src/cli/capabilities.ts` | MODIFY | 네 CLI capability 선언(port/issue/status/revoke). capability table은 leaf data module이며 현재 `:925-949` 인접부에만 data를 추가한다. |
| `structure/remote-link.md` | MODIFY (wp1 base) | pure module 문서에 runner/supervisor의 현재형 lifecycle과 ownership을 추가. 현재 dev에는 wp1 파일이 아직 없다. |
| `skills/ocx/SKILL.md`, `skills/ocx/references/01_management_surface.md`, 관련 생성 산출물 | GENERATED MODIFY | `bun run skill:surface`로 capability surface와 link 명령을 반영한다. 수동 편집하지 않는다. |
| `tests/server/link-management-routes.test.ts` | NEW | route별 principal matrix, K16 DTO, API auth/apply/remove 순서와 실패 경로. `server` domain explicit 등록. |
| `tests/clients/link-supervisor.test.ts` | NEW | injected runner, 상태 reducer 연결, pidfile argv 검증, orphan safety. `clients` explicit 등록. |
| `tests/cli/cli-link.test.ts` | NEW | port/issue/status/revoke parsing, admin-token loopback 호출, stdout secret shape, registry/dispatch/capability parity. `cli` regex가 맞지만 explicit도 등록한다. |

## 새 파일/변경 상세

### `src/link/ssh-runner.ts` (NEW)

wp1의 `buildExecArgv`와 `buildTunnelArgv`가 반환하는 argv만 실행한다. shell 문자열이나 `shell: true`는 사용하지 않는다.

```ts
export interface SshRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SshChild {
  readonly pid: number;
  readonly argv: readonly string[];
  readonly exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
}

export interface SshRunner {
  run(argv: readonly string[], options?: {
    stdin?: string | Uint8Array;
    timeoutMs?: number;
  }): Promise<SshRunResult>;
  spawnTunnel(argv: readonly string[]): SshChild;
}

export function createSshRunner(deps?: {
  spawn?: typeof Bun.spawn;
  timeoutMs?: number;
}): SshRunner;
```

`run`은 stdout/stderr를 끝까지 읽고 exit code를 반환한다. timeout, spawn 예외, stream decode 실패는 route가 구분할 수 있는 오류로 표면화한다. `spawnTunnel`은 stdout/stderr를 supervisor가 소비할 수 있는 child로 남기며 import 시 spawn하지 않는다. 테스트는 `spawn`을 주입해 실제 SSH와 네트워크를 사용하지 않는다.

### `src/link/supervisor.ts` (NEW)

정확한 exported surface는 다음과 같다.

```ts
export type LinkTunnelStatus =
  | { linkId: string; direction: "hub-initiated"; state: TunnelState; pid: number | null }
  | { linkId: string; direction: "client-initiated"; state: "client-owned"; pid: null };

export interface LinkSupervisor {
  start(): void;
  ensureStarted(): Promise<void>;
  stopLink(linkId: string): Promise<void>;
  status(): readonly LinkTunnelStatus[];
  stop(): Promise<void>;
}

export interface LinkSupervisorDeps {
  readStore?: () => LinkStore;
  writeStore?: (store: LinkStore) => void;
  runner?: SshRunner;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearTimer?: (timer: ReturnType<typeof setInterval>) => void;
  readProcessArgv?: (pid: number) => readonly string[] | null;
  killProcess?: (pid: number) => void;
}

export function createLinkSupervisor(deps?: LinkSupervisorDeps): LinkSupervisor;
```

구현 순서는 다음과 같다.

1. `start()`는 `readLinkStore(linkStorePath())`를 동기적으로 읽고, `reapOrphans()`를 먼저 수행한다. 손상된 store를 빈 store로 복구하지 않는다.
2. `ensureStarted(): Promise<void>`는 startup `start()`와 apply가 공유하는 single-flight promise를 반환한다. 동시에 들어온 호출은 한 번만 listener bind를 시도하고 모두 같은 성공/실패를 관찰한다. 빈 store에서는 bind하지 않는다.
3. `hub-initiated` record만 `listenerPort`를 target으로 삼아 `buildTunnelArgv({ alias: record.alias, direction: "R", bindPort: record.tunnelPort, targetPort: store.listenerPort!, knownHostsFile: linkKnownHostsPath() })`를 호출한다. `listenerPort === null`이면 spawn하지 않고 `failed{reason:"forward"}`에 해당하는 상태를 노출한다.
4. child spawn 직후 pidfile에 `{version: 1, linkId, pid, argv}`를 atomic write한다. pidfile에는 key material을 쓰지 않는다. child stderr는 `classifySshStderr`로 분류하고 `reduceTunnel`에 `spawn`, `ready`, `exit`, `tick`을 공급한다. forward가 실제로 열렸다는 증거는 `-o ExitOnForwardFailure=yes`의 성공 exit/연결 확인으로 삼는다.
5. timer는 supervisor가 소유하고 `dueForSpawn`이 true인 record만 재시도한다. `tunnel-state.ts`는 clock/timer를 직접 만들지 않는다. auth, hostkey, forward, 5분 timeout은 재시도하지 않고 사용자 조치가 필요한 상태로 남긴다.
6. pidfile orphan은 pid가 살아 있고 `readProcessArgv(pid)`가 저장 argv와 byte-for-byte 일치할 때만 kill한다. pid만 같거나 argv가 다르면 kill하지 않고 pidfile을 보존하며 status에 `orphan-unverified`를 기록한다. 정상 종료는 pid가 여전히 해당 pidfile의 값일 때만 파일을 삭제한다.
7. `stopLink`는 현재 child만 종료하고 pidfile을 조건부 삭제한 뒤 해당 record의 터널 상태를 idle로 만든다. `stop()`은 새 spawn을 막고 timer를 해제한 후 모든 child의 종료를 await한다. `optional-listeners.stop()`은 supervisor를 먼저 await하고 link listener를 다음에 닫는다. `client-initiated`는 client-owned로 표시하고 허브가 kill하지 않는다.

### `src/server/management/link-routes.ts` (NEW)

route handler는 `handleRemoteWorkspaceRoutes`의 `ManagementContext`/`response`/session gate 구조(`src/server/management/remote-workspace-routes.ts:1-49`)를 따른다. exported surface와 내부 seam은 다음과 같다.

```ts
export interface LinkRouteState {
  pendingHosts: Map<string, {
    fingerprint: string;
    knownHostLine: string;
    ocxVersion: string;
    expiresAt: number;
  }>;
  supervisor: LinkSupervisor;
  listener: {
    ensureStarted(): Promise<void>;
    closeIfUnused(): Promise<void>;
  };
}

export async function handleLinkRoutes(
  ctx: ManagementContext,
  state: LinkRouteState,
): Promise<Response | null>;
```

#### route별 auth matrix

| route | dashboard paired session | admin-token + loopback | Tailscale identity session | CLI |
|---|---|---|---|---|
| `GET /api/link/status` | 허용 | 허용 | 403 | 실행 중 proxy의 `ocx link status` |
| `GET /api/link/candidates` | 허용 | 403 | 403 | 없음 |
| `POST /api/link/probe` | 허용 | 403 | 403 | 없음 |
| `POST /api/link/confirm-host` | 허용 | 403 | 403 | 없음 |
| `POST /api/link/apply` | 허용 | 403 | 403 | 없음 |
| `DELETE /api/link/{id}` | 허용 | 허용 | 403 | `ocx link revoke --link-id <id>` |
| `POST /api/link/issue` | 403 | 허용 | 403 | `ocx link issue` |

`admin-token` 행은 반드시 요청의 실제 loopback origin/bind를 확인한 경우에만 허용한다. public bind, non-loopback management ingress, no principal, capability principal, 잘못된 token은 403이다. Tailscale identity session은 route별 session check보다 먼저 명시적으로 거부하며, 세션 헤더를 `gui-session`으로 취급하지 않는다. route registry는 route 목록을 선언하고, 실제 principal 판정과 loopback 확인은 handler에 둔다.

#### K16 wire DTO

응답은 아래 shape를 그대로 사용한다. 필드 추가, `runtimeRole`/`hub`/`client` 같은 별칭, secret 포함은 허용하지 않는다.

```ts
GET /api/link/status -> {
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
  child: null | {
    alias: string;
    state: "connecting" | "connected" | "reconnecting" | "failed" | "idle";
    since: string;
    reason: string | null;
  };
}

GET /api/link/candidates -> {
  candidates: Array<{ alias: string; source: "ssh_config" | "tailscale" }>;
}
POST /api/link/probe -> { alias: string; fingerprint: string; keyType: string; }
POST /api/link/confirm-host -> { alias: string; fingerprint: string; ocxVersion: string; }
POST /api/link/apply -> 202 { linkId: string }
POST /api/link/issue -> { linkId: string; apiKeyId: string; key: string; listenerPort: number; }
error -> { error: { code: string; message: string } }
```

`GET /api/link/status`는 links.json의 redacted records, supervisor tunnel state, listenerPort를 K16 필드로 투영한다. key 값, admin token, pidfile argv의 secret field는 반환하지 않는다. `GET /api/link/candidates`의 후보는 trust가 아니다.

`POST /api/link/probe`는 exact body `{alias}`를 요구한다. 임시 known_hosts로 fingerprint와 key type을 얻어 pending map에 만료 시각과 key line을 저장한다. probe 응답은 K16의 `alias`, `fingerprint`, `keyType`만 반환하고 `ocxVersion`을 섞지 않는다. `POST /api/link/confirm-host`는 exact body `{alias, fingerprint}`를 요구하고 pending fingerprint와 byte-equal인지 확인한다. 일치할 때만 pending key line을 link known_hosts에 append/replace하고 pending entry를 소비하며, 같은 응답에 확인된 `ocxVersion`을 K16 shape로 반환한다. 불일치·만료·unknown alias는 error DTO로 끝내며 파일을 변경하지 않는다.

`POST /api/link/apply`는 exact body `{alias}`를 요구한다. confirmed host가 없으면 error DTO로 409를 반환한다. `buildExecArgv(["ocx", "link", "port"])` 결과를 strict JSON `{port}`로 검증하고, 기존 key issuance helper를 in-process 호출해 `{apiKeyId,key}`를 얻는다. listenerPort를 확보한 store에 새 `LinkRecord`를 먼저 기록한 뒤 `await state.listener.ensureStarted()`를 호출하고, supervisor가 `-R`을 시작한 뒤 원격 stdin에 `{apiKeyId,key}` JSON을 넣어 `ocx connect --link --key-stdin --tunnel-port P --link-id ID`를 실행한다. 성공 판정은 K13대로 원격 명령 exit 0과 15초 안에 해당 key로 link listener에 인증된 첫 catalog lookup 요청 관찰을 모두 만족해야 한다. 둘 중 하나라도 실패하면 새 record, key, tunnel을 역순으로 회수하고 error DTO를 반환한다. 성공 HTTP status는 202이며 body는 `{linkId}`만 반환하고, 연결 완료는 status polling으로 관찰한다.

`POST /api/link/issue`는 exact body `{alias, tunnelPort}`를 요구하고 admin-token + loopback에서만 실행한다. in-process key issuance와 LinkRecord 기록을 한 transaction으로 수행하고 K2의 `{linkId, apiKeyId, key, listenerPort}`를 반환한다. `DELETE /api/link/{id}`는 id를 path에서 strict decode한다. supervisor stop → remote `ocx disconnect` → key revoke → store record 제거 순서이며 각 단계의 실패를 숨기지 않는다. record 제거가 마지막 link를 없애면 같은 처리 끝에서 즉시 `await state.listener.closeIfUnused()`를 호출한다. key revoke가 실패하면 record를 지워 orphan credential을 만들지 않고 error DTO를 반환한다.

### 기존 관리 API와 key issuance 변경

`src/server/management-api.ts:170-185`의 remote-workspace lazy loader 앞에 같은 namespace guard를 갖는 `handleLinkRoutesOnDemand(ctx)`를 둔다. 현재 route chain은 `src/server/management-api.ts:276-306`이며, link handler를 `handleSessionRoutes(ctx)` 다음, remote-workspace보다 앞에 연결한다. static import로 link supervisor를 management API 전체에 올리지 않는다. link handler는 route matrix의 admin-token loopback gate와 Tailscale identity 거부를 자체적으로 적용한다.

현재 key 발급은 `src/server/management/oauth-account-routes.ts:952-968` 안에 inline되어 있다. 다음처럼 `issueApiKeyInProcess(config, name)`를 같은 파일에 export하고 기존 POST route가 이를 호출하게 한다.

```ts
export function issueApiKeyInProcess(config: OcxConfig, name: string): IssuedApiKey {
  const key = "ocx_data_" + randomBytes(20).toString("hex");
  const entry = { id: randomUUID(), name, key, createdAt: new Date().toISOString() };
  config.apiKeys = [...(config.apiKeys ?? []), entry];
  saveConfigPreservingClaudeCode(config);
  reconcileLiveStateStores();
  return entry;
}
```

`IssuedApiKey`는 `{id: string; name: string; key: string; createdAt: string}`이며 link route는 `id`와 `key`만 link record/remote stdin에 사용한다. route test는 `ManagementApiDeps.issueApiKey` seam을 사용해 실제 사용자 config를 쓰지 않는다. 이 seam과 link supervisor/state seam은 `src/server/management/context.ts:36-62`에 추가한다.

### CLI

`src/cli/link.ts`는 다음 signature를 갖는다.

```ts
export const LINK_USAGE = `Usage:
  ocx link port [--json]
  ocx link issue --alias <alias> --tunnel-port <port> [--json]
  ocx link status [--json]
  ocx link revoke --link-id <id> [--json]`;

export interface LinkCliDeps extends RuntimeApiDeps {
  choosePort?: () => Promise<number>;
  readStore?: () => LinkStore;
  readAdminToken?: () => string | null;
}

export async function runLinkCommand(rawArgs: string[], deps?: LinkCliDeps): Promise<number>;
```

`port`는 `findAvailablePort(0, "127.0.0.1")`로 실제 ephemeral port를 확정하고 JSON 외 stdout을 쓰지 않는다. `status`는 실행 중인 proxy가 있으면 `/api/link/status`를 admin-token + loopback으로 호출하고, 없으면 local store를 직접 읽는다. 두 경로 모두 K16 status DTO를 그대로 출력하며 key를 포함하지 않는다. `issue`는 alias와 port를 검증하고 admin-token을 argv/env에 넣지 않은 채 running management API의 `/api/link/issue`를 loopback으로 호출해 K2 응답을 출력한다. `revoke --link-id`는 실행 중 proxy의 `DELETE /api/link/{id}`를 admin-token + loopback으로 호출하고, 성공 시 redacted `{linkId}` 결과만 출력한다.

### 정확한 MODIFY snippets

#### `src/server/management-api.ts`

현재 `:170-185`는 remote-workspace만 lazy load한다.

```ts
async function handleRemoteWorkspaceRoutesOnDemand(ctx: ManagementContext): Promise<Response | null> {
  if (!pathInManagementNamespace(ctx.url.pathname, "/api/remote-workspace")) return null;
  // ...
  const { handleRemoteWorkspaceRoutes } = await import("./management/remote-workspace-routes");
  return handleRemoteWorkspaceRoutes(ctx);
}
```

after에는 같은 위치에 `handleLinkRoutesOnDemand(ctx)`가 추가되고 `handleManagementAPI`의 `:279-281`은 다음 순서가 된다.

```ts
routed = handleSessionRoutes(ctx)
  ?? (await handleLinkRoutesOnDemand(ctx))
  ?? (await handleRemoteWorkspaceRoutesOnDemand(ctx))
  ?? (await handleConfigRoutes(ctx));
```

#### `src/server/management/route-registry.ts`

현재 remote-workspace 선언은 `src/server/management/route-registry.ts:366-374`에 있다. after에는 그 앞에 다음 seven rows를 추가한다. status와 DELETE는 CLI가 실제 route를 사용하므로 exemption을 붙이지 않는다. candidates/probe/confirm-host/apply만 CLI 없는 dashboard session-only route로 선언한다.

```ts
// server/management/link-routes
{ method: "GET", path: "/api/link/status", module: "server/management/link-routes", mutates: false },
{ method: "GET", path: "/api/link/candidates", module: "server/management/link-routes", mutates: false, exempt: { reason: "session-only", why: "SSH candidates are a dashboard pairing surface and are withheld from admin-token and Tailscale identity sessions." } },
{ method: "POST", path: "/api/link/probe", module: "server/management/link-routes", mutates: true, exempt: { reason: "session-only", why: "SSH probing and host-key presentation are part of the interactive pairing consent flow and have no unattended CLI verb." } },
{ method: "POST", path: "/api/link/confirm-host", module: "server/management/link-routes", mutates: true, exempt: { reason: "session-only", why: "Persisting a host key requires the paired dashboard session that saw the fingerprint; identity headers and admin tokens cannot confirm it." } },
{ method: "POST", path: "/api/link/apply", module: "server/management/link-routes", mutates: true, exempt: { reason: "session-only", why: "Applying a link issues a data key and starts a remote tunnel, so it requires the full paired dashboard session." } },
{ method: "DELETE", path: "/api/link/{id}", module: "server/management/link-routes", mutates: true, mechanism: "regex" },
{ method: "POST", path: "/api/link/issue", module: "server/management/link-routes", mutates: true },
```

#### `src/cli/registry.ts`, `src/cli/dispatch.ts`, `src/cli/capabilities.ts`

현재 registry의 top-level entries는 `src/cli/registry.ts:119-148`, dispatch runner는 `src/cli/dispatch.ts:538-549`, capability array의 terminal entries는 `src/cli/capabilities.ts:925-949`에 있다. 각각 after에는 `link` canonical entry/runner와 `port`, `issue`, `status`, `revoke` leaf capability rows를 추가한다. registry와 dispatch는 exact name `link`를 공유해야 parity test가 통과한다. capability rows는 `port`에 routes `[]`, `mutates: false`, `json: "payload"`; `issue`에는 `POST /api/link/issue`, `status`에는 `GET /api/link/status`, `revoke`에는 `DELETE /api/link/{id}`를 넣고 모두 `json: "payload"`를 사용한다. issue/revoke route 호출은 admin-token + loopback으로 제한한다.

## 필드 체인 — PLAN-FIELD-CHAIN-01

| 필드/형태 | 생성 | 직렬화 | 역직렬화·검증 | 모든 consumer |
|---|---|---|---|---|
| `SshRunResult.code/stdout/stderr` | `SshRunner.run`이 Bun child exit/두 stream을 수집 | 메모리 반환만 하며 디스크·로그에 raw credential을 쓰지 않음 | runner가 number/string으로 보장 | probe version parser, remote port parser, connect/disconnect 결과 분류, CLI API error |
| pidfile `version/linkId/pid/argv` | supervisor가 tunnel spawn 직후 생성 | `linkDir/<linkId>.pid`에 atomic JSON, key 없음 | startup에서 shape, pid 양수, linkId 존재, argv exact match 검증 | orphan reap, normal exit cleanup, status projection, shutdown |
| K16 status `{role,listener,links,child}` | `LinkStore` + supervisor + listener state | `/api/link/status` JSON 및 `ocx link status` projection | role/listener/link/child enum과 nullable 값만 허용 | dashboard polling, CLI status, apply wait, reconnect 503 상태 |
| K16 candidates/probe/confirm/apply DTO | host candidate loader, SSH probe, host confirmation, apply transaction | 각 route가 K16 exact JSON만 반환 | handler와 route tests가 extra/missing fields를 거부 | GUI, CLI status/revoke, host confirmation, link polling |
| issue `{linkId,apiKeyId,key,listenerPort}` | loopback admin-token issue transaction | key는 issue 성공 시 단 한 번 CLI stdout으로만 전달; status/store에는 key 미저장 | CLI는 id/port/string shape와 `ocx_data_` pattern을 검증; store는 `apiKeyId`만 검증 | remote `ocx connect --link --key-stdin`, link record, revoke rollback, CLI caller |
| pending host `{alias,fingerprint,keyType,knownHostLine,expiresAt}` (`ocxVersion`은 confirm 이후 `ConfirmedHost`에만) | probe 성공 시 process memory | persist하지 않음; confirm 전 link known_hosts에 쓰지 않음 | confirm이 alias/fingerprint exact match와 expiry를 재검증 | confirm-host, apply precondition, failed/expired probe response |

wp1에서 이미 정의한 `LinkRecord`의 `apiKeyId`, `tunnelPort`, `hostKeyFingerprint`, `direction`은 추가 필드가 아니다. wp4는 그 필드들을 생성·저장하는 consumer일 뿐이며 `010_wp1_link_core.md`의 chain을 따른다.

## 테스트 사례

테스트는 실제 SSH, 외부 호스트, 사용자의 `~/.ssh`, 실제 admin token을 사용하지 않는다. `mkdtempSync` fixture, 합성 alias, injected runner와 temp config를 사용한다.

### `tests/clients/link-supervisor.test.ts`

- 활성화: `LinkStore{listenerPort: 19001, links:[hub-initiated record]}`를 주입하고 fake runner가 `buildTunnelArgv`와 exact argv를 기록한다. 증거: `spawn` argv가 `-R 127.0.0.1:<tunnelPort>:127.0.0.1:19001`이고 `BatchMode`, `StrictHostKeyChecking=yes`, `ExitOnForwardFailure`가 존재한다.
- 활성화: child가 network stderr로 종료한다. 증거: state가 `reconnecting`, retryAt 전 spawn 없음, due 시 한 번만 재spawn한다.
- 활성화: auth, hostkey, forward stderr와 5분 tick. 증거: 각각 `failed`의 해당 reason이며 추가 spawn 없음.
- 활성화: stale pidfile의 pid/argv가 exact match. 증거: injected kill이 한 번 호출되고 pidfile이 삭제된다.
- 활성화: 살아 있는 pid의 argv가 다르거나 pid만 같다. 증거: kill이 0회이고 pidfile이 보존된다.
- 활성화: `client-initiated` record. 증거: supervisor가 spawn/kill하지 않고 `client-owned`를 반환한다.
- 활성화: `stop()` 중 새 retry가 due. 증거: timer 해제 후 spawn 0회, 모든 child 종료 await.

### `tests/server/link-management-routes.test.ts`

- 활성화: 각 route에 no principal, paired dashboard session, admin-token + loopback, admin-token + non-loopback, local capability, Tailscale identity session을 각각 주입한다. 증거: matrix대로 status/DELETE/issue의 허용 조합만 성공하고 candidates/probe/confirm-host/apply와 모든 Tailscale 조합은 403이다.
- 활성화: `/api/link/probe`에 unknown alias, malformed body, runner exit, fingerprint parse failure. 증거: 각각 400/404/502/502이며 known_hosts와 pending state가 의도 없이 쓰이지 않는다.
- 활성화: probe 후 다른 fingerprint로 confirm. 증거: 409, known_hosts byte unchanged.
- 활성화: confirm 후 apply. 증거: remote `ocx link port` → in-process key issue → store write → `await ensureStarted()` → `-R` spawn → stdin JSON `ocx connect --link` 순서가 event log에서 관찰되고, exit 0만으로 connected가 되지 않으며 15초 내 first authenticated catalog lookup까지 있어야 한다.
- 활성화: port JSON malformed, listener bind failure, tunnel auth failure, remote connect refusal. 증거: 4xx/502/503 매핑, rollback에서 key revoke/store removal/tunnel stop이 모두 관찰된다.
- 활성화: DELETE existing, unknown id, revoke refusal, last-link removal. 증거: 정상 순서와 record 보존 조건을 각각 확인하고, 마지막 record 삭제 직후 link listener가 닫힌다.
- 활성화: `/api/link/*`와 `/api/remote-workspace` namespace collision. 증거: prefix collision은 link handler가 claim하지 않고 remote route가 기존대로 동작한다.

### `tests/cli/cli-link.test.ts`

- 활성화: `runLinkCommand(["port","--json"])`. 증거: stdout이 JSON 한 문서이고 port가 1..65535이며 stderr/추가 stdout이 없다.
- 활성화: issue에 alias/port 누락, running proxy 없음, API 4xx. 증거: usage exit 64 또는 management exit 1이며 key가 error text에 포함되지 않는다.
- 활성화: running proxy와 stopped proxy에서 `status`, admin-token loopback `revoke --link-id`. 증거: status는 각각 management API/K16 local projection을 사용하고 revoke는 DELETE만 호출하며 key를 출력하지 않는다.
- 활성화: fake management response. 증거: issue stdout JSON이 K2 네 필드만 포함하고 status는 K16 DTO, revoke는 redacted result만 포함한다.
- 활성화: registry/dispatch/capability/route registry reconciliation. 증거: `DISPATCH_COMMANDS`의 `link`, `findCommand("link")`, capability invocation과 실제 route key가 모두 일치한다.

## 검증 명령

현재 이 worktree는 docs-only이며 지정된 target 외 파일을 쓸 수 없다. 따라서 아래 현재 검증은 모두 read-only이고, 구현 PR에서 신규 파일 생성 후의 명령은 계획으로 남긴다. 각 현재 명령은 이 문서 또는 명시된 source를 읽는지 함께 기록한다.

| 명령 | 실행 시점 | exit | change target 읽음 | 결과 |
|---|---|---:|---|---|
| `test -f devlog/_plan/260925_remote_home_child_link/000_prd.md && test -f .../010_wp1_link_core.md` | 사전 확인 | 0 | 아니오 | 필수 계획 문서 존재 |
| `test -f src/server/management-api.ts && test -f src/server/management/route-registry.ts && test -f src/cli/registry.ts && test -f src/cli/dispatch.ts && test -f src/cli/capabilities.ts` | 사전 확인 | 0 | 아니오 | 기존 MODIFY source 존재 |
| `test -f src/link/supervisor.ts; test -f src/server/management/link-routes.ts; test -f src/cli/link.ts` | 사전 확인 | 1 | 아니오 | 현재 dev에는 wp4 신규 파일이 아직 없음; 선행 구현 대상 |
| `wc -l devlog/_plan/260925_remote_home_child_link/040_wp4_supervisor_api_cli.md` | 문서 작성 후 | 0 | 예 | 문서 line count 확인 |
| `git diff --check -- devlog/_plan/260925_remote_home_child_link/040_wp4_supervisor_api_cli.md` | 문서 작성 후 | 0 | 예 | whitespace 오류 없음 |
| `bun run skill:surface:check` | 문서 작성 후 | 0 | 아니오 | 현재 generated CLI surface drift 없음; wp4 capability 추가 후 재실행 필요 |
| `bun run privacy:scan` | 문서 작성 후 | 0 | 예 | target을 포함한 저장소 privacy scan |
| `bun test tests/server/management-route-registry.test.ts tests/cli/cli-registry.test.ts tests/cli/cli-capabilities.test.ts` | 문서 작성 후 | 0 | 아니오 | 현재 registry/capability baseline focused tests; wp4 구현을 읽지 않음 |
| `bun test tests/server/link-management-routes.test.ts tests/clients/link-supervisor.test.ts tests/cli/cli-link.test.ts` | wp4 구현 후 | 미실행 | 예 | 신규 테스트가 생긴 뒤 실행할 focused proof |
| `bun run typecheck` | wp4 구현 후 | 미실행 | 아니오 | 신규 source compile proof; docs-only lane에서는 실행하지 않음 |
| `bun run skill:surface` | wp4 capability 변경 후 | 미실행 | 아니오 | generated `skills/ocx` files 갱신; 이 lane의 write scope 밖 |

`bun run test`와 `bun run test:changed`는 이 문서 lane에서 실행하지 않는다. wp4 구현 PR은 위 focused tests, `bun run typecheck`, `bun run privacy:scan`, `bun run structure:check`를 먼저 실행하고 full suite는 parent gate에서 판단한다.

## 우회 경로 기록

| enforcement | tier | surface | bypass | residual risk |
|---|---|---|---|---|
| per-route link auth matrix | E-management route | `/api/link/*` | admin-token issue/status/revoke는 loopback에서만 허용되고 dashboard session route는 paired session을 요구함 | Tailscale identity session은 전 route에서 거부하며, link ingress는 자식에 management route를 노출하지 않음 |
| Tailscale identity session 거부 | E-session issuance | link mutation | 사용자가 loopback dashboard에서 정식 paired session을 발급한 뒤 수행 | session token 보유 프로세스가 사용자 권한으로 동작할 수 있다는 기존 경계는 남음 |
| host-key confirmation | E-SSH trust | probe/confirm | 사용자가 OS `known_hosts`에 직접 key를 넣으면 probe가 이미 신뢰된 host를 관찰할 수 있음 | 의도된 OpenSSH 동작. route는 fingerprint를 확인하지 않은 채 link store에 쓰지 않음 |
| pidfile orphan kill | E-process ownership | supervisor shutdown/restart | pidfile을 수동 삭제하면 orphan이 남을 수 있음 | argv mismatch를 kill하지 않는 대신 orphan 수동 정리가 필요하며, 다른 process kill은 피함 |
| CLI stdout secret | E-CLI credential | `ocx link issue` | shell history나 pipe consumer가 stdout을 저장할 수 있음 | K1/K2에 따라 issue 성공 시에만 JSON key를 한 번 출력하고 status/revoke/store/log에는 key를 쓰지 않음 |

## file-size ratchet headroom

현재 baseline `tests/fixtures/file-size-baseline.json`에는 아래 파일들의 개별 cap이 없다. ratchet 규칙상 신규/무등록 파일은 2,000 lines 미만이어야 하므로 현재 line count 기준 headroom은 다음과 같다. 신규 파일도 2,000 lines 미만으로 유지한다.

| 파일 | 현재 lines | baseline cap | headroom |
|---|---:|---:|---:|
| `src/server/management-api.ts` | 467 | 신규 cap 없음 | 1,533 lines to 2,000 |
| `src/server/management/route-registry.ts` | 401 | 신규 cap 없음 | 1,599 |
| `src/server/management/oauth-account-routes.ts` | 1,033 | 신규 cap 없음 | 967 |
| `src/server/management/context.ts` | 156 | 신규 cap 없음 | 1,844 |
| `src/cli/registry.ts` | 643 | 신규 cap 없음 | 1,357 |
| `src/cli/dispatch.ts` | 1,118 | 신규 cap 없음 | 882 |
| `src/cli/capabilities.ts` | 968 | 신규 cap 없음 | 1,032 |
| `src/link/ssh-runner.ts`, `src/link/supervisor.ts`, `src/server/management/link-routes.ts`, `src/cli/link.ts` | NEW | 신규 cap 없음 | each must stay below 2,000 |
| new focused tests | NEW | 신규 cap 없음 | each must stay below 2,000 |

`devlog/`는 ratchet scan 제외 경로다. `structure/remote-link.md`는 wp1 base에서 생성될 때 2,000 lines 미만으로 유지한다. 기존 `src/server/index.ts` cap 893은 wp4가 직접 수정하지 않으며 wp2의 zero-net-lines 계약을 보존한다.

## test layout registration entries

`tests/server/link-management-routes.test.ts`는 현재 `server.match` regex에 `link`가 없어 `explicit`에 `"link-management-routes.test.ts": "server"`를 추가해야 한다. `tests/clients/link-supervisor.test.ts`는 `clients.match`에 seed가 없으므로 `explicit`에 `"link-supervisor.test.ts": "clients"`를 추가한다. `tests/cli/cli-link.test.ts`는 `cli.match`의 `^(?:cli|...)` seed로 분류되지만 deterministic하게 `explicit`에 `"cli-link.test.ts": "cli"`도 추가한다. 세 항목은 `scripts/test-layout/layout.json`과 `tests/fixtures/test-layout-expected.json` 양쪽에 동일하게 넣고 layout/tooling tests를 실행한다.

## structure/doc updates

wp4는 새 structure authority를 만들지 않는다. wp1이 소유한 `structure/remote-link.md`의 `documents`에 이미 `src/link/`가 포함되어야 하며, wp4는 그 문서의 supervisor 현재형 설명만 갱신한다. `structure/manifest.json`에 새 entry를 추가하지 않는다. wp2가 `src/server/index/optional-listeners.ts`와 ingress contract를 structure 문서에 매핑했다면 그 문서의 source ownership을 검토하고 필요한 현재형 문장만 갱신한다. `structure/INDEX.md`는 manifest 변경이 실제로 생긴 경우에만 `bun run structure:index`로 재생성한다.

현재 dev에서 `structure/remote-link.md`, `src/link/`가 아직 없다는 것은 선행 stack 산출물이 이 worktree에 병합되지 않았다는 증거다. wp4 implementation 시작 전 base가 `codex/remote-link-3-client`인지 확인하고, 누락이면 parent에게 expansion을 보고한다.

## docs-site impact

wp4 자체는 GUI/docs-site 사용자 흐름을 추가하지 않는다. 따라서 docs-site 파일 변경은 OUT이다. 다만 `ocx link` capability와 JSON shape가 public CLI surface가 되므로 wp5 또는 별도 docs phase가 `docs-site/src/content/docs/reference/management-api.md`와 CLI reference에 다음을 반영해야 한다: route별 dashboard/admin-token loopback requirement, host-key confirmation, `port`/`issue`/`status`/`revoke` output, key stdout handling, reconnect/failed semantics. 문서가 먼저 public behavior를 약속하지 않도록 wp4 PR에는 docs update pending을 명시한다.

## PR title/body notes

제목: `feat(link): add hub tunnel supervisor and link management API`

본문에는 다음을 포함한다.

- L4가 L1-L3 계약 위에서 hub-owned `-R` supervisor, lazy `/api/link/*`, CLI surface를 제공한다는 요약.
- `bun test` full suite는 이 phase의 local verification에서 실행하지 않았다는 사실, focused route/supervisor/CLI tests와 typecheck의 실제 결과.
- orphan reap이 pid와 argv exact match일 때만 kill한다는 ownership proof.
- `ocx link apply`의 remote command/stdin 순서와 rollback evidence.
- `MAINTAINERS.md` 기준 security review flag: host-key trust, data-key issuance/revocation, dashboard-session authorization, SSH subprocess/argv, management route exposure가 모두 auth boundary 또는 credential boundary를 변경하므로 명시적 security review가 필요하다.
- GUI screenshot은 이 PR에서 제공하지 않는다. GUI가 포함되면 PR template에 pr-assets branch 증거를 추가하고 screenshot을 branch 파일로 commit하지 않는다.

## Contract deviations

1. **K1/K2가 D18을 구체화한다.** D18의 dashboard consent 경계는 paired dashboard route에 적용한다. K1에 따라 `POST /api/link/issue`와 CLI의 status/revoke 경로는 admin-token + loopback을 사용하고, K2 응답은 `{linkId, apiKeyId, key, listenerPort}`로 고정한다.
2. **K13은 command exit만으로 connected를 결정하지 않는다.** remote command exit 0과 15초 내 첫 key-authenticated catalog lookup을 모두 관찰해야 하며, apply의 202 응답 뒤 K16 status polling으로 최종 상태를 확인한다.
3. **K14/K6 lifecycle.** `ensureStarted(): Promise<void>`는 single-flight이며, optional listener shutdown은 supervisor를 먼저 await한 뒤 listener를 닫는다. DELETE가 마지막 link를 제거하면 처리 끝에서 listener를 즉시 닫는다.
4. **K16이 wire DTO의 우선 규칙이다.** status/candidates/probe/confirm-host/apply는 위의 exact shape만 사용한다. GUI의 역할명이나 sidecar 필드는 이 문서에서 재정의하지 않으며, K11의 `hubHostKeyFingerprint`는 wp6 consumer가 따른다.
5. **선행 산출물 미존재.** 현재 dev worktree에는 wp1의 `src/link/`와 wp2의 `optional-listeners.ts`가 없다. 본 문서의 line anchors는 현재 존재하는 source에만 붙였고, 선행 파일은 `010`/`002` 계약 anchor로 표시했다. base 검증이 실패하면 wp4 파일 지도와 signatures를 실제 base에 맞춰 갱신해야 한다.

## 열린 질문

- client-initiated link에서 `LinkRecord.hostKeyFingerprint`를 어느 단계가 생성·확정하는가는 K3와 K11에 따라 wp6가 구현한다. wp4는 hub record의 `null` 허용과 client sidecar consumer를 깨지 않게 한다.
- remote `ocx link port`의 output schema에 `port` 외 `ocxVersion` 또는 protocol version을 포함할지는 wp3 구현 전에 별도 결정한다. wp4는 strict JSON `{port}`만 소비한다.

## 감사 반영 (Pauli FAIL r1)

- K1/K2/K12/K15에 맞춰 7개 route의 principal matrix, `/api/link/issue`, CLI `status`와 `revoke --link-id`를 추가했다.
- K16의 status/candidates/probe/confirm-host/apply DTO를 exact shape로 고정하고 route registry·lazy dispatch·negative test 범위를 명시했다.
- K13의 exit 0 + 15초 내 첫 key-authenticated catalog lookup 성공 조건을 apply와 테스트에 반영했다.
- K14/K6에 맞춰 `ensureStarted(): Promise<void>` single-flight, supervisor-first shutdown, 마지막 link 삭제 시 즉시 listener 종료를 추가했다.
- stale한 locale 수 표기를 현재 `gui/src/i18n/shared.ts:6-17`의 10개로 고쳤다. 003_decisions.md와 남은 계약 불일치는 없다.

## wp4 P 재검증 (아키텍트 Nash, gpt-6-sol high, 2026-09-25) — 이 절이 앞선 내용보다 우선한다

| ID | 제안 | 처분 |
|---|---|---|
| W4-1 | 원격 명령은 wp3의 `ocx connect --link --key-stdin --tunnel-port P --link-id ID`(src/cli/connect.ts:57-64,408-454) 그대로 | 유지 |
| W4-2 | 리스너 API는 `ensureStarted()`, `status()`, `close()`, `stop()`와 optional set의 `registerSupervisorStop()`(link-listener.ts:32-40, optional-listeners.ts:25-35,61-75). `closeIfUnused`는 없음 | 수용: 마지막 링크 삭제 후 store가 비었음을 확인하고 `close()` |
| W4-3 | supervisor는 인스턴스 하나. optional-listeners.start() 뒤 시작하고 같은 인스턴스를 관리 라우트에 넘기며, 종료 콜백은 종료 전에 등록(supervisor → listener 순서, optional-listeners.ts:69-75, index.ts:767-777) | 수용. index.ts는 893줄 이하 유지 |
| W4-4 | Tailscale 세션이 `gui-session`으로 합쳐짐(management-auth.ts:321-329,555-562; gui-session.ts:12-23,183-193). 루프백 여부는 Host가 아니라 입구로 판정해야 함 | 수용: 세션 발급 방식 `tailscale-identity`를 구분하는 술어를 추가해 링크 라우트에서 거부. `ManagementContext`에 serve-options가 아는 입구에서 파생한 `trustedLoopbackIngress: boolean`을 추가하고, 관리자 토큰 경로(issue, status, DELETE)는 이 값이 true일 때만 허용 |
| W4-5 | K13 관찰 지점 없음 | 수용: link-listener에 링크 키 id별 "첫 인증 요청" 관찰자(`awaitFirstAdmission(apiKeyId, timeoutMs)`)를 추가, 15초 제한 |
| W4-6 | K16 투영 필요 | 수용: 순수 함수 `projectLinkStatus(store, supervisorStates, listenerStatus, config)`. 역할은 `standalone`→standalone, 링크가 있는 standalone/hub→home, `client`+link transport→child. 문자열 캐스트 금지 |
| W4-7 | 키 발급 헬퍼 추출 시 이름 검증·저장 동작 유지, 실패 시 되돌림 | 수용: apply/remove의 각 단계 실패 시 발급한 키를 메모리와 저장소에서 모두 제거(보상 트랜잭션), 테스트로 고정 |
| W4-8 | ssh-keygen도 주입, 고아 정리는 정확한 argv 비교만 | 수용: `SshRunner`에 `fingerprint(tempFile)` 추가. Linux는 `/proc/<pid>/cmdline`(NUL 구분)로 정확 비교. macOS는 `ps -o command= -p <pid>` 결과가 argv를 공백으로 이은 문자열과 정확히 같고 어떤 argv 요소에도 공백이 없을 때만 일치로 본다. 그 밖에는 unverified로 두고 종료하지 않는다 |
| W4-9 | 크기 상한 확인, skill surface는 생성 명령으로 갱신 | 수용 |


### 반영 확인 (Nash MISALIGNED) — 위 표를 다음처럼 확정
- W4-3: `OptionalListenerSet`에 `linkSupervisor(): LinkSupervisor`(생성 시 한 번 만든 인스턴스를 돌려주는 접근자)를 추가한다. `ManagementApiDeps`에는 인스턴스가 아니라 게터 `linkSupervisor: () => optionalListeners.linkSupervisor()`를 넣어 생성 순서 문제를 없앤다. supervisor 시작과 종료 콜백 등록은 `optionalListeners.start()` 내부에서 한다. `src/server/index.ts`는 순증 0줄(기존 한 줄을 바꾸는 방식)이며 B 끝에 줄 수를 잰다.
- W4-4: `trustedLoopbackIngress`는 입구가 "unauthenticated-loopback"이거나, "public"이면서 바인드 주소가 루프백일 때만 true. "hub-management"(Tailscale Serve)와 "hub-link"는 false. 테스트: 네 입구 각각의 값.
- W4-5: `awaitFirstAdmission(apiKeyId, timeoutMs)`는 그 키로 인증된 `GET` 또는 `HEAD /v1/catalog`만 관찰한다.
- W4-6: 근거: D1에 따라 링크를 여는 기계의 runtimeRole을 바꾸지 않으므로 "home"은 역할이 아니라 링크 보유로 정의한다. 투영: runtimeRole `client`(transport 무관) → child, 그 밖에 store에 링크가 하나 이상 → home, 나머지 → standalone.
- W4-7: 보상은 apply에서 새로 발급한 키에만 적용한다. DELETE 순서: 터널 중지 → 원격 `ocx disconnect` → 성공하면 키 회수 → 레코드 삭제 → 링크가 없으면 `close()`. 원격 해제가 실패하면 레코드와 키를 유지하고 502 `{error:{code:"remote_disconnect_failed"}}`를 돌려준다. 요청 본문 `{force:true}`일 때만 원격 단계를 건너뛰고 회수·삭제한다(UI는 이 경우 따로 확인).
- W4-8: macOS는 항상 unverified로 두고 종료하지 않는다(ps 문자열은 정확한 argv 증명이 아님). 정상 종료·드레인 재시작 시 supervisor 종료 콜백이 자식 ssh를 SIGTERM 후 대기로 정리하므로 고아는 비정상 종료에서만 남는다. 그 경우 새 터널은 failed{forward}가 되고 status reason에 "stale tunnel may hold the port"를 싣는다. Linux는 /proc cmdline 정확 비교 후에만 종료.
- W4-9: 040 본문의 "`src/link/` 없음" 서술(:391, :416 부근)은 wp1-wp3 커밋 이후 무효.

## 감사 반영 (Hume FAIL r1, wp4 계획 감사) — 이 절이 앞선 모든 내용보다 우선한다

1. 테스트 이름: 서버 라우트 테스트는 `tests/server/link-management-routes.test.ts`로 하고 layout.json explicit와 test-layout-expected.json에 `"link-management-routes.test.ts": "server"`로 등록한다. 기존 `tests/clients/link-routes.test.ts`와 겹치지 않는다. 다른 새 테스트도 같은 방식으로 basename 전역 충돌을 확인한다(`rg -n '"<basename>"' scripts/test-layout/layout.json`이 비어 있어야 함).
2. 입구 배선: `handleManagementAPI(req, url, ..., requestIngress: ManagementRequestIngress = { trustedLoopback: false })` 형태로 요청별 입구 정보를 추가한다(`src/server/management-api.ts:187-194,276`). `serve-options.ts`의 관리 API 호출 지점(:655-683)이 `ingressForServer(requestServer)`와 바인드 주소로 `trustedLoopback`을 계산해 넘긴다(W4-4 규칙). `ManagementContext`에 `trustedLoopbackIngress: boolean` 필드를 추가하고 link 라우트만 읽는다. 직접 호출 테스트는 기본값 false. 테스트: public(루프백 바인드)·unauthenticated-loopback은 관리자 토큰으로 issue/status/DELETE 허용, hub-management(Tailscale Serve)·hub-link는 관리자 토큰이어도 403, Tailscale 신원 세션은 모든 link 라우트 403.
3. K13 관찰 훅: `LinkListenerLifecycle`에 `onAuthenticatedCatalog(listener: (apiKeyId: string) => void): () => void`(구독 해제 함수 반환)를 추가하고 `OptionalListenerSet`이 그대로 노출한다. `serve-options.ts`에서 ingress가 hub-link이고, 조기 인증 게이트가 성공했고, 경로가 정확히 `/v1/catalog`, 메서드가 GET 또는 HEAD일 때만, 인증 결과의 keyId로 알린다. `awaitFirstAdmission(apiKeyId, timeoutMs)`는 이 훅 위의 헬퍼(`src/link/admission-wait.ts`)로, apply가 원격 connect 명령을 시작하기 전에 구독한다. 테스트: 실제 링크 리스너에서 올바른 키 GET /v1/catalog → 해결, 다른 키 → 미해결, /v1/models → 미해결, 15초 제한은 주입 시계로 → timeout 오류.
4. 지문 명령: `src/link/ssh-argv.ts`에 `buildFingerprintArgv(tempKnownHostsFile: string): string[]` → `["ssh-keygen", "-l", "-f", <abs path>]`(optionPath와 같은 경로 검증)을 추가. `SshRunner` 계약은 `run(argv, { stdin?, timeoutMs, maxOutputBytes })`, `spawnTunnel(argv)` 두 개이고, 지문은 `run(buildFingerprintArgv(...))`로 실행한다(별도 메서드 없음, 앞 절의 `fingerprint()` 표기 폐기). 기본 구현은 `Bun.spawn(argv)`(셸 없음), 출력 64 KiB 상한. 출력 파싱은 순수 함수 `parseFingerprintLine(stdout)`가 `<bits> <SHA256:...> <alias> (<TYPE>)` 한 줄만 받는다. 테스트: 정확한 argv, 여러 줄·빈 출력·형식 불일치 거부.
5. 비차단 반영: pending 호스트 타입은 `{alias, fingerprint, keyType, probedAt}`만 갖고, `ocxVersion`은 confirm-host 이후의 `ConfirmedHost`에만 있다. 검증 표에 `bun run structure:check`, `bun run skill:surface:check`를 명시한다. 공개 CLI 문서는 wp5(docs-site)에서 다루며 이 PR 설명에 후속으로 적는다.

## 감사 반영 (Hume FAIL r2)

1. Tailscale 구분: `src/server/management-auth.ts`에 `managementSessionIssuance(req, managementAuth): GuiSessionIssuance | null`을 추가한다(요청이 제시한 GUI 세션 토큰의 레코드 `issuance`, 세션이 아니면 null; src/server/gui-session.ts:22,146,154의 필드). `ManagementContext`에 `guiSessionIssuance: GuiSessionIssuance | null`을 넣고, 모든 link 라우트는 권한 분기 전에 `guiSessionIssuance === "tailscale-identity"`이면 403 `{error:{code:"tailscale_session_refused"}}`를 돌려준다. 테스트: 7개 link 라우트 각각에 대해 Tailscale 신원 세션 403, 루프백 페어링 세션은 대시보드 라우트 허용.
2. 테스트 이름 참조는 문서 전체에서 `tests/server/link-management-routes.test.ts` / `"link-management-routes.test.ts"`로 통일했다.
3. 비차단: `buildFingerprintArgv`는 경로를 따옴표 없이 argv 한 요소로 그대로 넘긴다(절대 경로·제어 문자 없음만 검증, `optionPath`의 공백 인용은 `ssh -o` 전용). 필드 체인 표의 pending host에서 `ocxVersion`을 제거했다.
