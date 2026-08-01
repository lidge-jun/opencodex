# 010 — wp1: 설정 파일 안전성

대상: `src/grok/inject.ts`, `tests/grok-config-inject.test.ts`, `tests/grok-sync.test.ts`.

## 블로커 1 — 비루프백에서 플레이스홀더 자격 증명이 401을 만든다

현재 `buildGrokManagedBlock`은 모든 모델에 `api_key = "opencodex-loopback"`을 쓴다. 그런데 `isApiAuthRequired`는 `hostname`이 비루프백이면 true이고, 그때 `hasValidApiAuth`는 `isProxyAdmissionSecret`로 실제 토큰을 요구한다(`src/server/auth-cors.ts:121,163`). 따라서 LAN 바인드에서 자동 등록된 모든 모델이 401이다. 사용자가 손으로 고쳐도 다음 `ocx start`/`ensure`가 fence를 재생성하며 되돌린다.

리뷰어 두 곳(Codex P2, CodeRabbit Major)은 "비루프백이면 자동 등록을 거부하라"고 제안했다. 하지만 Grok Build는 `env_key`를 지원하므로 더 나은 해법이 있다: **환경변수 이름만 쓰고 값은 쓰지 않는다.**

### 결정

루프백: 기존대로 `api_key = "opencodex-loopback"` (프록시가 무시하는 더미).

비루프백: `api_key` 대신 `env_key = "OPENCODEX_API_AUTH_TOKEN"`을 쓴다. 토큰 값은 config에 남지 않고, 변수가 없으면 grok이 세션 토큰으로 폴백하지 않고 fail-closed다 (`180_grok-build .../model_providers.rs:741`). 프록시 자신도 같은 환경변수에서 토큰을 읽으므로(`auth-cors.ts:111`) 이름이 자연히 일치한다.

자동 등록 거부보다 이 쪽을 택하는 이유: 거부는 비루프백 사용자에게 기능을 완전히 없애고, 손수 쓴 설정도 fence 밖에 두어야 해 카탈로그 갱신 이점을 잃는다. `env_key`는 비밀 직렬화 금지라는 리뷰의 실제 요구를 지키면서 기능을 유지한다.

### 변경 (`src/grok/inject.ts`)

`buildGrokManagedBlock` 시그니처를 옵션 객체로 정리하되 기존 위치 인자 호환은 유지한다.

