# 003 — #539 Desktop 3P configLibrary 경로 근본 원인 분석

조사 시점: 2026-07-27
대상 이슈: #539 "Desktop 3P config written to Claude-3p/configLibrary instead of Claude/configLibrary"

## 제보 내용

제보자(NewLand-Ju, Claude Desktop 1.24012.9)는 `ocx claude desktop apply`가
`~/Library/Application Support/Claude-3p/configLibrary/`에 쓰는데 Desktop은
`~/Library/Application Support/Claude/configLibrary/`를 읽으므로 모델이 안 보인다고
보고했다. 제안한 수정은 하드코딩 세그먼트를 `Claude-3p` → `Claude`로 바꾸는 것이다.

제보자의 워크어라운드는 실제로 동작했다:

```bash
OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR="$HOME/Library/Application Support/Claude/configLibrary" ocx claude desktop apply
```

## 검증: 제안된 수정은 오답이다

로컬 설치본(`/Applications/Claude.app`, `com.anthropic.claudefordesktop`, 1.18286.0)의
`app.asar`에서 경로 결정 함수를 직접 추출했다:

```js
const Bu = "-3p", zW = "Claude", ND = `${zW}${Bu}`, MD = "claude_desktop_config.json";
function GE(){
  if (process.env.CLAUDE_USER_DATA_DIR) return te.app.getPath("userData");
  if (process.platform === "win32" && process.env.LOCALAPPDATA) return Nn.join(process.env.LOCALAPPDATA, ND);
  const t = te.app.getPath("userData");
  return t.endsWith(Bu) ? t : `${t}${Bu}`;
}
function mD(){ return Nn.join(GE(), "configLibrary") }
```

### 버전 일반화 근거 (A단계 감사 보강)

로컬 번들은 1.18286.0인데 제보자는 1.24012.9를 썼다. 버전 차이를 무시하고 일반화하면
안 되므로 외부 근거로 보강한다. Anthropic의 현행 설정 레퍼런스가 세 플랫폼 경로를
그대로 문서화하고 있다:

- macOS: `~/Library/Application Support/Claude-3p/configLibrary/`
- Windows: `%LOCALAPPDATA%\Claude-3p\configLibrary\`
- Linux: `~/.config/Claude-3p/configLibrary/`

즉 세 분기 모두 현재까지 유지된다. 이 벤더 문서가 6주 전 로컬 번들보다 강한 근거이며,
본 RCA의 결론은 로컬 추출이 아니라 이 문서에 의해 지탱된다.

세 가지가 확정된다.

**1. `Claude-3p`는 정상 기본값이다.** 마지막 분기가 `userData`에 `-3p`를 무조건
붙인다. 제보자가 `app.asar` 문자열 검색에서 `Claude-3p`를 1건밖에 못 찾은 이유는
이 값이 런타임 템플릿 리터럴(`` `${zW}${Bu}` ``)로 조립되기 때문이다. 정적 문자열로
존재하지 않는다.

로컬 파일시스템도 이를 뒷받침한다:

```
~/Library/Application Support/Claude-3p/    45 entries (Cache, IndexedDB, Local Storage, ... 실제 Electron userData)
~/Library/Application Support/Claude/       49 entries (1P 쪽 userData)
~/Library/Application Support/Claude/configLibrary/   존재하지 않음
```

따라서 하드코딩을 `Claude`로 바꾸면 현재 정상 동작 중인 모든 macOS 사용자가 깨진다.
제보자의 처방을 그대로 따르는 것은 회귀를 만드는 일이다.

**2. 진짜 결함 (a): 환경 분기 미구현.** ocx는 `GE()`의 세 분기 중 마지막 하나만
구현했다. 두 곳에 동일하게 하드코딩되어 있다:

- `src/claude/desktop-3p.ts:312`
- `src/server/management/agent-settings-routes.ts:548`

```ts
const libraryPath = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR?.trim()
  || join(homedir(), "Library", "Application Support", "Claude-3p", "configLibrary");
