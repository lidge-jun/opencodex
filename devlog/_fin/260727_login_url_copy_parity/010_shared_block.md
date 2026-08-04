# 010 — 공용 LoginUrlBlock 컴포넌트 (wp1)

## 목표

로그인 URL 노출 + 복사 + 외부 열기를 한 파일이 소유한다. 현재 표면 A·B가
같은 JSX를 2벌 들고 있고 표면 C는 아예 없다. 소유자가 하나여야 다음 회귀가
세 갈래로 갈리지 않는다.

## Design Read (mini DESIGN.md)

```yaml
name: login-url-block
role: recovery affordance inside an OAuth waiting state
```

읽기: 로컬 프록시 관리 도구(D5~D6 밀도)의 **에러 복구 보조 표면**이다.
사용자는 이미 "브라우저가 안 열렸다"는 실패 상태에 있고, 목표는 URL을 다른
기기/브라우저로 옮기는 것 하나뿐이다.

- DESIGN_VARIANCE: 2
- MOTION_INTENSITY: 1
- 밀도 프로필: D5 (개발자·운영 도구)
- 근거: 실패 복구 경로에 시각적 변주를 넣는 것은 domain-wrong이다. 이 블록의
  성공 기준은 "URL을 얻어간다" 하나이며, 기존 대기 패널의 시각 언어를 벗어나면
  오히려 사용자가 새 UI를 읽는 비용을 문다.

Do: 기존 `.pwi-auth-url*` 시각 언어를 그대로 승계한다. 복사 결과를 말로 알린다.
Don't: 새 색/모션/아이콘 체계 도입 금지. 토스트 도입 금지(대기 패널 안에서 끝낸다).

### Lazy-User Gate (UX-LAZY-01)

이 블록의 결정 지점은 "복사" 하나다. 나머지는 결정이 아니라 정보다.

- do nothing: 서버가 이미 브라우저를 열어봤다(`openUrl`). 실패했을 때만 이 블록이 의미를 갖는다 → 렌더 조건은 `url`이 있을 때로 유지.
- delete: "URL 전문 표시"를 지울 수 있나? 못 지운다. 클립보드가 막힌 컨텍스트에서 유일한 탈출구다(`user-select: all`).
- absorb: 복사 실패를 시스템이 흡수한다 → 사용자에게 "실패했으니 알아서 하라"가 아니라 URL 전문을 이미 눈앞에 두어 수동 선택이 가능한 상태로 만든다.
- demote: 없음. 이 블록 자체가 이미 실패 상태에서만 의미를 갖는 종속 정보다.

### UX-STATE-01 — 에러/복구 상태 계약

복사 결과는 3-상태다. 실패를 조용히 삼키지 않고, 로그인 에러와 섞지도 않는다.

| 상태 | 라벨 키 | 의미 |
|------|---------|------|
| idle | `prov.copyLink` | 아직 누르지 않음 |
| copied | `prov.linkCopied` | 클립보드에 들어감 |
| unavailable | `prov.linkCopyUnavailable` | 클립보드 API 부재/거부 — URL 전문을 수동 선택하라는 신호 |

`unavailable`은 dead-end가 아니다. 바로 위에 URL 전문이 `user-select: all`로
있으므로 복구 경로가 화면에 남아 있다.

## 신규 파일 — `gui/src/components/login-url-block.tsx`

```tsx
import { useEffect, useRef, useState } from "react";
import { IconExternal, IconLink } from "../icons";
import { useT } from "../i18n/shared";
import { copyTextToClipboard } from "../oauth-health-display";

export type LoginUrlCopyState = "idle" | "copied" | "unavailable";

export function LoginUrlBlock({ url, className }: { url: string; className?: string }) { ... }
```

- props는 `url` 하나(+ 선택적 `className`). 상태·타이머·i18n을 컴포넌트가 소유한다.
  호출부가 복사 상태를 들고 있을 이유가 없다 — 표면 A·B의 `linkCopyState`,
  표면 C의 `ui.copied`가 전부 사라진다.
- `url`이 빈 문자열이면 `null`을 반환한다. 호출부 조건문을 단순화한다.
- 타이머는 `useRef<ReturnType<typeof setTimeout> | null>`. 클릭할 때마다
  `clearTimeout` 후 재설정, 언마운트 시 정리. 이유: 같은 outcome을 연속으로
  누르면 functional-update 가드로는 앞 타이머가 뒤 라벨을 지운다(5919779d 감사 결론).
