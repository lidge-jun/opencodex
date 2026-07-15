# Foundations

## Color

색상 토큰은 역할을 나타낸다. 컴포넌트에서 hex 값을 직접 사용하지 않는다.

| 역할 | 토큰 | 라이트 | 다크 |
|---|---|---:|---:|
| 앱 배경 | `--bg` | `#ffffff` | `#212121` |
| 사이드바 | `--rail` | `#f9f9f9` | `#171717` |
| 기본 표면 | `--surface` | `#ffffff` | `#262626` |
| 올라온 표면 | `--raised` | `#f4f4f4` | `#303030` |
| 기본 텍스트 | `--text` | `#0d0d0d` | `#ececec` |
| 보조 텍스트 | `--muted` | `#6e6e6e` | `#a6a6a6` |
| 약한 텍스트 | `--faint` | `#707070` | `#9a9a9a` |
| 성공/활성 | `--green` | `#0a7d5c` | `#4ecb9d` |
| 경고 | `--amber` | `#9a4a08` | `#fbbf24` |
| 위험 | `--red` | `#b91c1c` | `#f87171` |

`--accent`는 기본 액션과 포커스에 사용한다. 활성 토글은 다크 모드에서 트랙과 핸들이
겹쳐 보이지 않도록 `--toggle-on-bg`와 `--toggle-dot-color`를 사용한다.

## Typography

### Font families

- `--font-ui`: 일반 UI, 제목, 본문, 버튼, 입력. Pretendard/Noto Sans KR/Apple SD Gothic Neo/Malgun Gothic을 포함해 한글 fallback을 보장한다.
- `--font-code`: 모델 ID, URL, 버전, 토큰 수, 로그, 코드. 숫자는 tabular 형태로 정렬한다.

외부 CDN 폰트를 사용하지 않는다. 프록시 관리 화면은 오프라인에서도 열려야 하고, 폰트
다운로드 실패가 레이아웃 이동이나 한글 누락으로 이어지면 안 되기 때문이다.

### Type scale

| 역할 | 클래스 | 토큰 | 크기 | 대표 용도 |
|---|---|---|---:|---|
| Micro | `.text-micro` | `--text-micro` | 10px | 매우 작은 상태 배지 |
| Caption | `.text-caption` | `--text-caption` | 11px | 메타데이터, 보조 수치 |
| Label | `.text-label` | `--text-label` | 12px | 필드 라벨, 표 헤더, 코드 |
| Control | `.text-control` | `--text-control` | 13px | 버튼, 메뉴, 필터, 알림 |
| Body | `.text-body` | `--text-body` | 14px | 본문, 카드 제목 |
| Subtitle | `.text-subtitle` | `--text-subtitle` | 16px | 모달 제목, 브랜드명 |
| Title | `.text-title` | `--text-title` | 20px | 페이지 제목, 주요 수치 |
| Display | `.text-display` | `--text-display` | 24px | 제한적인 대형 수치/빈 상태 |

굵기는 `regular(400)`, `medium(500)`, `semibold(600)`, `bold(700)` 네 단계만 사용한다.
행간은 `tight(1.2)`, `ui(1.35)`, `body(1.5)`, `relaxed(1.6)` 네 단계만 사용한다.

## Spacing

기본 단위는 4px이다.

| 토큰 | 값 | 토큰 | 값 |
|---|---:|---|---:|
| `--space-0-5` | 2px | `--space-1` | 4px |
| `--space-1-5` | 6px | `--space-2` | 8px |
| `--space-3` | 12px | `--space-4` | 16px |
| `--space-5` | 20px | `--space-6` | 24px |
| `--space-8` | 32px | `--space-10` | 40px |
| `--space-12` | 48px | `--space-16` | 64px |

컴팩트 컨트롤 내부는 4–8px, 카드 내부는 12–20px, 페이지 구획은 24–64px 범위를 사용한다.

## Radius and controls

| 토큰 | 값 | 용도 |
|---|---:|---|
| `--radius-2xs` | 4px | 작은 차트 셀, 포커스 보정 |
| `--radius-xs` | 6px | 칩, 작은 아이콘 표면 |
| `--radius-sm` | 8px | 입력, 메뉴 항목, 작은 카드 |
| `--radius` | 12px | 기본 카드/패널 |
| `--radius-lg` | 16px | 모달 |
| `--radius-round` | 50% | 점, 원형 아이콘 |
| `--radius-pill` | 999px | 버튼, 토글, segmented control |

컨트롤 높이는 `28/34/40/44px` 단계다. 44px는 모바일 터치 영역에 사용한다.

## Motion

- `--motion-fast: 120ms`: hover, border, color 변화
- `--motion-normal: 180ms`: drawer, toggle, 위치 변화
- `prefers-reduced-motion: reduce`에서는 transition과 animation을 제거한다.

모션은 상태 이해를 돕는 범위에서만 사용하며 장식 목적의 반복 애니메이션은 추가하지 않는다.
