# 260712 claudecode → dev 머지 플랜

## 상황 (프리플라이트 실측)

- `claudecode` HEAD: `47cae4df` — dev 분기점(`953fb5b9`) 위 53커밋. origin/claudecode와 동기화 완료(0 차이).
- 로컬 `dev`: `953fb5b9` (= merge-base). **origin/dev와 갈라짐.**
- `origin/dev`: `28afa74c` — PR #96~#103 배치 약 24커밋(SSRF/디컴프레션 보안, CI/릴리스 강화, GUI lint, Windows 픽스처, 디버그 로그 페이지 등).
- **머지 연산의 실제 base**: `git merge-base claudecode origin/dev` = `182ddae9` (v2.7.8). `953fb5b9`는 dev/claudecode 분기점일 뿐이므로, 953fb5b9 기준 비교는 origin/dev에 없는 변경을 dev쪽 되돌림으로 오독할 수 있음 (감사 지적 #1).
- 겹치는 파일 17개, `git merge-tree --write-tree claudecode origin/dev` 실측 충돌 **2개**:
  - `gui/src/pages/Debug.tsx` — 탭 충돌이 아니라 **렌더링 아키텍처 충돌**: dev(#103)는 `entries` 상태 기반 injection-stream 렌더링으로 재작성했고, claudecode 훙크는 여전히 `lines`/`useVirtualizer`/`scrollContainerRef`를 참조. **해소 방침: dev의 `entries` 아키텍처를 채택하고 그 위에 claudecode의 Claude inbound 패널을 접붙인다** (가상화가 필요하면 `entries` 기준으로 재적용).
  - `src/server/management-api.ts` — 인접 라우트 블록 충돌: claudecode의 `/api/claude/inbound-debug` 핸들러와 dev의 `/api/debug/injection-logs` 핸들러가 같은 위치에 삽입됨. **해소 방침: 두 독립 라우트 블록을 모두 유지** (순서 무관, 제어 흐름 훼손 금지). SSRF 등 보안 추가분은 자동 머지 영역이므로 충돌 해소 대상 아님.

### 시그니처 방향 정정 (재감사 지적 #1)

- `ManagementApiDeps` / `handleManagementAPI`의 deps 4번째 인자 / `getLogicalMaxThreads` / `transitionMultiAgentV2`는 **953fb5b9가 추가한 claudecode-계보 API**다. origin/dev(base 182ddae9)에는 애초에 없었을 뿐, 제거된 것이 아니다 (`git diff 182ddae9..origin/dev`에 features.ts/codex-v2-gate.test.ts 변경 없음).
- 따라서 머지 결과는 이들 API를 **그대로 유지**한다 (src/cli/v2.ts, management-api.ts, tests가 활성 소비자). 절대 제거/리네임하지 않는다.
- origin/dev가 management-api.ts에 기여하는 것: `/api/debug/injection-logs` 엔드포인트, provider 쓰기 시 DNS-resolved SSRF 체크(`providerDestinationResolvedError`), `allowPrivateNetwork` 노출. 합성 트리가 이미 올바르게 결합함.

## 전략 결정: merge (rebase/cherry-pick 배제)

| 옵션 | 판정 | 근거 |
|------|------|------|
| rebase claudecode onto origin/dev | 배제 | 53커밋이 이미 origin/claudecode에 게시됨 → 강제푸시 + 히스토리 재작성. 충돌도 커밋 단위로 반복 발생 위험 |
| cherry-pick 53커밋 | 배제 | 중복 커밋 53개, SHA 추적성 상실, 최악의 선택지 |
| **merge origin/dev → claudecode, dev를 ff** | 채택 | 충돌 1회 해소, 게시된 히스토리 보존, dev는 fast-forward로 깔끔하게 따라감 |

## 실행 순서

1. `claudecode`에서 `git merge origin/dev` — 충돌 2파일 수동 해소 (양쪽 의도 모두 보존: claude 기능 + 보안/로그 하드닝)
2. 검증 게이트 (origin/dev ci.yml 전체 재현, 푸시 전 로컬 통과 필수 — 감사 지적 #3, 재감사 #2):
   - `bun x tsc --noEmit` (루트 타입체크)
   - `bun test --isolate` (전체 테스트)
   - `bun run privacy:scan`
   - GUI lint + build
   - `bun build scripts/release.ts --target=bun --outdir=.tmp/ci-release-script-check` (release 헬퍼 컴파일)
   - CLI help 스모크: `bun run src/cli/index.ts help`
   - npm-global 스모크: `npm install` → `npm run build:gui` → `npm pack` → packed GUI 확인 → global install → `ocx help`
3. sol 서브에이전트 충돌 해소 감사 (VERDICT PASS 필요)
4. `claudecode` 푸시 → `dev`를 claudecode로 fast-forward → `origin/dev` 푸시
   - 머지 커밋은 claudecode/origin/dev 양쪽을 조상으로 가지므로 dev·origin/dev 모두 ff 가능 (dev-측 별도 머지 커밋 불필요, 감사 확인 #5). first-parent 체인이 claudecode를 따라가지만 --first-parent 의존 툴링 없음 확인됨.
5. `dev..claudecode = 0` 확인, devlog 종결 기록

## 리스크

- Debug.tsx 접붙이기에서 claudecode 가상화 코드가 dev `entries` 구조와 어긋나면 런타임 오류 → GUI build + 수동 스모크로 확인
- 자동 머지 파일(auth-cors.ts, responses.ts, types.ts, registry.ts)은 합성 트리 검사로 양쪽 의미 보존 확인됨(감사 #4) — tsc + 테스트로 재확인
- package.json은 `2.7.9-preview.20260712` + `bun test --isolate`로 올바르게 합성됨. lockfile/dist 충돌 없음. ci.yml은 origin/dev만 변경.
