# 110 — #1073: metadata 없는 프로바이더의 context window 를 GUI 에서 정할 수 없다

## 이슈가 요청한 것

`/models` 가 id 만 주는 프로바이더(`{"data":[{"id":"gpt-5.6-luna"}]}`)에서 routed
catalog 가 `128000 / 128000 / 115200` 보수 fallback 을 쓴다. 사용자는 그 라우트가
350K 를 지원한다는 걸 알지만 Models GUI 로 지정할 방법이 없다.

## 백엔드는 이미 동작한다

조사에서 확인된 사실이고, 이게 이 유닛의 범위를 결정한다.

- `OcxProviderConfig.contextWindow` 와 `modelContextWindows` 는 이미 존재한다
  (`src/types.ts:1178`), provider 스키마가 `.passthrough()` 라 보존된다.
- `configuredContextWindow()` (`src/codex/catalog/provider-fetch.ts:528`) 가
  `modelContextWindows[id] ?? contextWindow` 로 명시값을 고르고,
  `applyProviderConfigHints()` (`:551-575`) 가 upstream 값이 있으면
  `Math.min` 으로 낮추고 **없으면 설정값을 그대로 `contextWindow` 로 만든다.**
- `providerContextCaps` 는 별개다. 기존 값이 있을 때만 낮추고 없는 값을 만들지
  않는다 (`src/providers/context-cap.ts:24`).

즉 손으로 `config.json` 을 편집하면 오늘도 된다. 이슈는 **backend bug 가 아니라
enhancement** 다. 라벨이 맞다.

빠진 것은 두 개다:
- `GET /api/providers` 가 두 필드를 반환하지 않는다
  (`src/server/management/provider-routes.ts:243`)
- PATCH mask 가 두 필드를 인정하지 않는다 (`:90`)

그래서 Models UI 에는 저장할 경로 자체가 없다.

## 기여자 PR #1203 을 채택한다

[#1203](https://github.com/lidge-jun/opencodex/pull/1203) (`estelledc`,
`fix/1073-context-window-gui`, head `d648818cf`, 3 커밋, +469/-4, 16 파일).
조사 시점에는 `CONFLICTING` 이었으나 저자가 리베이스해서 지금은 `MERGEABLE`.

접근이 옳다. **catalog derivation 코드를 건드리지 않고** management/API 와 UI
계층에서만 노출한다. `providerContextCaps` 의 ceiling 의미도 그대로 둔다.
6개 로케일과 문서, 스크린샷까지 갖췄다.

재작성할 구조적 문제는 없다. 국소적인 보정과 테스트가 필요하다.

### 보정 A — 여러 모델 draft 중 하나만 저장된다

`gui/src/pages/Models.tsx` 의 `saveContextSettings()`:

```ts
const modelWindow = parseContextWindowDraft(contextModelDrafts[contextModelId] ?? "");
...
if (contextModelId) {
  body.modelContextWindows = { [contextModelId]: modelWindow };
}
```

`contextModelDrafts` 는 **모든** 모델의 편집 내용을 들고 있는데 PATCH 에는
현재 선택된 `contextModelId` 하나만 실린다. 사용자가 모델 A 를 고쳐 입력하고
B 로 옮겨 고친 뒤 Apply 하면 A 의 변경이 조용히 사라진다. 오류도 경고도 없다.

PR 의 테스트가 이 동작을 정상값으로 고정하고 있어서 더 나쁘다.

**해결:** dirty 한 draft 를 전부 보낸다. 값이 바뀌지 않은 모델은 payload 에서
빼서 불필요한 쓰기를 피한다.

### 보정 B — 철회

첫 판은 "저장 성공 후 refresh 실패가 닫힌 모달의 오류 상태를 쓴다" 고 했다.
감사가 되돌렸고 맞다: `load()` (`gui/src/pages/Models.tsx:301-315`) 는 fetch
오류를 잡아 `false` 를 반환하며 **던지지 않는다.** 그리고 기여자의 3번째 커밋이
이미 모달을 닫고 성공 피드백을 게시한 뒤에 `load(true)` 를 부른다.
PR 테스트(`gui/tests/models-empty-provider.test.tsx:263-275`)가 refresh 실패 후
성공 상태 유지까지 검증한다.

예외 경계를 정리하는 것 자체는 방어적으로 유효하지만, 없는 결함을 고쳤다고
말할 수는 없다. 기준 10 은 "PR 에서 이미 충족" 으로 기록한다.

### 보정 B' — 편집하지 않은 모델을 되돌리지 않는다

