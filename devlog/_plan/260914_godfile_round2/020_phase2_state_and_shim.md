# 020 — 사이클 2: `src/responses/state.ts`와 `src/codex/shim.ts` 파사드 분해

`src/responses/state.ts` 2,432줄과 `src/codex/shim.ts` 2,466줄이 한 파일에 저장소·스필·스냅샷·리플레이와 심 설치·프로브·복원을 각각 들고 있어 래칫 이후에도 2,000줄을 넘긴다. 이 문서는 그 두 파일을 7개 PR로 줄이는 복붙 가능한 이동 계약이다. 구현자는 아래에 적힌 원본 행을 새 리프로 옮기고 파사드가 기존 export 이름을 그대로 다시보내며, 소비자 28+6곳은 import 경로를 건드리지 않는다. 기여자에게 바뀌는 것은 새 리프가 1,999줄 미만이어야 한다는 점과, 심 오라클 3건이 읽는 `src/codex/shim.ts` 본문에 지정 리터럴이 남아 있어야 한다는 점뿐이다.

브랜치 `codex/m2k-l3-state-shim`, base는 사이클 1 래칫 브랜치 `codex/m2k-l2-ratchet`. 순수 이동, 동작 변경 없음. 로컬 스위트·typecheck·build는 이 단위 금지(hosted CI). 새 테스트 파일을 만들지 않는다.

## 공통 이동 규칙

각 PR은 아래를 한 커밋으로 끝낸다. 원본 함수 본문을 고치지 않고 잘라 붙인다. 옮긴 함수는 파사드에서 삭제하고 `export { name } from "./…";` 한 줄로 다시보낸다. 내부 심볼은 파사드가 `import { name } from "./…";` 한다. 리프는 파사드를 import하지 않는다. `Date.now()`가 필요하면 파사드의 `now()`(`src/responses/state.ts:1236-1238`)를 import하지 말고 리프에서 `Date.now()`를 쓴다.

모듈 수준 `let`/`const` 객체는 한 파일만 소유한다. `states`나 `spillCounters`를 인자로 넘겨 두 번째 참조를 만들지 않는다. 테스트 훅 setter는 소유 모듈에 두고 파사드가 기존 이름으로 다시보낸다.

## 상태 소유권

### `src/responses/state.ts`

| 바인딩 | 원본 행 | 소유 | 이유 |
|---|---|---|---|
| `states`, `storedResponseBytes`, `residentResponseBytes`, `oldestResidentId`, `oldestResidentAt`, `byteCapOverride` | 127-133 | 잔여 파사드 | ESM live binding. 이전 금지 |
| `stateRevision`, `lastSnapshotBytes`, `lastSnapshotDigest`, `lastSnapshotTarget` | 134-142 | 잔여 | 스냅샷 쓰기와 같은 파일 |
| `loaded`, `persistTimer`, `pendingPersistPath`, `persistGate`, `persistAttemptHookForTests` | 1229-1234 | 잔여 | `ensureLoaded`/`schedulePersist`와 같은 파일 |
| `replayOverlapSkips` | 1756 | 잔여 | `expandPreviousResponseInput:2154`가 증가, getter `:1835-1837`. 핑거프린트 리프로 옮기면 카운터가 갈라진다 |
| `replayScopeMismatchDrops` | 284 | 잔여 | `:2129`가 증가, `responseStateMetrics:2288`가 판독 |
| `pendingSpillUnlinks`, `PENDING_SPILL_UNLINKS_MAX` | 293-300 | 잔여 | `deleteEntry`/`replaceWithSpillFailure`/`drainPendingSpillUnlinks`가 잔여. 큐로 옮기면 순환 |
| `spillCounters`, `spillWriteHealth` | 172-214 | `spill-failure.ts` | 객체 변이. metrics는 import로 같은 객체를 판독 |
| `admissionCounters` | 283 | `spill-failure.ts` | 큐와 잔여가 필드만 증가. 객체를 인자로 넘기지 말 것 |
| `pendingResponseSpills`, `pendingResponseSpillById`, `pendingResponseSpillBytes` | 323-325 | `spill-queue.ts` | |
| `reservedResponseSpillBytes`, `unreclaimableSpillPaths`, `responseSpillPublicationTail` | 347, 361, 391 | `spill-queue.ts` | |
| 셧다운 예산 override 3개 | 392-394 | `spill-queue.ts` | 테스트 setter `:599-617`과 함께 |

`responseStateMetrics`(`:2213-2289`)는 잔여에 남긴다. 이 함수를 별도 모듈로 빼면 `states`와 스필 카운터를 한곳에 다시 모아 순환이 생긴다.

정정: 초안은 spill-failure 원본을 177-307로 적어 `spillCounters`(172-175)를 빠뜨리고 `pendingSpillUnlinks`(293-307)를 포함했다. 카운터는 172부터, unlink 큐는 잔여다.

### `src/codex/shim.ts`

| 바인딩 | 원본 행 | 소유 | 이유 |
|---|---|---|---|
| `lastShimDiscoveryError` | 선언 207, 기록 542·577·588·594, 판독 210·2181 | 잔여 | `findCodexOnPath`/`findWindowsCodexTargets`/`installCodexShimInternal`가 잔여. 탐색 분리 시 설치 메시지가 fallback으로 샌다 |
| `codexShimProbeHookForTests`, `codexShimProbeShellForTests`, `codexShimProbeObservationMs` | 806-807, 811 | `shim-probe.ts` | setter `:814-827`. 자식 오라클이 `setCodexShimProbeObservationMsForTests`를 `shim.ts`에서 import |
| guarded/fresh/rollback write 훅 3종 | 808-810, setter 829-850 | 잔여 | 설치/가드 리프레시 경로 |
| `guardedRefreshTransactionId` | 선언 1612, 사용 1850 | 잔여 | `applyGuardedRefreshTransaction`와 같은 파일 |

