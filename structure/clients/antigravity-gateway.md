# Antigravity Gateway Connect

OpenCodex points Google's official Antigravity clients at its own gateway so a user can run the desktop
app or the `agy` CLI through any provider OpenCodex routes. It is for a person on the machine that runs
the proxy. It does not use the client-integration store described in [integrations](integrations.md):
these clients are configured through Google's gateway settings, not through a provider catalog file.

## The two clients

| Id | What it is | Where the gateway setting lives |
| --- | --- | --- |
| `antigravity` | The desktop app (2.15 and newer) | the `gateway` block and `models.defaultModelId` in `~/.antigravity/settings.json` |
| `agy` | The command-line client (1.2.15 and newer) | a marked shell function in the bash, zsh and PowerShell profiles, exporting `AGY_LLM_GATEWAY_*` for `agy` only |

The `agy` connector edits shell profiles. On Windows it uses existing PowerShell 7 and Windows
PowerShell profiles, or creates the PowerShell 7 profile if neither exists. It also uses an existing
`.bashrc`. On macOS and Linux it uses existing bash, zsh and PowerShell profiles and creates the
active bash or zsh profile if needed. Google lists `agy` for macOS and Linux only, so the Windows
path is reported as untested.

## Target and the secret rule

`resolveGatewayTarget` in `src/integrations/gateway-clients/index.ts` asks `localInferenceDestination` for
the URL a local client dials and writes the fixed placeholder key `opencodex-local`. When that destination
requires a data-plane credential, the connect is refused with `requires-admission-token` before any file is
touched: OpenCodex never writes a real secret into a client file. `ocx connect antigravity --model` and
the Antigravity connect route accept a model selector of one line and at most 200 characters. The agy
connect command refuses `--model` with exit 2, and the agy connect route refuses a `model` field with
HTTP 400 `invalid-body`.

## Stash and restore

Connect keeps the original bytes (or records that the file was absent), directories it created,
and the applied or pending SHA-256 in `<config dir>/gateway-clients/<id>.json`. That record uses
owner-only permissions, including a protected ACL on Windows. Client files use ordinary atomic
replacement with inherited ACLs on Windows and retain their existing mode on POSIX.

The named restore destination must match the Antigravity settings path or a fixed agy profile
candidate under the user's home. Connectors explicitly resolve client symlinks and read regular files
up to 4 MiB. The named file's parent must resolve to its expected directory. The resolved file must
match the exact settings path or a fixed agy path for the same shell family under the canonical home.
Multiple agy profiles resolving to one file are updated once. The check runs before staging and again
before replacement or removal. New restore records also pin the resolved destination. If the file or its
resolved destination changes before replacement, the write is refused. Connect and disconnect use the
config-mutation lock, with the client lifecycle lock outside it on the CLI and management paths.

Disconnect reports one of three outcomes.

- **exact.** The file still equals what OpenCodex wrote, so the original bytes are written back, or the file
  and the directories OpenCodex created are removed when it did not exist.
- **path-wise.** The user edited the file since. Only OpenCodex's own entries are reverted: `gateway`,
  `models.defaultModelId` and `models.list` in the app settings, the marked block in a profile. Every edit
  outside those is kept, and a settings entry the user changed after connecting is left as the user set it.
  A profile block is removed whole, so an edit made inside its markers is not kept.
- **none.** There is no record, or the file is already gone; nothing is changed.

Reconnect keeps the first record while the client is connected. If the file was edited in between,
disconnect restores path-wise. Edits to fields that reconnect leaves alone survive. For example, if
only the gateway URL changed and the placeholder key stayed in place, reconnect sets the OpenCodex
URL again and disconnect restores the original gateway block.

Connect journals the replacement hash before editing the client file, so disconnect can recognise
the original and pending states after an interrupted write. A profile is read as UTF-8 without NUL
bytes or as BOM-prefixed UTF-16LE (used by Windows PowerShell 5.1 redirection). It is written back
in the same encoding. During disconnect, an untracked profile that cannot be resolved or read is skipped.
Recorded profiles are checked strictly. If a recorded profile cannot be decoded, disconnect refuses with
`unsupported-file` and keeps the recovery record. A settings file with comments, trailing commas
or a non-object root is refused with `unsupported-file` and left untouched.

`src/cli/uninstall-client-state.ts` disconnects every gateway client with a restore record before
removing config. The gateway context defaults to the current user and config directory even when
other teardown dependencies are supplied. Uninstall holds the lifecycle lock through both steps and
aborts removal on any refusal, leaving the failed client's record available for a retry. Retiring the
last record removes the restore directory when empty. Uninstall also clears an empty directory left
by an earlier restore and preserves unknown entries inside it.

## Which setting wins

Antigravity resolves the gateway as `admin_settings.json` over `AGY_LLM_GATEWAY_*` variables over the user
settings file. Status reports an organisation `admin_settings.json` that sets `gateway` and an
`AGY_LLM_GATEWAY_URL` in the OpenCodex process environment as `overrides` without echoing a
credential. An override set only in the Antigravity process is invisible to OpenCodex.

## Surfaces

`src/server/management/gateway-client-routes.ts` serves `GET /api/gateway-clients` and
`POST /api/gateway-clients/{id}/connect|disconnect`; `handleIntegrationRoutes` in
`src/server/management/integration-routes.ts` loads it on demand for that prefix, so
`src/server/management-api.ts` does not name it. Every note and override in a status carries a stable
`code` beside its English `text` or `detail` (`GATEWAY_NOTE_TEXT` in `types.ts` is the one English
source); the CLI prints the English, the dashboard tab translates the code, and an action's outcome is
rendered from `code`, `changed` and `restore` rather than from `message`. A refusal is HTTP 409 with `{ok, code, message}`, an
unknown id is 404. The routes sit behind the ordinary management auth and origin checks, and a sibling
instance refuses the mutations. `ocx connect|disconnect antigravity|agy` and
`ocx connect antigravity|agy status` in `src/cli/gateway-client-command.ts` call those routes through the
running proxy and run the same connectors in-process when the proxy is not running. The dispatch branch sits
before the hub `connect` logic and the disconnect restart flow, which are about a remote hub and do not apply.
