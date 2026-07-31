---
created: 2026-07-26
status: plan
phase: wp3
blockers: [B2, B6]
tags: [grok-build, lifecycle, service, teardown]
---

# 030 — 라이프사이클 teardown 정합성 (B2, B6)

> **개정 2026-07-26 (A-게이트 감사 반영).** 초판의 오너십 게이트는 fence를 실제로 지키지 못했고
> (`killProxy` → SIGTERM → `syncCleanup` 우회), `ocx update`/트레이 재시작 퇴행과 대시보드 409
> 정지 문제를 놓쳤다. 아래는 그 네 가지를 포함한 교정본이다.

대상 파일: `src/service.ts`, `src/cli/index.ts`, `src/server/management-api.ts`,
`src/lib/process-control.ts`, `gui/src/App.tsx`.
근거: `000_blocker_inventory.md` B2/B6 + 라이프사이클 인벤토리(서브에이전트 실측).

## 실측된 현재 상태

| 경로 | 서비스 매니저 | Grok fence | 문제 |
|------|--------------|-----------|------|
| `ocx stop` (정상) | 정지 | strip | 정상 |
| `ocx stop` (소유권 불일치) | **살아있음** | strip | B2 — 공유 설정만 제거 |
| `ocx service stop` | 정지 | **남음** | B6 확장 — Codex는 복원하면서 grok은 방치 |
| `ocx service uninstall` | 제거 | **남음** | B6 확장 — 영구 방치 |
| `POST /api/stop` | 정지 시도 | **남음** | B6 + 가드 없는 throw로 500 |
| 서비스 프록시 크래시/재spawn | — | 남음 | 의도된 배제, 유지 |

`stopServiceIfInstalled()`는 세 결과를 두 채널로 뭉갠다: `false`는 "미설치 또는 정지 실패",
throw는 "소유권 불일치"뿐이다. 호출자가 올바르게 분기할 수 없다.

## B2 — 소유권 실패를 구분 가능한 타입으로

### 1. 오류 타입 도입 (`src/service.ts`)

```ts
/** 서비스가 다른 CODEX_HOME/OPENCODEX_HOME에 설치되어 이 프로세스가 건드릴 수 없음. */
export class ServiceOwnershipError extends Error {
  readonly code = "service-ownership-mismatch" as const;
}
```

`assertServiceEnvironmentMatchesInstall()`의 두 throw를 이 타입으로 바꾼다. 메시지 문구는
그대로 유지한다 — 기존 테스트(`service.test.ts:199`)와 사용자에게 익숙한 안내를 깨지 않는다.

타입 판별 헬퍼도 함께 export한다:

```ts
export function isServiceOwnershipError(err: unknown): err is ServiceOwnershipError {
  return err instanceof ServiceOwnershipError;
}
```

### 2. `handleStop`이 공유 자원 teardown을 게이트 (`src/cli/index.ts`)

```ts
let ownershipBlocked = false;
try {
  stoppedService = stopServiceIfInstalled();
  ...
} catch (err) {
  if (isServiceOwnershipError(err)) {
    ownershipBlocked = true;
    stopFailed = true;
    console.error(`❌ ${err.message}`);
    console.error("   Skipping shared teardown: the installed service may still be running and would respawn the proxy.");
  } else {
    console.error(`⚠️  Service manager stop failed: ${...}`);
  }
}
```

그리고 공유 자원 정리(`restoreNativeCodex`, `revertSystemEnv`, `stripGrokConfig`)를
`if (!ownershipBlocked)`로 감싼다. 로컬 프록시 정지 자체는 그대로 시도한다 — 그것은
이 홈이 소유한 자원이다.

**정정(감사):** `revertSystemEnv`는 게이트에서 **제외**한다. 이것은 macOS `launchctl` 사용자 환경
상태이고 자체 소유권 검사를 가지며(`src/server/system-env.ts:330`이 `"ownership mismatch"`를 반환)
`CODEX_HOME`과 무관하다. 게이트 대상은 `restoreNativeCodex`와 `stripGrokConfig` 둘뿐이다 —
소유권 단언 메시지 자체가 네이티브 Codex 복원을 겨냥한다(`service.ts:170`).

### 2b. 게이트가 실제로 fence를 지키게 한다 (감사 blocking 5)

