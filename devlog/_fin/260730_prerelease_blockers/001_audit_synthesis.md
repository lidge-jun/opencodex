# 001 — A-phase 감사 종합

Sol 리뷰어(priority tier)에게 `000`/`010`/`020`/`030` 초안을 적대적으로 검토시켰다.
판정 **FAIL**, 블로커 3건. 두 건은 실제 결함이고, 계획을 고쳤다.

리뷰어의 사전 스캔: `bun test tests/claude-auth-mode.test.ts tests/web-search.test.ts
tests/images/loop.test.ts` → 75 pass / 0 fail (수정 전 기준선).

## 블로커 1 (High) — #701 수정이 기본 경로를 놓친다. **인정, 계획 변경.**

초안은 `config.claudeCode?.authMode === "subscription"`을 판별자로 썼다. 그런데 `auto`가
저장 형태로는 **키 부재**이고, 그게 GUI 기본값이다:

- `src/server/management/agent-settings-routes.ts:740` — `"auto"`는 키를 **삭제**한다.
  `"proxy"`/`"subscription"`만 문자열로 저장된다.
- `gui/src/pages/ClaudeCode.tsx:42` — "absent config key is AUTO", 강제 변환 금지가
  명시된 주석으로 고정돼 있다.
- `src/claude/auth-mode.ts:42` — `auto` + 탐지 `present` → `markerMode: "subscription"`,
  `origin: "auto-present"`.

직접 확인했다. `detectClaudeAuth`의 소스 순서는 `claude.json` → credentials 파일 →
keychain → exported-env다(`src/claude/auth-detect.ts:163`). 즉 claude.ai 로그인이 살아 있는
구독 사용자는 `claude.json`에서 먼저 `present`로 잡혀 subscription으로 해소된다. 그런데
초안의 strip은 저장된 리터럴만 보므로 이 사용자에게는 **발동하지 않는다**. 이슈 신고자는
`authMode`를 명시적으로 설정했지만, 같은 실패를 겪는 다수는 `auto`일 것이다.

초안은 "`auto`에서 상속된 키를 인정하는 것은 의도된 동작"이라고 적었다. 절반만 맞다.
의도된 것은 **사용자가 진짜 export한** 키를 인정하는 것이다. Bun이 작업 디렉터리에서
합성한 값까지 인정하려는 의도는 없었다. 초안은 이 provenance 구분을 뭉갰다.

### 고친 설계: 런처 provenance

측정으로 provenance가 복구 가능함을 확인했다(`000_plan.md`의 probe):

```
node sees:                [undefined]     ← 런처는 dotenv를 못 본다
bun default sees:         [from-dotenv]   ← 자식 Bun만 본다
bun --no-env-file sees:   [undefined]
bun --no-env-file+export: [real-export]   ← 진짜 export는 살아남는다
```

`bin/ocx.mjs`는 Node로 돌기 때문에 dotenv를 보지 못한다. 그래서 런처가 두 슬롯의
"Bun 시작 전 존재 여부"를 자식에게 알려줄 수 있고, `buildClaudeEnv`는 Bun이 시작한 뒤에야
나타난 값을 오염으로 판정할 수 있다.

전역 `--no-env-file`은 여전히 거부한다. 런타임 설정이 환경값을 광범위하게 읽고,
`src/config.ts:1603`의 config 보간도 포함된다. 리뷰어도 이 거부는 타당하다고 확인했다.
거부한 것은 전역 플래그이고, 런처 계층 해법 자체는 아니다.

상세 diff는 `010`에 반영했다.

## 블로커 2 (High) — #688 추출기가 다중 서명 블록을 여전히 손상시킨다. **인정, 계획 변경.**

초안의 추출기는 `thinking` 하나, `signature` **마지막 것 하나**, `redacted` 집계 배열
하나를 유지한다. `thinking("first"), sig1, thinking("second"), sig2` 스트림이 들어오면
`"firstsecond"` + `sig2` 한 파트가 된다. 그 서명은 결합된 텍스트를 인증하지 않으므로
리플레이가 여전히 400 날 수 있다. 집계된 redacted도 모든 visible thinking 앞으로 밀려
스트림 순서를 잃는다.

이건 내가 선례로 인용한 `src/images/loop.ts:153`가 이미 막아둔 바로 그 버그다. 그 파일
주석이 "flattening multiple blocks into one signature 400s on replay"라고 경고한다.
선례를 인용하면서 알고리즘은 따라가지 않았다.

Anthropic 직렬화는 수락된 서명마다 **그 파트의 정확한 텍스트**를 함께 내보낸다
(`src/adapters/anthropic.ts:409` 부근). 그래서 블록별 쌍이 유지돼야 한다.

### 고친 설계

