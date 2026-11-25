# 020 — 이주·온보딩: 발견, 일괄 가져오기, 링크, 속도 측정, 팀 접속

**Gaps:** G-003, G-004, G-005, G-006, G-007
**Depends on:** 010
**Size:** L

> 줄 번호와 줄 수는 OpenCodex `origin/dev` `9e0e298ef9` 기준이며, 줄 수는 ratchet의 `countLines`(`ocx:scripts/file-size-ratchet.ts:109`)로 센 값이다. 구현 단위를 열 때 현재 `dev`에서 다시 확인한다.

## Goal

다른 도구에서 넘어오는 사용자가 키를 다시 입력하지 않고 기존 공급자 설정을 발견·검토·가져오고, Codex/Claude 계정 파일을 일괄 가져온다. 공유받은 링크로 공급자 preset이나 Hub 접속을 미리 보고 확인한 뒤에만 기존 흐름을 시작한다. 공급자 후보 URL의 응답 시간을 같은 조건에서 비교한다.

## Why

- **G-003** — magpie는 Providers 화면에서 CC Switch·Claude Code·Codex 설정 후보를 발견한다(`mgp:internal/gui/importapps.go:30,48,70`). OpenCodex는 파일을 명시하는 CLI만 있다(`ocx:src/cli/provider-cc-switch-import.ts:81`, `ocx:src/providers/cc-switch-import.ts:747`) (`007` L7-3).
- **G-004** — magpie `ImportLogins`는 Sub2API·CPA·CodexBar·claude-swap 형식을 해석한다(`mgp:internal/provider/login_import.go:101,129,182`). OpenCodex registry는 Antigravity 형식만 받는다(`ocx:src/oauth/account-import/registry.ts:12`) (`007` L7-2).
- **G-005** — magpie(`mgp:build/darwin/Info.plist:21`, `mgp:internal/gui/importlink.go:30`)와 cc-switch(`ccs:src-tauri/src/deeplink/parser.rs:15–74`)는 OS 링크로 preset을 연다. OpenCodex에는 OS scheme 등록이 없다 (`008` L8-2 absence receipt).
- **G-006** — cc-switch `test_api_endpoints`는 URL 배열을 warm-up 후 병렬 timed GET으로 비교한다(`ccs:src-tauri/src/services/speedtest.rs:26–122`). OpenCodex probe는 단일 공급자 연결/모델 호출이다 (`003` L3-3).
- **G-007** — magpie는 LAN 키·원격 모델·접속 안내를 한 흐름에 둔다(`mgp:internal/gui/join.go:16`). OpenCodex Hub 초대는 `ocx connect <dataUrl> --management-url … --pairing-code-stdin` 명령을 만든다(`ocx:src/cli/hub.ts:236`). G-007은 Hub pairing 링크와 원격 카탈로그 준비 표시로 좁혔다. cc-switch L3-2의 SSH Link(Home/Child) 부분은 alias·confirmed host가 필요한 다른 흐름이라(`ocx:src/server/management/link-routes.ts:165`) G-060으로 보류했다 (감사 r3 #4).

## Changes

| 경로 | 의도 | 내용 |
|---|---|---|
| `src/providers/import-discovery/` | NEW | source adapter `{id, detect(), readKeyless(), fingerprint}`. 1차: cc-switch(기존 importer 재사용), Claude Code settings, Codex config.toml |
| `src/server/management/provider-import-routes.ts` | NEW | `GET /api/provider-import/candidates`(metadata만), `POST …/preview`, `POST …/apply` |
| `src/server/management/provider-routes.ts` | MODIFY 금지 | 1989줄, 여유 10줄. 새 route는 위 sibling에만 둔다 (`ocx:src/server/management/provider-routes.ts:1133`의 저장 경로를 호출만 함) |
| `src/oauth/account-import/types.ts` | MODIFY | `AccountImportAdapter`(`ocx:src/oauth/account-import/types.ts:89`)는 provider가 Antigravity 리터럴이고 Cockpit 레코드만 받는다. provider·format을 union으로 넓히고 adapter가 `parseDocument(raw)`를 직접 갖게 한다 |
| `src/oauth/account-import/service.ts` | MODIFY | 서비스가 항상 Cockpit 문서를 파싱하는 단계(`ocx:src/oauth/account-import/service.ts:36`)를 adapter의 `parseDocument` 호출로 바꾼다. provider/format 판정이 파싱보다 먼저인 순서는 유지 |
| `src/oauth/account-import/registry.ts` | MODIFY | 등록 표(`ocx:src/oauth/account-import/registry.ts:12`)를 `Map`으로 바꾸고 `codex-auth-json`, `claude-credentials` adapter 등록. 결과 receipt `{imported, skipped:{reason}, duplicates}` |
| `src/oauth/account-import/codex-auth-json-adapter.ts` | NEW | Codex `auth.json` 파싱, 저장은 Codex 계정 저장소 `saveCodexAccountCredential`(`ocx:src/codex/account-store.ts:248`) |
| `src/oauth/account-import/claude-credentials-adapter.ts` | NEW | Claude credentials 파싱, 저장은 OAuth 저장소 `saveAccountCredential`(`ocx:src/oauth/store.ts:1420`) |
| `src/cli/account-extended.ts` | MODIFY | 기존 import 진입(`ocx:src/cli/account-extended.ts:638`)에 `--format <id> <files…>` 일괄 입력 |
| `src/links/preset-link.ts` | NEW | 두 payload를 분리 파싱 (아래 스케치) |
| `desktop/src-tauri/src/lib.rs` | MODIFY | plugin 체인(`ocx:desktop/src-tauri/src/lib.rs:310`)에 deep-link plugin 등록, 이벤트를 GUI review dialog로 전달. `single_instance` 콜백(`:310`)이 두 번째 실행의 URL을 넘기도록 확장 |
| `desktop/src-tauri/tauri.conf.json` | MODIFY | 앱 identifier(`ocx:desktop/src-tauri/tauri.conf.json:5`) 아래에 URL scheme 선언 |
| `gui/src/pages/Providers.tsx` | MODIFY | 컴포넌트 진입(`ocx:gui/src/pages/Providers.tsx:227`)에서 sibling `ProviderImportPanel.tsx`, `PresetLinkDialog.tsx`, `EndpointSpeedTest.tsx`를 렌더만 |
| `src/server/management/endpoint-speed-routes.ts` | NEW | `POST /api/providers/speed-test` URL 배열, 동시성 상한·timeout·warm-up GET. 모델 호출 없음 |
| `src/cli/hub.ts` | MODIFY | `runInvite`(`ocx:src/cli/hub.ts:239`)가 명령 문자열과 함께 `hub-invite` 링크도 출력. 기존 명령 출력은 유지 |

링크 payload (감사 r2 #1에서 분리):

```ts
// provider preset: 공급자 저장 흐름(provider-routes 저장 경로)으로 이어진다.
type ProviderPresetLinkV1 = { v: 1; kind: "provider-preset"; name: string; baseUrl: string;
  protocol: "openai-chat" | "openai-responses" | "anthropic"; models?: string[] };  // apiKey 없음

// Hub 초대: 기존 Hub pairing(ocx connect, hub.ts:236)으로 이어진다. SSH Link join(/api/link/join, alias 필요)과는 다른 흐름이다.
type HubInviteLinkV1 = { v: 1; kind: "hub-invite"; dataUrl: string; managementUrl: string; clients?: string[] };
// pairing code는 링크에 넣지 않는다. dialog에서 사용자가 붙여 넣는다.
```

### Before / After

`ocx:src/oauth/account-import/registry.ts:12` — 지금은 provider·format 한 쌍만 받는다.

```ts
// before
const antigravityAdapter = createAntigravityAccountImportAdapter();
export function resolveAccountImportAdapter(provider: string, format: string): AccountImportRegistryResult {
  if (provider !== ACCOUNT_IMPORT_PROVIDER) return { ok: false, code: "unsupported_provider" };
  if (format !== ACCOUNT_IMPORT_FORMAT) return { ok: false, code: "unsupported_format" };
  return { ok: true, adapter: antigravityAdapter };
}
```

```ts
// after (sketch)
const ADAPTERS = new Map<string, AccountImportAdapter>([   // key: `${provider}\u0000${format}`
  [key(ACCOUNT_IMPORT_PROVIDER, ACCOUNT_IMPORT_FORMAT), createAntigravityAccountImportAdapter()],
  [key("codex", "codex-auth-json"), createCodexAuthJsonImportAdapter()],         // → saveCodexAccountCredential
  [key("anthropic", "claude-credentials"), createClaudeCredentialsImportAdapter()], // → saveAccountCredential
]);
export function resolveAccountImportAdapter(provider: string, format: string): AccountImportRegistryResult {
  const adapter = ADAPTERS.get(key(provider, format));   // Map이라 prototype 키(`__proto__` 등)가 섞이지 않는다
  if (adapter) return { ok: true, adapter };
  return [...ADAPTERS.values()].some(a => a.provider === provider)
    ? { ok: false, code: "unsupported_format" } : { ok: false, code: "unsupported_provider" };
}
// service.ts:36: parseCockpitAccountDocument(request.document) → resolved.adapter.parseDocument(request.document)
```

## Dependencies

010. 가져오기 결과는 Connections 화면에서 적용 상태를 확인한다.

## Acceptance

- CC Switch가 설치된 홈에서 Providers 화면이 후보를 보여 주고, 고른 항목만 preview 후 적용된다. 키 값은 브라우저로 전송되지 않는다.
- Codex `auth.json` 여러 개를 `ocx account import --format codex-auth-json`으로 넣으면 receipt가 중복·실패 사유를 항목별로 보여 준다.
- fixture `provider-preset` 링크를 열면 review dialog가 뜨고 확인 전에는 저장이 없다.
- fixture `hub-invite` 링크를 열면 data/management origin과 선택 클라이언트가 먼저 보이고, 사용자가 pairing code를 넣고 확인한 뒤에만 기존 Hub pairing이 시작된다. `/api/link/join`은 호출되지 않는다.
- pairing이 끝나면 마법사가 원격 카탈로그 상태(사용 가능한 모델 수, 준비 여부)를 보여 준다. 카탈로그가 비어 있으면 그 이유를 보여 준다.
- 속도 측정은 usage ledger 행을 만들지 않는다.

## Verification

- 신규 `tests/providers/import-discovery.test.ts`, `tests/server/account-import-codex.test.ts`, `tests/providers/preset-link.test.ts`, `tests/server/endpoint-speed-routes.test.ts`
- 기존 회귀: `tests/providers/cc-switch-import.test.ts`, `tests/cli/cli-provider-cc-switch-import.test.ts`, `tests/server/account-import*.test.ts`
- `bun run typecheck`, `bun run test:changed`, `bun run structure:check`, `bun run lint:gui`, `bun run privacy:scan`
- Tauri 변경은 import graph로 보이지 않으므로 PR에 `ci:full`

## Risks

- **File-size ratchet:** 캡에 없는 파일은 2000줄 이상이면 실패하고(`NEW_OVERSIZED`), 캡 파일은 캡을 넘으면 실패한다(`tests/fixtures/file-size-baseline.json`). `provider-routes.ts` 1989줄(여유 10), `oauth-account-routes.ts` 1567줄 — 둘 다 늘리지 않는다.
- **Lab 경계:** `tests/lab/core-lab-boundary.test.ts`의 보호 목록(`ocx:tests/lab/core-lab-boundary.test.ts:23`: `src/router.ts`, `src/server/lifecycle.ts`, `src/server/responses/core.ts`, `src/server/management-api.ts`)에서 `src/lab/`으로 가는 import가 직접이든 간접이든 생기면 안 된다.
- **Consent:** 계정 자격 증명 일괄 가져오기는 명시 입력 파일만 받는다. 자동 탐색 대상은 키 없는 공급자 설정뿐이다.
- **Privacy:** receipt와 로그에 email·token을 남기지 않는다. 링크에 키·pairing code를 넣지 않는다.

## Non-goals

- OpenCode auth 플러그인 자격 증명, MCP/Skill 링크 (G-052 비채택), 클라우드 동기화 (G-040 보류).
