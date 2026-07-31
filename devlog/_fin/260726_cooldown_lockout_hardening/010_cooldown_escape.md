# 010 — 쿨다운 락아웃 탈출구 + 진단 가능한 429 (구현 계약)

단일 work-phase. 조사·근거는 `000_plan.md`.

범위: G1(탈출구 부재)과 G3(429 침묵)만. G4(주입 게이트)는 `init` 대화 흐름과
launchd 설치 정책을 함께 바꿔야 하므로 별도 유닛으로 미룬다. G2는 G1이 해결되면
설계 의도대로 남는다(리터럴 Retry-After 존중 + 수동 탈출구).

## 스코프 경계

IN: `src/codex/routing.ts`, `src/codex/auth-context.ts`,
`src/server/responses/core.ts`, `src/server/images.ts`, `src/server/search.ts`,
`src/server/responses/compact.ts`, `src/server/live.ts`, `src/server/index.ts`(WS),
`src/codex/auth-api.ts`, `src/cli/account.ts`, `src/cli/account-extended.ts`, 해당 테스트.

OUT: 주입 로직(`inject.ts`), GUI 컴포넌트, `init` 흐름, 쿨다운 계산식 자체.
쿨다운 임계값·상한·probe 간격은 #433에서 확정된 값이므로 건드리지 않는다.

## MODIFY 1 — `src/codex/routing.ts`: 수동 해제 API

`clearCodexUpstreamHealthForAccount`는 헬스 전체를 지운다(실패 카운터·softAvoid 포함).
수동 해제는 **하드 쿨다운만** 걷어내야 한다. 실패 이력까지 지우면 페일오버 판단이
리셋되어 죽은 계정으로 다시 몰릴 수 있다.

`getCodexAccountHealthSnapshot`(현재 `:313`) 아래에 NEW:

```ts
/**
 * Manually lift a hard quota cooldown without touching failure history.
 * The pool must keep its transient-failure knowledge: a user clearing a cooldown
 * is saying "the quota window moved", not "this account is healthy".
 * Returns false when the account carried no live cooldown.
 */
export function clearCodexAccountCooldown(accountId: string, now = Date.now()): boolean {
  const health = upstreamHealth.get(accountId);
  if (!health) return false;
  const cooldownUntil = health.cooldownUntil;
  if (typeof cooldownUntil !== "number" || !Number.isFinite(cooldownUntil) || cooldownUntil <= now) return false;
  const {
    cooldownUntil: _u,
    cooldownSince: _s,
    cooldownSource: _src,
    probeLeaseId: _lease,
    probeLeaseGeneration: _leaseGen,
    ...rest
  } = health;
  // cooldownGeneration is intentionally PRESERVED and bumped: an in-flight probe
  // issued against the cleared cooldown must not later "clear" a newer one.
  upstreamHealth.set(accountId, {
    ...rest,
    cooldownGeneration: (health.cooldownGeneration ?? 0) + 1,
    lastProbeAt: now,
  });
  return true;
}
```

**C 페이즈에서 이 주장은 틀린 것으로 판명됐다** (`011_verification.md` §3 참조).
세대 bump를 제거한 ablation이 그대로 PASS했다. 실제 방어 주체는 해제 시
`probeLeaseId`를 떨어뜨리는 것이며(`ownsProbeLease`가 id 일치를 요구), 게다가
`recordCodexUpstreamOutcome`의 429 경로가 이미 세대를 올린다. bump는 load-bearing이
아닌 이중 방어로만 유지한다.

## MODIFY 2 — `src/codex/auth-context.ts`: 429에 실린 진단 정보

`CodexAccountCooldownError`(`:95`)는 이미 `accountId`와 `cooldownUntil`을 들고 있다.
`cooldownSource`만 추가한다. 생성자 두 호출부(`:165`, `:209`)에 소스를 넘긴다.

```ts
export class CodexAccountCooldownError extends Error {
  accountId: string;
  cooldownUntil: number;
  cooldownSource?: CodexCooldownSource;   // NEW

  constructor(accountId: string, cooldownUntil: number, cooldownSource?: CodexCooldownSource) {
```

## MODIFY 3 — 429 본문/헤더 (5개 호출부 공통)

현재 모든 호출부가 같은 문자열을 쓴다: `"Selected Codex account is cooling down"`.
공통 헬퍼를 `src/codex/auth-context.ts`에 NEW로 두고 각 호출부가 쓴다.

