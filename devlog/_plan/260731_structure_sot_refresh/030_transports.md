# 030 — WP3: `04_transports-and-sidecars.md`

선행: WP0만. A 감사 블로커 14에 따라 WP2 선행 주장을 철회했다(사이드카 설정 키를 여기서
새로 정의하지 않는다).

## 편집 대상

- MODIFY `structure/04_transports-and-sidecars.md`

## D1. Claude Desktop 절 역전 (S1 — 최우선)

현재 절(`:115-129`)은 `Claude-3p`를 "폐기된 하드코딩 경로"로 서술하고 Desktop이
`Claude/configLibrary`를 읽는다고 단언한다. 코드는 반대다.

`src/claude/desktop-3p-paths.ts:5-27`은 Desktop 번들(app.asar, v1.18286.0)에서 이식한 로직을 남겼다:
```
const Bu = "-3p", zW = "Claude", ND = `${zW}${Bu}`;
function GE(){
  if (process.env.CLAUDE_USER_DATA_DIR) return app.getPath("userData");
  if (process.platform === "win32" && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, ND);
  const t = app.getPath("userData");
  return t.endsWith(Bu) ? t : `${t}${Bu}`;
}
function mD(){ return join(GE(), "configLibrary") }
```
`:65`은 `"Claude-3p"`가 한 개의 경로 구성요소임을 명시하고, `:78`이 `configLibrary`를 붙인다.
즉 `Claude-3p/configLibrary`가 Desktop의 정상 기본값이고, #539의 실제 원인은 win32와
`CLAUDE_USER_DATA_DIR` 분기 누락이었다.

절 본문 교체:
```
The Desktop profile writer and the management status probe share
`resolveDesktop3pConfigLibraryPath`. The resolver reproduces Desktop's own rule rather than a
guess: an explicit `CLAUDE_USER_DATA_DIR` (or the opencodex override) wins; on Windows
`%LOCALAPPDATA%\Claude-3p` wins; otherwise the Electron user-data path gains a `-3p` suffix if it
does not already have one. `configLibrary` is appended to that root.

`Claude-3p` is Desktop's real directory name, assembled at runtime from `"Claude" + "-3p"`, which
is why searching the app bundle for the literal string finds nothing. It is not a legacy path to
migrate away from. Resolution stays a pure function of (env, platform, home) so the Windows branch
is testable on any host: stubbing `process.platform` does not propagate to `os.platform()` under
Bun.
```

Decision Log 블록은 정정한다. 현재 블록은 "`Claude-3p` 폴백이 잘못이었다"는 전제 위에 서 있어서
본문만 고치면 결정 기록이 본문과 모순된다.
```
[Decision Log]
- 목적과 의도: 생성된 Claude Desktop 프로필이 설치된 Desktop이 실제로 읽는 디렉터리에 떨어지고, 대시보드 상태가 그 쓰기 대상과 일치하게 한다.
- 기존 구현 및 제약 조건: 두 호출자가 macOS 전용 경로 계산을 각자 복제했고, Desktop이 실제로 쓰는 `CLAUDE_USER_DATA_DIR`와 Windows `LOCALAPPDATA` 분기가 없었다(#539). 사용자가 프로필 루트를 직접 지정하는 경우도 있다.
- 검토한 주요 대안: `-3p` 접미사를 "구버전 잔재"로 보고 제거; 두 디렉터리를 모두 스캔; 레거시 파일을 자동 이전; 크로스플랫폼 해석기를 한 곳에 둔다.
- 선택한 방식: Desktop 번들의 해석 규칙을 그대로 이식한 override 인지 해석기를 한 곳에 두고, 쓰기와 상태 조회가 같은 함수를 쓴다.
- 다른 대안 대신 이 방식을 선택한 이유: `-3p`는 Desktop의 정상 동작이므로 제거는 회귀였다. 해석기를 한 곳에 두면 두 호출자의 드리프트가 불가능해지고, 파괴적 이전 없이 상태와 쓰기 대상이 일치한다.
- 장점, 단점 및 영향: 지원 플랫폼 전부에서 apply 결과가 Desktop에 보인다. 비표준 레이아웃 사용자는 문서화된 override를 써야 하고, 해석기는 Desktop 번들 규칙 변경을 따라가야 한다.
```

## D2. Sidecars 절 이중 백엔드 (S2)

