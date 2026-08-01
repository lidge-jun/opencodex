# 010 — management-api authMode GET/PUT 왕복 + live-apply + stale 토큰 정리

감사(sol, GO-WITH-FIXES blockers=4) 반영판. RCA 증거는 `001_research.md`.

## MODIFY src/server/management-api.ts

### 1) GET `/api/claude-code` 응답에 authMode 추가 (~L995)

`enabled` 바로 아래에 삽입:

```ts
authMode: config.claudeCode?.authMode === "proxy" ? "proxy" : "subscription",
```

### 2) PUT 파서에 authMode 분기 추가 (body 캐스트 타입에 `authMode?: unknown` 추가, `enabled` 분기 옆)

```ts
if (body.authMode !== undefined) {
  // "proxy" stores the key; "subscription" (the default) deletes it —
  // OcxClaudeCodeConfig.authMode is typed `"proxy"` only (src/types.ts:291).
  if (body.authMode !== "proxy" && body.authMode !== "subscription") {
    return jsonResponse({ error: 'authMode must be "proxy" or "subscription"' }, 400);
  }
  if (body.authMode === "proxy") next.authMode = "proxy";
  else delete next.authMode;
}
```

주의: `next`는 `{ ...(config.claudeCode ?? {}) }` 스프레드라 delete 패턴이 기존
`autoContext`/`injectAgents` default-drop 관례와 동일.

### 3) live-apply 트리거 확장 (블로커 #2, ~L1179)

`if (body.systemEnv !== undefined)` → `if (body.systemEnv !== undefined || body.authMode !== undefined)`
(내부 `applySystemEnvToggle(config, config.port)` 호출 동일). 비-darwin이나
`systemEnv !== true`에서는 기존 가드가 no-op/revert 처리하므로 안전.

## MODIFY src/server/system-env.ts (블로커 #1)

`injectSystemEnv()`의 토큰 주입 분기(~L241-245) 뒤에 subscription 복귀 정리 추가:

```ts
if (config.apiKeys?.length) {
  inject("ANTHROPIC_AUTH_TOKEN", config.apiKeys[0].key);
} else if (config.claudeCode?.authMode === "proxy" && launchctlGetenv("ANTHROPIC_AUTH_TOKEN") === undefined) {
  inject("ANTHROPIC_AUTH_TOKEN", "opencodex-proxy");
} else if (config.claudeCode?.authMode !== "proxy"
  && injectedKeys.includes("ANTHROPIC_AUTH_TOKEN")
  && launchctlGetenv("ANTHROPIC_AUTH_TOKEN") === "opencodex-proxy") {
  // Subscription switch-back: remove ONLY the opencodex-owned dummy token so a
  // launchd-started Claude regains its own claude.ai OAuth. User-set tokens
  // (not in injectedKeys, or with a different value) are never touched.
  unsetLaunchctlEnv("ANTHROPIC_AUTH_TOKEN");
  const idx = injectedKeys.indexOf("ANTHROPIC_AUTH_TOKEN");
  if (idx >= 0) injectedKeys.splice(idx, 1);
  writeTracking(port, injectedKeys);
}
```

shell env 파일(`writeShellEnvFile`)은 매 주입마다 config 기준으로 재생성되므로
proxy 라인은 자연히 빠진다 — 추가 변경 불필요.

## MODIFY tests/claude-management-api.test.ts

회귀 테스트 2건 추가 (loadConfig()는 캐시 없이 디스크 재파싱 — src/config.ts:507;
persisted-config 단언은 기존 관례 그대로):

```ts
test("PUT round-trips authMode (proxy persists, subscription clears)", async () => {
  const server = startServer(0);
  try {
    // default: subscription
    let get = await fetch(new URL("/api/claude-code", server.url)).then(r => r.json()) as Record<string, unknown>;
    expect(get.authMode).toBe("subscription");
    // proxy persists to config
    const put = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authMode: "proxy" }),
    });
    expect(put.status).toBe(200);
    get = await fetch(new URL("/api/claude-code", server.url)).then(r => r.json()) as Record<string, unknown>;
    expect(get.authMode).toBe("proxy");
    expect(loadConfig().claudeCode?.authMode).toBe("proxy");
    // subscription clears the key
    await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authMode: "subscription" }),
    });
    expect(loadConfig().claudeCode?.authMode).toBeUndefined();
  } finally { server.stop(true); }
});

test("PUT rejects invalid authMode values (invalid string + non-string)", async () => {
  const server = startServer(0);
  try {
    for (const bad of ["x", 42]) {  // 블로커 #3: 테이블 테스트
      const r = await fetch(new URL("/api/claude-code", server.url), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authMode: bad }),
      });
      expect(r.status).toBe(400);
    }
  } finally { server.stop(true); }
});
```

## MODIFY tests/claude-management-api.test.ts — live-apply 활성 증거 (재감사 R2 반영)

authMode 단독 PUT이 `applySystemEnvToggle`에 도달함을 관찰 가능하게 단언:

```ts
import * as systemEnv from "../src/server/system-env";

test("authMode-only PUT triggers system-env reconciliation", async () => {
  const applySpy = spyOn(systemEnv, "applySystemEnvToggle").mockResolvedValue({ reverted: false, reason: "test" });
  const server = startServer(0);
  try {
    await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authMode: "proxy" }),  // systemEnv 필드 없이
    });
    expect(applySpy).toHaveBeenCalled();
  } finally { applySpy.mockRestore(); server.stop(true); }
});
```

(주의: management-api가 `applySystemEnvToggle`을 정적 import하므로 namespace
spy가 유효한지 확인. bun 모듈 캐시상 안 되면 시스템-env쪽 단위 테스트로 대체하되
그 결정을 이 문서에 기록.)

## MODIFY tests/system-env.test.ts (블로커 #1 활성 증거)

기존 spy 하네스(execSync/readFileSync mock) 재사용. 전환 테스트:

1. tracking mock에 `injectedKeys: [..., "ANTHROPIC_AUTH_TOKEN"]` 포함 + 포트 일치.
2. `launchctl getenv ANTHROPIC_AUTH_TOKEN` → `"opencodex-proxy"` 반환하도록 mock.
3. authMode 없는 config로 `injectSystemEnv` 호출.
4. execSpy 호출 목록에 `launchctl unsetenv ANTHROPIC_AUTH_TOKEN` 존재 단언 +
   tracking JSON의 injectedKeys에서 토큰 제거 단언.
5. 대조군(사용자 소유 토큰 보존): getenv가 다른 값(실제 키)을 반환하면
   unsetenv가 호출되지 않음을 단언.
6. 대조군 2(재감사 R2): getenv가 `"opencodex-proxy"`를 반환해도 tracking의
   injectedKeys에 `ANTHROPIC_AUTH_TOKEN`이 없으면(=우리가 주입한 적 없음)
   unsetenv가 호출되지 않음을 단언 — 소유권 가드와 값 가드를 독립 케이스로 커버.

## Verify

- `bun test tests/claude-management-api.test.ts tests/system-env.test.ts`
- `bunx tsc --noEmit`
