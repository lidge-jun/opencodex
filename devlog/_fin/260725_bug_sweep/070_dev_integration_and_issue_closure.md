# WP7 — local dev 통합과 이슈/PR 종료

## 루프 계약

- **Archetype:** repair/integration
- **Trigger:** 사용자가 최신 local `dev` 위로 버그 스윕을 재배치하고 `dev`에 직접 반영한 뒤,
  이번 수정으로 해결되는 이슈와 대체되는 PR을 코멘트와 함께 닫으라고 승인했다.
- **Goal:** `codex/260725-bug-sweep`의 다섯 버그 수정만 최신 local `dev` 위에 보존하고,
  검증된 결과를 `origin/dev`에 게시한 뒤 GitHub 상태를 실제 결과와 맞춘다.
- **Non-goals:** #418, #417, #241, #420/#430, #435/#436, GUI enhancement, 릴리스와 `main`
  승격은 건드리지 않는다. #433의 CLI escape hatch와 GUI 가시화도 이번 종료 근거에 포함하지
  않는다.
- **Verifier:** `git merge-tree --write-tree`, rebase 뒤 focused tests와 `bun run prepush`,
  exact-SHA Cross-platform CI·Service lifecycle, 원격 `dev` SHA 대조, GitHub issue/PR 상태 재조회.
- **Stop condition:** local `dev`와 `origin/dev`가 같은 통합 SHA를 가리키고, #433/#432/#422/
  #373/#404가 근거 코멘트와 함께 closed이며, 대체되는 열린 PR만 닫혀 있다.
- **Memory artifact:** 이 문서 하단의 실행 영수증과 WP6 검증 기록.
- **Terminal outcomes:** DONE, BLOCKED(충돌·신규 회귀·원격 거부), UNSAFE(관련 없는 local `dev`
  변경을 덮어써야 하는 경우), NEEDS_HUMAN(해결 여부가 구현 근거만으로 확정되지 않는 경우).
- **Escalation:** 통합 충돌이나 테스트 회귀는 main session이 회수한다. 이슈/PR 종료 판단은
  독립 감사에서 blocker가 두 번 남으면 자동 종료하지 않고 사용자에게 되돌린다.

## 착수 시점 사실

- 작업 워크트리: `/Users/jun/.codex/worktrees/404d/opencodex`
- 버그 스윕 tip: `f76d79ef907185644997010d0091fc64e3b7d5c8`
- local `dev` tip: `f0db9188d11b87f45f5cca0f52d6e447b6b51428`
- fetch 뒤 `origin/dev`: `9b37ef5a926388e7570bd819512ac3dbc8ae18e5`
- local `dev`는 `origin/dev`보다 1커밋 앞서며, `dev` 워크트리에는 사용자 소유
  `devlog/_plan/.DS_Store` 수정이 있다. 이 파일은 stage, restore, commit하지 않는다.
- merge-base 이후 local `dev`의 41개 커밋과 계획·감사반영 커밋을 포함한 스윕의 16개 커밋은 변경 파일
  교집합이 없다. `git merge-tree --write-tree dev codex/260725-bug-sweep` 결과는 계획 문서를
  고칠 때마다 바뀌므로 rebase 직전에 실행해 영수증에 기록한다.

## 변경 계약

### 1. 스윕 브랜치 재배치

```diff
- codex/260725-bug-sweep: <옛 merge-base> + 16 commits
+ codex/260725-bug-sweep: local dev@f0db9188 + 같은 16개 논리 커밋
```

- 현재 clean 워크트리에서 `git rebase dev`를 실행한다.
- 충돌이 생기면 자동 해석하지 않고 파일별로 local `dev`와 스윕 의도를 대조한다.
- 재배치 뒤 `dev..codex/260725-bug-sweep`가 정확히 스윕 커밋 16개인지 확인한다.

### 2. 검증

focused activation tests:

```bash
bun test tests/codex-routing.test.ts tests/service.test.ts \
  tests/responses-compaction-routing.test.ts tests/cursor-blob.test.ts \
  tests/cursor-live-transport.test.ts tests/cursor-protobuf-events.test.ts \
  tests/adapter-resolve.test.ts tests/config.test.ts \
  tests/management-provider-validation.test.ts tests/codex-auth-context.test.ts \
  tests/chat-completions-endpoint.test.ts
```

