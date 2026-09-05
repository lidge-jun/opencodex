# 084 — wp7 — 롤백 저널 삭제 CRUD

커밋 `e3f01df6f`, 22파일 +944/-9. PR #3477 → squash `413227888`.

툼스톤 append로 구현했다. `journal.jsonl` 재작성은 파일 헤더가 약속한 세 가지를 동시에
깨고, 툼스톤은 `appendFileSync` 한 번이라 불변식이 유지된다.

클라이언트별 최신 행은 서버가 409로 거절한다. UI가 `deletable`로 버튼을 감추지만 규칙의
원천은 라우트다 — admin-token 호출자에게는 GUI가 없다.

GUI 테스트가 컴포넌트보다 나중에 작성됐으므로 `RollbackHistory.tsx`를 HEAD로 되돌려
4 fail을 확인하고 복원해 15/15를 받았다. 비공허성을 사후에라도 증명하지 않으면 그 초록은
아무것도 말하지 않는다.

기존 테스트 하나가 의도대로 빨개졌다. `management-integration-routes.test.ts`가 저널 행의
키 집합을 정확히 고정하고 있어 `deletable`을 잡았다. 단언을 느슨하게 하지 않고 키 목록을
확장했다.

라이브 확인은 격리 홈(`CODEX_HOME`/`OPENCODEX_HOME` 분리)에서 했다. 처음에 홈을 완전히
격리하지 않아 사용자 `~/.codex`와 `~/.grok` 설정이 죽은 포트를 가리키게 됐고, 즉시
되돌렸다. 로컬 프록시를 띄우는 실험은 두 환경변수를 모두 격리해야 한다.
