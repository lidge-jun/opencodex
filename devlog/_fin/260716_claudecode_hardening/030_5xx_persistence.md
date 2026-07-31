# 030 — 실패 진단 필드의 usage.jsonl 영속화

## 목표

260716 사건에서 "슬로우 502였나, SSE 도중 response.failed였나"를 판별 못 한 원인은
진단 필드(errorCode/terminalStatus/closeReason/upstreamError)가 **메모리 200개
링버퍼에만** 있고 영속 usage.jsonl 항목에서 탈락하기 때문. 새 파일을 만들지 않고
기존 usage.jsonl 항목에 실패 진단 필드를 **additive**로 싣는다(하위 호환: 기존
리더는 미지 필드 무시).

## 변경 파일

### MODIFY `src/usage/log.ts`

`PersistedUsageEntry`에 옵션 필드 추가:

```ts
export interface PersistedUsageEntry {
  // ...기존 필드...
  errorCode?: string;
  terminalStatus?: string;          // ResponsesTerminalStatus, 문자열로 보존
  closeReason?: "terminal" | "client_cancel" | "non_stream";
  upstreamError?: string;           // 캡처 시점에 이미 redactSecretString + slice(0,500)
}
```

`normalizeUsageEntry`에 같은 필드 스프레드 추가:

```ts
...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
...(entry.terminalStatus ? { terminalStatus: entry.terminalStatus } : {}),
...(entry.closeReason ? { closeReason: entry.closeReason } : {}),
...(entry.upstreamError ? { upstreamError: entry.upstreamError } : {}),
```

### MODIFY `src/server/request-log.ts` `addRequestLog` (~line 87)

`appendUsageEntry({...})` 호출에 실패 항목 한정으로 진단 필드 전달:

```ts
const failureDiagnostics = entry.status >= 400 || (entry.terminalStatus && entry.terminalStatus !== "completed")
  ? {
      ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
      ...(entry.terminalStatus ? { terminalStatus: entry.terminalStatus } : {}),
      ...(entry.closeReason ? { closeReason: entry.closeReason } : {}),
      ...(entry.upstreamError ? { upstreamError: entry.upstreamError } : {}),
    }
  : {};
appendUsageEntry({ /* 기존 필드 */, ...failureDiagnostics });
```

성공(2xx, terminal completed) 항목은 현행 그대로 — 파일 성장률 영향 최소화.
(status>=400 게이트는 499 client-cancel 항목도 포함한다 — 의도된 포함, 진단 가치 있음.)
redaction은 `logCtx.upstreamError` 캡처 지점(request-log.ts ~line 286,
`redactSecretString(...).slice(0,500)`)에서 이미 적용되므로 추가 처리 불요.
`RequestLogEntry.closeReason`에 `"non_stream"`이 있으므로 Persisted 쪽 유니온도 동일하게.

## OUT

- 새 로그 파일 생성, 로테이션 정책 변경, GUI 노출 — 범위 밖.
- 200개 링버퍼 크기 자체 변경 — 불필요(영속화로 목적 달성).

## Accept criteria + activation

- NEW `tests/usage-failure-persistence.test.ts`:
  1. `OPENCODEX_HOME=<tmpdir>` 격리(감사 확인: config.ts:62의 per-call env 해석이라
     프로세스 중간 오버라이드 가능 — tests/api-usage.test.ts:68 패턴) 후
     `addRequestLog`로 status 502 +
     terminalStatus "failed" + closeReason "terminal" + upstreamError 항목 기록 →
     usage.jsonl 마지막 라인 JSON에 4개 필드 존재 (cr3)
  2. status 200 completed 항목 → 진단 필드 부재 (기존 형태 불변)
- 전체 스위트 green. `addRequestLog`는 `appendUsageEntry`를 직접 호출(주입 seam
  없음, 감사 blocker #5 확인)이므로 env-var 격리 경로가 유일한 assertion 루트다.
