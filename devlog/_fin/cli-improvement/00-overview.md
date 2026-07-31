# ocx CLI 개선 이니셔티브 — 개요

> **문서 목적**: CLI 개선 제안 전체를 조감하는 실행 요약서.
> 모든 변경은 기존 동작을 깨뜨리지 않는 **추가적(additive) 확장**으로 설계한다.

---

## 1. Executive Summary

opencodex(`ocx`)는 Codex CLI/App/SDK에 임의의 LLM 프로바이더를 투명하게 연결하는
로컬 프록시다. 사람이 터미널에서 직접 쓸 때는 이미 잘 동작하지만, **에이전트(자동화
스크립트, CI, MCP 서버 등)가 프로그래밍 방식으로 제어**하기에는 부족한 부분이 있다.

이 이니셔티브의 목표는:

1. **비대화형(non-interactive) 워크플로 완전 지원** — 에이전트가 프롬프트 없이
   프로바이더를 추가·설정하고 프록시를 관리할 수 있게 한다.
2. **기계 판독 가능한 출력(machine-readable output)** — 모든 명령에 `--json` 플래그를
   제공하여 파싱 없이 구조화된 데이터를 얻을 수 있게 한다.
3. **셀프서비스 진단** — 모델 목록 조회, 상태 점검, 쉘 자동 완성 등으로 사용자와
   에이전트 모두 "지금 뭐가 되고 있는지"를 바로 알 수 있게 한다.

---

## 2. 현재 상태 평가

### 2.1 잘 되고 있는 것 (에이전트 친화적)

| 기능 | 설명 | 위치 |
|------|------|------|
| `ocx status --json` | 프록시 상태를 `schemaVersion: 1` JSON으로 반환. PID, 헬스체크, 경로, 서비스 상태, 프로바이더 정보 포함 | `src/cli-status.ts` |
| `ocx ensure` | 멱등(idempotent) 시작 — 이미 실행 중이면 모델 동기화만 수행, 아니면 백그라운드로 기동 | `src/cli.ts` `handleEnsure()` |
| 종료 코드(exit codes) | 실패 시 `process.exit(1)`, 알 수 없는 명령에도 비정상 종료 코드 반환 (총 13곳) | `src/cli.ts` |
| `ocx start --port <n>` | 포트 충돌 시 자동 fallback, 포트 지정 가능 | `src/cli.ts` `chooseListenPort()` |
| `ocx doctor` | 환경 진단 (경로, WSL fs 타입, 프록시 env, ChatGPT 도달성) | `src/doctor.ts` |
| 서비스 관리 | `ocx service install/start/stop/status/uninstall` — OS별 서비스 매니저 지원 | `src/service.ts` |
| 코덱스 shim | `ocx codex-shim install/status/uninstall` — 온디맨드 자동 시작 | `src/codex-shim.ts` |
| 깨끗한 정리 | `ocx stop`이 서비스 중지 + PID 정리 + 네이티브 Codex 복원까지 원자적으로 수행 | `src/cli.ts` `handleStop()` |

### 2.2 부족한 것 (에이전트 관점 갭)

| 갭 | 현재 상태 | 영향 |
|----|----------|------|
| **프로바이더 설정이 대화형 전용** | `ocx init`은 `readline` 기반 대화형 프롬프트만 지원. 에이전트가 프로바이더를 추가하려면 `config.json`을 직접 조작해야 함 | 자동화 불가 |
| **대부분의 명령에 `--json` 없음** | `status` 외에는 구조화된 출력 없음. `start`, `stop`, `sync`, `doctor` 등 모두 사람용 텍스트만 출력 | 에이전트가 결과를 파싱해야 함 |
| **모델 목록 조회 불가** | 구성된 프로바이더의 사용 가능 모델을 CLI에서 나열하는 명령이 없음 | "지금 뭘 쓸 수 있지?" 질문에 대한 답이 GUI에만 존재 |
| **헬스체크 전용 명령 없음** | `status`가 헬스체크를 포함하지만, 프로바이더별 연결 상태를 빠르게 확인하는 명령이 없음 | 문제 진단이 느림 |
| **도움말이 얕음** | `ocx help <cmd>`가 1-2줄 요약만 표시. 옵션, 예제, 환경변수, 부작용 설명 없음 | 에이전트가 `--help`로 사용법을 학습할 수 없음 |
| **셸 자동완성 없음** | bash/zsh/fish completions 미제공 | 터미널 UX 저하 |
| **manpage 없음** | `man ocx` 불가 | 오프라인 참조 불가 |

---

## 3. 우선순위 매트릭스

### P0 — 필수 (에이전트 워크플로의 핵심 차단 요소)

| 항목 | 설명 | 근거 |
|------|------|------|
| **비대화형 프로바이더 설정** | `ocx provider add --name anthropic --adapter anthropic --base-url https://api.anthropic.com --api-key $KEY --default-model claude-sonnet-4-6` 같은 CLI 명령 | 에이전트가 `config.json`을 직접 건드리지 않고도 프로바이더를 추가/수정/삭제할 수 있어야 함 |
| **기계 판독 가능 출력** | 모든 상태 변경 명령에 `--json` 플래그 추가. 성공/실패, 변경된 필드, 타임스탬프를 구조화된 JSON으로 반환 | `status --json`이 이미 좋은 선례. 나머지 명령으로 확대 |

