# 010 — WP2: SSH 원격 프록시 게이트 (`isLoopbackRequestHost`)

대상: `src/server/auth-cors.ts`
근본 원인: `260727_owner_decision_ledger/009_ssh_remote_proxy_rootcause.md`
계층: 서버 인증 게이트 — `/v1/*` 전 경로가 통과하는 최하부

## 문제

```ts
// src/server/auth-cors.ts:35-40 (현재)
export function isLoopbackRequestHost(value: string | null): boolean {
  const parsed = parseHttpHost(value);
  if (!parsed) return true;
  if (!isLoopbackHostname(parsed.hostname)) return false;
  return parsed.port === "" || parsed.port === configuredPort();   // ← 원인
}
```

마지막 줄이 **"루프백 호스트인가"와 "포트가 서버 자기 포트와 같은가"를 한
판정으로 묶는다.** `ssh -L 20100:localhost:10100 remote` 구성에서 클라이언트가
`localhost:20100`으로 붙으면 Host 헤더가 `localhost:20100`이 되어 판정이 false가
되고, `isAllowedRequestOrigin`이 **Origin 유무와 무관하게** 거부한다
(`auth-cors.ts:73`).

이 게이트 뒤에 데이터 플레인 전체가 있다 — `/v1/models`, `/v1/responses`,
`/v1/messages`, `/v1/chat/completions`, `/v1/live`, WS 업그레이드
(`src/server/index.ts` 336·373·443·518·558·573·595·618·646).

## 결정적 선례 (직접 확인)

**같은 파일의 형제 함수는 이미 같은 이유로 포트 제약을 제거했다.**

커밋 `e4e06125b` "fix: allow CORS from any loopback origin regardless of port"
(bitkyc08-arch, 2026-07-05):

```diff
 function isLoopbackOriginValue(value: string): boolean {
-    if (parsed.protocol !== "http:") return false;
-    if (!isLoopbackHostname(parsed.hostname)) return false;
-    return parsed.port === configuredPort();
+    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
+    return isLoopbackHostname(parsed.hostname);
 }
```

커밋 메시지: "any http/https origin on localhost/127.0.0.1/::1 is treated as
**same-trust-boundary**".

즉 저장소는 이미 **"루프백이면 포트와 무관하게 같은 신뢰 경계"**라는 입장을
채택했다. `isLoopbackRequestHost`만 옛 규칙에 남아 비일관 상태다. 이 변경은
새 정책 도입이 아니라 **기존 정책을 형제 함수에 맞추는 것**이다.

포트 검사의 최초 도입은 `c29ee783e`(2026-06-27, 서버 하드닝 일괄 커밋)이고
포트 결합에 대한 개별 근거는 커밋 메시지에 없다.

## 보안 경계 분석

제거해도 되는 이유:

1. **포트는 신뢰 경계가 아니다.** Host 헤더의 포트는 클라이언트가 자유롭게
   보내는 값이다. 공격자가 `Host: localhost:10100`을 위조하는 것을 막지
   못하므로, 포트 검사는 DNS rebinding 방어로 기능하지 않는다.
2. **호스트명 검사가 실제 방어다.** `isLoopbackHostname`이 `localhost` /
   `127.0.0.1` / `::1`만 허용한다. rebinding 공격은 공격자 도메인을 Host로
   보내므로 여기서 걸린다.
3. **비루프백 바인드는 별도 경로다.** `hostname`이 비루프백이면
   `isApiAuthRequired`가 켜지고(`:122-124`) 토큰 인증 모드로 전환된다. 이
   변경은 그 경로를 건드리지 않는다.
4. **형제 함수가 이미 그렇다.** Origin 쪽은 07-05부터 포트 무관이다. Host
   쪽만 조이는 건 방어 효과 없이 정상 구성만 깬다.

독립 리뷰가 위 네 근거를 전수 추적해 확인했다: `isLoopbackRequestHost`의 호출자는
`auth-cors.ts:73` 하나뿐이고 `if (!isApiAuthRequired(config))` 안에서만 도달한다.
비루프백 바인드는 `:76`으로 가서 `requireApiAuth`/`requireResponsesApiAuth`와
`assertServerAuthConfig`로 별도 게이트를 받는다. `/v1/*`·관리 API 전 호출 지점
(`src/server/index.ts` 322·336·373·443·475·494·518·558·573·595·618·646)이 모두
`isAllowedRequestOrigin`을 거치므로 포트 검사가 유일한 방어인 경로는 없다.

