# 03. 머신 리더블 출력 및 종료 코드 표준화

> 개선 제안 | 2026-07-05

---

## 1. 현황 분석

### 1.1 현재 상태

`ocx` CLI는 대부분의 명령에서 사람이 읽기 편한 텍스트만 출력한다. 이모지(✅, ❌, ⚠️, 🛑 등)와 자유 형식 문자열이 혼재되어 있어, 외부 도구나 에이전트가 결과를 파싱하기 어렵다.

**구조화 출력이 있는 명령:**
- `ocx status --json` — `CliStatusJson` 타입의 JSON 출력 (schemaVersion 포함)

**구조화 출력이 없는 명령:**
- `ocx doctor` — paths, proxy env, WHAM probe 결과를 `console.log`로 직접 출력
- `ocx sync` — 모델 카탈로그 동기화 결과를 텍스트로 출력 (내부적으로 `CodexSyncResult` 구조체 존재)
- `ocx service status` — 설치 상태를 텍스트 한 줄로 출력
- `ocx start/stop/ensure` — 성공/실패를 이모지 + 텍스트로 출력
- `ocx init` — 인터랙티브 프롬프트 (구조화 불필요하나 결과 요약은 필요)
- `ocx codex-shim status` — 텍스트 한 줄
- `ocx login/logout` — 텍스트 한 줄

### 1.2 종료 코드 현황

현재 `process.exit()` 패턴을 분석한 결과:

| 코드 | 사용 위치 | 의미 |
|------|-----------|------|
| `0` | 정상 종료, `--version`, `help` | 성공 |
| `1` | 인자 파싱 실패, 포트 오류, 서비스 실패, stop 실패 등 | 범용 에러 |
| `130` | SIGINT force shutdown (두 번째 시그널) | 강제 종료 |

문제점:
- 종료 코드 `1`이 모든 종류의 실패에 사용됨 (인자 오류, 런타임 에러, 상태 이상 구분 불가)
- 에이전트/스크립트가 "이미 실행 중"과 "시작 실패"를 구분할 수 없음
- `ocx doctor`는 문제를 발견해도 항상 exit 0으로 종료

---

## 2. 문제 정의

### 2.1 에이전트/자동화 관점

Codex 에이전트, CI/CD 파이프라인, 모니터링 스크립트 등이 `ocx`를 프로그래밍 방식으로 사용할 때:

1. **파싱 불가능한 출력**: 이모지와 자유 텍스트를 정규식으로 파싱하면 버전 업데이트 시 깨진다
2. **상태 판단 불가**: `ocx doctor`가 경고를 출력해도 exit 0이므로 문제 감지를 놓침
3. **세부 에러 구분 불가**: exit 1만으로는 "포트 충돌", "권한 부족", "이미 실행 중" 등을 구분할 수 없음
4. **불필요한 출력 노이즈**: 스크립트에서 `ocx ensure`를 실행할 때 이모지/텍스트 출력이 로그를 오염시킴

### 2.2 기존 자산

다행히 내부 구조는 이미 구조화되어 있다:
- `CliStatusJson` 타입 — status 명령용 JSON 스키마 (schemaVersion 포함)
- `CodexSyncResult` 인터페이스 — sync 결과 (ok, added, catalogPath, warning 등)
- `PathRow`, `ProxyEnvRow`, `WhamProbeResult` 등 — doctor 진단 결과 타입
- `CodexPluginsDiagnostic` — 플러그인 진단 결과 구조체
- `oauthLoginSummary()` — OAuth 로그인 상태 배열 반환

이 내부 타입들을 CLI 표면으로 노출하기만 하면 된다.

---

## 3. 제안: `--json` 플래그 확장

### 3.1 대상 명령 및 우선순위

