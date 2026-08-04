# 커스텀 모델 칩 — 설계 조사

> 2026-07-22 · 세션 019f86f8-f5d9-72a3-b968-e0d69b180c4f

## 1. 문제 정의

OpenCodex 대시보드 모델 페이지(`gui/src/pages/Models.tsx`)는 두 출처에서 모델을 가져온다.

- **네이티브 OpenAI**: `src/codex/catalog.ts`의 `NATIVE_OPENAI_MODELS` 하드코딩 배열
- **라우팅 모델**: 프로바이더의 live `/models` 엔드포인트 또는 config의 `models` 배열

새 모델이 출시되면(예: `gpt-5.7`, `qwen4-max`) 사용자는 다음 중 하나를 기다려야 한다.

1. OpenCodex가 `NATIVE_OPENAI_MODELS`를 업데이트
2. 프로바이더의 live `/models`가 새 모델을 포함
3. 직접 config 파일을 편집

이 간극을 메우는 UI가 **커스텀 모델 칩**이다. 사용자가 대시보드에서 바로 모델을 추가·편집·삭제할 수 있게 한다.

## 2. 현재 구조 분석

### 2.1 데이터 흐름

```
config.toml (OcxConfig)
  ├── providers[name].models[]        ← 정적 허용 목록
  ├── providers[name].liveModels      ← live /models 폴링 여부
  ├── disabledModels[]                ← 숨긴 모델 목록
  └── (신설) customModels[]           ← 커스텀 모델 정의
        ↓
src/server/management-api.ts
  GET  /api/models                    ← 네이티브 + 라우팅 합쳐서 반환
  PUT  /api/disabled-models           ← 토글 저장
  (신설) POST /api/custom-models      ← 커스텀 모델 추가
  (신설) PUT  /api/custom-models/:id  ← 커스텀 모델 수정
  (신설) DELETE /api/custom-models/:id ← 커스텀 모델 삭제
        ↓
src/codex/catalog.ts
  fetchAllModels()                    ← 커스텀 모델을 라우팅 모델과 합쳐서 반환
  nativeModelRows()                   ← 네이티브 행 생성
        ↓
gui/src/pages/Models.tsx
  groups[]                            ← 프로바이더별 그룹
  (신설) 각 프로바이더 내에 커스텀 모델 병합
```

### 2.2 기존 UI 패턴

| 패턴 | 구현 | 참고 |
|------|------|------|
| 모달 | `.modal-overlay` + `.modal-card` (liquid-glass) | v2HelpOpen 모달 |
| 셀렉트 | `<Select>` 컴포넌트 (`gui/src/ui.tsx`) | 컨텍스트 제한, 스레드 수 |
| 커스텀 입력 | `showCustom` + inline `<input>` + 적용 버튼 | 컨텍스트 제한 직접 입력 |
| 토글 | `<Switch>` 컴포넌트 | 모델 on/off |
| 카드 | `.card` + `.group-head` | 프로바이더 그룹 |
| 알림 | `<Notice tone="ok"|"err">` | 저장 결과 |

### 2.3 디자인 시스템 토큰

```
--font-ui: "OpenAI Sans", "Pretendard Variable", ...
--font-code: ui-monospace, ...
--radius-pill: 999px
--radius-lg: 16px
--control-sm: 28px
--text-control: 13px
--text-label: 12px
--text-caption: 11px
```

모노크롬 기반, black/white primary, pill 버튼, hairline 보더, flat 서피스.

## 3. Design Read

```yaml
---
name: opencodex-custom-model-chip
colors:
  primary: "light-dark(#0d0d0d, #ececec)"
  accent: "light-dark(#0d0d0d, #ececec)"
  background: "light-dark(#ffffff, #212121)"
typography:
  heading: { fontFamily: "var(--font-ui)", fontSize: "var(--text-subtitle)" }
  body: { fontFamily: "var(--font-ui)", fontSize: "var(--text-control)" }
  code: { fontFamily: "var(--font-code)", fontSize: "var(--text-control)" }
iconography:
  system: "inline-svg (기존 icons.tsx)"
  weight: "regular"
  domain: "library-subset"
---
```

**읽기**: dense admin/tool UI for developer/power-user, with OpenAI monochrome infra-console language.
기존 대시보드의 모노크롬·pill·hairline 문법을 그대로 따른다. 새 시각 언어를 도입하지 않는다.

Do's: 기존 모달/셀렉트/스위치 패턴 재사용, mono 폰트로 모델 ID 표시, pill 뱃지로 컨텍스트 윈도우 표시
Don'ts: 새 색상 도입, 그라디언트, glassmorphism 추가, 카드-인-카드 중첩

### Dial Setting

