# 070 — diff-level 플랜: Claude Code 에이전트 정의 동적 주입 (subagentModels 연동)

## Loop-spec (C2, 단일 work-phase, HITL + sol 감사)
- Trigger: 사용자 확정 — "서브에이전트 모델 설정 UX와 이어지는 5개(+자가 미포함 시 6개)
  동적 주입". 근거(전부 본 세션 실측): Agent 도구 model 인자는 4별칭 하드 enum,
  에이전트 정의 frontmatter `model:`은 자유 문자열, 티어 슬롯만으로는 메인 모델
  자기복제 파견 불가.
- Goal: `config.subagentModels`(<=5) + 메인 모델(미포함 시)을 `~/.claude/agents/ocx-*.md`
  커스텀 에이전트 정의로 동기화 — `subagent_type`으로 임의 라우팅 모델 파견 가능.
- Non-goals: 사용자 소유 에이전트 파일 접촉(ocx- 접두만 소유), 핫리로드(새 세션 반영),
  Desktop 3P.

## 설계
- 새 모듈 `src/claude/agents-inject.ts`:
  - `buildClaudeAgentDefs(config, windows)`: 엔트리(native slug 또는 provider/id) →
    `{ file: "ocx-<sanitized>.md", name, model, description }`. model은 가독형 별칭
    (`claudeCodeAlias`/`claudeCodeNativeAlias`) + auto-context 술어로 [1m] 마킹
    (`withOneMillionMarker` + `resolveAutoContext`). name 충돌 시 provider 접미.
  - self 보정: `claudeCode.model`이 로스터 밖이면 `ocx-self.md` 추가 (effective 값,
    [1m] 포함). 로스터 안이면 5개 유지(중복 생성 금지).
  - `syncClaudeAgentDefs(defs, dir)`: ocx-*.md만 쓰기/덮기/제거(소유 접두 계약),
    타 파일 불가침. best-effort(절대 throw 금지).
- 게이트: `claudeCode.injectAgents !== false` (기본 ON — gateway-cache 선기록과 동일
  급의 launch-time 동기화; 파일은 ocx- 접두로 식별 가능, 프록시 다운 시 무해).
- 훅: cmdClaude(컨텍스트 맵 확보 직후) + injectSystemEnv(모델 env 계산 직후, 3s bound
  밖 — 로컬 계산이라 fetch 불요, windows는 이미 계산된 것 재사용).
- GUI: Claude 페이지 토글 1행 + i18n 4로케일. management GET/PUT `injectAgents`.
- description: 한 줄 영어("Delegate to <id> (<provider>) via opencodex routing").

## 테스트
- def 빌더: 5+self / self 중복 억제 / [1m] 마킹 / bare vs provider-id / 이름 sanitize·충돌.
- sync: 생성·덮어쓰기·stale ocx-* 제거·비-ocx 불가침 (tmpdir).
- management API 왕복 + 검증(boolean).

## 게이트
tsc / bun test / gui build / docs 3로케일 / 라이브: agents 파일 생성 + 사용자 HOTL 파견 확인.