```ts
/** Actionable 429 for a cooled-down account: who, until when, and how to escape. */
export function cooldownErrorResponse(err: CodexAccountCooldownError): Response {
  const seconds = Math.max(1, Math.ceil((err.cooldownUntil - Date.now()) / 1000));
  const until = new Date(err.cooldownUntil).toISOString();
  const res = formatErrorResponse(
    429,
    "rate_limit_error",
    `Selected Codex account is cooling down until ${until}`
      + ` (source: ${err.cooldownSource ?? "default"}).`
      + ` Run 'ocx account clear-cooldown openai <account-id>' to lift it, or 'ocx account use openai <other>' to switch.`,
  );
  const headers = new Headers(res.headers);
  headers.set("Retry-After", String(seconds));
  return new Response(res.body, { status: res.status, headers });
}
```

**A 감사 결과 뒤집힘 (블로커 2, High).** 원래 계획은 raw 계정 id를 본문에 넣으려 했다.
이는 틀렸다. `src/server/auth-cors.ts:121`의 `isApiAuthRequired`는 non-loopback
바인드를 **거부하지 않고** API 토큰을 요구할 뿐이므로, `/v1/*` 429 본문은 원격
인증 클라이언트에게 도달할 수 있다. `scripts/privacy-scan.ts`는 이메일·토큰·홈 경로를
보지 계정 id를 보지 않으므로 게이트가 막아주지도 않는다.

확정 규칙: 데이터 플레인 429 본문에 raw 계정 id를 넣지 않는다.
`__main__`은 `main`으로, 나머지는 `maskAccountId`(`src/lib/privacy.ts:13`) 결과를 쓴다.
명령은 템플릿으로 안내한다: `ocx account list openai`로 id를 확인한 뒤
`ocx account clear-cooldown openai <id>`. raw id는 인증된 관리/CLI 목록 표면에만 남는다.

치환 대상 (모두 동일 패턴):

| 파일 | 현재 위치 |
|------|----------|
| `src/server/responses/core.ts` | `:476` |
| `src/server/images.ts` | `:87` |
| `src/server/search.ts` | `:80` |
| `src/server/responses/compact.ts` | `instanceof` 분기 |
| `src/server/live.ts` | `instanceof` 분기 |
| `src/server/index.ts` | `:799` — **WS 전송 경로 (A 감사 블로커 4에서 추가)** |

`src/server/index.ts:799`는 Responses WebSocket 턴에서 `CodexAccountCooldownError`를
직접 잡아 옛 문자열을 프레임으로 보낸다. Codex Desktop이 WS 전송을 쓰므로 이 경로를
빠뜨리면 정작 문제의 표면에서 진단 정보가 나오지 않는다. `buildWsErrorFrame(429, ...)`의
payload를 공통 포매터가 만든 메시지로 교체한다(헤더는 프레임에 실리지 않으므로 메시지만).

## MODIFY 4 — 관리 API: `POST /api/codex-auth/accounts/clear-cooldown`

**A 감사 결과 뒤집힘 (블로커 1, High).** 원래 계획은 `/api/oauth/accounts/clear-cooldown`에
두려 했는데, 그 패밀리는 `isPublicOAuthProvider`(`src/oauth/index.ts:147`)로 검증하고
이 함수는 `chatgpt`를 제외한다. Codex 계정은 `openai` 패밀리이므로 정작 필요한
경로가 거부된다. Codex 계정 라우트는 `src/codex/auth-api.ts`의 `/api/codex-auth/*`다.

`auth-api.ts`의 `/api/codex-auth/accounts/alias` 분기(`:567`) 뒤에 NEW.
같은 파일의 기존 검증 규약(`ACCOUNT_ID_RE`, `MAIN_CODEX_ACCOUNT_ID`)을 그대로 따른다.

```ts
  if (url.pathname === "/api/codex-auth/accounts/clear-cooldown" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { id?: unknown };
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id || !ACCOUNT_ID_RE.test(id)) return jsonResponse({ error: "Invalid account id format" }, 400);
    const cleared = clearCodexAccountCooldown(id);
    return jsonResponse({ ok: true, id, cleared });
  }
```

`cleared: false`는 오류가 아니다. 쿨다운이 이미 만료됐거나 없던 상태를 뜻하며,
CLI가 이를 구분해 출력한다. 계정 존재 여부로 404를 나누지 **않는** 것은 의도된
선택이다: 쿨다운 맵은 계정 목록과 독립적인 런타임 상태이고, 404/200을 가르면
이 라우트가 계정 존재 여부를 알려주는 오라클이 된다(A 감사 블로커 6).

## MODIFY 5 — CLI: `ocx account clear-cooldown`

`src/cli/account.ts`:

- `ACCOUNT_USAGE`(`:18`)에 한 줄 추가:
  `  ocx account clear-cooldown <provider> <id|main> [--json]`
- `cmdAccount` 디스패치(`:259` 근처)에 추가:
  `if (sub === "clear-cooldown") return await cmdClearCooldown(rest, deps);`
- `cmdClearCooldown`은 `src/cli/account-extended.ts`에 NEW — `cmdAlias`/`cmdRemove`와
  같은 파일에 두어 `classifyAccount` + `main` 매핑 규약을 재사용한다.
  `src/cli/account-extended.ts:293`의 패턴을 그대로 따른다:
  `const id = classified.type === "codex" && requestedId === "main" ? MAIN_ID : requestedId;`
  `classified.type !== "codex"`이면 명확히 거부한다 — 이 기능은 Codex 계정 쿨다운
  전용이고, API 키 풀 쿨다운은 이미 `clearKeyCooldowns` 경로가 따로 있다.
  `cleared === true` → `Cooldown lifted for <masked>.`
  `cleared === false` → `No active cooldown for <masked>.` (exit 0)

`main` 별칭은 필수다. 단일 계정(`__main__`) 사용자가 정확히 이 락아웃의 피해자이므로
이 별칭이 없으면 기능 자체가 도달 불가능하다(A 감사 블로커 1의 도달성 지적).

## MODIFY 6 — `cooldownSource` 전달 (A 감사 블로커 3)

원래 계획은 `auth-context.ts:165`/`:209`가 소스를 "넘긴다"고 썼지만, 현재 두 지점은
`getCodexAccountCooldownUntil`만 호출해 소스를 알지 못한다. 실제 수정은 두 지점의
조회를 `getCodexAccountHealthSnapshot`(`routing.ts:313`)으로 바꾸는 것이다. 이 함수는
이미 `{ cooldownUntil, cooldownSource }`를 반환하고 쓰기 부작용이 없다.

## 활성화 시나리오 (C-ACTIVATION-GROUNDING-01)

조건부 경로 3개 전부 실제로 발화시킨다. "테스트 그린"은 이 규칙을 만족하지 않는다.

1. **`clearCodexAccountCooldown` 성공 경로** — `recordCodexUpstreamOutcome`로 429를
   심어 쿨다운 생성 → `isCodexAccountInCooldown` true 확인 → 해제 호출 → true 반환 +
   `isCodexAccountInCooldown` false 확인.
2. **세대 보존 경로 (가장 중요)** — 쿨다운 생성 → probe lease 획득 →
   `clearCodexAccountCooldown` 호출 → 새 429로 새 쿨다운 생성 → 그 **오래된 lease**를
   단 성공 결과를 기록 → 새 쿨다운이 **살아남아야 한다**. 이게 깨지면 수동 해제가
   쿼터 우회 수단이 된다.
3. **no-op 경로** — 쿨다운 없는 계정에 해제 호출 → false, 헬스 객체 무변경.
4. **429 본문** — `Retry-After` 헤더 존재 + 본문에 ISO 시각과 CLI 명령 템플릿 포함,
   그리고 **raw 계정 id가 본문에 없음**을 명시적으로 단언한다(마스킹 회귀 방지).
5. **WS 경로** — `src/server/index.ts:799` 분기가 실제로 발화해 새 메시지를 담은
   429 프레임을 보내는지 확인한다. HTTP 경로 통과는 이 경로의 증거가 아니다.

## 수용 기준

- `bun run typecheck` exit 0.
- `bun run test` — `tests/codex-routing.test.ts:314`
  ("2xx responses clear transient failures without clearing an unexpired cooldown")의
  의미가 유지된다. (A 감사 블로커 5: 원래 계획의 `:312`/`:806` 참조는 드리프트였다.
  `:806`은 WHAM 파서 테스트로 무관하다.)
- `bun run privacy:scan` 그린. 단 이 게이트는 계정 id를 보지 않으므로 통과가
  마스킹 정확성의 증거가 아니다 — 마스킹은 별도 단언으로 증명한다.
- 위 활성화 시나리오 5개가 각각 관찰된 증거를 남긴다.

## 보안 경계

`MAINTAINERS.md:22` 기준: 쿼터/크레덴셜 인접 변경이다. 수동 해제는 **로컬 관리 API
인증 뒤**에 있고(`requireApiAuth(..., "management")`), 상위 쿼터를 우회하지 않는다.
해제 후 요청은 실제로 상위로 나가고, 상위가 여전히 429면 즉시 새 쿨다운이 걸린다.
즉 이 기능은 "상위를 다시 물어볼 권리"이지 "제한 면제"가 아니다.
