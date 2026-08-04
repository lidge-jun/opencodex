# 02. 비대화형(Non-Interactive) Config/Provider 관리

**상태**: 제안  
**날짜**: 2026-07-05  
**영향 범위**: `src/cli.ts`, `src/config.ts`, 신규 모듈 `src/cli-provider.ts`, `src/cli-config.ts`

---

## 문제 정의

### 현재 상황

`ocx init`은 `readline` 기반 대화형 프롬프트로만 동작한다(`src/init.ts`의 `createPrompt()`).
Provider를 추가/변경/삭제하거나 config 값을 수정하려면 다음 두 가지 방법뿐이다:

1. `ocx init`을 대화형으로 실행 (CI/에이전트/스크립트에서 불가능)
2. `~/.opencodex/config.json`을 직접 편집 (스키마 검증 없음, 오타 리스크)

### 구체적 문제점

1. **에이전트 자동화 불가**: Codex, CI 파이프라인, 셋업 스크립트에서 provider를 프로그래밍적으로 관리할 수 없다.
2. **스키마 불투명성**: `configSchema`(`src/config.ts`)와 `OcxProviderConfig`(`src/types.ts`)에 zod 기반 검증이 있지만, CLI 사용자에게 이 스키마가 노출되지 않는다. 어떤 필드가 필수인지, 어떤 adapter가 유효한지 알 수 없다.
3. **레지스트리 활용 불가**: `PROVIDER_REGISTRY`(`src/providers/registry.ts`)에 40개 이상의 사전 정의 provider가 있고, `providerConfigSeed()`(`src/providers/derive.ts`)가 완전한 config seed를 생성할 수 있지만, 이 기능을 `ocx init`의 대화형 메뉴 이외의 경로로 활용할 방법이 없다.
4. **시크릿 확인 불가**: config를 확인하려면 `cat ~/.opencodex/config.json`으로 전체 파일을 열어야 하고, API 키가 평문으로 노출된다.
5. **단일 provider 교체시 전체 덮어쓰기**: `ocx init`은 기존 providers를 유지하지 않고 선택한 하나의 provider로 전체 config를 새로 작성한다.

---

## 제안: 비대화형 서브커맨드

### 1. `ocx provider` 서브커맨드 그룹

#### `ocx provider list`

사용 가능한(레지스트리) + 현재 설정된 provider 목록을 출력한다.

```
$ ocx provider list
Configured providers (* = default):
  * openai          openai-responses  https://chatgpt.com/backend-api/codex  (forward)
    anthropic       anthropic         https://api.anthropic.com               (oauth)

Available from registry (not configured):
    xai             openai-chat       https://api.x.ai/v1                     (oauth)
    ollama          openai-chat       http://localhost:11434/v1                (local)
    ... (37 more — use --all to show)
```

**옵션**:
- `--all`: 레지스트리의 전체 목록 표시
- `--json`: JSON 형식 출력 (에이전트/스크립트용)
- `--configured`: 설정된 provider만 표시

**매핑**:
- `loadConfig()` → `config.providers` (설정된 목록)
- `PROVIDER_REGISTRY` → 전체 레지스트리 (사용 가능 목록)
- `config.defaultProvider` → 기본 provider 표시

---

#### `ocx provider add <name>`

새 provider를 config에 추가한다. 레지스트리에 있는 provider는 최소한의 옵션만으로 추가 가능.

```bash
# 레지스트리 provider — adapter/baseUrl 자동 채움
ocx provider add anthropic --api-key sk-ant-xxx

# 레지스트리 provider (OAuth) — api-key 불필요
ocx provider add xai

# 커스텀 provider — adapter와 base-url 필수
ocx provider add my-local \
  --adapter openai-chat \
  --base-url http://localhost:11434/v1 \
  --default-model llama3.1

# 기본 provider로 설정
ocx provider add deepseek --api-key sk-xxx --set-default
```

**옵션**:
- `--adapter <adapter>`: 어댑터 종류 (레지스트리 provider는 생략 가능)
- `--base-url <url>`: API 베이스 URL (레지스트리 provider는 생략 가능)
- `--api-key <key>`: API 키 (환경변수 참조 `${VAR}` 형식도 가능)
- `--default-model <model>`: 기본 모델
- `--set-default`: 이 provider를 defaultProvider로 설정
- `--auth-mode <mode>`: `key` | `forward` | `oauth` (레지스트리 기반 자동 결정)

