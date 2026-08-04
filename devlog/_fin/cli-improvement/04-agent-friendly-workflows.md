# 04. 에이전트/자동화 친화적 워크플로우 개선 제안

> **작성일**: 2025-07-05
> **범위**: `ocx` CLI의 비대화형(non-interactive) 워크플로우 확장
> **상태**: 제안(proposal)

---

## 1. 문제 정의

### 1.1 현재 상황

`ocx`는 **사람이 터미널에서 직접 사용하는 것**을 전제로 설계되어 있다. 이 설계는 인간 사용자에게는 자연스럽지만, AI 에이전트(Codex agent)나 CI/CD 파이프라인, 셸 스크립트 같은 **자동화 컨텍스트에서는 마찰이 된다**.

구체적인 문제점:

| 현재 명령 | 문제 | 에이전트 관점의 영향 |
|-----------|------|---------------------|
| `ocx init` | `readline` 기반 대화형 프롬프트만 지원. 프로그래밍적으로 설정 불가 | 에이전트가 프록시를 처음 설정할 수 없음 |
| `ocx start` | 포그라운드에서 `await new Promise(() => {})` 로 영구 블로킹 | 에이전트가 시작 후 다음 작업으로 넘어갈 수 없음 |
| `ocx start` (이미 실행 중) | `process.exit(1)` -- 에러로 종료 | 멱등성 없음. 스크립트에서 "시작되어 있으면 OK" 패턴 불가 |
| `ocx ensure` | 백그라운드 시작 + 대기 포함, 그러나 출력이 사람용 이모지 텍스트 | 종료 코드는 활용 가능하지만, 포트 번호 등을 파싱하기 어려움 |
| `ocx status` | `--json` 플래그 지원 (좋음!), 하지만 단순 health-check 전용 명령 부재 | 상태 확인에 JSON 파싱이 필요함 |
| 모델 목록 | GUI 대시보드 또는 HTTP API (`/api/models`)로만 접근 가능 | CLI에서 사용 가능한 모델을 확인할 방법 없음 |
| 프로바이더 검증 | 없음 -- 실제 요청을 보내봐야 알 수 있음 | 설정 후 "이 프로바이더가 작동하는가?"를 자동 확인 불가 |

### 1.2 에이전트 시나리오

다음은 현재 CLI로는 깔끔하게 수행할 수 없는 대표적인 에이전트 워크플로우다:

```bash
# 에이전트가 스스로의 opencodex 프록시를 부트스트랩하는 이상적인 흐름
ocx init --provider xai --non-interactive      # 없음
ocx start --background                          # 없음
ocx wait-ready --timeout 10000                  # 없음
ocx health                                       # 없음 (ocx status --json 으로 대체 가능하지만 과잉)
ocx models --json                                # 없음
ocx test-provider xai                            # 없음
```

### 1.3 설계 원칙

이 제안의 모든 개선은 다음 원칙을 따른다:

- **멱등성(Idempotency)**: 같은 명령을 여러 번 실행해도 동일한 결과. 이미 원하는 상태면 성공.
- **스크립트 친화적 출력**: 기본은 사람용, `--json` / `--quiet` 으로 기계용 출력 전환.
- **종료 코드 계약**: 성공=0, 실패=1, 타임아웃=124 (표준 `timeout(1)` 관례).
- **기존 CLI와의 하위 호환**: 현재 동작을 깨지 않음. 새 플래그나 새 서브커맨드로 확장.

---

## 2. 제안하는 개선 사항

### 2.1 `ocx start --background` / `ocx start -d`

**목적**: 서비스 매니저(launchd/systemd) 설치 없이 프록시를 백그라운드로 시작하고 셸 제어를 즉시 반환한다.

#### 현재 동작

```typescript
// cli.ts -- handleStart()
if (options.block ?? true) {
  setInterval(() => {}, 60_000);
  await new Promise<void>(() => {});  // 영구 블로킹
}
```