full gates:

```bash
bun run prepush
cd gui && bun test tests && bun run build
```

- `prepush`가 요구하는 typecheck, GUI lint, isolated root test, privacy scan이 실패하면 push를
  중단한다. conditional React Doctor는 advisory이므로 출력은 기록하되 blocking gate로 과장하지
  않는다. GUI test/build는 위 별도 명령으로 검증한다. WP6 기준선은 진단 자료일 뿐 통과 예외가
  아니다.

### 3. local dev fast-forward와 push

```diff
- dev: f0db9188
+ dev: <rebased sweep tip>
```

- `/Users/jun/Developer/new/700_projects/opencodex`에서 `git merge --ff-only
  codex/260725-bug-sweep`를 실행한다.
- fast-forward 전에 `.DS_Store`의 `git hash-object` 값을 기록하고, 작업 뒤 같은 값인지 확인한다.
  수정 상태뿐 아니라 내용 해시가 같아야 한다.
- 원격 선행 변경이 없는지 한 번 더 fetch하고 `origin/dev`가 현재 local `dev`의 ancestor인지
  확인한 뒤 `git push origin dev`한다. force push는 사용하지 않는다.
- 첫 push의 SHA를 `IMPLEMENTATION_SHA`로 기록한다. `git ls-remote origin refs/heads/dev`와
  local SHA가 같아야 한다.
- `IMPLEMENTATION_SHA`에 대한 `Cross-platform CI`와 `Service lifecycle`이 모두 success가
  될 때까지 기다린다. 이전 SHA의 성공이나 로컬 테스트는 이 hosted gate를 대신하지 않는다.

### 4. GitHub 종료 범위

`IMPLEMENTATION_SHA`의 두 hosted gate가 성공한 뒤 다음 순서로 처리한다.

| 항목 | 조치 | 근거 |
|---|---|---|
| issue #433 | 구현 범위와 남은 CLI/GUI 후속을 구분해 코멘트 후 close | probe lease와 reset-derived 15분 상한이 핵심 stale cooldown을 해소 |
| issue #432 | 코멘트 후 close | 생략된 Task Scheduler 기본값과 explicit unsafe 값 회귀 테스트 |
| issue #422 | 코멘트 후 close | canonical forward capability gate와 synthetic path 회귀 테스트 |
| issue #373 | 코멘트 후 close | 실제 전송 payload 기반 request-local estimate와 restart/checkpoint-less 회귀 테스트 |
| PR #376 | 먼저 기여에 감사를 표하고 통합 구현이 dev에 들어갔음을 설명한 뒤 close | 같은 #373을 다루며 현재 reviewDecision은 CHANGES_REQUESTED |
| issue #404 | 코멘트 후 close | `modelAdapters` per-model override와 validator/resolver 회귀 테스트 |

- PR #376 외 다른 열린 PR은 이번 다섯 이슈를 직접 대체하지 않는다.
- #430/#436은 별도 버그를 해결하므로 유지한다. #408은 Windows elevation 문제라 #432와
  겹치지 않으므로 유지한다.
- 코멘트에는 `IMPLEMENTATION_SHA`와 해당 구현 커밋 SHA, 검증 결과를 넣는다. 모든 코멘트를
  먼저 게시하고 URL을 확인한 뒤 PR #376을 닫고, 마지막으로 이슈 다섯 건을 닫는다.
- #433에는 핵심 pinning 수정만 완료됐고 CLI clear-cooldown과 GUI 가시화는 이번 변경에 없다고
  명시한다. #404/#422는 제보자의 live gateway 재검증이 아니라 회귀 계약으로 닫는다고 밝힌다.
- 상태와 URL을 실행 영수증에 기록해 별도 docs-only receipt commit을 만든다. 이
  `RECEIPT_SHA`는 스윕 워크트리에서 만든다. local `dev`를 다시
  `git merge --ff-only codex/260725-bug-sweep`한 뒤 `dev`를 push하고 `.DS_Store` blob hash가
  여전히 같은지 확인한다.
- receipt는 docs-only라 push path filter가 두 hosted workflow를 자동 실행하지 않는다.
  `gh workflow run ci.yml --ref dev`와 `gh workflow run service-lifecycle.yml --ref dev`로 둘을
  수동 dispatch하고, `RECEIPT_SHA`에 매인 두 run이 success인지 확인한다. 이 두 번째 hosted
  gate가 끝나야 이 work-phase를 닫는다.

