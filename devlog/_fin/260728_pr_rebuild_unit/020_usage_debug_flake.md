# 020 — usage-debug 회전 테스트의 Windows 타임아웃 (WP3)

## 증상

`windows-latest` 잡에서 이 테스트만 실패한다:

```
(fail) appendUsageDebug > keeps file size bounded by MAX_LINES across long runs [13624.12ms]
```

PR #576의 CI(run 30308795526 / job 90119324868)에서 관측했다. #576의 diff는
`src/codex/app-server-processes.ts` 계열이고 `src/usage/debug.ts`를 건드리지 않으므로,
이 실패는 그 PR이 만든 것이 아니다. 다른 잡(ubuntu, macos)은 통과한다.

## 원인

`appendUsageDebug()`가 append마다 파일 전체를 다시 읽는다
([src/usage/debug.ts:58-68](/Users/jun/developer/new/700_projects/opencodex/src/usage/debug.ts)):

```ts
appendFileSync(path, `${JSON.stringify(safeRecord)}\n`, ...);
try { chmodSync(path, 0o600); } catch { }
if (existsSync(path)) trimRollingFile(path);   // ← readFileSync 전체
```

`trimRollingFile()`은 `readFileSync` → `split` → 길이 검사를 무조건 수행한다
(`:49-52`). 회전이 필요 없을 때도 전체 파일을 읽는다.

테스트는 `MAX_LINES(200) + KEEP_LINES(100) + 25 = 325`회 append 한다
([tests/usage-debug.test.ts:152-163](/Users/jun/developer/new/700_projects/opencodex/tests/usage-debug.test.ts)).

append 1회당 동기 파일시스템 호출을 정확히 세면:

| 호출 | 출처 | 빈도 |
| --- | --- | --- |
| `mkdirSync` | `ensureUsageDebugDir()` `:44` | 매번 |
| `chmodSync` (디렉터리) | `ensureUsageDebugDir()` `:45` | 매번 |
| `appendFileSync` | `:63` | 매번 |
| `chmodSync` (파일) | `:64` | 매번 |
| `existsSync` | `:65` | 매번 |
| `readFileSync` | `trimRollingFile` `:50` | 매번 |
| `writeFileSync` + `chmodSync` | `trimRollingFile` `:54-55` | 회전 시에만 (이 실행에서 2회) |

정상 경로 6회 × 325 + 회전 2회 × 2 ≈ **1,954회**. 초안이 `mkdirSync`/`chmodSync`
쌍을 빠뜨렸는데, 이 둘은 매 append마다 돌면서 아래 제안한 어떤 수정에도 영향받지 않는다.

Windows에서 이 조합이 특히 비싸다. Defender 실시간 검사가 열기마다 걸리고,
`chmodSync`는 Windows에서 의미가 거의 없으면서도 syscall 비용은 그대로 낸다.
전체 스위트를 동시 실행하는 CI 부하에서 5초 기본 타임아웃을 넘겼다 — 13.6초 소요.

테스트 주석(`:153-154`)이 이미 "MAX*3 appends (that path times out under full-suite
load)"라고 적어 두었다. 한 번 줄인 적이 있고, 아직 부족했다.

## 이것이 결정 불요인 이유

테스트가 검증하려는 계약은 "회전이 몇 번 일어나도 파일이 MAX를 넘지 않는다"이다.
그 계약을 확인하는 데 325회 append가 필요하지 않다. 회전 임계를 **두 번** 넘기면
충분하고, 그건 상수를 낮추면 된다. 동작 변경이 아니라 테스트 비용 조정이다.

## A 게이트 정정 — 폐기한 접근

초안은 `trimRollingFile`에 `statSync().size < USAGE_DEBUG_MAX_LINES * MIN_RECORD_BYTES`
조기 반환을 넣자고 했다. `MIN_RECORD_BYTES = 3`으로. **폐기한다.**

실제 레코드는 약 200바이트다. 임계값 `200 × 3 = 600`바이트는 레코드 3개면 넘어간다.
즉 325회 append 중 조기 반환이 걸리는 건 앞 3회뿐 — 약 0.9%다. "대부분의 append에서
읽기를 생략한다"는 초안의 주장은 사실이 아니었다. 보수적으로 잡은 하한이 게이트를
무력화한 것이다.

