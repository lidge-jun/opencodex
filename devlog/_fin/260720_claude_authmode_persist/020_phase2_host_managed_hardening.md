# 020 — settings.env 라우팅 납치 방어 (CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST)

두 번째 work-phase (LOOP-UNIT-CHAIN-01 append; 000 work-phase map v2 참조).
R1 감사 FAIL 반영 개정판. 참고: `~/developer/codex/150_claude_code/src/utils/
managedEnv.ts`, `managedEnvConstants.ts`, `auth.ts`, `envUtils.ts` + cc-switch
공식 문서/이슈(리뷰어 웹 검증).

## 위협 모델 (검증됨)

- cc-switch류 전환 도구는 `~/.claude/settings.json`의 `env` 블록에
  `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`을 기록한다 (cc-switch docs
  5.1-config-files, issue #1790).
- Claude Code는 trusted settings.env를 `Object.assign(process.env, ...)`로
  적용해 **spawn env를 덮어쓴다** (managedEnv.ts:136-161). 즉 `ocx claude`가
  주입한 `ANTHROPIC_BASE_URL=127.0.0.1:PORT`는 잔재 설정에 조용히 납치된다.
- 방어: spawn env에 `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1`이 truthy면
  settings-sourced env에서 provider-managed 변수(BASE_URL/AUTH_TOKEN/API_KEY/
  OAUTH_TOKEN + 모델 슬롯 전부)가 strip된다 (managedEnv.ts:45-58,
  managedEnvConstants.ts:14-58). opt-out: `=0`은 isEnvTruthy에서 false
  (envUtils.ts:32-36 — `1|true|yes|on`만 true). 설치된 2.1.212 바이너리에
  플래그 문자열 존재 확인.

## R1 감사 반영 결정 (synthesis)

- **launchctl/shell-env 주입 철회** (R1 #2 accept): launchctl 도메인은 Claude
  Desktop/CCD까지 닿고, 플래그는 settings.env의 모델 슬롯도 strip하므로 CCD
  사용자 설정을 조용히 무효화한다. `src/server/system-env.ts`는 이 phase에서
  변경하지 않는다. (TDZ 블로커 R1 #1은 이 철회로 소멸.)
- **`ocx claude` 한정 적용** (R1 #3 부분 accept): `ocx claude`는 opencodex가
  라우팅을 소유하는 명시적 진입점이므로 플래그 기본 ON이 계약에 맞다.
  settings.env에 의도적 `ANTHROPIC_MODEL`을 둔 사용자는 (a) top-level `model`
  설정(strip 무관)으로 이전하거나 (b) `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=0`
  export로 opt-out — user-wins setDefault이므로 유효. 이 회귀는 문서화된
  의도적 계약 변경으로 수용한다.
- **GUI 수동 env 안내 포함, 테스트 가능하게 추출** (R1 #4 accept):
  `buildManualEnv`를 순수 모듈로 추출해 tests/에서 직접 검증한다.

## Scope

IN: `src/cli/claude.ts` buildClaudeEnv, `gui/src/pages/ClaudeCode.tsx`의 수동
env 빌더 추출(`gui/src/pages/claude-manual-env.ts` NEW) + 라인 추가, 테스트.
OUT: `src/server/system-env.ts`(launchctl/shell env — R1 #2로 철회),
apiKeyHelper류 설정 필드 방어, Claude Desktop 3P 경로, 구버전 클코 분기
(플래그 미지원 버전에선 무해한 no-op env var).

## Diffs

### MODIFY src/cli/claude.ts (buildClaudeEnv)

`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` setDefault 옆:

```ts
// Host-managed routing guard (devlog 260720 020): with this flag in the spawn
// env, Claude Code strips provider-managed vars (ANTHROPIC_BASE_URL/AUTH_TOKEN,
// model slots) from settings-sourced env (managedEnv.ts), so a leftover
// cc-switch/CCR ~/.claude/settings.json env block cannot hijack proxy routing.
// setDefault: an explicit user export (e.g. =0, isEnvTruthy-false) still wins.
// Intentional contract change: settings.env model slots are also stripped in
// ocx claude runs — use the top-level settings "model" field or opt out.
setDefault("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "1");
```

### NEW gui/src/pages/claude-manual-env.ts

`ClaudeCode.tsx`의 `buildManualEnv` + `MODEL_ENV_NAMES` + 관련 타입을 그대로
이동(순수 함수, React 의존 없음). GATEWAY_MODEL_DISCOVERY 라인 옆에 **조건부**
할당을 추가 (R2 #1: 무조건 export는 사용자 opt-out `=0`을 덮어씀 —
system-env.ts shell 파일의 기존 conditional 패턴과 동일):

```sh
[ -z "${CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST+x}" ] && export CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1
```

### MODIFY gui/src/pages/ClaudeCode.tsx

`buildManualEnv`/`MODEL_ENV_NAMES` 정의 제거, 새 모듈 import로 대체.

### NEW tests/claude-manual-env.test.ts

`gui/src/pages/claude-manual-env`를 import해 문자열 단언(bun은 TS 직접 로드):
proxy 모드 → AUTH_TOKEN 라인 + 플래그 라인 포함; subscription 모드 →
AUTH_TOKEN 주석 라인; 플래그 라인은 양쪽 모두 **conditional 형태**로 포함
(`[ -z "${CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST+x}" ]` 프리픽스 단언 — 기존
`=0` export가 있는 셸에서 복붙해도 opt-out이 유지됨을 계약으로 고정).

### MODIFY tests/claude-cli.test.ts

buildClaudeEnv 매트릭스 (활성 시나리오, R1 #3 대조군):

1. 기본 호출 → 플래그 === "1".
2. base에 `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "0"` pre-export → "0" 보존
   (user-wins opt-out).
3. opencodex model 설정 있음/없음 × 플래그 기본 ON — 모델 슬롯 주입 자체는
   플래그와 독립임을 단언(효과는 클코 내부이므로 여기선 spawn env 계약만).

## Accept criteria

- 위 테스트 전부 green: `bun test tests/claude-cli.test.ts
  tests/claude-manual-env.test.ts tests/claude-management-api.test.ts
  tests/system-env.test.ts` (system-env는 무변경 회귀 확인용).
- `bunx tsc --noEmit` green + gui 빌드 겸용 타입체크(`cd gui && bunx tsc
  --noEmit`)가 통과 — ClaudeCode.tsx 추출 후 타입 오류 없음.
- system-env.ts diff 없음 (`git diff --stat src/server/system-env.ts` empty).

## 020 완료 기록

이 phase의 D는 `091_done_phase2.md`로 기록 (090은 phase 1 전용으로 유지).
