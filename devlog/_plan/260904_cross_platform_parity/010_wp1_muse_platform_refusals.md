# 010 - wp1: meta-muse honest platform refusals

One PR. Base `dev`. Branch `codex/260904-muse-platform-refusals`.
Evidence: `002`. Revised after audit round 1 (FAIL, blocker 6).

## What the audit changed

The first draft accepted `storage: "file"` and "the path the pointer names". Both
were INVENTED. `MusePointer` (`src/oauth/meta-muse.ts:58-60`) declares only
`mechanism`, `storage` and `user_email` - there is no path field and no inline-key
field, and `002` itself records that no Linux pointer has ever been observed.
Writing a reader for fields nobody has seen is precisely the unverified-credential
path the module refuses everywhere else.

The XDG change was also wrong as drafted: making `XDG_CONFIG_HOME` authoritative
on ALL platforms would redirect the MEASURED macOS path whenever that variable
happens to be set, with no evidence the macOS CLI honors it.

So this phase ships what is actually provable: refusals that tell the truth.

## The change in one sentence

Replace the single `platform !== "darwin"` throw, which blames the macOS Keychain
on every platform, with per-platform refusals that state the real reason - and
keep refusing Linux until a real pointer is measured.

## What must not change

- The consent warning fires before any credential read (`meta-muse.ts:128-143`,
  audit-confirmed: it precedes platform selection).
- Import-only. Nothing spawns `muse login`.
- The `LLM|` grammar check, the `access_token` prohibition, the refusal of any
  unmeasured shape.
- `refreshMetaMuseToken` does not re-read storage.

## MODIFY `src/oauth/meta-muse.ts`

### 1. Windows gets a true refusal

```ts
if (platform === "win32") {
  throw new Error(
    "Meta does not ship a native Windows Muse Code CLI, so there is no Windows credential to import. "
      + "Install the CLI inside WSL2 and import there, or use the meta-model provider with your own key (META_MODEL_API_KEY).",
  );
}
```

### 2. Linux gets a true refusal, not a guess

```ts
if (platform !== "darwin") {
  throw new Error(
    "Meta Muse Code import is verified only on macOS. The Muse CLI runs on Linux, but the credential "
      + "storage it writes there has not been measured, and importing an unverified credential shape is refused. "
      + "Use the meta-model provider with your own key (META_MODEL_API_KEY).",
  );
}
```

This is a real fix even though Linux still refuses. Today's message tells a Linux
user their Keychain is the problem, which is false and sends them nowhere. The new
message states what is actually true and names the path that works.

### 3. XDG lookup is Linux-only and inert for now

Deferred with the Linux reader. When `002` is updated with a measured pointer,
the resolver lands with it and is gated to non-darwin platforms so the measured
macOS path cannot move.

## MODIFY `src/providers/registry.ts`

The `meta-muse` `note` says "macOS only". Make it precise: requires the Muse Code
CLI signed in on macOS; not available on Windows (no native CLI); Linux import is
not yet verified. No other field changes.

## Tests in `tests/meta-muse-oauth.test.ts`

The existing table at `:181` already asserts `{ platform: "linux" }` rejects, so
that case stays green. Added:

1. win32 refusal message names WSL2 and `META_MODEL_API_KEY`, and does NOT claim
   the macOS Keychain is the reason.
2. linux refusal message names the unmeasured storage and `META_MODEL_API_KEY`,
   and does NOT claim the macOS Keychain is the reason.
3. The consent warning is emitted before the throw on both refusal paths.

Focused run: `bun test tests/meta-muse-oauth.test.ts`.

## Acceptance

- `bun x tsc --noEmit` clean.
- The focused file passes; no existing case changes behavior.
- No code reads a pointer field that has not been observed.
- CI green.

## What this phase deliberately does not do

Ship a Linux credential reader. `050` records the measurement that would unblock
it: a real `~/.config/muse/auth.json` from a Linux install, with its exact
`storage` value and, if the secret is file-backed, the exact field naming the
file. That is a measurement task, not an implementation guess.