`MAX_LINES × 150` 같은 현실적 하한으로 바꾸면 게이트는 실제로 걸리지만, 그때는
"레코드가 150바이트보다 작을 수 있는가"라는 안전성 질문이 생긴다. `bodySample`이
비면 충분히 작아질 수 있다. 회전이 늦어지면 파일이 상한을 넘고, 그건 이 테스트가
막으려던 바로 그 계약 위반이다.

더 근본적으로, Windows에서 13.6초가 걸린 원인은 읽기 1회가 아니라 **열기 1회당
비용**(Defender 실시간 검사)이고, 그건 남는 5회 호출에도 그대로 붙는다. 읽기 하나를
제거해도 6분의 1만 준다. 근본 수정처럼 보이지만 아니다.

## 변경 — MODIFY `tests/usage-debug.test.ts`

타임아웃만 올린다. Bun의 `test()`는 세 번째 인자로 밀리초 타임아웃을 받는다.

```diff
   test("keeps file size bounded by MAX_LINES across long runs", () => {
     // Cross the rotate threshold twice — enough to prove the bound holds across
     // multiple rewrites without MAX*3 appends (that path times out under full-suite load).
     const total = USAGE_DEBUG_MAX_LINES + USAGE_DEBUG_KEEP_LINES + 25;
     for (let i = 0; i < total; i++) {
       appendUsageDebug(sample({ requestId: `ocx-${i}`, ts: i }));
     }
     const path = usageDebugPath();
     const lines = readFileSync(path, "utf-8").split(/\r?\n/).filter(Boolean);
     expect(lines.length).toBeLessThanOrEqual(USAGE_DEBUG_MAX_LINES);
     expect(lines.length).toBeGreaterThanOrEqual(USAGE_DEBUG_KEEP_LINES);
-  });
+  }, 30_000);
```

주석도 함께 갱신해서, 다음 사람이 왜 이 숫자인지 알 수 있게 한다:

```diff
   test("keeps file size bounded by MAX_LINES across long runs", () => {
     // Cross the rotate threshold twice — enough to prove the bound holds across
     // multiple rewrites without MAX*3 appends (that path times out under full-suite load).
+    //
+    // The 325 appends here cost ~1,950 synchronous fs calls (6 per append: mkdir, chmod,
+    // append, chmod, exists, read). On windows-latest under full-suite load that measured
+    // 13.6s — past the 5s default — while ubuntu and macos stay well under it. The cost is
+    // per-open (Defender), not per-byte, so trimming one of the six calls would not move it
+    // enough to matter; the honest fix is to let the test have the time it needs.
     const total = USAGE_DEBUG_MAX_LINES + USAGE_DEBUG_KEEP_LINES + 25;
```

## 검증 (C-ACTIVATION-GROUNDING-01)

이 변경은 조건부 분기를 **추가하지 않는다** — 테스트 타임아웃 상수만 바꾼다.
따라서 활성화 증거의 대상은 새 분기가 아니라 기존 계약이다:

- `rotates to the most recent USAGE_DEBUG_KEEP_LINES once ... exceeded` — MAX+1회
  append 후 정확히 KEEP 줄, 최신 레코드 생존
- `keeps file size bounded by MAX_LINES across long runs` — 회전 2회 후에도 상한 유지

둘 다 그대로 통과해야 한다. 회전 로직은 한 줄도 건드리지 않으므로 통과가 기대치다.

```
bun test tests/usage-debug.test.ts
```

로컬(macOS)에서는 원래 통과하므로, 이 수정의 진짜 검증은 CI의 windows-latest다.
로컬 통과는 "회귀 없음"의 증거이지 "타임아웃 해결"의 증거가 아니다 — 그 구분을
D 요약에 남긴다.

## 스코프 밖

`appendUsageDebug`의 per-append 재읽기 최적화. 실제 비효율이 맞지만, 이 실패를
고치는 데 필요하지 않고 크리덴셜 로그 파일의 회전·권한 동작을 건드린다. 별건이다.

## SoT 동기화

없음. `usage-debug.jsonl`의 회전 계약은 바뀌지 않는다 — 사용자 노출 동작 무변경.