**매핑**:
- 레지스트리 provider: `getProviderRegistryEntry(name)` → `providerConfigSeed(entry)` 로 기본값 채움
- `enrichProviderFromCatalog()` 또는 `enrichProviderFromRegistry()` 로 모델 메타데이터 보강
- `isValidProviderName(name)` 으로 이름 검증
- `providerBaseUrlConfigError(url)` 으로 URL 검증
- `saveConfig(config)` 으로 저장
- 기존 provider가 이미 존재하면 에러 (덮어쓰기는 `--force` 옵션)

**검증 체인**:
```
name 검증 (isValidProviderName)
  → 레지스트리 조회 (getProviderRegistryEntry)
  → baseUrl 검증 (providerBaseUrlConfigError)
  → headers 검증 (providerHeadersConfigError)
  → configSchema.safeParse (전체 config 검증)
  → saveConfig (atomic write)
```

---

#### `ocx provider remove <name>`

설정에서 provider를 제거한다.

```bash
$ ocx provider remove anthropic
✅ Provider 'anthropic' removed.

# defaultProvider인 경우
$ ocx provider remove openai
❌ Cannot remove default provider 'openai'. Change default first with:
   ocx provider add <other> --set-default
```

**매핑**:
- `hasOwnProvider(config.providers, name)` 으로 존재 확인
- `config.defaultProvider !== name` 검증 (기본 provider 삭제 방지)
- `delete config.providers[name]` → `saveConfig(config)`

---

#### `ocx provider show <name>`

특정 provider의 현재 config를 표시한다. 시크릿은 마스킹.

```
$ ocx provider show anthropic
Provider: anthropic
  adapter:      anthropic
  baseUrl:      https://api.anthropic.com
  authMode:     oauth
  apiKey:       sk-ant-***...***xyz  (masked)
  defaultModel: claude-sonnet-4-6
  models:       claude-sonnet-5, claude-opus-4-8, claude-opus-4-7, ...
  disabled:     false
```

**옵션**:
- `--json`: JSON 출력 (시크릿 마스킹 유지)
- `--unmask`: 시크릿 평문 표시 (명시적 opt-in)

**매핑**:
- `loadConfig()` → `config.providers[name]`
- 마스킹 함수: `apiKey` 필드에 대해 앞 6자 + `***...***` + 뒤 3자

---

#### `ocx provider set-default <name>`

기본 provider를 변경한다.

```bash
$ ocx provider set-default anthropic
✅ Default provider changed to 'anthropic'.
```

**매핑**:
- `hasOwnProvider(config.providers, name)` 검증
- `config.defaultProvider = name` → `saveConfig(config)`

---

### 2. `ocx config` 서브커맨드 그룹

#### `ocx config show`

현재 전체 config를 출력한다. 시크릿은 마스킹.

```
$ ocx config show
{
  "port": 10100,
  "defaultProvider": "openai",
  "providers": {
    "openai": {
      "adapter": "openai-responses",
      "baseUrl": "https://chatgpt.com/backend-api/codex",
      "authMode": "forward"
    }
  },
  "websockets": false,
  "codexAutoStart": true
}
```

**옵션**:
- `--unmask`: API 키 등 시크릿 평문 표시
- `--source`: config 소스 표시 (`"file"` | `"default"` | `"fallback"`)
- `--diagnostics`: `readConfigDiagnostics()` 결과 포함 (에러 정보)

**매핑**:
- `readConfigDiagnostics()` → 소스/에러 정보 포함 로드
- `loadConfig()` → 현재 유효 config
- 시크릿 마스킹: `providers.*.apiKey`, `codexAccounts.*.accessToken` 등

---

#### `ocx config get <key>`

dot-notation으로 특정 config 값을 조회한다.

```bash
$ ocx config get port
10100

$ ocx config get defaultProvider
openai

$ ocx config get providers.openai.adapter
openai-responses

$ ocx config get stallTimeoutSec
90  (default — not set in config file)
```

**옵션**:
- `--json`: 값을 JSON 형태로 출력 (객체/배열인 경우 유용)