### 받아들이는 잔여 위험 (명시)

**이 변경은 보안 중립이 아니다.** 루프백 모드는 인증이 아예 없다. 따라서:

```
ssh -g -L 20100:localhost:10100 remote
```

`-g` 옵션은 **클라이언트 쪽 `0.0.0.0`에** 리스너를 연다. 그 LAN의 누구나
`Host: localhost:20100`으로 관리 API에 인증 없이 닿는다. 지금은 포트 불일치가
**우연히** 이걸 막고 있고, 변경 후에는 막지 않는다.

같은 성질의 토폴로지: devcontainer 포트 포워딩, Codespaces 포워딩.

이걸 받아들이는 이유는 포트 검사가 **의도된 방어가 아니었기 때문**이다.
`-g` 없는 평범한 `ssh -L`은 클라이언트 루프백에만 열리므로 노출이 없고,
`-g`/devcontainer 토폴로지는 포트를 10100으로 맞추기만 하면 지금도 그대로
뚫린다. 즉 현재 상태는 방어가 아니라 **일관성 없는 반쪽 차단**이다.

진짜 해법은 별개다 — 포워딩된 루프백에 인증을 요구할지 여부는 제품 결정이며
이 work-phase의 스코프가 아니다. 여기서는 위험을 기록하고 넘어간다.

### 보안 리뷰 경계 (STRICT)

`.github/CODEOWNERS:13`:

```
/src/server/auth-cors.ts @lidge-jun @Ingwannu
```

"Authentication, credentials, and management API" 항목이다. `MAINTAINERS.md:29-32`:

> Authentication, credential handling, GitHub Actions, release automation,
> dependency installation, and other security-boundary changes require explicit
> security review.
> Security-sensitive and release-related changes should be reviewed by both
> maintainers when practical.

**따라서 이 work-phase는 자체 머지할 수 없다.** dev 대상 PR로 올리고
CODEOWNERS 리뷰를 받는다. 터미널 판정은 `NEEDS_HUMAN` 가능이며, 그건 실패가
아니라 경계를 지킨 정상 종료다 — `050`의 #557과 같은 성질이다.

## 변경 (diff-level)

### MODIFY `src/server/auth-cors.ts`

```diff
 export function isLoopbackRequestHost(value: string | null): boolean {
   const parsed = parseHttpHost(value);
   if (!parsed) return true;
-  if (!isLoopbackHostname(parsed.hostname)) return false;
-  return parsed.port === "" || parsed.port === configuredPort();
+  // Loopback is a trust boundary by hostname, not by port: `ssh -L 20100:localhost:10100`
+  // legitimately arrives as Host: localhost:20100. The sibling isLoopbackOriginValue()
+  // already dropped its port check for the same reason (e4e06125b). A port equality test
+  // is not a DNS-rebinding defense either — an attacker controls the Host header freely,
+  // so the hostname check below is the actual boundary.
+  return isLoopbackHostname(parsed.hostname);
 }
```

`configuredPort()`는 `isLoopbackOriginValue` 제거 후에도 다른 참조가 있는지
B 단계에서 확인한다. 없으면 미사용 export가 되므로 그대로 두되 주석으로
표시하거나, 참조가 0이면 제거를 검토한다(스코프 최소화 우선 — 남겨둔다).

### NEW `tests/server-loopback-host-gate.test.ts`

현재 이 술어에 회귀 테스트가 **0건**이다(`rg 'isLoopbackRequestHost' tests/` → 0).
이 공백 자체가 결함이므로 신설한다.

