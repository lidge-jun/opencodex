# 020_layer2_initialize_flag.md — wp2: sibling flag in initialize.ts

New work in this unit. Branch `codex/c-track-initialize-flag`, base
`codex/c-track-atomic-write`.

## Why this layer exists

wp1 fixes the two writers in `atomic-write.ts`, but
`publishInitialConfigNoReplace` in `src/config/initialize.ts` still opens its
temp file with the same numeric spelling. Independent inspection confirms the
identical Bun/Windows exposure: first-run `ocx init` fails before writing or
publishing `config.json`, leaving `publication = "not-published"` and
`hardLinkUnavailable = false`, so the CLI prints "Initial config publication
did not finish." and exits 1.

It also sits between the two carried PRs deliberately. #3896 inserts a line
immediately after this `openSync` call, so building wp2 first means the
adjacent-hunk overlap is resolved once, while carrying #3896 in wp3. This is a
chosen construction order rather than a semantic prerequisite: #3900 does not
touch this file at all, and either change could be written first.

## Change (MODIFY)

`src/config/initialize.ts`

```diff
 import {
-  closeSync, constants, fchmodSync, fstatSync, linkSync, lstatSync,
+  closeSync, fchmodSync, fstatSync, linkSync, lstatSync,
   openSync, unlinkSync, writeFileSync,
 } from "node:fs";
@@
-    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
+    fd = openSync(temp, "wx", 0o600);
```

`constants` is referenced only by the import and that one expression, so the
import entry is removed with it.

## Change (MODIFY, regression)

`tests/windows/windows-secret-acl.test.ts` gains a sibling source-oracle test
next to the wp1 guard, asserting exactly one portable call in
`src/config/initialize.ts`.

## Contract preserved

The no-replace publication contract does not depend on the numeric spelling:
hardening, `verifyPrivateTemp`, the single `linkSync` publication with its
`EEXIST`/`collided` and `hardLinkUnavailable` handling, and the
descriptor-owned `removeOwnedTemp` cleanup are all unchanged.

## Out of scope: the same pattern under `src/lab/`

An independent scan found three more exclusive opens sharing this combination:
`src/lab/ledger/store.ts:153` and `:185` (recovery mutex, ledger lock) and
`src/lab/public/private-file.ts:209` (private publication temp). They deserve the
same portability follow-up, but Lab is an opt-in subsystem off the core request
path, so they stay out of this track rather than widening a config-surface fix.

Two further matches are not exclusive opens and must not be swept in:
`src/codex/native-main-lock-file.ts:89` and `src/lab/fabric/scratch.ts:416`. The
read/write sites in `src/lab/artifacts/secure-fs.ts` need individual treatment because
`"wx"` would drop read access.

## Verification

Repository CI on the stack tip only. Local suite, typecheck, and build:
**NOT RUN** (owner instruction).
