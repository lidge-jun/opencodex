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

The `agy` connector never edits an `agy` settings file. On Windows it writes the PowerShell 7 profile and
only an existing `.bashrc`; elsewhere it writes the existing bash and zsh profiles, or creates the one the
login shell names when neither exists. Google lists `agy` for macOS and Linux only, so the Windows path is
reported as untested.

## Target and the secret rule

`resolveGatewayTarget` in `src/integrations/gateway-clients/index.ts` asks `localInferenceDestination` for
the URL a local client dials and writes the fixed placeholder key `opencodex-local`. When that destination
requires a data-plane credential, the connect is refused with `requires-admission-token` before any file is
touched: OpenCodex never writes a real secret into a client file. A model selector must be one line of at
most 200 characters, otherwise `invalid-model`.

## Stash and restore

Every connect records what it replaced in `<config dir>/gateway-clients/<id>.json` (mode 0600): the original
bytes of each file (or that the file was absent), the directories it created, and the SHA-256 of what it
wrote. Disconnect then restores in one of three ways.

- **exact.** The file still equals what OpenCodex wrote, so the original bytes are written back, or the file
  and the directories OpenCodex created are removed when it did not exist.
- **path-wise.** The user edited the file since. Only OpenCodex's own entries are reverted: `gateway`,
  `models.defaultModelId` and `models.list` in the app settings, the marked block in a profile. Every other
  edit is kept, and an entry the user changed after connecting is left as the user set it.
- **none.** There is no record, or the file is already gone; nothing is changed.

Connecting again while connected keeps the first record, so disconnect still returns to the user's own
state. A settings file with comments, trailing commas or a non-object root is refused with
`unsupported-file` and left untouched, because it cannot be round-tripped.

## Which setting wins

Antigravity resolves the gateway as `admin_settings.json` over `AGY_LLM_GATEWAY_*` variables over the user
settings file. Status reports an organisation `admin_settings.json` that sets `gateway` and an
`AGY_LLM_GATEWAY_URL` in the environment OpenCodex itself sees, as `overrides`, without echoing values. A
connected client under an override is therefore reported with a warning rather than as working.

## Surfaces

`src/server/management/gateway-client-routes.ts` serves `GET /api/gateway-clients` and
`POST /api/gateway-clients/{id}/connect|disconnect`. A refusal is HTTP 409 with `{ok, code, message}`, an
unknown id is 404. The routes sit behind the ordinary management auth and origin checks, and a sibling
instance refuses the mutations. `ocx connect|disconnect antigravity|agy` and
`ocx connect antigravity|agy status` in `src/cli/gateway-client-command.ts` call those routes through the
running proxy and run the same connectors in-process when the proxy is not running. The dispatch branch sits
before the hub `connect` logic and the disconnect restart flow, which are about a remote hub and do not apply.
