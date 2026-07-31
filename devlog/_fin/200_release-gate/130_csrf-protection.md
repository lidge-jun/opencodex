# 130 — localhost CSRF 보호 (Medium)

## 문제

mutating management API endpoints가 Origin 검증 없이 POST를 수락:

- `POST /api/stop` — 프록시 종료 + 네이티브 Codex 복원
- `POST /api/oauth/logout` — OAuth credential 삭제

CORS는 응답 읽기만 차단. Simple POST (no custom headers, no preflight)는 부작용이 먼저 발생:

```js
// 악성 웹페이지에서:
fetch("http://localhost:10100/api/stop", { method: "POST" })
// → 프록시가 종료됨 (응답은 CORS로 차단되지만 부작용은 이미 발생)
```

## 수정

### MODIFY `src/server.ts` — `handleManagementAPI` 상단에 Origin 검증 추가

```ts
function isLocalOrigin(req: Request, listenPort: number): boolean {
  const origin = req.headers.get("Origin");
  if (!origin) return true; // non-browser (curl, Codex CLI) — no Origin header
  const allowed = `http://localhost:${listenPort}`;
  return origin === allowed || origin === `http://127.0.0.1:${listenPort}`;
}
```

mutating endpoints(`POST /api/stop`, `POST /api/oauth/logout`, `POST /api/providers/*`)에 적용:

```ts
if (req.method === "POST" && !isLocalOrigin(req, listenPort)) {
  return jsonResponse({ error: "cross-origin request blocked" }, 403);
}
```

### 설계 결정

- Origin 없는 요청은 허용 (curl, CLI, Codex 자체 — 브라우저 아님)
- Origin이 있으면 localhost만 허용
- GET 요청은 안전 (side-effect 없음) → 제한 안 함
- random token 방식은 과도 — Origin 검증만으로 브라우저 CSRF 방어 충분

### NEW `tests/csrf-protection.test.ts`

```ts
test("POST /api/stop with foreign Origin returns 403", ...);
test("POST /api/stop without Origin header succeeds", ...);
test("POST /api/stop with localhost Origin succeeds", ...);
test("POST /api/oauth/logout with foreign Origin returns 403", ...);
```

## 검증

1. `Origin: http://evil.com` + POST /api/stop → 403 (unit test)
2. No Origin + POST /api/stop → 200 (curl/CLI 정상)
3. `Origin: http://localhost:10100` + POST /api/stop → 200 (GUI 정상)