```
DESIGN_VARIANCE: 2
MOTION_INTENSITY: 1
Product density profile: D6
Reasoning: dense admin tool — 기능적 피드백만, 시각적 트릭 없음. 기존 대시보드와 동일 톤.
```

## 4. UX 플로우 설계

### 4.1 진입점 — 프로바이더 헤더 "+" 버튼

**각 프로바이더 그룹 헤더**의 "모두 켜기 / 모두 끄기" 버튼 왼쪽에 **"+"** 아이콘 버튼을 배치.
프로바이더 컨텍스트가 이미 헤더에 있으므로 모달에서 프로바이더를 다시 고를 필요가 없다.
프로바이더가 10개 넘게 쌓이는 환경에서 드롭다운으로 다시 고르는 건 불필요한 왕복이다.

```
┌─ alibaba-token-plan-intl  2/15 활성 ──────────────────────────────┐
│  ▾  alibaba-token-plan-intl  2/15 활성                            │
│                        [+ ] [모두 켜기] [모두 끄기]  [○ 350k 제한] │
│     ↑ 신규: 커스텀 모델 추가                                       │
│  [토글] alibaba-token-plan-intl/qwen3.8-max-preview               │
│  [토글] alibaba-token-plan-intl/glm-5.2                           │
│  ...                                                               │
└────────────────────────────────────────────────────────────────────┘
```

**네이티브 openai 그룹**에는 "+" 버튼을 표시하지 않는다 — 네이티브 모델은
`NATIVE_OPENAI_MODELS` 하드코딩 배열에서 오므로 사용자가 임의로 추가할 수 없다.

**"+" 버튼 스타일**: 기존 "모두 켜기/끄기" ghost 버튼과 동일한 `btn btn-ghost btn-sm`
클래스, 텍스트 대신 `+` 기호 또는 `IconPlus` SVG. `text-caption` 사이즈.
프로바이더 헤더의 우측 컨트롤 클러스터 맨 앞에 배치하여
"추가 → 전체 켜기 → 전체 끄기 → 컨텍스트 제한" 순서의 논리적 흐름.

**커스텀 모델 렌더링**: 커스텀 모델은 해당 프로바이더 그룹 안에 기존 모델과
동일하게 병합된다. `custom: true` 플래그로 행 우측에 편집/삭제 ghost 버튼 노출.
`namespaced` ID는 `<provider>/<model-id>` 형식으로 기존 라우팅 모델과 동일.

**요약 칩**: 페이지 상단(컨텍스트 제한 행 아래)에 "커스텀 N개" 텍스트 칩을
표시하여 전체 커스텀 모델 개수를 한눈에 파악 가능하게. 클릭 시 첫 커스텀
모델이 포함된 프로바이더 그룹으로 스크롤 (선택적, v2에서).

### 4.2 추가 모달 (Add Custom Model)

프로바이더가 헤더 "+" 버튼에서 이미 결정되므로 모달에는 프로바이더 필드가 없다.
제목에 프로바이더 이름을 표시하여 컨텍스트를 고정.

```
┌──────────────────────────────────────────────┐
│  커스텀 모델 추가 — {provider}          [×]  │
│                                               │
│  모델 ID (엔드포인트 슬러그)                   │
│  ┌────────────────────────────────────────┐  │
│  │ qwen4-max-preview                      │  │
│  └────────────────────────────────────────┘  │
│  {provider}의 /models에 없는 슬러그를 입력     │
│                                               │
│  표시명 (선택, 슬래시 불가)                    │
│  ┌────────────────────────────────────────┐  │
│  │ Qwen 4 Max Preview                     │  │
│  └────────────────────────────────────────┘  │
│  슬래시(/) 불가 · 비우면 모델 ID 그대로 표시   │
│                                               │
│  컨텍스트 윈도우                               │
│  ┌────────────────────────────────────── ▾┐  │
│  │ 200k                                   │  │
│  └────────────────────────────────────────┘  │
│  (100k / 128k / 200k / 256k / 352k / 500k /  │
│   1M / 직접 입력…)                             │
│                                               │
│  입력 모달리티 (선택)                          │
│  [✓ text]  [  image]  [  audio]               │
│                                               │
│  ┌──────────────┐  ┌──────────────┐          │
│  │    취소       │  │    추가       │          │
│  └──────────────┘  └──────────────┘          │
└──────────────────────────────────────────────┘
```

**필드 검증 규칙**:

| 필드 | 필수 | 검증 |
|------|------|------|
| 모델 ID | ✓ | 빈 문자열 불가, 슬래시 포함 불가(프로바이더 접두사는 시스템이 붙임) |
| 표시명 | ✗ | 슬래시(`/`) 불가, 64자 이내 |
| 컨텍스트 윈도우 | ✗ | 양의 정수, 기본값 없음(비우면 프로바이더 기본값 따름) |
| 입력 모달리티 | ✗ | `["text"]` 기본, `image`/`audio` 추가 가능 |