| 우선순위 | 명령 | 이유 | 기존 내부 타입 |
|----------|------|------|----------------|
| **P0** | `ocx doctor --json` | 환경 진단을 자동화/모니터링에 활용, 가장 복잡한 출력 | `PathRow[]`, `ProxyEnvRow[]`, `WhamProbeResult` |
| **P0** | `ocx sync --json` | 카탈로그 동기화 결과를 에이전트가 확인 | `CodexSyncResult` (이미 존재) |
| **P1** | `ocx service status --json` | 서비스 관리 자동화 | `serviceStatusSummary()` 확장 필요 |
| **P1** | `ocx ensure --json` | CI/에이전트 부트스트랩에서 가장 흔히 호출 | 신규 |
| **P2** | `ocx start --json` | 데몬 시작 결과 확인 (포트, PID) | 신규 |
| **P2** | `ocx stop --json` | 정리 결과 확인 | 신규 |
| **P3** | `ocx codex-shim status --json` | 마이너 — 단순 상태 | 신규 |

`ocx init`은 인터랙티브 명령이므로 `--json` 대상에서 제외한다.

### 3.2 JSON 스키마 제안

모든 `--json` 출력은 공통 엔벨로프를 사용한다:

```typescript
interface CliJsonEnvelope<T> {
  schemaVersion: 1;
  command: string;        // e.g. "doctor", "sync", "service status"
  success: boolean;       // 전체적인 성공/실패
  timestamp: string;      // ISO 8601
  data: T;
  warnings?: string[];    // 비치명적 경고 목록
  errors?: string[];      // 에러 메시지 목록
}
```

#### 3.2.1 `ocx doctor --json`

```typescript
interface DoctorJson {
  paths: Array<{
    label: string;       // "CODEX_HOME", "OPENCODEX_HOME" 등
    path: string;
    exists: boolean;
    fsType?: string;     // "ext4", "drvfs" 등 (Linux만)
    isDrvfs?: boolean;   // WSL drvfs 경고용
    isMntDrive?: boolean;
  }>;
  proxyEnv: {
    current: Array<{ key: string; present: boolean }>;
    configured: {
      present: boolean;
      configured: boolean;
      source: "default" | "file" | "fallback";
      detail: string;
    };
    runningProcess: {
      status: "not_running" | "ok" | "unavailable";
      pid: number | null;
      reason?: string;
      rows: Array<{ key: string; present: boolean }>;
    };
  };
  wham: {
    ok: boolean;
    url: string;
    status: number | null;
    durationMs: number;
    classification: "ok" | "timeout" | "connect_error" | string;
    authenticated: boolean;
  };
  hints: string[];
  overallHealthy: boolean;  // 모든 검사 통과 여부
}
```

사용 예시:
```bash
# 에이전트가 환경 건강 확인
ocx doctor --json | jq '.data.overallHealthy'

# WSL 환경 문제 감지
ocx doctor --json | jq '.data.paths[] | select(.isDrvfs == true)'

# WHAM 연결 문제 확인
ocx doctor --json | jq '.data.wham.classification'
```

#### 3.2.2 `ocx sync --json`

`CodexSyncResult`가 이미 존재하므로 그대로 노출:

```typescript
interface SyncJson {
  ok: boolean;
  added: number;           // 추가된 모델 수
  catalogPath: string | null;
  catalogExists: boolean;
  cacheSynced: boolean;
  message: string;
  warning?: string;
}
```

사용 예시:
```bash
# 동기화 후 추가된 모델 수 확인
ocx sync --json | jq '.data.added'

# 경고 확인
ocx sync --json | jq '.warnings // empty'
```

#### 3.2.3 `ocx service status --json`

```typescript
interface ServiceStatusJson {
  installed: boolean;
  running: boolean;
  manager: "launchd" | "systemd" | "task_scheduler" | null;
  platform: string;
  installState: {
    codexHome: string;
    opencodexHome: string;
    bunPath?: string;
    cliPath?: string;
  } | null;
  summary: string;        // 기존 serviceStatusSummary() 텍스트
  logPath: string | null;
}
```