```ts
import { describe, expect, test } from "bun:test";
import { isLoopbackRequestHost, isAllowedRequestOrigin } from "../src/server/auth-cors";
import type { OcxConfig } from "../src/types";

const loopbackConfig = { hostname: "127.0.0.1" } as OcxConfig;

describe("isLoopbackRequestHost", () => {
  test("a forwarded loopback port is still loopback (ssh -L 20100:localhost:10100)", () => {
    expect(isLoopbackRequestHost("localhost:20100")).toBe(true);
    expect(isLoopbackRequestHost("127.0.0.1:20100")).toBe(true);
    expect(isLoopbackRequestHost("[::1]:20100")).toBe(true);
  });

  test("the proxy's own port and a bare host stay allowed", () => {
    expect(isLoopbackRequestHost("localhost:10100")).toBe(true);
    expect(isLoopbackRequestHost("localhost")).toBe(true);
    expect(isLoopbackRequestHost(null)).toBe(true);
  });

  test("a non-loopback hostname is refused on every port", () => {
    expect(isLoopbackRequestHost("evil.example:10100")).toBe(false);
    expect(isLoopbackRequestHost("evil.example:20100")).toBe(false);
    expect(isLoopbackRequestHost("192.168.1.5:10100")).toBe(false);
  });
});

describe("isAllowedRequestOrigin over a forwarded port", () => {
  function req(host: string, origin?: string): Request {
    const headers: Record<string, string> = { Host: host };
    if (origin) headers.Origin = origin;
    return new Request("http://x/v1/models", { headers });
  }

  test("a CLI with no Origin reaches the data plane through the forward", () => {
    expect(isAllowedRequestOrigin(req("localhost:20100"), loopbackConfig)).toBe(true);
  });

  test("a browser Origin on the forwarded port is also allowed", () => {
    expect(isAllowedRequestOrigin(req("localhost:20100", "http://localhost:20100"), loopbackConfig)).toBe(true);
  });

  test("a non-loopback Host is still refused", () => {
    expect(isAllowedRequestOrigin(req("evil.example:20100"), loopbackConfig)).toBe(false);
  });
});
```

### 활성화 증거 (C-ACTIVATION-GROUNDING-01)

이 변경은 조건부 분기를 **제거**하는 쪽이다. 활성화 증거는 "제거 전에는 false,
제거 후에는 true"를 같은 입력으로 보이는 것이다:

- 트리거: `Host: localhost:20100` (서버 포트 10100과 다른 루프백 포트)
- 관측: 변경 전 `isLoopbackRequestHost` = false → `isAllowedRequestOrigin` = false
  (이미 009에서 실측), 변경 후 두 값 모두 true
- 반대 방향: `Host: evil.example:20100`은 변경 전후 모두 false — 방어가 살아있음

"전체 green"으로는 불충분하다. 위 세 테스트가 실제로 이 술어를 호출한다.

## 스코프 경계

IN: `isLoopbackRequestHost` 한 함수, 신설 테스트 파일 1개.
OUT: `isApiAuthRequired` / `assertServerAuthConfig` / 토큰 인증 경로 —
비루프백 바인드는 별개 토폴로지이고 이 버그와 무관하다.
OUT: OAuth 콜백 포트 1455 고정 문제(009 §"같이 깨지는 두 번째 것") — 같은
원격 토폴로지에서 깨지지만 **독립 결함**이다. 별도 work-phase 후보로 남긴다.
OUT: `ocx status`/`doctor`의 원격 미인식, GUI 스니펫 하드코딩 — 둘 다 009가
부수 확인으로 기록한 별개 항목.

## SoT 동기화

`docs-site/src/content/docs/reference/configuration.md`의 "Remote access" 절에
SSH 로컬 포워딩이 지원된다는 사실을 명시한다. 현재 이 절은 원격 접근을 다루면서
포트가 다른 포워딩은 언급하지 않는다.

## 수용 기준

- `bun run typecheck` 통과
- `bun test tests/server-loopback-host-gate.test.ts` 전건 통과
- `bun test tests/server-auth.test.ts` 회귀 없음 — 특히
  **`tests/server-auth.test.ts:582-602`의 Host 헤더 rebinding 테스트**가 이
  work-phase의 must-not-break 오라클이다. 비루프백 이름(`attacker.test`)을 쓰므로
  통과해야 정상이며, 깨지면 방어가 무너진 것이다.
- `bun run privacy:scan` 초록
- PR은 dev 대상. CODEOWNERS 보안 리뷰 없이 머지하지 않는다.

> `import type { OcxConfig } from "../src/types"` — `src/config.ts`는
> `OcxConfig`를 재export하지 않는다(리뷰 지적, `tsc` 실측 TS2459). 저장소의
> 기존 테스트도 전부 `../src/types`를 쓴다.
