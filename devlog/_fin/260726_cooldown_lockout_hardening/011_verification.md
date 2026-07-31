# 011 — 검증 결과 (C 페이즈 증거)

구현 계약은 `010_cooldown_escape.md`.

## 게이트

| 명령 | 결과 |
|------|------|
| `bun run typecheck` | exit 0 |
| `bun run privacy:scan` | `Privacy scan passed` |
| `bun test tests/codex-routing.test.ts tests/codex-auth-context.test.ts` | 101 pass / 0 fail |
| `bun run test` (전체) | 4573 pass / 5 fail — **전부 baseline 아님, 동시 작업 소유** (아래 참조) |

## 전체 스위트 5건 실패 귀속 (중요)

실패: `codex-journal` 4건 + `ocx status --json codexPlugins` 1건.

이 워크트리에는 이번 유닛과 무관한 동시 작업이 있다: `src/codex/journal.ts`,
`src/codex/inject.ts`, `src/codex/injected-marker.ts`(신규), `src/cli/index.ts`,
`tests/codex-journal.test.ts`. 이는 사용자 소유 변경이며 건드리지 않았다.

귀속 증명 (실제 실행):

1. 이번 유닛 변경만 남기고 위 5개 파일을 stash → `bun test tests/codex-journal.test.ts`
   **11 pass / 0 fail**.
2. 같은 상태에서 `tests/cli-status-json.test.ts` **8 pass / 0 fail**.
3. stash pop으로 동시 작업 원상 복구 확인.

즉 5건은 이번 변경이 만든 회귀가 아니다. 동시 작업 소유자가 해결할 몫이다.

## 활성화 증거 (C-ACTIVATION-GROUNDING-01)

"테스트 그린"이 아니라 각 조건부 경로가 실제로 발화하는 것을 관찰했다.

**1. 해제 성공 경로** — 429 주입 → `isCodexAccountInCooldown` true → 해제 →
false, `lastFailureStatus: 429`는 보존. (`clearCodexAccountCooldown lifts a live
cooldown but keeps failure history`)

**2. no-op 경로** — 쿨다운 없음/이미 만료 두 경우 모두 false.

**3. stale probe 방어 — ablation으로 검증.**
`probeLeaseId`/`probeLeaseGeneration` 제거를 코드에서 빼자 테스트가 실제로 FAIL했다
(`Expected: null / Received: undefined`). 즉 이 테스트는 진짜 방어를 증명한다.

**계획 대비 정정 (LOOP-MECHANISM-PROOF-01):** 010 문서와 초기 주석은 "cooldownGeneration
bump가 쿼터 우회를 막는다"고 주장했다. **틀렸다.** bump를 제거한 ablation은 여전히
PASS했다. 실제 방어 주체는 해제 시 `probeLeaseId`를 떨어뜨리는 것이고
(`ownsProbeLease`가 id 일치를 요구), 게다가 `recordCodexUpstreamOutcome`의 429 경로가
이미 세대를 올린다(런타임 확인: gen 1 → 해제 후 1 → 재쿨다운 후 2). bump는
load-bearing이 아닌 이중 방어로 남기고, 주석과 테스트 이름을 사실에 맞게 고쳤다.

**4. 429 본문 마스킹** — `acct_9f3c21` → `account-…3c21`로 렌더되고 raw id가 본문에
없음을 단언. `__main__` → `main`. `Retry-After: 90`, 이미 지난 쿨다운은 `1`.

**5. WS 경로 (Desktop 표면)** — 실제 프레임을 만들어 관찰:

```json
{"type":"error","status":429,"error":{"type":"rate_limit_error","message":"Selected Codex account (account-…3c21) is cooling down until 2026-07-26T12:00:00.000Z (source: retry-after). Run 'ocx account list openai' to find the id, then 'ocx account clear-cooldown openai <id>' to lift it, ..."}}
```

`leaks raw id? false`, `has escape cmd? true`.

**6. CLI 도달성** — `cmdAccount(["clear-cooldown","openai","main"])`을 fake fetch로
실행: `POST /api/codex-auth/accounts/clear-cooldown` body `{"id":"__main__"}`,
출력 `openai: cooldown lifted for main`, exit 0. 단일 계정 탈출 경로가 살아 있다.

**7. 계정 존재 오라클 차단** — 설정된 계정과 미설정 id가 동일하게 200 + `cleared:false`.

## 남은 갭 (이번 유닛 범위 밖)

G4(Desktop 커버리지 없이 주입 허용)는 손대지 않았다. `ocx init`이 launchd 서비스
설치 여부와 무관하게 주입을 진행하고, shim은 Desktop을 커버하지 못한다. 이는
"프록시 부재" 갈래의 근본 원인이고 별도 유닛이 필요하다.
