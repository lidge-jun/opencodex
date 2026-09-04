# OpenCodex Remote Workspace 기획서

- 상태: private dogfood 구현 완료; runtime/CLI/GUI 연결 및 Hub-Executor 실제 통합 검증, 출시 전 검토 대기
- 대상 브랜치: `improved-remote-control`
- 기준 `dev`: `04879bc88`
- 범위: 사용자 소유 메인 OCX를 통한 다중 기기 제어와 원격 Codex 실행
- 제외: Super Sync, 유료 VPS, 원격 데스크톱, production 배포

## 1. 한 줄 정의

컴1의 OpenCodex가 웹 GUI, Codex 로그인, Codex App Server와 세션 기록을 소유하고,
컴2의 최소 OCX Executor가 파일 및 명령을 실제로 실행하게 한다. 컴3의 브라우저는 컴1
GUI에 접속해 컴2를 선택하고 그 세션을 조작한다.

```text
컴3 Browser
  | HTTPS/WSS: GUI, prompt, approvals, streamed session events
  v
컴1 Main OCX
  |-- Web GUI + account/device control plane
  |-- Codex credentials + isolated Codex App Server pool
  |-- bounded relay
  |
  | E2EE remote execution channel
  v
컴2 OCX Executor
  |-- allowed workspace roots
  |-- capability-filtered remote tool endpoint
  `-- shell, file operations, patch application, process lifecycle
