---
title: Remote Link
description: Connect an OpenCodex Home computer to a Child computer over SSH.
---

A machine link connects an OpenCodex **Home** computer to a **Child** computer over SSH. The Home serves the Child through the SSH tunnel, while both computers keep their local OpenCodex service on port `10100`. The dashboard transfers the per-child link key through SSH, so you do not type a token.

## Requirements

- The Home computer can log in to the Child with an OpenSSH key.
- For a Child-initiated link, the Child can log in to Home with an OpenSSH key (password login is not supported).
- OpenCodex is installed on the Child computer.
- Both computers run macOS or Linux.
- The Home dashboard has a full paired session.

Password SSH and Windows are outside the current flow. For a Child-initiated link, open the standalone Child dashboard, choose **Child** → **Find Home**, select the SSH host for Home, check and confirm the host-key fingerprint, then choose **Connect as Child**. The Child must be able to log in to Home with an SSH key (password login is not supported), and `ocx` must be running on Home. The client tunnel port is `1024` or higher. After joining, the Child restarts and connects through Home. This option is available only on a standalone runtime.

## Add a Child from `#remote`

1. Open the dashboard at `#remote` and switch Remote Link on.
2. Choose **Home**.
3. Select **Add child**.
4. Choose a host from the SSH candidates, or enter an SSH config alias.
5. Run the connection test and compare the offered host fingerprint with the fingerprint for the machine you intend to use. Comparing it helps detect a wrong host or a changed host key before SSH trusts the host.
6. Confirm the fingerprint, then connect the Child.

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
