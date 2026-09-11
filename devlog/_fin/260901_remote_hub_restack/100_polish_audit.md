# 최종 폴리싱 감사 — 노출 / 요청 / 롤백

요구사항: 기능을 켜지 않은 일반 사용자에게 **UI가 노출되지 않고**, **API 요청이
발생하지 않으며**, **로컬로 되돌리기 쉬울 것.**

세 축을 코드로 추적했다. 서버는 깨끗했고, 클라이언트에 실질 위반 세 건이 있다.
전부 이 스택이 도입한 것이고 `dev`에는 없다.

## 서버 — 위반 없음

머신 플레인 라우트(`/api/machine/*`)는 `src/client/machine-listener.ts`가
서빙하고, 그 리스너는 `src/client/runtime.ts`가 **연결된 클라이언트 롤에서만**
띄운다. standalone 프록시의 `src/server/index.ts`에는 해당 라우트가 아예 없다.

즉 standalone 사용자의 프로세스는 이 라우트를 열지 않는다. `AGENTS.md`의
optional-subsystem 원칙과 같은 모양이다 — 켜지 않으면 코드가 돌지 않는다.

## 위반 1 (요청) — 모든 부팅에서 나가는 discovery 요청

`gui/src/App.tsx:113-137`의 `useEffect`가 조건 없이 실행되고,
`gui/src/api-targets.ts:118-131`의 `discoverApiTargets()`가
`GET /api/machine/status`를 친다.

standalone에서는 그 라우트가 없으므로 404가 돌아오고 `:126`이 standalone
타깃으로 폴백한다. 동작은 옳다. 그런데 **요청 자체는 나간다.** remote hub를
켠 적 없는 사용자의 브라우저가 매 로드마다 이 스택이 정의한 엔드포인트를
한 번씩 두드린다.

404 폴백은 "기능이 조용하다"가 아니라 "기능이 없다는 것을 매번 물어서
확인한다"이다.

## 위반 2 (노출) — 전체 페이지가 discovery 결과 뒤로 밀린다

`gui/src/App.tsx:390-393`이 페이지 본문 전체를 `targetsSettled` 뒤에 둔다.
정착 전에는 `connection.discovering`("로컬 및 공유 대상을 확인하는 중…")
배너만 보이고, 대시보드도 프로바이더도 로그도 렌더되지 않는다.

standalone 사용자에게 이건 자기가 쓰지 않는 기능의 로딩 문구다. 그리고
`dev`의 App에는 이 게이트가 존재하지 않는다 — 스택이 만든 것이다.

## 위반 3 (노출) — discovery 실패가 대시보드 전체를 대체한다

같은 곳 `:392-393`. `targetError`면 본문 전체가
`connection.machineUnavailable`("로컬 머신 연결을 사용할 수 없습니다. 공유
요청을 로컬로 우회하지 않았습니다.")로 대체된다.

`discoverApiTargets`는 fetch가 **throw할 때** 에러를 던진다(`:123-125`).
프록시가 재시작 중이거나 잠깐 느리면 standalone 사용자가 대시보드 대신
원격 플레인 이야기를 하는 에러 화면을 본다. 자기가 켠 적 없는 기능 때문에
쓰던 화면을 잃는 것이다.

## 롤백 — 재검증 대상

`disconnect`의 원상복구 계약은 wp4에서 이미 한 번 고쳤다(process 소유
journal을 충돌로 오독해 연결이 갇히던 문제). 이번 사이클에서 부분 복구가
조용히 성공으로 보이지 않는지 재확인한다.

## 방향

서버가 이미 GUI HTML에 세션 메타 태그를 주입한다(`src/server/gui-static.ts:69-75`).
같은 자리에 롤을 실어 보내면 클라이언트는 **묻지 않고도** 자기가 standalone인지
안다. 요청이 사라지고, 게이트가 사라지고, 에러 화면이 사라진다.

standalone은 아무것도 하지 않는 것이 기본값이어야 한다. 지금은 아니라고
확인하는 절차가 기본값이다.
