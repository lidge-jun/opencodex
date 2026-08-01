# 020 — wp2: 라이프사이클 / teardown

대상: `src/cli/index.ts`, `src/service.ts`, `src/server/management-api.ts`, `tests/service.test.ts`, 신규 `tests/grok-lifecycle.test.ts`.

## 블로커 4 — 소유권 가드 실패 후에도 공유 fence를 제거한다

`handleStop`은 `stopServiceIfInstalled()`을 try/catch로 감싸 경고만 남기고 계속 진행한다(`src/cli/index.ts:390`). 이 함수는 `assertServiceEnvironmentMatchesInstall()`이 먼저 던지므로(`src/service.ts:870`), CODEX_HOME/OPENCODEX_HOME이 다른 홈에서 실행하면 **서비스 매니저를 건드리지도 못한 채** 예외가 난다. 그런데도 흐름은 447행의 `stripGrokConfig()`까지 내려가 다른 홈이 소유한 살아 있는 서비스의 라우팅 블록을 지운다.

로컬 프록시/Codex 복원은 이 홈의 것이므로 계속해도 되지만, `~/.grok/config.toml`은 **전역 공유 파일**이라 다르다.

### 결정

가드 실패를 전면 치명적으로 만들지 않는다(그러면 `ocx restart`가 막히고 로컬 정리도 못 한다). 대신 **공유 자원 정리만 건너뛴다.**

```diff
   let stopFailed = false;
   let stoppedService = false;
+  // A guard failure means the service manager was never touched, so an installed service
+  // owned by ANOTHER home may still be live and still routing through the shared Grok fence.
+  let sharedTeardownSafe = true;
   try {
     stoppedService = stopServiceIfInstalled();
     if (stoppedService) console.log("🛑 Service manager stopped (won't respawn).");
   } catch (err) {
+    sharedTeardownSafe = false;
     console.error(`⚠️  Service manager stop failed: ${err instanceof Error ? err.message : String(err)}`);
   }
```

그리고 strip 호출부:

```diff
-  try {
-    const g = stripGrokConfig();
-    if (g.changed) console.log(`↩️  ${g.message}`);
-    else if (!g.ok) console.error(`⚠️  ${g.message}`);
-  } catch { /* best-effort */ }
+  if (sharedTeardownSafe) {
+    try {
+      const g = stripGrokConfig();
+      if (g.changed) console.log(`↩️  ${g.message}`);
+      else if (!g.ok) console.error(`⚠️  ${g.message}`);
+    } catch { /* best-effort */ }
+  } else {
+    console.error(
+      "⚠️  Left the Grok Build managed block in place: the installed service could not be stopped "
+      + "from this home, so it may still be serving those models. Re-run `ocx stop` from the "
+      + "installing home, or remove the fenced block manually.",
+    );
+    process.exitCode = 1;
+  }
```

`process.exitCode = 1`로 실패를 보이게 한다. 기존 `stopFailed` 경로의 `process.exit(1)`과 달리 exitCode만 세팅해 나머지 정리는 끝까지 돌게 한다.

## 블로커 5 — 의도적 서비스 종료 경로가 fence를 남긴다

데몬은 `OCX_SERVICE=1`일 때 `syncCleanup`에서 strip을 일부러 건너뛴다(`cli/index.ts:212`) — 재시작 사이에 블록을 유지하려는 설계다. 문제는 **영구 종료** 경로도 아무도 지우지 않는다는 점이다:

- `ocx service stop` (`src/service.ts:1149`) — `stripGrokConfig` 호출 없음. 파일 전체에 해당 심볼이 없다.
- `ocx service uninstall|remove` (`:1165`) — 동일.
- 대시보드 `POST /api/stop` (`src/server/management-api.ts:136`) — 동일. 게다가 `stopServiceIfInstalled()`이 **무방비**라, 소유권 불일치 시 핸들러가 통째로 throw되어 `restoreNativeCodex`도, 200 응답도, 드레인 타이머도 실행되지 않는다. CLI보다 나쁜 상태다.

### 변경 A — `src/service.ts`

`stop`과 `uninstall/remove` 케이스의 `restoreNativeCodex()` 직후에 fence 제거를 추가한다. 두 케이스 모두 앞서 `assertServiceEnvironmentMatchesInstall()`을 통과했으므로 이 홈이 소유자임이 이미 증명돼 있다.