`handleStart`에 `block` 매개변수가 이미 존재하지만, CLI에서는 사용되지 않는다. `ocx ensure`가 내부적으로 `spawn` + `detach`를 하지만, `ensure`는 auto-start가 비활성화된 경우 아무것도 하지 않는다 (`codexAutoStartEnabled` 체크).

#### 제안 동작

```
ocx start --background    # detach + 포트 반환 + exit 0
ocx start -d              # 축약형
ocx start -d --port 8080  # 포트 지정과 조합
```

```bash
$ ocx start -d
Proxy started in background (PID 12345, port 10100)

$ ocx start -d --json
{"pid":12345,"port":10100,"status":"started"}
```

**멱등성 규칙**: 이미 프록시가 실행 중이면 에러 대신 성공을 반환한다.

```bash
$ ocx start -d
Proxy already running (PID 12345, port 10100)
# exit 0
```

#### 구현 스케치

```typescript
// cli.ts -- parseStartOptions()
function parseStartOptions(): { port?: number; background: boolean; json: boolean } {
  const rest = args.slice(1);
  const background = rest.includes("--background") || rest.includes("-d");
  const json = rest.includes("--json");
  // ... 기존 --port 파싱 유지 ...
  return { port, background, json };
}

// handleStart 수정
async function handleStart(options: { block?: boolean; json?: boolean } = {}) {
  const existingPid = readPid();
  if (existingPid) {
    const live = await findLiveProxy();
    if (live) {
      // 기존: process.exit(1)
      // 변경: 멱등 성공
      if (options.json) {
        console.log(JSON.stringify({ pid: live.pid, port: live.port, status: "already_running" }));
      } else {
        console.log(`Proxy already running (PID ${live.pid ?? existingPid}, port ${live.port}).`);
      }
      return; // exit 0
    }
    removePid(existingPid);
  }

  // ... 서버 시작 ...

  if (!(options.block ?? true)) {
    // 백그라운드 모드: 자기 자신을 detach된 자식으로 재시작
    const child = spawn(process.execPath, [process.argv[1], "start"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env },
    });
    child.unref();
    const live = await waitForProxy();
    if (!live) {
      console.error("Proxy did not become healthy.");
      process.exit(1);
    }
    if (options.json) {
      console.log(JSON.stringify({ pid: live.pid, port: live.port, status: "started" }));
    } else {
      console.log(`Proxy started in background (PID ${live.pid}, port ${live.port})`);
    }
    return; // exit 0, 셸로 제어 반환
  }

  // 기존 포그라운드 블로킹 로직 유지
}
```

**`ocx ensure`와의 관계**: `ensure`는 "auto-start가 켜져 있을 때만" 동작하는 반면, `start -d`는 명시적 시작 명령이므로 auto-start 설정과 무관하게 동작한다. `ensure`는 codex-shim에서 호출되는 간접 실행 경로이고, `start -d`는 에이전트나 스크립트의 직접 실행 경로이다.

---

### 2.2 `ocx wait-ready [--timeout <ms>]`

**목적**: 프록시가 healthy 상태가 될 때까지 블로킹하고, 준비되면 exit 0으로 반환한다.

#### 사용 시나리오

```bash
ocx start -d && ocx wait-ready --timeout 15000
# 또는
ocx ensure && ocx wait-ready
```

이미 `cli.ts` 내부에 `waitForProxy()` 함수가 있지만 (기본 8초 타임아웃), 이것은 내부 유틸리티로만 사용된다. 이를 독립 커맨드로 노출한다.

#### 제안 동작

```
ocx wait-ready                     # 기본 30초 타임아웃
ocx wait-ready --timeout 5000      # 5초 타임아웃
ocx wait-ready --json              # {"ready":true,"port":10100,"pid":12345,"elapsed_ms":1234}
```

종료 코드:
- `0`: 프록시가 healthy 상태
- `1`: 프록시를 찾을 수 없거나 unhealthy
- `124`: 타임아웃 (GNU `timeout` 관례)

#### 구현 스케치