`handleStop`에서 strip을 건너뛰어도 **프록시 종료 경로가 대신 strip한다**:
`stopProxy` → `stopProxyGracefully` → `POST /api/stop` → (409) → `!res.ok` → `killProxy` SIGTERM
→ 데몬의 `syncCleanup` → `OCX_SERVICE` 미설정이면 `stripGrokConfig()`.
즉 수동 기동/고아 프록시에서는 공유 설정이 그대로 사라진다 — B2가 말한 바로 그 상황이다.

두 곳을 함께 막는다:

1. `stopProxyGracefully`가 **409를 에스컬레이션 금지 신호로** 다룬다. 409는 "정지 요청이
   정책상 거부됨"이지 "엔드포인트가 죽음"이 아니므로 `killProxy`로 승격하면 안 된다.
   반환 타입을 `boolean`에서 `"stopped" | "refused" | "unreachable"`로 넓히고,
   `refused`면 호출자가 강제 종료 없이 실패를 보고한다.
2. 데몬의 `syncCleanup`에도 같은 판단을 심는다: strip 직전에 소유권을 확인해,
   불일치면 공유 파일을 건드리지 않는다. 프로세스 종료 경로가 어디서 오든 한 곳에서 막힌다.

### 2c. 명시적으로 감수하는 동작 변화 (감사 regression A/B)

`stopFailed = true`는 종료 코드 1을 낳고, 이는 두 곳에 파급된다:

- **`ocx update`** — `src/update/index.ts:223`이 `stop.status !== 0`이면 업데이트를 중단한다.
  소유권 불일치 사용자는 원래 `CODEX_HOME`을 찾을 때까지 업데이트가 거부된다.
  의도된 안전 동작이지만 막다른 길이 되므로, 중단 메시지에 소유권 원인과 해결 방법
  (원래 홈에서 실행)을 함께 출력한다.
- **트레이 재시작** — `handleStop`이 내부에서 `process.exit(1)`을 하면
  `runTrayProxyRestart`의 `stop()`이 값을 반환하지 못해 `start()`가 조용히 사라진다
  (`src/cli/tray-proxy.ts:50`). `handleStop`이 즉시 `exit`하는 대신 `process.exitCode`를
  세팅하고 반환하도록 바꿔 호출자가 결과를 관찰할 수 있게 한다. CLI 최상위에서는 동일하게 1로 끝난다.

### 2d. 거부된 strip을 삼키지 않는다 (감사 잔여 결함 3)

`handleStop`은 `stripGrokConfig()`가 `!ok`(예: orphaned-marker 거부)를 반환해도 로그만 찍고
성공으로 끝난다. fence가 죽은 프록시를 가리킨 채 남는데 종료 코드는 0이다.
`!g.ok`일 때 `stopFailed = true`로 승격한다.

**restart 영향:** `handleStop`이 `stopFailed`로 `process.exit(1)`하면 `handleEnsure`가 실행되지
않는다. 소유권 불일치 상태에서 재주입까지 진행하는 것은 오히려 위험하므로 이 동작이 옳다.
사용자는 올바른 홈에서 다시 실행하라는 안내를 받는다.

## B6 — 명시적 종료 경로에서 fence 제거

### 3. `serviceCommand`의 `stop` / `uninstall` (`src/service.ts`)

선행 조건(감사): `stop`은 현재 `ops.stop()`을 **설치 여부와 무관하게** 호출한다(`service.ts:1151`).
`stopServiceIfInstalled`과 달리 `existsSync(plistPath())` 가드가 없어 미설치 환경에서도 실제
`launchctl unload`가 실행된다. grok strip을 붙이기 전에 이 가드를 먼저 넣는다 — 그래야 이 경로가
테스트 가능해지고(040), 미설치 사용자에게 헛된 부작용도 사라진다.

두 경로 모두 `restoreNativeCodex()` 직후에 grok strip을 추가한다. 순환 의존을 피하려고
`src/cli/index.ts`가 쓰는 것과 같은 정적 import를 쓴다(`src/grok/inject.ts`는 `src/config`와
`src/codex/inject`만 의존하므로 안전).

순환 없음 확인(감사): `src/grok/inject.ts`의 import는 `node:fs`/`node:os`/`node:path`/`../config`/
`../codex/inject`뿐이고, 이들 중 어느 것도 `grok/`, `service.ts`, `management-api.ts`에 도달하지 않는다.

```ts
const g = stripGrokConfig();
if (g.changed) console.log(`↩️  ${g.message}`);
else if (!g.ok) console.error(`⚠️  ${g.message}`);
```

