# 010 — #701: 프로젝트 dotenv가 Claude 구독 인증을 덮어쓰는 문제

대상 이슈: [#701](https://github.com/lidge-jun/opencodex/issues/701)

## 증상

`.env.local`에 `ANTHROPIC_API_KEY`가 있는 디렉터리에서 `ocx claude`를 띄우면, Bun이
OpenCodex 코드가 시작되기 전에 그 값을 환경에 올린다. `claudeCode.authMode`가
`subscription`인데도 OpenCodex는 그 값을 사용자가 직접 export한 자격증명처럼 보존하고,
Claude Code는 claude.ai 커넥터를 끄고 API 과금 경로로 간다. 로그인은 정상인데
크레딧 잔액 오류가 난다.

## 경로 추적

1. Bun이 `.env.local`을 자동 로드한다.
2. `src/cli/claude.ts:222` — `buildClaudeEnv(config, port, process.env, contextWindows)`로
   오염된 환경을 그대로 넘긴다.
3. `src/cli/claude.ts:44` — `const env: ClaudeLaunchEnv = { ...base };` 전부 보존한다.
4. `src/cli/claude.ts:84` — 인증 탐지를 같은 `base`에 바인딩한다. 탐지기와 실제 spawn이
   서로 다른 값을 보면 안 된다는 기존 불변식이다.
5. `src/claude/auth-detect.ts:144` — `env.ANTHROPIC_API_KEY?.trim()`을 읽어
   `{ source: "exported-env", presence: "present" }`로 판정한다.
6. `src/claude/auth-mode.ts:37` — `authMode === "subscription"`이면 탐지를 우회하지만,
   이미 `base`에서 복사된 자격증명을 **제거하지는 않는다**.
7. `src/cli/claude.ts:246` — 그 환경이 Claude Code 자식에게 전달된다.

OpenCodex가 `ANTHROPIC_API_KEY`를 직접 주입하는 곳은 없다. 문제는 Bun의 주입을
그대로 통과시킨다는 점이다.

## 선택한 수정: 런처 provenance (A-phase 감사 후 변경)

> 초안은 `authMode === "subscription"` 리터럴만 판별자로 썼다. 감사에서 이게 **기본
> 경로를 놓친다**는 것이 드러났다. 근거와 경위는 `001_audit_synthesis.md` 블로커 1.

핵심 사실: `auto`는 저장 형태가 **키 부재**이고 그게 GUI 기본값이다.
`src/server/management/agent-settings-routes.ts:740`이 `"auto"`일 때 키를 삭제하고,
`gui/src/pages/ClaudeCode.tsx:42`가 "absent config key is AUTO"를 명시한다. 그리고
`auto` + 탐지 `present`는 subscription으로 해소된다(`src/claude/auth-mode.ts:42`).
claude.ai 로그인이 살아 있으면 `claude.json`이 탐지 소스 중 **첫 번째**로 잡힌다
(`src/claude/auth-detect.ts:163`). 즉 피해자 다수가 `auto`다. 리터럴 판별자로는 안 된다.

그렇다고 `auto`에서 상속된 키를 무조건 버릴 수도 없다. 그건 의도된 API-key 인증 경로이고
`tests/claude-auth-mode.test.ts:129`가 고정한다. 필요한 건 **provenance**다: 사용자가
진짜 export한 값인가, Bun이 작업 디렉터리에서 합성한 값인가.

측정 결과 provenance는 런처 경계에서 복구된다(`000_plan.md`). `bin/ocx.mjs`는 Node로
실행되므로 dotenv를 보지 못하고, 자식 Bun만 본다.

전역 `--no-env-file`은 여전히 쓰지 않는다. 런타임 설정이 환경값을 광범위하게 읽고
`src/config.ts:1603`의 config 보간도 포함되므로, dotenv 로딩 자체를 끄면 무관한
프로바이더 설정이 깨진다. 끄는 게 아니라 **표시**한다.

## 변경 1: `bin/ocx.mjs` (MODIFY)

Bun spawn 직전에, Node가 본(=dotenv 이전) 두 슬롯의 존재 여부를 자식에게 알린다.

before (`bin/ocx.mjs:356` 부근):

```js
const bun = resolveBun();
...
const child = spawn(bun, [cliPath, ...process.argv.slice(2)], { stdio: "inherit" });
```

after:

```js
const bun = resolveBun();
...
// Provenance seam for issue #701. This launcher runs under NODE, which does not
// auto-load a project dotenv; the Bun child does. So the only place that can still
// tell a real shell export from a working-directory `.env.local` value is right here,
// BEFORE the child starts. We record which Anthropic credential slots were already
// present and let src/cli/claude.ts treat anything that appears later as ambient
// project pollution rather than user auth. Disabling Bun's dotenv wholesale is not an
// option: config interpolation and provider settings legitimately read the project env.
const preBunAnthropicSlots = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]
  .filter(name => typeof process.env[name] === "string" && process.env[name] !== "");
const child = spawn(bun, [cliPath, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, OCX_PRE_BUN_ANTHROPIC_ENV: preBunAnthropicSlots.join(",") },
});
```

빈 문자열도 유효한 마커다(슬롯 0개 = "런처 시점에 아무것도 없었다"). 변수 자체가 부재한
경우와 구분해야 하므로, 소비 측은 `undefined`와 `""`를 다르게 취급한다.

## 변경 2: `src/cli/claude.ts` (MODIFY)

`buildClaudeEnv` 안, `base` 복사 직후 · 관리키 주입 이전.

before (`src/cli/claude.ts:44` 부근):

```ts
  const env: ClaudeLaunchEnv = { ...base };
  if (env.ANTHROPIC_AUTH_TOKEN === PROXY_MARKER) delete env.ANTHROPIC_AUTH_TOKEN;
```

after:

```ts
  const env: ClaudeLaunchEnv = { ...base };
  if (env.ANTHROPIC_AUTH_TOKEN === PROXY_MARKER) delete env.ANTHROPIC_AUTH_TOKEN;
  // Step 1b — drop Anthropic credentials that the bundled Bun runtime synthesized from a
  // project `.env`/`.env.local` (issue #701). Claude Code disables claude.ai connectors the
  // moment either token slot is populated, so an ambient project file silently moved a
  // subscriber onto API billing. The npm launcher runs under Node, which does NOT auto-load
  // dotenv, so it records the slots that existed before Bun started; anything present now
  // but absent then came from the working directory, not from the user. A genuine shell
  // export still wins, which keeps auto-mode API-key auth intact. When the marker is absent
  // (direct `bun src/cli/index.ts` runs, tests) we cannot attribute provenance and change
  // nothing.
  const preBun = base.OCX_PRE_BUN_ANTHROPIC_ENV;
  if (preBun !== undefined) {
    const exported = new Set(preBun.split(",").filter(s => s.length > 0));
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const) {
      if (env[name] !== undefined && env[name] !== "" && !exported.has(name)) delete env[name];
    }
  }
  delete env.OCX_PRE_BUN_ANTHROPIC_ENV;
```

정리가 `setDefault("ANTHROPIC_AUTH_TOKEN", config.apiKeys![0].key)` (line 76 부근) **앞**에
와야 한다. 그래야 OpenCodex 관리키는 그 뒤에 정상 주입된다.

마커는 자식 환경에서 삭제한다. Claude Code에 흘려보낼 이유가 없다.

### PROXY_MARKER 상호작용

기존 line 50이 자기 소유 더미를 먼저 지운다. 그 다음에 provenance strip이 온다. 순서가
중요하다 — 더미가 남아 있으면 "슬롯이 채워져 있다"로 보여 불필요하게 strip 대상이 된다.
실제로는 이미 삭제됐으므로 문제없다.

### 탐지 바인딩 — 정리된 환경에 바인딩한다 (감사 라운드 2에서 수정)

> 초안은 탐지를 원본 `base`에 그대로 두려 했다. 그건 틀렸다.
> 근거: `001_audit_synthesis.md` 블로커 4.

`src/cli/claude.ts:79-88`의 기존 불변식은 "탐지기와 spawn되는 프로세스가 절대 다른 것을
보지 않는다"다. provenance strip은 `env`를 바꾸므로, 탐지를 원본 `base`에 두면 그
불변식을 **내가 깨는** 셈이다.

깨졌을 때의 구체적 실패: `auto` 모드 + claude.ai 로그인 없음 + dotenv에만
`ANTHROPIC_API_KEY`. 오염된 base를 보는 탐지는 exported-env를 `present`로 잡아
(`src/claude/auth-detect.ts:139` 부근) subscription으로 해소한다
(`src/claude/auth-mode.ts:42`). 그러면 `markerMode !== "proxy"`이므로 line 90의 마커
주입이 일어나지 않는다. 자식은 dotenv 자격증명도 없고 `PROXY_MARKER`도 없는 상태가 된다.
초안이 "이 사용자는 `auto-absent` → proxy로 간다"고 적은 건 자기 의사코드와 모순이었다.

그래서 탐지는 **정리된 환경**에 바인딩한다. strip이 line 50~1b에서 이미 끝나 있으므로
`env`를 그대로 넘기면 된다.

before (`src/cli/claude.ts:84` 부근):

```ts
  const resolved = resolveClaudeAuthMode(config, detectClaudeAuth({
    ...defaultAuthDetectDeps(base as NodeJS.ProcessEnv),
    ...(deps.authDetect ?? {}),
    env: () => base as NodeJS.ProcessEnv,
    ownTokens: ownAdmissionTokens(config),
  }));
```

after:

```ts
  // Detection reads the SANITIZED launch env, not the raw base: the provenance strip above
  // already removed dotenv-only credentials, and binding detection to the pre-strip base
  // would let a value the child never receives decide the marker. That combination left an
  // auto-mode user with no credential AND no PROXY_MARKER (#701 audit round 2). `env` is
  // still the exact object the spawn below uses, so the original invariant holds.
  const resolved = resolveClaudeAuthMode(config, detectClaudeAuth({
    ...defaultAuthDetectDeps(env as NodeJS.ProcessEnv),
    ...(deps.authDetect ?? {}),
    env: () => env as NodeJS.ProcessEnv,
    ownTokens: ownAdmissionTokens(config),
  }));
```

불변식은 유지된다 — 오히려 더 정확해진다. `env`가 실제로 spawn에 쓰이는 객체다
(`src/cli/claude.ts:246`). 주석도 그에 맞춰 갱신한다.

마커 자체(`OCX_PRE_BUN_ANTHROPIC_ENV`)는 strip 직후 `env`에서 지우므로 탐지가 그것을
보지 않는다.

## 회귀 테스트: `tests/claude-auth-mode.test.ts` (MODIFY)

`"an exported ANTHROPIC_API_KEY keeps the token slot untouched"` 뒤에 추가한다.
기존 테스트는 비회귀 증거로 그대로 남긴다 — 마커가 없으면 아무것도 바뀌지 않아야 하므로
그 테스트는 수정 후에도 통과한다.

핵심은 **auto 모드**를 덮는 것이다. 감사 블로커 1이 지적한 실제 피해 경로다.

```ts
// #701: Bun auto-loads a project .env.local before opencodex starts, so process.env alone
// cannot tell ambient pollution from a real export. The Node launcher runs BEFORE that and
// records which slots already existed. These tests drive that marker directly.
const PRE_BUN = "OCX_PRE_BUN_ANTHROPIC_ENV";

// The reported failure: auto mode, healthy claude.ai login, key only from the dotenv.
test("auto mode drops an Anthropic key that only Bun's dotenv introduced", () => {
  const env = buildClaudeEnv(
    cfg(), 10100,
    { ANTHROPIC_API_KEY: "sk-ant-from-project-dotenv", [PRE_BUN]: "" },
    {},
    { authDetect: fileAuth("present") },
  );
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env[PRE_BUN]).toBeUndefined();
});

// A real shell export must still win — this is auto-mode API-key auth, which is supported.
test("a shell-exported Anthropic key survives the dotenv strip", () => {
  const env = buildClaudeEnv(
    cfg(), 10100,
    { ANTHROPIC_API_KEY: "sk-ant-user", [PRE_BUN]: "ANTHROPIC_API_KEY" },
    {},
    { authDetect: fileAuth("present") },
  );
  expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-user");
});

test("explicit subscription mode also drops a dotenv-only credential", () => {
  const env = buildClaudeEnv(
    cfg({ enabled: true, authMode: "subscription" }), 10100,
    { ANTHROPIC_API_KEY: "sk-ant-from-project-dotenv", ANTHROPIC_AUTH_TOKEN: "token-from-dotenv", [PRE_BUN]: "" },
    {},
    { authDetect: fileAuth("present") },
  );
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
});

// The admission key is opencodex's own gate, not user auth: injected after the strip.
test("the configured admission key survives the dotenv strip", () => {
  const env = buildClaudeEnv(
    cfg({ enabled: true }, [{ key: "admission-key" }]), 10100,
    { ANTHROPIC_API_KEY: "sk-ant-from-project-dotenv", [PRE_BUN]: "" },
    {},
    { authDetect: fileAuth("present") },
  );
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe("admission-key");
  expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
});

// No marker (direct `bun src/cli/index.ts` run, or an older launcher): provenance is
// unknowable, so behavior must be unchanged rather than guessed.
test("without the launcher marker an inherited key is left alone", () => {
  const env = buildClaudeEnv(
    cfg(), 10100,
    { ANTHROPIC_API_KEY: "sk-ant-user" },
    {},
    { authDetect: fileAuth("present") },
  );
  expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-user");
});

// Audit round 2: with no native Claude auth, stripping the dotenv key must ALSO flip
// detection to absent so the proxy marker is injected. Binding detection to the pre-strip
// base left this user with no credential and no marker at all.
test("a stripped dotenv key lets detection fall through to the proxy marker", () => {
  const env = buildClaudeEnv(
    cfg(), 10100,
    { ANTHROPIC_API_KEY: "sk-ant-from-project-dotenv", [PRE_BUN]: "" },
    {},
    { authDetect: fileAuth("absent") },
  );
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe(PROXY_MARKER);
  expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
});
```

`cfg()`와 `fileAuth()` 헬퍼는 이미 그 파일 상단에 있다(line 13, line 35). 리뷰어가 실존과
시그니처를 확인했다.

### 런처 소스 불변식

`tests/ocx-launcher-source.test.ts`가 `bin/ocx.mjs`의 소스 불변식을 검사하는 기존 소유자다.
`OCX_PRE_BUN_ANTHROPIC_ENV`를 spawn env에 넣는다는 문자열 단정을 한 건 추가해, 런처 쪽
절반이 조용히 사라지는 것을 막는다.

## 반증 절차

```
git stash push -- src/cli/claude.ts
bun test tests/claude-auth-mode.test.ts    # dotenv strip 테스트 4개가 실패해야 한다
git stash pop
bun test tests/claude-auth-mode.test.ts    # 전부 통과
```

수정 전 실패해야 하는 4건: auto dotenv strip, explicit-subscription strip, admission-key
strip, stripped-key proxy fallback. shell-export 생존과 no-marker no-op은 수정 전후 모두
통과한다(비회귀 증거이므로 정상이다).

`bin/ocx.mjs`만 stash하는 경우도 확인한다. 런처 마커 단정 테스트가 실패해야 한다.

## 문서

`docs-site/src/content/docs/guides/claude-code.md:56`이 "직접 export한 변수는 항상
이긴다"고 서술한다. 이 서술은 **그대로 유지된다** — provenance 설계에서 진짜 셸 export는
`authMode`와 무관하게 살아남는다. 초안이 "subscription 모드가 예외"라고 적었던 것은
리터럴 판별자 시절 이야기이고, 지금 계획과 어긋난다(감사 라운드 3 블로커 1).

추가할 내용은 예외가 아니라 **새 사실**이다: 배포된 `ocx claude`는 프로젝트
`.env`/`.env.local`의 Anthropic 자격증명을 무시한다. Node 런처 환경에 이미 있던 값만
사용자 인증으로 인정한다. 셸에서 export한 값은 계속 이긴다.

번역 로케일도 같은 내용으로 맞춘다. 이 문서 변경은 `bun run test` 게이트와 무관하므로
`030` 푸시 전에 함께 넣는다.

구현 시 `tests/claude-auth-mode.test.ts:127`의 기존 주석도 "base-env binding" →
"sanitized launch-env binding"으로 갱신한다.

## 위험

프로젝트 dotenv에 `ANTHROPIC_API_KEY`를 두고 `ocx claude`로 API 과금을 **의도**하던
사용자는 동작이 바뀐다. 회피 경로는 셸에서 export하거나(`export ANTHROPIC_API_KEY=...`)
`ocx claude` 실행 전 환경에 올리는 것이다. 릴리스 노트와 docs에 명시한다.

런처와 런타임이 두 파일로 나뉘므로 반쪽만 배포되면 안 된다. 마커 부재 시 동작 불변이라
안전 방향으로 실패한다(구 런처 + 신 런타임 = 기존 동작). 반대 조합(신 런처 + 구 런타임)은
마커가 무시되고 자식 환경에 낯선 변수 하나가 남지만, Claude Code는 이를 읽지 않는다.

`npx`/글로벌 설치 외에 서비스 래퍼가 `bin/ocx.mjs`를 우회해 Bun을 직접 띄우는 경로가
있으면 마커가 없어 strip이 발동하지 않는다. `ocx claude`는 런처를 지나므로 신고된 경로는
덮인다. 서비스 경로는 Claude Code 자식을 만들지 않아 무관하다.