```typescript
async function handleWaitReady() {
  const timeoutArg = args.indexOf("--timeout");
  const timeoutMs = timeoutArg !== -1 ? Number(args[timeoutArg + 1]) : 30_000;
  const json = args.includes("--json");
  const start = Date.now();

  const live = await waitForProxy(timeoutMs);
  const elapsed = Date.now() - start;

  if (!live) {
    if (json) console.log(JSON.stringify({ ready: false, elapsed_ms: elapsed }));
    else console.error("Proxy did not become ready within timeout.");
    process.exit(elapsed >= timeoutMs ? 124 : 1);
  }

  if (json) {
    console.log(JSON.stringify({ ready: true, port: live.port, pid: live.pid, elapsed_ms: elapsed }));
  } else {
    console.log(`Proxy ready (port ${live.port}, ${elapsed}ms)`);
  }
}
```

---

### 2.3 `ocx health`

**목적**: 프록시의 현재 health 상태를 단순하게 확인한다. `ocx status`의 경량 버전.

#### `ocx status`와의 차이

`ocx status`는 서비스 상태, codex-shim, OAuth 로그인, 플러그인 등 전체 진단을 수행한다 (`collectStatus()`). 에이전트가 "프록시 살아있나?" 하나만 확인하고 싶을 때 불필요한 오버헤드다.

```
$ ocx health
ok
# exit 0

$ ocx health
unreachable
# exit 1

$ ocx health --json
{"ok":true,"port":10100,"pid":12345,"version":"0.3.0","uptime":3600}
# exit 0
```

#### 구현 스케치

```typescript
async function handleHealth() {
  const json = args.includes("--json");
  const live = await findLiveProxy();

  if (!live) {
    if (json) console.log(JSON.stringify({ ok: false }));
    else console.log("unreachable");
    process.exit(1);
  }

  // /healthz에서 상세 정보 가져오기
  const config = loadConfig();
  const hostname = probeHostname(live.hostname ?? config.hostname);
  try {
    const res = await fetch(`http://${hostname}:${live.port}/healthz`, {
      signal: AbortSignal.timeout(2000),
    });
    const body = await res.json() as HealthzIdentity;
    if (json) {
      console.log(JSON.stringify({
        ok: true,
        port: live.port,
        pid: live.pid,
        version: body.version,
        uptime: body.uptime,
      }));
    } else {
      console.log("ok");
    }
  } catch {
    if (json) console.log(JSON.stringify({ ok: false }));
    else console.log("unreachable");
    process.exit(1);
  }
}
```

**셸 스크립트에서의 활용:**

```bash
if ocx health; then
  echo "프록시 정상"
else
  ocx start -d
  ocx wait-ready
fi
```

---

### 2.4 멱등 시작 (Idempotent Start)

**목적**: `ocx start`가 이미 실행 중인 프록시를 에러로 처리하지 않도록 한다.

#### 현재 동작

```typescript
// cli.ts:102-106
if (live) {
  console.error(`Proxy already running (...). Use 'ocx stop' first.`);
  process.exit(1);  // <-- 에러!
}
```

#### 제안 동작

이미 실행 중일 때 **exit 0** 으로 성공 반환. 포그라운드 모드에서도 동일하게 적용.

기존 동작을 기대하는 스크립트가 있을 수 있으므로, `--strict` 플래그로 기존 동작을 선택적으로 유지:

```
ocx start             # 이미 실행 중 -> 성공 (exit 0)
ocx start --strict    # 이미 실행 중 -> 에러 (exit 1, 기존 동작)
```

이 변경은 `ocx ensure`의 멱등 패턴과 일관성을 갖추게 된다. `ensure`는 이미 실행 중이면 `Proxy running on port N`을 출력하고 exit 0 한다.

---

### 2.5 `ocx models` / `ocx models --json`

**목적**: GUI나 HTTP API 없이 CLI에서 사용 가능한 모델 목록을 확인한다.

#### 현재 상황

모델 목록은 서버의 `/api/models` 엔드포인트에서만 접근 가능:

```typescript
// server.ts:1881
if (url.pathname === "/api/models" && req.method === "GET") {
  const models = await fetchAllModels(config);
  // ...
}
```

프록시가 실행 중이어야만 모델을 확인할 수 있고, HTTP 요청을 직접 보내야 한다.

#### 제안 동작

```
$ ocx models
Provider: xai
  grok-3              reasoning, vision    128K context
  grok-3-mini         reasoning            128K context
  grok-3-fast         -                    128K context