```

사용자 관점에서는 Codex가 컴2에서 실행되는 것처럼 보인다. 실제 프로세스 경계는 다음처럼
나뉜다.

- 대화, 모델 호출, 계정 인증, 세션 기록: 컴1
- 파일 읽기/수정, 명령, 테스트, 로컬 프로세스: 컴2
- 화면, 입력, 승인: 컴3
- 암호문과 세션 라우팅: 컴1 relay

컴2에는 ChatGPT 로그인, OpenAI API key, Codex binary, Codex 세션 저장소가 없어야 한다. 컴1의
실제 Codex App Server는 격리된 Code Mode에서 Remote Workspace MCP만 호출하고, App Server client
역할의 OCX가 그 요청을 컴2의 OCX-native Executor로 전달한다.

## 2. 해결하려는 사용 사례

### 2.1 컴3에서 컴2를 조작

1. 컴1이 `ocx gui`를 안전한 HTTPS 주소로 제공한다.
2. 실행 대상인 컴2는 OCX 기기로 컴1에 등록한다. 컴3이 브라우저 controller 역할만 한다면 OCX를
   따로 실행할 필요가 없다.
3. 컴3 사용자가 브라우저에서 컴1 GUI에 로그인한다.
4. Devices에서 컴2를 선택한다.
5. 컴2의 terminal 또는 Remote Codex Workspace를 연다.
6. 컴1은 세션 권한을 검사하고 컴3과 컴2, 또는 컴1 Codex와 컴2 Executor를 연결한다.

컴3이 Executor로도 등록돼 있더라도 현재 선택한 실행 대상은 컴2다. `browser/controller`와
`executor device` 역할은 컴퓨터 자체가 아니라 세션마다 분리한다.

### 2.2 컴2에 Codex가 없어도 컴2에서 작업

1. 컴3이 컴1 GUI에서 컴2와 workspace root를 선택한다.
2. 컴1의 Runtime Supervisor가 격리된 Codex App Server process를 시작하거나 pool을 재사용한다.
3. App Server는 컴1의 Codex 자격증명을 사용한다.
4. thread는 `executorDeviceId=컴2`와 `rootId`에 고정되고 capability별 remote tools만 등록한다.
5. App Server의 격리된 `functions.exec`가 허용된 Remote Workspace MCP를 호출하면 컴1 OCX가 이를
   컴2 Executor로 전달한다.
6. 컴2가 파일과 명령 도구를 실행하고 결과만 컴1 Codex에 돌려준다.
7. 결과와 승인은 컴1 GUI를 통해 컴3에 streaming된다.

컴2가 offline이면 컴1 로컬 실행으로 fallback하지 않는다. 세션을 `waiting_for_executor`로
멈춰야 한다. 조용한 local fallback은 컴1 파일을 잘못 수정할 수 있으므로 금지한다.

### 2.3 컴2 터미널만 직접 사용

Codex 없이 shell만 필요하면 Browser와 컴2 Executor가 기존 프로토타입의 E2EE terminal
channel을 사용한다. 컴1 relay는 terminal plaintext를 해독하지 않는다.

## 3. 제품 역할

| 역할 | 기본 위치 | 책임 |
| --- | --- | --- |
| Main Coordinator | 컴1 | GUI, 로그인, 기기/세션 권한, Codex credentials, session storage, runtime supervision |
| Controller | 컴3 browser | 기기 선택, prompt 입력, terminal input, 승인, 진행 확인 |
| Executor | 컴2 OCX | 허용된 workspace의 file/shell/process/PTY 실행 |
| Opaque relay | 컴1 | device/session routing, bounds, backpressure, presence |
| Codex App Server | 컴1 | 실제 Codex thread/turn/model lifecycle |
| Dynamic tool dispatcher | 컴1과 컴2 사이 | App Server의 client-executed tool call을 선택된 Executor에 고정 |

한 컴퓨터가 여러 역할을 가질 수 있다. 예를 들어 컴3은 browser controller인 동시에 나중에
다른 세션의 executor가 될 수 있다. 그러나 한 세션의 `controllerDeviceId`, `coordinatorId`,
`executorDeviceId`는 명시적으로 분리해 기록한다.

## 4. 기존 OpenCodex 기능과의 관계

### Remote Hub

기존 Remote Hub는 서브컴의 Codex/Claude 요청을 컴1 provider gateway로 라우팅한다. 자격증명을
복사하지 않고 컴1에서 provider 요청을 실행한다. Remote Workspace는 이를 대체하지 않는다.

### Remote Control prototype

현재 브랜치의 `src/remote-control/`은 다음을 이미 증명한다.

- account/device 상호 서명
- session별 ECDH 및 방향별 AES-GCM key
- replay/order 검증
- opaque relay frame
- terminal session과 buffer limit
- 첫 authenticated application frame 이후 local terminal 생성

이 토대는 device enrollment 이후 Browser-to-Executor terminal channel과
Coordinator-to-Executor dynamic tool channel에 공통으로 사용한다. Phase 0에는 추가로
`workspace-tools`, `workspace-coordinator`, `workspace-executor`가 들어갔다.

### Super Sync

API key, OAuth token, provider 계정을 다른 컴퓨터로 복제하는 Super Sync는 이 계획에 포함하지
않는다. Remote Workspace에서는 provider credentials가 컴1을 떠나지 않는다.

## 5. 실제 Codex 통합 전략

공식 OpenAI의 [Codex App Server 문서](https://learn.chatgpt.com/docs/app-server)에 따르면
현재 Codex는 App Server thread별 permission profile과 MCP 설정을 받고, MCP tool은 격리된
`functions.exec` Code Mode를 통해 호출한다. 이 경로가 컴2에 Codex를 두지 않는 Remote Workspace의
기준이다.

- `codex app-server --listen ...`: 컴1 OCX가 thread와 turn을 제어하는 JSON-RPC transport
- `thread/start` / `thread/resume`: remote workspace 전용 permission profile과 MCP 등록
- `functions.exec`: 다른 Hub 도구 없이 `mcp__ocx_remote_workspace__*`만 호출
- MCP response: 컴2 결과를 Codex의 다음 model request에 연결

thread ID를 기준으로 컴2/컴3 binding을 찾을 수 있으므로 여러 executor thread가 작은 App Server
pool을 공유할 수 있다. 다른 executor로 조용히 fallback하는 것은 허용하지 않는다.

```text
컴1 Runtime Supervisor
  |-- isolated app-server A -> thread 1 -> 컴2 binding
  |                         `-> thread 2 -> 컴3 binding
  `-- isolated app-server B -> capacity/failure isolation
