# 050 — WP6: `ocx sync`가 켜진 클라이언트 통합까지 동기화

## 문제

`ocx sync`는 Codex 카탈로그만 쓴다.

```ts
// src/server/management/config-routes.ts:383-395
if (url.pathname === "/api/sync" && req.method === "POST") {
  const { syncModelsToCodex } = await import("../../codex/sync");
  const result = await syncModelsToCodex(runtime?.port, loadConfig(), null);
  ...
}
```

Grok이나 Claude Desktop 토글이 켜져 있어도 갱신되지 않는다. 이번 컨텍스트 변경
(1,050,000 -> 922,000)처럼 값이 바뀌면 Codex만 새 값을 받고 나머지는 옛 값에 머문다.
사용자가 "모델 세팅할 때도 그렇고"라고 한 상황이 이것이다.

## 이미 있는 것

기동 경로는 각 통합을 **켜진 것만** 동기화한다:

| 통합 | 게이트 | 위치 |
| --- | --- | --- |
| Codex | `syncCodexOnStartIfEnabled` | `src/cli/index.ts:379` |
| Grok | `shouldSyncGrokOnStart(config)` | `src/cli/index.ts:412-419` |
| Claude Desktop | `claudeDesktopIntegrationEnabledNow()` | `src/cli/claude-desktop.ts` |

게이트 함수(`grokIntegrationEnabled`, `claudeDesktopIntegrationEnabled`)는
`src/codex/desired-state.ts`에 이미 있다. 새로 만들 상태가 없다.

즉 `/api/sync`가 기동 경로와 같은 규칙을 따르기만 하면 된다.

## 설계

`/api/sync`를 다음 순서로 바꾼다.

1. `syncModelsToCodex` — 지금과 동일. Codex 카탈로그가 다른 통합의 입력이므로 먼저 돈다.
2. `grokIntegrationEnabled(config)`이면 `syncGrokConfig(port, config, ...)`.
3. `claudeDesktopIntegrationEnabled(config)`이면 Desktop writer.

**부분 실패는 전체 실패가 아니다.** Codex sync가 성공하고 Grok이 실패하면 200을 유지하되
응답에 통합별 결과를 싣는다. 기동 경로가 이미 그렇게 한다 — Grok 실패가 start를 막지 않는다.

응답 형태:

```json
{
  "ok": true,
  "...codex 기존 필드...": "…",
  "integrations": [
    { "client": "grok", "ok": true, "changed": true },
    { "client": "claude-desktop", "ok": false, "reason": "…" }
  ]
}
```

꺼진 통합은 배열에 넣지 않는다 — "건드리지 않았다"와 "실패했다"를 구분해야 한다.

## 범위 밖

- 통합을 자동으로 켜지 않는다. `ocx sync`는 동기화 명령이지 활성화 명령이 아니다.
- 새 CLI 플래그를 만들지 않는다. 기존 `ocx sync`의 동작이 넓어질 뿐이다.
- Codex sync가 `refused`(409)면 나머지도 돌리지 않는다 — 카탈로그가 안 써졌으면
  하위 통합이 읽을 새 값이 없다.

## 테스트

- Grok on / Desktop off: Grok만 배열에 나오고 Desktop 설정 파일은 mtime 불변.
- 둘 다 off: 배열이 비고 Codex만 갱신 (현행 동작과 동일).
- Grok 실패: HTTP 200 유지, `integrations[0].ok === false`, Codex 결과는 성공으로 보고.
- Codex refused: 409이고 `integrations`가 비어 있음.
- 값 전파: 컨텍스트 상수를 바꾼 뒤 sync 한 번으로 `~/.grok/config.toml`의
  `context_window`가 새 값이 되는지 (C-ACTIVATION-GROUNDING-01).

## 검증 명령

`bun test --isolate tests/management-sync.test.ts tests/grok-sync.test.ts` (해당 파일 확인 후 확정),
`bun x tsc --noEmit`.