**컨텍스트 윈도우 드롭다운 프리셋**:

사용자가 언급한 "캐싱 미포함 원래 지원값"을 기준으로, 실제로 많이 쓰이는 값들을 프리셋으로 제공한다.

```ts
const CONTEXT_WINDOW_PRESETS = [
  { value: 100_000,  label: "100k"  },
  { value: 128_000,  label: "128k"  },
  { value: 200_000,  label: "200k"  },
  { value: 256_000,  label: "256k"  },
  { value: 352_000,  label: "352k"  },  // 캐싱 포함 1M의 실제 non-cached 값
  { value: 500_000,  label: "500k"  },
  { value: 1_000_000, label: "1M"   },
];
```

"직접 입력" 선택 시 inline `<input>` + 적용 버튼 (기존 컨텍스트 제한 커스텀 입력 패턴 재사용).

### 4.3 커스텀 모델 행 렌더링

커스텀 모델은 **원래 프로바이더 그룹 안에 병합**된다. 별도 "커스텀" 그룹 카드를
만들지 않는다 — 프로바이더 컨텍스트가 이미 헤더에 있고, 사용자가 "+"를 누른
프로바이더 안에 바로 나타나야 직관적이다.

```
┌─ alibaba-token-plan-intl  3/16 활성 ──────────┐
│  [토글] alibaba-token-plan-intl/qwen3.8-max... │
│  [토글] alibaba-token-plan-intl/glm-5.2        │
│  [토글] alibaba-token-plan-intl/qwen4-max...   │  ← 커스텀
│         [커스텀] pill 뱃지  [편집] [삭제]       │
└────────────────────────────────────────────────┘
```

커스텀 모델 행은 기존 행과 동일 레이아웃이되, 우측에 `[커스텀]` pill 뱃지 +
`[편집]` `[삭제]` ghost 버튼이 추가된다. pill 뱃지는 기존 `contextCapped`
뱃지와 동일한 타일(`padding: 1px 6px; border: 1px solid var(--border);
border-radius: var(--radius-pill); text-caption`).

### 4.4 편집·삭제

커스텀 모델 행에 hover 시 `[편집]` `[삭제]` 버튼 표시 (기존 행 레이아웃 우측에 ghost 버튼).

- **편집**: 추가 모달과 동일 폼, 값 pre-fill, 제목 "커스텀 모델 편집 — {provider}"
- **삭제**: inline confirm (기존 대시보드에 confirm 모달 패턴 없음 → 간단한 inline "삭제하시겠습니까? [예] [아니오]" 또는 window.confirm)

UX-LAZY-01 적용: 삭제는 되돌릴 수 없는 동작이므로 confirm 필수 (STRICT exemption).

### 4.5 빈 상태

커스텀 모델이 0개일 때 상단 요약 칩은 "커스텀 0개" 또는 아예 숨김.
각 프로바이더 헤더의 "+" 버튼 자체가 빈 상태의 CTA 역할 —
사용자가 이미 해당 프로바이더를 보고 있으므로 추가 행동을 유도할 필요 없음.

## 5. 데이터 모델

### 5.1 Config 스키마 확장

```ts
// src/types.ts — OcxConfig에 추가
interface OcxCustomModel {
  /** 고유 ID (UUID 또는 provider/model-id 조합) */
  id: string;
  /** 프로바이더 키 (기존 providers[name]) */
  provider: string;
  /** 모델 슬러그 (프로바이더 접두사 없는 bare id) */
  modelId: string;
  /** 인간 가독 표시명 (선택, 슬래시 불가) */
  displayName?: string;
  /** 컨텍스트 윈도우 (토큰) */
  contextWindow?: number;
  /** 입력 모달리티 (선택, 기본 ["text"]) */
  inputModalities?: string[];
  /** 추가 시각 (ISO 8601) */
  addedAt?: string;
}

// OcxConfig에 추가
customModels?: OcxCustomModel[];
```

### 5.2 API 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/custom-models` | 커스텀 모델 목록 |
| POST | `/api/custom-models` | 커스텀 모델 추가 (body에 provider 포함) |
| PUT | `/api/custom-models/:id` | 커스텀 모델 수정 |
| DELETE | `/api/custom-models/:id` | 커스텀 모델 삭제 |

모든 mutation 후 `refreshCodexCatalogBestEffort()` 호출하여 카탈로그 즉시 갱신.

### 5.3 카탈로그 병합

`fetchAllModels()`에서 커스텀 모델을 라우팅 모델 배열에 합친다.

