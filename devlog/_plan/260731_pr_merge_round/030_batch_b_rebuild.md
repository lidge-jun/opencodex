# 030 — 배치 B: 브랜치에서 재작성 3건

결함은 진짜인데 기여자 구현을 그대로 태우면 회귀가 난다. 아이디어와 크레딧은
유지하고 구현만 다시 만든다. 원저자를 `Co-authored-by`로 남긴다.

## 1. 대시보드 로그 — #790 + #784를 하나로 (#725 + #726)

두 PR이 같은 계약을 서로 다르게 바꾼다. 따로 태우면 충돌하므로 한 커밋으로 묶는다.

### 왜 그대로 못 태우나

둘 다 `/api/logs` 응답을 배열에서 `{timeZone, logs}` 봉투로 바꾼다
(`src/server/management/logs-usage-routes.ts:126-129`). 그 계약을 배열로 가정한
소비자가 최소 네 곳 있다:

- `tests/server-auth.test.ts:1623`
- `tests/claude-native-passthrough.test.ts:119`
- `tests/openai-provider-option-e2e.test.ts:489`
- `tests/server-403-permission-e2e.test.ts:86`
- 그리고 GUI mock 다수

PR들은 이 소비자들을 안 고친다. 더 나쁜 건 #790이 고친 유일한 테스트가 옛 형태와
새 형태를 **둘 다 허용**한다는 점이다. 즉 그 테스트는 패치를 되돌려도 통과한다 —
회귀 테스트 구실을 못 한다.

### 재작성 방향

**배열 계약을 유지한다.** 타임존은 응답 헤더(`X-OpenCodex-Timezone`)로 나른다.
기존 소비자를 하나도 안 건드리고 GUI만 헤더를 읽는다.

감사가 잡은 것: `jsonResponse()`는 일반 CORS 헤더만 붙인다
(`src/server/auth-cors.ts:167-171`). 커스텀 응답 헤더는 `Access-Control-Expose-Headers`
없이는 **cross-origin에서 읽히지 않는다.** 대시보드가 same-origin으로만 뜬다는
보장이 없으므로(포트 리매핑 터널 사례가 #570에 있다) `Access-Control-Expose-Headers:
X-OpenCodex-Timezone`을 같이 내보낸다. 그리고 cross-origin 요청에서 헤더가 실제로
읽히는지 확인하는 테스트를 넣는다 — 안 그러면 same-origin에서만 통과하고 실사용에서
조용히 실패한다.

- `src/server/management/logs-usage-routes.ts` — 배열 본문 유지, 헤더 추가.
  `limit`/`offset` 쿼리 파라미터 수용.
- `src/server/request-log.ts:128-129` — 200건 링 버퍼 상한을 올린다. `:741-764`에
  페이지네이션을 추가한다.
- `gui/src/pages/Logs.tsx` — HEAD의 `useDataSurface` 리팩터 위에 얹는다.
  #784는 그 이전의 수동 `fetchLogs` 흐름을 가정하고 있어 그대로는 안 맞는다.
  타임스탬프를 서버 타임존으로 포맷(`:288-293`, `:366-371`).

### 회귀 테스트 (우리가 쓴다)

1. 서버가 여전히 **배열**을 반환한다 — 기존 소비자가 안 깨진다는 증거.
2. 헤더에 서버 타임존이 실린다.
3. `limit`/`offset`으로 200건 너머를 읽을 수 있다.
4. GUI가 브라우저 로컬이 아니라 헤더 타임존으로 렌더한다. 브라우저 TZ를 서버와
   다르게 고정해놓고 확인해야 실제로 구동된다.
5. cross-origin 응답에서 `Access-Control-Expose-Headers`에
   `X-OpenCodex-Timezone`이 실려 나간다.

4번이 핵심이다. 브라우저와 서버 타임존이 같으면 이 테스트는 패치 없이도 통과한다.

#784는 `.github/workflows/enforce-pr-target.yml:284-304`도 건드린다. 워크플로
변경은 `AGENTS.md`상 보안 리뷰 대상이고 이 결함과 무관하므로 **가져오지 않는다.**

닫는 이슈: #725 FULL, #726 FULL.

## 2. #771 — Windows autostart Run 항목 260자 초과 (#696 FULL)

지금: `src/tray/windows.ts:153-171`이 PowerShell 전체 명령을 만들고 `:500-571`이
그걸 Run 레지스트리 값으로 쓴다. 260자를 넘으면 로그인 후 실행이 안 된다.

PR 방향은 맞다: UTF-16LE VBS 런처를 만들어 소유권을 확인하고, 상태를 추적하고,
실패 시 롤백한다.

**막힌 곳은 하나**: `tests/windows-tray.test.ts`가 HEAD와 import/컨텍스트에서
충돌한다. 기능 코드는 깨끗하게 붙는다. 충돌만 풀고 기여자 커밋을 그대로 올린다.

테스트: `tests/windows-tray-run-limit.test.ts`가 패치 없이 실패한다.
`tests/windows-tray.test.ts`가 유니코드 경로, UNC 경로, 소유권 경로를 덮는다.

실행 검증은 macOS에서 불가능하다. 이 건은 Windows 매트릭스 CI가 판정한다.
커밋에 그 한계를 명시한다.

## 3. #780 — Windows 스케줄러 stop이 실제로 멈추지 않는다 (#764 PARTIAL)

지금:

- `src/service.ts:1629-1640` — pid 없이 조기 반환
- `src/server/proxy-liveness.ts:128-151` — health가 보고한 PID를 그대로 믿는다
- `src/service.ts:1948-1964` — `ops.stop()` 직후 성공을 보고한다

### PR의 진단이 얕다

패치는 `schtasks /end`가 **에러를 낼 때만** 6.5초 기다린다. 그런데 보고된 실패
모드는 `/end`가 **성공했는데** 래퍼 프로세스가 살아남아 5초 뒤 자식을 재생성하는
경우다. 그 경로에서는 이 패치도 여전히 거짓 성공을 보고한다.

### 재작성 방향

`/end` 결과와 무관하게 **항상** 검증한다:

1. `/end` 호출.
2. 래퍼/태스크가 재시작 창(관측된 5초 + 여유)을 지나 실제로 죽었는지 확인.
3. 살아 있는 프록시가 없는지 확인한 **뒤에** native Codex 복구를 진행.
4. PID는 health 보고를 믿지 말고 프로세스 존재로 교차 확인.

### 회귀 테스트

`/end`가 성공을 반환하지만 래퍼가 살아남아 자식을 재생성하는 시나리오. 지금
구현과 PR 구현 **양쪽 다** 실패해야 한다. 그게 이 재작성이 새 문제를 푼다는
증거다.

보안: 파괴적 PID 제어와 서비스 자격증명을 건드린다. 커밋에 명시한다.
#764는 PARTIAL로 열어둔다 — `--native` 스위치 문제는 별개다.

## 검증

배치 A와 동일. 각 건 `tsc` + 대상 테스트, 배치 종료 시 전체 스위트 +
`privacy:scan` + 메인 체크아웃 대조, 그 다음 푸시.
