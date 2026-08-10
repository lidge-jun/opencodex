# 000 — OpenCodex 저장소 용량 및 Git 인벤토리 분석

Date: 2026-08-01  
Work phase: research  
Target: OpenCodex 저장소 구조 및 `.git` 팽창 원인 측정

---

## 1. 현재 저장소 용량 스냅샷

OpenCodex 개발 워크스페이스의 전체 용량은 약 **1.9 GB**이며, 주요 디렉터리별 용량 구성은 다음과 같습니다.

| 디렉터리 / 항목 | 용량 | 성격 및 주요 구성 내용 |
| --- | --- | --- |
| **`.git`** | **718 MB** | Git 오브젝트 패크 (packfile 628MB, 7,500+ 커밋 히스토리) |
| **`docs-site/`** | **477 MB** | 공개 문서 사이트 (Astro, ECharts, Pretendard 폰트 97MB 등 node_modules 포함) |
| **`gui/`** | **262 MB** | React 기반 대시보드 UI (Vite, Rollup, Happy-DOM 등 node_modules 포함) |
| **`devlog/`** | **180 MB** | PABCD 계획/감사 문서 및 외부 참조 분석 소스 (`_chase/` 141MB 포함) |
| **`.tmp/`** | **146 MB** | RSS 메모리 모니터링 로그, CI/테스트 실행 시 생성된 임시 아티팩트 |
| **`node_modules/`** | **116 MB** | 루트 Bun / TypeScript 개발 및 테스트 도구 의존성 |
| **`src/` + `tests/`** | **~14 MB** | 프록시 런타임 소스 코드 및 자동화 회귀 테스트 전체 |

---

## 2. npm 사용자 배포 패키지와의 격차

일반 사용자가 `npm install -g opencodex` 또는 `npx opencodex`로 설치할 때 받는 실제 배포본(`npm pack`)은 다음과 같이 극도로 경량화되어 있습니다.

- **압축 패키지 크기 (`.tgz`)**: **7.5 MB**
- **설치 후 해제 크기**: **13.0 MB**
- **포함 항목**: `bin/` (CLI 진입점 24KB), `src/` (TypeScript 런타임 6.5MB), `gui/dist/` (빌드된 대시보드 1.8MB), `assets/`, `README.md`, `LICENSE`
- **제외 항목**: `.git` (718MB), `docs-site/` (477MB), `devlog/` (180MB), `.tmp/`, `tests/` 등 개발 전용 자산 전체

---

## 3. `.git` 팽창 원인 분석

1. **7,500회를 넘어서는 촘촘한 커밋 히스토리**
   - 개발 문서 중심 PABCD 루프 및 서브에이전트 감사/검증 과정에서 짧은 기간 동안 수천 건의 커밋이 쌓였습니다.
2. **개발 문서 (`devlog/_plan/`) 델타 누적**
   - 소스 코드뿐만 아니라 십여 개의 계획/조사 문서가 반복 수정되면서 Git 델타 객체가 축적되었습니다.
3. **참조용 외부 코드 및 임시 파일**
   - `devlog/_chase/` 하위 외부 참조 소스는 `.gitignore` 처리되어 Git 히스토리에 들어가지 않으나, 워크트리 용량을 차지합니다.