사용 예시:
```bash
# 서비스 설치 여부 확인
ocx service status --json | jq '.data.installed'

# 서비스 로그 경로 확인
ocx service status --json | jq '.data.logPath'
```

#### 3.2.4 `ocx ensure --json`

```typescript
interface EnsureJson {
  proxyRunning: boolean;
  port: number;
  alreadyRunning: boolean;  // 이미 실행 중이었는지, 새로 시작했는지
  syncResult: SyncJson;
  autostartEnabled: boolean;
}
```

사용 예시:
```bash
# 프록시 포트 확인
ocx ensure --json | jq '.data.port'

# 새로 시작됐는지 확인
ocx ensure --json | jq '.data.alreadyRunning'
```

#### 3.2.5 `ocx start --json`

```typescript
interface StartJson {
  pid: number;
  port: number;
  portFallback: boolean;    // 요청한 포트 대신 다른 포트 사용 여부
  requestedPort: number;
}
```

> 참고: `ocx start`는 기본적으로 블로킹 모드이므로, `--json`이 함께 사용되면 시작 완료 후 JSON을 stdout에 출력하고 데몬 모드로 전환하거나, 별도의 `--json --detach` 조합을 요구하는 설계가 필요하다. 가장 실용적인 방식은 `ocx ensure --json`을 권장하는 것이다.

#### 3.2.6 `ocx stop --json`

```typescript
interface StopJson {
  stopped: boolean;
  pid: number | null;
  serviceWasStopped: boolean;   // 서비스 매니저도 중지했는지
  nativeCodexRestored: boolean;
}
```

---

## 4. 제안: 종료 코드 표준화

### 4.1 종료 코드 테이블

UNIX 관례와 `sysexits.h`, `curl` 등의 패턴을 참고한 설계:

| 코드 | 상수명 | 의미 | 예시 |
|------|--------|------|------|
| `0` | `EXIT_OK` | 성공 | 정상 완료 |
| `1` | `EXIT_GENERAL_ERROR` | 범용 에러 | 예상치 못한 런타임 에러 |
| `2` | `EXIT_USAGE_ERROR` | CLI 인자/사용법 오류 | 잘못된 옵션, 알 수 없는 명령 |
| `3` | `EXIT_CONFIG_ERROR` | 설정 파일 오류 | config.json 파싱 실패, 필수 값 누락 |
| `4` | `EXIT_STATE_CONFLICT` | 상태 충돌 | 이미 실행 중 (start), 실행 중이 아님 (stop) |
| `5` | `EXIT_NETWORK_ERROR` | 네트워크/연결 에러 | health check 실패, WHAM 타임아웃 |
| `6` | `EXIT_PARTIAL_FAILURE` | 부분 실패 | uninstall 중 일부 단계 실패 |
| `7` | `EXIT_HEALTH_WARNING` | 진단 경고 발견 | doctor가 문제를 감지 (현재는 exit 0) |
| `130` | `EXIT_SIGINT` | SIGINT (Ctrl-C) | 사용자 인터럽트 |

### 4.2 명령별 종료 코드 매핑

