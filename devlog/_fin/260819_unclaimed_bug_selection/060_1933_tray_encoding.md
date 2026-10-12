# 060 — #1933: Windows tray registration misread as foreign/stale

Rank 5. Cheapest fix in the selected set.

## The title is a symptom string, not a diagnosis

"startup registration is foreign, stale, or points to missing package files" is
a single collapsed summary produced by `trayStatusFrom()`
(`src/tray/windows.ts:440-462`). It does not mean three things were checked and
one failed; it means one boolean went false.

## Failure mechanism

`runRegistry` / `runRegistryAsync` decode `reg.exe` output with
`encoding: "utf8"` (`src/tray/windows.ts:120-125`, `335-345`). Redirected
`reg query` emits the console ANSI code page, not UTF-8.

The reporter's username is `MötzJensen`. `ö` is `0xF6` in Windows-1252 and
decodes to `U+FFFD` under UTF-8. The round-trip check
`registered === state.runCommand` then fails, `registrationOwned` goes false,
and the stale summary is printed — even though regedit shows a correct,
well-formed, owned Run value.

**The write side is fine** (CreateProcess is UTF-16). Only the read is broken.

## This is a known class with an existing fix that was never wired here

`decodeWindowsTextBytes` (`src/lib/windows-text.ts:75`) already solves exactly
this for `schtasks` — that was #1573, and it ships with a `C:\Users\Jörg`
fixture in `tests/windows-text-decoding.test.ts`. The tray registry reader was
simply missed.

That is the argument for doing it now despite the low severity: a half-applied
fix for a known class is how the next site gets missed too.

## Fix shape

Capture a Buffer in `runRegistry`/`runRegistryAsync` and decode through
`decodeWindowsTextBytes`, the same helper the service probe uses.

**Files:** `src/tray/windows.ts`, `tests/` (new case reusing the existing
fixture shape).

**Known limitation to state, not hide:** `decodeWindowsTextBytes` does not
cover ja/zh code pages by design. This fix closes 1252 and CP949, not every
ACP. A fuller answer is `reg export` (UTF-16) instead of `reg query`, which is
a larger change and should be its own decision.

**Do not** loosen the foreign-Run refusal (`tray/windows.ts:587`) to make the
symptom go away. That check is correct; it is being fed corrupted input.

## Regression test

Feed Windows-1252 (and CP949) `reg query` bytes for a path like
`C:\Users\MötzJensen\.opencodex\opencodex-tray.vbs` through the tray registry
reader and assert
`parseWindowsTrayRunValue(...) === buildWindowsTrayRunCommand(...)`.

Today UTF-8-decoding those bytes makes
`windowsTrayRegistrationIsStale({ registered: true, registrationOwned: false })`
true. After the fix it must round-trip.

## Verification

```
bun test tests/windows-text-decoding.test.ts tests/windows-tray.test.ts
bun x tsc --noEmit
```

(The tray suite is `tests/windows-tray.test.ts` — an earlier draft of this doc
named a `tests/tray-windows.test.ts` that does not exist. Related files:
`windows-tray-restart-hardening.test.ts`, `windows-tray-run-limit.test.ts`.)

## Secondary UX gap worth a follow-up, not this fix

The GUI cannot repair this state: Install is hidden when `tray.stale`
(`gui/src/pages/startup-sections.tsx:195`), and Uninstall is shown but also
refuses on a mismatched parse (`tray/windows.ts:687`). So a user in this state
has no in-product action. Worth splitting into its own issue — a stale tray
should always offer a repair path regardless of why it is stale.

## Honesty note: the mechanism is proven, the attribution is inferred

The encoding **mechanism** is verified in code — the tray reads `reg.exe` as
utf8 while the service probe already routes the same output through
`decodeWindowsTextBytes`.

**Pinning this specific issue to it is an inference.** An audit lane checked
the thread: the reporter's GitHub *display name* is `Mötz Jensen`, the actual
profile path was never posted, and `C:\Users\MötzJensen` is reconstructed
rather than observed. The screenshots show the collapsed stale summary and a
German UI; the issue's own earlier review said they cannot distinguish a
foreign Run value from missing package files.

Consequence for whoever picks this up: make the fix on class-hygiene grounds
(the helper exists, the site was missed), but **do not close #1933 on it**
without asking the reporter for `ocx tray status --json` and the raw Run value.
If their profile path is pure ASCII, this is the wrong diagnosis and the issue
stays open.
