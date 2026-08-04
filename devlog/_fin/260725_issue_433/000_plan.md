# 260725 #433 — quota cooldown 고착 (조사 · 근거 · 제약)

단일 work-phase 유닛. 이 문서는 조사와 근본 원인만 담는다. 구현 계약은
`010_probe_lease.md`에 있다 (LEXICO-SPLIT-01).

설계 이력은 `../260725_bug_sweep/010_wp1_quota_cooldown_433.md`, 외부 근거는
`../260725_bug_sweep/001_external_evidence.md` 참조.

## 증상

상위가 `usage_limit_exceeded`와 함께 며칠 뒤 reset 타임스탬프를 주면 프록시가 24h 상한까지
계정을 묶고, 계정이 회복돼도 재시작 전까지 모든 요청을 로컬 429로 차단한다.

## 근본 원인 (코드 확인 완료)

**1. weekly reset을 retry 지시처럼 취급** — `src/codex/routing.ts:151` `parseResetCooldownMs()`가
resetAt까지 남은 시간을 `clampCooldownMs()`(24h)로만 자른다.

**2. 자기 완결적 교착** — `routing.ts:474`가 하드 cooldown을 성공 응답에도 보존한다.
그런데 cooldown 계정은 `auth-context.ts:132`에서 선차단되어 요청이 나가지 않으므로
성공 응답이 생길 기회가 없다.

## 활성화 경로 (가장 중요한 확인)

수정이 의미를 가지려면 cooldown 계정이 auth 단계까지 도달해야 한다. `routing.ts:427`에서
대체 계정이 없으면 `hasConfiguredPoolAccount` 경로로 여전히 `selected`를 반환한다.

```ts
  if (isCodexAccountInCooldown(active, now)) {
    return hasConfiguredPoolAccount(config, active) ? { status: "selected", accountId: active } : { status: "none" };
  }
```

즉 #433의 실제 시나리오(단일 `__main__` 계정)에서 cooldown 계정이 선택되어
`auth-context.ts:132`의 차단 지점까지 온다. 여기서 lease를 발급할 수 있다.

독립 리뷰어도 이 경로를 확인했다. pool에 건강한 계정이 있으면 cooled 계정은 선택되지
않는데, 이는 의도된 동작이다.

## 제약

- `Retry-After`는 명시적 retry 지시이므로 리터럴로 존중한다. probe 대상이 아니다.
- 기존 테스트 `tests/codex-routing.test.ts:312`, `:806`이 "2xx는 하드 cooldown을 보존한다"를
  고정한다. 이 의미는 유지되어야 한다.
- `MAINTAINERS.md:22` 기준 보안 검토 대상이다. quota 우회 수단이 되어선 안 된다.

## 범위 밖

이슈 제안 3·4번(`ocx account clear-cooldown` CLI, cooldown 상태 가시화)은 CLI/GUI 표면이라
별도 유닛에서 다룬다.
