# 080 — 감사 합성: GUI 전반 하드닝 (Hubble/sol, FAIL → 4수용 2반박)

| # | 심각도 | 지적 | 처분 |
|---|---|---|---|
| 1 | Med | docs 로스터 절이 반증된 inherit 경로 서술 | 수용 — 3로케일: settings.json 픽커 기본값 핀 + ocx-route 지시자 + placeholder model 인자로 재서술 |
| 2 | Med | "thinking disabled → effort 미전송"이 2.1.207 관측과 모순 | **부분 반박** — 관측은 클라이언트→프록시 와이어(항상 effort 탑재), docs 문장은 프록시→업스트림 번역 정책(thinking off면 reasoning 미부여, 의도된 서브에이전트 보호). 어댑터 유지, docs에 주어(프록시)를 명시해 모호성만 제거 |
| 3 | Med | ko inert 안내가 삭제된 컨트롤("위의 컨텍스트 크기 늘리기") 참조 | 수용 — 4로케일 전부 "설정 파일의 이전 방식 값" 표현으로 교체 (en/zh/de도 동일 결함) |
| 4 | Low | back-compat 주석 불완전 (alwaysEnableEffort/model, 요청 타입 통합 주석) | 수용 |
| 5 | Low | ClaudeCodeState의 미사용 model/modelMap 필드 | 수용 — 제거 |
| 6 | Low | 한국어 전문용어 + '모델 가로채기' 개명 권고 | **부분 반박** — '가로채기'는 사용자 명시 지시(금일)라 유지. min() 표기는 결과 중심 문장으로 완화 수용. manualEnv 셸 주석은 고급 블록 내 코드라 영문 유지 |

UX 기본값 채택: (1) 직접 설정하기(고급) = 닫힌 `<details>` 접이식, 빠른 시작 바로 아래
(2) 별칭 목록 = 프로바이더별 그룹 라벨 + 단일 스크롤 (3) 카피는 결과 우선.
검증 보고: 미사용 키 0/41 (4로케일), 관련 테스트 48 pass — c1 교차 확인.
