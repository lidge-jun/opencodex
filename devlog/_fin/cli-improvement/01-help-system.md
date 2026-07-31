 # CLI 도움말 시스템 개선 제안서
 
 > 작성일: 2025-07-05
 > 대상: `src/cli-help.ts`, `src/cli.ts`, `src/cli-status.ts`
 
 ---
 
 ## 1. 현재 문제점
 
 ### 1.1 도움말 정보의 빈약함
 
 현재 `ocx help <cmd>`는 1-2줄의 요약만 출력한다. 예를 들어:
 
 ```
 $ ocx help status
 Usage: ocx status
 
 Check proxy server status.
 ```
 
 하지만 실제 `handleStatus()` (cli.ts:234-268)를 보면 `--json` 플래그를 받아
 JSON 형식으로 상태를 출력하는 기능이 있다:
 
 ```typescript
 // cli.ts:235-239
 const statusArgs = args.slice(1);
 const wantsJson = statusArgs.length === 1 && statusArgs[0] === "--json";
 ```
 
 사용자는 이 옵션의 존재를 소스 코드를 읽지 않는 한 알 수 없다.
 
 ### 1.2 옵션/플래그 미문서화
 
 소스 코드에서 확인되는 실제 옵션들이 도움말에 전혀 나타나지 않는다:
 
 | 서브커맨드 | 실제 옵션 | 도움말에 표시 |
 |-----------|----------|-------------|
 | `start` | `--port <port>` | usage 문자열에만 표시, 상세 설명 없음 |
 | `status` | `--json` | 표시 안 됨 |
 | `update` | `--tag latest\|preview` | usage 문자열에만 표시, 상세 설명 없음 |
 | `recover-history` | `--legacy-openai` | usage 문자열에만 표시, 상세 설명 없음 |
 | `restore` / `eject` | `back` (서브커맨드) | summary에 언급은 되지만 별도 옵션 설명 없음 |
 | `service` | `install\|start\|stop\|status\|uninstall\|remove` | details에 간략 언급 |
 | `codex-shim` | `install\|status\|uninstall\|remove` | details에 간략 언급 |
 
 ### 1.3 환경 변수 미문서화
 
 코드베이스 전체에서 다음 환경 변수들이 사용되지만, 도움말 어디에서도 안내하지 않는다:
 
 **핵심 환경 변수:**
 
 | 환경 변수 | 사용 위치 | 설명 |
 |----------|----------|------|
 | `CODEX_HOME` | `codex-paths.ts:7`, `codex-catalog.ts:38`, `config.ts:21`, `service.ts:66,180` | Codex 홈 디렉토리 경로 오버라이드 |
 | `OPENCODEX_HOME` | `config.ts:33`, `service.ts:181,470` | opencodex 설정 디렉토리 경로 오버라이드 |
 | `OPENCODEX_API_AUTH_TOKEN` | `server.ts:1539`, `service.ts:158,166`, `codex-inject.ts:60`, `login-cli.ts:11` | 비-루프백 바인딩 시 API 인증 토큰 |
 | `OPENCODEX_BUN_PATH` | `bun-runtime.ts:23,64` | Bun 런타임 경로 오버라이드 |
 | `CODEX_CLI_PATH` | `codex-catalog.ts:329` | Codex CLI 바이너리 경로 오버라이드 |
 | `OCX_SERVICE` | `cli.ts:149,215`, `star-prompt.ts:45`, `update-notify.ts:121` | 서비스 모드 플래그 (내부용) |
 | `OCX_DEBUG_FRAMES` | `debug.ts:7` | 프레임 디버깅 활성화 |
 
 **프로바이더 관련 환경 변수:**
 
 | 환경 변수 | 사용 위치 | 설명 |
 |----------|----------|------|
 | `GOOGLE_CLOUD_API_KEY` | `adapters/google.ts:42` | Google Cloud API 키 |
 | `GOOGLE_CLOUD_PROJECT` | `adapters/google.ts:286` | Google Cloud 프로젝트 ID |
 | `GOOGLE_CLOUD_LOCATION` | `adapters/google.ts:288` | Google Cloud 리전 |
 | `GOOGLE_APPLICATION_CREDENTIALS` | `lib/gcp-adc.ts:92,111` | GCP 서비스 계정 키 파일 경로 |
 | `OPENCODEX_CURSOR_TEST_TOKEN` | `adapters/cursor/live-transport.ts:80` | Cursor 테스트 토큰 |
 | `KIRO_ACCESS_TOKEN` | `oauth/kiro.ts:67` | Kiro 액세스 토큰 |
 | `KIRO_REGION` | `oauth/kiro.ts:87,99` | Kiro API 리전 |
 | `OPENCODEX_DEBUG_QUOTA` | `codex-auth-api.ts:314` | 쿼터 디버깅 활성화 |
 | `OPENCODEX_USAGE_DEBUG` | `usage-debug.ts:7` | 사용량 디버깅 활성화 |
 
 **네트워크/프록시 환경 변수 (config.ts:332-343에서 자동 설정):**
 
 | 환경 변수 | 설명 |
 |----------|------|
 | `HTTP_PROXY` / `http_proxy` | HTTP 프록시 |
 | `HTTPS_PROXY` / `https_proxy` | HTTPS 프록시 |
 | `NO_PROXY` / `no_proxy` | 프록시 제외 대상 |
 
 ### 1.4 HelpEntry 타입의 제한
 
 현재 타입 정의 (`cli-help.ts:8-12`):
 
 ```typescript
 type HelpEntry = {
   usage: string;
   summary: string;
   details?: string[];
 };
 ```
 
 `details`는 단순 문자열 배열이라 구조화된 정보(옵션 목록, 예시, 관련 커맨드 등)를
 표현할 수 없다. `printSubcommandUsage()`는 이 최소한의 구조를 그대로 출력할 뿐이다:
 
 ```typescript
 // cli-help.ts:93-100
 export function printSubcommandUsage(name: string | undefined): void {
   const entry = name ? helpEntries[name] : undefined;
   if (!entry) { /* error */ }
   console.log(`Usage: ${entry.usage}\n\n${entry.summary}`);
   if (entry.details?.length) console.log(`\n${entry.details.join("\n")}`);
 }
 ```
 
 ### 1.5 하드코딩된 메인 usage 문자열
 
 `printUsage()` (cli-help.ts:56-88)는 전체 사용법을 하나의 템플릿 리터럴로 하드코딩하고
 있다. `helpEntries` 레코드와 별도로 유지되므로 새 커맨드 추가 시 두 군데를 동기화해야
 한다. 실제로 `gui`, `update` 등의 usage 설명과 helpEntries의 summary가 미묘하게
 다른 부분이 이미 존재한다.
 
 ---
 
 ## 2. 제안: HelpEntry 스키마 확장
 
 ### 2.1 새로운 타입 정의
 
 ```typescript
 type HelpOption = {
   flag: string;           // e.g. "--port <port>", "--json", "--tag latest|preview"
   description: string;    // 한 줄 설명
   default?: string;       // 기본값 (있는 경우)
 };
 
 type HelpEnvVar = {
   name: string;           // e.g. "CODEX_HOME"
   description: string;    // 한 줄 설명
   scope?: "global" | "command";  // 전역 vs 특정 커맨드 전용
 };
 
 type HelpExample = {
   command: string;        // e.g. "ocx start --port 8080"
   description: string;    // 예시 설명
 };
 
 type HelpEntry = {
   usage: string;
   summary: string;
   details?: string[];
   options?: HelpOption[];
   envVars?: HelpEnvVar[];
   examples?: HelpExample[];
   seeAlso?: string[];     // 관련 커맨드 이름 배열 e.g. ["stop", "status", "service"]
 };
 ```
 
 ### 2.2 설계 원칙
 
 - **단일 소스**: `helpEntries` 레코드가 모든 도움말 정보의 유일한 원천이 된다.
   `printUsage()`도 이 레코드에서 동적으로 생성한다.
 - **점진적 공개**: `ocx --help`는 간결한 커맨드 목록, `ocx help <cmd>`는
   옵션/환경변수/예시를 포함한 상세 도움말을 보여준다.
 - **전역 환경 변수**: 모든 커맨드에 공통인 환경 변수(`CODEX_HOME`, `OPENCODEX_HOME` 등)는
   별도의 `globalEnvVars` 배열로 관리하고, `ocx help` (인자 없음) 하단에 표시한다.
 
 ---
 
 ## 3. 개선 후 출력 예시
 
 ### 3.1 `ocx help start`
 
 ```
 Usage: ocx start [--port <port>]
 
 Start the proxy server and sync models to Codex.
 
 The proxy starts on the configured port (default 10100), syncs provider models
 into Codex config, and blocks until interrupted (Ctrl-C). If the default port is
 busy, an available port is automatically selected.
 
 Options:
   --port <port>    Listen port (default: config.port or 10100)
 
 Environment Variables:
   CODEX_HOME              Codex home directory override (default: ~/.codex)
   OPENCODEX_HOME          opencodex config directory override (default: ~/.opencodex)
   OPENCODEX_API_AUTH_TOKEN API auth token (required for non-loopback binds)
   OPENCODEX_BUN_PATH      Override the Bun runtime binary path
 
 Examples:
   ocx start               Start on default port (10100)
   ocx start --port 8080   Start on custom port
 
 See also: stop, status, service, ensure
 ```
 
 ### 3.2 `ocx help status`
 
 ```
 Usage: ocx status [--json]
 
 Check proxy server status.
 
 Displays proxy health, PID, listen port, dashboard URL, config paths, runtime
 source, default provider, service state, Codex shim state, plugin diagnostics,
 and OAuth login status.
 
 Options:
   --json    Output status as JSON (schema version 1)
 
 Environment Variables:
   OPENCODEX_HOME    opencodex config directory override
   CODEX_HOME        Codex home directory override
 
 Examples:
   ocx status          Human-readable status overview
   ocx status --json   Machine-readable JSON output
 
 See also: doctor, start, service
 ```
 
 ### 3.3 `ocx --help` (메인 도움말 하단 추가)
 
 기존 커맨드 목록 아래에 다음 섹션을 추가:
 
 ```
 Environment Variables:
   CODEX_HOME               Codex home directory (default: ~/.codex)
   OPENCODEX_HOME           opencodex config directory (default: ~/.opencodex)
   OPENCODEX_API_AUTH_TOKEN  API auth token for non-loopback binds
   OPENCODEX_BUN_PATH       Override the Bun runtime binary path
   CODEX_CLI_PATH           Override the Codex CLI binary path
   OCX_DEBUG_FRAMES         Set to "1" to enable frame debugging
 
 Run 'ocx help <command>' for detailed help on a specific command.
 ```
 
 ---
 
 ## 4. 구현 스케치
 
 ### 4.1 `cli-help.ts` 수정 계획
 
 #### 단계 1: 타입 확장 및 전역 환경 변수 정의
 
 ```typescript
 // -- 새로운 타입 정의 (기존 HelpEntry 교체) --
 
 type HelpOption = {
   flag: string;
   description: string;
   default?: string;
 };
 
 type HelpEnvVar = {
   name: string;
   description: string;
   scope?: "global" | "command";
 };
 
 type HelpExample = {
   command: string;
   description: string;
 };
 
 type HelpEntry = {
   usage: string;
   summary: string;
   details?: string[];
   options?: HelpOption[];
   envVars?: HelpEnvVar[];
   examples?: HelpExample[];
   seeAlso?: string[];
 };
 
 // -- 전역 환경 변수 (모든 커맨드에 공통) --
 
 const globalEnvVars: HelpEnvVar[] = [
   { name: "CODEX_HOME", description: "Codex home directory (default: ~/.codex)" },
   { name: "OPENCODEX_HOME", description: "opencodex config directory (default: ~/.opencodex)" },
   { name: "OPENCODEX_API_AUTH_TOKEN", description: "API auth token for non-loopback binds" },
   { name: "OPENCODEX_BUN_PATH", description: "Override the Bun runtime binary path" },
   { name: "CODEX_CLI_PATH", description: "Override the Codex CLI binary path" },
   { name: "OCX_DEBUG_FRAMES", description: 'Set to "1" to enable frame debugging' },
 ];
 ```
 
 #### 단계 2: helpEntries 보강 (대표 예시)
 
 ```typescript
 const helpEntries: Record<string, HelpEntry> = {
   start: {
     usage: "ocx start [--port <port>]",
     summary: "Start the proxy server and sync models to Codex.",
     details: [
       "The proxy starts on the configured port (default 10100), syncs provider",
       "models into Codex config, and blocks until interrupted (Ctrl-C). If the",
       "default port is busy, an available port is automatically selected.",
     ],
     options: [
       { flag: "--port <port>", description: "Listen port", default: "config.port or 10100" },
     ],
     envVars: [
       { name: "OPENCODEX_API_AUTH_TOKEN", description: "Required for non-loopback hostname binds" },
     ],
     examples: [
       { command: "ocx start", description: "Start on default port (10100)" },
       { command: "ocx start --port 8080", description: "Start on custom port" },
     ],
     seeAlso: ["stop", "status", "service", "ensure"],
   },
   status: {
     usage: "ocx status [--json]",
     summary: "Check proxy server status.",
     details: [
       "Displays proxy health, PID, listen port, dashboard URL, config paths,",
       "runtime source, default provider, service state, Codex shim state,",
       "plugin diagnostics, and OAuth login status.",
     ],
     options: [
       { flag: "--json", description: "Output status as JSON (schema version 1)" },
     ],
     examples: [
       { command: "ocx status", description: "Human-readable status overview" },
       { command: "ocx status --json", description: "Machine-readable JSON output" },
     ],
     seeAlso: ["doctor", "start", "service"],
   },
   // ... 나머지 커맨드도 동일한 패턴으로 보강
 };
 ```
 
 #### 단계 3: 출력 함수 리팩터링
 
 ```typescript
 function formatOptions(options: HelpOption[]): string {
   const maxFlagLen = Math.max(...options.map(o => o.flag.length));
   return options
     .map(o => {
       const padded = o.flag.padEnd(maxFlagLen + 4);
       const def = o.default ? ` (default: ${o.default})` : "";
       return `  ${padded}${o.description}${def}`;
     })
     .join("\n");
 }
 
 function formatEnvVars(envVars: HelpEnvVar[]): string {
   const maxNameLen = Math.max(...envVars.map(e => e.name.length));
   return envVars
     .map(e => `  ${e.name.padEnd(maxNameLen + 4)}${e.description}`)
     .join("\n");
 }
 
 function formatExamples(examples: HelpExample[]): string {
   const maxCmdLen = Math.max(...examples.map(e => e.command.length));
   return examples
     .map(e => `  ${e.command.padEnd(maxCmdLen + 4)}${e.description}`)
     .join("\n");
 }
 
 export function printSubcommandUsage(name: string | undefined): void {
   const entry = name ? helpEntries[name] : undefined;
   if (!entry) {
     console.error(`Unknown command: ${name ?? ""}`.trim());
     printUsage();
     process.exit(1);
   }
 
   const lines: string[] = [];
   lines.push(`Usage: ${entry.usage}`, "");
   lines.push(entry.summary);
 
   if (entry.details?.length) {
     lines.push("", entry.details.join("\n"));
   }
 
   if (entry.options?.length) {
     lines.push("", "Options:", formatOptions(entry.options));
   }
 
   // 커맨드 전용 환경 변수 + 관련 전역 환경 변수
   const envVars = [
     ...(entry.envVars ?? []),
     ...globalEnvVars.filter(g =>
       // 커맨드 전용에 이미 있으면 중복 제거
       !entry.envVars?.some(e => e.name === g.name)
     ),
   ];
   // 서브커맨드 도움말에서는 커맨드 관련 전역 변수만 선별적으로 표시할 수도 있다.
   // 단순히 전부 표시하는 것이 초기 구현으로 적절하다.
   if (entry.envVars?.length) {
     lines.push("", "Environment Variables:", formatEnvVars(entry.envVars));
   }
 
   if (entry.examples?.length) {
     lines.push("", "Examples:", formatExamples(entry.examples));
   }
 
   if (entry.seeAlso?.length) {
     lines.push("", `See also: ${entry.seeAlso.join(", ")}`);
   }
 
   console.log(lines.join("\n"));
 }
 ```
 
 #### 단계 4: printUsage()를 helpEntries에서 동적 생성
 
 ```typescript
 export function printUsage(): void {
   const header = `opencodex (ocx) -- Universal provider proxy for Codex\n\nUsage:`;
 
   // helpEntries에서 커맨드 목록 동적 생성
   const commandLines = Object.entries(helpEntries)
     .filter(([name]) => !isAlias(name))  // remove/eject 같은 alias 제외
     .map(([_, entry]) => `  ${entry.usage.padEnd(30)} ${entry.summary}`);
 
   const footer = [
     `  ocx help [command]          Show help`,
     `  ocx --version | -v          Print version`,
     "",
     "Environment Variables:",
     formatEnvVars(globalEnvVars),
     "",
     "Run 'ocx help <command>' for detailed help on a specific command.",
   ];
 
   console.log([header, ...commandLines, "", ...footer].join("\n"));
 }
 ```
 
 ### 4.2 변경 범위 요약
 
 | 파일 | 변경 내용 |
 |-----|---------|
 | `src/cli-help.ts` | HelpEntry 타입 확장, helpEntries 보강, 출력 함수 리팩터링, printUsage() 동적 생성 |
 | `src/cli.ts` | 변경 없음 (cli-help.ts의 public API는 유지) |
 | `src/cli-status.ts` | 변경 없음 (status의 `--json` 옵션은 helpEntries에만 추가) |
 
 ### 4.3 구현 우선순위
 
 1. **P0 (즉시)**: HelpEntry 타입 확장 + `start`, `status`, `service`, `update` 보강
 2. **P1 (이후)**: 나머지 커맨드 보강 + printUsage() 동적 생성
 3. **P2 (선택)**: `ocx help --all`로 전체 환경 변수 / 옵션 일람 출력
 
 ### 4.4 호환성
 
 - 기존 `HelpEntry` 타입의 모든 필드가 유지되므로 하위 호환성 문제 없음
 - `printSubcommandUsage()`와 `printUsage()`의 시그니처 변경 없음
 - 추가 필드는 모두 optional이므로 점진적으로 채워나갈 수 있음