정정: 프로브 훅 3종은 초안과 같다. 파일의 setter 6개 중 나머지 3개(write/rollback)는 잔여 소유다.

## 하지 말아야 할 분할

1. `responseStateMetrics`를 별도 파일로 빼지 않는다.
2. store-core(`states`, `replaceMapEntry`, `deleteEntry`, `swapResidentForSpill`, `replaceWithSpillFailure`, `setResidentEntry`, `admitOversizedCandidate`)와 `spill-queue.ts`를 같은 PR에서 동시에 빼지 않는다. `runPendingResponseSpill:490,500`가 store-core를 호출하고 store-core 교체가 unlink 헬퍼를 호출한다.
3. `installCodexShimInternal`(`:2108-2293`)를 unix/windows로 나누지 않는다. 저널·롤백·probe가 한 함수다.
4. `findCodexOnPath`(`:541-585`)와 `findWindowsCodexTargets`(`:587-621`)를 리프로 옮기지 않는다.
5. `writeShim`(`:1427-1479`)를 리프로 옮기지 않는다. 오라클이 호출부 리터럴을 `shim.ts` 원문에서 찾는다. 빌더 정의만 옮긴다.
6. 소비자 import 경로를 리프로 바꾸지 않는다.

## 동반 수정 의무

| 항목 | `state.ts` | `shim.ts` |
|---|---|---|
| structure 백틱 | 0. `structure/`가 `src/responses/state.ts`를 백틱하지 않음. 갱신 없음 | 2. `structure/runtime.md:41`, `structure/ops/docs-and-release.md:179`. 둘 다 `src/codex/shim.ts`. 파사드 파일명 유지 |
| 소스 오라클 | 0 | 3. 아래 오라클 절 |
| INV-* | 0. 이 파일을 묶는 INV 없음. 승계 모듈 없음 | 0 |
| `scripts/test-layout/layout.json` | 등록하지 않음 | 등록하지 않음 |
| `tests/fixtures/test-layout-expected.json` | 등록하지 않음 | 등록하지 않음 |
| `structure/manifest.json` / `INDEX.md` | 불필요. 리프는 `src/responses/` 중첩. 게이트는 `src/` 1-depth만 센다(`scripts/structure-ssot.ts:518-530`) | 불필요. 리프는 청구된 `src/codex/` 형제 |

`structure/runtime.md:41`은 파사드 한 칸이다. PR 4부터 service.ts 행(`:42`)처럼 리프 백틱을 같은 칸에 나열한다. 없는 파일을 백틱하면 `structure:check`가 git index 기준으로 실패하므로 그 PR에서 만든 리프만 적는다. `ops/docs-and-release.md:179`는 파사드 파일명만 말하므로 본문 변경 없음.

새 테스트 파일 금지: responses 도메인 regex는 `^(?:apply|chat|citation|continuation|eventstream|legacy|namespace|passthrough|responses|sse|thought|ws)-`이다. `spill-queue.test.ts`는 매칭되지 않아 explicit 등록이 강제된다. 기존 스위트가 순수 이동의 오라클이다.

## 소스 오라클 (shim.ts 3건, 리터럴 재검증)

`tests/codex-integration/codex-shim.test.ts:240-242`가 `readFileSync(repoPath("src", "codex", "shim.ts"), "utf8")` 후 아래 부분 문자열이 `shim.ts`에 있기를 요구한다.

    `\uFEFF${buildWindowsPowerShellCodexShim(realCodexPath, bun, cli, bunRuntimeSource)}`

원본: `writeShim` 내부 `:1434`

    writeFileSync(wrapperPath, `\uFEFF${buildWindowsPowerShellCodexShim(realCodexPath, bun, cli, bunRuntimeSource)}`, "utf8");

`tests/codex-integration/codex-shim.test.ts:246-250`이 같은 파일에서 다음 세 리터럴을 찾는다.

1. `const gitBashLauncher = join(dir, "codex");` → `findWindowsCodexTargets:608`
2. `for (const path of [cmd, ps1, gitBashLauncher])` → `findWindowsCodexTargets:610`
3. `buildUnixCodexShim(gitBashPath(realCodexPath), gitBashPath(bun), gitBashPath(cli), bunRuntimeSource, gitBashPath(serviceApiTokenFilePath()))` → `writeShim:1441`

정정: 초안은 writeShim 호출부를 1434 한 줄로 적었다. 1434는 BOM 리터럴, Git-Bash 유닉스 빌더 호출은 1441이다. `writeShim` 함수는 1427-1479에 잔류한다.

`tests/codex-integration/codex-shim.test.ts:1918-1922` — 자식이 `repoPath("src", "codex", "shim.ts")`를 `await import` 한다. 경로가 파사드여야 하고 파사드가 `autoRestoreCodexShim`와 `setCodexShimProbeObservationMsForTests`를 export해야 한다. 후자 정의는 프로브 리프로 옮겨도 `export { setCodexShimProbeObservationMsForTests } from "./shim-probe";`면 통과한다.

## 소비자 (파사드 유지 시 write set 밖)

정정: 초안 "src 임포터 38곳"은 과대. `responses/state`를 import하는 파일은 28곳이다.

src 10: `src/cli/doctor.ts`, `src/lab/conformance/executor.ts`, `src/lib/app-owned-memory-stores.ts`, `src/lib/state-store-registrations.ts`, `src/server/lifecycle.ts`, `src/server/management/system-routes.ts`, `src/server/responses/collaboration.ts`, `src/server/responses/compact.ts`, `src/server/responses/core.ts`, `src/server/responses/encrypted-payload.ts`. scripts 1: `scripts/macos-rss-retention-sampler.ts`. tests/helpers 2 + tests 15.

`src/adapters/kiro/stream.ts:895`는 주석만 있고 import가 아니다.

shim 실임포트 src 6: `src/cli/codex-shim-autorestore.ts`, `src/cli/doctor.ts`, `src/cli/status.ts`, `src/client/machine-api.ts`, `src/remote-control/workspace-codex-sandbox.ts`, `src/server/startup-health-cache.ts`.

