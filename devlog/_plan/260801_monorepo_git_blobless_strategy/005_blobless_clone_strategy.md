# 005 — Hermes 및 대형 에이전트 모노레포 전략 대조 (Blobless Clone 중심)

Date: 2026-08-01  
Work phase: research / decision-locked  
Target: 자율 에이전트 모노레포의 Git 용량 관리 방식 대조 및 최적 전략 도출

---

## 0. 결정 고정 (Decision Locked)

**OpenCodex는 Hermes Agent 스타일의 단일 모노레포 + Blobless Clone (`--filter=blob:none`) 전략을 공식 확정합니다.**

- **기각된 안 A (Submodule 분리 - cli-jaw 스타일)**: `devlog`를 별도 저장소로 분리하는 방식은 브랜치 이동/병합 시마다 서브모듈 포인터 충돌(gitlink churn)을 유발하므로 채택하지 않습니다.
- **기각된 안 B (히스토리 재작성 - git-filter-repo)**: 기존 커밋 히스토리를 강제로 파괴하면 과거 PR 및 추적 가능성이 손상되므로 시행하지 않습니다.
- **채택된 안 (Hermes 모노레포 방식)**: 문서(`devlog`), 소스(`src`), 테스트(`tests`)를 단일 모노레포로 유지하여 원자적 커밋(Atomic Commit)을 보존하되, 클론 및 CI 시점에 `filter: blob:none`을 적용해 로컬 `.git` 용량을 최소화합니다.

---

## 1. 주요 에이전트 프로젝트 사례 비교

| 프로젝트 | 관리 구조 | 문제점 및 특징 | 선택한 해결 방향 |
| --- | --- | --- | --- |
| **OpenClaw** | 프록시 코어 + 공개 스킬 분리 | 히스토리에 과거 테스트 대용량 잔여물이 남아 200MB+ 유지 | 스킬/자산 저장소를 외부(`openclaw/skills`)로 완전히 분리 |
| **Hermes Agent** | 모노레포 (코어 + CLI + Web + Docs) | 짧은 기간 동안 2,700+ 커밋 폭증, 파일 개수 4,700+ 개 | 모노레포 구조를 유지하되, CI/개발 시점에 **Partial Clone** 활용 |
| **cli-jaw 계열** | 코드 + `devlog` 서브모듈 분리 | 기획 문서 커밋을 별도 repo로 분리하여 코드 `.git` 최소화 | `.git`은 가벼우나, 브랜치 이동 시 서브모듈 포인터 충돌(gitlink churn) 발생 |

---

## 2. 왜 Blobless Clone인가?

OpenCodex는 문서 퍼스트 PABCD 규율을 따르므로 기획 문서(`devlog/_plan/`), 프록시 소스(`src/`), 회귀 테스트(`tests/`)가 하나의 atomic 커밋으로 묶이는 이점이 매우 큽니다.

서브모듈 방식은 브랜치 이동이나 PR 작업 시 gitlink 포인터 충돌이 자주 일어나는 단점이 있습니다. Hermes 프로젝트처럼 **단일 모노레포를 유지하면서 Blobless Clone (`--filter=blob:none`)을 활용하는 전략**이 OpenCodex에 가장 적합합니다.

### Blobless Clone (`git clone --filter=blob:none`)의 장점

1. **로컬 용량 절감**: 과거 커밋의 실제 파일 본문(Blob) 다운로드를 생략하므로 초기에 `.git` 용량을 **700MB대에서 50~100MB 수준**으로 축소합니다.
2. **모든 Git 명령어 정상 동작**: Shallow clone과 달리 모든 커밋 히스토리, 브랜치, `git log`, `git status`, `git diff`가 완벽하게 동작합니다.
3. **온디맨드 자동 다운로드**: 과거 옛날 커밋의 특정 파일을 열거나 체크아웃할 때만 Git이 배경에서 해당 블롭을 자동으로 가져옵니다.
