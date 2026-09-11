# ADR-0046 — Claude Desktop config-library resolution

- Contract owner: [clients/claude-desktop.md](../clients/claude-desktop.md#claude-desktop-config-library-resolution)

## Decision record

- 목적과 의도: 생성된 Claude Desktop 프로필이 설치된 Desktop이 실제로 읽는 디렉터리에 떨어지고, 대시보드 상태가 그 쓰기 대상과 일치하게 한다.
- 기존 구현 및 제약 조건: 두 호출자가 경로 계산을 각자 복제했고, Desktop이 실제로 참조하는 `CLAUDE_USER_DATA_DIR`와 Windows `LOCALAPPDATA` 분기가 빠져 있었다(#539). 사용자가 프로필 루트를 직접 지정하는 경우도 있다.
- 검토한 주요 대안: `-3p` 접미사를 구버전 잔재로 보고 제거; 두 디렉터리를 모두 스캔; 레거시 파일을 자동 이전; 크로스플랫폼 해석기를 한 곳에 둔다.
- 선택한 방식: Desktop 번들의 해석 규칙을 그대로 이식한 override 인지 해석기를 한 곳에 두고, 쓰기 경로와 상태 조회가 같은 함수를 쓴다.
- 다른 대안 대신 이 방식을 선택한 이유: `-3p`는 Desktop의 정상 동작이므로 제거는 회귀였다. 해석기를 한 곳에 두면 두 호출자의 드리프트가 불가능해지고, 파괴적 이전 없이 상태와 쓰기 대상이 일치한다.
- 장점, 단점 및 영향: 지원 플랫폼 전부에서 apply 결과가 Desktop에 보인다. 비표준 레이아웃 사용자는 문서화된 override를 써야 하고, 해석기는 Desktop 번들의 규칙 변경을 따라가야 한다.
