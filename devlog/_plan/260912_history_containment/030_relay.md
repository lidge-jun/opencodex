# Relay source-pinned change design

Source: PR #3663 at 8e0b53b0f96ae840c0ce836c043174aac98816a2. Initial carry uses the following public diff, revalidated against current dev at phase P. Every diff header is the exact NEW/MODIFY file map. Main resolves conflicts against current owners; no wholesale replacement from a stale head.

Before: current merge-base behavior in removed lines. After: added lines below. Tests are authored but NOT RUN locally; final-tip hosted CI observes these files. No new dependency or persisted schema is introduced by containment/continuation; relay owner state remains bounded/process-local and needs separate security review.

Disposition-first: carry only after owner/auth audit; inspect existing listener admission and accepted-attempt ownership. Known/unknown/expired/conflicting owners, failover, direct caller and proxy bearer cases are covered by source regressions below. Native live-account smoke is not authorized and cannot be claimed. Public diff only; new findings stay scratch.

```diff
diff --git a/docs-site/src/content/docs/guides/codex-integration.md b/docs-site/src/content/docs/guides/codex-integration.md
index b2ae7fcb91..b7bc5aecec 100644
--- a/docs-site/src/content/docs/guides/codex-integration.md
+++ b/docs-site/src/content/docs/guides/codex-integration.md
@@ -57,6 +57,63 @@ The proxy listens on port `10100` by default and serves `POST /v1/responses`,
 `POST /v1/responses/compact`, `POST /v1/images/generations`, `POST /v1/images/edits`,
 `GET /v1/models`, `GET /healthz`, and the `/api/*` management surface.

+### Experimental context management (Codex 0.153+)
+
+For an eligible ChatGPT account, enable the experimental feature in Codex's own
+`config.toml` (merge this into an existing `[features]` table):
+
+```toml
+[features]
+context_management.experimental_mode = true
+```
+
+On the default built-in loopback integration, the next `ocx sync` or proxy start changes the
+managed root `openai_base_url` to `http://127.0.0.1:10100/backend-api/codex`. Codex checks this
+backend path before enabling its `new_context`, history, and notes tools. Start a new Codex
+session after synchronization. The feature remains opt-in; user-owned base URLs and remote
+custom-provider injection are not rewritten. No context-window or compaction-limit override
+is needed or added.
+
+The backend prefix aliases the existing data-plane routes, including Responses WebSocket
+upgrades. The original `/v1` routes and the realtime sideband override remain available. The
+proxy also relays the ten native `alpha/history/v2/*` and `alpha/notes/v2/*` POST endpoints
+through the built-in `openai` provider with the `openai-responses` adapter and canonical
+ChatGPT forward destination. Direct uses the current caller/main login; Pool selects a Codex
+account. `openai-apikey` uses its configured API key, and custom or noncanonical Responses
+providers are not candidates for this context relay and receive no Codex-account credentials
+from it. These private endpoints are not implemented by other model providers or the OpenAI
+API-key route.
+
+Caller headers are restricted to the shared Codex forward allowlist: `authorization`,
+`chatgpt-account-id`, and approved OpenAI beta, originator, session, and Codex protocol metadata.
+The context relay additionally forwards `x-openai-encrypted-tool-arguments` and
+`x-openai-tool-output-truncation-policy`; arbitrary caller headers such as cookies are not
+forwarded. A proxy data-plane key presented as a bearer is replaced with the selected Codex
+credential (the stored main login in Direct); missing credentials fail before forwarding.
+Proxy admission credentials never go upstream. Encrypted arguments, response bodies, and
+upstream error statuses are preserved.
+
+A successful ChatGPT model response records the root session's actual serving account in a
+bounded, process-local ownership registry. History and notes use that recorded owner, including
+an explicitly selected account, even when the current active account changes. Stored-account token
+refresh may continue for the same physical account; a replaced account identity is rejected.
+Direct caller-owned sessions keep the caller credential and cannot be taken over by a proxy bearer.
+This does not migrate server-side history between accounts.
+
+Unknown, expired, evicted, conflicting, or restart-lost ownership returns HTTP 409 before account
+selection or upstream I/O. The relay does not guess from the current active account. Existing
+sessions should save a checkpoint or other durable summary before enabling the feature or resetting
+context. Enabling it does not backfill earlier history or notes, and a new ownership observation
+does not prove that older backend content exists. After a restart, establish ownership with a
+successful model request before using context tools; start a new session when ownership conflicts.
+
+Existing model affinity, cooldown, and retry rules are unchanged. Context requests are not
+automatically retried, including notes writes; ChatGPT forward requests do not use same-key 429
+replay. History traffic does not consume or settle a model quota-recovery probe.
+
+To disable the feature, remove the experimental key (or set it to `false`), run `ocx sync`,
+and start a new Codex session. The managed root base returns to `/v1`.
+
 ### Built-in image generation (`image_gen`)

 Codex's built-in `image_gen` tool does not go through `/v1/responses` — the codex-rs extension
diff --git a/docs-site/src/content/docs/ko/guides/codex-integration.md b/docs-site/src/content/docs/ko/guides/codex-integration.md
index 3f777153ec..7dc14176c6 100644
--- a/docs-site/src/content/docs/ko/guides/codex-integration.md
+++ b/docs-site/src/content/docs/ko/guides/codex-integration.md
@@ -40,6 +40,61 @@ loopback `openai_base_url` 형태에서만 쓰이고, 그 키와 함께 제거

 프록시는 기본적으로 포트 `10100`에서 듣고 `POST /v1/responses`, `POST /v1/responses/compact`, `POST /v1/images/generations`, `POST /v1/images/edits`, `GET /v1/models`, `GET /healthz`, 그리고 `/api/*` 관리 표면을 제공합니다.

+### 실험적 컨텍스트 관리 (Codex 0.153+)
+
+지원되는 ChatGPT 계정에서는 Codex의 `config.toml`에 다음 설정을 추가합니다.
+기존 `[features]` 테이블이 있으면 그 안에 병합하세요.
+
+```toml
+[features]
+context_management.experimental_mode = true
+```
+
+기본 내장 loopback 통합에서는 다음 `ocx sync` 또는 프록시 시작 시 관리되는 루트
+`openai_base_url`이 `http://127.0.0.1:10100/backend-api/codex`로 바뀝니다. Codex는 이 경로를
+확인한 뒤 `new_context`, history, notes 도구를 활성화합니다. 동기화 후 새 Codex 세션을
+시작하세요. 이 기능은 명시적으로 켜야 하며, 사용자 소유 URL과 원격 사용자 지정 provider
+주입은 변경하지 않습니다. 컨텍스트 창이나 압축 한도를 덮어쓰지 않습니다.
+
+이 backend 접두사는 Responses WebSocket 업그레이드를 포함한 기존 데이터 경로의 별칭입니다.
+원래 `/v1` 경로와 realtime sideband 오버라이드도 유지됩니다. 열 개의 네이티브
+`alpha/history/v2/*`, `alpha/notes/v2/*` POST 엔드포인트는 `openai-responses` 어댑터와 정식
+ChatGPT forward 목적지를 사용하는 내장 `openai` provider로만 전달합니다. Direct는 현재
+호출자/메인 로그인을, Pool은 선택된 Codex 계정을 사용합니다. `openai-apikey`는 설정된 API
+키를 사용하는 별도 경로이며 이 비공개 엔드포인트를 지원하지 않습니다. 사용자 지정 또는
+비정식 Responses provider는 이 컨텍스트 relay의 후보가 아니며 Codex 계정 자격 증명을
+전달받지 않습니다.
+
+호출자 헤더는 공통 Codex forward 허용 목록으로 제한됩니다. `authorization`,
+`chatgpt-account-id`, 승인된 OpenAI beta, originator, session 및 Codex 프로토콜 메타데이터와
+추가 헤더 `x-openai-encrypted-tool-arguments`, `x-openai-tool-output-truncation-policy`만
+전달합니다. 쿠키 등 임의 헤더는 전달하지 않습니다. 프록시 데이터 키를 bearer로 사용하면
+선택된 Codex 자격 증명으로 교체하며, Direct에서는 저장된 메인 로그인을 사용합니다.
+자격 증명이 없으면 전달 전에 실패합니다. 프록시 인증 자격 증명은 upstream으로 보내지
+않습니다. 암호화된 인수, 응답 본문, upstream 오류 상태는 보존합니다.
+
+성공한 ChatGPT 모델 응답은 루트 세션을 실제로 처리한 계정을 크기가 제한된 프로세스 로컬
+소유권 레지스트리에 기록합니다. History와 notes는 현재 활성 계정이 바뀌어도 명시적으로
+선택된 계정을 포함해 기록된 소유 계정을 사용합니다. 저장된 계정의 토큰은 같은 실제 계정에
+한해 갱신할 수 있으며, 다른 실제 계정으로 교체되면 거부합니다. Direct 호출자 소유 세션은
+호출자 자격 증명을 유지하며 프록시 bearer로 인계할 수 없습니다. 서버 측 history를 계정 간에
+이동하는 기능은 아닙니다.
+
+소유권이 없거나 만료, 제거, 충돌 또는 재시작으로 소실된 경우 계정 선택이나 upstream 요청
+전에 HTTP 409를 반환합니다. 현재 활성 계정으로 추측하지 않습니다. 기존 세션에서는 기능을
+켜거나 컨텍스트를 초기화하기 전에 체크포인트 또는 지속적으로 보관할 요약을 먼저 저장하세요.
+기능을 켜도 이전 history나 notes를 소급해서 채우지 않으며, 소유권이 새로 확인되어도 이전
+backend 콘텐츠가 존재한다는 뜻은 아닙니다. 재시작 후에는 성공한 모델 요청으로 소유권을
+확립한 뒤 컨텍스트 도구를 사용하고, 소유권이 충돌하면 새 세션을 시작하세요.
+
+기존 모델 affinity, cooldown 및 재시도 규칙은 변경하지 않습니다. Notes 쓰기를 포함한
+컨텍스트 요청은 자동 재시도하지 않으며, ChatGPT forward 요청에 같은 키를 사용한 429
+재시도를 추가하지 않습니다. History 트래픽은 모델의 quota-recovery probe를 점유하거나
+완료 처리하지 않습니다.
+
+끄려면 실험 설정을 삭제하거나 `false`로 바꾼 뒤 `ocx sync`를 실행하고 새 세션을 시작하세요.
+관리되는 루트 URL은 `/v1`로 돌아갑니다.
+
 ### 내장 이미지 생성 (`image_gen`)

 Codex의 내장 `image_gen` 도구는 `/v1/responses`를 거치지 않습니다. codex-rs 확장은 채팅과 같은 ChatGPT bearer 인증을 사용해서 `{base_url}/images/generations`를 직접 POST하며, 참조 이미지가 붙어 있으면 `/images/edits`를 POST합니다. 주입된 `base_url`이 opencodex를 가리키므로, 프록시가 이 호출을 OpenAI upstream으로 전달합니다.
diff --git a/scripts/test-layout/layout.json b/scripts/test-layout/layout.json
index 7d312309ce..b72066c1d2 100644
--- a/scripts/test-layout/layout.json
+++ b/scripts/test-layout/layout.json
@@ -11,7 +11,7 @@
   "domains": {
     "providers": {
       "match": [
-        "^(?:aside|auto|azure|baseten|chutes|cline|command|commandcode|context|cyber|deepinfra|deepseek|digitalocean|exa|featherless|forward|hyperbolic|kimi|meta|mimo|minimax|moonshot|muse|new|nous|novita|nscale|nvidia|opencode|openrouter|qwen38|sambanova|umans|vercel|zcode|zhipu)-"
+        "^(?:aside|auto|azure|baseten|chutes|cline|command|commandcode|context(?!-compat|-history)|cyber|deepinfra|deepseek|digitalocean|exa|featherless|forward|hyperbolic|kimi|meta|mimo|minimax|moonshot|muse|new|nous|novita|nscale|nvidia|opencode|openrouter|qwen38|sambanova|umans|vercel|zcode|zhipu)-"
       ],
       "children": {
         "cursor": [
@@ -33,11 +33,13 @@
     },
     "codex-integration": {
       "match": [
+        "^context-compat\\.test\\.ts$",
         "^(?:active|app|bearer|catalog|combos\\.test\\.ts|doctor\\.test\\.ts|effort|gather|history|injection|issue|multi|native|parallel|project|selected|slug|ultrafast|warmup\\.test\\.ts)-"
       ]
     },
     "server": {
       "match": [
+        "^context-history\\.test\\.ts$",
         "^(?:account|alias|bounded|cancel|config\\.test\\.ts|consume|data|debug|error|errors|fetch|health|input|loopback|management|memory|outbound|owned|passive|port|ports\\.test\\.ts|proxy|relay|response|retry|server|session|sidebar|stream|v2)-"
       ]
     },
@@ -378,6 +380,7 @@
     "codex-cli-update-zero-effect.test.ts": "codex-integration",
     "codex-composed-acceptance.test.ts": "codex-integration",
     "codex-config-generation.test.ts": "codex-integration",
+    "codex-context-owner.test.ts": "codex-integration",
     "codex-convergence-account-selectors.test.ts": "codex-integration",
     "codex-convergence-contract.test.ts": "codex-integration",
     "codex-cooldown-recovery.test.ts": "codex-integration",
@@ -493,6 +496,9 @@
     "consume-for-inspection-cancel.test.ts": "server",
     "container-bootstrap.test.ts": "service",
     "context-cap-unknown-window.test.ts": "providers",
+    "context-compat.test.ts": "codex-integration",
+    "context-history-ownership.test.ts": "server",
+    "context-history.test.ts": "server",
     "continuation-dedup.test.ts": "responses",
     "core-lab-boundary.test.ts": "lab",
     "cost-cap-unknown-evidence.test.ts": "usage",
diff --git a/src/codex/context-compat.ts b/src/codex/context-compat.ts
new file mode 100644
index 0000000000..8158ec728a
--- /dev/null
+++ b/src/codex/context-compat.ts
@@ -0,0 +1,42 @@
+/** Backend path and opt-in config compatibility for native Codex history/notes. */
+export const CONTEXT_BACKEND_PREFIX = "/backend-api/codex";
+
+const CONTEXT_ENDPOINTS = new Set([
+  "alpha/history/v2/list_windows", "alpha/history/v2/list_items",
+  "alpha/history/v2/read_item", "alpha/history/v2/search_contents",
+  "alpha/notes/v2/thread_hint", "alpha/notes/v2/list_files_by_prefix",
+  "alpha/notes/v2/read_file", "alpha/notes/v2/search_contents",
+  "alpha/notes/v2/append_to_file", "alpha/notes/v2/write_file",
+]);
+
+export function contextEndpoint(path: string): string | undefined {
+  const endpoint = path.startsWith("/v1/") ? path.slice(4) : "";
+  return CONTEXT_ENDPOINTS.has(endpoint) ? endpoint : undefined;
+}
+
+/** Alias only the data-plane prefix. Existing auth/origin and route gates still run. */
+export function codexCompatibleUrl(rawUrl: string): URL {
+  const url = new URL(rawUrl);
+  if (url.pathname === CONTEXT_BACKEND_PREFIX || url.pathname.startsWith(CONTEXT_BACKEND_PREFIX + "/")) {
+    url.pathname = "/v1" + url.pathname.slice(CONTEXT_BACKEND_PREFIX.length);
+  }
+  return url;
+}
+
+/** Change only marker-managed built-in routing, and only with an explicit context opt-in. */
+export function contextCompatibleBaseLine(content: string, line: string): string {
+  let parsed: {features?: {context_management?: {experimental_mode?: boolean}}};
+  try {
+    parsed = Bun.TOML.parse(content) as typeof parsed;
+  } catch {
+    // Injection tolerates incomplete user config; malformed TOML is not an opt-in.
+    return line;
+  }
+  if (parsed.features?.context_management?.experimental_mode !== true) return line;
+  const match = /^openai_base_url = "([^"]+)"$/.exec(line);
+  if (!match) return line;
+  const url = new URL(match[1]);
+  if (url.pathname !== "/v1" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return line;
+  url.pathname = CONTEXT_BACKEND_PREFIX;
+  return `openai_base_url = "${url.href}"`;
+}
diff --git a/src/codex/context-owner.ts b/src/codex/context-owner.ts
new file mode 100644
index 0000000000..cf0149c139
--- /dev/null
+++ b/src/codex/context-owner.ts
@@ -0,0 +1,141 @@
+import { createHmac, randomBytes } from "node:crypto";
+import type { CodexAuthContext } from "./auth-context";
+import { MAIN_CODEX_ACCOUNT_ID } from "./account-id";
+
+export type ContextSessionOwner = Readonly<
+  | { kind: "stored"; accountId: string; physicalIdentity: string; ambiguous: boolean }
+  | { kind: "caller"; physicalIdentity?: string; callerCredentialIdentity: string; ambiguous: boolean }
+>;
+
+const TTL_MS = 24 * 60 * 60_000;
+const MAX_ENTRIES = 2048;
+const MAX_BYTES = 1024 * 1024;
+const salt = randomBytes(32);
+type Entry = { owner: ContextSessionOwner; destination: string; touchedAt: number; bytes: number };
+const owners = new Map<string, Entry>();
+let totalBytes = 0;
+
+function digest(domain: string, value: string): string {
+  return createHmac("sha256", salt).update(domain).update("\0").update(value).digest("hex");
+}
+
+function validId(value: string | null | undefined): value is string {
+  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,512}$/.test(value);
+}
+
+function destinationIdentity(destination: string): string | undefined {
+  if (!destination || destination.length > 4096) return undefined;
+  try {
+    const url = new URL(destination);
+    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) return undefined;
+    return digest("destination", url.href.replace(/\/+$/, ""));
+  } catch { return undefined; }
+}
+
+function physicalIdentity(headers: Headers): string | undefined {
+  const account = headers.get("chatgpt-account-id");
+  return validId(account) ? digest("physical-account", account) : undefined;
+}
+
+function callerCredentialIdentity(headers: Headers): string | undefined {
+  const authorization = headers.get("authorization");
+  if (!authorization || authorization.length > 32_768 || !/^Bearer [^\s]+$/i.test(authorization)) return undefined;
+  const account = headers.get("chatgpt-account-id");
+  if (account !== null && !validId(account)) return undefined;
+  return digest("caller-credential", JSON.stringify([authorization.slice(7), account]));
+}
+
+function remove(key: string): void {
+  const prior = owners.get(key);
+  if (!prior) return;
+  owners.delete(key);
+  totalBytes -= prior.bytes;
+}
+
+function sweep(now: number): void {
+  for (const [key, entry] of owners) {
+    if (now < entry.touchedAt || now - entry.touchedAt >= TTL_MS) remove(key);
+  }
+}
+
+/** Called only after a model attempt was accepted by its actual destination. */
+export function recordContextSessionOwner(
+  inboundHeaders: Headers, destination: string, auth: CodexAuthContext,
+  outboundHeaders: Headers, substituteMainCredential: boolean, now = Date.now(),
+): void {
+  if (!Number.isFinite(now)) return;
+  // A malformed explicit parent must not fall back to an unrelated local session.
+  const root = inboundHeaders.get("x-codex-parent-thread-id") ?? inboundHeaders.get("session-id");
+  if (!validId(root)) return;
+  const destinationKey = destinationIdentity(destination);
+  const credential = callerCredentialIdentity(outboundHeaders);
+  if (!destinationKey || !credential) return;
+  const physical = physicalIdentity(outboundHeaders);
+  let owner: ContextSessionOwner;
+  if (auth.kind !== "main" || substituteMainCredential) {
+    if (!physical) return;
+    if (auth.kind !== "main" && (!validId(auth.accountId)
+      || auth.chatgptAccountId !== outboundHeaders.get("chatgpt-account-id"))) return;
+    // Direct proxy-bearer substitution has no token snapshot in its `main` context;
+    // its accepted outbound identity is still evidence for the stored main slot.
+    owner = { kind: "stored", accountId: auth.kind === "main" ? MAIN_CODEX_ACCOUNT_ID : auth.accountId,
+      physicalIdentity: physical, ambiguous: false };
+  } else {
+    owner = { kind: "caller", ...(physical ? { physicalIdentity: physical } : {}),
+      callerCredentialIdentity: credential, ambiguous: false };
+  }
+  sweep(now);
+  const key = digest("root-session", root);
+  const prior = owners.get(key);
+  if (prior) {
+    const samePhysical = prior.owner.physicalIdentity !== undefined && physical !== undefined
+      ? prior.owner.physicalIdentity === physical
+      : prior.owner.kind === "caller" && owner.kind === "caller"
+        && prior.owner.physicalIdentity === undefined && owner.physicalIdentity === undefined
+        && prior.owner.callerCredentialIdentity === owner.callerCredentialIdentity;
+    if (prior.owner.ambiguous || prior.destination !== destinationKey
+      || prior.owner.kind !== owner.kind || !samePhysical) {
+      // Once two accepted attempts prove conflicting ownership, no later write can
+      // silently choose which account contains this session's history.
+      owner = { ...prior.owner, ambiguous: true };
+    }
+  }
+  const ownerDestination = prior?.destination ?? destinationKey;
+  const bytes = Buffer.byteLength(JSON.stringify([key, ownerDestination, owner]), "utf8");
+  remove(key);
+  owners.set(key, { owner: Object.freeze(owner), destination: ownerDestination, touchedAt: now, bytes });
+  totalBytes += bytes;
+  while (owners.size > MAX_ENTRIES || totalBytes > MAX_BYTES) {
+    const oldest = owners.keys().next().value;
+    if (oldest === undefined) break;
+    remove(oldest);
+  }
+}
+
+/** Missing/expired/evicted ownership is unknown; never infer it from active routing. */
+export function getContextSessionOwner(
+  sessionId: string, destination: string, now = Date.now(),
+): ContextSessionOwner | undefined {
+  if (!validId(sessionId) || !Number.isFinite(now)) return undefined;
+  const destinationKey = destinationIdentity(destination);
+  if (!destinationKey) return undefined;
+  sweep(now);
+  const key = digest("root-session", sessionId);
+  const entry = owners.get(key);
+  if (!entry || entry.destination !== destinationKey) return undefined;
+  owners.delete(key);
+  entry.touchedAt = now;
+  owners.set(key, entry);
+  return entry.owner;
+}
+
+/** Compare only already-materialized headers; this function never reads credentials. */
+export function contextSessionOwnerMatches(owner: ContextSessionOwner, headers: Headers): boolean {
+  if (owner.ambiguous) return false;
+  if (owner.kind === "stored") return owner.physicalIdentity === physicalIdentity(headers);
+  return owner.callerCredentialIdentity === callerCredentialIdentity(headers);
+}
+
+export function clearContextSessionOwnersForTests(): void {
+  owners.clear(); totalBytes = 0;
+}
diff --git a/src/codex/inject.ts b/src/codex/inject.ts
index 37e631305b..e9765e8a7f 100644
--- a/src/codex/inject.ts
+++ b/src/codex/inject.ts
@@ -1,3 +1,4 @@
+import { contextCompatibleBaseLine } from "./context-compat";
 import { existsSync, readFileSync, unlinkSync } from "node:fs";
 import {
   atomicWriteFile,
@@ -364,7 +365,7 @@ export function setRootOpenaiBaseUrl(
   const lines = content.split("\n");
   const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
   const rootEnd = firstTable === -1 ? lines.length : firstTable;
-  const key = buildOpenaiBaseUrlLine(portOrTarget, hostname);
+  const key = contextCompatibleBaseLine(content, buildOpenaiBaseUrlLine(portOrTarget, hostname));

   for (let i = 0; i < rootEnd; i++) {
     if (!isRootOpenaiBaseUrlLine(lines[i])) continue;
@@ -399,7 +400,7 @@ function setRootOpenaiBaseUrlForTarget(
   const lines = content.split("\n");
   const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
   const rootEnd = firstTable === -1 ? lines.length : firstTable;
-  const key = buildOpenaiBaseUrlLineForTarget(target);
+  const key = contextCompatibleBaseLine(content, buildOpenaiBaseUrlLineForTarget(target));
   for (let index = 0; index < rootEnd; index += 1) {
     if (!isRootOpenaiBaseUrlLine(lines[index])) continue;
     const markerOwned = index > 0 && lines[index - 1].includes(OCX_SECTION_MARKER);
diff --git a/src/server/context-history.ts b/src/server/context-history.ts
new file mode 100644
index 0000000000..de06cbcf40
--- /dev/null
+++ b/src/server/context-history.ts
@@ -0,0 +1,142 @@
+/** Native history/notes JSON relay. No interpretation of encrypted tool arguments or retries. */
+import { formatErrorResponse } from "../bridge";
+import {
+  CodexAccountCooldownError, CodexAuthContextError, CodexMainProfileDrainingError, CodexDirectAuthenticationError,
+  CodexPoolAuthenticationError, CodexThreadAffinityExpiredError, CodexMainSubstitutionUnavailableError,
+  codexMainProfileDrainingResponse, cooldownErrorResponse,
+  materializeCodexUpstreamAuth, isCodexAuthContextUsable, resolveCodexAuthContext, releaseCodexAuthContextProbeLease,
+} from "../codex/auth-context";
+import { getContextSessionOwner, contextSessionOwnerMatches } from "../codex/context-owner";
+import { contextEndpoint } from "../codex/context-compat";
+import { formatCodexProviderForLog } from "../codex/routing";
+import { listOpenAiForwardSidecarCandidates } from "../providers/openai-sidecar";
+import { signalWithTimeout } from "../lib/abort";
+import { readBoundedResponseBytes } from "../lib/bounded-body";
+import type { AdmissionLease } from "../lib/admission";
+import type { OcxConfig } from "../types";
+import { ForwardAdmissionCredentialError, validateForwardAdmissionCredential, type DataPlaneAdmission } from "./auth-cors";
+import { readJsonRequestBody } from "./request-decompress";
+import { codexLogAccountId, decodeRequestErrorResponse } from "./responses";
+import { codexAccountSelectionForTurn } from "./lifecycle";
+import type { RequestLogContext } from "./request-log";
+
+const PROTOCOL_HEADERS = ["x-openai-encrypted-tool-arguments", "x-openai-tool-output-truncation-policy"];
+const RESPONSE_HEADERS = ["content-type", "retry-after", "x-request-id", "openai-processing-ms", ...PROTOCOL_HEADERS];
+const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
+
+export function contextSelectionHeaders(headers: Headers, sessionId: string): Headers {
+  const result = new Headers(headers);
+  // Codex history tools carry root session_id in JSON, unlike Responses' HTTP headers.
+  // Root model requests use (session-id=root, thread-id=root); don't fabricate a parent key.
+  if (!result.has("x-codex-parent-thread-id") && !result.has("session-id") && !result.has("thread-id")) {
+    result.set("session-id", sessionId);
+    result.set("thread-id", sessionId);
+  }
+  return result;
+}
+
+export async function handleContextHistory(
+  req: Request, config: OcxConfig, logCtx: RequestLogContext,
+  endpoint: string, turnAdmissionLease?: AdmissionLease, admission?: DataPlaneAdmission,
+): Promise<Response> {
+  if (!contextEndpoint("/v1/" + endpoint) || req.method !== "POST") {
+    return formatErrorResponse(404, "not_found", "Unknown context endpoint");
+  }
+  // Only a trusted listener admission authorizes replacing a proxy bearer with Codex auth.
+  const substituteMainCredential = admission?.source === "bearer";
+  try { if (!substituteMainCredential) validateForwardAdmissionCredential(req.headers, config); }
+  catch (err) {
+    if (err instanceof ForwardAdmissionCredentialError) return formatErrorResponse(401, "authentication_error", err.message);
+    throw err;
+  }
+  let body: unknown;
+  try { body = await readJsonRequestBody(req); }
+  catch (err) { return decodeRequestErrorResponse(err, "context_history"); }
+  const sessionId = (body as {context?: {session_id?: unknown}} | null)?.context?.session_id;
+  if (typeof sessionId !== "string" || !/^[A-Za-z0-9._:-]{1,512}$/.test(sessionId)) {
+    return formatErrorResponse(400, "invalid_request_error", "context.session_id must be a bounded nonempty string");
+  }
+  const candidate = listOpenAiForwardSidecarCandidates(config)[0];
+  if (!candidate) return formatErrorResponse(400, "invalid_request_error", "History and notes require the native ChatGPT forward provider");
+  const rootHeader = req.headers.get("x-codex-parent-thread-id")?.trim() || req.headers.get("session-id")?.trim();
+  if (rootHeader && rootHeader !== sessionId) {
+    return formatErrorResponse(409, "context_account_unavailable", "Context root does not match this request");
+  }
+  const owner = getContextSessionOwner(sessionId, candidate.provider.baseUrl);
+  if (!owner || owner.ambiguous || (owner.kind === "caller" && substituteMainCredential)) {
+    return formatErrorResponse(409, "context_account_unavailable",
+      "Context account ownership is unavailable; start a new session and preserve needed state before resetting context");
+  }
+  let authContext: Awaited<ReturnType<typeof resolveCodexAuthContext>>;
+  const headers = new Headers(candidate.provider.headers);
+  try {
+    authContext = await resolveCodexAuthContext(contextSelectionHeaders(req.headers, sessionId), config, owner.kind === "stored" ? "pool" : "direct", {
+      // Resolve the proven physical owner as an explicit account. Context operations
+      // never create affinity, rotate on quota, or inspect file-main for a caller owner.
+      modelId: "context_history",
+      ...(owner.kind === "stored" ? { accountId: owner.accountId } : { requestScopedMainCredential: true }),
+      admission,
+      substituteMainCredentialForDirect: substituteMainCredential,
+      beginCodexAccountSelection: codexAccountSelectionForTurn(turnAdmissionLease),
+    });
+    if (authContext.kind !== "main" && authContext.probeLeaseId) {
+      // History traffic must not occupy or settle the model's quota-recovery probe.
+      releaseCodexAuthContextProbeLease(authContext);
+      return formatErrorResponse(503, "upstream_error", "Model quota recovery is pending; retry context operation later");
+    }
+    if (!isCodexAuthContextUsable(authContext, config)) throw new CodexPoolAuthenticationError("Selected Codex account is unavailable");
+    logCtx.provider = formatCodexProviderForLog(candidate.providerName, codexLogAccountId(authContext), config);
+    // Materialization rechecks the current account policy after async selection.
+    // Synthetic lane IDs are local selection metadata, never upstream headers.
+    for (const [key, value] of materializeCodexUpstreamAuth(req.headers, authContext, {
+      config, modelId: "context_history", admission, substituteMainCredential,
+    })) {
+      headers.set(key, value);
+    }
+    // Recheck actual wire identity after async selection/materialization. A replaced
+    // account slot or login must not receive another physical account's history.
+    const currentOwner = getContextSessionOwner(sessionId, candidate.provider.baseUrl);
+    if (!currentOwner || currentOwner.kind !== owner.kind
+      || !contextSessionOwnerMatches(owner, headers) || !contextSessionOwnerMatches(currentOwner, headers)) {
+      return formatErrorResponse(409, "context_account_unavailable", "Context account identity changed; start a new session");
+    }
+    // Check the assembled outbound headers, including configured provider headers.
+    validateForwardAdmissionCredential(headers, config);
+  } catch (err) {
+    if (err instanceof CodexAccountCooldownError) return cooldownErrorResponse(err);
+    if (err instanceof CodexMainProfileDrainingError) return codexMainProfileDrainingResponse();
+    if (err instanceof CodexThreadAffinityExpiredError) return formatErrorResponse(409, "invalid_request_error", "Codex thread account affinity expired; start a new session");
+    if (err instanceof CodexAuthContextError || err instanceof CodexPoolAuthenticationError || err instanceof CodexDirectAuthenticationError
+      || err instanceof CodexMainSubstitutionUnavailableError || err instanceof ForwardAdmissionCredentialError) {
+      return formatErrorResponse(401, "authentication_error", "Selected Codex account is unavailable or needs reauthentication");
+    }
+    throw err;
+  }
+  headers.set("content-type", "application/json");
+  for (const key of PROTOCOL_HEADERS) {
+    const value = req.headers.get(key); if (value !== null) headers.set(key, value);
+  }
+  const deadline = signalWithTimeout(35_000, req.signal);
+  let response: Response | undefined;
+  try {
+    response = await fetch(`${candidate.provider.baseUrl}/${endpoint}`, {
+      method: "POST", headers, body: JSON.stringify(body), signal: deadline.signal, redirect: "manual",
+    });
+    const result = await readBoundedResponseBytes(response, {maxBytes: MAX_RESPONSE_BYTES, signal: deadline.signal});
+    if (result.oversized) return formatErrorResponse(502, "upstream_error", "Context response exceeded 16 MiB");
+    const outputHeaders = new Headers();
+    for (const key of RESPONSE_HEADERS) {
+      const value = response.headers.get(key); if (value !== null) outputHeaders.set(key, value);
+    }
+    // A context 403 is not evidence that the model credential is invalid. Don't mutate pool
+    // health/quota or retry writes; preserve the real upstream result for the caller.
+    return new Response([204,205,304].includes(response.status) ? null : result.bytes, {status:response.status, headers:outputHeaders});
+  } catch {
+    if (req.signal.aborted) return formatErrorResponse(499, "client_closed_request", "Context request canceled by client");
+    if (deadline.signal.aborted) return formatErrorResponse(504, "upstream_error", "Context upstream timed out");
+    return formatErrorResponse(502, "upstream_error", "Context upstream connection failed");
+  } finally {
+    deadline.cleanup();
+    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
+  }
+}
diff --git a/src/server/index.ts b/src/server/index.ts
index 82f36d7b6a..f074235f36 100644
--- a/src/server/index.ts
+++ b/src/server/index.ts
@@ -195,6 +195,8 @@ import {
 import { handleImages } from "./images";
 import { handleLive, logLiveSidebandFrame, parseLiveSidebandTarget, resolveLiveSidebandUpgrade } from "./live";
 import { handleSearch } from "./search";
+import { handleContextHistory } from "./context-history";
+import { codexCompatibleUrl, contextEndpoint } from "../codex/context-compat";
 import { fetchAllModels, handleManagementAPI, VERSION, type ManagementApiDeps } from "./management-api";
 import {
   createManagementSessionControl,
@@ -820,6 +822,7 @@ export function startServer(port?: number, deps: StartServerDeps = {}): Server<W
     }
     if (path === "/v1/responses/compact") return req.method === "POST";
     if (path === "/v1/alpha/search") return req.method === "POST";
+    if (contextEndpoint(path)) return req.method === "POST";
     if (path === "/v1/images/generations" || path === "/v1/images/edits") {
       return req.method === "POST";
     }
@@ -1047,7 +1050,7 @@ export function startServer(port?: number, deps: StartServerDeps = {}): Server<W
       // The unauthenticated loopback listener (#1102) serves a fixed allowlist and nothing
       // else. Rejecting here, before any handler runs, is what keeps the surface from growing
       // silently when a route is added below.
-      if (ingress === "unauthenticated-loopback" && !loopbackRouteAllowed(new URL(req.url), req)) {
+      if (ingress === "unauthenticated-loopback" && !loopbackRouteAllowed(codexCompatibleUrl(req.url), req)) {
         return withCors(
           formatErrorResponse(404, "not_found", `Unknown endpoint: ${req.method} ${new URL(req.url).pathname}`),
           req,
@@ -1056,7 +1059,7 @@ export function startServer(port?: number, deps: StartServerDeps = {}): Server<W
       }
       // Tailscale Serve terminates only on this separately bound loopback socket. Reject before
       // dispatch so no data, readiness, health, WebSocket, or unknown-static handler can run.
-      if (ingress === "hub-management" && !managementIngressRouteAllowed(new URL(req.url), req)) {
+      if (ingress === "hub-management" && !managementIngressRouteAllowed(codexCompatibleUrl(req.url), req)) {
         return withCors(
           formatErrorResponse(404, "not_found", `Unknown endpoint: ${req.method} ${new URL(req.url).pathname}`),
           req,
@@ -1069,7 +1072,7 @@ export function startServer(port?: number, deps: StartServerDeps = {}): Server<W
       // same code path a plain loopback bind has always taken — Host-header check included.
       // Routing, provider selection and response bodies keep using `config`.
       const policy: RequestPolicyView = ingress === "unauthenticated-loopback" ? loopbackPolicy() : config;
-      const url = new URL(req.url);
+      const url = codexCompatibleUrl(req.url);
       markActivity(`${req.method} ${url.pathname}`);

       // Readiness is exact-GET on the literal /readyz path. Compare the DECODED
@@ -1825,6 +1828,31 @@ export function startServer(port?: number, deps: StartServerDeps = {}): Server<W
         }), req, policy);
       }

+      if (contextEndpoint(url.pathname) !== undefined && req.method === "POST") {
+        disableResponsesRequestTimeout(req, requestServer);
+        if (isDraining()) {
+          return drainingResponse(req, policy);
+        }
+        const admission = resolveApiAuth(req, policy);
+        if (!admission) return withCors(formatErrorResponse(401, "authentication_error", "opencodex API key required"), req, policy);
+        if (!isAllowedRequestOrigin(req, policy)) {
+          return withCors(formatErrorResponse(403, "origin_rejected", "cross-origin data-plane request blocked"), req, policy);
+        }
+        const start = Date.now();
+        const requestId = nextRequestLogId(start);
+        const logCtx: RequestLogContext = {
+          model: "context_history",
+          provider: "unknown",
+          ...admissionFields(admission),
+        };
+        return runAdmittedHttpTurn(req, policy, async turnAdmissionLease => {
+          const response = await handleContextHistory(req, config, logCtx, contextEndpoint(url.pathname)!, turnAdmissionLease, admission);
+          addFinalRequestLog(requestId, start, logCtx, response.status,
+            response.status === 499 ? { closeReason: "client_cancel" } : undefined);
+          return withCors(response, req, policy);
+        });
+      }
+
       if (url.pathname === "/v1/alpha/search" && req.method === "POST") {
         disableResponsesRequestTimeout(req, requestServer);
         if (isDraining()) {
diff --git a/src/server/live.ts b/src/server/live.ts
index 91caec1f66..a139c6c177 100644
--- a/src/server/live.ts
+++ b/src/server/live.ts
@@ -1,3 +1,4 @@
+import { codexCompatibleUrl } from "../codex/context-compat";
 /**
  * /v1/live and /v1/realtime/calls relay (issue #371).
  *
@@ -646,7 +647,7 @@ export async function handleLive(
     // Frameless API-shape call-create posts to `{base}/live` without the AVAS
     // query (openai/codex RealtimeCallClient, realtime_call.rs); only the
     // realtime/calls inbound shape keeps the legacy keyed AVAS endpoint.
-    url = new URL(req.url).pathname === "/v1/live"
+    url = codexCompatibleUrl(req.url).pathname === "/v1/live"
       ? forwardLiveUrl(relay.providerBaseUrl, /* usesBackendShape */ false)
       : keyedLiveUrl(relay.providerBaseUrl);
   }
diff --git a/src/server/responses/core.ts b/src/server/responses/core.ts
index 684931c9f9..b451103c1d 100644
--- a/src/server/responses/core.ts
+++ b/src/server/responses/core.ts
@@ -1,4 +1,5 @@
 import type { Server } from "bun";
+import { recordContextSessionOwner } from "../../codex/context-owner";
 import { randomUUID } from "node:crypto";
 import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse, type ResponsesTerminalStatus } from "../../bridge";
 import { formatPassthroughUpstreamError } from "./passthrough-error";
@@ -3880,8 +3881,14 @@ async function handleResponsesInner(
   // message, and leave Codex fataling on a missing compaction item (#422).
   const routedCompaction = parsed._compactionRequest === true
     && !isCanonicalOpenAiForwardProvider(route.provider);
-  const commitReasoningReplayServingRoute = (): void => {
+  const commitReasoningReplayServingRoute = (outboundHeaders?: HeadersInit): void => {
     commitReasoningReplayServingIdentity(parsed._reasoningReplayScope);
+    // History has no model namespace. Record the account that actually accepted this
+    // final attempt, after refresh/failover, rather than guessing from mutable affinity.
+    if (outboundHeaders && isCanonicalOpenAiForwardProvider(route.provider)) {
+      recordContextSessionOwner(req.headers, route.provider.baseUrl, authCtx,
+        new Headers(outboundHeaders), substituteMainCredential);
+    }
   };
   if (routedCompaction) {
     delete parsed.context.tools;
@@ -4951,7 +4958,7 @@ async function handleResponsesInner(
       // For streamed passthrough, a successful terminal response means non-error upstream status
       // before relay starts. Waiting for SSE completion would retain request state across the whole
       // stream; a later body failure does not undo that this destination accepted and served the turn.
-      commitReasoningReplayServingRoute();
+      commitReasoningReplayServingRoute(request.headers);
       const terminalRepairPolicy = providerModelResponsesTerminalRepair(
         route.providerName,
         route.provider,
@@ -5271,7 +5278,7 @@ async function handleResponsesInner(
           return formatErrorResponse(502, "upstream_error", undeclaredToolCallMessage(undeclared));
         }
       }
-      commitReasoningReplayServingRoute();
+      commitReasoningReplayServingRoute(request.headers);
       if (rememberPassthroughResponseChecked) {
         try {
           rememberPassthroughResponseChecked(
@@ -5355,7 +5362,7 @@ async function handleResponsesInner(
     }
     // An unclassified passthrough body is relayed directly and has no bounded completion observer;
     // use the same non-error-status success boundary as SSE instead of retaining per-stream state.
-    commitReasoningReplayServingRoute();
+    commitReasoningReplayServingRoute(request.headers);
     const body = relayWithAbort(upstreamResponse.body, upstream);
     const turnAc = new AbortController();
     const tracked = body ? trackStreamLifetime(body, turnAc, undefined, options.turnAdmissionLease) : null;
@@ -5671,7 +5678,7 @@ async function handleResponsesInner(
       streamRoutedModelOutput: wsPlan.streamRoutedModelOutput,
       on429: rotateSidecarProviderOn429,
       retryOn429Policy: rateLimitRetryPolicyFor(route.provider),
-      onCompletedResponse: commitReasoningReplayServingRoute,
+      onCompletedResponse: () => commitReasoningReplayServingRoute(),
     });
     // Register the sidecar stream as an active turn so drainAndShutdown waits for (or aborts)
     // in-flight web-search turns instead of skipping them during graceful shutdown.
diff --git a/tests/codex-integration/codex-auth-context.test.ts b/tests/codex-integration/codex-auth-context.test.ts
index bb4f24a098..34ca20c112 100644
--- a/tests/codex-integration/codex-auth-context.test.ts
+++ b/tests/codex-integration/codex-auth-context.test.ts
@@ -72,6 +72,8 @@ import {
   tryAdmitTurn,
 } from "../../src/server/lifecycle";
 import type { CodexModelEntitlementSnapshot } from "../../src/codex/model-entitlements";
+import { recordContextSessionOwner, clearContextSessionOwnersForTests } from "../../src/codex/context-owner";
+import { handleContextHistory } from "../../src/server/context-history";
 import { hasForwardableCodexBearer } from "../../src/server/auth-cors";
 import { removeTreeWithRetry } from "../helpers/remove-tree";

@@ -2228,3 +2230,50 @@ describe("native-main fence names its gate reason", () => {
     }
   });
 });
+
+
+test("context Direct bearer admission uses real stored-main materialization and fails closed without it", async () => {
+  const cfg = config();
+  cfg.providers.openai = {
+    adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex",
+    authMode: "forward", codexAccountMode: "direct",
+  };
+  const token = liveJwt();
+  const admission = { kind: "environment", source: "bearer" } as const;
+  clearContextSessionOwnersForTests();
+  recordContextSessionOwner(new Headers({ "session-id": "synthetic-root" }), cfg.providers.openai.baseUrl,
+    { kind: "main", accountId: null }, new Headers({ authorization: `Bearer ${token}`, "chatgpt-account-id": "stored_main_acc" }), true);
+  const request = () => new Request("http://localhost/v1/alpha/notes/v2/read_file", {
+    method: "POST", headers: { authorization: "Bearer ocx_data_test_admission", "openai-beta": "responses=experimental", cookie: "synthetic=private" },
+    body: JSON.stringify({ context: { session_id: "synthetic-root" } }),
+  });
+  const originalFetch = globalThis.fetch;
+  let calls = 0;
+  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
+    calls++;
+    expect(String(input)).toBe("https://chatgpt.com/backend-api/codex/alpha/notes/v2/read_file");
+    const headers = new Headers(init?.headers);
+    expect(headers.get("authorization")).toBe(`Bearer ${token}`);
+    expect(headers.get("chatgpt-account-id")).toBe("stored_main_acc");
+    expect(headers.get("openai-beta")).toBe("responses=experimental");
+    expect(headers.has("cookie")).toBe(false);
+    return new Response("{}");
+  }, { preconnect: originalFetch.preconnect });
+  try {
+    for (const available of [true, false]) {
+      writeFileSync(join(testDir, "auth.json"), JSON.stringify({ tokens: available ? { access_token: token, account_id: "stored_main_acc" } : {} }));
+      const turn = tryAdmitTurn();
+      expect(turn).not.toBeNull();
+      try {
+        const response = await handleContextHistory(request(), cfg, { model: "context_history", provider: "" }, "alpha/notes/v2/read_file", turn!, admission);
+        expect(response.status).toBe(available ? 200 : 401);
+      } finally {
+        turn?.release();
+      }
+    }
+    expect(calls).toBe(1);
+  } finally {
+    clearContextSessionOwnersForTests();
+    globalThis.fetch = originalFetch;
+  }
+});
diff --git a/tests/codex-integration/codex-context-owner.test.ts b/tests/codex-integration/codex-context-owner.test.ts
new file mode 100644
index 0000000000..5d34fc0406
--- /dev/null
+++ b/tests/codex-integration/codex-context-owner.test.ts
@@ -0,0 +1,151 @@
+import { beforeEach, describe, expect, test } from "bun:test";
+import type { CodexAuthContext } from "../../src/codex/auth-context";
+import { clearContextSessionOwnersForTests, contextSessionOwnerMatches,
+  getContextSessionOwner, recordContextSessionOwner } from "../../src/codex/context-owner";
+
+const destination = "https://chatgpt.com/backend-api/codex";
+const start = 1_000_000;
+const root = (id = "root") => new Headers({ "session-id": id, "thread-id": id });
+const outbound = (account: string | null = "physical-a", token = "accepted-a") => new Headers({
+  authorization: `Bearer ${token}`, ...(account === null ? {} : { "chatgpt-account-id": account }),
+});
+const stored = (id = "slot-a", account = "physical-a"): CodexAuthContext => ({
+  kind: "pool", accountId: id, chatgptAccountId: account,
+  accessToken: "accepted-a", generation: 1, writerGeneration: 0, fixedAccount: true,
+});
+const caller: CodexAuthContext = { kind: "main", accountId: null };
+beforeEach(clearContextSessionOwnersForTests);
+
+describe("context session ownership", () => {
+  test("an explicit stored account owns the session independently of routing state", () => {
+    recordContextSessionOwner(root(), destination, stored(), outbound(), false, start);
+    const owner = getContextSessionOwner("root", destination, start)!;
+    expect(owner).toMatchObject({ kind: "stored", accountId: "slot-a", ambiguous: false });
+    expect(contextSessionOwnerMatches(owner, outbound())).toBe(true);
+    expect(contextSessionOwnerMatches(owner, outbound("physical-b"))).toBe(false);
+    expect(JSON.stringify(owner)).not.toContain("physical-a");
+    expect(JSON.stringify(owner)).not.toContain("accepted-a");
+  });
+
+  test("stored ownership survives token and generation refresh within the same physical account", () => {
+    recordContextSessionOwner(root(), destination, stored(), outbound(), false, start);
+    const refreshed = { ...stored(), generation: 2, accessToken: "refreshed" } as CodexAuthContext;
+    recordContextSessionOwner(root(), destination, refreshed, outbound("physical-a", "refreshed"), false, start + 1);
+    const owner = getContextSessionOwner("root", destination, start + 2)!;
+    expect(owner.ambiguous).toBe(false);
+    expect(contextSessionOwnerMatches(owner, outbound("physical-a", "refreshed"))).toBe(true);
+  });
+
+  test("stored identity must match the accepted outbound account", () => {
+    recordContextSessionOwner(root(), destination, stored(), outbound("physical-b"), false, start);
+    expect(getContextSessionOwner("root", destination, start)).toBeUndefined();
+    recordContextSessionOwner(root(), destination, stored(), outbound(null), false, start);
+    expect(getContextSessionOwner("root", destination, start)).toBeUndefined();
+  });
+
+  test("caller-owned credentials remain fenced from proxy or other bearer credentials", () => {
+    recordContextSessionOwner(root(), destination, caller, outbound(), false, start);
+    const owner = getContextSessionOwner("root", destination, start)!;
+    expect(owner.kind).toBe("caller");
+    expect(contextSessionOwnerMatches(owner, outbound())).toBe(true);
+    expect(contextSessionOwnerMatches(owner, outbound("physical-a", "proxy-secret"))).toBe(false);
+    expect(contextSessionOwnerMatches(owner, outbound("physical-b"))).toBe(false);
+  });
+
+  test("only an accepted same-account model turn authorizes a rotated caller token", () => {
+    recordContextSessionOwner(root(), destination, caller, outbound(), false, start);
+    const refreshed = outbound("physical-a", "refreshed");
+    expect(contextSessionOwnerMatches(getContextSessionOwner("root", destination, start)!, refreshed)).toBe(false);
+    recordContextSessionOwner(root(), destination, caller, refreshed, false, start + 1);
+    const owner = getContextSessionOwner("root", destination, start + 1)!;
+    expect(owner.ambiguous).toBe(false);
+    expect(contextSessionOwnerMatches(owner, refreshed)).toBe(true);
+    expect(contextSessionOwnerMatches(owner, outbound())).toBe(false);
+  });
+
+  test("caller without physical identity allows only the exact credential", () => {
+    recordContextSessionOwner(root(), destination, caller, outbound(null), false, start);
+    let owner = getContextSessionOwner("root", destination, start)!;
+    expect(contextSessionOwnerMatches(owner, outbound(null))).toBe(true);
+    recordContextSessionOwner(root(), destination, caller, outbound(null, "rotated"), false, start + 1);
+    owner = getContextSessionOwner("root", destination, start + 1)!;
+    expect(owner.ambiguous).toBe(true);
+    expect(contextSessionOwnerMatches(owner, outbound(null, "rotated"))).toBe(false);
+  });
+
+  test("substituted Direct main is stored ownership, not caller ownership", () => {
+    recordContextSessionOwner(root(), destination, caller, outbound(), true, start);
+    expect(getContextSessionOwner("root", destination, start)).toMatchObject({ kind: "stored", accountId: "__main__" });
+  });
+
+  test("root and child model turns share the root body session lookup", () => {
+    recordContextSessionOwner(root(), destination, stored(), outbound(), false, start);
+    recordContextSessionOwner(new Headers({ "x-codex-parent-thread-id": "root", "session-id": "child" }),
+      destination, stored(), outbound(), false, start + 1);
+    expect(getContextSessionOwner("root", destination, start + 1)?.ambiguous).toBe(false);
+    expect(getContextSessionOwner("child", destination, start + 1)).toBeUndefined();
+  });
+
+  test.each(["physical", "kind", "destination"])("conflicting %s remains ambiguous after later writes", conflict => {
+    recordContextSessionOwner(root(), destination, stored(), outbound(), false, start);
+    recordContextSessionOwner(root(), conflict === "destination" ? "https://other.test/codex" : destination,
+      conflict === "kind" ? caller : stored("slot-b", conflict === "physical" ? "physical-b" : "physical-a"),
+      outbound(conflict === "physical" ? "physical-b" : "physical-a"), false, start + 1);
+    recordContextSessionOwner(root(), destination, stored(), outbound(), false, start + 2);
+    const owner = getContextSessionOwner("root", destination, start + 2)!;
+    expect(owner.ambiguous).toBe(true);
+    expect(contextSessionOwnerMatches(owner, outbound())).toBe(false);
+    expect(getContextSessionOwner("root", "https://other.test/codex", start + 2)).toBeUndefined();
+  });
+
+  test("destination mismatch cannot bootstrap a new owner", () => {
+    recordContextSessionOwner(root(), destination, stored(), outbound(), false, start);
+    expect(getContextSessionOwner("root", "https://other.test/codex", start)).toBeUndefined();
+    expect(getContextSessionOwner("root", destination + "/", start)).toBeDefined();
+  });
+
+  test("a fresh lookup detects conflict after an earlier snapshot was read", () => {
+    recordContextSessionOwner(root(), destination, stored(), outbound(), false, start);
+    const oldOwner = getContextSessionOwner("root", destination, start)!;
+    recordContextSessionOwner(root(), destination, stored("slot-b", "physical-b"), outbound("physical-b"), false, start + 1);
+    const currentOwner = getContextSessionOwner("root", destination, start + 1)!;
+    expect(oldOwner.ambiguous).toBe(false);
+    expect(currentOwner.ambiguous).toBe(true);
+    expect(contextSessionOwnerMatches(currentOwner, outbound())).toBe(false);
+  });
+
+  test("expiry and restart lose ownership instead of guessing an active account", () => {
+    recordContextSessionOwner(root(), destination, stored(), outbound(), false, start);
+    expect(getContextSessionOwner("root", destination, start + 24 * 60 * 60_000)).toBeUndefined();
+    recordContextSessionOwner(root(), destination, stored(), outbound(), false, start);
+    clearContextSessionOwnersForTests();
+    expect(getContextSessionOwner("root", destination, start)).toBeUndefined();
+  });
+
+  test("LRU capacity evicts the untouched entry, preserving a recently looked-up owner", () => {
+    for (let i = 0; i < 2048; i++) recordContextSessionOwner(root(`root-${i}`), destination, stored(), outbound(), false, start);
+    expect(getContextSessionOwner("root-0", destination, start + 1)).toBeDefined();
+    recordContextSessionOwner(root("overflow"), destination, stored(), outbound(), false, start + 2);
+    expect(getContextSessionOwner("root-0", destination, start + 2)).toBeDefined();
+    expect(getContextSessionOwner("root-1", destination, start + 2)).toBeUndefined();
+  });
+
+  test("byte capacity also bounds long account slots", () => {
+    for (let i = 0; i < 1600; i++) recordContextSessionOwner(root(`root-${i}`), destination,
+      stored("a".repeat(512)), outbound(), false, start);
+    expect(getContextSessionOwner("root-0", destination, start)).toBeUndefined();
+    expect(getContextSessionOwner("root-1599", destination, start)).toBeDefined();
+  });
+
+  test("invalid and oversized identifiers never create ownership", () => {
+    for (const id of ["", "bad root", "a".repeat(513)]) {
+      recordContextSessionOwner(root(id), destination, stored(), outbound(), false, start);
+      expect(getContextSessionOwner(id, destination, start)).toBeUndefined();
+    }
+    recordContextSessionOwner(new Headers({ "x-codex-parent-thread-id": "bad root", "session-id": "root" }),
+      destination, stored(), outbound(), false, start);
+    expect(getContextSessionOwner("root", destination, start)).toBeUndefined();
+    recordContextSessionOwner(root(), "https://x.test/" + "a".repeat(4096), stored(), outbound(), false, start);
+    expect(getContextSessionOwner("root", destination, start)).toBeUndefined();
+  });
+});
diff --git a/tests/codex-integration/codex-inject.test.ts b/tests/codex-integration/codex-inject.test.ts
index 84ac5f67b6..54bf6cd34c 100644
--- a/tests/codex-integration/codex-inject.test.ts
+++ b/tests/codex-integration/codex-inject.test.ts
@@ -2,6 +2,7 @@ import { describe, expect, test } from "bun:test";
 import {
   applyEol,
   buildOpenaiBaseUrlLine,
+  buildRealtimeWsBaseUrlLine,
   buildProfileFile,
   buildProviderTableBlock,
   chooseCatalogPathForInjection,
@@ -13,7 +14,7 @@ import {
   stripRootContextWindowOverrides,
   standaloneCodexRoutingTarget,
 } from "../../src/codex/inject";
-import { stripJournaledOpenaiBaseUrl } from "../../src/codex/injected-marker";
+import { OCX_SECTION_MARKER, stripJournaledOpenaiBaseUrl } from "../../src/codex/injected-marker";
 import {
   MANAGED_AGENTS_TABLE_MARKER,
   MANAGED_SUBAGENT_DEFAULT_MARKER,
@@ -687,3 +688,33 @@ describe("EOL boundary helpers (Windows CRLF configs)", () => {
     expect(applyEol(crlf, "\r\n")).toBe(crlf);
   });
 });
+
+test('managed injection is idempotent and retains every unrelated value',()=>{
+ const source=`model = "gpt-6-astra"\n${OCX_SECTION_MARKER}\nopenai_base_url = "http://127.0.0.1:10100/v1"\nservice_tier = "fast"\n[features]\ncontext_management.experimental_mode = true\n[features.multi_agent_v2]\nenabled = true\n`;
+ const target={baseUrl:'http://127.0.0.1:10100/v1',requiresAdmissionToken:false,tokenEnv:'OPENCODEX_API_AUTH_TOKEN' as const};
+ const result=setRootOpenaiBaseUrl(source,target);
+ expect(result.keptUserBaseUrl).toBe(false);
+ expect(result.content).toBe(source.replace('10100/v1','10100/backend-api/codex'));
+ expect(setRootOpenaiBaseUrl(result.content,target).content).toBe(result.content);
+ expect(buildRealtimeWsBaseUrlLine(target)).toContain('10100/v1');
+ expect(setRootOpenaiBaseUrl(source,10100).content).toBe(result.content);
+});
+test('feature disabled and user-owned routing remain intact',()=>{
+ const source='openai_base_url = "http://127.0.0.1:10100/v1"\n[features]\ncontext_management.experimental_mode = true\n';
+ expect(setRootOpenaiBaseUrl(source,10100)).toEqual({content:source,keptUserBaseUrl:true});
+ const managed=`${OCX_SECTION_MARKER}\nopenai_base_url = "http://127.0.0.1:10100/v1"\n[features]\ncontext_management.experimental_mode = false\n`;
+ expect(setRootOpenaiBaseUrl(managed,10100).content).toBe(managed);
+});
+
+
+test("malformed TOML preserves user routing and does not enable context injection", () => {
+  const target = { baseUrl: "http://127.0.0.1:10100/v1", requiresAdmissionToken: false, tokenEnv: "OPENCODEX_API_AUTH_TOKEN" as const };
+  for (const malformed of ['model = "unterminated', '[features]\ncontext_management.experimental_mode = true\nbroken = [']) {
+    const userOwned = `openai_base_url = "https://example.invalid/v1"\n${malformed}\n`;
+    const managed = `${OCX_SECTION_MARKER}\nopenai_base_url = "http://127.0.0.1:10100/v1"\n${malformed}\n`;
+    for (const inject of [(source: string) => setRootOpenaiBaseUrl(source, 10100), (source: string) => setRootOpenaiBaseUrl(source, target)]) {
+      expect(inject(userOwned)).toEqual({ content: userOwned, keptUserBaseUrl: true });
+      expect(inject(managed)).toEqual({ content: managed, keptUserBaseUrl: false });
+    }
+  }
+});
diff --git a/tests/codex-integration/context-compat.test.ts b/tests/codex-integration/context-compat.test.ts
new file mode 100644
index 0000000000..a0e19f4c60
--- /dev/null
+++ b/tests/codex-integration/context-compat.test.ts
@@ -0,0 +1,22 @@
+import { describe, test, expect } from "bun:test";
+import { codexCompatibleUrl, contextEndpoint, contextCompatibleBaseLine } from "../../src/codex/context-compat";
+
+describe("route and config isolation", () => {
+  test("aliases data-plane routes and preserves query; never aliases management", () => {
+    for (const route of ["responses", "responses/compact", "models", "alpha/search", "live", "realtime/calls"]) {
+      expect(codexCompatibleUrl(`http://127.0.0.1:10100/backend-api/codex/${route}?a=1`).pathname).toBe(`/v1/${route}`);
+    }
+    expect(codexCompatibleUrl("http://127.0.0.1:10100/v1/responses?a=1").href).toBe("http://127.0.0.1:10100/v1/responses?a=1");
+    expect(codexCompatibleUrl("http://127.0.0.1:10100/backend-api/codex/api/config").pathname).toBe("/v1/api/config");
+    expect(contextEndpoint("/v1/alpha/notes/v2/write_file")).toBe("alpha/notes/v2/write_file");
+    expect(contextEndpoint("/v1/alpha/notes/v2/delete_file")).toBeUndefined();
+    expect(contextEndpoint("/v1/alpha/notes/v2/../write_file")).toBeUndefined();
+  });
+  test("opt-in changes only the built-in loopback base URL", () => {
+    const line='openai_base_url = "http://127.0.0.1:10100/v1"';
+    expect(contextCompatibleBaseLine('[features]\ncontext_management.experimental_mode = true\n',line)).toBe('openai_base_url = "http://127.0.0.1:10100/backend-api/codex"');
+    for(const content of ['','[features]\ncontext_management.experimental_mode = false\n']) expect(contextCompatibleBaseLine(content,line)).toBe(line);
+    const remote='openai_base_url = "https://example.com/v1"';
+    expect(contextCompatibleBaseLine('[features.context_management]\nexperimental_mode=true\n',remote)).toBe(remote);
+  });
+});
diff --git a/tests/fixtures/test-layout-expected.json b/tests/fixtures/test-layout-expected.json
index 5276f08f46..288049cd0d 100644
--- a/tests/fixtures/test-layout-expected.json
+++ b/tests/fixtures/test-layout-expected.json
@@ -215,6 +215,7 @@
   "codex-cli-update-zero-effect.test.ts": "codex-integration",
   "codex-composed-acceptance.test.ts": "codex-integration",
   "codex-config-generation.test.ts": "codex-integration",
+  "codex-context-owner.test.ts": "codex-integration",
   "codex-convergence-account-selectors.test.ts": "codex-integration",
   "codex-convergence-contract.test.ts": "codex-integration",
   "codex-cooldown-recovery.test.ts": "codex-integration",
@@ -330,6 +331,9 @@
   "consume-for-inspection-cancel.test.ts": "server",
   "container-bootstrap.test.ts": "service",
   "context-cap-unknown-window.test.ts": "providers",
+  "context-compat.test.ts": "codex-integration",
+  "context-history-ownership.test.ts": "server",
+  "context-history.test.ts": "server",
   "continuation-dedup.test.ts": "responses",
   "core-lab-boundary.test.ts": "lab",
   "cost-cap-unknown-evidence.test.ts": "usage",
diff --git a/tests/server/context-history-ownership.test.ts b/tests/server/context-history-ownership.test.ts
new file mode 100644
index 0000000000..83a9a79d42
--- /dev/null
+++ b/tests/server/context-history-ownership.test.ts
@@ -0,0 +1,150 @@
+import { afterEach, beforeEach, expect, test } from "bun:test";
+import { mkdtempSync, writeFileSync } from "node:fs";
+import { join } from "node:path";
+import { tmpdir } from "node:os";
+import { handleResponses } from "../../src/server/responses";
+import { handleContextHistory } from "../../src/server/context-history";
+import { tryAdmitTurn } from "../../src/server/lifecycle";
+import type { DataPlaneAdmission } from "../../src/server/auth-cors";
+import { saveCodexAccountCredential } from "../../src/codex/account-store";
+import { clearAccountNeedsReauth } from "../../src/codex/account-runtime-state";
+import { clearAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
+import { clearCodexUpstreamHealth, clearThreadAccountMap, resetCodexRoutingForManualSelection } from "../../src/codex/routing";
+import { clearContextSessionOwnersForTests, getContextSessionOwner } from "../../src/codex/context-owner";
+import type { OcxConfig } from "../../src/types";
+import { removeTreeWithRetry } from "../helpers/remove-tree";
+
+const destination = "https://chatgpt.com/backend-api/codex";
+const originalFetch = globalThis.fetch;
+let previousHome: string | undefined;
+let previousCodexHome: string | undefined;
+let home = "";
+let sent: Array<{ url: string; headers: Headers }> = [];
+let failFirstAccount: string | undefined;
+
+function install(id: string, owner: string, token = `${id}-token`): void {
+  saveCodexAccountCredential(id, { accessToken: token, refreshToken: `${id}-refresh`,
+    chatgptAccountId: owner, expiresAt: Date.now() + 3600_000 });
+  setAccountQuotaFromParsed(id, { weeklyPercent: 20 });
+}
+
+function config(): OcxConfig {
+  return { port: 0, defaultProvider: "openai", activeCodexAccountId: "pool-b",
+    autoSwitchThreshold: 95, accountPoolStrategy: "fill-first", emptyCompletionRetry: false,
+    codexAccountNamespaces: { side: "pool-a" },
+    codexAccounts: [{ id: "pool-a", isMain: false }, { id: "pool-b", isMain: false }],
+    providers: { openai: { adapter: "openai-responses", baseUrl: destination,
+      authMode: "forward", codexAccountMode: "pool" } } };
+}
+
+function requestHeaders(session: string, bearer = "caller-native-token", account = "caller-account"): Headers {
+  return new Headers({ "content-type": "application/json", authorization: `Bearer ${bearer}`,
+    "chatgpt-account-id": account, "session-id": session, "thread-id": session });
+}
+
+async function model(cfg: OcxConfig, session: string, name = "side/gpt-5.5", headers = requestHeaders(session), admission?: DataPlaneAdmission): Promise<Response> {
+  const lease = tryAdmitTurn(); expect(lease).not.toBeNull();
+  try {
+    const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST", headers,
+      body: JSON.stringify({ model: name, input: "hello", stream: false }) }), cfg,
+      { model: "", provider: "" }, { turnAdmissionLease: lease!, admission });
+    const text = await response.text();
+    return new Response(text, { status: response.status, headers: response.headers });
+  } finally { lease?.release(); }
+}
+
+async function notes(cfg: OcxConfig, session: string, headers = requestHeaders(session), admission?: DataPlaneAdmission): Promise<Response> {
+  const lease = tryAdmitTurn(); expect(lease).not.toBeNull();
+  try {
+    return await handleContextHistory(new Request("http://localhost/v1/alpha/notes/v2/read_file", {
+      method: "POST", headers, body: JSON.stringify({ context: { session_id: session } }),
+    }), cfg, { model: "context_history", provider: "" }, "alpha/notes/v2/read_file", lease!, admission);
+  } finally { lease?.release(); }
+}
+
+beforeEach(() => {
+  previousHome = process.env.OPENCODEX_HOME; previousCodexHome = process.env.CODEX_HOME;
+  home = mkdtempSync(join(tmpdir(), "ocx-context-owner-"));
+  process.env.OPENCODEX_HOME = home; process.env.CODEX_HOME = home;
+  clearContextSessionOwnersForTests(); clearAccountQuota(); clearThreadAccountMap(); clearCodexUpstreamHealth();
+  for (const id of ["pool-a", "pool-b", "__main__"]) clearAccountNeedsReauth(id);
+  install("pool-a", "physical-a"); install("pool-b", "physical-b");
+  sent = []; failFirstAccount = undefined;
+  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
+    const url = String(input); const headers = new Headers(init?.headers); sent.push({ url, headers });
+    if (url === `${destination}/responses`) {
+      if (headers.get("chatgpt-account-id") === failFirstAccount) {
+        failFirstAccount = undefined;
+        return Response.json({ error: { message: "usage limit reached", type: "usage_limit_reached" } }, { status: 429 });
+      }
+      return Response.json({ id: "response-owned", object: "response", status: "completed",
+        output: [{ id: "message-owned", type: "message", role: "assistant", status: "completed",
+          content: [{ type: "output_text", text: "ready", annotations: [] }] }],
+        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
+    }
+    if (url === `${destination}/alpha/notes/v2/read_file`) return Response.json({ value: "same account" });
+    throw new Error(`Unexpected test request: ${url}`);
+  }, { preconnect: originalFetch.preconnect });
+});
+
+afterEach(() => {
+  globalThis.fetch = originalFetch;
+  clearContextSessionOwnersForTests(); clearAccountQuota(); clearThreadAccountMap(); clearCodexUpstreamHealth();
+  removeTreeWithRetry(home);
+  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
+  if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
+});
+
+test("successful explicit account A owns context while active B remains selected", async () => {
+  const cfg = config(); resetCodexRoutingForManualSelection("pool-b");
+  const response = await model(cfg, "root-explicit");
+  expect(response.status).toBe(200);
+  expect(getContextSessionOwner("root-explicit", destination)).toMatchObject({ kind: "stored", accountId: "pool-a", ambiguous: false });
+  expect((await notes(cfg, "root-explicit")).status).toBe(200);
+  expect(sent.map(row => row.headers.get("chatgpt-account-id"))).toEqual(["physical-a", "physical-a"]);
+  expect(cfg.activeCodexAccountId).toBe("pool-b");
+  install("pool-a", "physical-a", "renewed-a-token");
+  expect((await notes(cfg, "root-explicit")).status).toBe(200);
+  expect(sent.at(-1)!.headers.get("authorization")).toBe("Bearer renewed-a-token");
+  install("pool-a", "replacement-a");
+  expect((await notes(cfg, "root-explicit")).status).toBe(409);
+  expect(sent).toHaveLength(3);
+  clearContextSessionOwnersForTests();
+  expect((await notes(cfg, "root-explicit")).status).toBe(409);
+  expect(sent).toHaveLength(3);
+});
+
+test("failed account A then successful B records only the serving account", async () => {
+  const cfg = config(); cfg.activeCodexAccountId = "pool-a";
+  resetCodexRoutingForManualSelection("pool-a"); failFirstAccount = "physical-a";
+  const response = await model(cfg, "root-retry", "gpt-5.5");
+  expect(response.status).toBe(200);
+  expect(sent.map(row => row.headers.get("chatgpt-account-id"))).toEqual(["physical-a", "physical-b"]);
+  expect(getContextSessionOwner("root-retry", destination)).toMatchObject({ kind: "stored", accountId: "pool-b", ambiguous: false });
+  expect((await notes(cfg, "root-retry")).status).toBe(200);
+  expect(sent.at(-1)!.headers.get("chatgpt-account-id")).toBe("physical-b");
+});
+
+test("Direct caller context never borrows stored login or proxy admission", async () => {
+  const cfg = config(); cfg.providers.openai.codexAccountMode = "direct";
+  expect((await model(cfg, "root-caller", "gpt-5.5")).status).toBe(200);
+  expect(getContextSessionOwner("root-caller", destination)?.kind).toBe("caller");
+  expect((await notes(cfg, "root-caller")).status).toBe(200);
+  expect(sent.map(row => row.headers.get("authorization"))).toEqual(["Bearer caller-native-token", "Bearer caller-native-token"]);
+  const admission = { kind: "environment", source: "bearer" } as const;
+  expect((await notes(cfg, "root-caller", requestHeaders("root-caller", "ocx_data_test_key"), admission)).status).toBe(409);
+  expect(sent).toHaveLength(2);
+});
+
+test("Direct proxy-bearer model and notes use stored main without leaking the proxy secret", async () => {
+  const cfg = config(); cfg.providers.openai.codexAccountMode = "direct";
+  const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
+  writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: token, account_id: "physical-main" } }));
+  const admission = { kind: "environment", source: "bearer" } as const;
+  const headers = requestHeaders("root-proxy", "ocx_data_test_key", "untrusted-account");
+  expect((await model(cfg, "root-proxy", "gpt-5.5", headers, admission)).status).toBe(200);
+  expect(getContextSessionOwner("root-proxy", destination)).toMatchObject({ kind: "stored", accountId: "__main__" });
+  expect((await notes(cfg, "root-proxy", headers, admission)).status).toBe(200);
+  expect(sent.map(row => row.headers.get("authorization"))).toEqual([`Bearer ${token}`, `Bearer ${token}`]);
+  expect(sent.every(row => row.headers.get("chatgpt-account-id") === "physical-main")).toBe(true);
+});
diff --git a/tests/server/context-history.test.ts b/tests/server/context-history.test.ts
new file mode 100644
index 0000000000..26c3d03b9b
--- /dev/null
+++ b/tests/server/context-history.test.ts
@@ -0,0 +1,281 @@
+// mock.module replacements require file isolation (bun test --isolate).
+import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
+import type { CodexAuthContext } from "../../src/codex/auth-context";
+import { recordContextSessionOwner, clearContextSessionOwnersForTests } from "../../src/codex/context-owner";
+import type { DataPlaneAdmission } from "../../src/server/auth-cors";
+import type { OcxConfig } from "../../src/types";
+import type { RequestLogContext } from "../../src/server/request-log";
+
+type Selection = { headers: Headers; mode: string; options: { modelId: string; admission?: DataPlaneAdmission; substituteMainCredentialForDirect?: boolean; accountId?: string; requestScopedMainCredential?: boolean } };
+let selection: Selection | undefined;
+const config: OcxConfig = { port: 0, defaultProvider: "openai", providers: {} };
+const logContext = (): RequestLogContext => ({ model: "context_history", provider: "" });
+let materialized: { config: OcxConfig; modelId: string } | undefined;
+let materializationError: Error | undefined;
+let materializationOptions: { admission?: DataPlaneAdmission; substituteMainCredential?: boolean } | undefined;
+let outgoingBearer = "test-only";
+let outgoingAccount = "test-only";
+let accountMode = "pool";
+let validated=0;
+let probe=false;let released=0;let directError=false;
+const errors = {
+  CodexAccountCooldownError: class extends Error {},
+  CodexMainSubstitutionUnavailableError: class extends Error {},
+  CodexDirectAuthenticationError: class extends Error {},
+  CodexAuthContextError: class extends Error {},
+  CodexMainProfileDrainingError: class extends Error {},
+  CodexPoolAuthenticationError: class extends Error {},
+  CodexThreadAffinityExpiredError: class extends Error {},
+};
+mock.module("../../src/codex/auth-context",()=>({
+  ...errors,
+  resolveCodexAuthContext:async(headers: Headers, _config: OcxConfig, mode: string, options: Selection["options"])=>{selection={headers,mode,options};if(directError)throw new errors.CodexDirectAuthenticationError();return {kind:"pool",accountId:"test-account",...(probe?{probeLeaseId:"test-probe"}:{})};},
+  isCodexAuthContextUsable:()=>true,
+  releaseCodexAuthContextProbeLease:()=>{released++;},
+  materializeCodexUpstreamAuth: (_headers: Headers, _auth: unknown, options: { config: OcxConfig; modelId: string; admission?: DataPlaneAdmission; substituteMainCredential?: boolean }) => {
+    materializationOptions = options;
+    materialized = { config: options.config, modelId: options.modelId };
+    if (materializationError) throw materializationError;
+    return new Headers({ authorization: `Bearer ${outgoingBearer}`, "chatgpt-account-id": outgoingAccount });
+  },
+  headersForCodexAuthContext:(_headers: Headers, _auth: unknown, selectedConfig: OcxConfig, modelId: string) => {
+    materialized = { config: selectedConfig, modelId };
+    if (materializationError) throw materializationError;
+    return new Headers({ authorization: "Bearer test-only", "chatgpt-account-id": outgoingAccount });
+  },
+  cooldownErrorResponse:()=>new Response("cooldown",{status:429}),
+  codexMainProfileDrainingResponse:()=>new Response("draining",{status:503}),
+}));
+const realRouting = await import("../../src/codex/routing");
+mock.module("../../src/codex/routing",()=>({...realRouting, formatCodexProviderForLog:()=>"openai-test"}));
+mock.module("../../src/providers/openai-sidecar",()=>({listOpenAiForwardSidecarCandidates:()=>[{providerName:"openai",provider:{baseUrl:"https://chatgpt.com/backend-api/codex"},accountMode}]}));
+class ForwardAdmissionCredentialError extends Error {}
+mock.module("../../src/server/auth-cors",()=>({ForwardAdmissionCredentialError,validateForwardAdmissionCredential:(h:Headers)=>{validated++;if(!h.has("authorization") || h.get("authorization") === "Bearer ocx_data_test_admission")throw new ForwardAdmissionCredentialError("test credential missing");}}));
+mock.module("../../src/server/responses",()=>({codexLogAccountId:()=>"test",decodeRequestErrorResponse:()=>new Response("invalid json",{status:400})}));
+mock.module("../../src/server/lifecycle",()=>({codexAccountSelectionForTurn:()=>()=>undefined}));
+const { handleContextHistory, contextSelectionHeaders } = await import("../../src/server/context-history");
+const destination = "https://chatgpt.com/backend-api/codex";
+function seedOwner(sessionId: string, kind: "stored" | "caller" = "stored", account = "test-only", now?: number) {
+  const auth = kind === "caller" ? { kind: "main", accountId: null } : {
+    kind: "pool", accountId: "test-account", chatgptAccountId: account,
+    accessToken: "test-only", generation: 1, writerGeneration: 0,
+  };
+  recordContextSessionOwner(new Headers({ "session-id": sessionId }), destination,
+    auth as CodexAuthContext, new Headers({ authorization: "Bearer test-only", "chatgpt-account-id": account }), false, now);
+}
+const originalFetch=globalThis.fetch;
+function setFetch(handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): void {
+  globalThis.fetch = Object.assign(handler, { preconnect: originalFetch.preconnect });
+}
+afterAll(()=>{clearContextSessionOwnersForTests();globalThis.fetch=originalFetch;mock.restore();});
+beforeEach(()=>{clearContextSessionOwnersForTests();for (const id of ["root", "root-test", "s"]) seedOwner(id);outgoingAccount="test-only";globalThis.fetch=originalFetch;materialized=undefined;materializationError=undefined;selection=undefined;validated=0;materializationOptions=undefined;outgoingBearer="test-only";accountMode="pool";probe=false;released=0;directError=false;});
+
+describe("context relay contract",()=>{
+  test("selects root shared lane but sends original body and protocol headers",async()=>{
+    const body={context:{session_id:"root-test",current_agent_name:"/root"},encrypted_arguments:"opaque+==",unknown:{future:true}};
+    let sent: RequestInit & { url: string } = { url: "" };
+    setFetch(async(url: string | URL | Request, opts?: RequestInit)=>{sent={url:String(url),...opts};return new Response('{"ok":true}',{headers:{"content-type":"application/json","x-request-id":"req-test"}});});
+    const req=new Request("http://127.0.0.1/backend-api/codex/alpha/notes/v2/write_file",{method:"POST",headers:{authorization:"Bearer incoming","content-type":"application/json","x-openai-encrypted-tool-arguments":"true","x-openai-tool-output-truncation-policy":"{\"mode\":\"tokens\"}"},body:JSON.stringify(body)});
+    const r=await handleContextHistory(req,config,logContext(),"alpha/notes/v2/write_file");
+    expect(r.status).toBe(200);expect(r.headers.get("x-request-id")).toBe("req-test");
+    expect(materialized).toEqual({ config, modelId: "context_history" });
+    expect(validated).toBeGreaterThanOrEqual(1);expect(selection?.mode).toBe("pool");expect(selection?.options.modelId).toBe("context_history");
+    expect(selection?.headers.get("session-id")).toBe("root-test");expect(selection?.headers.get("thread-id")).toBe("root-test");expect(selection?.headers.get("x-codex-parent-thread-id")).toBeNull();
+    expect(JSON.parse(String(sent.body))).toEqual(body);expect(new Headers(sent.headers).has("session-id")).toBe(false);
+    expect(new Headers(sent.headers).get("x-openai-encrypted-tool-arguments")).toBe("true");expect(sent.redirect).toBe("manual");
+  });
+  test("propagates errors without retrying or hiding a write failure",async()=>{
+    let calls=0;
+    setFetch(async()=>{calls++;return new Response('{"error":"feature denied"}',{status:403,headers:{"retry-after":"7"}});});
+    const req=new Request("http://localhost/v1/alpha/notes/v2/write_file",{method:"POST",headers:{authorization:"Bearer test","content-type":"application/json"},body:JSON.stringify({context:{session_id:"s"}})});
+    const r=await handleContextHistory(req,config,logContext(),"alpha/notes/v2/write_file");
+    expect(r.status).toBe(403);expect(await r.text()).toBe('{"error":"feature denied"}');expect(r.headers.get("retry-after")).toBe("7");expect(calls).toBe(1);
+  });
+  test("rejects malformed context before any account selection",async()=>{
+    const req=new Request("http://localhost/v1/alpha/notes/v2/write_file",{method:"POST",headers:{authorization:"Bearer test","content-type":"application/json"},body:"{}"});
+    expect((await handleContextHistory(req,config,logContext(),"alpha/notes/v2/write_file")).status).toBe(400);expect(selection).toBeUndefined();
+    expect(contextSelectionHeaders(new Headers({"x-codex-parent-thread-id":"parent"}),"s").get("session-id")).toBeNull();
+  });
+});
+
+test("context traffic releases quota probe and maps missing direct auth",async()=>{
+ const request=()=>new Request("http://localhost/v1/alpha/notes/v2/read_file",{method:"POST",headers:{authorization:"Bearer test","content-type":"application/json"},body:JSON.stringify({context:{session_id:"root-test"}})});
+ probe=true;
+ expect((await handleContextHistory(request(),config,logContext(),"alpha/notes/v2/read_file")).status).toBe(503);
+ expect(released).toBe(1);
+ probe=false;directError=true;
+ expect((await handleContextHistory(request(),config,logContext(),"alpha/notes/v2/read_file")).status).toBe(401);
+});
+test("invalid header characters are rejected before selection",async()=>{
+ const req=new Request("http://localhost/v1/alpha/notes/v2/read_file",{method:"POST",headers:{authorization:"Bearer test","content-type":"application/json"},body:JSON.stringify({context:{session_id:"bad\nvalue"}})});
+ expect((await handleContextHistory(req,config,logContext(),"alpha/notes/v2/read_file")).status).toBe(400);
+ expect(selection).toBeUndefined();
+});
+
+function contextRequest(body: string, headers: HeadersInit = { authorization: "Bearer test" }, signal?: AbortSignal): Request {
+  return new Request("http://localhost/v1/alpha/notes/v2/read_file", { method: "POST", headers, body, signal });
+}
+
+test("missing admission credential fails before parsing or selecting an account", async () => {
+  const response = await handleContextHistory(contextRequest("not json", {}), config, logContext(), "alpha/notes/v2/read_file");
+  expect(response.status).toBe(401);
+  expect(selection).toBeUndefined();
+});
+
+test("malformed JSON and non-string or oversized session IDs fail before selection", async () => {
+  for (const body of ["not json", "null", JSON.stringify({ context: { session_id: 42 } }), JSON.stringify({ context: { session_id: "a".repeat(513) } })]) {
+    expect((await handleContextHistory(contextRequest(body), config, logContext(), "alpha/notes/v2/read_file")).status).toBe(400);
+    expect(selection).toBeUndefined();
+  }
+});
+
+test("existing session and child affinity headers are not overwritten", () => {
+  for (const entry of [{ "session-id": "existing" }, { "thread-id": "child" }, { "x-codex-parent-thread-id": "parent" }] as Record<string, string>[]) {
+    const headers = new Headers(entry);
+    const result = contextSelectionHeaders(headers, "root");
+    expect([...result]).toEqual([...headers]);
+    expect([...headers]).toEqual([...new Headers(entry)]);
+  }
+});
+
+test("network failures and client cancellation do not retry writes", async () => {
+  let calls = 0;
+  setFetch(async () => { calls++; throw new Error("test transport failure"); });
+  const body = JSON.stringify({ context: { session_id: "root" } });
+  expect((await handleContextHistory(contextRequest(body), config, logContext(), "alpha/notes/v2/write_file")).status).toBe(502);
+  const controller = new AbortController();
+  setFetch(async () => { calls++; controller.abort(); throw new Error("test canceled"); });
+  expect((await handleContextHistory(contextRequest(body, { authorization: "Bearer test" }, controller.signal), config, logContext(), "alpha/notes/v2/write_file")).status).toBe(499);
+  expect(calls).toBe(2);
+});
+
+test("unknown endpoints and methods are rejected before admission", async () => {
+  expect((await handleContextHistory(contextRequest("{}"), config, logContext(), "alpha/notes/v2/delete_file")).status).toBe(404);
+  expect((await handleContextHistory(new Request("http://localhost/v1/alpha/notes/v2/read_file"), config, logContext(), "alpha/notes/v2/read_file")).status).toBe(404);
+  expect(validated).toBe(0);
+  expect(selection).toBeUndefined();
+});
+
+test("credential materialization rechecks hardlocks and maps auth errors", async () => {
+  const body = JSON.stringify({ context: { session_id: "root" } });
+  let calls = 0;
+  setFetch(async () => { calls++; return new Response("unexpected"); });
+  for (const [error, status] of [[new errors.CodexAccountCooldownError(), 429], [new errors.CodexAuthContextError(), 401]] as const) {
+    materializationError = error;
+    const response = await handleContextHistory(contextRequest(body), config, logContext(), "alpha/notes/v2/read_file");
+    expect(response.status).toBe(status);
+    expect(materialized).toEqual({ config, modelId: "context_history" });
+  }
+  expect(calls).toBe(0);
+});
+
+
+const bearerAdmission: DataPlaneAdmission = { kind: "configured", keyId: "synthetic-key", source: "bearer" };
+const admissionHeaders = { authorization: "Bearer ocx_data_test_admission" };
+
+test("bearer-admitted context validates the body before selecting credentials", async () => {
+  const response = await handleContextHistory(contextRequest("{}", admissionHeaders), config, logContext(), "alpha/notes/v2/read_file", undefined, bearerAdmission);
+  expect(response.status).toBe(400);
+  expect(await response.text()).toContain("context.session_id");
+  expect(selection).toBeUndefined();
+});
+
+test("stored ownership remains fixed across current Direct and Pool settings", async () => {
+  let calls = 0;
+  setFetch(async (_url, init) => {
+    calls++;
+    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-only");
+    return new Response("{}");
+  });
+  for (const mode of ["direct", "pool"]) {
+    accountMode = mode;
+    const response = await handleContextHistory(contextRequest('{"context":{"session_id":"root"}}', admissionHeaders), config, logContext(), "alpha/notes/v2/read_file", undefined, bearerAdmission);
+    expect(response.status).toBe(200);
+    expect(selection?.mode).toBe("pool");
+    expect(selection?.options.accountId).toBe("test-account");
+    expect(selection?.options.admission).toEqual(bearerAdmission);
+    expect(selection?.options.substituteMainCredentialForDirect).toBe(true);
+    expect(materializationOptions?.admission).toEqual(bearerAdmission);
+    expect(materializationOptions?.substituteMainCredential).toBe(true);
+  }
+  expect(calls).toBe(2);
+});
+
+test("proxy credentials cannot escape materialization or bypass non-bearer rejection", async () => {
+  let calls = 0;
+  setFetch(async () => { calls++; return new Response("unexpected"); });
+  outgoingBearer = "ocx_data_test_admission";
+  const body = '{"context":{"session_id":"root"}}';
+  const response = await handleContextHistory(contextRequest(body, admissionHeaders), config, logContext(), "alpha/notes/v2/read_file", undefined, bearerAdmission);
+  expect(response.status).toBe(401);
+  expect(materialized).toBeDefined();
+  for (const admission of [undefined, { kind: "environment", source: "dedicated" } as const, { kind: "loopback", source: "loopback" } as const]) {
+    selection = undefined;
+    expect((await handleContextHistory(contextRequest(body, admissionHeaders), config, logContext(), "alpha/notes/v2/read_file", undefined, admission)).status).toBe(401);
+    expect(selection).toBeUndefined();
+  }
+  expect(calls).toBe(0);
+});
+
+
+test("missing usable stored credentials fail before upstream I/O in bearer mode", async () => {
+  let calls = 0;
+  setFetch(async () => { calls++; return new Response("unexpected"); });
+  for (const mode of ["direct", "pool"]) {
+    accountMode = mode;
+    materializationError = mode === "direct"
+      ? new errors.CodexMainSubstitutionUnavailableError()
+      : new errors.CodexPoolAuthenticationError();
+    const response = await handleContextHistory(contextRequest('{"context":{"session_id":"root"}}', admissionHeaders), config, logContext(), "alpha/notes/v2/read_file", undefined, bearerAdmission);
+    expect(response.status).toBe(401);
+    expect(materializationOptions?.substituteMainCredential).toBe(true);
+  }
+  expect(calls).toBe(0);
+});
+
+
+test("unknown, expired and conflicting owners fail before selecting or sending", async () => {
+  let calls = 0;
+  setFetch(async () => { calls++; return new Response("unexpected"); });
+  for (const state of ["unknown", "expired", "conflicting"]) {
+    clearContextSessionOwnersForTests();
+    if (state === "expired") seedOwner("root", "stored", "test-only", Date.now() - 25 * 60 * 60_000);
+    if (state === "conflicting") { seedOwner("root"); seedOwner("root", "stored", "other-account"); }
+    expect((await handleContextHistory(contextRequest('{"context":{"session_id":"root"}}'), config, logContext(), "alpha/notes/v2/read_file")).status).toBe(409);
+    expect(selection).toBeUndefined();
+  }
+  expect(calls).toBe(0);
+});
+
+test("stored token refresh is accepted but physical account replacement is refused", async () => {
+  let calls = 0;
+  setFetch(async () => { calls++; return new Response("{}"); });
+  outgoingBearer = "refreshed-test-token";
+  const body = '{"context":{"session_id":"root"}}';
+  expect((await handleContextHistory(contextRequest(body), config, logContext(), "alpha/notes/v2/read_file")).status).toBe(200);
+  outgoingAccount = "replacement-account";
+  expect((await handleContextHistory(contextRequest(body), config, logContext(), "alpha/notes/v2/read_file")).status).toBe(409);
+  expect(calls).toBe(1);
+});
+
+test("caller owner uses Direct request credentials and cannot authorize proxy-bearer substitution", async () => {
+  clearContextSessionOwnersForTests(); seedOwner("root", "caller");
+  let calls = 0;
+  setFetch(async () => { calls++; return new Response("{}"); });
+  const body = '{"context":{"session_id":"root"}}';
+  expect((await handleContextHistory(contextRequest(body), config, logContext(), "alpha/notes/v2/read_file")).status).toBe(200);
+  expect(selection?.mode).toBe("direct");
+  expect(selection?.options.requestScopedMainCredential).toBe(true);
+  expect(selection?.options.accountId).toBeUndefined();
+  expect(materializationOptions?.substituteMainCredential).toBe(false);
+  selection = undefined;
+  expect((await handleContextHistory(contextRequest(body, admissionHeaders), config, logContext(), "alpha/notes/v2/read_file", undefined, bearerAdmission)).status).toBe(409);
+  expect(selection).toBeUndefined(); expect(calls).toBe(1);
+});
+
+test("a context root conflicting with protocol headers is rejected without selection", async () => {
+  const response = await handleContextHistory(contextRequest('{"context":{"session_id":"root"}}', {
+    authorization: "Bearer test", "session-id": "another-root",
+  }), config, logContext(), "alpha/notes/v2/read_file");
+  expect(response.status).toBe(409); expect(selection).toBeUndefined();
+});
diff --git a/tests/server/server-live.test.ts b/tests/server/server-live.test.ts
index 16ee4c7946..bf096961b0 100644
--- a/tests/server/server-live.test.ts
+++ b/tests/server/server-live.test.ts
@@ -198,7 +198,7 @@ test("POST /v1/live rewrites ChatGPT multipart into backend realtime/calls JSON"
   }
 });

