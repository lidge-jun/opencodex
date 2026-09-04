# 002 - Measured: what the Muse Code CLI stores off macOS

The `meta-muse` provider is the only hard platform throw in the runtime
(`src/oauth/meta-muse.ts:136`). This document records what is known, what is
sourced, and what is still unmeasured, because the module's own contract is to
refuse any storage backend it has not verified (`meta-muse.ts:160`).

## What was measured on macOS (prior unit, not re-derived here)

`devlog/_plan/260903_muse_spark_plan_oauth/003` records the shipped shape:

- `~/.config/muse/auth.json` (0600) is a POINTER carrying no secret. Its
  `providers.meta` object declares `mechanism: "oauth"` and `storage: "keychain"`.
- The secret is a macOS Keychain generic-password item, service
  `ai.meta.dev.credentials`, account `meta`.
- Only `api_key` authenticates the Model API; `access_token` returns 401. The key
  matches `/LLM\|\d+\|[A-Za-z0-9_-]{10,}/`.

The important detail for this unit is that `storage` is a DECLARED field in the
pointer. The CLI tells us where it put the secret. That is the extension point:
a non-keychain host will declare a different value, and the module already
refuses unknown values rather than guessing.

## What the vendor documents for other platforms

Meta's quickstart documents installation for macOS and Linux only, through
`curl -fsSL https://dev.meta.ai/install.sh | bash`. There is no native Windows
installer; the documented Windows route is WSL2.

Consequence, and it reframes the whole task: **there is no native Windows Muse
CLI to import a credential from.** The current error message is wrong about the
reason. It blames the macOS Keychain when the real reason on Windows is that the
vendor ships no Windows CLI at all.

## Linux: sourced, NOT yet measured

Third-party setup writeups describe the Linux credential living in
`~/.config/muse/auth.json` and honoring `$XDG_CONFIG_HOME`, with the secret in
that JSON file rather than an OS keyring. That is plausible - it matches how the
pointer already declares its own backend - but it is **unverified**. No Muse CLI
install exists on this host (`~/.config/muse/auth.json` is absent, checked
2026-09-04), so the exact `storage` value a Linux install writes has not been
observed.

This is the single fact that gates wp1's Linux half. The module must not invent a
`storage` value. Two honest routes:

1. Implement the Linux branch keyed on the DECLARED `storage` value, accepting a
   file-backed secret only when the pointer says so, and keep refusing unknown
   values. If a Linux install declares `storage: "keychain"`, the refusal still
   fires and nothing is silently wrong.
2. Do not guess a specific value: accept the shapes we can validate structurally
   (a secret embedded in the pointer, or a sibling file the pointer names) and
   refuse everything else with a message that says what was found.

**Audit round 1 rejected both routes as premature (blocker 6).** The pointer
interface (`src/oauth/meta-muse.ts:58-60`) declares only `mechanism`, `storage`
and `user_email`. There is no path field and no inline-key field. Writing a reader
against fields nobody has observed is the unverified-credential path this module
refuses everywhere else, and no amount of structural validation makes an invented
schema measured.

So this unit ships neither route. Linux keeps refusing, with a message that states
the real reason instead of blaming the macOS Keychain. `010` implements that, and
`050` records the exact measurement that would unblock a Linux reader: a real
`~/.config/muse/auth.json` from a Linux install, with its `storage` value and, if
the secret is file-backed, the field naming the file.

## What wp1 must therefore deliver

- Windows: replace the misleading macOS-Keychain refusal with an accurate one
  that names WSL2 and the supported `META_MODEL_API_KEY` alternative. No WSL2
  pointer read: reachability was never measured, and a refusal that tells the
  truth is a fix while a guess is not.
- Linux: a refusal naming the unmeasured storage rather than the Keychain. No
  reader until a real pointer is measured.
- Neither platform may weaken the ToS consent warning, which is the CLI's only
  warning surface.