## 수용 기준

- rebase와 fast-forward가 비강제 방식으로 끝난다.
- 사용자 소유 `.DS_Store`의 전후 blob hash가 같다.
- focused tests, `bun run prepush`, GUI test/build가 0으로 끝난다.
- `IMPLEMENTATION_SHA`와 `RECEIPT_SHA` 각각의 Cross-platform CI·Service lifecycle이 성공한다.
- `origin/dev`가 최종 `RECEIPT_SHA`와 일치한다.
- #433/#432/#422/#373/#404와 PR #376의 최종 상태·코멘트 URL을 이 문서에 기록한다.

## 실행 영수증

### 재배치와 로컬 검증

- rebase 직전 merge tree: `34c4ba5626fee2246719464abaa7caf47596a0e9`
- local `dev` 기준: `f0db9188d11b87f45f5cca0f52d6e447b6b51428`
- rebase 결과: 16/16 무충돌, 스윕 tip `a5ec15e37f0ba39bf226ceb4357a6cc341efbfc0`
- focused activation tests: 11파일, **332 pass / 0 fail**
- `bun run prepush`: **4151 pass / 0 fail**, typecheck·GUI lint·privacy scan 통과
- GUI tests: **134 pass / 0 fail**
- GUI build: `tsc -b && vite build`, exit 0
- 사용자 소유 `devlog/_plan/.DS_Store` blob hash:
  `3a1ad0021f9ebeed0b59a514a836fce018b0ef71` (재배치·첫 ff-only 전후 동일)

### 첫 dev 게시와 hosted gate

- `IMPLEMENTATION_SHA`: `a5ec15e37f0ba39bf226ceb4357a6cc341efbfc0`
- local `dev` fast-forward: 성공
- `origin/dev` push: 성공, force 없음
- [Cross-platform CI run 30159409645](https://github.com/lidge-jun/opencodex/actions/runs/30159409645):
  success. Ubuntu/macOS/Windows와 npm-global 3개 job 전부 통과.
- [Service lifecycle run 30159409637](https://github.com/lidge-jun/opencodex/actions/runs/30159409637):
  success. Windows Task Scheduler, Linux systemd, macOS launchd 전부 통과.

### GitHub 코멘트와 종료

모든 코멘트를 먼저 게시하고 URL을 확인한 뒤 PR, 이슈 순으로 닫았다.

| 항목 | 코멘트 | 최종 상태 |
|---|---|---|
| #433 | [issuecomment-5078643748](https://github.com/lidge-jun/opencodex/issues/433#issuecomment-5078643748) | CLOSED / COMPLETED |
| #432 | [issuecomment-5078643797](https://github.com/lidge-jun/opencodex/issues/432#issuecomment-5078643797) | CLOSED / COMPLETED |
| #422 | [issuecomment-5078643875](https://github.com/lidge-jun/opencodex/issues/422#issuecomment-5078643875) | CLOSED / COMPLETED |
| #373 | [issuecomment-5078643829](https://github.com/lidge-jun/opencodex/issues/373#issuecomment-5078643829) | CLOSED / COMPLETED |
| #404 | [issuecomment-5078643932](https://github.com/lidge-jun/opencodex/issues/404#issuecomment-5078643932) | CLOSED / COMPLETED |
| PR #376 | [issuecomment-5078643983](https://github.com/lidge-jun/opencodex/pull/376#issuecomment-5078643983) | CLOSED / not merged |

- #433 코멘트는 핵심 pinning 수정과 미구현 CLI/GUI 후속을 분리했다.
- #404/#422 코멘트는 live private gateway 재검증이 아니라 회귀 계약으로 닫는다고 명시했다.
- 제외 대상 PR #408, #430, #436은 모두 OPEN / MERGEABLE 상태를 유지한다.

### Receipt 게시

이 문서 커밋을 `RECEIPT_SHA`로 삼아 스윕 브랜치에서 커밋한 뒤 local `dev`를 두 번째
ff-only로 올리고 push한다. docs-only path filter 때문에 자동 실행되지 않는 두 hosted workflow는
수동 dispatch하고 exact SHA를 확인한다.