---

#### `ocx config set <key> <value>`

dot-notation으로 특정 config 값을 설정한다.

```bash
$ ocx config set port 8080
✅ port = 8080

$ ocx config set websockets true
✅ websockets = true

$ ocx config set stallTimeoutSec 120
✅ stallTimeoutSec = 120

# 지원하지 않는 키
$ ocx config set unknownKey value
⚠️  'unknownKey' is not a recognized config key. Set anyway? (--force to skip)
```

**검증**:
- `configSchema`의 알려진 키에 대해서는 타입 검증 (number → 숫자 파싱, boolean → true/false)
- 전체 config에 대해 `configSchema.safeParse()` 실행 후 저장
- `.passthrough()` 덕분에 알려지지 않은 키도 저장 가능하지만 경고 표시

---

## 구현 설계

### 파일 구조

```
src/
├── cli.ts                  # switch(command)에 "provider", "config" case 추가
├── cli-provider.ts         # NEW — provider 서브커맨드 핸들러
├── cli-config.ts           # NEW — config get/set/show 핸들러
├── cli-help.ts             # helpEntries에 provider/config 항목 추가
├── config.ts               # 기존 — loadConfig, saveConfig, 검증 함수 재활용
├── providers/
│   ├── registry.ts         # 기존 — PROVIDER_REGISTRY, getProviderRegistryEntry
│   └── derive.ts           # 기존 — providerConfigSeed, enrichProviderFromRegistry
└── types.ts                # 기존 — OcxProviderConfig, OcxConfig
```

### `src/cli-provider.ts` 구현 스케치

```typescript
import {
  loadConfig, saveConfig, isValidProviderName,
  providerBaseUrlConfigError, hasOwnProvider,
} from "./config";
import {
  getProviderRegistryEntry, PROVIDER_REGISTRY,
} from "./providers/registry";
import { providerConfigSeed, enrichProviderFromRegistry } from "./providers/derive";
import type { OcxProviderConfig } from "./types";

export async function handleProvider(args: string[]): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case "list":    return handleProviderList(args.slice(1));
    case "add":     return handleProviderAdd(args.slice(1));
    case "remove":  return handleProviderRemove(args.slice(1));
    case "show":    return handleProviderShow(args.slice(1));
    case "set-default": return handleProviderSetDefault(args.slice(1));
    default:
      console.error("Usage: ocx provider <list|add|remove|show|set-default>");
      process.exit(1);
  }
}

function handleProviderAdd(args: string[]): void {
  const name = args[0];
  if (!name || !isValidProviderName(name)) {
    console.error("Invalid provider name.");
    process.exit(1);
  }

  const config = loadConfig();
  if (hasOwnProvider(config.providers, name) && !args.includes("--force")) {
    console.error(`Provider '${name}' already exists. Use --force to overwrite.`);
    process.exit(1);
  }

  // 레지스트리에서 기본값 시드
  const registryEntry = getProviderRegistryEntry(name);
  let provConfig: OcxProviderConfig;

  if (registryEntry) {
    provConfig = providerConfigSeed(registryEntry);
    // CLI 옵션으로 오버라이드
    const apiKey = parseOption(args, "--api-key");
    if (apiKey) provConfig.apiKey = apiKey;
    const model = parseOption(args, "--default-model");
    if (model) provConfig.defaultModel = model;
  } else {
    // 커스텀 provider — adapter, base-url 필수
    const adapter = parseOption(args, "--adapter");
    const baseUrl = parseOption(args, "--base-url");
    if (!adapter || !baseUrl) {
      console.error("Custom provider requires --adapter and --base-url.");
      process.exit(1);
    }
    const urlError = providerBaseUrlConfigError(baseUrl);
    if (urlError) {
      console.error(`Invalid base URL: ${urlError}`);
      process.exit(1);
    }
    provConfig = {
      adapter,
      baseUrl,
      ...(parseOption(args, "--api-key") ? { apiKey: parseOption(args, "--api-key")! } : {}),
      ...(parseOption(args, "--default-model") ? { defaultModel: parseOption(args, "--default-model")! } : {}),
      ...(parseOption(args, "--auth-mode") ? { authMode: parseOption(args, "--auth-mode") as "key" | "forward" | "oauth" } : {}),
    };
  }

  config.providers[name] = provConfig;
  if (args.includes("--set-default")) {
    config.defaultProvider = name;
  }

  saveConfig(config);
  console.log(`✅ Provider '${name}' added.`);
  if (args.includes("--set-default")) {
    console.log(`   Set as default provider.`);
  }
}

function parseOption(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}
```