| 명령 | 현재 | 개선 후 |
|------|------|---------|
| `ocx start` (성공) | `0` (블로킹) | `0` |
| `ocx start` (이미 실행 중) | `1` | `4` (STATE_CONFLICT) |
| `ocx start` (포트 파싱 에러) | `1` | `2` (USAGE_ERROR) |
| `ocx stop` (성공) | `0` | `0` |
| `ocx stop` (프로세스 없음) | `0` ("No running proxy found") | `0` (멱등성 유지) |
| `ocx stop` (stop 실패) | `1` | `1` (GENERAL_ERROR) |
| `ocx ensure` (이미 실행 중) | `0` | `0` |
| `ocx ensure` (시작 실패) | `1` | `5` (NETWORK_ERROR) |
| `ocx ensure` (autostart 비활성) | `0` (텍스트만) | `0` |
| `ocx doctor` (정상) | `0` | `0` |
| `ocx doctor` (경고 발견) | `0` | `7` (HEALTH_WARNING) |
| `ocx sync` (성공) | `0` | `0` |
| `ocx sync` (카탈로그 없음) | `0` (경고 텍스트) | `7` (HEALTH_WARNING) |
| `ocx uninstall` (부분 실패) | `1` | `6` (PARTIAL_FAILURE) |
| `ocx service install` (환경 불일치) | `1` (throw) | `3` (CONFIG_ERROR) |
| 알 수 없는 명령 | `1` | `2` (USAGE_ERROR) |
| `--help` / `--version` | `0` | `0` |

### 4.3 구현 위치

```typescript
// src/exit-codes.ts (신규)
export const EXIT_OK = 0;
export const EXIT_GENERAL_ERROR = 1;
export const EXIT_USAGE_ERROR = 2;
export const EXIT_CONFIG_ERROR = 3;
export const EXIT_STATE_CONFLICT = 4;
export const EXIT_NETWORK_ERROR = 5;
export const EXIT_PARTIAL_FAILURE = 6;
export const EXIT_HEALTH_WARNING = 7;
export const EXIT_SIGINT = 130;
```

`cli.ts`의 모든 `process.exit(1)` 호출을 의미에 맞는 상수로 교체한다.

---

## 5. 제안: `--quiet` / `-q` 플래그

### 5.1 동작 정의

`--quiet` (또는 `-q`)가 전달되면:

1. **stdout에 아무것도 출력하지 않음** (성공 시)
2. **stderr에 치명적 에러만 출력**
3. **종료 코드로만 결과를 전달**

이는 `--json`과 상호 배타적이다. 둘 다 지정하면 `EXIT_USAGE_ERROR`(2)로 종료한다.

### 5.2 사용 시나리오

```bash
# CI 스크립트: 프록시 실행 확인만 (출력 불필요)
if ocx ensure -q; then
  echo "Proxy ready"
fi

# 셸 스크립트: doctor 결과를 종료 코드로만 확인
ocx doctor -q || echo "Environment issues detected (exit $?)"

# cron job: 서비스 상태 확인
ocx service status -q
```

### 5.3 명령별 `--quiet` 지원 범위

| 명령 | `--quiet` 지원 | 비고 |
|------|---------------|------|
| `ocx status` | O | 종료 코드 0=running, 4=not running |
| `ocx doctor` | O | 종료 코드 0=healthy, 7=warnings |
| `ocx ensure` | O | 종료 코드 0=running |
| `ocx sync` | O | 종료 코드 0=success |
| `ocx start` | X | 블로킹 명령 — quiet 의미 없음 |
| `ocx stop` | O | 종료 코드 0=stopped |
| `ocx service *` | O | 종료 코드로 결과 전달 |
| `ocx init` | X | 인터랙티브 — quiet 불가 |

---

## 6. 구현 접근법

### 6.1 글로벌 플래그 파싱

`cli.ts`의 진입점에서 `--json`과 `--quiet`를 전역으로 파싱한다:

```typescript
// src/cli-flags.ts (신규)
export interface CliGlobalFlags {
  json: boolean;
  quiet: boolean;
}

export function parseGlobalFlags(argv: string[]): {
  flags: CliGlobalFlags;
  rest: string[];  // 플래그가 제거된 나머지 인자
} {
  const json = argv.includes("--json");
  const quiet = argv.includes("--quiet") || argv.includes("-q");

  if (json && quiet) {
    console.error("--json and --quiet are mutually exclusive.");
    process.exit(EXIT_USAGE_ERROR);
  }

  const rest = argv.filter(a => a !== "--json" && a !== "--quiet" && a !== "-q");
  return { flags: { json, quiet }, rest };
}
```

