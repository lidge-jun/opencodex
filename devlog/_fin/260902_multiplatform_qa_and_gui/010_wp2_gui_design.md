# 010 — wp2: GUI 프런트 개선

## Design Read

```yaml
name: opencodex dashboard
colors:
  primary: light-dark(#0d0d0d, #ececec)
  accent:  light-dark(#0a7d5c, #4ecb9d)
  background: light-dark(#ffffff, #212121)
typography:
  heading: { fontFamily: system-ui, fontSize: var(--text-title) }
  body:    { fontFamily: system-ui, fontSize: var(--text-body) }
iconography:
  system: "custom inline SVG"
  weight: "regular"
  domain: "library-subset"
```

읽으면 이렇다: **로컬 프록시를 조작하는 개발자 도구**이고, 사용자는 자기
기계에서 반복적으로 이 화면을 연다. 랜딩이 아니라 계기판이다.

Do: 조용한 중립 표면, 한 개의 accent(초록)를 상태 신호로만, 밀도 높은 정보
배치. Don't: 히어로 타이포, 그라디언트 장식, 균등 3카드 그리드, 이모지 아이콘.

## 다이얼

```
DESIGN_VARIANCE: 3
MOTION_INTENSITY: 2
Product density profile: D8 (developer console)
```

근거: 개발자 콘솔이다. `cxc-dev-uiux-design` 다이얼 프리셋의
"Dashboard / SaaS admin" 3/2/5보다 밀도를 올린 이유는 이 화면이 프로바이더,
모델, 계정 풀, 로그를 동시에 다루는 전문가 제어 표면이기 때문이다.
"복잡하다"는 밀도이지 VARIANCE가 아니다.

## 이미 잘 되어 있는 것 (건드리지 않는다)

토큰 체계는 `light-dark()` 기반으로 정리돼 있고 accent는 하나다
(`--accent` + 상태색 green/red/amber/blue). 736px 접힘도 정상 동작한다.
`cxc-dev-frontend` FE-ONENOTE-01(단일 색조 도배)이나 FE-GRADIENT-01(그라디언트
남용) 위반이 없다. 이모지 아이콘도 없다. **재디자인 대상이 아니다.**

## 실측으로 찾은 결함 — 모바일 상단바 겹침

320px에서 CDP로 실제 기하를 측정했다:

```
.brand .ver              right = 245
.mobile-topbar-actions   left  = 206
```

39px 겹친다. 버전 배지 위에 전원 버튼이 올라앉는다.

원인은 flex 축소 사슬이 한 단계 일찍 끊긴 것이다. `.mobile-topbar .brand`는
`min-width: 0`을 가지고 있지만, flex 아이템이 콘텐츠 크기 아래로 줄어들려면
**그 아이템 자신이** `min-width: 0`을 가져야 한다. `.name`과 `.ver`는
`.brand`의 flex 아이템인데 그 선언이 없어 고유 너비를 유지했다.

## 수정과 그 대가

`.name`에 축소와 말줄임을 주고 `.ver`를 고정한다. 그런데 그것만으로는
부족했다 — 320px 예산은 44(메뉴) + 26(로고) + 56(배지) + 94(액션) + 간격이라
이름에 약 38px만 남아 `op…`로 잘렸다. 겹침을 고치고 가독성을 잃은 셈이다.

그래서 400px 미만에서 **배지를 숨긴다**. 배지는 드로어 브랜드에 중복돼 있고,
잘린 제품명보다 한 번 탭하면 보이는 버전이 낫다.

수정 후 측정: 이름 `right = 179`, 액션 `left = 206`. 겹침 없음.

## 검증 방법

CSS 문자열 검사만으로는 겹침을 잡을 수 없다. happy-dom은 레이아웃을 계산하지
않으므로 `getBoundingClientRect` 기반 테스트도 불가능하다. 그래서 두 층으로
나눈다:

1. **회귀 테스트** — 겹침을 만든 CSS 선언의 부재를 잡는다. 레드 선행 확인.
2. **CDP 실측** — 실제 브라우저에서 좌표를 재고 스크린샷을 `view_image`로 본다.

테스트는 원인을 지키고, 실측은 결과를 증명한다.

