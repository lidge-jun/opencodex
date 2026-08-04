# 040 — WP5: 전체 검증과 마감

선행: WP2(`010`), WP3(`020`), WP4(`030`) 전부.
상태: 계획.

## 왜 별도 사이클인가

앞의 세 사이클은 각자 자기 패키지 테스트만 돌린다. 이 유닛이 건드리는
`FilterVisibleRuntimeModels`와 `availableModels()` 계열은 `management`, `server`,
`codex`, `cli`, `test/parity`, `test/e2e`가 모두 소비한다. **전체 스위트와 라이브
재측정은 개별 사이클이 아니라 통합 지점에서 한 번 제대로 해야** 의미가 있다.

그리고 이 유닛의 핵심 주장("사용자 화면에서 미설정 프로바이더가 사라진다")은 단위
테스트로 증명되지 않는다. 테스트는 스텁 레지스트리를 쓰고, 실제 누출은 사용자의 진짜
설정(26 프리셋 vs 10 설정)에서 나왔다. 그러므로 **라이브 재측정이 이 유닛의 종결
증거**다.

## 절차

### 1. 정적 게이트

```
cd go
go build ./...
go vet ./...
go test ./... -count=1
```

`go test ./...`가 전체다. 개별 패키지가 아니라 전체를 돌리는 이유: `parity` 스위트가
관리 API 응답을 바이트 단위로 대조할 수 있고, 이 유닛은 최소 네 개 라우트의 응답을
바꾼다.

깨지는 파리티 테스트가 나오면 **자동으로 갱신하지 않는다.** 각각에 대해 오라클을 다시
읽고, "go가 틀렸으니 테스트를 고친다"인지 "내 변경이 틀렸다"인지 판정한 뒤 그 판정을
이 문서에 기록한다.

### 2. 라이브 재측정

현재 실행 중인 프록시는 이 워크트리의 코드가 아니다(`/Users/jun/.bun/bin/ocx`, 포트
10100). 사용자의 실행 중인 세션을 죽이지 않기 위해 **다른 포트에 별도 인스턴스**를
띄운다.

```
cd go && go build -o /tmp/ocx-scope-check ./cmd/...   # 실제 경로는 빌드 시 확인
/tmp/ocx-scope-check serve --port <빈 포트>            # 사용자의 10100은 건드리지 않는다
```

같은 `~/.opencodex/config.json`을 읽으므로 프리셋 26 vs 설정 10 상황이 재현된다.

```
GET http://127.0.0.1:<port>/api/models
  → 프로바이더 수가 26이 아니라 10 이하여야 한다
  → 응답에 등장하는 프로바이더 이름이 config.providers의 부분집합이어야 한다
GET http://127.0.0.1:<port>/api/selected-models
  → available 키 집합이 config.providers의 부분집합
GET http://127.0.0.1:<port>/api/claude-code
  → available과 aliases 어디에도 미설정 프로바이더가 없다
```

측정 전후를 같은 방식으로 찍어 **before 26 / after N**을 나란히 기록한다. after만
기록하면 필터가 죽어 있어도 그럴듯해 보인다.

측정이 끝나면 임시 인스턴스를 반드시 종료하고, 사용자의 10100 인스턴스가 그대로
살아 있는지 확인한다(teardown 영수증).

### 3. 커밋

각 work-phase는 자기 사이클에서 이미 로컬 커밋된다(DEV-GIT-COMMIT-01). WP5는 검증
증거와 문서 마감을 커밋한다. **push는 하지 않는다** — 사용자 승인 없이는 금지
(DEV-GIT-PUSH-01).

`devlog/`는 gitignore 대상이므로 문서를 남기려면 `git add -f`가 필요하다. 이 저장소의
관례를 커밋 직전에 `git check-ignore -v`로 확인하고, 강제 추가할 경우 스테이지된
경로를 눈으로 검사한다.

## 수용 기준

1. `go build ./...`, `go vet ./...`, `go test ./...` 모두 exit 0.
2. 라이브 `/api/models`의 프로바이더 집합이 `config.providers`의 부분집합.
3. before/after 측정치가 나란히 기록됨.
4. 갱신한 기존 테스트마다 오라클 근거가 문서에 있음.
5. 임시 인스턴스 종료 확인, 사용자의 10100 인스턴스 무손상.
6. `000_plan.md` §D의 보류 항목이 판정 완료 상태로 갱신됨.

## 남길 가능성이 높은 후속

- **네이티브 슬러그 형태 발산** — 선행 유닛 `260729_go_parity_chase/050`이 지목한
  bare(`gpt-5.6-luna`) vs namespaced(`openai/gpt-5.6-luna`) 문제. 세 라우트와 GUI 저장
  형태를 함께 봐야 하므로 별개 유닛이다.
- **`/api/claude-code` alias의 네이티브 표기** — 오라클은 `(native)` 표기와 전용 별칭
  헬퍼를 쓴다. 위와 같은 뿌리.

둘 다 D에서 goalplan work-phase 후보로 기록하되, 이 유닛의 종결 조건은 아니다.
