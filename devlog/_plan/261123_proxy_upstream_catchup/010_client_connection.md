# 010 — 클라이언트 연결 상태와 Claude 기본 실행 preview

**Gaps:** G-001, G-002
**Depends on:** none
**Size:** M

> 줄 번호와 줄 수는 OpenCodex `origin/dev` `9e0e298ef9` 기준이며, 줄 수는 ratchet의 `countLines`(`ocx:scripts/file-size-ratchet.ts:109`)로 센 값이다. 구현 단위를 열 때 현재 `dev`에서 다시 확인한다.

## Goal

Desktop/GUI의 한 화면에서 Codex와 Claude Code가 지금 어디로 가는지(OpenCodex proxy, native 로그인, Remote Link Home), 누가 설정을 소유하는지, 원하는 상태와 실제 파일이 왜 다른지, 되돌리면 어떤 키가 어떻게 바뀌는지를 본다. Claude Code의 기존 first-party 토글은 켜기 전에 `settings.json`에서 바뀔 키를 미리 보여 주고, 사용자가 명시적으로 등록한 Claude home마다 상태를 보여 준다.

## Why

- **G-001** — cc-switch는 앱별 카드에서 직접/라우팅 전환과 현재 상태를 보여 주고(`003` L3-1, `ccs:src-tauri/src/services/provider/mod.rs:7720–7804`), magpie는 `/api/drift`와 Keep/Reapply로 drift를 다룬다(`007` L7-5, `mgp:internal/gui/api.go:1438,1574`). OpenCodex에는 desired state, inject, restore 계약이 이미 있다(`ocx:src/codex/desired-state.ts:63`, `ocx:src/codex/inject/restore.ts:269`, `ocx:src/server/management/integration-routes.ts:830`). 빠진 것은 "왜 다른지"를 한곳에서 읽는 projection이다.
- **G-002** — magpie는 일반 실행에 효력이 있는 `settings.json` env/model을 편집한다(`mgp:internal/agent/claude.go:710,762`, `007` L7-1). OpenCodex에도 first-party 토글이 이미 있다: GUI `toggleFirstParty`(`ocx:gui/src/pages/ClaudeCode.tsx:293`), reconciler(`ocx:src/claude/first-party-settings.ts:46`), rollback 캡처(`ocx:src/server/management/agent-settings-routes.ts:1760`). 빠진 것은 적용 전 preview와 home별 상태다 (감사 r1 #1).

## Changes

| 경로 | 의도 | 내용 |
|---|---|---|
| `src/server/management/connection-status-routes.ts` | NEW | `GET /api/connections` 읽기 전용 projection |
| `src/codex/connection-projection.ts` | NEW | `desired-state.ts`·`inject/restore.ts` 판정을 drift 사유 코드로 변환. 쓰기 없음 |
| `src/claude/connection-projection.ts` | NEW | first-party settings, intercept, desktop binding 상태를 home별로 변환 |
| `src/claude/first-party-preview.ts` | NEW | `reconcileClaudeFirstPartySettings`와 같은 입력으로 dry-run해 바뀔 키와 변경 종류만 계산 |
| `src/server/management/agent-settings-routes.ts` | MODIFY | 1925줄. `PUT /api/claude-code` 처리부(`ocx:src/server/management/agent-settings-routes.ts:1760`) 옆에 preview 위임 한 줄. apply·rollback은 그대로 |
| `src/server/management/route-registry.ts` | MODIFY | `/api/claude-code` 항목(`ocx:src/server/management/route-registry.ts:149`) 옆에 `GET /api/claude-code/first-party/preview`, `GET /api/connections` 등록 (`mutates: false`) |
| `gui/src/pages/ClaudeCode.tsx` | MODIFY | `toggleFirstParty`(`ocx:gui/src/pages/ClaudeCode.tsx:293`) 앞에 preview 확인 단계와 home별 상태 배지 |
| `src/server/management/native-integration-routes.ts` | MODIFY | 1142줄. `handleCodexToggle`(`ocx:src/server/management/native-integration-routes.ts:404`) 결과 envelope에 projection 링크만 추가. 새 로직 없음 |
| `src/claude/auth-detect.ts` | MODIFY | `claudeConfigDir`(`ocx:src/claude/auth-detect.ts:99`)는 그대로 두고, 등록된 추가 home 목록을 읽는 helper를 옆에 둔다 |
| `gui/src/pages/integrations/ConnectionsPanel.tsx` | NEW | 클라이언트별 카드, drift 사유, 되돌리기 변경 종류 |
| `gui/src/i18n/*.ts` | MODIFY | 새 문구, 10개 locale 모두 (ratchet exempt) |

Home 선택 규칙 (감사 r2 #5): 기본 home은 현재 프로세스 환경의 `claudeConfigDir(env)`이다. 추가 home은 사용자가 설정 `claudeCode.extraConfigDirs`(새 config leaf)에 명시적으로 등록한 경로만 쓴다. OpenCodex가 디스크를 탐색해 home을 찾지 않는다. preview는 기존 토글이 실제로 쓰는 home, 즉 기본 home에 묶인다.

스케치:

```ts
type ConnectionView = {
  client: "codex" | "claude-code" | "claude-desktop";
  home?: string;                     // claude만: 등록된 config dir 경로
  desired: "proxy" | "native" | "remote-home" | "unset";
  observed: "proxy" | "native" | "remote-home" | "foreign" | "missing";
  owner: "opencodex" | "external" | "hub" | "none";
  driftReasons: Array<"external_owner" | "account_mode" | "quota_block" | "file_edited" | "pending_restart">;
  restorePreview?: Array<{ file: string; key: string; change: "add" | "update" | "remove" }>; // 값은 담지 않음
};
```

### Before / After

`ocx:gui/src/pages/ClaudeCode.tsx:293` — 지금은 토글이 바로 PUT한다.

```ts
// before
const toggleFirstParty = async () => {
  if (!state || firstPartyInFlight.current) return;
  firstPartyInFlight.current = true;
  setFirstPartyPending(true);
  setStatus("");
  const requested = !state.cliFirstParty;
  try {
    const response = await fetch(`${apiBase}/api/claude-code`, { method: "PUT", /* … */ });
```

```ts
// after (sketch)
const toggleFirstParty = async () => {
  if (!state || firstPartyInFlight.current) return;
  firstPartyInFlight.current = true;          // preview 전에 잠가 중복 클릭을 막는다
  setFirstPartyPending(true);
  setStatus("");
  const requested = !state.cliFirstParty;
  try {
    if (requested) {
      const preview = await fetchJson(`${apiBase}/api/claude-code/first-party/preview`); // 쓰기 없음
      if (!(await confirmChanges(preview.changes))) return;   // {file, key, change}만 표시. 취소해도 finally가 해제
    }
    const response = await fetch(`${apiBase}/api/claude-code`, { method: "PUT", /* 기존 그대로 */ });
    /* … */
  } finally {                                                  // 기존 finally(ClaudeCode.tsx:330): 잠금·pending 해제
    firstPartyInFlight.current = false;
    setFirstPartyPending(false);
  }
```

## Dependencies

없음. 020(가져온 설정의 적용 결과)과 030(writer/journal 재사용)이 이 단계를 쓴다.

## Acceptance

- Codex native 토글이 외부 소유 때문에 거절된 상태에서 Connections 화면이 `external_owner` 사유와 소유 파일 경로를 보여 준다.
- Claude first-party 토글을 켜기 전에 바뀔 `settings.json` 키와 변경 종류(add/update/remove)가 보이고 값은 보이지 않는다. preview 호출 전후로 파일 바이트가 같다.
- preview 요청이 네트워크·서버 오류로 실패하면 토글 잠금과 pending 상태가 풀리고 오류 문구가 보이며, PUT은 호출되지 않는다.
- `claudeCode.extraConfigDirs`에 두 번째 home을 등록하면 각 home의 상태가 따로 보인다. 등록하지 않은 경로는 나타나지 않는다.
- 적용·rollback 결과는 기존 테스트 그대로 통과한다.

## Verification

- 신규 `tests/server/connection-status-routes.test.ts`, `tests/claude-integration/claude-first-party-preview.test.ts` (`scripts/test-layout/layout.json`과 `tests/fixtures/test-layout-expected*.json` shard 등록)
- 기존 회귀: `tests/codex-integration/codex-inject-*.test.ts`, `tests/claude-integration/`의 first-party settings 테스트
- `bun run typecheck`, `bun run test:changed`, `bun run structure:check`, `bun run lint:gui`; GUI 변경이라 PR에 스크린샷

## Risks

- **File-size ratchet:** 캡에 없는 파일은 2000줄 이상이면 실패하고(`NEW_OVERSIZED`), 캡 파일은 캡을 넘으면 실패한다(`tests/fixtures/file-size-baseline.json`). `agent-settings-routes.ts`는 1925줄로 여유 74줄이다. 로직은 sibling 파일에 둔다.
- **Lab 경계:** `tests/lab/core-lab-boundary.test.ts`의 보호 목록(`ocx:tests/lab/core-lab-boundary.test.ts:23`: `src/router.ts`, `src/server/lifecycle.ts`, `src/server/responses/core.ts`, `src/server/management-api.ts`)에서 `src/lab/`으로 가는 import가 직접이든 간접이든 생기면 안 된다. `route-registry.ts`는 `management-api.ts`가 읽으므로 새 route 모듈은 namespace별 지연 로드 규칙을 따른다.
- **Privacy:** projection과 preview는 경로·키 이름·변경 종류만 돌려준다. 값, email, 토큰은 없다.
- **중복 구현 금지:** first-party apply/rollback을 새로 만들지 않는다.

## Non-goals

- magpie식 자동 provider 전환.
- 다른 클라이언트(Gemini CLI, Zed)는 030. 계정 자격 증명 이동은 020(G-004).