image loop의 flush 알고리즘을 이식한다: `thinking_signature`에서 flush,
`redacted_thinking`에서 flush 후 별도 파트 push. 그 위에 raw reasoning 누적기를 더한다.
상세는 `020`에 반영했다.

## 블로커 3 (Medium) — #688 테스트가 실패 지점까지 못 간다. **인정, 계획 변경.**

초안은 mock 어댑터로 `p.context.messages`만 검사하고, 실제 wire body의
`reasoning_content` 확인을 "선택적"으로 뒀다. 사용자가 겪는 실패는 직렬화 경계에서
발생한다(`src/adapters/openai-chat.ts:179` 게이팅). mock 테스트만 통과하면서 2회차 요청에
`reasoning_content`가 없을 수 있다.

실제 `createOpenAIChatAdapter`로 2회차 body를 검증하는 테스트를 **필수**로 올린다.

## 리뷰어가 확인한 비-블로커

- `extractIterationThinking` 호출부는 web-search에 1곳. image loop의 동명 함수는 독립.
- 서명 없는 thinking은 Anthropic이 무시하고 openai-chat이 직렬화한다. Kiro는 툴콜
  리플레이에서 thinking을 무시하고, Cursor는 다중 thinking 파트를 표현할 수 있다.
  bridge와 terminal guard는 내부 재구성된 리플레이 메시지를 소비하지 않는다.
- `010`의 admission-key 순서 주장은 맞다. 관리키 주입(`src/cli/claude.ts:76`)이
  host-managed 검사(`:114`)보다 앞이다. 제안된 테스트 2개는 수정 전에 실패한다.
- `cfg`, `fileAuth`, web-search mock 스타일 모두 실존. 유령 심볼 없음. Anthropic 인용
  줄번호가 10줄쯤 밀린 것들이 있어 `020`에서 정정했다.
- `030`의 live 사실 재확인: `e2da6f6df`는 `origin/dev`·`origin/main` 양쪽 조상. PR
  #610·#616·#707 모두 dev 대상으로 열려 있음. dev 2.7.41 / main 2.7.43.

## 반박한 것

없다. 세 블로커 모두 코드 근거가 있어 전부 계획에 반영했다.

---

# 라운드 2

같은 리뷰어에게 수정된 계획을 재감사시켰다(AUDIT-LOOP-01: FAIL 라운드는 같은 리뷰어로
재감사). 판정 **FAIL**, 블로커 1건. 인정하고 고쳤다.

## 블로커 4 (High) — strip과 탐지가 서로 다른 환경을 본다. **인정, 계획 변경.**

라운드 1 수정안은 `env`에서 dotenv 자격증명을 지우면서 탐지는 원본 `base`에 그대로
뒀다. 그러면 `src/cli/claude.ts:79-88`이 명시적으로 보호하는 "탐지기와 spawn되는
프로세스가 다른 것을 보지 않는다" 불변식을 내가 깨는 것이 된다.

구체적 실패 경로: `auto` + claude.ai 로그인 없음 + dotenv에만 `ANTHROPIC_API_KEY`.
오염된 base를 보는 탐지가 exported-env를 `present`로 잡아 subscription으로 해소하고
(`src/claude/auth-mode.ts:42`), 그래서 `markerMode !== "proxy"`가 되어 line 90의 마커
주입이 건너뛰어진다. 자식은 **자격증명도 없고 마커도 없는** 상태가 된다.

내 초안은 "이 사용자는 `auto-absent` → proxy로 간다"고 적었는데, 자기 의사코드와
모순이었다. 리뷰어 지적이 정확하다.

수정: 탐지를 정리된 `env`에 바인딩한다. strip이 이미 끝난 뒤라 `env`가 실제 spawn에
쓰이는 그 객체이므로 불변식은 오히려 더 정확해진다. 회귀 테스트 한 건 추가
(`fileAuth("absent")` + 마커 `""` + dotenv 전용 키 → 키 제거 + `PROXY_MARKER` +
`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1`).

## 라운드 2에서 통과 확인된 것

- `OCX_PRE_BUN_ANTHROPIC_ENV`는 실제 경로에서 관측된다. 런처가 Bun에 넘기고
  `src/cli/claude.ts:222`가 Bun의 `process.env`를 `buildClaudeEnv`에 넘긴다. 직접 확인:
  `ClaudeLaunchEnv`는 열린 index signature라 타입 변경도 불필요하다.
- 배포된 `ocx`/`opencodex` 모두 `bin/ocx.mjs`를 지난다. `bun run src/cli/index.ts claude`
  직접 실행은 provenance를 얻지 못해 미수정으로 남지만, 계획이 이를 명시하고 fail-safe로
  동작한다.
- `env: { ...process.env, marker }`는 기존 상속과 값이 동등하다. tray·update·service
  코드가 그 spawn의 객체 동일성에 의존하지 않는다.
