# 030 - wp3: Windows identity decode

One PR. Bases on wp2's head branch (stacked child).
Branch `codex/260904-windows-identity-decode`. Evidence: `003`.
Revised after audit rounds 1 and 2.

## Scope, after two audits

Round 1 rejected the legacy-task refresh widening as a security hole: matching
command and launcher does not prove the task is ours, and a different user's task
could have been silently re-registered.

Round 2 examined the replacement - resolve the reported name to a SID and require
equality with the current SID - and found it underspecified at a security
boundary: no API, no trusted execution channel, no SID validation, no rule for
prefixed, duplicated or mixed `<UserId>` elements, and a name flowing into a
command line is an injection surface. Round 2 did confirm the SID-equality IDEA
is sound (a mojibaked name resolving to a foreign account is safely rejected),
but sound-in-principle is not a specification.

Writing that specification means designing a trusted principal-resolution channel
(`LookupAccountNameW`, or a static trusted PowerShell command receiving the name
strictly as data), with fail-closed rules for every malformed XML shape
`src/service.ts:2117-2136` already guards. That is its own phase, and it belongs
with someone who can make the trust decision.

**So this PR ships the decode fix alone.** The auditor stated it is
independently correct, and it is the defect actually proven to exist in the tree.
The legacy migration moves to `050`.

## The defect

`src/lib/windows-user-principal.ts:141` and `:156` decode `powershell.exe`
stdout with a bare `Buffer.toString()`, which is UTF-8. Windows PowerShell 5.1
emits the console output code page, so a non-ASCII account name becomes U+FFFD
mojibake and is frozen into the process identity cache by `identityFromResult`
(`:225`).

Audit-confirmed: `decodeWindowsTextBytes` tries strict UTF-8 BEFORE the locale
code page (`src/lib/windows-text.ts:119-126`), so a UTF-8 host is unaffected. The
`<UserId>` comparison itself is correct - case-insensitive, no lossy folding
(`src/service.ts:1992-2000, 2135-2136`).

## MODIFY `src/lib/windows-user-principal.ts`

### 1. The runner seam carries bytes

```ts
export interface WindowsPrincipalLookupResult {
  success: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** Raw child stdout. Bytes, so the decode under test is the real one. */
  stdout: string | Uint8Array;
}
```

Audit-confirmed source-compatible: nothing outside the module reads `.stdout`,
and every test seam only CONSTRUCTS results (`service.test.ts:29`,
`responses-state.test.ts:124`, `lab-public-security-regressions.test.ts:229`,
`windows-secret-acl.test.ts`, `windows-user-principal.test.ts`,
`openai-provider-option-e2e.test.ts:283`, and the migration child fixture).

This widening is what makes the bug testable at all: the current seam hands over
an already-decoded string, so the `Buffer.toString()` boundary can never be
exercised. A fix without it ships untested.

### 2. Decode through the repository's own decoder, with an explicit locale seam

```ts
let principalLocaleForTests: string | undefined;

/** Test seam: pin the locale used to select the legacy code page. */
export function setWindowsPrincipalLocaleForTests(locale: string | null): void {
  // Same in-flight guard as the runner setters (:326-341): decoding happens
  // AFTER the async runner resolves (:311), so a locale swapped mid-lookup would
  // silently change that lookup's decode.
  if (asyncLookupInFlight) {
    throw new Error("Cannot change the Windows principal locale while a lookup is in flight.");
  }
  principalLocaleForTests = locale ?? undefined;
  // Same contract as the runner setters (:323-341): a successful identity is
  // returned from cache BEFORE any decode (:245-256, :296-299), so a locale
  // change that left the cache intact would silently re-assert the first decode.
  cachedIdentity = null;
}

function decodePrincipalStdout(stdout: string | Uint8Array): string {
  if (typeof stdout === "string") return stdout;
  return decodeWindowsTextBytes(
    stdout,
    principalLocaleForTests ? { locale: principalLocaleForTests } : {},
  );
}
```

The locale seam is REQUIRED, not a convenience. `decodeWindowsTextBytes` picks a
single legacy encoding from the active locale
(`src/lib/windows-text.ts:19-30, 70-77`), so one CI process cannot decode CP949,
CP932 and CP936 fixtures correctly without being told which to expect. Every
existing codec test already passes an explicit locale
(`tests/windows-text-decoding.test.ts:11,35,45`); this seam gives the principal
path the same determinism. Production passes nothing and keeps the ambient locale.

`defaultWindowsPrincipalRunner` returns the Buffer unchanged; the async runner
returns bytes rather than `Response.text()`; `identityFromResult` decodes before
splitting lines. `SID_PATTERN` and `sid.toUpperCase()` are untouched - the SID is
ASCII by construction, which is why the corruption was silent.

## What this fixes, stated exactly

The EXPECTED side of every identity comparison, and `identity.name` for the ACL
comparisons at `src/lib/windows-secret-acl.ts:565,583`. It does not rescue a
task already registered with a name-form `<UserId>`, because the REPORTED side is
separately mangled by schtasks. That migration is `050`.

## Tests

New `tests/windows-user-principal-nonascii.test.ts`, each guard driven RED first:

1. CP949 bytes for `S-1-5-21-1-2-3-1001\r\nMACHINE\\<hangul>\r\n`, locale seam
   pinned to `ko-KR`, yield the exact account name, no U+FFFD. RED today.
2. Same for CP932 with `ja-JP` and CP936 with `zh-CN`. Each case pins its own
   locale; without that the three fixtures are mutually exclusive in one process.
3. UTF-8 bytes decode identically under every pinned locale - the
   strict-UTF-8-first guard that keeps ordinary hosts unaffected.
4. ASCII `EXAMPLE\\Owner` is byte-identical before and after.
5. A string-returning legacy runner still works, proving the widened type is
   backward compatible.
6. A timed-out or failed lookup still throws `EACLIDENTITY`, unchanged.
7. The locale seam resets in `afterEach`, so no case leaks a locale into another
   file's expectations.

Focused run: `bun test tests/windows-user-principal-nonascii.test.ts`.
`tests/service.test.ts` is unchanged by this PR and needs no new case.

## Acceptance

- Each guard driven red before the fix; red output recorded in `004`.
- `bun x tsc --noEmit` clean.
- The PR references #3320 as a CANDIDATE cause and does not say `Closes`.
- CI green, Windows leg specifically.