`src/web-search/index.ts:12-14`와 `src/vision/index.ts:14-16`에 Anthropic 기본 모델
(`claude-sonnet-5`)이 있고, vision은 쓸 수 있는 Anthropic OAuth 프로바이더가 있으면 그쪽을 고른다.
문서가 적은 OpenAI 기본값(`gpt-5.6-luna`, `gpt-5.4-mini`) 자체는 맞다.

백엔드 선택 규칙은 두 사이드카가 **다르다**. A 감사 블로커 4가 지적한 대로 이를 하나로 묶으면
새 오류가 된다. `src/web-search/index.ts:97-105`의 `resolveSidecarBackend`는 명시 설정만
anthropic을 고르고 미설정은 항상 openai다. 코드 주석이 이유를 남겼다: 자격증명 기반 자동선택은
`gpt-5.6-luna` 같은 모델을 Anthropic API로 보내는 회귀를 만들었다.

절 본문 교체:
```
Web search and vision sidecars run only when the main request needs that capability and a usable
sidecar authority exists. Both have two possible backends, but they select differently:

| Sidecar | Backend selection | Default model | Activation |
| --- | --- | --- | --- |
| `web-search/` | Explicit configuration only: unset always resolves to the OpenAI forward path. Anthropic is never auto-selected from credential availability — doing so once sent OpenAI model ids to the Anthropic API. | `gpt-5.6-luna` (OpenAI), `claude-sonnet-5` (Anthropic) | Hosted `web_search` requested by a non-passthrough routed model. |
| `vision/` | Explicit configuration wins for both backends. Only an unset backend auto-selects: Anthropic when a usable Anthropic OAuth provider exists, otherwise the OpenAI forward authority. An explicitly selected backend whose authority is unavailable produces no plan rather than falling back. | `claude-sonnet-5` (Anthropic), `gpt-5.4-mini` (OpenAI) | Input contains images for a model listed in `noVisionModels`. |

The asymmetry is in the unset case only: vision may describe an image with whichever model can see
it, while a hosted search tool is tied to a provider-specific tool contract, so search never infers
Anthropic from credentials alone.

For the OpenAI path there is one deterministic `openai` sidecar candidate and its current account
mode owns credential selection; API-key OpenAI is not a ChatGPT forward sidecar candidate.

Sidecar failures must degrade to text markers or skipped capability, not abort the main request.
```

## D3. Standalone Images 폴백 (I8)

`:62` 절에 Antigravity 폴백 추가. `src/server/images.ts:95-159,405-423`은 OpenAI 자격증명이
없거나 깨졌을 때 `generations`에 한해 Google Antigravity를 시도한다.
```
When OpenAI credentials are unavailable or rejected, `generations` (not `edits`) may fall back to
Google Antigravity. The fallback is credential-driven: it exists so an image request fails with a
real upstream answer rather than a local credential error, and it never applies when the caller
selected an explicit keyed custom provider.
```

## D4. 미기재 트랜스포트 절 (§B)

