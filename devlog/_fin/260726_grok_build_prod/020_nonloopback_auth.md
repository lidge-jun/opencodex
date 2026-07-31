---
created: 2026-07-26
status: plan
phase: wp2
blockers: [B1]
tags: [grok-build, auth, non-loopback, security]
---

# 020 — 비루프백 자동 등록 거부 (B1)

> **개정 2026-07-26 (A-게이트 감사 반영).** 초판은 `env_key` 방출로 자동 등록을 유지하려 했다.
> 감사에서 그 설계가 보안 퇴행임이 원본 코드와 상위 테스트로 확인됐다(`001` E3 정정 참조).
> 본 문서는 메인테이너가 요구한 원안 — 비루프백에서는 fence를 만들지 않는다 — 으로 되돌린다.

대상 파일: `src/grok/inject.ts`, `src/grok/sync.ts`, `tests/grok-config-inject.test.ts`,
`tests/grok-sync.test.ts`.
근거: `000_blocker_inventory.md` B1, `001_grok_source_evidence.md` E3.

## 왜 자동 등록을 거부하는가

비루프백 바인드에서 우리가 취할 수 있는 선택지는 셋뿐이고, 셋 다 문제가 있거나 우리 권한 밖이다.

| 선택지 | 결과 |
|--------|------|
| 리터럴 실토큰을 fence에 쓴다 | 사용자 소유 파일에 비밀을 기록하고, 매 sync마다 사용자가 고친 값을 덮어쓴다 (현재 버그) |
| `env_key`만 쓰고 `api_key`를 뺀다 | 변수 미설정 시 grok이 **xAI 세션 토큰을 평문 LAN 주소로 전송** (E3 정정) |
| 자동 등록을 하지 않는다 | 사용자 파일을 건드리지 않고, 유출 경로가 없으며, 수동 설정 안내로 기능을 잃지 않는다 |

세 번째가 메인테이너 요구와 일치하고 유일하게 안전하다. 자동화는 우리가 인증을 안전하게 책임질 수
있는 범위(루프백)로 한정한다.

## 설계

### 1. 루프백 판정을 공유 가능한 곳으로

`src/codex/inject.ts`의 `isLoopbackHostname`은 모듈 private이고, 같은 이름이 `auth-cors.ts`에
또 export되어 있으며 `service.ts`에 사본이 하나 더 있다. 새 사본을 만들지 않는다.
`src/codex/inject.ts`에서 `isLoopbackHostname`을 **export**하고 grok 모듈이 그것을 쓴다.
(`providerBaseHost`는 `0.0.0.0`을 `127.0.0.1`로 접는 다이얼 주소 매퍼라 판정에 쓸 수 없다.)

### 2. `injectGrokConfig`가 비루프백에서 거부한다

거부는 `buildGrokManagedBlock`이 아니라 **파일을 건드리기 전** `injectGrokConfig` 초입에서 한다.
새 `skippedReason`을 추가한다:

```ts
skippedReason?: "no-grok-home" | "orphaned-marker" | "non-loopback";
```

```ts
if (!isLoopbackHostname(opts.hostname)) {
  return {
    ok: true,          // 실패가 아니라 의도된 비적용 — 기동을 막지 않는다.
    changed: false,
    skippedReason: "non-loopback",
    message:
      `Grok auto-registration skipped: opencodex is bound to a non-loopback host `
      + `(${opts.hostname}). Non-loopback requests need your admission token, and a managed `
      + `block would either store that secret in your config or overwrite it on the next start. `
      + `Add models manually OUTSIDE the opencodex fence — see the Grok Build guide.`,
  };
}
```

`ok: true`인 이유: 이것은 오류가 아니라 정책이다. CLI의 `else if (!r.ok)` 경로가 경고를 찍지
않도록 하고, 대신 `skippedReason`을 보고 안내 문구를 한 번 출력한다.

### 3. 이미 존재하는 fence는 어떻게 하는가

사용자가 루프백으로 쓰다가 `hostname`을 비루프백으로 바꾸면, 이전에 만든 fence가 남아 죽은
`127.0.0.1` 주소를 가리킨다. 거부하면서 **기존 관리 블록은 제거**한다 — 그것도 우리가 만든 것이므로
정리 책임이 있다.

```ts
// 비루프백으로 전환된 경우: 우리가 남긴 (이제 잘못된) 블록을 걷어낸다.
const removed = stripGrokConfig({ ...(opts.grokHome ? { grokHome: opts.grokHome } : {}) });
```

제거 결과는 메시지에 합쳐 사용자에게 알린다.

### 4. 사용자 실토큰 보존

비루프백에서 우리는 아무것도 쓰지 않으므로, 사용자가 fence 밖에 둔 `api_key`는 정의상 보존된다.
메인테이너가 재현한 `REAL_TOKEN_PRESERVED=false`가 `true`로 뒤집힌다.

## 회귀 테스트

`tests/grok-config-inject.test.ts`:
1. `hostname: "0.0.0.0"` → 파일이 생성되지 않고 `skippedReason === "non-loopback"`,
   `ok === true`, `changed === false`.
2. `hostname: "192.168.1.10"` → 동일. 메시지에 수동 설정 안내가 포함된다.
3. `hostname` 미지정/`127.0.0.1`/`localhost`/`::1`/`::` → 기존대로 fence를 만든다
   (`0.0.0.0`과 `::`는 와일드카드지만 비루프백 노출이므로 **거부** 쪽으로 분류한다는 점을 테스트로 고정).
4. 루프백 fence가 있는 상태에서 비루프백으로 재호출 → 기존 관리 블록이 제거되고 사용자 바이트는 보존.
5. 어떤 경우에도 `env_key`가 방출되지 않는다 (세션 토큰 폴백 회귀 방지 가드).

`tests/grok-sync.test.ts`:
6. 비루프백 hostname으로 `syncGrokConfig`를 **두 번** 실행해도 사용자가 fence 밖에 둔
   `[model.mine] api_key = "real-token"`이 바이트 그대로 남는다 (B1 재현의 반증).

## 와일드카드 바인드 분류

`0.0.0.0` / `::`는 `isLoopbackHostname`이 false를 준다(그 함수는 루프백 리터럴만 참으로 본다).
이 값들은 모든 인터페이스에 노출하므로 admission token이 요구되며, 따라서 **거부 대상이 맞다**.
`providerBaseHost`가 이들을 `127.0.0.1`로 접는 것은 다이얼 주소 계산용이지 보안 판정이 아니다 —
판정에는 절대 쓰지 않는다.

## 게이트

`bun test tests/grok-config-inject.test.ts tests/grok-sync.test.ts` → `bun run typecheck`.
