# 020 — WP3: TLS altname 오류 진단 (이슈 #553)

대상: `src/server/responses/core.ts`
이슈: #553 `[Bug] GitHub Copilot model request fails with 502 and TLS hostname mismatch`
판정 근거: `260727_owner_decision_ledger/010_bug_bundle_fixability.md` §이슈 #553
계층: 응답/오류 계층

## 문제

리포터가 받은 메시지:

```
unexpected status 502 Bad Gateway: Provider unreachable:
ERR_TLS_CERT_ALTNAME_INVALID fetching https://api.individual.githubcopilot.com/chat/completions
```

이 문구는 **우리 어댑터가 URL을 잘못 만든 것처럼 읽힌다.** 실제로는 우리 URL
구성이 옳다 — `src/oauth/github-copilot.ts:136`이 `*.githubcopilot.com`을
허용하므로 `api.individual.githubcopilot.com`은 정상 엔드포인트다. 메인테이너도
재현에 실패했다(#553 코멘트, Ingwannu 07-27).

`ERR_TLS_CERT_ALTNAME_INVALID`는 **제시된 인증서의 SAN에 요청 호스트명이 없다**는
뜻이다. 정상 경로에서는 나올 수 없고, 사실상 TLS 가로채기(기업 프록시, VPN,
로컬 MITM 도구) 또는 DNS 오염을 가리킨다. 즉 리포터 환경 문제인데 메시지가
그 사실을 전혀 알려주지 않는다.

## 중복 코드 (직접 확인)

동일한 3줄이 `core.ts`에 **세 번** 나온다:

```
1195-1197   초기 upstream fetch catch
1744-1746   재시도 루프 진입 전 catch
1786-1788   rebuildAndRefetch catch
```

```ts
const msg = err instanceof Error && err.name === "TimeoutError"
  ? `Provider connect timeout after ${connectMs}ms`
  : `Provider unreachable: ${err instanceof Error ? err.message : String(err)}`;
```

세 곳을 각각 고치면 다음 사람이 또 갈라진다. **헬퍼 하나로 뽑는다.**

## 변경 (diff-level)

### NEW `src/server/responses/upstream-error.ts`

```ts
/**
 * Upstream connection failures share one message shape across the three catch sites in
 * core.ts. TLS altname mismatches deserve their own wording: they are almost never a
 * proxy-side URL bug, so the generic "Provider unreachable" reads as if opencodex built
 * a wrong endpoint (issue #553). Name the likely cause and the command that proves it.
 */
export function describeUpstreamConnectFailure(err: unknown, connectMs: number): string {
  if (err instanceof Error && err.name === "TimeoutError") {
    return `Provider connect timeout after ${connectMs}ms`;
  }
  const detail = err instanceof Error ? err.message : String(err);
  const code = err instanceof Error ? (err as { code?: unknown }).code : undefined;
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID" || detail.includes("ERR_TLS_CERT_ALTNAME_INVALID")) {
    const host = extractHostname(detail);
    const target = host ?? "the provider host";
    return `Provider TLS certificate does not match ${target}: ${detail}. `
      + "opencodex did not rewrite this hostname — a mismatched certificate normally means TLS "
      + "interception (corporate proxy, VPN, or local MITM tooling) or a poisoned DNS answer. "
      + `Verify with: openssl s_client -connect ${host ?? "<host>"}:443 -servername ${host ?? "<host>"} `
      + "| openssl x509 -noout -subject -ext subjectAltName";
  }
  return `Provider unreachable: ${detail}`;
}

function extractHostname(detail: string): string | null {
  const match = detail.match(/https?:\/\/([^/\s]+)/);
  if (!match?.[1]) return null;
  try { return new URL(`https://${match[1]}`).hostname; } catch { return null; }
}
```

### MODIFY `src/server/responses/core.ts` — 세 지점 모두

```diff
+import { describeUpstreamConnectFailure } from "./upstream-error";
```

```diff
@@ 1195 (초기 fetch catch)
-      const msg = outcome === "timeout"
-        ? `Provider connect timeout after ${connectMs}ms`
-        : `Provider unreachable: ${err instanceof Error ? err.message : String(err)}`;
+      const msg = outcome === "timeout"
+        ? `Provider connect timeout after ${connectMs}ms`
+        : describeUpstreamConnectFailure(err, connectMs);
       return formatErrorResponse(502, "upstream_error", msg);
```

> 이 지점만 `outcome === "timeout"` 판정을 쓰고 나머지 둘은 `err.name`을 쓴다.
> 타임아웃 분기는 **그대로 둔다** — 헬퍼도 같은 판정을 내리지만 이 자리의
> `outcome`은 상위에서 계산된 값이라 의미가 다르다(usage 기록과 연동).

```diff
@@ 1744 (재시도 루프 진입 전 catch)
-    const msg = err instanceof Error && err.name === "TimeoutError"
-      ? `Provider connect timeout after ${connectMs}ms`
-      : `Provider unreachable: ${err instanceof Error ? err.message : String(err)}`;
+    const msg = describeUpstreamConnectFailure(err, connectMs);
     return formatErrorResponse(502, "upstream_error", msg);
