# 050 — 세션 연속성과 캐시

**Gaps:** G-018, G-019, G-020, G-021
**Depends on:** 040
**Size:** XL (G-021은 별도 구현 단위)

> 줄 번호와 줄 수는 OpenCodex `origin/dev` `9e0e298ef9` 기준이며, 줄 수는 ratchet의 `countLines`(`ocx:scripts/file-size-ratchet.ts:109`)로 센 값이다. 구현 단위를 열 때 현재 `dev`에서 다시 확인한다.

## Goal

긴 코딩 대화에서 combo가 이미 캐시가 따뜻한 대상을 유지해 cache miss를 줄인다. Antigravity와 xAI 경로에서 클라이언트가 돌려주지 않은 reasoning·서명 문맥을 안전하게 복원한다. 실제 Claude CLI를 쓰는 경로에 계정별 세션 재사용 opt-in 모드를 둔다.

## Why

- **G-018** — magpie는 대화별로 대상과 계정을 유지하고 cache read/write·TTL을 쓴다 (`006` L6-1). OpenCodex는 Codex 계정(`ocx:src/codex/routing/cache-affinity.ts:36`), JEV pin(`ocx:src/combos/jev-session-pin-config.ts:2`), tool-loop pin(`ocx:src/server/responses/core-combo.ts:790`)이 있으나 일반 combo 대상 affinity는 없다.
- **G-019** — CPA는 이전 문맥·part 위치 대조와 native call 복원을 한다 (`001` L1-1). OpenCodex는 세션별 다중 서명·snapshot·제거가 있다(`ocx:src/adapters/google-antigravity-replay.ts:37,184,344`).
- **G-020** — CPA는 xAI 경로에서 completion을 보강한다 (`001` L1-2). OpenCodex에는 Grok replay 정규화가 있다(`ocx:src/adapters/openai-responses/reasoning.ts:125`, `ocx:src/server/responses/core-replay.ts:114`).
- **G-021** — magpie는 계정별 장기 Claude CLI와 resume을 쓴다 (`006` L6-5). OpenCodex `claude-cli`는 매 턴 stateless다(`ocx:src/server/responses/run-turn-execution.ts:190`).

## Changes

| 경로 | 의도 | 내용 |
|---|---|---|
| `src/combos/session-affinity.ts` | NEW | `{callerNamespace, lane, comboId} → {target, accountId, generation, expiresAt}`. `callerNamespace`는 JEV 구현을 공용 helper로 옮겨 함께 쓴다 |
| `src/combos/resolve.ts` | MODIFY | `pickComboTarget`(`ocx:src/combos/resolve.ts:445`)에 affinity 힌트 인자. 기본 off, combo별 설정 |
| `src/server/responses/core-combo.ts` | MODIFY | 1971줄, 2000 전까지 28줄. tool-loop pin 계산(`ocx:src/server/responses/core-combo.ts:790`) 다음에 affinity 조회 한 줄, 기록은 dispatch scope 확인(`:1189`) 뒤 한 줄. 로직은 sibling |
| `src/adapters/google-antigravity-replay-context.ts` | NEW | 문맥 지문·part 위치 대조, native call 복원, snapshot 조건부 갱신 |
| `src/adapters/google-antigravity-replay.ts` | MODIFY | 986줄. 관찰·저장 경로 `observeAntigravityReplay`(`ocx:src/adapters/google-antigravity-replay.ts:718`)에서 새 모듈의 조건부 갱신을 호출 |
| `src/responses/state/xai-turn-supplement.ts` | NEW | 완료 turn 보강. target/credential binding, 동일 turn dedupe, compaction 무효화 |
| `src/adapters/claude-cli/session-pool.ts` | NEW | 계정·호출자·세션 소유권, idle drain, crash 복구, 취소 전파. 기본 off |
| `src/server/responses/run-turn-execution.ts` | MODIFY | `claude-cli` 분기(`ocx:src/server/responses/run-turn-execution.ts:190`)에서 session-pool 사용 여부 선택 |