---

## PR 1 — replay-fingerprint + temp-recovery

브랜치 첫 커밋. `state.ts`만 줄인다.

### NEW

`src/responses/state/replay-fingerprint.ts` 예상 105줄 (import ~12 + 이동 79).

원본에서 이동:

- `:1752-1754` `REPLAY_FINGERPRINT_MAX_BYTES`, `REPLAY_FINGERPRINT_MAX_DEPTH`
- `:1758-1833` `replayItemFingerprint`, `providerIssuedIdentity`, `clientCarriedPrefixLength` (1758-1769 주석은 `replayItemFingerprint` 것)

파사드에 남김:

- `:1744-1750` `inputItems` — `expandPreviousResponseInput:2144,2167`와 `rememberResponseState:2350`가 사용
- `:1756` `let replayOverlapSkips = 0;`
- `:1835-1837` `replayOverlapSkipsForTests`

정정: 초안 ~115 (1744-1833)은 `inputItems`와 `replayOverlapSkips`를 포함했다. 실제 이동 본문은 79줄.

`src/responses/state/temp-recovery.ts` 예상 270줄 (import ~20 + 이동 257).

원본에서 이동:

- `:70-84` `STALE_TEMP_GRACE_MS`, `STALE_TEMP_MAX_ENTRIES`, `STALE_TEMP_MAX_CLEANUPS`, `BOOT_FLOOR_SKEW_MS`, `PERIODIC_TEMP_MAX_ENTRIES`, `PERIODIC_TEMP_MAX_CLEANUPS`, `PERIODIC_TEMP_SCAN_DEADLINE_MS`, `RESPONSE_STATE_TEMP_NAME`
- `:1330-1527` `ResponseStateTempRecoveryResult`, `ResponseStateTempRecoveryIO`, `ResponseStateTempRecoveryOptions`, `processIsAlive`, `responseStateTempRecoveryIO`, `recoverStaleResponseStateTemps`, `responseStateSweepDirectories`
- `:1966-2009` `reclaimAbandonedResponseStateTemps`, `inspectAbandonedResponseStateTemps`, `sweepAbandonedResponseStateTemps`

`responseStateSweepDirectories`의 `snapshotPath()` 호출은 `join(getConfigDir(), "responses-state.json")`로 인라인한다. 파사드의 `snapshotPath`를 import하지 않는다. `resolveWriteTarget`는 `../config`에서 가져온다.

정정: 초안 ~200 (1330-1528)은 상수와 공개 래퍼를 빠뜨렸다. 래퍼를 파사드에 남기면 공개 API가 두 파일로 갈라진다.

### MODIFY

`src/responses/state.ts` — 위 행을 삭제하고 상단에 다음을 추가한다.

```ts
import { clientCarriedPrefixLength } from "./state/replay-fingerprint";
export type { ResponseStateTempRecoveryResult, ResponseStateTempRecoveryOptions } from "./state/temp-recovery";
export { recoverStaleResponseStateTemps, reclaimAbandonedResponseStateTemps, inspectAbandonedResponseStateTemps, sweepAbandonedResponseStateTemps } from "./state/temp-recovery";
```

`ensureLoaded:1546`의 `recoverStaleResponseStateTemps(dir)`는 재export된 이름을 그대로 쓴다. `expandPreviousResponseInput:2154`는 `clientCarriedPrefixLength(...)` 후 `replayOverlapSkips += 1`. 카운터는 이 파일에 남는다.

예상 잔여 2,120줄 (2,432 − 79 − 15 − 198 − 44 + 글루 ~24). 아직 1,999 초과, 래칫은 감소이므로 통과.

### DELETE

없음.

### write set

- NEW `src/responses/state/replay-fingerprint.ts`
- NEW `src/responses/state/temp-recovery.ts`
- MODIFY `src/responses/state.ts`

### 회귀 테스트 (hosted CI, 로컬 NOT RUN)

- `tests/responses/continuation-dedup.test.ts` — `replayOverlapSkipsForTests`
- `tests/responses/responses-state.test.ts` — `recoverStaleResponseStateTemps`
- `tests/oauth/state-store-sweeper.test.ts`
- `tests/codex-integration/issue-702-expired-replay-state.test.ts`

### 완료 조건

새 두 파일 각 ≤1,999. 파사드가 `replayOverlapSkips`를 소유. 리프가 `../state`를 import하지 않음. 소비자 diff 0.

---

## PR 2 — spill-failure + snapshot-codec

PR 1 위에 쌓는다.

### NEW

`src/responses/state/spill-failure.ts` 예상 145줄.

원본에서 이동:

- `:172-175` `spillCounters`
- `:177-214` `ResponseSpillWriteFailureCode`, `ResponseSpillWriteStatus`, `ResponseSpillWriteFailureOrigin`, `ResponseSpillWriteHealth`, `spillWriteHealth`
- `:216-275` `classifySpillWriteFailure`, `spillAclMemoRefusalOrigin`, `noteSpillWriteSuccess`, `noteSpillWriteFailure`
- `:283` `admissionCounters`
- `:287-288` `responseAdmissionCountersForTests`

`noteSpillWriteSuccess:256` / `noteSpillWriteFailure:269`의 `now()`는 `Date.now()`로 바꾼다. 파사드를 import하지 않는다.

파사드에 남김:

- `:284` `let replayScopeMismatchDrops = 0;`
- `:293-307` `pendingSpillUnlinks`, `PENDING_SPILL_UNLINKS_MAX`, `MAX_PENDING_RESPONSE_SPILL_BYTES`

파사드의 `responseStateMetrics:2273-2287`는 `import { spillCounters, spillWriteHealth } from "./state/spill-failure";` 후 기존 필드를 그대로 읽는다. 객체 identity가 하나라 변이가 metrics에 보인다. 잔여 `:1167,1188,1205,1562`의 `admissionCounters.* += 1`도 같은 import로 필드만 증가한다. 객체를 인자로 넘기지 않는다.

