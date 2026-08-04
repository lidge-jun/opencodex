# 031 — 로그 타임존(#725)을 GUI 레이아웃 불변으로 다시 만들기

사용자 제약: **GUI 레이아웃은 변경하지 않는다.** 개혁이면 close.

`030`이 세운 배치 B 방향을 이 제약에 맞춰 좁힌다.

## 결함 (#725)

대시보드 로그 타임스탬프가 **브라우저 로컬 시간**으로 렌더된다.
서버가 KST인데 브라우저가 UTC면 로그 시각이 9시간 어긋난다.
`gui/src/pages/Logs.tsx`의 `formatLogTimestamp` / `formatLogDateTime`이
`toLocaleTimeString(localeTag)`를 타임존 없이 부른다.

## #790을 그대로 못 쓰는 이유 — 두 가지, 둘 다 유효

### 1. `/api/logs` 계약 파괴 (감사가 잡음)

`jsonResponse(logs.map(requestLogDto))` → `jsonResponse({timeZone, logs})`.
배열을 가정한 소비자가 최소 네 곳이고 PR은 안 고친다:

- `tests/server-auth.test.ts:1623`
- `tests/claude-native-passthrough.test.ts:119`
- `tests/openai-provider-option-e2e.test.ts:489`
- `tests/server-403-permission-e2e.test.ts:86`

게다가 PR이 고친 유일한 테스트
(`tests/management-api-logs-metrics.test.ts:16-20`)는 두 형태를 **둘 다**
허용한다. 즉 프로덕션 변경을 되돌려도 통과한다 — 회귀 테스트가 아니다.

### 2. GUI 표면 확대 (사용자 제약)

PR은 `Logs.tsx`에 76줄을 더한다: 캐시 페이로드 타입, 세션 캐시 마이그레이션
(`LogEntry[] | LogsCachePayload` 양형 해석), `parseLogsApiResponse`,
`serverTimeZone` state, `LogDetailDialog` prop 추가.

JSX 구조 자체는 안 바꾸므로 엄밀히는 "레이아웃 변경"이 아니다. 그러나
세션 캐시 스키마를 바꾸는 건 사용자 화면의 상태 저장 방식을 바꾸는 것이고,
제약의 의도에 비추면 필요 이상이다.

## 대신 쓸 방법 — 이미 있는 표면

#790 본인이 `src/server/management/config-routes.ts:113`에서
`/api/settings`에 `timeZone`을 **이미 추가한다.** 그런데 GUI는 그걸 안 쓰고
`/api/logs` 봉투를 따로 만들어 읽는다. 같은 값을 두 경로로 나르는 셈이다.

`/api/settings` 하나만 쓴다:

- 이미 존재하는 라우트고 이미 객체를 반환한다 — 계약 파괴 없음
- `SettingsData`(`gui/src/pages/dashboard-shared.ts:43`)는 이미 GUI 전역에
  흐른다. 새 fetch도, 새 캐시 스키마도 필요 없다
- `/api/logs`는 배열 그대로 — 소비자 네 곳 무사

### 변경 지점 (diff-level)

**`src/server/management/config-routes.ts`** — `/api/settings` 응답에 한 줄:

```ts
timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
```

**`gui/src/pages/dashboard-shared.ts`** — `SettingsData`에 `timeZone?: string`.

**`gui/src/pages/Logs.tsx`** — 두 포맷터에 타임존 인자를 넘기는 것만:

```ts
function formatLogTimestamp(ts: number, localeTag?: string, timeZone?: string): string {
  try {
    return new Date(ts).toLocaleTimeString(localeTag, timeZone ? { timeZone } : undefined);
  } catch {
    return new Date(ts).toLocaleTimeString(localeTag);
  }
}
```

`try/catch`가 필요한 이유: 서버가 보낸 타임존 문자열이 브라우저 ICU에
없으면 `toLocaleTimeString`이 `RangeError`를 던진다. 그러면 행 렌더가
통째로 죽는다. 시각이 어긋나는 것보다 로그가 안 보이는 게 나쁘다.

**호출부 2곳**만 인자를 추가한다. JSX 구조, className, CSS 파일 — 전부 그대로.

`/api/logs`, 세션 캐시 스키마, `LogDetailDialog` 시그니처 — 전부 안 건드린다.
detail 다이얼로그는 이번 범위에서 뺀다. prop 추가가 필요한데 그게 표면 확대다.
목록의 시각이 맞으면 #725가 보고한 실패는 사라진다.

## 회귀 테스트

`tests/logs-timezone.test.ts` (신규):

1. `/api/settings`가 유효한 IANA 타임존을 반환한다.
2. `/api/logs`가 **여전히 배열**이다 — 계약 유지의 직접 증거.
3. 포맷터가 서버 타임존으로 렌더한다. **브라우저 TZ와 서버 TZ를 다르게
   고정**해야 한다. 같으면 패치 없이도 통과한다 — #790 테스트가 그래서 무력했다.
4. 알 수 없는 타임존 문자열에 던지지 않고 로컬 포맷으로 떨어진다.

3번은 ablation으로 확인한다: 인자 전달을 되돌리면 실패해야 한다.

## 레이아웃 불변 증거

```bash
git diff <base>..HEAD -- gui/ | grep -E '^[+-].*(className|<div|<td|<span|style=)'
```

빈 출력이어야 한다. 커밋에 그 결과를 기록한다.

## 처분

- #790 — **close.** 방향은 맞지만 계약 파괴와 무력한 테스트가 있다.
  같은 결함을 좁은 표면으로 고친 커밋을 대신 올리고, 원저자를
  `Co-authored-by`로 남긴다.
- #784 — 별건(200건 상한 + 페이지네이션, #726). 이번 사이클 범위 밖.
  워크플로 파일까지 건드리므로 별도 판단이 필요하다.
- #725 — 목록 시각이 맞으면 닫는다.
