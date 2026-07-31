# 091 — D 요약 (work-phase 2, outcome: DONE)

## 무엇을 했나

커밋 `5875a0b5` (dev): cc-switch/CCR류 전환 도구가 `~/.claude/settings.json`
env에 남긴 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`이 `ocx claude`의 spawn
env를 덮어써 프록시 라우팅을 납치하는 문제 방어.

- `src/cli/claude.ts` — spawn env에 `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1`
  setDefault (사용자 `=0` export가 이김; isEnvTruthy상 유효한 opt-out).
- `gui/src/pages/claude-manual-env.ts` NEW — buildManualEnv 순수 모듈 추출,
  수동 안내 블록에 **조건부** 플래그 라인(복붙해도 기존 opt-out 유지).
- 테스트 6건 (claude-cli 매트릭스 3 + claude-manual-env 3).

## 감사 이력

sol explorer (Kepler) 2라운드. R1 **FAIL** (blockers=4): injectLever TDZ,
launchctl 주입이 Claude Desktop settings 모델 슬롯까지 strip, ocx claude
settings-model 회귀, plan-map/GUI 테스트 공백. Synthesis: **launchctl/shell-env
주입 전면 철회**(#1/#2 소멸), #3은 opt-out 명시된 의도적 계약 변경으로 수용,
#4는 map v2 + 모듈 추출 + 직접 테스트로 해소. R2 GO-WITH-FIXES (blockers=1):
GUI 무조건 export가 opt-out을 덮음 → 조건부 할당으로 fold. 최종 near-pass.

## 증거

- bun test 7파일: 91 pass / 0 fail / 559 expects. tsc root+gui green.
- 참조 소스 검증: managedEnv.ts:45-58 (플래그 게이트), :136-161
  (Object.assign 덮어쓰기), managedEnvConstants.ts:14-58 (strip 목록),
  envUtils.ts:32-36 (`=0` opt-out 유효). 설치된 2.1.212 바이너리에서 플래그
  문자열 41회 확인. cc-switch 패턴은 공식 문서/이슈로 확인(리뷰어).
- system-env.ts 무변경 (`git diff --stat` empty) — 철회 준수.

## LOOP-PESSIMIST-01

- 죽은 방향: launchctl 도메인 주입 — 도달 범위가 CCD까지라 부수 피해가
  방어 이득을 초과. spawn-env 한정이 옳은 경계.
- 의도적 회귀(문서화): `ocx claude`에서 settings.env 모델 슬롯이 strip됨.
  이전 사용자는 top-level `model` 필드나 `=0` opt-out으로 이전.
- 반증 시나리오: 플래그를 켰는데도 라우팅이 납치되면 settings 소스가
  trusted가 아닌 다른 주입 경로(프로젝트 로컬 settings의 SAFE_ENV_VARS,
  shell rc 직접 export)를 의심할 것.