- **`url`이 바뀌면 복사 상태를 `idle`로 되돌리고 대기 중인 타이머를 취소한다**
  (`useEffect(..., [url])`). A 감사 blocker #1: 표면 A는
  `Providers.tsx:210`의 `key={item.name}`로 리마운트되어 우연히 안전하지만,
  표면 B(`AddProviderModal.tsx:253`)에는 그런 key가 없다. 지금은 복사 상태가
  pane 지역 상태라 무해하지만, 블록이 상태를 소유하는 순간
  "Claude 복사 → Back → Gemini 로그인" 경로에서 **Gemini URL 위에 '복사됨'이
  남는다** — 클립보드에는 Claude URL이 든 채로. 거짓 성공이다.
  호출부 `key={url}`이 아니라 컴포넌트 내부 effect로 해결한다. 상태를 소유한
  쪽이 그 상태의 무효화도 소유해야 한다(이 문서의 단일 소유자 논지 그대로).
- 라벨 span에 `aria-live="polite"`. 상태 전환을 스크린리더에 고지한다.
- 외부 링크 `prov.didntOpen`은 블록 내부에 포함한다. 표면 A·B가 지금 이 링크를
  블록 밖에 두고 있으나, "URL을 얻는다"라는 하나의 사용자 의도에 속하므로
  블록이 함께 소유하는 것이 옳다.

렌더 구조(기존 마크업/클래스 승계):

```tsx
<div className={`pwi-auth-url-wrap${className ? ` ${className}` : ""}`}>
  <code className="pwi-auth-url">{url}</code>
  <div className="pwi-auth-url-actions">
    <button type="button" className="btn btn-ghost btn-sm" onClick={copy}>
      <IconLink style={{ width: 13, height: 13 }} aria-hidden="true" />
      <span aria-live="polite">{label}</span>
    </button>
    <a href={url} target="_blank" rel="noreferrer" className="pwi-auth-open-link">
      <IconExternal style={{ width: 13, height: 13 }} aria-hidden="true" /> {t("prov.didntOpen")}
    </a>
  </div>
</div>
```

클래스명은 이번 단계에서 바꾸지 않는다. `pwi-` 접두사가 모달에서도 쓰이는
어긋남은 사실이나, 리네임은 CSS·테스트·세 표면을 동시에 건드리므로 이 루프의
목표(기능 동등성)와 섞으면 회귀 원인을 분리할 수 없다. 별도 항목으로 남긴다.

## 신규 테스트 — `gui/tests/login-url-block.test.tsx`

`gui/tests/provider-auth-login-copy-link.test.tsx`의 happy-dom + act 하네스를 재사용.

1. `url`이 주어지면 URL 전문이 DOM에 렌더된다.
2. 복사 클릭 시 `navigator.clipboard.writeText`가 그 URL로 호출되고 라벨이
   `prov.linkCopied`로 바뀐다.
3. 클립보드 API 부재 시 라벨이 `prov.linkCopyUnavailable`로 바뀐다(조용한 실패 금지).
4. 2.5초 창 안에서 같은 outcome으로 재클릭해도 뒤 클릭 피드백이 제 수명을 다한다
   (타이머 ref 회귀 가드).
5. `prov.didntOpen` 외부 링크가 `href={url}`로 존재한다.
6. `url=""`이면 아무것도 렌더하지 않는다.
7. **url A로 복사한 뒤 url B로 리렌더하면 라벨이 `prov.copyLink`로 돌아온다**
   (blocker #1 가드). 이 테스트는 effect를 지우면 실패해야 한다.

버튼은 라벨 텍스트가 아니라 `.pwi-auth-url-actions button` 구조로 조회한다.

## 범위 밖 (wp1)

- 표면 A·B·C의 호출부 변경 — wp2/wp3.
- CSS 클래스 리네임.
- 서버/`src/` 변경.

## 완료 기준

- `cd gui && bun x tsc -b` exit 0 — 단 이는 `src`만 덮는다.
  `gui/tsconfig.app.json`의 `include`는 `src`뿐이므로 **신규 테스트 파일의 타입은
  이 명령이 증명하지 않는다**(A 감사 #8). 테스트 타입 오류는 `bun test`에서만 드러난다.
- `cd gui && bun test tests/login-url-block.test.tsx` 전건 통과
- 컴포넌트를 되돌리면 신규 테스트가 실패한다(가드 실효 확인)
