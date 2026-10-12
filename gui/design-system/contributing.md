# Design System Contribution Guide

## 새 UI를 만들기 전

1. `gui/src/ui.tsx`와 `gui/src/styles.css`에 같은 역할의 컴포넌트가 있는지 검색한다.
2. 기존 컴포넌트를 변형으로 확장할지, 새 컴포넌트가 필요한지 판단한다.
3. 새 값이 아니라 기존 semantic token으로 표현 가능한지 확인한다.
4. 새 토큰이 필요하면 최소 두 곳에서 재사용될 역할인지 설명하고 ADR 또는 Decision Log를 남긴다.

## 금지 규칙

- TSX에 숫자형 `fontSize`, `fontWeight`, `lineHeight`, `letterSpacing` 추가
- hex/rgb 색상을 페이지 컴포넌트에 직접 추가
- `borderRadius: 999`처럼 토큰을 우회하는 값 추가
- 한 화면만을 위한 새로운 폰트 family 추가
- 기존 `Switch`, `Select`, `.btn`, `.card`, `.panel`, `.badge`와 중복되는 컴포넌트 생성
- hover만 있고 keyboard focus가 없는 인터랙션 추가

## 허용되는 예외

차트 셀 크기, 가상화 row height, viewport 계산처럼 데이터/알고리즘에 종속된 값은 인라인으로
남길 수 있다. 다만 시각적 역할을 나타내는 값은 반드시 token을 사용한다.

## 권장 구현 예시

```tsx
<div className="panel">
  <div className="text-body font-semibold">설정 이름</div>
  <div className="muted text-control leading-body">설정 설명</div>
  <Switch on={enabled} onClick={toggle} label="설정 이름" />
</div>
```

## 검증 체크리스트

- [ ] 라이트/다크에서 텍스트와 상태 색상이 읽힌다.
- [ ] 페이지 제목, 본문, 라벨, 코드가 역할별 type token을 사용한다.
- [ ] 데스크톱과 760px 이하 viewport에서 overflow/clipping이 없다.
- [ ] hover, active, focus-visible, disabled 상태가 존재한다.
- [ ] 토글과 입력이 실제 상태를 변경한다.
- [ ] `bun run lint`가 오류 없이 끝난다.
- [ ] `bun run build`가 성공한다.
- [ ] Playwright 또는 Browser로 console error와 framework overlay가 없음을 확인한다.
- [ ] 시각 변경 시 전/후 또는 기준/구현 스크린샷을 `view_image`로 직접 비교한다.

## 리뷰 명령

```bash
rg -n 'font-size:\s*[0-9]|font-weight:\s*[0-9]' gui/src/styles.css
rg -n 'fontSize:\s*[0-9]|fontWeight:\s*[0-9]|lineHeight:\s*[0-9]' gui/src --glob '*.tsx'
rg -n 'border-radius:\s*[0-9]|borderRadius:\s*[0-9]' gui/src --glob '*.{css,tsx}'
cd gui && bun run lint && bun run build
```

첫 세 명령은 결과가 없어야 한다.

실제 로컬 API와 함께 화면을 확인할 때는 Vite의 opt-in proxy를 사용한다.

```bash
cd gui
OPENCODEX_PROXY_TARGET=http://127.0.0.1:10101 bun run dev --host 127.0.0.1
```
