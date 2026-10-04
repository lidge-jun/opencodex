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
- The dashboard that adds a Child from Home is opened on Home itself or through a paired Hub session. Turning the current computer into a Child requires an operator-paired dashboard session; a credentialless local dashboard session cannot commit that routing change.

Password SSH and Windows are outside the current flow. A link can be started from either side: from the Home, as described next, or from the Child, as described in [Connect this computer as a Child](#connect-this-computer-as-a-child).

## Add a Child from `#remote`

1. Open the dashboard at `#remote` and switch Remote Link on.
2. Choose **Home**, then **Continue**. The SSH host list opens.
3. Choose a host from the SSH candidates, or enter an SSH config alias.
4. Run the connection test and compare the offered host fingerprint with the fingerprint for the machine you intend to use. Comparing it helps detect a wrong host or a changed host key before SSH trusts the host.
5. Confirm the fingerprint, then connect the Child.

The dashboard does not ask you to enter a token. It probes the host first, and it cannot apply the link until you explicitly confirm the fingerprint.

The Add Child sheet explains that the Child uses this Home's providers over SSH and lists the prerequisites above. Host aliases come from `~/.ssh/config` on the Home running OpenCodex, not necessarily the computer displaying the browser. If discovery succeeds with no hosts, add a `Host` entry like this, then choose **Rescan hosts**. You can also enter an existing alias manually; selecting or entering an alias enables **Test connection**. The sheet links to this guide.

```sshconfig
Host devbox
  HostName devbox.example.com
  User you
  IdentityFile ~/.ssh/id_ed25519
```

If discovery fails, the sheet shows **Could not load SSH hosts**, the available request reason and **Retry**, rather than claiming the host list is empty. A connection-test failure keeps its specific reason and sanitized SSH hint in the active sheet, not duplicated behind it. Check the reason, use the SSH diagnostic in Troubleshooting below when relevant, and retry. Rescanning keeps the entered alias but requires fresh fingerprint review before connecting.

## Connect this computer as a Child

On the computer that should use the Home's providers:

1. Open the dashboard at `#remote` and switch Remote Link on.
2. Choose **Child**. The SSH host list opens.
3. Choose the Home's SSH host, run the connection test, then compare and confirm its host fingerprint.
4. Read the notice and choose **Connect as Child**.

Connecting restarts OpenCodex on this computer. Codex turns that are already running finish first, and new requests can fail for up to a minute while it restarts. The dashboard then reloads by itself and shows the Child link. Codex keeps using `http://127.0.0.1:<port>/v1` on this computer, with no token and no environment variable to set: the local OpenCodex relays each request to the Home, which serves it with its own providers and accounts.

The Child waits for its configured port while the old process releases it. If a CLI-managed restart still fails, run `ocx start` on the Child and check `~/.opencodex/restart-handoff.log`. In the desktop app, the app starts and supervises the replacement automatically.

If **Child** says to pair this machine first, open this computer's configured literal-loopback HTTP dashboard, for example `http://127.0.0.1:<configured-port>`. The local pairing form appears only when pairing is missing and the dashboard and API use the same loopback origin. Copy the form's `ocx gui pair --origin "http://127.0.0.1:<configured-port>"` command, run it in a terminal on this computer, and paste the one-use code into the form. Use the exact origin shown in the form; a provider API key or admin token is not a pairing code. Missing pairing is separate from a configured-port mismatch.

The **Child** role also requires a standalone OpenCodex runtime running on its configured port, because the Child restarts on exactly that port. If the dashboard says OpenCodex is not running on its configured port, restart it there first.

## Link status

- **Connected** means the SSH tunnel is ready and the Child can use the Home link.
- **Reconnecting** means the tunnel is being retried. Requests can temporarily return `503` with `Retry-After` while the retry is in progress. On a Child that connected from its own dashboard, a request first waits up to 15 seconds for the tunnel to come back.
- **Failed** means the link needs attention. Check SSH authentication, the confirmed host key, forwarding, or the timeout reason shown in the dashboard. A Child that connected from its own dashboard keeps retrying by itself, after sleep, an outage or a restart: about once a minute after a timeout or forwarding error, and every five minutes after an authentication error. A changed host key is never retried.

A failed link does not silently switch to a local provider.
The Child returns a retryable `503` without forwarding the link key or request when its tunnel is failed, stopped, or not supervised.
It also keeps the key local when another process owns the tunnel port; free that port so the Child's SSH tunnel can bind it.

## Remove a Child

Select **Disconnect** for the Child and confirm the alias. The Home stops the tunnel, revokes that Child's link key, and removes the saved link record.

If the Home cannot reach the Child to run its disconnect command, choose **Remove here only**. This removes the local tunnel, key, and record. Then log in to the Child and run:

```bash
ocx disconnect
```

To disconnect a Child-initiated link, run `ocx disconnect` on the Child. It disconnects the client tunnel and revokes the link on Home over SSH. If Home revocation fails, it prints: `Home revoke failed; run ocx link revoke --link-id <linkId> on the home.`

## Troubleshooting

When a step fails, the dashboard shows the reason and, when SSH reported one, a short sanitized hint from its last non-empty error line under the message. Remote-shell errors can appear there even when the remote shell emits non-UTF-8 text; OpenCodex removes terminal controls, link keys and URL queries and limits the hint's length.

- **Could not connect to the SSH host**: the host must accept your SSH key without a password prompt; `ssh -o BatchMode=yes <alias> true` must succeed from a terminal. A `ProxyCommand` helper such as `cloudflared` must be installed in `/opt/homebrew/bin`, `/usr/local/bin`, `~/.bun/bin`, `~/.local/bin` or another directory on the PATH OpenCodex runs with.
- **ocx was not found on the remote computer**: OpenCodex looks for `ocx` on the PATH of a non-interactive SSH session first, then in `~/.bun/bin`, `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`. If it is installed elsewhere, add that directory to PATH in a file the remote shell reads for non-interactive sessions, such as `~/.zshenv` for zsh.
- **OpenCodex on the remote computer is too old**: run `ocx update` on that computer. Remote Link needs 2.66.0 or later.
- **The remote computer did not report an OpenCodex version**: `ocx --version` on that computer printed something else, for example the usage text of an unsupported Windows install.

## Security

The Child uses the Home computer's providers and provider credentials through the link. The Home creates a separate link key for each Child; removing the link revokes that key. On the Child, the key stays inside OpenCodex: credentials that Codex or Claude Code send there are not forwarded to the Home, including Bearer, Azure `api-key`, Anthropic-compatible `x-api-key`, and Google `x-goog-api-key` forms. Any program on the Child that reaches `127.0.0.1:<port>` uses the Home without a key, the same local trust a standalone install gives. Web pages from other sites are refused. Compare the host fingerprint before confirmation so a wrong machine or changed host key is not accepted by mistake. Dashboard sessions issued from a Tailscale identity cannot manage machine links.

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

### Relay authentication compatibility

Update both the Home and Child when upgrading to connection-bound relay authentication. Before sending a relayed request's link credential or body, the Child verifies the Home on the same connection it will use for that request. A closed connection is not silently replaced. A Home without this protocol causes a retryable authentication error; upgrade the Home and Child, and re-link when the stored link is no longer recognized. There is no insecure fallback switch. An unexpired pending API-key rotation remains valid until it expires or the rotation is committed or aborted.

Removing the final Home link drains pending authenticated relay requests before releasing its listener. Stopping the process still cancels active connections. This does not change which caller credentials are stripped or which routes can be relayed, and it does not replace SSH's host-key verification.
