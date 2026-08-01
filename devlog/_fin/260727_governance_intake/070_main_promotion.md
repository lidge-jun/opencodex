# WP8 — 게이트를 main으로 승격

## 왜 필요한가

`pull_request_target`은 **기본 브랜치(main)의 워크플로 정의를 실행한다.**
dev의 `enforce-pr-target.yml`이 `ALLOWED_BASES = ["dev","dev2-go"]`로 바뀌어도
main이 옛 `EXPECTED_BASE = "dev"`인 한 실제 PR은 여전히 dev2-go를 거부한다.
c5의 마지막 조각("main 승격으로 실제 발효된다")이 이것이다.

## 형태

origin/main은 origin/dev의 조상이고 dev가 98커밋 앞선다 — fast-forward가
가능하다. 즉 승격은 머지 커밋 없이 `main`을 `b4a9fe5c`로 옮기는 일이다.

## 전제 (전부 충족되어야 진행)

1. dev HEAD `b4a9fe5c`에 대한 호스팅 CI(Cross-platform CI, Service lifecycle)
   success. **로컬 통과는 전제가 아니다** — 승격 대상은 원격 커밋이다.
2. main..dev 범위에 릴리스 파이프라인을 건드리는 변경이 있는지 확인.
   `scripts/release.ts`, `.github/workflows/release.yml`이 범위에 들어오면
   MAINTAINERS.md의 보안 리뷰 대상이므로 별도로 짚는다.
3. main으로 가는 98커밋에 미완결 작업이 섞여 있지 않은지 요약 확인.

## 절차

```
git fetch origin
gh run list --branch dev  # b4a9fe5c 두 워크플로 success 확인
git push origin b4a9fe5c:main   # fast-forward, main 로컬 체크아웃 없이
```

로컬 체크아웃을 dev에 둔 채 refspec으로 밀어 다른 세션의 워크트리를 건드리지
않는다.

## 수용 기준

- `git log --oneline origin/main -1` == `b4a9fe5c`
- main의 `enforce-pr-target.yml`에 `ALLOWED_BASES`가 있다 (원격 파일로 확인)
- main 푸시 후 트리거된 워크플로 상태 확인

## 하지 않는 것

브랜치 보호 설정은 승인받았으나 별도 단계다. main이 먼저 옳은 워크플로를
가진 뒤에 그 위에 required check를 거는 순서가 맞다.