### `src/cli.ts` 변경

```typescript
// 기존 switch(command) 블록에 추가:
case "provider": {
  const { handleProvider } = await import("./cli-provider");
  await handleProvider(args.slice(1));
  break;
}
case "config": {
  const { handleConfig } = await import("./cli-config");
  await handleConfig(args.slice(1));
  break;
}
```

### 시크릿 마스킹 유틸리티

```typescript
// src/cli-config.ts 또는 공용 유틸리티
export function maskSecret(value: string): string {
  if (value.length <= 8) return "***";
  return `${value.slice(0, 6)}***...***${value.slice(-3)}`;
}

export function maskConfigSecrets(config: OcxConfig): OcxConfig {
  const masked = structuredClone(config);
  for (const [, prov] of Object.entries(masked.providers)) {
    if (prov.apiKey) prov.apiKey = maskSecret(prov.apiKey);
  }
  // codexAccounts 토큰 등 추가 마스킹
  return masked;
}
```

---

## 기존 함수 매핑 요약

| 서브커맨드 | 사용하는 기존 함수 | 파일 |
|---|---|---|
| `provider list` | `loadConfig()`, `PROVIDER_REGISTRY` | `config.ts`, `registry.ts` |
| `provider add` | `getProviderRegistryEntry()`, `providerConfigSeed()`, `enrichProviderFromRegistry()`, `isValidProviderName()`, `providerBaseUrlConfigError()`, `saveConfig()` | `registry.ts`, `derive.ts`, `config.ts` |
| `provider remove` | `hasOwnProvider()`, `saveConfig()` | `config.ts` |
| `provider show` | `loadConfig()`, `hasOwnProvider()` | `config.ts` |
| `provider set-default` | `hasOwnProvider()`, `saveConfig()` | `config.ts` |
| `config show` | `readConfigDiagnostics()`, `loadConfig()` | `config.ts` |
| `config get` | `loadConfig()` | `config.ts` |
| `config set` | `loadConfig()`, `configSchema.safeParse()`, `saveConfig()` | `config.ts` |

---

## 추가 고려사항

### `ocx init`과의 관계

`ocx init`은 대화형 온보딩 경험으로 그대로 유지한다. 새 서브커맨드들은 `init` 이후 개별
provider를 추가/제거/수정하거나, 스크립트/에이전트에서 자동화할 때 사용한다.
`init`이 하는 "Codex config.toml 주입"과 "autostart shim 설치"는 별도 커맨드
(`ocx sync`, `ocx codex-shim install`)로 이미 존재하므로, `provider add` 이후
사용자가 필요시 개별 호출하면 된다.

### 환경변수 참조 지원

`--api-key '${ANTHROPIC_API_KEY}'` 형태로 환경변수 참조를 저장할 수 있다.
런타임에는 기존 `resolveEnvValue()` (`src/config.ts`)가 이를 해석한다.

### `--json` 출력 규약

모든 `--json` 출력은 stdout에 단일 JSON 객체로 출력하고, 메시지/경고는 stderr로
분리한다. `ocx status --json`의 기존 패턴을 따른다.

### 프록시 재시작 없는 핫 리로드

provider add/remove/set 이후 실행 중인 프록시가 있으면, config 파일 변경만으로
다음 요청부터 반영된다 (프록시는 요청마다 config를 다시 읽지는 않지만, `/api/` 엔드포인트를
통해 reload 시그널을 보내는 것도 고려 가능).

### 보안

- `--api-key` 값은 프로세스 인자로 노출되므로, 프로덕션에서는 `${ENV_VAR}` 형태를 권장한다.
- `config.json`은 `0o600` 퍼미션으로 저장된다 (`atomicWriteFile`의 기존 동작).
- `provider show`와 `config show`는 기본적으로 시크릿을 마스킹한다.