이 두 경로는 이미 맨 앞에서 `assertServiceEnvironmentMatchesInstall()`을 부르고 예외를 전파하므로
소유권 게이트는 이미 만족한다.

### 4. `POST /api/stop` (`src/server/management-api.ts`)

현재 6줄에 문제가 셋이다. 함께 고친다:

```ts
if (url.pathname === "/api/stop" && req.method === "POST") {
  const { restoreNativeCodex } = await import("../codex/inject");
  const { stopServiceIfInstalled, isServiceOwnershipError } = await import("../service");
  try {
    stopServiceIfInstalled();
  } catch (err) {
    if (isServiceOwnershipError(err)) {
      // 설치된 서비스를 정지시킬 수 없다 = 공유 설정을 건드리면 안 되고, 종료해도 즉시 되살아난다.
      return jsonResponse({ success: false, message: err.message }, 409, req, config);
    }
    throw err;
  }
  const restore = restoreNativeCodex();
  const { stripGrokConfig } = await import("../grok/inject");
  const grok = stripGrokConfig();
  setTimeout(...);
  ...
}
```

`jsonResponse` 시그니처 확인 완료: `src/server/auth-cors.ts:104`
`jsonResponse(data, status = 200, req?, config?)` — 상태 코드를 받는다.
`req`/`config`를 함께 넘겨 CORS 헤더가 대시보드 오리진과 맞게 한다.
응답 메시지에 grok strip 결과를 합쳐 대시보드가 상태를 볼 수 있게 한다.

종료 스케줄(`setTimeout` → `drainAndShutdown` → `process.exit(0)`)은 **주입 가능하게** 바꾼다.
현재 구조에서는 테스트가 `handleManagementAPI`를 호출하면 200 ms 뒤 테스트 러너 프로세스가
그대로 종료된다(감사 blocking 3). `ManagementApiDeps`에 종료 훅을 추가해 테스트가 대체하게 한다.

### 4b. 대시보드 409 처리 (감사 blocking 6)

`gui/src/App.tsx:181`의 정지 핸들러는 `res.ok`를 보지 않고 `stopping` 상태를 되돌리지도 않는다.
409를 받으면 버튼이 "stopping…"에 멈춘 채 아무 설명도 나오지 않는다.
응답을 검사해 실패면 `stopping`을 해제하고 서버 메시지를 노출한다. 상태 코드 변경과 **같은
커밋에** 넣는다 — 백엔드만 바뀌면 UI가 멈춘다.

### 5. `handleStart` grok 동기화 중첩 해소 (감사 잔여 결함 1)

`src/cli/index.ts:263`의 grok 동기화는 Desktop3P 레지스트리 `try` **안쪽**에 중첩돼 있다.
`fetchAllModels`가 던지면 바깥 catch가 삼켜 fence가 조용히 건너뛰어진다 —
`syncGrokConfig` 자체에 카탈로그 실패 폴백이 있는데도 도달하지 못한다.
두 블록을 형제 `try`로 분리한다. 040의 배선 테스트가 이 구조를 고정한다.
(초판에서 040이 이 변경을 전제했으나 어느 사이클도 소유하지 않았다 — 여기로 귀속.)

`OCX_SERVICE=1` 크래시/재spawn 배제(`syncCleanup`의 게이트)는 **그대로 둔다** — 이 변경은
명시적 종료 경로에만 strip을 추가한다.

## 회귀 테스트 (뼈대만; 상세는 040에서)

- 소유권 불일치 시 `handleStop`이 strip을 건너뛰고 실패 종료 코드를 남긴다.
- 소유권 불일치 시 `revertSystemEnv`는 **여전히 실행된다**(과잉 게이트 방지).
- 409를 받은 `stopProxyGracefully`가 `killProxy`로 승격하지 **않는다**.
- `syncCleanup`이 소유권 불일치에서 strip하지 않는다.
- `!ok` strip 결과가 `ocx stop`을 실패로 만든다.
- `service stop`/`uninstall`이 strip을 호출한다.
- `/api/stop`이 strip을 호출하고, 소유권 불일치에는 409로 응답하며 프록시를 종료하지 않는다.
- `syncCleanup`의 `OCX_SERVICE` 배제가 그대로 남아 있다.

## 게이트

`bun test tests/service.test.ts tests/grok-*.test.ts` → `bun run typecheck` → 전체 `bun run test`.
