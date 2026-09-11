# 010 - wp1: meta-muse manual key entry off macOS

One PR. Base `dev`. Branch `codex/260904-muse-platform-refusals`.
Evidence: `002`. Revised after audit round 1 and implementation review rounds 1-3.

## Scope change, and why

The first two drafts of this phase shipped REFUSALS: Windows and Linux would fail
with an accurate message instead of the old inaccurate one blaming the macOS
Keychain. Audit round 1 had already cut a Linux credential READER, because the
pointer interface declares no path or inline-key field and writing against
invented schema is what `meta-muse.ts` refuses to do everywhere else.

Then the repository owner pointed out the thing both drafts missed: **the Muse
Code API key is visible in Meta's own developer console.** A user on Windows is
not out of options, they are out of an IMPORT path. Refusing the whole platform
because our importer cannot read its store, while the vendor hands the same key
to the user in a browser, reports a limitation of the importer as a limitation of
the platform.

So this phase now ADDS a capability rather than only correcting prose.

## The change

### `src/oauth/meta-muse.ts`

**Manual entry off darwin.** `loginMetaMuse` calls `manualKeyCredential`, which
fires `ctrl.onAuth` so the GUI renders its paste field, then awaits
`ctrl.onManualCodeInput`. This is the shape `kiro.ts:405` already uses when no
local token exists; resolving the flow first is load-bearing, because otherwise
the await blocks and the dashboard never receives a response.

**Two reasons, not one.** Windows and Linux are unavailable for different
reasons, and the instructions say which: Meta ships no native Windows build,
while the Linux CLI exists and only its credential storage is unmeasured.
Implementation review round 3 caught the collapsed version telling a Linux user
something false about their own machine.

**One validator for both origins.** `validatedMetaMuseCredential` does the
`LLM|` grammar check and the live `GET` against the Model API for imported and
pasted keys alike. A pasted key that skipped either would be a weaker credential
wearing the same provider id, and the difference would surface only as a 401
mid-session.

The macOS error strings are preserved VERBATIM. Extraction is a refactor, and a
refactor that quietly rewrites a user-facing error is a behavior change in
disguise (review round 3, blocker 3).

**A host with no paste surface still refuses**, naming `dev.meta.ai` and
`META_MODEL_API_KEY`. An empty paste refuses rather than storing a blank
credential.

**`refreshMetaMuseToken` preserves the origin.** `merged()`
(`src/oauth/index.ts:754`) keeps any source that is not `local-cli`, so returning
`local-cli` unconditionally would relabel a hand-pasted key as an imported one on
its first refresh. It now takes the existing credential and preserves `manual`.

### `src/providers/registry.ts` and `docs-site`

The note, the decision record, and the providers guide all described the provider
as import-only and macOS-only. All three now describe macOS import plus
Windows/Linux paste, and the consent warning says "the key you import or paste".

## What is deliberately NOT here

A Linux credential reader. `002` records that no Linux pointer has ever been
observed, and `050` records the four facts one would have to supply. Manual entry
makes that reader a convenience rather than a blocker, which is a better place
for it to sit.

A WSL2 bridge. Reaching into `\\wsl$\<distro>\...` needs distro enumeration and
a reachability probe, neither measured.

## Tests - `tests/meta-muse-oauth.test.ts`

1. Windows offers a paste field naming `dev.meta.ai`; the credential returns
   `source: "manual"` with `access === refresh`.
2. Linux offers the same field.
3. A pasted key still faces the grammar check, and a 401 still fails the login.
4. A host with no paste surface refuses with an actionable message.
5. An empty paste refuses rather than storing a blank credential.
6. The consent warning precedes every unsupported-platform path.
7. Refresh preserves `manual` and still reports `local-cli` for an imported key.
8. **No failure path echoes the credential**, across four cases: imported and
   pasted, each with a rejected (401) and an unreachable (socket) upstream,
   asserting absence from the error, the stack, `onProgress`, AND `onAuth`. The
   old single-case version only ever exercised the macOS path, so its name
   overclaimed once a second route existed (review round 3, blocker 4).

## Acceptance

- `bun test tests/meta-muse-oauth.test.ts` green.
- `bun x tsc --noEmit` clean.
- macOS import path byte-identical in behavior, including error wording.
- No credential value reaches a log, an error, or a callback payload.
- CI green.
