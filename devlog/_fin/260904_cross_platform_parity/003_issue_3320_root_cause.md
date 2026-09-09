# 003 - Verified latent defect: Windows non-ASCII identity decode (candidate cause of #3320)

Verified against `dev` at `072df52eb` on 2026-09-04.
Revised after audit round 1: the causal link to #3320 is a CANDIDATE, not proven.
The reporter's SID evidence was collected after a local patch and repair, so it
does not establish the original registration shape. What follows is proven about
the CODE; the connection to that user's stock-v2.40.0 failure is not.

## Verdict

A real defect exists in the tree, and it is NOT where the issue title points.

The reporter's `<UserId>` is a SID (`S-1-5-21-...`). A SID is pure ASCII, so it
survives any code page, and `taskXmlDecodedValueEquals` (`src/service.ts:1992`)
matches it exactly. **The `<UserId>` comparison is correct and is not the bug.**

The defect is one layer up, in how the expected identity is ACQUIRED.

## The break point

`src/lib/windows-user-principal.ts:141`, and its async twin at `:156`:

```ts
stdout: result.stdout ? result.stdout.toString() : "",
```

`result.stdout` is a Buffer, and bare `.toString()` is UTF-8. The child is
`powershell.exe` (`windows-user-principal.ts:112`) with stdout piped, so Windows
PowerShell 5.1 encodes using the console output code page - CP949, CP936, CP932 -
not UTF-8. `$identity.Name` returns `DOMAIN\\account`. For a non-ASCII account
those bytes are not valid UTF-8, so the decode yields U+FFFD mojibake, and
`identityFromResult` (`:225`) freezes the corrupted string into the process cache
as `identity.name`.

The repository already owns the correct decoder for exactly this class of bug:
`decodeWindowsTextBytes` (`src/lib/windows-text.ts:101`), which tries UTF-16 with
and without BOM, then STRICT UTF-8, then the locale's legacy code page. This
module never calls it. The SID on the adjacent line is ASCII, so the corruption
is silent.

## What the defect would cause, conditionally

These are consequences of the CODE. Whether any of them produced the failure in
#3320 is not established; see the header.

1. `identity.name` is corrupt whenever the account name is non-ASCII. A
   SID-registered task still matches on the SID, so health survives. A
   SID-form task is therefore unaffected.
2. **A legacy name-form task becomes permanently unrepairable.** Versions through
   v2.39.0 wrote the account NAME into `<UserId>`. For a non-ASCII account the
   reported name is code-page mangled by schtasks AND the expected name is
   mojibaked by the UTF-8 decode - two different corruptions, so they never
   match. `windowsTaskRegistrationHealthy` returns false;
   `windowsTaskRegistrationRefreshableLegacy` (`service.ts:2202`) also rejects it
   because it DOES carry session triggers. Repair then throws "not a recognized
   legacy OpenCodex definition; it was preserved for manual review"
   (`service.ts:2948`) and changes nothing. A permanent dead end, and a plausible
   route to the reported symptom - but the reporter's original registration shape
   was never observed, so this remains a hypothesis.
3. `src/lib/windows-secret-acl.ts:565,583` compares against `identity.name` for
   ACL checks; a mojibaked name silently fails that compare. Consequences beyond
   "returns false" are unverified.

Normalization and case are NOT implicated. Case is already handled. NFC/NFD
normalization is absent on both sides but no evidence shows it triggering here,
so no claim is made.

## What #3134 did and did not cover

`b14b741dc` (#3134, shipped in v2.40.0) closed #3064. It added
`taskXmlLossyValueEquals` (`service.ts:2026`) and applied it ONLY to `<Command>`
and `<Arguments>` (`service.ts:2175`). The commit states the exclusion outright:
applying lossy comparison to `<UserId>` would let `MACHINE\<CJK>` match
`MACHINE\Admin`. That refusal is correct and must be preserved. #3134 also moved
new registrations from name form to SID form.

Not covered: the identity ACQUISITION decode, and any pre-existing name-form task
belonging to a non-ASCII account. No commit references #3320.

## The probe path is already correct

`src/service-manager-probe.ts` decodes through `decodeWindowsTextBytes` with an
explicit locale at `:651`, `:658`, `:674`, `:726`, `:864`, `:883`, `:945`. Nothing
there compares against a localized or non-ASCII string;
`windowsTaskListContains` (`:600`) compares only the ASCII task name.

Worth recording as latent, not active: `service.ts` and `service-manager-probe.ts`
use two different decoders for the same schtasks output. `decodeSchtasksOutput`
(`service.ts:902`) handles UTF-16 then falls back to plain UTF-8 with no code-page
branch. For `/query /xml` that is fine because the payload is UTF-16.

## Test coverage today

Covered: `tests/windows-text-decoding.test.ts` exercises CP949, CP936, CP932,
Big5, Windows-1252 and the refusal to guess CP1251 - but only against
`decodeWindowsTextBytes`, which the identity path never calls.
`tests/service.test.ts:643` pins that an explicit identity is never code-page
folded, using `MACHINE\\<CJK>`. `service.test.ts:2541` covers legacy name-to-SID
migration with a pure-ASCII `MACHINE\\installer`, so both sides match and the bug
cannot appear.

Not covered: every fixture in `tests/windows-user-principal.test.ts` uses
`EXAMPLE\\Owner`. No test anywhere feeds non-ASCII BYTES through the principal
runner, and the injected-runner seam hands over a pre-decoded `string`, so the
`Buffer.toString()` boundary is structurally untestable through the current seam.
That seam gap is itself part of the fix.

## Conditional reproduction

This is the reproduction the code PREDICTS, not one that has been executed
end-to-end against a reporter's machine. Non-ASCII account on a ko-KR host with
console code page CP949, holding an `opencodex-proxy` task registered by v2.39.0
or earlier so `<UserId>` is name form. Run `ocx service` then
`ocx service repair` on current `dev`. Predicted: repair throws "preserved for
manual review" and changes nothing. Confirming this on a real host, or obtaining
pre-repair task XML from the reporter, is what would upgrade the #3320 link from
candidate to established.

Unit-level: give `defaultWindowsPrincipalRunner` a Buffer-returning seam, feed
CP949 bytes for `S-1-5-21-1-2-3-1001\r\nMACHINE\\<non-ASCII>\r\n`, and observe
`cachedCurrentWindowsIdentity().name` return U+FFFD instead of the account name.