보정 A 를 "현재 `groups` 와 draft 를 비교해서 다르면 dirty" 로 구현하면 새
결함이 생긴다. 모달이 열린 동안 폴링이나 다른 관리 요청이 모델 A 를
64K → 96K 로 갱신했는데 사용자는 B 만 고친 경우, 최신 값과 낡은 draft 를
비교하면 A 도 dirty 로 판정되어 64K 로 되돌린다. 사용자가 건드리지도 않은
모델을 되돌리는 셈이다.

**해결:** 두 조건을 **모두** 만족할 때만 보낸다 — 사용자가 그 필드를 건드렸고
(`touched`), 값이 모달을 열 때의 스냅샷과 다르다.

둘 중 하나만으로는 부족하다. `touched` 만 보면 "입력했다가 원래 값으로
되돌린" 경우에 낡은 값을 보내서 그 사이 바뀐 값을 덮는다. 스냅샷 비교만 보면
사용자가 건드리지도 않은 필드가 dirty 로 잡힌다.

**provider default 도 같다.** 이게 감사가 두 번째로 잡은 것이다. 첫 구현은
`contextWindow` 를 항상 payload 에 실었으므로, 모달이 열린 사이 다른 요청이
default 를 256K → 300K 로 바꿨는데 사용자가 모델만 편집했다면 낡은 256K 가
300K 를 되돌린다. default 에도 `touched` + 스냅샷 비교를 적용한다.

모든 편집이 되돌려져 payload 가 비면 PATCH 자체를 보내지 않는다.

### 보정 D — 기존 override 가 모델 목록에서 사라질 수 있다

live discovery 에서 빠지고 `providers.<name>.models` 에도 없는 모델에
`modelContextWindows` 항목만 남아 있으면, draft 에는 들어가지만
`contextModalModels` 에는 없어서 사용자가 그 값을 보거나 지울 수 없다.
목록에 `Object.keys(group.modelContextWindows ?? {})` 를 합친다.

### 보정 E — `1e100` 이 정수 검증을 통과한다

`Number.isFinite(1e100) && Number.isInteger(1e100)` 는 참이다. management PATCH
(`src/server/management/provider-routes.ts:174,194`) 와 GUI 파서
(`gui/src/pages/Models.tsx:373-379`) 가 둘 다 통과시킨다. 저장된 뒤 catalog 에
거대한 수로 직렬화되면 downstream Codex 의 정수 타입이 카탈로그를 거부할 수
있다. `Number.isSafeInteger` 로 좁힌다.

### 보정 F — 번역 문서가 새 의미와 모순된다

ko/ja/ru/zh-cn 의 provider 문서가 두 필드를 여전히 "상한" 으로만 설명한다.
metadata 가 없을 때 값을 **공급**한다는 의미가 빠져 있어서, 비영어 사용자는
#1073 의 해법을 정반대로 읽는다.

### 보정 C — #1073 의 정확한 재현이 테스트에 없다

PR 은 management 영속화와 GUI 를 테스트하지만, 이슈가 신고한 그 경로 —
`{data:[{id:"gpt-5.6-luna"}]}` + 명시 350K → catalog `350000/350000/315000` —
를 단언하지 않는다. 구성 요소가 각각 검증돼도 조립된 결과는 별개다.

`auto_compact_token_limit` 은 `min(floor(contextWindow * 0.9), maxInputTokens)`
(`src/codex/catalog/effort.ts:112`) 이므로 350000 → 315000.

**단, 테스트를 하나로 쓰면 안 된다.** 감사가 잡은 P1 이다. `modelContextWindows`
로만 350K 를 주면 `?? prov.contextWindow` 를 지워도 per-model 값이 그대로
선택되어 결과가 변하지 않는다. provider-wide fallback 결함을 놓치는 통과 전용
테스트가 된다.

두 케이스로 나눈다:

1. `contextWindow: 350000` **만** (per-model 없음) → 350K.
   `?? prov.contextWindow` 를 지우면 red.
2. provider default 와 **다른** `modelContextWindows[id]` → per-model 우선.
   `modelRecordValue(...)` 를 지우면 red.

fixture 에 `modelMaxInputTokens` 를 두지 않는다. 있으면
`min(315000, maxInputTokens)` 가 되어 기대값이 달라진다.

## 변경 파일

PR 커밋을 cherry-pick 해서 저작을 보존하고, 그 위에 보정 커밋을 얹는다.

