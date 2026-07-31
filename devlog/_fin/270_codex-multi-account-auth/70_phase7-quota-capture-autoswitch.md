# Phase 7: Quota Capture + Auto-Switch (70-79)

> Superseded security note (2026-06-25): This document predates the 280 security patch plan and Phase 10-60 hardening. Treat release-readiness, full-email UI, ordinal request-log labels, unauthenticated management API, fail-open fallback, and earlier account-boundary claims here as historical only. Current merge/deploy evidence is tracked under `devlog/280_codex-multi-auth-security-patch-plan/` and `devlog/_plan/260624_codex-multi-auth-security-implementation/`.

PABCD 7턴: upstream 응답에서 quota 헤더 캡처 + auto-switch 로직 구현

## Scope

- src/server.ts — passthrough 응답 후 x-codex-*-used-percent 캡처
- src/codex-auth-api.ts — auto-switch 실행 로직 (resolveCodexAccountForThread 연동)
- gui/src/pages/CodexAuth.tsx — quota bar 실시간 표시 반영 확인

## Problem

현재 quota 데이터 소스 2개:
1. Main account: GET chatgpt.com/backend-api/wham/usage (Phase 실제 구현 완료)
2. Pool accounts: passthrough 응답 헤더에서 x-codex-primary/secondary-used-percent

Pool 계정의 quota는 실제 passthrough 요청이 해당 계정으로 갈 때만 헤더가 돌아옴.
→ 한번도 사용 안 한 pool 계정은 quota 0%로 표시 (합리적 기본값)

## Files

### MODIFY src/server.ts

passthrough 응답 후 헤더 캡처 (HTTP path, line ~180 근처):

```ts
// After adapter response received, before sending to client:
// (passthrough adapter streams directly, so capture from upstream response headers)
//
// 실제 구현 위치: createResponsesPassthroughAdapter의 buildRequest가 반환하는
// upstream Response의 headers에서 추출해야 함.
// → 이건 bridge.ts의 bridgeToResponsesSSE 안에서 처리.

// server.ts에서 accountId를 알고 있고, upstream response headers가 bridge를 통해 relay되니까
// safeResponseHeaders에서 이미 x-codex-*-used-percent를 통과시키고 있음.
// → response relay 후 quota 업데이트:

if (accountId) {
  const weeklyRaw = upstreamHeaders?.get("x-codex-secondary-used-percent");
  const fiveHourRaw = upstreamHeaders?.get("x-codex-primary-used-percent");
  if (weeklyRaw || fiveHourRaw) {
    const { updateAccountQuota } = await import("./codex-auth-api");
    updateAccountQuota(accountId, parseFloat(weeklyRaw ?? "0"), parseFloat(fiveHourRaw ?? "0"));
  }
}
```

주의: passthrough adapter는 upstream response를 직접 relay하므로
헤더 접근 타이밍이 bridge 내부임. 정확한 삽입 위치는 구현 시 확인 필요.

### MODIFY src/server.ts — Auto-switch in resolveCodexAccountForThread

```ts
// resolveCodexAccountForThread 에 auto-switch 추가:
function resolveCodexAccountForThread(
  threadId: string | null,
  config: OcxConfig,
): string | null {
  if (threadId && threadAccountMap.has(threadId)) {
    return threadAccountMap.get(threadId)!;
  }
  const active = config.activeCodexAccountId;
  if (!active) return null;

  // Auto-switch check
  const threshold = config.autoSwitchThreshold ?? 80;
  if (threshold > 0) {
    const { getAccountQuota } = require("./codex-auth-api"); // sync import
    const quota = getAccountQuota(active);
    if (quota && quota.weeklyPercent >= threshold) {
      const pool = (config.codexAccounts ?? []).filter(a => !a.isMain && a.id !== active);
      let best = active;
      let bestUsage = quota.weeklyPercent;
      for (const p of pool) {
        const pq = getAccountQuota(p.id);
        const usage = pq?.weeklyPercent ?? 0;
        if (usage < bestUsage) { best = p.id; bestUsage = usage; }
      }
      if (best !== active) {
        config.activeCodexAccountId = best;
        saveConfig(config);
      }
    }
  }

  if (threadId) threadAccountMap.set(threadId, active);
  return active;
}
```

## Verification

- quota bar가 실제 사용 후 업데이트되는지 확인
- auto-switch가 threshold 초과 시 다음 세션에서 작동하는지 확인
- 기존 테스트 회귀 없음

## Commits

```
feat: capture quota from passthrough response headers
feat: implement auto-switch at usage threshold
```
