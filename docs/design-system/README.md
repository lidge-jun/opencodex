# OpenCodex GUI Design System

OpenCodex 관리 GUI의 시각 언어와 구현 규칙을 정의한다. 목표는 화면마다 새 스타일을
만드는 것이 아니라, 같은 역할의 요소가 어떤 페이지에서도 같은 글꼴, 크기, 간격,
표면, 상태 표현을 사용하게 하는 것이다.

## 원칙

1. **역할이 값보다 먼저다.** `13px` 대신 `control`, `12px` 대신 `label`처럼 UI 역할을 선택한다.
2. **기계 데이터만 monospace를 쓴다.** 모델 ID, URL, 버전, 토큰 수, 코드에 한정한다.
3. **4px 그리드를 따른다.** 반복 간격은 spacing token을 우선 사용한다.
4. **상태에는 의미 색상을 쓴다.** 성공/활성은 green, 경고는 amber, 위험은 red다.
5. **라이트와 다크를 함께 설계한다.** 색상은 `light-dark()` 기반 semantic token으로 정의한다.
6. **새 의존성보다 네이티브 CSS를 우선한다.** 디자인 시스템은 런타임 라이브러리 없이 동작한다.

## 소스 구조

```text
gui/src/styles.css
├── semantic color tokens
├── spacing / radius / motion tokens
├── typography tokens and utilities
├── app shell and responsive rules
└── shared component styles

gui/src/ui.tsx
├── Switch
├── Notice
├── Select
└── EmptyState

docs/design-system/
├── README.md
├── foundations.md
├── components.md
└── contributing.md
```

실행 시점의 유일한 스타일 소스는 `gui/src/styles.css`다. 이 폴더의 문서는 해당 코드의
사용 계약을 설명하며, 토큰 값이 바뀌면 코드와 문서를 같은 변경에서 갱신해야 한다.

## 빠른 사용법

```tsx
<h2 className="text-title font-semibold">Models</h2>
<p className="text-body muted">라우팅 가능한 모델을 관리합니다.</p>
<code className="mono text-label">openrouter/gpt-5</code>
<span className="badge badge-green">active</span>
```

```css
.feature-row {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  transition: background var(--motion-fast);
}
```

## 문서 안내

- [Foundations](./foundations.md): 색상, 폰트, 크기, 간격, 반경, 모션
- [Components](./components.md): 버튼, 입력, 패널, 표, 배지, 토글, 내비게이션
- [Contributing](./contributing.md): 새 화면/컴포넌트 추가 규칙과 QA 체크리스트

## 관련 결정 기록

- [ADR 0004](../adr/0004-gui-toggle-contrast-and-nav-spacing.md)
- [ADR 0005](../adr/0005-gui-design-token-system.md)
