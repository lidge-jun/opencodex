# 020 — 배치 A: restack 6건 + free-directory 1건

HEAD에 결함이 남아 있고, 기여자 구현이 지금 트리와 맞고, 패치 없이는 실패하는
회귀 테스트를 들고 오는 건들이다. 전부 76커밋 이상 뒤처져 있어 재기준이 필요하다.

머지 방식: 기여자 커밋을 `git cherry-pick`으로 브랜치에 올린다. 커밋이 여러 개면
스쿼시해서 `type(scope): subject (#issue)` 한 줄로 접고, 원저자를 `--author`로
유지한다. 우리가 수정을 얹은 건은 원저자를 author로 두고 우리를
`Co-authored-by`에 넣는다(`275345a61` 관행).

## 감사 반영 (2026-07-31)

독립 리뷰어가 두 건을 잡아냈다. 둘 다 배치 구성을 바꾼다.

1. **#744를 배치 A에서 뺀다.** OAuth 재조정·설정 영속화·토큰 해석 순서 변경이
   들어 있어(`59d95c0e4`, `39543a3c0`) 보안 리뷰 대상이다. `040`으로 옮겼다.
   아래 4번 항목은 기록으로 남겨둔다 — import 충돌 해소 방법은 리뷰 통과 후에도
   그대로 유효하다.
2. **#781은 커밋을 쪼갠다.** 토픽 커밋이 Anthropic 수정과 `/api/logs` 테스트
   봉투 헬퍼를 같이 들고 있다. 아래 6번에 상세.

## 랜딩 순서

충돌 표면이 겹치지 않는 것부터. `#772`와 `#783`이 `src/codex/catalog.ts` facade에서
겹치므로 연달아 처리한다.

1. #774 — `src/cli/init.ts` 단독
2. #768 — `src/oauth/kiro-*.ts` 단독
3. #772 — `src/server/management/model-routes.ts` + catalog facade
4. #783 — catalog metadata + catalog facade
5. #781 — `src/adapters/anthropic.ts` 단독 (테스트 분리 후)
6. #769 — `src/providers/free-directory.ts` 단독