```diff
-export function buildGrokManagedBlock(port: number, models: GrokInjectModel[], hostname?: string, reservedAliases?: ReadonlySet<string>): string {
-  const host = providerBaseHost(hostname);
-  const baseUrl = `http://${host}:${port}/v1`;
+/** Env var the proxy reads its admission token from; also what grok is told to read. */
+const ADMISSION_TOKEN_ENV = "OPENCODEX_API_AUTH_TOKEN";
+
+export function buildGrokManagedBlock(port: number, models: GrokInjectModel[], hostname?: string, reservedAliases?: ReadonlySet<string>): string {
+  const host = providerBaseHost(hostname);
+  const baseUrl = `http://${host}:${port}/v1`;
+  // A non-loopback bind makes every data-plane request require the admission token
+  // (server/auth-cors.ts isApiAuthRequired). ~/.grok/config.toml is a shared user file,
+  // so we never serialize the token itself: grok resolves `env_key` from the environment
+  // and fails closed (no session-token fallback) when the variable is unset.
+  const requiresAdmission = !isLoopbackHostname(hostname);
```

모델 루프의 자격 증명 줄:

```diff
       'api_backend = "chat_completions"',
-      'api_key = "opencodex-loopback"',
+      requiresAdmission
+        ? `env_key = ${tomlString(ADMISSION_TOKEN_ENV)}`
+        : 'api_key = "opencodex-loopback"',
```

`isLoopbackHostname`은 `src/server/auth-cors.ts`에서 가져온다. `src/codex/inject.ts`가 이미 같은 곳에서 import하므로 계층 위반이 아니다.

## 블로커 2 — 인용된 첫 TOML 키 세그먼트를 놓친다

`userModelAliases`의 정규식은 `[model."x"]`는 잡지만 `["model"."x"]`, `['model'.x]`는 못 잡는다. TOML에서는 동일한 테이블이므로, 우리가 `[model.x]`를 또 내보내면 `Cannot redefine key` 파싱 실패로 **설정 전체가 무효**가 된다.

```diff
-  const header = /^\s*\[\s*model\s*\.\s*(?:([A-Za-z0-9_-]+)|"((?:[^"\\]|\\.)*)"|'([^']*)')\s*\]\s*(?:#.*)?$/gm;
-  for (const match of outsideManagedRegion.matchAll(header)) {
-    const bare = match[1];
-    const doubleQuoted = match[2];
-    const singleQuoted = match[3];
+  const segment = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
+  const header = new RegExp(String.raw`^\s*\[\s*(${segment})\s*\.\s*(${segment})\s*\]\s*(?:#.*)?$`, "gm");
+  for (const match of outsideManagedRegion.matchAll(header)) {
+    if (canonicalTomlKey(match[1]) !== "model") continue;
+    const alias = canonicalTomlKey(match[2]);
+    if (alias !== undefined) aliases.add(alias);
+  }
```

새 헬퍼:

```ts
/** Canonicalize one TOML key segment: bare, "basic", or 'literal' all denote the same key. */
function canonicalTomlKey(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return decodeTomlBasicString(value.slice(1, -1));
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1); // literal strings take no escapes
  }
  return value;
}
```

## 블로커 3 — 후행 개행이 없던 파일이 바이트 단위로 복원되지 않는다

주입 시 후행 개행이 없으면 `separator = "\n\n"`를 넣는데, 제거 시에는 `prefix.endsWith("\n\n")`일 때 하나만 줄이고 블록 뒤 `\n` 하나만 제거한다. 결과적으로 원본에 없던 후행 개행이 남는다.

정확한 대칭 복원: 주입이 붙인 것은 (앞 `\n\n`) + 블록 + (뒤 `\n`)이고 원본은 개행으로 끝나지 않았다. 그러므로 제거 시 접미사가 비어 있으면 앞의 `\n\n`을 **둘 다** 없애야 한다.

```diff
     let removalEnd = region.end;
     if (content.startsWith("\n", removalEnd)) removalEnd += 1;
     let prefix = content.slice(0, region.start);
-    if (prefix.endsWith("\n\n")) prefix = prefix.slice(0, -1);
-    const stripped = prefix + content.slice(removalEnd);
+    const suffix = content.slice(removalEnd);
+    if (prefix.endsWith("\n\n")) {
+      // Injection into a file WITHOUT a trailing newline added "\n\n" before the block and
+      // "\n" after it; injection into a file WITH one added a single "\n". Removing both
+      // separator newlines is only correct when nothing follows the block — otherwise the
+      // user's own blank line before our fence would be eaten.
+      prefix = suffix.length === 0 ? prefix.slice(0, -2) : prefix.slice(0, -1);
+    }
+    const stripped = prefix + suffix;
```

## 테스트 (`tests/grok-config-inject.test.ts`)

기존 스타일(mkdtemp `grokHome` 주입)을 따라 4건 추가:

1. `non-loopback bind uses env_key instead of a literal token` — `injectGrokConfig(port, models, { grokHome, hostname: "192.168.1.50" })` 후 파일에 `env_key = "OPENCODEX_API_AUTH_TOKEN"`이 있고 `api_key`와 실제 토큰 문자열이 **없음**을 단언.
2. `loopback keeps the placeholder api_key` — 대조군.
3. `reserves aliases declared with a quoted first key segment` — `["model"."ocx-probe"]`, `['model'.ocx-other]`를 미리 둔 뒤 생성 별칭이 충돌하지 않고 `-2` 접미사를 받는지 단언.
4. `restores a config that had no trailing newline byte-for-byte` — 원본 문자열을 저장 → inject → strip → `readFileSync`가 원본과 **정확히** 같은지 단언.

`tests/grok-sync.test.ts`에는 비루프백 hostname을 넘겼을 때 `env_key`가 나오는 경로 1건을 추가한다.
