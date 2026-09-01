# 131 — 워크트리 정리 상태

유닛이 끝난 뒤 이 워크트리(`/Users/jun/.codex/worktrees/89ca/opencodex`)를
`dev` 최신(`b27bab041`)에 맞췄다.

`codex/remote-hub-restack-roadmap`은 #3149로 스쿼시 머지됐다. 스쿼시라 로컬
브랜치의 39개 커밋이 `dev`의 커밋 하나와 조상 관계를 갖지 않아 fast-forward가
되지 않는다. 내용은 동일하다 — `git diff origin/dev HEAD -- devlog/`가 빈
출력이다.

그래서 리셋 대신 이렇게 했다:

- `codex/remote-hub-restack-roadmap-archive` — 원래 39커밋 히스토리를 보존.
  스쿼시가 지운 커밋 단위 기록이 필요할 때 여기 있다.
- `codex/remote-hub-closeout` — `origin/dev`에서 새로 시작한 현재 브랜치.

`git reset --hard`는 쓰지 않았다. 스쿼시 머지 후의 갈라짐은 파괴적 명령으로
풀 문제가 아니라 브랜치를 하나 더 만들면 되는 문제다.