```

누락된 것:

| 조건 | Desktop의 실제 경로 | ocx 현재 동작 |
|------|---------------------|---------------|
| `CLAUDE_USER_DATA_DIR` 설정됨 | `userData/configLibrary` (`-3p` 접미사 **없음**) | macOS `Claude-3p` 하드코딩 |
| win32 + `LOCALAPPDATA` | `%LOCALAPPDATA%\Claude-3p\configLibrary` | macOS `Claude-3p` 하드코딩 |
| 그 외 | `userData` + `-3p` | 우연히 일치 |

제보자의 워크어라운드가 먹힌 것은 그가 첫 번째 분기에 해당하는 환경이었을 가능성이
가장 크다. `CLAUDE_USER_DATA_DIR`가 설정되면 Desktop은 `-3p` 없는 경로를 읽는데,
ocx는 계속 `-3p` 경로에 썼다. 증상 설명과 정확히 일치한다.

Windows 분기는 더 심각하다. 현재 코드는 Windows에서 `~/Library/Application Support/...`
라는 존재하지 않는 경로를 만든다. 프록시는 Windows를 CI에서 지원하므로 실질 결함이다.

**3. 진짜 결함 (b): `appliedId` 읽기/쓰기 비대칭.**

쓸 때는 갱신한다 (`desktop-3p.ts:331`):

```ts
atomicWriteFile(metadataPath, JSON.stringify({ ...metadata, appliedId: id, entries }, null, 2) + "\n");
```

읽을 때는 무시한다 (`agent-settings-routes.ts`, `/api/claude-desktop/status`):

```ts
const entry = Array.isArray(meta.entries) ? meta.entries.find(e => e?.name === "opencodex") : undefined;
```

Desktop 번들은 `appliedId`가 가리키는 프로필 **하나만** 읽는다:

```js
function l$(){
  let t = JSON.parse(An.readFileSync(n$(), "utf8"))?.appliedId;
  ...
  return JSON.parse(An.readFileSync(r$(t), "utf8"));   // appliedId의 파일만
}
```

로컬 `_meta.json`이 이 구조를 확인해 준다:

```json
{
  "appliedId": "1252f550-...",
  "entries": [
    { "id": "d1444bab-...", "name": "Default" },
    { "id": "1252f550-...", "name": "opencodex" }
  ]
}
```

사용자가 Desktop UI에서 "Default"로 전환하면 `appliedId`가 `d1444bab`로 바뀐다.
그 순간 ocx의 상태 API는 여전히 `entries`에서 `opencodex`를 찾아내 "적용됨"이라고
보고하지만, Desktop은 opencodex 설정을 읽지 않는다. 조용한 거짓 보고다.

**범위 한정 (A단계 감사 보강).** "Desktop이 `appliedId`만 읽는다"는 managed-config
읽기 경로(`l$()`)에 한정된 진술이다. 번들에는 `[appliedId, ...나머지 엔트리]`를 순회하며
`inferenceProvider === "anthropic"`을 찾는 별도 루틴도 있다. 따라서 `activeProfile`
필드의 의미는 "managed-config 경로에서 우리 프로필이 선택되었는가"로 좁혀서 문서화한다.
상태 수정의 정당성 자체는 변하지 않는다 — `l$()`가 3P 게이트웨이 설정을 읽는 경로이기 때문이다.

**Windows 마이그레이션 경로 (A단계 감사 보강).** 번들에는 `XW()`(`%APPDATA%\Claude-3p`)와
`QW()`가 있고, `QW()`는 레거시 Roaming 디렉터리를 `GE()` 위치로 이전하며 복사 목록에
`configLibrary`를 포함한다. Windows에서 마이그레이션이 진행 중인 창에서는 ocx가 Desktop이
아직 읽지 않는 위치에 쓸 수 있다. 이번 수정의 범위를 넘으므로 WP1에서는 `GE()` 정합까지만
구현하고, 이 창은 알려진 한계로 기록한다.

## 결론

#539는 실재하는 버그이나 제보된 위치와 처방이 모두 틀렸다. 수정해야 할 것은
하드코딩 세그먼트가 아니라 **경로 해석 로직 전체**이며, `Claude-3p` 기본값은
반드시 보존해야 한다.

수정 설계는 `010_phase1_desktop_path_fix.md`에 있다.

## 부수 확인 대상

#241("라우팅 모델이 Desktop 모델 피커에 미표시", upstream-tracking)은 이 결함의
하위 증상일 수 있다. WP1 수정 후 재평가한다.