### 6.2 출력 추상화

현재 각 핸들러가 직접 `console.log`를 호출하는 패턴을 출력 추상화 레이어로 감싼다:

```typescript
// src/cli-output.ts (신규)
import type { CliGlobalFlags } from "./cli-flags";
import type { CliJsonEnvelope } from "./cli-json";

export function createOutput(flags: CliGlobalFlags) {
  return {
    /** 사람이 읽는 일반 출력 */
    log(message: string): void {
      if (!flags.quiet && !flags.json) console.log(message);
    },

    /** 에러 출력 (quiet 모드에서도 stderr로 출력) */
    error(message: string): void {
      if (!flags.json) console.error(message);
    },

    /** JSON 모드일 때 구조화 결과 출력 */
    json<T>(envelope: CliJsonEnvelope<T>): void {
      if (flags.json) {
        console.log(JSON.stringify(envelope, null, 2));
      }
    },
  };
}
```

### 6.3 단계적 마이그레이션

한 번에 모든 명령을 변경하지 않고, 점진적으로 적용한다:

**Phase 1 (P0): 기반 + doctor + sync**
1. `src/exit-codes.ts` 생성
2. `src/cli-flags.ts` 생성
3. `src/cli-output.ts` 생성
4. `src/cli-json.ts`에 `CliJsonEnvelope` 타입 정의
5. `ocx doctor`에 `--json` 추가 — 내부 타입을 그대로 노출
6. `ocx sync`에 `--json` 추가 — `CodexSyncResult` 노출
7. `ocx doctor`의 종료 코드를 `EXIT_HEALTH_WARNING`으로 변경

**Phase 2 (P1): service + ensure**
1. `ocx service status --json` 추가
2. `ocx ensure --json` 추가
3. 해당 명령들의 종료 코드 세분화

**Phase 3 (P2): start/stop + quiet**
1. `ocx start/stop`에 `--json` 추가
2. `--quiet` 플래그 전체 적용
3. 모든 `process.exit(1)`을 의미별 상수로 교체

### 6.4 기존 `ocx status --json`과의 호환

현재 `ocx status --json`은 `CliStatusJson`을 직접 출력한다 (엔벨로프 없음):

```json
{
  "schemaVersion": 1,
  "proxy": { ... },
  ...
}
```

새로운 엔벨로프 형식과의 일관성을 위해 두 가지 선택지가 있다:

**선택지 A (권장): 기존 형식 유지 + 새 명령만 엔벨로프 적용**
- `ocx status --json`은 현재 스키마 유지 (`schemaVersion`으로 이미 버전 관리)
- 새로 추가되는 `--json`만 `CliJsonEnvelope`로 감쌈
- 장점: 하위 호환성 유지
- 단점: 두 가지 JSON 형식 공존

**선택지 B: v2 엔벨로프로 통일**
- `schemaVersion: 2`에서 모든 명령이 `CliJsonEnvelope`를 사용
- `ocx status --json`의 기존 `data`가 엔벨로프의 `data` 필드로 이동
- 장점: 일관성
- 단점: 기존 파서 깨짐 (현재 사용자가 적으면 허용 가능)

`schemaVersion`이 이미 있으므로, Phase 1에서는 **선택지 A**로 시작하고, 향후 메이저 버전에서 선택지 B로 마이그레이션하는 것을 권장한다.

---

## 7. 변경 범위 및 영향

### 7.1 신규 파일

| 파일 | 역할 |
|------|------|
| `src/exit-codes.ts` | 종료 코드 상수 |
| `src/cli-flags.ts` | 글로벌 플래그 파싱 |
| `src/cli-output.ts` | 출력 추상화 (log/error/json) |
| `src/cli-json.ts` | `CliJsonEnvelope` 타입 + 각 명령 JSON 타입 |

### 7.2 수정 파일