- `gui/src/pages/Models.tsx` — 보정 A, B', D, E(파서)
- `gui/src/i18n/{en,ko,ja,zh,de,ru}.ts` — no-op 피드백 문구 `models.contextUnchanged`
- `src/server/management/provider-routes.ts` — 보정 E
- `gui/tests/models-empty-provider.test.tsx` — 다중 모델 저장, 중간 refresh 케이스
- `tests/management-provider-validation.test.ts` — unsafe integer 거부
- `tests/codex-catalog.test.ts` — 보정 C 의 두 acceptance 테스트
- `docs-site/src/content/docs/{ko,ja,ru,zh-cn}/reference/configuration/providers.md` — 보정 F

## 수용 기준

1. id-only `/models` + `contextWindow: 350000` **만** → catalog 가
   `350000 / 350000 / 315000`. (fixture 에 `modelMaxInputTokens` 없음)
2. id-only `/models` + provider default 와 다른 `modelContextWindows[id]` →
   per-model 값이 이긴다.
3. 설정 없는 id-only 모델은 그대로 `128000 / 128000 / 115200`.
4. upstream 이 64K 를 주면 configured 350K 가 있어도 64K 유지 (`Math.min` 방향).
5. 모델 A 와 B 를 각각 편집한 뒤 한 번의 Apply 로 **둘 다** PATCH 에 실린다.
6. 편집하지 않은 모델은 payload 에 없다. **모달이 열린 동안 A 의 persisted
   값이 바뀌어도** 사용자가 A 를 건드리지 않았으면 여전히 없다.
   provider default 도 마찬가지 — 사용자가 default 를 건드리지 않았으면
   중간에 갱신됐어도 `contextWindow` 가 payload 에 없다.
7. 입력했다가 원래 값으로 되돌린 필드는 payload 에 없다. 모든 편집이 되돌려지면
   PATCH 를 아예 보내지 않는다.
8. `1e100` 같은 unsafe integer 는 management PATCH 가 거부하고, GUI 도 인라인
   오류를 띄우며 PATCH 를 보내지 않는다.
9. live discovery 에 없지만 `modelContextWindows` 에 있는 모델이 선택 목록에 뜬다.
10. (PR 에서 이미 충족) PATCH 성공 후 refresh 실패해도 성공 피드백 유지.
11. ko/ja/ru/zh-cn 의 provider 문서가 두 필드를 "상한" 만이 아니라 "메타데이터가
    없을 때 값을 공급" 하는 의미까지 설명한다. `rg` 대조로 확인한다.
12. ablation — 전부 **실제 결함 형태**로 되돌려서 red 를 확인한다. 인위적으로
    강한 mutant(예: touched 가드까지 제거)는 통과 근거가 되지 못한다:
    - `configuredContextWindow` 에서 `?? prov.contextWindow` 제거 → 1 이 red.
    - `modelRecordValue(prov.modelContextWindows, id)` 제거 → 2 가 red.
    - 보정 A 를 되돌려 선택된 모델만 전송 → 5 가 red.
    - **touched 가드는 유지한 채** 비교 대상만 스냅샷 → 라이브 `groups` 로 교체
      → 6·7 이 red. 이걸 잡으려면 "건드렸다가 되돌린 필드 + 그 사이 서버가 값을
      바꿈" 시나리오가 필요하다. 사용자의 값이 양쪽 모두와 다른 케이스로는
      두 비교가 같은 답을 내므로 탐지되지 않는다.
    - 값 비교를 문자열 비교로 되돌리면 → 7 의 재포맷 케이스가 red.
      provider default 와 per-model 이 별개 분기이므로 양쪽 다 케이스가 있어야 한다.
    - default 검증을 무조건 실행하도록 되돌리면 → 8 의 untouched-unsafe 케이스가 red.
    - management 의 `Number.isSafeInteger` 를 `Number.isInteger` 로 → 8 이 red.
    - GUI 파서의 `Number.isSafeInteger` 를 되돌리면 → 8 의 GUI 절반이 red.
    - `Object.keys(group.modelContextWindows ?? {})` 를 목록에서 제거 → 9 가 red.

## GUI 게이트

이 PR 은 **실제로 GUI 를 바꾼다.** 저장소 게이트가 요구하는 UI 스크린샷을
본문에 포함해야 하고, `gui` 언급을 피해서 우회하면 안 된다. PR #1203 이 이미
`docs-site/public/pr-screenshots/1073-context-window-controls.jpg` 를 갖고 있으므로
cherry-pick 하면 따라온다.

`bun run lint:gui` 와 `bun run build:gui` 가 필요하므로 `cd gui && bun install`
선행.