- 마커는 자식 복사본에서 삭제되므로 중첩 `ocx` 실행은 자기 환경에서 provenance를 다시
  계산한다. 중첩 결함 없음.
- `020`의 지정 스트림은 정확히 thinking 파트 4개(redacted, signed first, signed second,
  unsigned raw)를 만들고 리플레이가 툴콜을 다섯 번째로 붙인다.

## 남긴 관찰 (블로커 아님)

마커가 부모 Bun 프로세스에 남아, `ensureProxyForClaude()`가 먼저 돌면서
`src/cli/claude.ts:179`의 `{ ...process.env }` spread로 새 프록시에 상속된다. 현재 프록시
소비자가 이 변수를 읽지 않아 무해하다. 이상적으로는 프록시 시작 전에 소비·제거해 seam을
좁히는 게 낫다. 별도 관찰로 남긴다.

`thinking_delta → reasoning_raw_delta → thinking_signature` 순서로 **서명이 끝나지 않은**
블록 안에 raw reasoning이 끼어들면 연결이 깨진다. 현재 어떤 어댑터도 그런 스트림을
내지 않아 도달 불가다. `020`에 이 이벤트 순서 불변식을 문서화한다. "혼합 스트림은 항상
안전"이라는 더 넓은 주장을 하려면 segment 객체 구조가 필요하고, 그건 이번 범위가 아니다.

---

# 라운드 3

판정 **GO-WITH-FIXES (blockers=2)**. 둘 다 문서 내부 정합성 문제이고 코드 설계 결함이
아니다. 둘 다 고쳤다. A 게이트는 near-pass로 종료한다.

## 블로커 5 (Medium) — 문서 계획이 존재하지 않는 예외를 서술한다. **인정, 고침.**

`010`의 문서 절이 "subscription 모드에서는 직접 export한 값이 이기지 않는다"고 적혀
있었다. 리터럴 판별자 시절의 잔재다. provenance 설계에서는 런처가 지목한 슬롯이
`authMode`와 무관하게 보존되므로, 진짜 셸 export는 subscription 모드에서도 살아남는다.
제거되는 것은 Bun이 만든 dotenv 값뿐이다.

구현자가 이 절을 그대로 따르면 코드와 반대되는 문서를 쓰게 된다. 고쳤다.

## 블로커 6 (Low) — 반증 카운트가 낡았다. **인정, 고침.**

라운드 2에서 회귀 테스트를 추가해 수정 전 실패해야 하는 테스트가 3개가 아니라 4개다.
`010`의 반증 절차를 갱신하고, 어떤 4개인지 명시했다. shell-export 생존과 no-marker no-op은
수정 전후 모두 통과하는 비회귀 증거라는 점도 적었다.

## 라운드 3 5-케이스 트레이스 (리뷰어 검증)

| 케이스 | API key | Auth token | Host-managed |
|---|---|---|---|
| (a) auto + 네이티브 로그인 + dotenv 키 | 제거 | unset | unset |
| (b) auto + 로그인 없음 + dotenv 키 | 제거 | `PROXY_MARKER` | `"1"` |
| (c) auto + 로그인 없음 + 셸 export | 보존 | unset | unset |
| (d) 명시 proxy + dotenv 키 | 제거 | `PROXY_MARKER` | `"1"` |
| (e) 관리키 설정 + dotenv 키 | 제거 | 관리키 | `"1"` |

(b)가 라운드 2에서 깨져 있던 케이스다. 이제 마커가 정상 주입된다.

## 라운드 3에서 확인된 것

- `ownTokens`가 주입된 관리키를 사용자 인증으로 오인하지 않게 막는다
  (`src/claude/auth-detect.ts:142`).
- stale proxy marker 제거가 provenance 정리보다 먼저다. 탐지 재바인딩은 쓰이지 않는
  `staleProxyMarker` 진단값만 바꾸고 해소 동작은 그대로다.
- `defaultAuthDetectDeps(env)`는 `CLAUDE_CONFIG_DIR`/home 경로 해소에 환경을 쓰지만,
  provenance 정리는 그 필드를 건드리지 않는다. 직접 확인했다 — 파일·keychain 프로브는
  동일하게 동작한다(`src/claude/auth-detect.ts:188`, `:86`, `:96`).
- deps spread 순서가 유지되므로 테스트 fake가 env 바인딩을 덮을 수 없다.
- `020`과 이 문서에 새 불일치 없음.

## A 게이트 종료

3라운드: FAIL → FAIL → GO-WITH-FIXES(2). 블로커 6건 전부 인정하고 계획에 반영했으며,
반박한 것은 없다. 남은 잔여물은 문서 문구 2건이고 방금 고쳤다. B로 넘어간다.