### P1 — 높은 우선순위 (에이전트 경험 대폭 개선)

| 항목 | 설명 | 근거 |
|------|------|------|
| **상세 도움말** | `ocx help <cmd>`에 전체 옵션, 환경변수, 예제, 부작용을 표시. `--format=json` 시 도움말도 JSON으로 반환 | 에이전트가 `--help`를 읽어서 사용법을 자율 학습할 수 있음 |
| **헬스체크 명령** | `ocx health` — 프록시 + 각 프로바이더 연결 상태를 한눈에 (JSON 지원) | `doctor`는 환경 진단에 집중. `health`는 런타임 연결성에 집중 |
| **모델 목록** | `ocx models [--provider <name>] [--json]` — 구성된 모든 모델 나열, 라우팅 규칙 포함 | GUI 대시보드에서만 가능하던 것을 CLI로 |

### P2 — 있으면 좋음 (사용성 / 생태계)

| 항목 | 설명 | 근거 |
|------|------|------|
| **쉘 자동완성** | bash/zsh/fish completion 스크립트 생성 (`ocx completion bash`) | 사람 사용자의 터미널 경험 개선 |
| **manpage 생성** | `ocx --generate-manpage` 또는 빌드 시 생성 | 오프라인 참조, 패키지 매니저 배포 시 유용 |
| **설정 검증** | `ocx config validate [--json]` — 현재 config.json의 유효성 검사 | 에이전트가 설정 변경 후 검증 가능 |
| **버전 정보 확장** | `ocx version --json` — 버전, 런타임, Node/Bun 버전, OS 정보 포함 | 디버깅·리포트에 유용 |

---

## 4. 제안 명령/플래그 전체 목록

| 명령/플래그 | 유형 | 우선순위 | 상태 | 설명 |
|-------------|------|----------|------|------|
| `ocx provider add` | 새 명령 | P0 | 미구현 | 비대화형 프로바이더 추가 |
| `ocx provider remove <name>` | 새 명령 | P0 | 미구현 | 프로바이더 삭제 |
| `ocx provider list [--json]` | 새 명령 | P0 | 미구현 | 구성된 프로바이더 나열 |
| `ocx provider set-default <name>` | 새 명령 | P0 | 미구현 | 기본 프로바이더 변경 |
| `--json` (전역 플래그) | 플래그 확장 | P0 | `status`만 구현 | 모든 명령에 JSON 출력 |
| `ocx start --json` | 플래그 확장 | P0 | 미구현 | 시작 결과를 JSON으로 |
| `ocx stop --json` | 플래그 확장 | P0 | 미구현 | 종료 결과를 JSON으로 |
| `ocx sync --json` | 플래그 확장 | P0 | 미구현 | 동기화 결과를 JSON으로 |
| `ocx doctor --json` | 플래그 확장 | P1 | 미구현 | 진단 결과를 JSON으로 |
| `ocx health [--json]` | 새 명령 | P1 | 미구현 | 프록시 + 프로바이더 연결 점검 |
| `ocx models [--provider <n>] [--json]` | 새 명령 | P1 | 미구현 | 사용 가능 모델 나열 |
| `ocx help <cmd>` (상세화) | 기존 개선 | P1 | 부분 구현 | 옵션·예제·env 포함 상세 도움말 |
| `ocx completion <shell>` | 새 명령 | P2 | 미구현 | 쉘 자동완성 스크립트 출력 |
| `ocx config validate [--json]` | 새 명령 | P2 | 미구현 | 설정 파일 유효성 검사 |
| `ocx version --json` | 플래그 확장 | P2 | 미구현 | 확장 버전 정보 |

---

## 5. 마이그레이션 / 호환성 노트

### 5.1 변경 불가 원칙

- **기존 명령의 기본 동작은 바꾸지 않는다.** `ocx start`는 지금처럼 사람용 텍스트를
  출력하고, `--json`이 명시된 경우에만 JSON을 출력한다.
- **기존 종료 코드 체계를 유지한다.** 성공=0, 실패=1. 새 명령도 같은 규칙을 따른다.
- **`ocx status --json`의 `schemaVersion: 1` 스키마를 깨뜨리지 않는다.** 새 필드는
  추가만 하고, 기존 필드를 제거하거나 타입을 변경하지 않는다.
- **`ocx init`의 대화형 워크플로를 제거하지 않는다.** `ocx provider add`는
  별도 명령으로 추가하며, `init`은 사람용으로 그대로 유지한다.

### 5.2 하위 호환 전략

| 카테고리 | 접근 방식 |
|----------|-----------|
| 새 명령 (`provider`, `health`, `models`, `completion`) | 기존 switch/case에 추가. 알 수 없는 명령 핸들러는 변경 없음 |
| `--json` 플래그 | 각 핸들러 내부에서 옵트인 체크. 기본값은 항상 텍스트 |
| 도움말 상세화 | `helpEntries` 레코드에 `options`, `examples`, `envVars` 필드 추가. 기존 `summary`/`details` 필드 유지 |
| JSON 스키마 버전 | 모든 JSON 출력에 `schemaVersion` 필드 포함. 비호환 변경 시 버전 증가 |