```diff
     case "stop":
       assertServiceEnvironmentMatchesInstall();
       ops.stop();
       await stopTrackedProxyForServiceCommand();
       {
         const restore = restoreNativeCodex();
         if (restore.success) console.log("✅ service stopped + native Codex restored.");
         else console.error(`⚠️ service stopped, but native Codex restore FAILED: ...`);
       }
+      // Intentional, permanent teardown: the service-mode daemon deliberately keeps the
+      // Grok fence across respawns, so this path owns removing it. Otherwise the generated
+      // [model.ocx-*] entries survive pointing at a dead endpoint.
+      stripGrokConfigBestEffort();
       break;
```

`uninstall`/`remove` 케이스는 `removeServiceInstallState()` 직전에 같은 호출을 넣는다.

헬퍼는 동적 import로 두어 모듈 사이클을 피한다:

```ts
/** Remove the opencodex-managed ~/.grok block; never fails a teardown command. */
function stripGrokConfigBestEffort(): void {
  try {
    const { stripGrokConfig } = require("./grok/inject") as typeof import("./grok/inject");
    const r = stripGrokConfig();
    if (r.changed) console.log("↩️  Removed the opencodex managed block from Grok config.");
  } catch { /* best-effort */ }
}
```

`src/service.ts`는 이미 `./codex/inject`를 정적 import하므로 정적 import로 통일한다 (`import { restoreNativeCodex } from "./codex/inject";` 옆에 `import { stripGrokConfig } from "./grok/inject";`). `require` 대신 정적 import를 쓰는 쪽이 Bun 런타임 및 typecheck와 일관된다.

### 변경 B — `src/server/management-api.ts`

```diff
   if (url.pathname === "/api/stop" && req.method === "POST") {
     const { restoreNativeCodex } = await import("../codex/inject");
     const { stopServiceIfInstalled } = await import("../service");
-    stopServiceIfInstalled();
+    const { stripGrokConfig } = await import("../grok/inject");
+    // The ownership guard inside stopServiceIfInstalled throws when this process's
+    // CODEX_HOME/OPENCODEX_HOME differs from the installed service's. That must not abort
+    // the handler: without this catch the request never gets a response and the drain timer
+    // never runs. A guard failure also means another home may still be serving the Grok
+    // models, so the shared fence stays.
+    let sharedTeardownSafe = true;
+    try {
+      stopServiceIfInstalled();
+    } catch (err) {
+      sharedTeardownSafe = false;
+      console.error(`⚠️  Service manager stop failed: ${err instanceof Error ? err.message : String(err)}`);
+    }
     const restore = restoreNativeCodex();
+    if (sharedTeardownSafe) { try { stripGrokConfig(); } catch { /* best-effort */ } }
     setTimeout(async () => {
```

## 테스트

저장소 관례상 라이프사이클은 소스 텍스트 슬라이스 + 순서 단언이 지배적이다(`tests/service.test.ts:523`). 그 관례를 따르되, 순수 함수로 검증 가능한 부분은 실제 호출로 확인한다.

신규 `tests/grok-lifecycle.test.ts`:

1. `handleStop skips the shared Grok strip when the ownership guard fails` — `src/cli/index.ts`에서 `async function handleStop`부터 다음 `async function`까지 슬라이스한 뒤, `sharedTeardownSafe = false`가 catch 안에 있고 `stripGrokConfig()` 호출이 `if (sharedTeardownSafe)` 블록 안에 있음을 단언.
2. `ocx service stop strips the Grok fence after restoring Codex` — `service.ts`의 `case "stop":` 슬라이스에서 `stripGrokConfig` 존재와 `restoreNativeCodex` 뒤 순서를 단언.
3. `ocx service uninstall strips the Grok fence` — 동일 패턴.
4. `POST /api/stop guards the service stop and strips the fence` — `management-api.ts` 슬라이스에서 `stopServiceIfInstalled()`가 try 안에 있고 `stripGrokConfig`가 존재함을 단언.
5. `service-mode daemon shutdown still keeps the fence` — `cli/index.ts`의 `syncCleanup` 슬라이스에서 `!process.env.OCX_SERVICE` 가드가 유지됨을 단언 (회귀 방지: 크래시/respawn 예외를 없애면 안 된다).

추가로 실제 발동 증거(C-ACTIVATION-GROUNDING-01)를 위해 `tests/grok-config-inject.test.ts`에서 `stripGrokConfig`가 실제 파일에 대해 도는 경로는 이미 wp1이 커버한다.