파사드 재export: `ResponseSpillWriteFailureCode`, `ResponseSpillWriteStatus`, `ResponseSpillWriteFailureOrigin`, `responseAdmissionCountersForTests`. `ResponseStateMetrics` 인터페이스(`:2213-2233`)는 metrics 함수와 같이 잔여.

`src/responses/state/snapshot-codec.ts` 예상 110줄.

원본에서 이동:

- `:1244-1251` `LegacySnapshotState`
- `:1253-1261` `isSpillRef`
- `:1263-1328` `loadSnapshotEntry`

정정: 초안 ~110 (1244-1329) 대비 본문은 86줄. 파일 예상 110은 import+핸들 타입이다.

`loadSnapshotEntry`는 지금 `replaceMapEntry`/`tombstone`/`measureResidentEntry`/`admitOversizedCandidate`/`byteCap`를 직접 호출한다. 리프가 파사드를 import할 수 없으므로 시그니처만 다음으로 바꾼다(본문 동작 동일).

```ts
export interface SnapshotLoadStore {
  replaceMapEntry(id: string, next: StoredResponseState, expected?: StoredResponseState): boolean;
  tombstone(id: string, createdAt: number): SpillFailedResponseState;
  measureResidentEntry(id: string, entry: ResidentInput): ResidentResponseState | null;
  admitOversizedCandidate(id: string, expected: ResidentResponseState, previous: StoredResponseState | undefined): void;
  byteCap(): number;
}
export function loadSnapshotEntry(id: string, value: unknown, store: SnapshotLoadStore): void {
  // 원본 1263-1328 본문. states Map을 받지 않는다.
}
```

타입 `StoredResponseState` / `ResidentInput` / `ResidentResponseState` / `SpillFailedResponseState` / `SpilledResponseState`는 파사드 `:91-120`에 남긴다. 코덱은 `import type`만 한다. `import type`은 값 순환을 만들지 않는다.

파사드 `ensureLoaded:1568` 호출을 `loadSnapshotEntry(entry[0], entry[1], { replaceMapEntry, tombstone, measureResidentEntry, admitOversizedCandidate, byteCap })`로 바꾼다. 핸들은 잔여 소유 함수의 참조이며 `states` 자체를 넘기지 않는다.

### MODIFY

`src/responses/state.ts` — 이동 행 삭제, import/재export 추가, `responseStateMetrics`와 admission 증가 지점이 `spill-failure`를 import, `clearResponseStateMemoryForTests:2402-2411`의 카운터 리셋이 import한 같은 객체의 필드를 0으로 만든다.

예상 잔여 1,950줄 (PR1 잔여 2,120 − 4 − 99 − 1 − 2 − 86 + 글루 ~22). 이 PR 끝에서 `state.ts`가 1,999 이하가 된다. `structure/` 변경 없음.

### DELETE

없음.

### write set

- NEW `src/responses/state/spill-failure.ts`
- NEW `src/responses/state/snapshot-codec.ts`
- MODIFY `src/responses/state.ts`

### 회귀 테스트

- `tests/responses/responses-state.test.ts` — spill write failure, tombstone, admission, snapshot round-trip (`:2001,2010,2240,2334,2383,2696`)
- `tests/responses/responses-state-write-amplification.test.ts`
- `tests/responses/continuation-dedup.test.ts` — metrics 키 집합 `:316-322`
- `tests/codex-integration/app-owned-memory.test.ts` — `MAX_STORED_RESPONSE_BYTES` (파사드 잔류)

### 완료 조건

`responseStateMetrics`가 파사드에 남음. `spillCounters` identity 1개. `pendingSpillUnlinks`가 파사드에 남음. 코덱이 `states`를 인자로 받지 않음.

---

## PR 3 — spill-queue

PR 2 위에 쌓는다. store-core는 파사드에 남긴다.

### NEW

`src/responses/state/spill-queue.ts` 예상 620줄 (이동 559 + 핸들 타입 + import).

원본에서 이동 `:309-867` 중 `deferSupersededSpill`를 제외한 전부:

- `:309-321` `PendingResponseSpill`
- `:323-325` `pendingResponseSpills`, `pendingResponseSpillById`, `pendingResponseSpillBytes`
- `:347-394` `reservedResponseSpillBytes`, `unreclaimableSpillPaths`, `chargeUnreclaimableSpillPath`, `reconcileUnreclaimableSpillPaths`, `publicationFootprintBytes`, `responseSpillPublicationTail`, 셧다운 override 3개
- `:404-867` `releasePendingResponseSpill`, `cancelPendingResponseSpill`, `isAclTimeout`, `spillPayloadForResident`, `runPendingResponseSpill`, `queuePendingResponseSpill`, `replaceWithPendingResponseSpill`, 테스트 export 5개(`:584-617`), 셧다운 fallback/drain

`:396-402` `deferSupersededSpill`는 `pendingSpillUnlinks`(잔여)를 push한다. 이 함수는 파사드에 남기고 큐가 핸들로 호출한다. 초안 309-867을 통째로 옮기면 unlink 큐가 큐 모듈로 들어가 store-core와 순환한다.

정정: 초안 ~560 (309-867) 범위는 맞지만 `deferSupersededSpill`는 잔여. 이동 본문은 약 552줄.

큐 리프가 파사드를 import하지 않도록 모듈 로드 시점에 핸들만 주입한다.

```ts
export interface SpillQueueStore {
  swapResidentForSpill(id: string, expected: ResidentResponseState, ref: ResponseSpillRef): boolean;
  replaceWithSpillFailure(id: string, candidate: ResidentResponseState, options?: { deferSpillUnlink?: boolean }): void;
  deleteEntry(id: string, options?: { deleteSpill?: boolean }): void;
  deferSupersededSpill(ref: ResponseSpillRef | undefined): void;
}
let store: SpillQueueStore | null = null;
export function bindSpillQueueStore(next: SpillQueueStore): void {
  store = next;
}
function requireStore(): SpillQueueStore {
  if (!store) throw new Error("spill-queue store is not bound");
  return store;
}
```