```

```diff
@@ 1786 (rebuildAndRefetch catch)
-        const msg = err instanceof Error && err.name === "TimeoutError"
-          ? `Provider connect timeout after ${connectMs}ms`
-          : `Provider unreachable: ${err instanceof Error ? err.message : String(err)}`;
+        const msg = describeUpstreamConnectFailure(err, connectMs);
         return { failed: formatErrorResponse(502, "upstream_error", msg) };
```

### NEW `tests/upstream-connect-error.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { describeUpstreamConnectFailure } from "../src/server/responses/upstream-error";

describe("describeUpstreamConnectFailure", () => {
  test("a TLS altname mismatch names interception and the verification command", () => {
    const err = Object.assign(
      new Error("ERR_TLS_CERT_ALTNAME_INVALID fetching https://api.individual.githubcopilot.com/chat/completions"),
      { code: "ERR_TLS_CERT_ALTNAME_INVALID" },
    );
    const msg = describeUpstreamConnectFailure(err, 30000);
    expect(msg).toContain("api.individual.githubcopilot.com");
    expect(msg).toContain("TLS interception");
    expect(msg).toContain("openssl s_client");
    expect(msg).not.toContain("Provider unreachable");
  });

  test("the altname branch also fires when only the message carries the code", () => {
    const msg = describeUpstreamConnectFailure(new Error("ERR_TLS_CERT_ALTNAME_INVALID"), 30000);
    expect(msg).toContain("openssl s_client");
  });

  test("an ordinary connection failure keeps the existing wording", () => {
    const msg = describeUpstreamConnectFailure(new Error("ECONNREFUSED"), 30000);
    expect(msg).toBe("Provider unreachable: ECONNREFUSED");
  });

  test("a timeout keeps its own message", () => {
    const err = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    expect(describeUpstreamConnectFailure(err, 12345)).toBe("Provider connect timeout after 12345ms");
  });
});
```

### 활성화 증거 (C-ACTIVATION-GROUNDING-01)

새 분기가 셋이다. 각각 발화 테스트가 위에 있다:

| 분기 | 트리거 | 관측 |
| --- | --- | --- |
| altname (code 경유) | `err.code = ERR_TLS_CERT_ALTNAME_INVALID` | `openssl s_client` 포함, `Provider unreachable` 미포함 |
| altname (message 경유) | 메시지에만 코드 | 같은 문구 |
| 기본 경로 | `ECONNREFUSED` | 기존 문구 그대로 |
| 타임아웃 | `name = TimeoutError` | 기존 문구 그대로 |

"전체 green"으로는 불충분하다 — 위 4건이 헬퍼를 직접 호출해 각 분기를 태운다.

## 프라이버시 확인

새 메시지가 담는 것은 **호스트명뿐**이다. 호스트명은 이미 기존 메시지에
`err.message`로 그대로 나가고 있었다. API 키·요청 본문·계정 식별자는 넣지
않는다. `bun run privacy:scan` 대상.

## 스코프 경계

IN: 세 catch 지점의 메시지 생성, 신설 헬퍼, 신설 테스트.
OUT: Copilot 어댑터의 URL 구성 — 이미 옳다는 것이 확인됐다.
OUT: 재시도 정책·상태 코드 — 502 유지.
OUT: 이슈 #553 자체의 클로즈 판단 — 리포터 환경 확인이 남아 있어 `needs-info`
상태를 유지한다. 이 변경은 **다음 사람이 같은 오해를 하지 않게** 하는 것이다.

## 수용 기준

- `bun run typecheck` 통과
- `bun test tests/upstream-connect-error.test.ts` 4건 통과
- `bun test tests/responses*.test.ts` 회귀 없음
- `bun run privacy:scan` 초록
> `(err as { code?: unknown }).code` — `NodeJS.ErrnoException`은 이 tsconfig
> (`types: ["bun-types"]`, `@types/node` 직접 의존 없음)에서 해석이 보장되지
> 않는다. 저장소 관용구는 `src/lib/upstream-retry.ts:213`이다.

## 독립 리뷰 확인 사항 (A 게이트)

리뷰어가 이 절을 실측으로 검증했다:

- 세 호출 지점(1197·1746·1788)이 정확하다.
- 오류가 실제로 거기까지 **도달한다.** Bun 실측:
  `fetch("https://wrong.host.badssl.com/")` → `name=Error`,
  `code=ERR_TLS_CERT_ALTNAME_INVALID`. 중간에서 삼켜지지 않는다 —
  `fetchWithHeaderTimeout`은 시그널만 감싸고 rethrow,
  `isConnectionResetError`는 `ECONNRESET`/`EPIPE`만 매칭,
  `fetchWithTransientRetry`는 반환된 `Response` 상태만 검사,
  `providerFetch`는 통과다.
- 제안된 헬퍼를 실제 Bun 오류와 #553 원문 문자열 양쪽에 돌려 두 경우 모두
  TLS 분기를 타고 호스트명 추출도 정확함을 확인했다.

검증한 핸들러: #553 리포터의 URL은 `/v1/responses`이고, 세 호출 지점이 그
경로를 덮는다. `/v1/chat/completions`는 `src/server/index.ts:588`에서
`handleChatCompletions`로 분기하므로 별도 경로이며 이 변경 범위 밖이다.
