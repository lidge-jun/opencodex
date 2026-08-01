# 110 - RCA: 워크플로우 이후 ocx 에이전트 레지스트리 소실

## 증상

- `ocx-gpt-5-6-sol` 파견이 처음에는 성공했지만, 저장소 평가 Agent가 테스트를 실행한 뒤
  같은 Claude Code 세션에서 `Agent type 'ocx-gpt-5-6-sol' not found`가 발생했다.
- 세션 JSONL에는 `ocx-*` 6개가 초기 등록된 뒤 모두 `removedTypes`로 내려간 기록이 남았다.

## 원인

- 평가 Agent가 `bun test tests`를 실행했다.
- `tests/claude-management-api.test.ts`는 `enabled: false` 저장을 검증하면서
  `CLAUDE_CONFIG_DIR`를 격리하지 않았다.
- production 코드의 즉시 prune이 테스트 프로세스의 실제 `~/.claude/agents/ocx-*.md`를
  삭제했고, Claude Code 파일 감시가 이를 감지해 실행 중 레지스트리에서도 제거했다.
- Workflow/Agent 레지스트리 자체의 모델 필터 문제가 아니었다.

## 수정

- Claude management API 테스트마다 임시 `CLAUDE_CONFIG_DIR`를 사용해 실제 사용자 홈을
  절대 건드리지 않게 했다.
- Claude 설정과 서브에이전트 로스터 저장을 모두 같은 동기화 함수에 연결했다.
  OFF는 즉시 prune하고, ON/로스터 변경은 즉시 정의를 다시 생성한다.
- provider 모델 조회가 잠시 실패해도 모델명과 route 정의는 빈 context map으로 복구하며,
  다음 launch-time sync가 `[1m]` 마커를 보정한다.

## 검증

- 실패 재현: 새 회귀 테스트가 구현 전 `ENOENT .../claude/agents`로 실패.
- 수정 후: `bun test tests/claude-management-api.test.ts tests/claude-agents-inject.test.ts`
  - 13 pass, 0 fail.
- `bun x tsc --noEmit`: exit 0.
- `bun test tests`: 2277 pass, 0 fail, 9657 assertions.
- 전체 suite 전후 실제 `~/.claude/agents`의 동일한 6개 파일이 유지됨을 확인했다.
- launchd 재시작 후 `PUT /api/claude-code {"injectAgents":true}`가 200을 반환했고,
  GET은 `enabled:true`, `injectAgents:true`, 실제 파일은 6개로 확인됐다.