-test("POST /v1/live relays to an OpenAI API-key provider at /v1/live without AVAS", async () => {
+test.each(["/v1/live", "/backend-api/codex/live"])("POST %s relays to an OpenAI API-key provider at /v1/live without AVAS", async (path) => {
   const captured: CapturedRequest[] = [];
   const upstream = fakeLiveUpstream(captured, 201, "/v1/live/rtc_api");
   saveConfig({
@@ -217,7 +217,7 @@ test("POST /v1/live relays to an OpenAI API-key provider at /v1/live without AVA
   const server = startServer(0);
   try {
     const { body, contentType } = multipartLiveBody();
-    const response = await fetch(new URL("/v1/live", server.url), {
+    const response = await fetch(new URL(path, server.url), {
       method: "POST",
       headers: { "content-type": contentType },
       body,
diff --git a/tests/server/server-management-auth.test.ts b/tests/server/server-management-auth.test.ts
index aece9bc93a..22554b6cad 100644
--- a/tests/server/server-management-auth.test.ts
+++ b/tests/server/server-management-auth.test.ts
@@ -4,6 +4,7 @@ import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
 import { tmpdir } from "node:os";
 import { join } from "node:path";
 import { getConfigPath, saveConfig } from "../../src/config";
+import { clearContextSessionOwnersForTests } from "../../src/codex/context-owner";
 import { startServer } from "../../src/server";
 import { findAvailablePort } from "../../src/server/ports";
 import type { OcxConfig } from "../../src/types";
@@ -589,6 +590,71 @@ describe("management and data-plane credential separation", () => {
     }
   });

+  test("Codex backend aliases retain data-plane authentication and cannot enter management", async () => {
+    saveConfig(remoteConfig());
+    const server = startServer(0);
+    try {
+      for (const token of [undefined, "admin-secret", "data-secret"]) {
+        const headers: Record<string, string> = token ? { "x-opencodex-api-key": token } : {};
+        const models = await fetch(new URL("/backend-api/codex/models", server.url), { headers });
+        expect(models.status).toBe(token === "data-secret" ? 200 : 401);
+        const context = await fetch(new URL("/backend-api/codex/alpha/notes/v2/read_file", server.url), {
+          method: "POST", headers, body: "{}",
+        });
+        expect(context.status).toBe(token === "data-secret" ? 400 : 401);
+        const management = await fetch(new URL("/backend-api/codex/api/config", server.url), { headers });
+        expect(management.status).toBe(404);
+      }
+    } finally {
+      await server.stop(true);
+    }
+  });
+
+  test("context bearer admission reaches body validation without accepting foreign credentials", async () => {
+    saveConfig(remoteConfig());
+    const server = startServer(0);
+    try {
+      for (const prefix of ["/v1", "/backend-api/codex"]) {
+        for (const token of ["data-secret", "admin-secret", "foreign-secret"]) {
+          const response = await fetch(new URL(`${prefix}/alpha/notes/v2/read_file`, server.url), {
+            method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}",
+          });
+          expect(response.status).toBe(token === "data-secret" ? 400 : 401);
+          if (token === "data-secret") expect(await response.text()).toContain("context.session_id");
+        }
+      }
+    } finally {
+      await server.stop(true);
+    }
+  });
+
+  test("authenticated context without a successful model owner fails closed on both listener prefixes", async () => {
+    const cfg = remoteConfig();
+    cfg.providers.openai = { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool" };
+    saveConfig(cfg); clearContextSessionOwnersForTests();
+    const originalFetch = globalThis.fetch;
+    let upstreamCalls = 0;
+    globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
+      const url = new URL(input instanceof Request ? input.url : String(input));
+      if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "0.0.0.0") return originalFetch(input, init);
+      upstreamCalls++; throw new Error("unknown context owner must not reach upstream");
+    }, { preconnect: originalFetch.preconnect });
+    const server = startServer(0);
+    try {
+      for (const prefix of ["/v1", "/backend-api/codex"]) {
+        const response = await fetch(new URL(`${prefix}/alpha/notes/v2/read_file`, server.url), {
+          method: "POST", headers: { authorization: "Bearer data-secret" },
+          body: JSON.stringify({ context: { session_id: "unknown-root" } }),
+        });
+        expect(response.status).toBe(409);
+        expect(await response.text()).toContain("context_account_unavailable");
+      }
+      expect(upstreamCalls).toBe(0);
+    } finally {
+      await server.stop(true); globalThis.fetch = originalFetch; clearContextSessionOwnersForTests();
+    }
+  });
+
   test("data and management environment tokens authorize only their own planes", async () => {
     saveConfig(remoteConfig());
     const server = startServer(0);
```