Provider: openrouter
  claude-4-opus       reasoning, vision    200K context
  gemini-2.5-pro      reasoning, vision    1M context

$ ocx models --json
[
  {"provider":"xai","id":"grok-3","vision":true,"reasoning":true,"context":131072},
  {"provider":"xai","id":"grok-3-mini","vision":false,"reasoning":true,"context":131072},
  ...
]

$ ocx models --provider xai
  grok-3
  grok-3-mini
  grok-3-fast
```

#### 구현 방식

두 가지 경로:

1. **프록시 실행 중**: `/api/models` HTTP 호출 (이미 구현된 엔드포인트 활용)
2. **프록시 미실행**: `gatherRoutedModels(config)`를 직접 호출 (서버와 동일한 로직)

```typescript
async function handleModels() {
  const json = args.includes("--json");
  const providerFilter = (() => {
    const idx = args.indexOf("--provider");
    return idx !== -1 ? args[idx + 1] : null;
  })();

  // 1차: 실행 중인 프록시에서 가져오기
  const live = await findLiveProxy();
  let models: CatalogModel[];

  if (live) {
    const res = await fetch(
      `http://${probeHostname(live.hostname)}:${live.port}/api/models`,
    );
    models = await res.json();
  } else {
    // 2차: 설정에서 직접 수집 (네트워크 요청은 여전히 발생)
    const { gatherRoutedModels } = await import("./codex-catalog");
    const config = loadConfig();
    applyProxyEnv(config);
    models = await gatherRoutedModels(config);
  }

  if (providerFilter) {
    models = models.filter(m => m.provider === providerFilter);
  }

  if (json) {
    console.log(JSON.stringify(models, null, 2));
  } else {
    // 프로바이더별 그룹핑 + 테이블 출력
    const byProvider = Object.groupBy(models, m => m.provider);
    for (const [provider, group] of Object.entries(byProvider)) {
      console.log(`\nProvider: ${provider}`);
      for (const m of group ?? []) {
        const tags = [m.reasoning && "reasoning", m.vision && "vision"]
          .filter(Boolean).join(", ");
        console.log(`  ${m.id.padEnd(24)} ${tags.padEnd(20)} ${
          m.contextWindow
            ? `${Math.round(m.contextWindow / 1024)}K context`
            : ""
        }`);
      }
    }
  }
}
```

---

### 2.6 `ocx test-provider <name>`

**목적**: 특정 프로바이더 설정이 실제로 작동하는지 검증한다 (API 키 유효성, 네트워크 연결, 모델 접근).

#### 사용 시나리오

```bash
$ ocx test-provider xai
xai: connected
   Base URL: https://api.x.ai/v1
   Auth: API key (valid)
   Models found: 5
   Test completion: ok (grok-3-fast, 243ms)

$ ocx test-provider badconfig
badconfig: failed
   Base URL: https://invalid.example.com/v1
   Error: ECONNREFUSED