`## Sidecars` 앞에 새 절 하나로 묶는다. 절을 14개 신설하지 않는 이유: 이 문서는 이미 35KB이고,
각 항목의 불변 조건은 한두 줄이다. 표 한 개가 절 14개보다 오래 산다.
```
## Transport inventory

Sections above cover the transports with load-bearing invariants. The rest of the transport surface
is listed here so a maintainer can find the owner without grepping:

| Transport | Owner | Invariant worth knowing |
| --- | --- | --- |
| Azure OpenAI Responses | `src/adapters/azure.ts` | Deployment-shaped URLs on top of the Responses contract. |
| Google / Vertex / Antigravity | `src/adapters/google.ts`, `src/adapters/google-http.ts`, `src/adapters/google-wire-compiler.ts`, `src/adapters/google-tool-schema.ts`, `src/adapters/google-truncation.ts`, `src/adapters/google-errors.ts`, `src/adapters/google-antigravity-wire.ts`, `src/adapters/google-antigravity-replay.ts` | Google keeps its own `fetchResponse`, so it owns its retry policy while reusing the shared abort/deadline helpers, wire-body repair, and upstream error normalization. |
| Mimo Free | `src/adapters/mimo-free.ts` | Client identity and JWT handling are transport-local; the per-install client id lives in the opencodex state root. |
| Anthropic image ingress | `src/adapters/anthropic-image-guard.ts`, `src/adapters/anthropic-image-normalize.ts` | Oversized or unsupported images are normalized or rejected before reaching upstream. |
| Adapter execution support | `src/adapters/run-turn-queue.ts`, `src/adapters/tool-catalog-nudge.ts`, `src/adapters/identity.ts`, `src/adapters/image.ts`, `src/adapters/upstream-http-error.ts` | Shared machinery: turn ordering, tool-catalog nudging, client fingerprinting, image conversion, upstream error normalization. |
| Cursor (beyond the sections above) | `src/adapters/cursor/live-transport.ts`, `src/adapters/cursor/transport-retry.ts`, `src/adapters/cursor/mcp-manager.ts`, `src/adapters/cursor/thread-continuity.ts` | Thread continuity is the point: a retry must not start a new Cursor thread. |
| Claude Messages | `src/server/claude-messages.ts` | Routed translation, a native Anthropic passthrough branch, and `count_tokens`. |
| Chat Completions inbound | `src/server/chat-completions.ts`, `src/chat/` | Inbound translation onto the same routing pipeline. |
| Hosted search relay | `src/server/search.ts` | Direct relay; distinct from the web-search sidecar loop. |
| Image/video generation loop | `src/images/loop.ts`, `src/images/plan.ts`, `src/images/fulfill.ts`, `src/images/xai-client.ts`, `src/images/xai-video-client.ts`, `src/images/artifacts.ts` | A provider-returned image URL is downloaded into a local artifact once, then served locally; warnings stay URL-free because provider CDN URLs may embed credentials. |
| GitHub Copilot | `src/providers/github-copilot-transport.ts` | Transport selection is registry-driven. |
| API-key pools | `src/providers/key-failover.ts` | A 429 rotates the active key and records a cooldown; routing stays single-key. |
| Alibaba regions | `src/providers/alibaba-region-backup.ts`, `src/providers/alibaba-region-migration.ts`, `src/providers/alibaba-region-startup.ts` | Region migration backs up before rewriting and is idempotent across restarts. |
| Discovery and quota | `src/providers/model-discovery.ts`, `src/providers/quota.ts` | Discovery rejects a response over 4 MiB or past 2,000 raw rows before caching it. |
```

## 검증

```bash
rg -n "CLAUDE_USER_DATA_DIR|LOCALAPPDATA|configLibrary" src/claude/desktop-3p-paths.ts
rg -n "DEFAULT_ANTHROPIC_SIDECAR_MODEL|DEFAULT_SIDECAR_MODEL" src/web-search/index.ts
rg -n "DEFAULT_ANTHROPIC_VISION_MODEL|DEFAULT_VISION_MODEL" src/vision/index.ts
rg -n "antigravity" src/server/images.ts | head
bun x tsc --noEmit
bun test tests/claude-desktop*.test.ts tests/web-search*.test.ts tests/vision*.test.ts
bun run privacy:scan && git diff --check
```

## 수용 기준

- Claude Desktop 절과 그 Decision Log가 코드의 해석 규칙과 일치한다(역전 완료).
- 사이드카 표가 백엔드 2종과 각 기본 모델을 담는다.
- 이미지 폴백 조건(`generations` 한정, 자격증명 기반)이 명시된다.
- Transport inventory 표의 모든 경로가 존재한다.
- 게이트 통과, 커밋 1개.

## 서술 계약 자기점검

살아남은 절대어·범위 주장 전부와 그 근거(A 감사 R4 블로커 4: 자기점검은 빠짐이 없어야 한다):

| 문안 | 근거 |
|------|------|
| `never auto-selected from credential availability` (web-search) | `src/web-search/index.ts:97-105` — `resolveSidecarBackend`는 명시값만 anthropic으로 해석하고, 주석이 자동선택 회귀를 기록한다 |
| `run only when the main request needs that capability and a usable sidecar authority exists` | `src/web-search/index.ts:148-186`, `src/vision/index.ts:164-182` — 두 계획 함수 모두 권한/필요 조건 불충족 시 계획을 만들지 않는다 |
| `Sidecar failures must degrade to text markers or skipped capability, not abort the main request` | 기존 문서 문장을 유지한 것이며 사이드카 호출부가 실패를 흡수한다. 이 문장은 요구사항 서술이므로 "현재 그렇다"가 아니라 "그래야 한다"로 읽힌다 |
| `explicit backend wins / unset auto-selects / explicit without authority produces no plan` (vision) | `src/vision/index.ts:113-119`, `:164-182` |
| `never applies when the caller selected an explicit keyed custom provider` (images) | `src/server/images.ts:95-159`의 분기 순서 |
| `download once, then served locally` | `src/images/fulfill.ts:74-85` |

- 경로: transport 인벤토리 표의 모든 항목이 저장소 루트 기준 완전 경로.
- 라벨: 기본 모델 문자열 4개는 두 사이드카 소스에서 그대로 옮겼다.