파사드는 store-core 함수가 정의된 다음 한 번 호출한다.

```ts
import { bindSpillQueueStore } from "./state/spill-queue";
bindSpillQueueStore({ swapResidentForSpill, replaceWithSpillFailure, deleteEntry, deferSupersededSpill });
```

`runPendingResponseSpill:490,500` 등의 store-core 호출을 `requireStore().swapResidentForSpill(...)`로 치환한다. `noteSpillWriteSuccess`/`noteSpillWriteFailure`/`admissionCounters`는 `./spill-failure`에서 import한다. spill-store 심볼은 원본과 같이 `../spill-store`에서 import한다.

파사드 재export: `flushPendingResponseSpillsForTests`, `awaitResponseSpillPublicationTailForTests`, `pendingResponseSpillMetricsForTests`, `setResponseSpillShutdownBudgetForTests`, `setResponseSpillAsyncAclAttemptBudgetForTests`, `setResponseSpillShutdownTerminalizationPassLimitForTests`.

파사드 `clearResponseStateMemoryForTests:2393`의 `cancelPendingResponseSpill`와 `:2424-2425` `reservedResponseSpillBytes = 0` / `unreclaimableSpillPaths.clear()`는 큐 리프의 `resetSpillQueueForTests()` 한 함수로 모은다. 파사드 clear가 큐 모듈 바인딩을 필드 단위로 만지면 소유권이 샌다.

파사드 `spilledResponseBytes:896`, `accountedResponseSpillBytes:917`는 `pendingSpillUnlinks`(잔여)와 `reservedResponseSpillBytes`(큐)를 함께 본다. 바이트 회계 함수는 잔여에 남기고, 큐는 getter를 제공한다.

```ts
export function spillQueueAccounting(): { reservedBytes: number; jobOwnedBytes: number } {
  // 원본 917-927과 동일 산식. states를 읽지 않는다.
}
```

잔여 `accountedResponseSpillBytes`가 이 getter를 더한다.

### MODIFY

`src/responses/state.ts` — `:309-867` 중 잔여 `deferSupersededSpill`만 남기고 삭제, bind 호출 추가, 테스트 export 재export, clear/accounting이 큐 getter를 사용.

예상 잔여 1,370줄.

### DELETE

없음.

### write set

- NEW `src/responses/state/spill-queue.ts`
- MODIFY `src/responses/state.ts`

### 회귀 테스트

- `tests/responses/responses-state.test.ts` — Windows ACL 큐, shutdown drain/fallback, pending unlink 128 cap (`:894,1240,1251,1285,1317,1357,1465,1514,1575,1643,1780,1791,2104,2413,2473`)
- `tests/helpers/responses-state-shutdown-budget-child.ts`
- `tests/helpers/responses-state-never-settling-acl-child.ts`

자식 헬퍼는 계속 `from "../../src/responses/state"`를 import한다. 경로를 리프로 바꾸지 않는다.

### 완료 조건

`state.ts` ≤1,999, `spill-queue.ts` ≤1,999. 큐가 `./state`를 import하지 않음. `bindSpillQueueStore` 1회. `states`를 인자로 넘기지 않음. store-core 함수가 파사드에 남음.

이 PR로 `state.ts` 분해는 끝이다. 이후 PR은 `shim.ts`만 만진다.

---

## PR 4 — shim-templates

`shim.ts` 첫 분해. 오라클 리터럴이 있는 호출부는 옮기지 않는다.

### NEW

`src/codex/shim-templates.ts` 예상 270줄.

원본에서 이동:

- `:38-39` `SHIM_MARKER`, `UNIX_SHIM_REVISION_MARKER`
- `:46-47` `CODEX_SHIM_REENTRY_EXIT_CODE`, `CODEX_SHIM_REENTRY_DIAGNOSTIC`
- `:212-235` `CODEX_INTERNAL_COMMANDS`
- `:237-249` `CODEX_GLOBAL_OPTIONS_WITH_VALUE`
- `:674-685` `shQuote`
- `:687-767` `buildUnixCodexShim` (export)
- `:1050-1161` `windowsBatchValue`, `windowsBatchSet`, `buildWindowsCodexShim` (export), `psString`, `buildWindowsPowerShellCodexShim` (export)
- `:1414-1416` `gitBashPath` — inspect(`:1390`)와 writeShim(`:1441`)가 공유. 템플릿 리프에 둔다

정정: 초안 ~390은 `:48-204` `CODEX_SHIM_INSTALL_PROBE_SCRIPT`(157줄)를 템플릿에 넣은 합산이다. 그 스크립트는 `probeUnixShimInstall:888`만 쓰므로 PR 6 프로브 리프로 간다. 템플릿 본문은 ~251줄.

`CODEX_SHIM_INSTALL_PROBE_SCRIPT`는 이 PR에서 옮기지 않는다.

### MODIFY

`src/codex/shim.ts`

```ts
import { SHIM_MARKER, UNIX_SHIM_REVISION_MARKER, CODEX_SHIM_REENTRY_EXIT_CODE, CODEX_SHIM_REENTRY_DIAGNOSTIC, shQuote, windowsBatchSet, psString, gitBashPath } from "./shim-templates";
export { buildUnixCodexShim, buildWindowsCodexShim, buildWindowsPowerShellCodexShim } from "./shim-templates";
```

`writeShim:1434`와 `:1441` 호출부 텍스트를 한 글자도 바꾸지 않는다. 빌더 이름이 같은 스코프에 남아야 오라클이 통과한다(재export가 같은 바인딩을 제공한다).

`isShim:331`, `isHealthyShim:339`는 잔여. `SHIM_MARKER`를 템플릿에서 import.