(#744는 보류로 이동)

## 1. #774 — `ocx init`이 파이프 stdin EOF에서 100% CPU (#754 FULL)

지금: `src/cli/init.ts:9`의 `readline.question()`이 EOF에서 영원히 안 풀린다.
콜백이 안 불리고 이벤트 루프가 계속 돈다.

PR: `refs/prs/774:src/cli/init.ts:9-32`가 EOF를 reject로 바꾸고 `:213-223`이 그걸
0이 아닌 종료 코드로 매핑한다.

테스트: `tests/init-eof.test.ts:12`. stdin을 닫고 8초 안에 exit 1을 요구하며,
stderr 문구와 **config 파일이 쓰이지 않았음**까지 확인한다. 패치 없이 실패한다
(무한 대기 → 타임아웃).

수정 없음. cherry-pick 후 `bun test tests/init-eof.test.ts`.

## 2. #768 — Kiro Windows 실행파일을 PATH 없이 해석

지금: `src/oauth/kiro.ts:77`과 `:131`이 맨 `kiro-cli`를 spawn한다. Windows에서
PATH에 없으면 로그인과 롤백이 둘 다 실패한다.

PR: `refs/prs/768:src/oauth/kiro-credentials.ts:183`이 `PATH`/`Path` 두 케이싱,
`%LOCALAPPDATA%`, Program Files를 훑는다.

**우리가 얹을 수정**: 후보를 `existsSync`만으로 받아들인다
(`kiro-credentials.ts:183-211`). 디렉터리가 `kiro-cli`라는 이름이면 그대로
실행 대상이 된다. `statSync().isFile()` 확인을 추가하고, Windows에서는
`.exe`/`.cmd`/`.bat` 확장자를 요구한다. 그리고 환경변수 파싱 자체를 구동하는
테스트가 없다 — 테스트가 `pathEntries`를 직접 주입한다
(`tests/kiro-windows-cli-executable-path.test.ts:12-23`). `PATH` 대소문자 두 벌을
실제로 읽는 케이스를 추가한다.

보안: PATH 하이재킹 경계를 넓히지 않는다. 지금도 맨 이름으로 PATH를 탄다.

## 3. #772 — `GET /api/catalog` (#709 FULL)

지금: `src/codex/catalog/parsing.ts:186`에 리더는 있는데 라우트가 없다. 원격
클라이언트가 생성된 카탈로그를 못 읽는다.

PR: `refs/prs/772:src/server/management/model-routes.ts:67`. 인증된 라우트이고,
파일이 없으면 404.

테스트: `tests/api-catalog-route.test.ts:40` — 디스크 바이트를 그대로 돌려주고
런타임 프로브를 돌리지 않는다는 것, 그리고 404 경로.

수정 없음.

## 4. #783 — Claude Desktop 모델 목록에서 `native/*` 제외 (#767 FULL)

지금: `src/server/management/shared.ts:224`가 native 행을 전부 내보낸다.

PR: `refs/prs/783:src/codex/catalog/metadata.ts:126`에 `claudeCode.desktopNativeModels`
플래그를 두고 Desktop discovery(`src/server/index.ts:426`)와 프로필 export
(`shared.ts:215`)에 일관되게 적용한다. Grok native는 유지한다.

테스트: `tests/claude-desktop-cli.test.ts:73`이 show/export 출력에서 `native/*`를
찾아 실패한다.

**충돌**: #772와 같이 `src/codex/catalog.ts` facade를 건드린다. `readCatalog`와
`desktopVisibleNativeSlugs` export를 **둘 다** 살린다.

## (보류) #744 — Antigravity 카탈로그 static 고정 (#723 FULL)

**보안 리뷰 대기.** 아래 분석은 리뷰 통과 후 그대로 쓴다.

지금: `src/providers/registry.ts:799`에 static 플래그가 없어서 Antigravity가
지원하지 않는 `GET /models`를 프로브하고 영구히 discovery 실패를 보고한다.
토큰 해석이 static 반환보다 먼저 일어난다
(`src/codex/catalog/provider-fetch.ts:382-384`, `:451-453`).

**충돌 — 기계적**: `tests/provider-connection-test.test.ts:5-8` import 블록.
HEAD가 `withRegistryDiscovery` 헬퍼를 추가했고 PR이 그 줄을 지우면서
`OAUTH_PROVIDERS`와 `PROVIDER_REGISTRY`를 넣는다. 해소: **셋 다 유지**한다.

```
 import { saveConfig } from "../src/config";
+import { OAUTH_PROVIDERS } from "../src/oauth";
+import { PROVIDER_REGISTRY } from "../src/providers/registry";
 import type { OcxConfig } from "../src/types";
 import { withRegistryDiscovery } from "./helpers/provider-registry-discovery";
```

테스트: 카탈로그, connection probe, 마이그레이션, sparse GUI PATCH, single-flight를
덮는다. 그중 `"Google Antigravity uses the static-only probe without network access (#723)"`은
fetch가 한 번이라도 불리면 던지게 해놓아서 패치 없이 확실히 실패한다.

보안: OAuth 설정 영속화와 토큰 해석 순서를 건드린다. 자격증명 목적지가 바뀌지는
않지만(같은 Antigravity), 커밋 메시지에 이 사실을 남긴다.

## 5. #781 — Anthropic baseUrl 중복과 스트림 quirk (#765 PARTIAL)

지금 네 가지가 다 살아 있다:

- `src/adapters/anthropic.ts:695-723` — 사용자가 `/v1/messages`로 끝나는 baseUrl을
  넣으면 경로가 두 번 붙는다
- `:786-805` — `input_json_delta`가 `tool_use` 블록 밖에서도 먹는다
- `:771-779` — tool ID가 비어도 그대로 내보낸다
- `:833-848` — terminal SSE 없이 끝나는 스트림

**커밋을 쪼갠다.** 토픽 커밋 `70031f470`이 `src/adapters/anthropic.ts`와
`tests/anthropic-stream-hardening.test.ts` 말고도
`tests/claude-messages-endpoint.test.ts`, `tests/claude-native-passthrough.test.ts`를
`logsFromApiBody`로 갈아끼우고 `tests/helpers/logs-api.ts`를 들여온다. 그 헬퍼는
배열과 `{logs}` 봉투를 둘 다 받아준다:

```ts
export function logsFromApiBody<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === "object" && Array.isArray((body as {logs?: unknown}).logs)) {
    return (body as {logs: T[]}).logs;
  }
  return [];
}
```

배치 B는 봉투 계약을 거부하기로 했다. 이 헬퍼를 먼저 들이면 배열 단언이 느슨해져서
나중에 봉투로 바뀌어도 테스트가 안 잡는다 — #790이 정확히 그 방식으로 무력한
테스트를 만들었다. 그러니 **`src/adapters/anthropic.ts`와
`tests/anthropic-stream-hardening.test.ts`만** 가져오고 나머지 세 파일은 HEAD 그대로
둔다.

**그 위에 얹을 수정 2건**:

1. 문자열 `tool_use.input`이 그대로 JSON 문자열로 직렬화된다. 보고된 이중 인코딩
   실패가 그대로 남는다. 파싱을 시도하고, 실패하면 `{}`로 떨어뜨린다.
   그 케이스의 테스트를 우리가 쓴다.
2. `sawContent` 지역변수가 6곳에서 대입되는데 읽히는 곳이 없다. 죽은 코드다.
   제거한다.

#765는 부분 해결이라 열어둔다 — 이슈가 relay quirk 관용을 더 넓게 요구한다.

## 7. #769 — Baseten free-directory 행

`src/providers/free-directory.ts:21-24`, `:122-124`. canonical registry가 아니라
비활성 참조 행이다. `MAINTAINERS.md`가 증거 부족 시 권하는 바로 그 배치다.
1파일 +4/-1. 승격이 아니므로 그대로 태운다.

## 검증

각 건: `bun x tsc --noEmit` + 해당 테스트 파일.
배치 종료: `bun run test` 전체 + `bun run privacy:scan` + 메인 체크아웃
`git status --porcelain` 대조. 그 다음 푸시.