```

각 remote thread는 생성 시 `executorDeviceId`, `rootId`, App Server writer identity를 함께 저장한다.
다른 기기로 thread를 resume하는 동작은 기본적으로 거부하고, 명시적인 `fork to another device`만
새 thread로 허용한다.

### 5.1 선택 경로: App Server와 제한된 Remote Workspace MCP

컴1이 자체 Codex login을 사용하면 App Server가 컴1의 Codex credential을 읽고, OCX provider
route를 사용하면 provider credential은 컴1 OCX Hub가 소유한다. 두 경우 모두 credential은 컴1을
떠나지 않는다. remote thread에는 `ocx_remote_workspace` MCP만 등록한다. Codex가 격리된 Code
Mode에서 이 namespace를 호출하면 컴1 OCX가 E2EE transport로 컴2 Executor에 전달한다.

현재 local compatibility spike가 다음을 확인했다.

1. Codex `0.152.1` App Server가 thread permission profile과 required HTTP MCP를 적용한다.
2. 실제 Codex App Server의 `functions.exec`가 `mcp__ocx_remote_workspace__exec`를 호출한다.
3. 컴1 OCX coordinator가 그 request를 session별 E2EE RPC로 선택된 컴2 fixture에 전달한다.
4. command output이 function-call output으로 Codex의 다음 model request에 들어간다.
5. 컴2 canary만 변경되고 같은 이름의 컴1 canary는 바뀌지 않는다.
6. offline, unbound thread, wrong namespace는 local fallback 없이 실패한다.

App Server client protocol은 계속 버전 호환 검사가 필요하다. 또한 developer instruction만으로
built-in local tool을 막았다고 간주하지 않으므로, 컴1 App Server thread에는 명시적인 deny-local
permission profile, 비어 있는 coordinator root, 제한된 shell environment와 단 하나의 required MCP를
동시에 적용한다. 현재 Linux 통합 검증은 같은 이름의 컴1 canary를 읽거나 수정하지 못하고 컴2
canary만 변경함을 증명한다. 이 permission-profile 호환성을 확인할 수 없으면 runtime을 활성화하지
않는다.

### 5.2 제외한 경로: remote Code Mode host

`--code-mode-host`도 실제로 조사했지만 이는 Code Mode JavaScript runtime을 원격화한다. Code Mode
안에서 호출하는 nested shell/file tool은 App Server로 다시 delegate될 수 있어, 이 옵션만으로
컴2 filesystem과 process 실행을 보장할 수 없다. Remote Workspace의 실행 경계로 사용하지 않는다.

prompt 지시만으로 remote tool 사용을 유도하는 방식도 같은 이유로 사용하지 않는다. App Server
permission profile, required MCP allowlist와 OS-level coordinator isolation을 함께 사용한다.

## 6. 연결 구조

### 6.1 컴1 공개 경로

컴1은 public port를 열지 않고 Cloudflare Tunnel 또는 동등한 outbound tunnel로 GUI와 WebSocket
upgrade를 제공한다. TLS edge와 E2EE endpoint를 구분한다.

- Cloudflare: public TLS, hostname, rate limit, WebSocket 전달
- 컴1 control plane: 사용자/기기/session authorization
- Browser와 컴2 또는 컴1과 컴2: application E2EE

Cloudflare나 relay compromise만으로 terminal command를 만들거나 plaintext를 읽을 수 없어야 한다.

### 6.2 컴2 연결

컴2 OCX Executor는 컴1에 outbound WSS 한 개를 유지한다. inbound listener, 공유기 port forwarding,
root 권한은 요구하지 않는다. 한 socket에서 control, dynamic tool, terminal channel을 session ID로
multiplex하되 channel별 key와 counter를 분리한다.

### 6.3 direct transport

LAN/Tailscale direct 연결을 선택해도 같은 endpoint protocol과 identity key를 사용한다. transport가
relay를 우회하더라도 인증이나 capability 검사가 약해지면 안 된다.

## 7. 인증과 암호화

### 7.1 사용자 인증

- GitHub login은 계정 소유권만 증명한다.
- 별도 E2EE password는 account vault를 browser에서 unlock한다.
- GitHub OAuth token은 장기 provider credential처럼 저장하지 않는다.
- browser session과 device authority는 별도 revoke 대상이다.

### 7.2 기기 등록

1. 컴1 GUI가 짧은 수명의 one-time pairing grant를 만든다.
2. 컴2가 local OCX GUI/CLI에서 grant를 입력한다.
3. 컴2가 device signing key를 local owner-only storage에 생성한다.
4. 컴1은 device public key, 이름, OS, capabilities만 저장한다.
5. pairing grant는 한 번 사용하면 폐기한다.

### 7.3 세션 암호화

- account signing key가 Browser/Coordinator hello를 서명
- device signing key가 Executor hello를 서명
- session별 ephemeral P-256 ECDH
- HKDF domain separation으로 방향 및 channel key 분리
- AES-256-GCM과 monotonically increasing counter
- session/device/profile/capability binding

Direct terminal mode에서 컴1은 ciphertext만 본다. Remote Codex Workspace mode에서는 컴1이 Codex
endpoint이므로 prompt, model output과 tool request를 볼 수 있다. 이 차이를 UI와 문서에서 숨기지
않는다. 향후 제3자 hosted 컴1 서비스를 만들 때는 별도의 trust model이 필요하다.

## 8. 권한과 workspace 경계

컴2 등록만으로 전체 filesystem 접근을 주지 않는다. 사용자가 컴2에서 명시적으로 승인한
workspace root만 노출한다.

- canonical path 기준 root allowlist
- symlink/junction/reparse point escape 거부
- 각 session은 한 executor와 root set에 고정
- read/write/exec/network 권한 분리
- 승인 요청에 실제 컴2 hostname, cwd, command, target path 표시
- write와 destructive command는 기본 prompt
- output, file, request body, concurrent process에 상한 적용
- secret-looking file과 OS credential store는 기본 제외

`thread/shellCommand`, App Server `fs/*`, `command/exec`, `process/spawn`처럼 컴1에서 실행될 수 있는
API는 remote thread GUI에서 그대로 노출하지 않는다. compatibility spike로 컴2 실행이 증명된
method만 allowlist한다.

## 9. 세션 모델

```text
RemoteWorkspaceSession
  id
  ownerAccountId
  controllerDeviceId?       # browser-only이면 null 가능
  coordinatorInstallationId # 컴1
  executorDeviceId          # 컴2
  appServerInstanceId       # 컴1 isolated process/pool writer
  codexThreadId             # 컴1 저장
  rootId                    # 컴2가 승인한 workspace root
  workspaceRoots[]          # 컴2 native paths
  state                     # starting/ready/running/waiting/offline/closed
  createdAt / lastActiveAt
```

한 Codex thread에 동시에 두 App Server writer를 붙이지 않는다. Browser disconnect는 현재 turn을
자동 kill하지 않지만 approval은 timeout된다. 컴2 disconnect는 tool execution을 중단하고 session을
`waiting_for_executor`로 둔다. 같은 device key가 다시 연결되면 명시적인 resume 확인 후 계속한다.

## 10. GUI 기획

컴1 `ocx gui`에 Remote Workspace를 추가한다.

### Devices

- 기기명, OS, online/offline, last seen
- 역할/capabilities
- 승인된 workspace roots
- active sessions
- key rotate/revoke
- 새 기기 pairing

### Sessions

- `Codex runs on: Main OCX (컴1)`
- `Tools run on: 컴2`
- 현재 cwd와 workspace roots
- model/account는 secret 없이 label만 표시
- session state와 reconnect 상태
- open terminal, new Codex, resume, fork, stop

기기를 선택하지 않은 상태에서는 remote session을 만들 수 없다. 컴2가 offline이거나 remote tool
protocol compatibility가 다르면 실행 버튼을 비활성화하고 정확한 이유를 표시한다.

## 11. 서버 부하 원칙

- 빌드, 테스트, shell, file I/O는 선택된 Executor에서만 실행한다. 컴3이 browser controller로만
  참여하면 컴3의 CPU는 작업 실행에 쓰이지 않는다.
- account당 작은 isolated App Server pool을 사용하고 thread ID로 executor를 dispatch한다.
- 한 thread의 active writer는 정확히 한 process만 소유한다.
- idle process는 grace period 후 종료하고 persisted thread는 유지한다.
- relay는 frame마다 DB query나 plaintext logging을 하지 않는다.
- presence와 session table은 연결/해제 경계에서만 갱신한다.
- per-device session/process/frame/buffer limit을 둔다.
- output burst는 짧게 coalesce하되 interactive echo를 지연시키지 않는다.

향후 컴1만 우리 서버로 대체하면 `hosted coordinator` 상품이다. 빌드 컴퓨트까지 판매하려면
별도의 `hosted executor` VM/workspace를 함께 제공해야 한다. 우리 서버가 coordinator/Codex를
실행하는 모드에서는 실행 중 prompt가 tool result를 보지 못하는 `server-blind E2EE`라고 표현하지
않는다. 이 모드의 보안 목표는 전송 구간 암호화, 보관 시 암호화, 분리된 runtime과 명시적
unlock이다.

## 12. 장애 동작

| 장애 | 동작 |
| --- | --- |
| 컴3 browser disconnect | turn은 계속될 수 있고 재접속 시 event snapshot/resume |
| 컴2 disconnect | remote tool 중단, session 대기, local fallback 금지 |
| 컴1 restart | persisted thread 복구 후 동일 device 재연결 대기 |
| device key revoke | 해당 device socket과 session 즉시 종료 |
| relay overload | bounded close와 jittered reconnect, 무제한 queue 금지 |
| protocol mismatch | 실행 전 차단하고 필요한 OCX/Codex version 표시 |
| approval timeout | 해당 tool 거부, turn 상태 명시 |
| selected root removed | fail closed, 상위 directory로 자동 확대 금지 |

## 13. 구현 단계

### Phase 0 — 기획 및 Codex compatibility spike

- 이 문서 리뷰
- [x] current Codex-generated experimental schema 확인
- [x] actual App Server + local mock model + 컴2 Executor harness
- [x] dynamic `exec` request/response round trip
- [x] 컴1/컴2 file negative canary
- [x] offline/unbound/namespace mismatch fail-closed unit test
- [x] App Server OS sandbox proof
- [x] E2EE transport binding
- [x] WebSocket relay adapter and reconnect
- [x] session-scoped read/write consent and protocol mismatch integration test

종료 조건: 실제 upstream Codex가 제한된 Remote Workspace MCP를 통해 컴2에서 도구를 실행하고, built-in local
tools가 컴1 사용자 filesystem을 볼 수 없는 OS sandbox가 증명된다.

### Phase 1 — 공통 protocol 정리

- [x] 기존 prototype frame/crypto/relay review
- [x] transport-neutral connection interface
- [x] channel multiplexing과 capability manifest
- [x] replay, ownership, backpressure, reconnect tests
- [x] core runtime import graph와 완전 분리

### Phase 2 — 컴2 Executor

- [x] owner-user process
- [x] workspace root admission
- [x] OCX-native dynamic tool executor
- [x] command/process cancellation
- [x] Linux/macOS/Windows Hub CLI 실행/종료 lifecycle abstraction (`.cmd` 및 Windows process tree 포함)
- [x] Executor command sandbox 구현 (Linux bubblewrap, Windows AppContainer+Job; macOS file-only)
- [x] hosted Linux/Windows confinement과 macOS direct-run fail-closed CI
- [ ] exact signed Windows release binary에서 native confinement probe 통과
- [ ] signed background-agent artifact/update policy (현재 foreground agent는 자동 재연결)

### Phase 3 — 컴1 Coordinator

- [x] device registry와 one-time pairing
- [x] outbound relay admission
- [x] isolated App Server와 단일 writer ownership
- [x] thread/device binding persistence
- [x] session-scoped access grant와 session recovery

### Phase 4 — 컴1 GUI와 컴3 browser flow

- [x] Devices/Sessions screens
- [ ] GitHub login과 E2EE vault unlock (현재는 기존 OCX GUI session/HTTPS identity 사용)
- [x] 컴2 선택 후 Codex/Claude Code/Pi start
- [x] reconnect, access mode, revoke UX
- [ ] 실제 브라우저 screenshot/accessibility 검증 (Happy DOM interaction, i18n, Vite build는 완료)

### Phase 5 — private dogfood

- 컴1, 컴2, 컴3 실제 분리
- 컴2에 ChatGPT/API credential 없음 확인
- 컴3에서 컴1 GUI로 컴2 canary project 수정
- disconnect/restart/rotation/revocation
- CPU/RAM/relay bandwidth 측정
- production feature flag는 계속 off

## 14. 필수 인수 테스트

1. 컴2에는 ChatGPT session, OpenAI API key, Codex thread history가 없다.
2. 컴3에서 컴1 GUI를 열어 컴2를 선택한다.
3. 새 Codex thread는 컴1에 생성된다.
4. `pwd`, shell, read, patch 결과는 컴2 경로와 프로세스를 증명한다.
5. 컴2 canary file은 변경되고 같은 이름의 컴1 canary는 변경되지 않는다.
6. 모델 요청은 컴1의 OpenCodex/provider credential 경로를 사용한다.
7. 컴2 연결을 끊으면 다음 tool이 fail closed하고 컴1에서 실행되지 않는다.
8. 컴2 reconnect 후 같은 device identity를 확인해야 resume할 수 있다.
9. 컴3 browser를 닫았다 열어도 session ownership과 event ordering이 유지된다.
10. 컴3 자체도 executor로 등록 가능하지만 컴2 session의 실행 대상은 바뀌지 않는다.
11. relay log와 DB에는 terminal plaintext, provider token, E2EE private key가 없다.
12. unsupported Codex/Executor protocol 조합은 작업 시작 전에 거부된다.
13. capability presence acknowledgement 전에는 새 WSS가 online으로 표시되지 않는다.
14. 시작 중 Stop/revoke와 긴 turn의 Stop은 뒤늦은 `ready` 상태나 남은 command process를 만들지 않는다.

## 15. 출시 차단 조건

- 검증되지 않은 App Server/MCP protocol 조합을 stable 기능으로 노출
- 컴1 App Server OS sandbox가 없거나 실제 컴1 filesystem을 읽을 수 있음
- remote thread가 컴1 local tools로 fallback 가능
- 컴2 root escape 또는 device/session identity confusion
- browser/Executor E2EE interop 미검증
- 지원되는 Windows/Linux command lifecycle 또는 PTY cleanup 미검증
- config 또는 credentials가 컴2로 복제됨
- real three-computer acceptance 미완료

## 16. 현재 판단

기술적으로 가능하고 실제 local integration에서 핵심 round trip을 확인했다. 실제 Codex App Server는
컴1에 있고 컴2에는 Codex가 없지만, namespaced MCP 요청이 OCX coordinator와 E2EE RPC를
거쳐 컴2 Executor에서 실행됐으며 결과가 다음 model request로 돌아갔다.

Linux private dogfood의 양쪽 실행 경계는 구현됐다. 컴1 Codex에는 deny-local permission profile과
비어 있는 coordinator root를 적용하고, 컴2 `exec`는 bubblewrap이 실제로 실행 가능할 때만 광고한다.
현재 OCX Bun runtime은 실행 파일 하나만 read-only로 자동 노출되고 추가 Node/Rust/Go 경로는 컴2
소유자가 pairing 때 명시해야 한다. command runner가 없거나 capability acknowledgement가 끝나지
않으면 실행은 fail closed한다.

Windows command sandbox는 좁은 Rust helper로 구현했다. capability 없는 AppContainer를 suspended
상태로 만들고 첫 instruction 전에 Job Object에 붙인 뒤 resume한다. 실제 workspace 쓰기는 성공하고
인접 파일 read/write와 live loopback 연결은 실패해야만 exec capability를 광고한다. helper binary는
pairing 때 SHA-256을 고정하고 command마다 다시 확인한다. macOS는 모든 descendant를 회수할 좁은
native owner가 아직 없고 넓은 Seatbelt system profile import는 host service 권한을 늘리므로, 현재
helper가 probe와 direct run을 모두 거부해 file-only로 fail closed한다.

남은 blocker는 핵심 데이터 흐름의 미구현이 아니라 출시 공정이다. signed Windows helper 설치와
업데이트, exact release binary native CI, macOS의 revocable descendant containment, 선택한 public HTTPS
identity, 독립 maintainer review, current `dev` rebase와 실제 세 대의 컴퓨터 acceptance를 끝내기 전에는
stable 기능으로 표시하지 않는다.

## 17. 최종 Windows / macOS / Linux 감사

- Windows Hub: npm `codex.cmd`, `claude.cmd`, `pi.cmd`를 PATHEXT로 찾고 안전하게 이스케이프된
  `ComSpec`으로 실행한다. Stop은 신뢰된 System32 `taskkill /T /F`로 OCX가 띄운 wrapper tree만
  종료하며, 임시 폴더 삭제는 AV/indexer의 짧은 lock을 bounded retry한다.
- macOS Hub: 실행 argv를 shell 없이 그대로 유지하고 deny-local profile에는 macOS 최소 PATH를 쓴다.
- macOS Executor: file tools만 광고한다. unprivileged Job Object/cgroup 동등물이 없고 fork된 자식은
  `setsid()`로 process group을 벗어날 수 있다. 넓은 Apple system profile을 import해 command를 억지로
  시작하지 않고 helper의 probe/direct run 양쪽을 거부하므로, deadline/cancel 뒤 남는 writer도 없다.
- Windows Executor: 고유 AppContainer SID에 workspace modify와 toolchain read/execute ACL만 임시로
  부여한다. non-breakaway kill-on-close Job을 primary thread가 suspended인 동안 붙이고
  stdin/stdout/stderr 세 handle만 명시적으로 상속하며, command가 끝나면 Job, SID profile, ACL을
  정리한다. writable profile environment는 workspace-owned temporary directory만 가리킨다.
- Linux Hub/Executor: Hub argv는 shell 없이 유지한다. Executor는 `bwrap` 파일 존재가 아니라 실제
  PID/IPC/UTS/network namespace probe가 성공할 때만 `workspace.exec`를 광고한다.
- 모든 Executor: 한 기기의 file/exec 작업을 직렬화하고, 열린 파일 descriptor와 현재 path identity를
  I/O 전후 비교하며, write hash를 atomic replace 직전에 다시 확인한다. 승인된 root filesystem
  identity를 고정하고 toolchain root는 command마다 symlink 여부를 다시 확인한다. hardlink는 다른
  path의 동일 inode를 path sandbox가 구분할 수 없으므로 file read/write에서 거부하고, command 전에는
  최대 250,000개 entry를 검사해 multi-link 항목이 있으면 exec를 fail closed한다.
- 재연결 capability는 페어링 당시 grant와 현재 OS sandbox 지원의 교집합만 광고한다. sandbox가
  사라지면 권한을 줄일 수 있지만, 재연결만으로 사용자가 승인하지 않은 exec 권한을 늘리지 않는다.
- Windows 파일 경계: `NUL`, `CON`, `COM1` 같은 device 이름, NTFS ADS, trailing dot/space alias를
  거부한다. junction/symlink와 parent escape는 기존 canonical boundary에서 계속 차단한다.
- GUI: 파일 전용 기기는 `Edit files only`로 표시하고, pairing 명령은 Linux/macOS와 Windows
  PowerShell을 따로 제공한다.
- 연결 종료: 아직 열리지 않은 WebSocket의 `close()`가 OS/runtime별로 throw해도 agent stop이
  자체적으로 settle되어 reconnect loop나 종료를 붙잡지 않는다. Linux/macOS CLI는 SIGTERM grace
  뒤에도 남아 있으면 해당 자식에만 SIGKILL을 보내 Hub session 밖으로 고아가 되지 않게 한다.

일부 Linux VM/컨테이너는 외부 실행 환경의 network namespace 제한 때문에 bubblewrap 실제 probe가
실패한다. 그런 장비에서는 `workspace.exec`가 의도대로 광고되지 않고 파일 도구만 제공된다. 이는 기능
실패를 숨기는 fallback이 아니라 capability fail-closed 동작이다. PR CI의 별도 Ubuntu hosted lane은
bubblewrap을 명시적으로 설치하고 production runner/Bun mount, workspace write, adjacent read/write와
hardlink denial, live loopback denial, cancel 뒤 detached child 미생존을 실행 증명한다. 실제 Windows
confinement probe, macOS file-only fail-closed probe와 3-computer acceptance까지 통과하기 전에는 세 OS
production-ready라고 주장하지 않는다.

[Decision Log]
- 목적과 의도: 세 OS에서 지원되는 기능만 정확히 광고하면서 Hub CLI와 Executor 파일 경계가 OS별
  launcher, path, lock, shutdown 차이 때문에 깨지지 않게 한다.
- 기존 구현 및 제약 조건: Windows npm shim은 직접 spawn할 수 없고 child kill만으로 Node가 남는다.
  Windows 파일 이름은 POSIX와 다른 alias/device 규칙이 있으며, bwrap 설치 여부는 namespace 권한을
  증명하지 않는다.
- 검토한 주요 대안: `shell: true`, OS 차이를 문서로만 경고, bwrap 존재 검사 유지, Job Object만 사용,
  Docker/Podman을 필수화, 병렬 file/exec, 모든 OS에서 command 기능을 강제로 노출.
- 선택한 방식: Hub에는 검증된 Windows launcher/taskkill/atomic-replace primitives를 재사용한다.
  Executor에는 Linux isolation probe와 좁은 Rust Seatbelt/AppContainer helper, 직렬화/descriptor
  identity 확인을 적용한다.
- 다른 대안 대신 이 방식을 선택한 이유: 지원되지 않는 실행을 성공처럼 보이지 않게 하면서 shell
  injection과 orphan process, path-swap 경합을 동시에 줄인다.
- 장점, 단점 및 영향: 세 OS 모두 동일한 capability 계약을 사용하며 native sandbox/probe가 실패한
  호스트만 파일 전용으로 남는다. 실제 native OS 검증과 signed artifact 배포는 branch-level
  cross-target 검증과 별도로 남는다.

[Decision Log]
- 목적과 의도: 컴2에 Codex 설치나 로그인이 없어도 컴1의 실제 Codex 세션이 컴2의 파일과 명령을
  안전하게 다루고, 컴3에서 컴1 GUI를 통해 그 세션을 조작하게 한다.
- 기존 구현 및 제약 조건: 기존 Remote Hub는 provider 요청만 중앙화하고 terminal/filesystem을
  원격화하지 않는다. 기존 remote-control prototype은 E2EE terminal/relay 경계만 증명했으며, 이번
  작업에서 실제 Codex App Server, runtime/GUI와 E2EE device transport를 하나의 흐름으로 연결했다.
- 검토한 주요 대안: 컴2에 전체 Codex 설치와 로그인, 컴1 filesystem에 컴2를 mount, prompt 지시만으로
  remote tools 사용 강제, 제한된 App Server MCP, official remote Code Mode host.
- 선택한 방식: 컴1의 isolated actual Codex App Server에 제한된 Remote Workspace MCP를 등록하고, OCX
  coordinator가 thread-device-root binding에 따라 컴2 OCX-native Executor로 dispatch한다.
- 다른 대안 대신 이 방식을 선택한 이유: 사용자 자격증명을 컴2로 복사하지 않으면서 실제 upstream
  Codex thread/turn/history를 유지하면서 컴2에 Codex를 두지 않고, tool call마다 device binding을
  검증할 수 있다. prompt-only MCP, mount, remote Code Mode host는 local execution 혼동을 막지 못한다.
- 장점, 단점 및 영향: 정확히 요청한 컴1-Codex/컴2-execution/컴3-control UX를 제공할 수 있다.
  대신 App Server/MCP protocol 추적, 컴1/컴2 양쪽 OS sandbox, E2EE transport, 3개 OS 검증이 필요하고
  컴1이 offline이면 Remote Workspace 전체가 멈춘다.

## 18. 타입과 메모리 수명 최적화

- [x] Remote Workspace production source의 explicit `any` 0개와 strict TypeScript 확인
- [x] untrusted RPC result를 success/error discriminated union과 runtime guard로 검증
- [x] chunked pairing response를 64 KiB까지만 streaming read하고 overflow 즉시 cancel
- [x] loopback bridge body 512 KiB, 동시 8개 제한 및 async idempotent shutdown
- [x] session acceptance 전송 실패 시 cipher endpoint 즉시 삭제/파기
- [x] directory entry를 incremental read하고 4,097번째에서 중단
- [x] UTF-8 truncation의 반복 rescanning을 logarithmic boundary search로 교체
- [x] GUI의 stopped-session tombstone을 무제한 Set 대신 단일 in-flight identity로 제한
- [x] 64 KiB relay 상한을 늘리지 않고 최대 2 MiB logical RPC를 bounded fragmentation하며,
  불완전 reassembly는 동시 8개/30초로 제한
- [x] process/bridge/transport/temp-dir 정리를 전 단계 시도하고 강제 종료 결과까지 확인
- [x] Rust native Executor helper에 64 KiB request, 256 KiB combined output, 60초 timeout,
  Windows 256-process Job 상한과 RAII native handle/ACL/profile cleanup 적용
- [x] macOS/Windows helper source의 cross-target compile과 common Rust unit tests
- [ ] signed Windows helper artifact pipeline 및 exact-binary live probe
- [ ] macOS command execution용 revocable descendant containment 설계와 native proof
- [ ] PTY streaming은 command RPC와 별도 protocol/backpressure 설계 후 도입