`structure/runtime.md:41` MODIFY. 기존 칸의 파사드 백틱을 지우지 말고, 이 PR에서 만든 리프만 같은 칸에 추가한다.

    | `src/codex/shim.ts` | Codex autostart shim facade. Wrapper templates live in `src/codex/shim-templates.ts`. It skips startup for management subcommands even when value-taking global flags precede the subcommand, and transactionally restores complete, stable external launcher replacements without a watcher or PATH rediscovery. |

`structure/ops/docs-and-release.md:179` 변경 없음.

예상 잔여 2,235줄.

### DELETE

없음.

### write set

- NEW `src/codex/shim-templates.ts`
- MODIFY `src/codex/shim.ts`
- MODIFY `structure/runtime.md` (41행만)

### 회귀 테스트

- `tests/codex-integration/codex-shim.test.ts` — 빌더 출력, 오라클 `:239-251`, management command skip, BOM, Git-Bash launcher
- `tests/codex-integration/codex-cli-install-provenance.test.ts` — `buildUnixCodexShim`
- `tests/adapters/openai/openai-provider-option-tooling.test.ts` — `buildUnixCodexShim`

### 완료 조건

`:1434` BOM 리터럴과 `:1441` Git-Bash 호출 리터럴이 `shim.ts`에 존재. `findWindowsCodexTargets:608,610` 미이동. runtime.md가 `src/codex/shim.ts`를 백틱.

---

## PR 5 — shim-fingerprint + shim-state-file

### NEW

`src/codex/shim-fingerprint.ts` 예상 210줄.

원본에서 이동:

- `:40` `CODEX_SHIM_PROBE_BYTES`
- `:289-303` `ShimPathFingerprint`, `StableShimPathProbe`
- `:351-515` `readShimProbePrefix`, `statFingerprint`, `sameFingerprint`, `sameFingerprintAfterRename`, `stableShimPathProbe`, `sameStableShimPathProbe`, `shimPathFingerprint`, `restoreWithoutReplacing`, `isHealthyShimProbe`, `isCurrentUnixShimProbe`, `hasUsableBackingPath`
- `:641-661` `isVersionManagerOwnedCodexPath` (export) — inspect(PR 7)가 파사드를 import할 수 없으므로 경로 판별을 여기 둔다

정정: 초안 ~165 (351-515)은 인터페이스와 version-manager 판별을 빠뜨렸다. `:351-515` 165줄은 맞고, 파일 총량은 ~210.

`isShim`/`isHealthyShim`(`:331-349`)는 잔여. 전체 파일을 읽는 설치 경로용이다. 프로브 prefix 판별만 리프.

`src/codex/shim-state-file.ts` 예상 140줄.

원본에서 이동:

- `:42` `CODEX_SHIM_STATE_MAX_BYTES` (export)
- `:251-265` `ShimState`, `ShimFileState` — 여러 리프가 쓰므로 상태 파일 모듈이 타입 소유
- `:1163-1260` `ShimStateReadResult`, `fileErrorCode`, `readBoundedRegularFile`, `readStateResult`, `readState`
- `:1402-1412` `statePath`, `writeState`
- `:1522-1527` `stateFiles` — inspect와 설치가 공유. 파사드에 남기면 inspect가 파사드를 import한다

`fileErrorCode`는 잔여 롤백(`:1016,1816`)·restore-lock(`:1752`)·inspect(`:1300`)가 쓴다. 이 리프가 소유하고 나머지가 import한다.

`primaryState:1528-1532`는 설치 경로, 잔여.

정정: 초안 ~130은 read 블록+writeState와 비슷하다. 타입·`stateFiles`를 포함하면 ~140.

### MODIFY

`src/codex/shim.ts` — 이동 행 삭제.

```ts
import { type ShimPathFingerprint, type StableShimPathProbe, statFingerprint, sameFingerprint, stableShimPathProbe, shimPathFingerprint, restoreWithoutReplacing, isHealthyShimProbe, isCurrentUnixShimProbe, hasUsableBackingPath } from "./shim-fingerprint";
export { isVersionManagerOwnedCodexPath } from "./shim-fingerprint";
import { type ShimState, type ShimFileState, fileErrorCode, readStateResult, readState, statePath, writeState, stateFiles } from "./shim-state-file";
export { CODEX_SHIM_STATE_MAX_BYTES } from "./shim-state-file";
```

`structure/runtime.md:41` 칸에 `src/codex/shim-fingerprint.ts`, `src/codex/shim-state-file.ts` 백틱을 추가한다.

예상 잔여 1,940줄. 이 PR 끝에서 `shim.ts`가 1,999 이하.

### DELETE

없음.

### write set

- NEW `src/codex/shim-fingerprint.ts`
- NEW `src/codex/shim-state-file.ts`
- MODIFY `src/codex/shim.ts`
- MODIFY `structure/runtime.md` (41행)

### 회귀 테스트

- `tests/codex-integration/codex-shim.test.ts` — fingerprint mismatch defer, version-manager 분류 `:2258`, stale lock 전 관측 구간 `:2040,2098,2119`
- `tests/codex-integration/codex-shim-autorestore.test.ts` — `CODEX_SHIM_STATE_MAX_BYTES`

### 완료 조건

`findWindowsCodexTargets`/`writeShim` 잔류. 오라클 리터럴 잔류. 리프가 `./shim`을 import하지 않음.

---

## PR 6 — shim-probe + shim-restore-lock

두 모듈은 서로 import하지 않는다. 한 PR에 넣는 이유는 스택 길이다.

### NEW

`src/codex/shim-probe.ts` 예상 390줄.

원본에서 이동:

- `:44-45` `CODEX_SHIM_INSTALL_PROBE_TIMEOUT_MS`, `CODEX_SHIM_INSTALL_PROBE_EXIT_TIMEOUT_MS`
- `:48-204` `CODEX_SHIM_INSTALL_PROBE_SCRIPT`
- `:769-805` `UnixShimProbeCleanupPhase`, `UnixShimProbeCleanup`, `UnixShimProbeResult`, `SHIM_PROBE_ERROR_CODES`, `SHIM_PROBE_SIGNALS`, `shimProbeCleanup`
- `:806-807` `codexShimProbeHookForTests`, `codexShimProbeShellForTests`
- `:811` `codexShimProbeObservationMs`
- `:814-827` `setCodexShimProbeHookForTests`, `setCodexShimProbeShellForTests`, `setCodexShimProbeObservationMsForTests` (export)
- `:852-981` `readProbeMetadata`, `probeUnixShimInstall`, `probeUnixShimFiles`, `unixProcessGroupAlive`, `terminateUnixProcessGroup`

파사드에 남김 (설치 경로 훅):

- `:808-810` guarded/fresh/rollback write 훅 바인딩
- `:829-850` 그 setter 3개

프로브는 템플릿에서 `CODEX_SHIM_REENTRY_EXIT_CODE`, `CODEX_SHIM_REENTRY_DIAGNOSTIC`를 import한다. `MAX_DIAGNOSTIC_VALUE_BYTES`(`:206`)는 잔여 `lastShimDiscoveryError` truncate(`findCodexOnPath:577`)와 프로브 stderr cap이 공유한다. 상수 한 줄을 프로브 리프가 소유하고 파사드가 import한다. 복제하지 않는다.

정정: 초안 ~215는 `:769-981`(213줄)만이다. 스크립트 157줄을 더하면 ~370 + import ≈ 390.

`src/codex/shim-restore-lock.ts` 예상 175줄.

원본에서 이동:

- `:43` `CODEX_SHIM_RESTORE_LOCK_STALE_MS`
- `:1614-1758` `ShimRestoreLock`, `ShimRestoreLockRecord`, `ShimRestoreLockSnapshot`, `restoreLockPath`, `sameFileIdentity`, `readShimRestoreLockSnapshot`, `sameShimRestoreLock`, `reclaimStaleRestoreLock`, `tryAcquireShimRestoreLock`

`:1612` `let guardedRefreshTransactionId = 0;`는 이동하지 않는다. `:1760`부터의 `planGuardedRefreshTransaction` / `applyGuardedRefreshTransaction`가 잔여에서 `++guardedRefreshTransactionId`(`:1850`)를 쓴다.

restore-lock은 fingerprint에서 `stableShimPathProbe`, `sameFingerprint`, `ShimPathFingerprint`를, state-file에서 `fileErrorCode`를, `../lib/process-control`에서 `isProcessAlive`를 import한다. 파사드를 import하지 않는다.

정정: 초안 ~165 (1614-1759) → 본문 145줄(1614-1758). 파일 예상 175.

### MODIFY

`src/codex/shim.ts`

```ts
export { setCodexShimProbeHookForTests, setCodexShimProbeShellForTests, setCodexShimProbeObservationMsForTests } from "./shim-probe";
import { probeUnixShimFiles } from "./shim-probe";
import { tryAcquireShimRestoreLock, reclaimStaleRestoreLock } from "./shim-restore-lock";
```

자식 오라클 `:1918`이 `setCodexShimProbeObservationMsForTests`를 `shim.ts`에서 가져오므로 재export가 필수다.

`structure/runtime.md:41` 칸에 두 리프 백틱을 추가한다.

예상 잔여 1,470줄.

### DELETE

없음.

### write set

- NEW `src/codex/shim-probe.ts`
- NEW `src/codex/shim-restore-lock.ts`
- MODIFY `src/codex/shim.ts`
- MODIFY `structure/runtime.md` (41행)

### 회귀 테스트

- `tests/codex-integration/codex-shim.test.ts` — Unix install probe (`:335,417,483,517,617,895,927`), restore lock (`:1897,1985,2016`), 자식 import `:1918`
- `tests/codex-integration/codex-shim-autorestore.test.ts`

### 완료 조건

write 훅 3종이 파사드에 남음. `guardedRefreshTransactionId` 파사드. `lastShimDiscoveryError` 파사드. 프로브 리프가 `./shim`을 import하지 않음.

---

## PR 7 — shim-inspect

마지막. 설치 본체는 여전히 파사드.

### NEW

`src/codex/shim-inspect.ts` 예상 185줄.

원본에서 이동:

- `:267-287` `CodexShimBackingForCommand` (export type)
- `:1262-1401` `isLocalAbsoluteInspectionPath` (export), `windowsShimInspectionIsDeferred`, `inspectCodexShimBackingForCommand` (export)

inspect는 다음만 import한다. `./shim` 금지.

- `./shim-state-file`: `readStateResult`, `fileErrorCode`, `stateFiles`
- `./shim-fingerprint`: `shimPathFingerprint`, `stableShimPathProbe`, `statFingerprint`, `isHealthyShimProbe`, `isVersionManagerOwnedCodexPath`
- `./shim-templates`: `shQuote`, `windowsBatchSet`, `psString`, `gitBashPath`

정정: 초안 ~150 (1262-1401)은 타입 21줄을 빠뜨렸다. 본문 140 + 타입 21 + import ≈ 185.

### MODIFY

`src/codex/shim.ts`

```ts
export type { CodexShimBackingForCommand } from "./shim-inspect";
export { isLocalAbsoluteInspectionPath, inspectCodexShimBackingForCommand } from "./shim-inspect";
```

`structure/runtime.md:41` 칸에 `src/codex/shim-inspect.ts`를 추가하고 칸을 마친다. 최종 칸이 백틱해야 할 경로:

- `src/codex/shim.ts` (파사드, 기존)
- `src/codex/shim-templates.ts`
- `src/codex/shim-fingerprint.ts`
- `src/codex/shim-state-file.ts`
- `src/codex/shim-probe.ts`
- `src/codex/shim-restore-lock.ts`
- `src/codex/shim-inspect.ts`