### 5.3 환경변수 규칙

새 환경변수를 도입할 경우 `OPENCODEX_` 또는 `OCX_` 접두사를 사용한다.
기존 `OCX_SERVICE`, `OPENCODEX_API_AUTH_TOKEN` 등과 일관성을 유지한다.

---

## 6. 구현 순서 제안

아래 순서는 "앞 단계가 뒷 단계의 기반이 되는" 의존 관계와 에이전트 영향도를
기준으로 배치했다.

```
Phase 1: 기반 인프라
  ├─ 1a. --json 전역 파서 유틸리티 (공용 헬퍼)
  └─ 1b. HelpEntry 타입 확장 (options, examples, envVars)

Phase 2: P0 명령
  ├─ 2a. ocx provider add/remove/list/set-default
  ├─ 2b. ocx start --json, ocx stop --json
  └─ 2c. ocx sync --json, ocx ensure --json

Phase 3: P1 명령
  ├─ 3a. ocx health [--json]
  ├─ 3b. ocx models [--provider] [--json]
  ├─ 3c. ocx doctor --json
  └─ 3d. ocx help <cmd> 상세화

Phase 4: P2 보조 기능
  ├─ 4a. ocx completion <shell>
  ├─ 4b. ocx config validate [--json]
  └─ 4c. ocx version --json
```

각 Phase 내 항목은 독립적이므로 병렬 작업 가능하다. Phase 경계만 순서를 지키면 된다.

---

## 7. 설계 가이드라인

### 7.1 JSON 출력 규격

모든 `--json` 출력은 다음 최소 구조를 따른다:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "command": "start",
  "result": { ... },
  "timestamp": "2026-07-05T12:00:00.000Z"
}
```

- `ok: false`일 경우 `error` 필드에 메시지를 포함한다.
- JSON 모드에서는 이모지, ANSI 색상 코드를 출력하지 않는다.
- stderr에는 JSON을 출력하지 않는다. 로그/경고는 `--json` 시 `warnings` 배열로
  stdout JSON에 포함한다.

### 7.2 provider 명령 인터페이스 초안

```bash
# 추가
ocx provider add \
  --name anthropic \
  --adapter anthropic \
  --base-url https://api.anthropic.com \
  --auth-mode key \
  --api-key '$ANTHROPIC_API_KEY' \
  --default-model claude-sonnet-4-6

# 나열
ocx provider list              # 사람용 테이블
ocx provider list --json       # JSON 배열

# 삭제
ocx provider remove anthropic

# 기본 프로바이더 변경
ocx provider set-default google
```

`--api-key`에 `${ENV_VAR}` 형태의 환경변수 참조를 그대로 저장하여
config.json에 평문 키가 남지 않도록 한다 (기존 GUI 동작과 일치).

### 7.3 models 명령 인터페이스 초안

```bash
ocx models                                 # 전체 모델 목록
ocx models --provider anthropic            # 특정 프로바이더만
ocx models --json                          # JSON 출력
```

출력에는 모델 ID, 프로바이더, 컨텍스트 윈도우, 입력 모달리티를 포함한다.

### 7.4 health 명령 인터페이스 초안

```bash
ocx health                                 # 프록시 + 모든 프로바이더
ocx health --json                          # JSON 출력
```

각 프로바이더에 대해 `/v1/models` 엔드포인트에 경량 프로브를 보내고,
응답 시간과 HTTP 상태 코드를 리포트한다. OAuth 토큰 만료 여부도 포함한다.

---

## 8. 현재 버전 참고

- **패키지**: `@bitkyc08/opencodex`
- **버전**: `2.6.17-preview.20260701`
- **Node 요구**: `>=18`
- **CLI 엔트리**: `bin/ocx.mjs` -> `src/cli.ts`
- **도움말 시스템**: `src/cli-help.ts` (`HelpEntry` 레코드 기반)
- **상태 JSON**: `src/cli-status.ts` (`CliStatusJson` 타입, `schemaVersion: 1`)
- **진단**: `src/doctor.ts` (경로, WSL, 프록시 env, WHAM 프로브)
- **대화형 설정**: `src/init.ts` (readline 기반)

---

## 9. 관련 문서

이 디렉토리(`devlog/cli-improvement/`)에 각 개선 제안의 상세 설계 문서를 배치한다:

| 파일 | 내용 |
|------|------|
| `00-overview.md` | 이 문서 (전체 조감) |
| `01-provider-command.md` | `ocx provider` 서브커맨드 상세 설계 (예정) |
| `02-json-output.md` | `--json` 전역 플래그 구현 가이드 (예정) |
| `03-health-models.md` | `ocx health`, `ocx models` 설계 (예정) |
| `04-detailed-help.md` | `HelpEntry` 확장 및 상세 도움말 설계 (예정) |
| `05-shell-completion.md` | 쉘 자동완성 생성기 설계 (예정) |

---

*최종 수정: 2026-07-05*