```ts
// src/server/management-api.ts — GET /api/models
const custom = (config.customModels ?? []).map(cm => ({
  provider: cm.provider,
  id: cm.modelId,
  namespaced: `${cm.provider}/${cm.modelId}`,
  disabled: disabledSet.has(`${cm.provider}/${cm.modelId}`),
  custom: true,  // UI에서 편집/삭제 버튼 표시용 플래그
  displayName: cm.displayName,
  ...(cm.contextWindow ? { contextWindow: cm.contextWindow } : {}),
  ...(cm.inputModalities ? { inputModalities: cm.inputModalities } : {}),
}));
return jsonResponse([...native, ...routed, ...custom]);
```

### 5.4 ModelRow 인터페이스 확장

```ts
// gui/src/pages/Models.tsx
interface ModelRow {
  // ... 기존 필드
  custom?: boolean;        // 커스텀 모델 여부
  displayName?: string;    // 커스텀 표시명
}
```

## 6. 구현 단계 (예상)

### Phase 1: 백엔드 (config + API)

1. `src/types.ts` — `OcxCustomModel` 인터페이스 + `OcxConfig.customModels` 필드
2. `src/server/management-api.ts` — CRUD 엔드포인트 4개
3. `src/server/management-api.ts` — `GET /api/models`에 커스텀 모델 병합
4. `src/codex/catalog.ts` — `fetchAllModels()`에 커스텀 모델 포함

### Phase 2: 프론트엔드 (모달 + 렌더링)

5. `gui/src/pages/Models.tsx` — 프로바이더 헤더 "+" 버튼 추가
6. `gui/src/pages/Models.tsx` — 커스텀 모델 추가/편집 모달 컴포넌트
7. `gui/src/pages/Models.tsx` — 커스텀 모델 행 렌더링 (편집/삭제 버튼 + 커스텀 pill)
8. `gui/src/pages/Models.tsx` — 상단 요약 칩
9. `gui/src/styles.css` — 모달 폼 스타일 (기존 `.modal-*` 재사용 + 폼 필드 간격)

### Phase 3: i18n

10. `gui/src/i18n/ko.ts`, `en.ts`, `zh.ts`, `de.ts`, `ru.ts` — 커스텀 모델 관련 키 추가

### Phase 4: 검증

11. `bun test --isolate tests` — 기존 테스트 회귀 확인
12. 수동 검증 — 대시보드에서 추가/편집/삭제 플로우
13. 카탈로그 갱신 확인 — 추가 후 Codex 모델 피커에 반영되는지

## 7. UX 상태 매트릭스

| 상태 | 처리 |
|------|------|
| 로딩 | 기존 `loading` 스핀너 재사용 |
| 빈 상태 (커스텀 0개) | 요약 칩 숨김 또는 "커스텀 0개", 헤더 "+" 버튼이 CTA |
| 추가 성공 | `<Notice tone="ok">` + 모달 닫기 + 목록 갱신 |
| 추가 실패 (중복) | `<Notice tone="err">` "이미 존재하는 모델입니다" |
| 추가 실패 (검증) | 모달 내 필드 아래 inline 에러 메시지 |
| 삭제 confirm | inline "삭제하시겠습니까?" 또는 모달 내 confirm |
| 네트워크 오류 | `<Notice tone="err">` + 모달 유지 (입력값 보존) |

## 8. 접근성

- 모달: `role="dialog"`, `aria-modal="true"`, `aria-label`, Escape 키 닫기, 포커스 트랩
- 폼 필드: `<label>` + `htmlFor` 또는 `aria-label`
- 삭제 버튼: `aria-label="커스텀 모델 삭제: {displayName}"`
- 키보드: Tab 순서 논리적, Enter로 제출, Escape로 취소

## 9. 개방 질문

1. **live `/models` 중복 충돌**: 프로바이더의 live `/models`가 나중에
   같은 모델 ID를 반환하면? → 커스텀 항목을 우선 표시하고 중복 제거
   (커스텀 메타데이터가 live 메타데이터보다 우선).

2. **카탈로그 JSON 직접 주입**: 커스텀 모델을 `model_catalog_json`에 쓸지,
   런타임 메모리에서만 병합할지. → **권장**: 런타임 병합. 카탈로그 파일은
   Codex 바이너리가 읽는 포맷이므로 opencodex가 직접 쓰지 않는 것이 안전.

## 10. 참고: 기존 유사 패턴

- **컨텍스트 제한 커스텀 입력**: `showCustom` + inline input + 적용 버튼 → 동일 패턴 재사용
- **v2 스레드 커스텀 입력**: `showThreadsCustom` + inline input → 동일 패턴
- **콤보 추가 링크**: `+ 콤보 추가하기` → 텍스트 링크 스타일 참고
- **프로바이더 추가**: Providers 페이지의 추가 플로우 → 모달 폼 구조 참고
