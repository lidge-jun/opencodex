# 120 - Preview 릴리스 플랜: Agent 레지스트리 테스트 격리

## Loop spec

- Archetype: C4 단일 릴리스 사이클.
- Trigger: 사용자 요청 - 현재 수정 커밋, push, preview 병합 및 배포.
- Goal: 실제 `~/.claude/agents`를 삭제하던 테스트 격리 결함을 고친 preview 패키지 배포.
- Non-goals: `.claude/` Agent worktree 정리, PR #111의 dev 병합, latest 태그 변경.
- Verifier: typecheck, 전체 Bun suite, privacy scan, preview 브랜치 Cross-platform CI,
  npm registry/version/dist-tag, GitHub prerelease.
- Stop: npm preview 태그가 새 버전을 가리키고 GitHub prerelease가 생성됨.
- Rollback: latest는 불변. preview 문제가 있으면 이전 preview dist-tag로 되돌리고 새 버전을
  삭제하지 않는다.
- Escalation: merge conflict, CI 실패, OIDC publish 실패, origin/preview SHA 경합 시 dispatch 중단.

## P - 변경 및 릴리스 맵

1. `src/server/management-api.ts` MODIFY
   - Claude 설정/서브에이전트 로스터 저장 후 같은 agent 정의 동기화 경로 호출.
   - OFF는 prune, ON은 재생성. provider discovery 실패 시 route-only fallback.
2. `tests/claude-management-api.test.ts` MODIFY
   - `CLAUDE_CONFIG_DIR`를 test temp dir로 격리.
   - OFF -> ON -> roster 변경의 파일 상태 회귀 테스트.
3. `claudecode` commit/push
   - 위 두 tracked 파일만 stage. `.claude/` 제외.
4. `preview` promotion
   - 임시 worktree에서 `origin/preview`에 `origin/claudecode` 병합 후 push.
5. preview publish
   - 현재 package의 `2.7.9-preview.20260712`는 기존 배포 버전이다. preview worktree에서
     새 `2.7.9-preview.20260712.1`로 bump.
   - release helper가 typecheck, bump commit/push, SHA 고정, Cross-platform CI 대기,
     release workflow publish 및 watch를 수행.

## A - 감사 체크

- 테스트가 실제 HOME/CLAUDE_CONFIG_DIR를 건드리지 않는가.
- ON/OFF 동기화가 사용자 소유 파일 보호 계약을 우회하지 않는가.
- 커밋에 `.claude/` 또는 devlog ignore 파일이 섞이지 않는가.
- preview 브랜치만 publish하며 `latest`는 2.7.8로 유지되는가.
- 새 버전/npm tag/GitHub release가 모두 미사용인가.

## C - 합격 기준

- `bun x tsc --noEmit`: exit 0.
- `bun test tests`: 0 fail, 실제 `~/.claude/agents` 6개 전후 동일.
- `bun run privacy:scan`: exit 0.
- GitHub Cross-platform CI: 새 preview release SHA 성공.
- `npm view @bitkyc08/opencodex dist-tags version --json`: preview가
  `2.7.9-preview.20260712.1`, latest는 `2.7.8`.
- GitHub prerelease `v2.7.9-preview.20260712.1` 존재.