Affinity 소유권 (감사 r2 #7, r3 #3): namespace는 JEV pin의 `callerNamespace(admission)`(`ocx:src/server/responses/jev-session-pin.ts:57`)과 같이 admitted principal(`principal:<contextPrincipalId>`, `key:<keyId>`, loopback)과 session lane, comboId로 만든다(`ocx:src/server/responses/jev-session-pin.ts:123`). `currentAdmissionScope()`(`ocx:src/server/responses/core-combo.ts:1189`)는 provider·model 허용 범위일 뿐 신원이 아니므로, 바인딩된 대상의 eligibility 재검사에만 쓴다. 040 snapshot은 계정과 generation만 준다. 우선순위는 tool-loop pin > affinity > 정책 순서다. compaction override와 main hard-lock fallback override 경로는 JEV pin과 같이 affinity를 읽지도 기록하지도 않는다(`ocx:src/server/responses/core-combo.ts:805`).

### Before / After

`ocx:src/server/responses/core-combo.ts:790` — tool-loop pin이 없으면 바로 정책 순서로 고른다.

```ts
// before
const toolLoopPin = options.compactionRoutingOverride || options.mainHardLockFallbackOverride
  ? undefined
  : toolLoopPinnedPick({ config, comboId, lane: sessionLaneIdFromRequest(req.headers), body,
      eligible: target => maySpendOnTarget(target) && targetEligible(target), now: initialNow });
let pick = toolLoopPin ?? await pickWithWait({ /* … */ });
```

```ts
// after (sketch) — core-combo.ts에는 한 줄, 로직은 combos/session-affinity.ts
// override 경로는 JEV pin(core-combo.ts:805)과 같이 affinity를 읽지도 쓰지도 않는다
const overrideRoute = options.compactionRoutingOverride || options.mainHardLockFallbackOverride;
const affinityPick = toolLoopPin || overrideRoute ? undefined : comboAffinityPick({ admission: options.admission, comboId,
  lane: sessionLaneIdFromRequest(req.headers), eligible: t => maySpendOnTarget(t) && targetEligible(t) });
let pick = toolLoopPin ?? affinityPick ?? await pickWithWait({ /* … */ });
```

## Dependencies

040. 바인딩이 가리키는 계정이 교체됐는지(generation) 040 snapshot으로 판단한다.

## Acceptance

- affinity를 켠 combo에서 같은 세션의 연속 turn이 같은 대상으로 간다. 대상이 cooldown에 들어가거나 generation이 바뀌면 해제 이유가 metrics에 남고 다음 후보로 간다. 허용 범위가 똑같은 두 발급 키가 같은 session lane을 써도 바인딩이 섞이지 않는다. tool-loop pin이 있으면 그쪽이 이긴다.
- Antigravity: 같은 인자의 tool call이 반복되는 fixture에서 서명이 위치 기준으로 복원된다. 불일치면 기존처럼 제거하고 진행한다.
- xAI: reasoning item을 빠뜨린 다음 turn에서 보강되고 같은 turn이 두 번 보강되지 않는다.
- Claude CLI 세션 재사용을 켜면 같은 세션의 두 번째 turn이 프로세스를 새로 띄우지 않는다. 끄면 기존 동작.

## Verification

- 신규 `tests/codex-integration/combo-session-affinity.test.ts`, `tests/adapters/google/google-antigravity-replay-context.test.ts`, `tests/responses/xai-turn-supplement.test.ts`, `tests/adapters/claude-cli-session-pool.test.ts`
- 기존 회귀: `tests/adapters/google/google-antigravity-replay.test.ts`, `tests/codex-integration/combos.test.ts`, `tests/codex-integration/combo-cooldown-reprobe.test.ts`, `tests/responses/` replay 테스트
- `bun run typecheck`, `bun run test:changed`, `bun run structure:check`; Claude CLI는 subprocess라 `ci:full`

## Risks

- **File-size ratchet:** 캡에 없는 파일은 2000줄 이상이면 실패하고(`NEW_OVERSIZED`), 캡 파일은 캡을 넘으면 실패한다(`tests/fixtures/file-size-baseline.json`). `core-combo.ts`는 1971줄로 28줄 여유다. 이 단계의 추가는 두 줄 이내로 한다.
- **Lab 경계:** `tests/lab/core-lab-boundary.test.ts`의 보호 목록(`ocx:tests/lab/core-lab-boundary.test.ts:23`: `src/router.ts`, `src/server/lifecycle.ts`, `src/server/responses/core.ts`, `src/server/management-api.ts`)에서 `src/lab/`으로 가는 import가 직접이든 간접이든 생기면 안 된다.
- **Consent:** G-021은 사용자 Claude 구독을 장기 프로세스로 유지하므로 명시 opt-in이다. 한 로그인을 여러 사람이 공유하는 구성은 지원하지 않는다.
- **Privacy:** 서명·reasoning 원문은 로그에 남기지 않는다.

## Non-goals

- 영속 replay 저장소, Gemini 명시적 cache API (G-036 보류).
