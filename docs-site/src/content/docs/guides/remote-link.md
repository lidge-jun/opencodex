---
title: Remote Link
description: Connect an OpenCodex Home computer to a Child computer over SSH.
---

A machine link connects an OpenCodex **Home** computer to a **Child** computer over SSH. The Home serves the Child through the SSH tunnel, while both computers keep their local OpenCodex service on port `10100`. The dashboard transfers the per-child link key through SSH, so you do not type a token.

## Requirements

- The Home computer can log in to the Child with an OpenSSH key.
- For a Child-initiated link, the Child can log in to Home with an OpenSSH key (password login is not supported).
- OpenCodex 2.66.0 or later is installed on the Child computer, and on Home for a Child-initiated link.
- Both computers run macOS or Linux.
- Links are started from the Home: its dashboard is opened on the Home computer itself (browser or desktop app, standalone install) or through a paired Hub session.

Password SSH and Windows are outside the current flow. Connecting a computer as a Child from the dashboard (a Child-initiated link) is not available in this release: joining restarts OpenCodex on that computer, which would drop the Codex connections already running there, so the dashboard shows the **Child** role as unavailable. Home-initiated linking is the supported path: on the computer that should be Home, choose **Home** and add the other computer as a Child, as described below.

## Add a Child from `#remote`

1. Open the dashboard at `#remote` and switch Remote Link on.
2. Choose **Home**, then **Continue**. The SSH host list opens.
3. Choose a host from the SSH candidates, or enter an SSH config alias.
4. Run the connection test and compare the offered host fingerprint with the fingerprint for the machine you intend to use. Comparing it helps detect a wrong host or a changed host key before SSH trusts the host.
5. Confirm the fingerprint, then connect the Child.

The dashboard does not ask you to enter a token. It probes the host first, and it cannot apply the link until you explicitly confirm the fingerprint.

## Link status

- **Connected** means the SSH tunnel is ready and the Child can use the Home link.
- **Reconnecting** means the tunnel is being retried. Requests can temporarily return `503` with `Retry-After` while the retry is in progress.
- **Failed** means the link needs attention. Check SSH authentication, the confirmed host key, forwarding, or the timeout reason shown in the dashboard.

A failed link does not silently switch to a local provider.

## Remove a Child

Select **Disconnect** for the Child and confirm the alias. The Home stops the tunnel, revokes that Child's link key, and removes the saved link record.

If the Home cannot reach the Child to run its disconnect command, choose **Remove here only**. This removes the local tunnel, key, and record. Then log in to the Child and run:

```bash
ocx disconnect
```

To disconnect a Child-initiated link, run `ocx disconnect` on the Child. It disconnects the client tunnel and revokes the link on Home over SSH. If Home revocation fails, it prints: `Home revoke failed; run ocx link revoke --link-id <linkId> on the home.`

## Troubleshooting

When a step fails, the dashboard shows the reason and, when SSH reported one, the last line of its error output under the message.

- **Could not connect to the SSH host**: the host must accept your SSH key without a password prompt; `ssh -o BatchMode=yes <alias> true` must succeed from a terminal. A `ProxyCommand` helper such as `cloudflared` must be installed in `/opt/homebrew/bin`, `/usr/local/bin`, `~/.bun/bin`, `~/.local/bin` or another directory on the PATH OpenCodex runs with.
- **ocx was not found on the remote computer**: OpenCodex looks for `ocx` on the PATH of a non-interactive SSH session first, then in `~/.bun/bin`, `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`. If it is installed elsewhere, add that directory to PATH in a file the remote shell reads for non-interactive sessions, such as `~/.zshenv` for zsh.
- **OpenCodex on the remote computer is too old**: run `ocx update` on that computer. Remote Link needs 2.66.0 or later.
- **The remote computer did not report an OpenCodex version**: `ocx --version` on that computer printed something else, for example the usage text of an unsupported Windows install.

## Security

The Child uses the Home computer's providers and provider credentials through the link. The Home creates a separate link key for each Child; removing the link revokes that key. Compare the host fingerprint before confirmation so a wrong machine or changed host key is not accepted by mistake. Dashboard sessions issued from a Tailscale identity cannot manage machine links.

## CLI reference

```text
ocx link port [--json]
ocx link issue --alias <alias> --tunnel-port <port> [--json]
ocx link status [--json]
ocx link revoke --link-id <id> [--json]
```

## Related guides

- [Remote Hub Deployment](/guides/remote-hub/)
- [Remote Workspace](/guides/remote-workspace/)
