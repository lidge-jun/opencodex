# 020 — wp2: #4384 carry (빈 XDG_DATA_HOME 폴백을 호스트 홈에 고정)

- 원 PR: https://github.com/lidge-jun/opencodex/pull/4384 (`luvs01`, draft)
- 원 head: `fdba29bc1ae1cf262430764221312d729476a551`, base `dcd13b435` (현재 `dev`보다 1커밋 뒤)
- patch: `.tmp/research/4384.patch` (sha256 `662d9993bb262009accc93248338e40960c301a81b8d221656fb0d813f265eaf`)
- apply 검증: `git apply --check` EXIT 0, offset 0, 1파일

## 왜 아직 필요한가

프로덕션은 이미 맞다. `src/oauth/devin-cli.ts:80`이 빈 `XDG_DATA_HOME`일 때
`homedir()`로 폴백한다. 깨지는 건 테스트뿐이다.

`tests/providers/devin-cli-login.test.ts:155`가 결과 경로에 `startsWith("/")`를 건다.
Windows 러너에서 폴백 경로는 `C:\Users\runneradmin\...`이므로 항상 false다.
실제 실패 로그 (fork run, Windows job):

```text
D:\a\opencodex\opencodex\tests\providers\devin-cli-login.test.ts:155:40
Expected: true
Received: false
```

## MODIFY: tests/providers/devin-cli-login.test.ts

플랫폼 무관 단언으로 바꾼다. 경로 접두사를 문자열로 추측하지 말고 호스트 홈에 고정한다.

```ts
// before
expect(resolved.startsWith("/")).toBe(true);

// after
expect(resolved.startsWith(homedir())).toBe(true);
```

`homedir`는 `node:os`에서 import한다. 이것이 프로덕션 코드가 실제로 하는 일
(`src/oauth/devin-cli.ts:80`)과 정확히 같은 계약이므로, 테스트가 구현을 복제하는 것이
아니라 계약을 검증하게 된다.

## 범위 밖

같은 Windows job에 quota-policy 실패 2건이 함께 있었다. `#4384`의 범위가 아니며
이 carry에서 건드리지 않는다. 별도 단위로 남긴다.

## 커밋 메시지

```text
test(devin-cli): anchor the empty-data-dir fallback at the host home

Carry #4384 from fdba29bc1ae1cf262430764221312d729476a551 onto 7ca00ffe7.
The empty-XDG_DATA_HOME case asserted the resolved path starts with "/",
which is false on Windows where the fallback is C:\Users\<user>\...
Anchor the assertion at homedir() instead, which is the contract
src/oauth/devin-cli.ts actually implements.

Production behavior is unchanged; this is a test-only fix.

Local product tests / typecheck / build / install: NOT RUN.
Hosted exact-head CI on this PR is the merge proof.

Co-authored-by: luvs01 <27862058+luvs01@users.noreply.github.com>
```

## 착지 후

- #4384를 close하고 carry PR을 가리키는 코멘트를 남긴다.