예상 잔여 1,320줄. `installCodexShimInternal:2108-2293`, `findCodexOnPath:541-585`, `findWindowsCodexTargets:587-621`, `writeShim:1427-1479`, `autoRestoreCodexShim`, `uninstallCodexShim`, `diagnoseCodexShim`는 전부 이 파일에 남는다.

### DELETE

없음.

### write set

- NEW `src/codex/shim-inspect.ts`
- MODIFY `src/codex/shim.ts`
- MODIFY `structure/runtime.md` (41행)

### 회귀 테스트

- `tests/codex-integration/codex-shim.test.ts` — `:2287` local inspection paths, `:2304` Windows backing inspection fail-closed
- `src/remote-control/workspace-codex-sandbox.ts` 소비자는 계속 `from "../codex/shim"` (write set 밖, diff 0)

### 완료 조건

`shim.ts` ≤1,999, 모든 리프 ≤1,999. 오라클 3건의 리터럴과 동적 import 경로가 `src/codex/shim.ts`를 가리킴. `findCodexOnPath`/`findWindowsCodexTargets`/`writeShim`/`installCodexShimInternal` 잔류. 소비자 diff 0.

---

## 사이클 2 종료 시 파일 크기

| 파일 | 원본 줄 | 예상 최종 | 비고 |
|---|---|---|---|
| `src/responses/state.ts` | 2,432 | ~1,370 | 파사드+store-core+persist+metrics+replay 카운터 |
| `src/responses/state/replay-fingerprint.ts` | — | ~105 | |
| `src/responses/state/temp-recovery.ts` | — | ~270 | |
| `src/responses/state/spill-failure.ts` | — | ~145 | |
| `src/responses/state/snapshot-codec.ts` | — | ~110 | |
| `src/responses/state/spill-queue.ts` | — | ~620 | |
| `src/codex/shim.ts` | 2,466 | ~1,320 | 파사드+발견+writeShim+설치 본체 |
| `src/codex/shim-templates.ts` | — | ~270 | |
| `src/codex/shim-fingerprint.ts` | — | ~210 | |
| `src/codex/shim-state-file.ts` | — | ~140 | |
| `src/codex/shim-probe.ts` | — | ~390 | |
| `src/codex/shim-restore-lock.ts` | — | ~175 | |
| `src/codex/shim-inspect.ts` | — | ~185 | |

합이 원본보다 ~400줄 많은 것은 파일 헤더·import·핸들 타입이다. 각 파일 1,999 미만이면 래칫 통과. 기준선 회수(`ratchet:update`)는 사이클 D에서 하며 이 7개 PR의 write set에 넣지 않는다.

## 파사드가 다시보내야 하는 기존 export (누락 금지)

`state.ts` 공개 이름. 리프로 정의가 옮겨도 파사드 이름이 그대로여야 한다: `MAX_STORED_RESPONSE_BYTES`, `MAX_SPILLED_RESPONSE_BYTES`, `PreviousResponseReplayFailure`, `ResponseSpillWriteFailureCode`, `ResponseSpillWriteStatus`, `ResponseSpillWriteFailureOrigin`, `responseAdmissionCountersForTests`, `flushPendingResponseSpillsForTests`, `awaitResponseSpillPublicationTailForTests`, `pendingResponseSpillMetricsForTests`, `setResponseSpillShutdownBudgetForTests`, `setResponseSpillAsyncAclAttemptBudgetForTests`, `setResponseSpillShutdownTerminalizationPassLimitForTests`, `setResponseStateByteCapForTests`, `getStoredResponseBytesForTests`, `setSpilledResponseByteCapForTests`, `getSpilledResponseBytesForTests`, `getAccountedResponseSpillBytesForTests`, `ResponseStateTempRecoveryResult`, `ResponseStateTempRecoveryOptions`, `recoverStaleResponseStateTemps`, `flushResponseState`, `replayOverlapSkipsForTests`, `sweepExpiredResponseStates`, `reclaimAbandonedResponseStateTemps`, `inspectAbandonedResponseStateTemps`, `sweepAbandonedResponseStateTemps`, `responseContinuationRetainedStoreSnapshot`, `evictOldestResponseContinuationForBudget`, `expandPreviousResponseInput`, `previousResponseReplayFailure`, `previousResponseReplayPrefixLength`, `copyPreviousResponseReplayProvenance`, `previousResponseScopeMismatch`, `previousResponseConversationId`, `previousResponseProviderState`, `ResponseStateMetrics`, `responseStateMetrics`, `markBodyNonPersistable`, `rememberResponseState`, `setResponseStatePersistAttemptHookForTests`, `runPendingResponseStatePersistForTests`, `responseStatePersistPendingForTests`, `clearResponseStateMemoryForTests`, `clearResponseStateForTests`.

`shim.ts` 공개 이름: `CODEX_SHIM_REPLACEMENT_STABLE_MS`, `CODEX_SHIM_STATE_MAX_BYTES`, `lastCodexDiscoveryError`, `CodexPathScanDeps`, `findCodexOnPath`, `isWindowsInteropDir`, `isVersionManagerOwnedCodexPath`, `buildUnixCodexShim`, `setCodexShimProbeHookForTests`, `setCodexShimProbeShellForTests`, `setCodexShimProbeObservationMsForTests`, `setCodexShimGuardedWriteHookForTests`, `setCodexShimFreshWriteHookForTests`, `setCodexShimRollbackRestoreHookForTests`, `buildWindowsCodexShim`, `buildWindowsPowerShellCodexShim`, `isLocalAbsoluteInspectionPath`, `inspectCodexShimBackingForCommand`, `CodexShimBackingForCommand`, `CodexShimAutoRestoreResult`, `installCodexShim`, `autoRestoreCodexShim`, `uninstallCodexShim`, `isCodexShimInstalled`, `CodexShimDiagnostic`, `diagnoseCodexShim`, `codexShimStatus`.

이 이름을 리네임하거나 소비자 import 경로를 바꾸면 이 사이클의 계약 위반이다.