| 파일 | 변경 내용 |
|------|-----------|
| `src/cli.ts` | 글로벌 플래그 파싱, 핸들러에 flags/output 전달, exit 코드 교체 |
| `src/doctor.ts` | `runDoctor`에 `--json` 분기 추가, 진단 결과를 구조체로 수집하는 `collectDoctorDiagnostics()` 함수 추출 |
| `src/cli-status.ts` | (Phase 3에서) 엔벨로프 통일 시 수정 |
| `src/service.ts` | `serviceCommand`에 `--json` 분기 추가, `ServiceStatusJson` 수집 함수 추출 |
| `src/cli-help.ts` | help 텍스트에 `--json`, `--quiet` 옵션 설명 추가 |

### 7.3 영향 분석

- **하위 호환성**: `--json`/`--quiet` 없이 호출하면 기존과 동일한 출력. 종료 코드 변경만 주의 필요.
- **종료 코드 변경의 위험**: 현재 `exit(1)`에 의존하는 외부 스크립트가 있을 수 있음. 하지만 `exit(1)`은 여전히 "에러"를 의미하므로 `if ocx ...; then` 패턴은 깨지지 않음. 세분화된 코드(2-7)에 의존하는 스크립트는 아직 없으므로 위험 낮음.
- **`ocx status --json` 호환**: 선택지 A를 따르면 기존 파서 영향 없음.

---

## 8. 이점 요약

### 에이전트 사용 시나리오

```bash
# Codex 에이전트가 프록시 상태를 프로그래밍 방식으로 확인
STATUS=$(ocx status --json)
if echo "$STATUS" | jq -e '.proxy.running' > /dev/null; then
  PORT=$(echo "$STATUS" | jq -r '.listen.port')
  echo "Proxy on port $PORT"
fi

# 환경 진단을 JSON으로 수집하여 이슈 리포트에 첨부
ocx doctor --json > /tmp/ocx-diagnostics.json

# CI에서 모델 동기화 결과 확인
SYNC=$(ocx sync --json)
ADDED=$(echo "$SYNC" | jq '.data.added')
echo "Synced $ADDED models"

# 모니터링 스크립트에서 건강 체크
if ! ocx doctor -q; then
  alert "opencodex environment unhealthy (exit $?)"
fi
```

### 기대 효과

| 영역 | 현재 | 개선 후 |
|------|------|---------|
| 에이전트 통합 | 텍스트 파싱, 깨지기 쉬움 | JSON 스키마, 안정적 |
| 스크립트 자동화 | exit 0/1만 구분 | 7단계 종료 코드로 세밀한 분기 |
| CI/CD 파이프라인 | 이모지/텍스트 로그 오염 | `--quiet`로 깨끗한 로그 |
| 모니터링 | 수동 텍스트 파싱 | `jq` 기반 구조화 쿼리 |
| 디버깅 | `ocx doctor` 출력 복사-붙여넣기 | JSON 첨부로 정확한 진단 공유 |

---

## 9. 참고: 기존 `CliStatusJson` 구조

현재 `ocx status --json`의 출력 타입 (참고용):

```typescript
type CliStatusJson = {
  schemaVersion: 1;
  proxy: {
    running: boolean;
    pid: number | null;
    health: { ok: boolean; url: string; message: string };
  };
  dashboard: { url: string };
  listen: {
    port: number;
    hostname: string | null;
    source: "runtime" | "config";
  };
  paths: { config: string; pid: string; runtime: string };
  runtime: { source: string; overrideEnv?: string };
  codexAutostart: boolean;
  defaultProvider: string | null;
  config: { source: "default" | "file" | "fallback"; error: string | null };
  service: { summary: string };
  codexShim: { summary: string };
  codexPlugins: CodexPluginsDiagnostic;
};
```

이 구조는 `schemaVersion` 필드로 이미 하위 호환 전략이 잡혀 있으며, 새로운 `CliJsonEnvelope`의 설계 참고가 된다.
