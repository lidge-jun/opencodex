# wp1 — #2429: the privacy scanner rejects its own test fixture

## Symptom

`gates` fails on #2429's head. The failing step is `Privacy scan`, not a test:

```
Privacy scan failed:
tests/test-runner.test.ts:42 email: test<at>opencodex.invalid
error: script "privacy:scan" exited with code 1
```

Every test shard, `macos`, and all three `npm-global` matrices pass. The only red checks
are `gates` and the two draft-checklist gates (`hygiene`, `enforce-target`), which are
process gates rather than code failures.

## Cause

The PR's test helper commits a fixture repository and needs a git identity to do it:

```ts
runGit(
  cwd,
  "-c", "user.name=OpenCodex Test",
  "-c", "user.email=test<at>opencodex.invalid",
  "commit", "-m", message,
);
```

`scripts/privacy-scan.ts` matches `/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi` across the
tree. The fixture address satisfies that pattern, and `.invalid` is not on the
allow-list, so the scanner is behaving correctly — the literal really is an email-shaped
string in a tracked file.

(This document writes the address as `test<at>opencodex.invalid` for exactly the same
reason the fix exists: quoting the literal verbatim would make this file trip the scanner
too. It did, on the first commit of this unit.)

This is not a false positive worth loosening the scanner for. The scanner's value comes
from having almost no exceptions; every added exception is a hole someone's real address
can later fall through.

## Design

Use the idiom the repository already uses for exactly this problem. `privacy-scan.ts` and
its own fixtures avoid self-matching by never writing an email as one literal:

```ts
["1", "gmail.com"].join("@")
["stranger", "third-party.example.org"].join("@")
```

So the fix is a join at the call site:

```ts
const TEST_COMMIT_EMAIL = ["test", "opencodex.invalid"].join("@");
```

The value handed to git is byte-identical, so the fixture commits exactly as before and no
test expectation changes. The scanner no longer sees an email literal because there is no
longer one in the source.

### Rejected alternatives

- **Add `tests/test-runner.test.ts` to the scanner's allow-list.** The allow-list currently
  holds two narrowly-argued entries (`a@b.com` in tests, a URL-userinfo fixture that reads
  as `pw@host`). Adding a whole file would exempt every future email added to it.
- **Allow the `.invalid` TLD globally.** `.invalid` is reserved and safe in principle, but
  the exemption would apply repository-wide and the scanner's job is to be boring, not
  clever.
- **Drop the git identity and rely on ambient config.** CI runners have no global
  `user.email`, so the fixture commit would fail. The identity is load-bearing.

## Verification

- `bun run privacy:scan` exits 0 locally.
- `bun x tsc --noEmit` clean.
- `gates` returns success on the pushed head.
- No local full-suite run: the user has forbidden it, and CI covers the shards.
