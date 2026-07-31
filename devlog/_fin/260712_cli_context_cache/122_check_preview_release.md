# 122 - C/D 기록: Agent 레지스트리 preview 배포

## 커밋과 승격

- fix: `47cae4df` - `fix(claude): isolate agent registry tests and resync definitions`
- claudecode CI: `29186385820`, 6 jobs success.
- preview merge: `77b10ec6`.
- release bump: `9550a7d6` - `release: v2.7.9-preview.20260712.1`.

## 릴리스 게이트

- preview Cross-platform CI `29186509792`: 6 jobs success, head `9550a7d6`.
- Release `29186583158`: publish success, registry smoke success, GitHub release success.
- npm version: `2.7.9-preview.20260712.1`.
- dist-tags: `preview=2.7.9-preview.20260712.1`, `latest=2.7.8` 불변.
- GitHub prerelease: `v2.7.9-preview.20260712.1`, target `9550a7d6`.
- remote: `preview` branch와 release tag가 모두 `9550a7d6`을 가리킴.

## 마찰 기록

- PR #111이 dev와 conflict 상태라 pull_request CI가 생성되지 않았다. 같은 head SHA로
  workflow_dispatch Cross-platform CI를 실행해 merge 전 게이트를 대체했다.
- 첫 release helper 실행은 새 worktree에 node_modules가 없어 `bun-types` typecheck 실패.
  package/version/push 전 중단됐고 tree는 clean이었다. `bun install --frozen-lockfile` 후
  같은 helper를 재실행해 성공했다.
