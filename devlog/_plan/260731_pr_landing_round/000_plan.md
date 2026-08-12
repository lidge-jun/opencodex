# 000 — 검증 끝난 PR 4건 랜딩

어제 백로그 26건을 트리아지하면서 처분만 달아뒀다. 이제 그 중 실제로 태울 수 있는
것들을 dev에 올린다.

## 대상

| PR | 규모 | 내용 | 관련 이슈 |
|---|---|---|---|
| #736 | 7 files, +140 | Windows 서비스 상태를 locale 독립 요약으로 | #722 |
| #752 | 3 files, +94 | tray host를 셸 경계 너머로 띄워 소켓 상속 차단 | #733 |
| #743 | 4 files, +65 | discovery 경로에서 백슬래시와 `..` 거부 | #572 부분 |
| #610 | 3 files, +174 | `codex --version` 반복 spawn 중단 | #606 부분 |

#734는 뺐다. 런처 로직은 맞는데 `tests/bun-runtime.test.ts:74`가 macOS에서 깨진다.
`mkdtemp`가 준 `/var/...`와 `process.chdir()` 후 resolve된 `/private/var/...`를
비교하기 때문이다. 작성자에게 `realpathSync` 수정안을 코멘트했다.

## 앞선 검증과 지금의 차이

어제 검증은 `origin/dev = 350a07b82` 기준이었다. 그 사이 로컬 dev가 9커밋 앞서
나갔고, 그 중 하나가 devlog를 서브모듈에서 추적 파일로 전환하면서 **1668파일**을
바꿨다. `scripts/privacy-scan.ts`와 `tests/repo-hygiene.test.ts`도 그 안에 있다.

그래서 "어제 통과했다"는 근거가 못 된다. 현재 HEAD `2435b1149` 기준으로 다시
측정했고, 네 건 모두 여전히 CLEAN이다(#734도 CLEAN이지만 테스트가 깨져서 제외).

## 선행 블로커 — privacy 게이트가 이미 빨갛다

PR을 얹기 전에 기준선부터 확인했더니 **손대지 않은 dev HEAD에서 privacy:scan이
exit 1**이다.

세 건 모두 같은 파일에서 나온다:
`devlog/_fin/260730_devlog_publication_feasibility/030_wp3_wp4_execution_record.md`
의 84~86행이고, 종류는 각각 `token-looking`, `home-path`, `email`이다. 실제 값은
여기 옮기지 않는다 — 옮기는 순간 이 문서가 같은 이유로 스캔에 걸린다. 실제로 처음
이 문서를 쓸 때 값을 그대로 인용했다가 스캐너에 잡혔고, 그게 아래 예외가 파일 단위로
묶여 있다는 가장 좋은 증거였다.

실제 유출이 아니다. 그 파일의 "Proof the scanner is not dead" 절이 스캐너가 프로브를
잡아낸 **출력을 그대로 인용**한 것이고, devlog가 추적 파일이 되면서 스캐너가 자기
시연 기록을 다시 잡았다.

진짜 유출이 아니라는 게 중요한 게 아니다. **게이트가 exit 1이면 푸시가 안 된다.**
내 PR과 무관하게 지금 dev는 푸시 불가 상태고, 사용자 워킹 트리에서도 동일하게
재현된다.

`--no-verify`는 답이 아니다. 게이트를 우회하면 다음 사람이 진짜 유출을 밀어넣을 때도
막히지 않는다. 스캐너가 이 셋을 예외로 인정하도록 고치는 게 맞다.

`scripts/privacy-scan.ts`에 이미 같은 성격의 선례가 있다 —
`MAINTAINER_HOME_USERNAME`과 `DEVLOG_PLACEHOLDER_EMAILS`가 devlog 범위로 좁혀진
예외다. 커밋 `814fb3cda`("allow test-fixture sk- sentinels")도 같은 계열이다.

## 작업 격리

사용자가 GUI 로딩 계약 작업으로 25개 파일을 커밋 안 한 채 들고 있다. 메인 체크아웃
에서 머지하면 그 작업과 섞인다. 별도 워크트리에서 머지·검증하고 결과만 dev에
반영한다.

## 사이클 구성

- `010` — privacy 게이트 복구 (선행 조건)
- `020` — #736 + #752 + #743 스택 랜딩
- `030` — #610 랜딩
- `040` — PR/이슈 정리와 푸시

이슈는 랜딩된 코드에서 결함이 정말 사라졌는지 확인한 뒤에만 닫는다. #606과 #572는
부분 해결이라 닫지 않는다.