$ ocx test-provider xai --json
{
  "provider": "xai",
  "ok": true,
  "baseUrl": "https://api.x.ai/v1",
  "authValid": true,
  "modelCount": 5,
  "testCompletion": {"ok": true, "model": "grok-3-fast", "latencyMs": 243}
}
```

#### 구현 스케치

```typescript
async function handleTestProvider() {
  const name = args[1];
  if (!name) {
    console.error("Usage: ocx test-provider <provider-name>");
    process.exit(1);
  }

  const config = loadConfig();
  const provider = config.providers?.[name];
  if (!provider) {
    console.error(`Provider "${name}" not found in config.`);
    process.exit(1);
  }

  const json = args.includes("--json");
  const result: Record<string, unknown> = {
    provider: name, ok: false, baseUrl: provider.baseUrl,
  };

  // 1. 모델 목록 가져오기 시도 (GET /v1/models)
  try {
    const { fetchProviderModels } = await import("./model-fetcher");
    const models = await fetchProviderModels(name, provider, config);
    result.modelCount = models.length;
    result.authValid = true;

    // 2. 간단한 completion 테스트 (선택적)
    if (models.length > 0) {
      const testModel = provider.defaultModel ?? models[0].id;
      const start = Date.now();
      try {
        const res = await fetch(`${provider.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(provider.apiKey
              ? { Authorization: `Bearer ${provider.apiKey}` }
              : {}),
          },
          body: JSON.stringify({
            model: testModel,
            messages: [{ role: "user", content: "Say 'ok'" }],
            max_tokens: 5,
          }),
          signal: AbortSignal.timeout(15000),
        });
        result.testCompletion = {
          ok: res.ok,
          model: testModel,
          latencyMs: Date.now() - start,
        };
      } catch (e) {
        result.testCompletion = {
          ok: false,
          model: testModel,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }
    result.ok = true;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const label = result.ok ? "connected" : "failed";
    console.log(`${name}: ${label}`);
    console.log(`   Base URL: ${provider.baseUrl}`);
    if (result.error) console.log(`   Error: ${result.error}`);
    if (result.modelCount)
      console.log(`   Models found: ${result.modelCount}`);
    if (result.testCompletion) {
      const tc = result.testCompletion as {
        ok: boolean; model: string; latencyMs?: number;
      };
      console.log(`   Test completion: ${tc.ok ? "ok" : "failed"} (${
        tc.model}${tc.latencyMs ? `, ${tc.latencyMs}ms` : ""})`);
    }
  }

  if (!result.ok) process.exit(1);
}
```

---

## 3. 에이전트 워크플로우 통합 시나리오

### 3.1 Codex 에이전트가 자체 프록시를 부트스트랩하는 흐름

```bash
#!/bin/bash
set -euo pipefail

# 1. 프록시가 이미 실행 중인지 확인
if ocx health; then
  echo "프록시 이미 실행 중"
else
  # 2. 백그라운드로 시작
  ocx start -d

  # 3. 준비될 때까지 대기
  ocx wait-ready --timeout 15000
fi

# 4. 사용 가능한 모델 확인
MODELS=$(ocx models --json)
echo "사용 가능 모델: $(echo $MODELS | jq length)개"

# 5. 프로바이더 동작 확인
ocx test-provider xai --json | jq '.ok'
```

### 3.2 CI 파이프라인에서의 활용

```yaml
# GitHub Actions 예시
steps:
  - name: Start opencodex proxy
    run: |
      ocx start -d --port 10100
      ocx wait-ready --timeout 30000

  - name: Verify providers
    run: |
      ocx test-provider xai
      ocx models --json > available-models.json

  - name: Run Codex agent tasks
    run: |
      codex --model xai/grok-3 "Fix the failing tests"

  - name: Teardown
    if: always()
    run: ocx stop
```

### 3.3 에이전트 내부에서의 프로그래밍적 사용 (Node.js)

```typescript
import { execSync } from "node:child_process";

// 멱등 시작
execSync("ocx start -d", { stdio: "inherit" });

// 준비 대기
const readyOutput = execSync("ocx wait-ready --json", { encoding: "utf8" });
const { port, pid } = JSON.parse(readyOutput);

// 모델 목록
const models = JSON.parse(
  execSync("ocx models --json", { encoding: "utf8" }),
);
console.log(`${models.length} models available`);

// health check 루프
setInterval(() => {
  try {
    execSync("ocx health", { stdio: "ignore" });
  } catch {
    console.error("프록시 다운 감지, 재시작...");
    execSync("ocx start -d");
  }
}, 60_000);
```

---

## 4. 구현 우선순위

| 순위 | 기능 | 난이도 | 기존 코드 활용 | 영향도 |
|------|------|--------|---------------|--------|
| 1 | 멱등 시작 | 낮음 | `handleStart`의 exit(1) -> exit(0) 변경 | 높음 -- 모든 스크립트 패턴의 기반 |
| 2 | `start --background` | 중간 | `ensure`의 spawn 패턴 재사용 | 높음 -- 에이전트의 핵심 요구 |
| 3 | `health` | 낮음 | `findLiveProxy()` + `proxyIdentityAt()` 직접 활용 | 중간 -- 스크립트 health-check |
| 4 | `wait-ready` | 낮음 | `waitForProxy()` 함수 이미 존재 | 중간 -- 비동기 시작과 조합 |
| 5 | `models` | 중간 | `/api/models` 엔드포인트 + `gatherRoutedModels()` | 중간 -- 모델 탐색 |
| 6 | `test-provider` | 중간 | 기존 모델 fetch 로직 부분 활용 | 낮음-중간 -- 설정 검증 |

---

## 5. 기존 구조와의 호환성

### 5.1 `ocx ensure`와의 관계

`ensure`는 codex-shim에서 호출되는 **간접 자동 실행** 경로이다:

```bash
# codex-shim이 생성하는 래퍼 스크립트 (codex-shim.ts:buildUnixCodexShim)
case "$1" in
  app-server|archive|...) ;; # 내부 명령은 바이패스
  *) ocx ensure >/dev/null 2>&1 || true ;;
esac
exec codex.opencodex-real "$@"
```

`ensure`는 `codexAutoStartEnabled(config)` 체크가 있어서, auto-start가 꺼져 있으면 아무것도 하지 않는다. 반면 `start -d`는 **명시적 시작 의도**이므로 이 체크가 없다.

두 커맨드의 역할 분담:

| | `ocx ensure` | `ocx start -d` |
|---|---|---|
| 호출자 | codex-shim (자동) | 에이전트/스크립트 (명시적) |
| auto-start 체크 | 있음 | 없음 |
| 이미 실행 중 | 모델 sync만 수행 | 성공 반환 |
| 프롬프트/업데이트 | 없음 | 없음 (--background이므로) |
| 출력 | 사람용 | `--json` 지원 |

### 5.2 `ocx service`와의 관계

`service`는 OS 서비스 매니저(launchd/systemd/Task Scheduler)에 등록하여 **부팅 시 자동 시작** + **크래시 자동 재시작**을 제공한다. `start -d`는 서비스 매니저 없이 단순 백그라운드 프로세스로 실행한다.

| | `ocx service install` | `ocx start -d` |
|---|---|---|
| 부팅 시 자동 시작 | O | X |
| 크래시 자동 재시작 | O | X |
| OS 서비스 매니저 필요 | O | X |
| 일시적 사용 | X (uninstall 필요) | O (stop으로 종료) |
| 에이전트/CI 적합성 | 낮음 | 높음 |

---

## 6. 열린 질문

1. **`ocx init --non-interactive`**: config 파일을 직접 작성하는 것으로 충분한가, 아니면 `--provider`, `--api-key` 등의 CLI 플래그가 필요한가? 현재는 `config.json`을 직접 편집하는 것이 해결책이지만 문서화가 부족하다.

2. **`--json` 글로벌 플래그**: 모든 명령에 `--json` 을 개별 추가하는 것보다, `OCX_OUTPUT=json` 환경 변수나 글로벌 `--output json` 플래그가 나은가?

3. **`ocx start -d`의 구현**: 현재 프로세스에서 서버를 시작한 뒤 반환할 것인가 (현재 `handleStart`의 `block: false` 경로), 아니면 `ensure`처럼 자식 프로세스를 spawn할 것인가? 후자가 더 깔끔하지만, 업데이트 프롬프트 건너뛰기 등의 차이가 생긴다.

4. **`test-provider`의 completion 테스트**: 실제 토큰을 소비하는 completion 테스트를 기본으로 수행할 것인가, `--test-completion` 플래그로 선택적 수행으로 할 것인가? 기본적으로는 `/v1/models` 엔드포인트 호출(무료)만 하고, completion은 옵트인이 안전할 수 있다.
