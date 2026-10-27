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

Host discovery also follows top-level `Include` directives. Parentheses and braces in an included filename stay literal when combined with wildcards: for example, `Include conf.d/*(1).conf` finds `backup(1).conf`, and `Include conf.d/shard-{1..3}-*.conf` looks for filenames containing `{1..3}`. An `Include` inside a `Host` or `Match` block is conditional and is not used for discovery.

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

`ocx stop` on a Child stops its proxy and leaves Codex routing, the catalog and the Grok config in place, so `ocx start` (or `ocx service start`) brings the Child back unchanged. If `ocx status` on the Child reports that Codex routing is native, run `ocx sync --restart-codex`; `ocx start` does not rewrite a Child's Codex routing.

If **Child** says to pair this machine first, open this computer's configured literal-loopback HTTP dashboard, for example `http://127.0.0.1:<configured-port>`. The local pairing form appears only when pairing is missing and the dashboard and API use the same loopback origin. Copy the form's `ocx gui pair --origin "http://127.0.0.1:<configured-port>"` command, run it in a terminal on this computer, and paste the one-use code into the form. Use the exact origin shown in the form; a provider API key or admin token is not a pairing code. Missing pairing is separate from a configured-port mismatch.

On a Hub dashboard opened through a non-loopback address, the browser may have no loopback session or may have a shared session that cannot manage machine links. When Remote Link reports that session or permission problem, choose **Connect this dashboard to the hub** in the Remote Link page to open the one-time pairing form. Run the displayed command on the Hub and enter its code. The page validates the new session's Remote Link access before it closes the form.

The **Child** role also requires a standalone OpenCodex runtime running on its configured port, because the Child restarts on exactly that port. If the dashboard says OpenCodex is not running on its configured port, restart it there first.

## Link status

- **Connected** means the SSH tunnel is ready and the Child can use the Home link.
- **Reconnecting** means the tunnel is being retried. Requests can temporarily return `503` with `Retry-After` while the retry is in progress. On a Child that connected from its own dashboard, a request first waits up to 15 seconds for the tunnel to come back.
- **Failed** means the link needs attention. Check SSH authentication, the confirmed host key, forwarding, or the timeout reason shown in the dashboard. The side that runs the SSH tunnel keeps retrying by itself, after sleep, an outage or a restart: Home for a Child it added, and the Child for a link it joined from its own dashboard. After a timeout or forwarding error it retries after one minute and doubles the wait after each retry that fails again, up to five minutes; after an authentication error it retries every five minutes. A changed host key is never retried. To try again at once, select **Retry** in the Home's dashboard or run `ocx link reconnect --link-id <id>` on the Home. It restarts that link's tunnel without restarting OpenCodex.

A failed link does not silently switch to a local provider.
The Child returns a retryable `503` without forwarding the link key or request when its tunnel is failed, stopped, or not supervised.
It also keeps the key local when another process owns the tunnel port; free that port so the Child's SSH tunnel can bind it.

On a Child, `GET /healthz` only says that OpenCodex is running. `GET /readyz` (and `ocx ready`) also says whether the link can carry a request right now: while it cannot, it answers `503` with `Retry-After: 1`, `"status": "pending"` and a `link` object such as `{ "state": "unavailable", "reason": "home_unreachable" }`, and while it can, `200` with `"status": "ready"` and `{ "state": "available" }`. The reasons are `tunnel_connecting`, `tunnel_failed`, `tunnel_idle`, `tunnel_unavailable`, `sidecar_invalid`, `home_unreachable`, `home_unauthorized`, `link_auth_failed`, `link_credential_unavailable` and `link_unverified`. A Child that joined from its own dashboard answers from its tunnel. A Child that its Home added has no tunnel of its own to look at, so it asks the Home through the tunnel with the same credential-free check every relayed request starts with; it repeats that check at most once every five seconds, and answers `link_unverified` when the Home has not replied within half a second.

To confirm which Home is serving a Child, compare the `x-opencodex-served-by` header on the Child's `GET /v1/models` with the `instanceId` in the Home's `GET /healthz`. The Child passes the Home's header through unchanged, so the two match while the link works. The value is an opaque id, never a hostname; see [Home identity and the served-by header](/reference/management-api/#home-identity-and-the-served-by-header).

## What a Child shows and manages

A Child runs on the Home's providers, accounts and settings, so the Home is where you change them.

- **Dashboard.** The Child's dashboard shows the Home's state read-only and says "Managed by Home <name> over Remote Link". Dashboard and Providers read the Home through the link, and the usage strip in the header shows the Home's quota. The model list is not shown on a Child, because building it runs provider discovery on the Home; Codex on the Child already offers the Home's models. For the same reason, the delegation and sidecar model pickers on a Child list the native models and the Home's current choices, not the Home's full routed list. Saving a change there is refused with a message that names the Home; make the change in the Home's dashboard. The Child's browser never receives a Home credential.
- **Codex settings.** `ocx sync` on the Child (and connecting it) applies the Codex settings OpenCodex manages on the Home: Fast mode, the multi-agent mode, the web search sidecar switch, and the native sub-agent defaults when the Home syncs them. `ocx sync` and `ocx status` list the values that came from the Home. The default reasoning effort and the effort levels shown in the Codex app's model picker are Codex app settings on each computer; OpenCodex does not manage them on any computer.
- **CLI.** Commands that only read, such as `ocx account list`, `ocx provider quota` and `ocx usage`, read the Home. They show what the Home has already observed: a read from a Child never makes the Home probe a provider, refresh a token or start a process, so quota and account details are as fresh as the Home's own activity keeps them. Reads that only exist to run provider discovery or a forced refresh, such as `ocx models live`, `ocx models preset show` and `ocx account list --quota`, are refused like changes. Commands that change configuration are refused with one message that names the Home and the link and says no request was sent. `ocx status` describes the Home and the link. `ocx provider list` and `ocx config get` still show this computer's own configuration, labelled as local and inactive while the computer is linked. `ocx config set`, `ocx config unset` and `ocx config import` still write locally, each with the same note, and `ocx provider add`, `remove` and `set-default` are refused because those providers are not used while linked.

These reads need an OpenCodex version with the Remote Link management relay on both the Home and the Child. An older Home answers with a message asking you to upgrade it.

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
- **Requests fail with `home_unreachable` while the Home is down**: a Child never serves requests from its own providers. When the tunnel is down before a request is forwarded, the Child answers a retryable 503 and sends nothing to the Home. If the tunnel drops after forwarding started, the answer is also `home_unreachable`, but the Home may already have received the request. A failed link relay authentication answers `link_relay_auth_failed` instead: upgrade the Home and Child or re-link. Whether GOAT may move that device's work to its own sign-ins is the per-device local fallback permission on the Home's **Remote Link** page, or `ocx fallback local on --device <alias>`; see [Fallback off](/guides/fallback-off/).
- **A Home link stays Failed with a forwarding error after the Home slept or changed networks**: run `ocx link status --json` on the Home. Its `tunnel` field shows the attempts since the link was last connected, `nextRetryAt`, and the last failure. A `lastFailure.cause` of `remote_forward_conflict` means the Child's SSH server still holds the tunnel port for the session that died with the Home's old connection, so every new tunnel is refused until it lets go. OpenCodex keeps retrying and connects on its own once the port is free; it never stops processes on the Child. The Child's SSH server notices a dead session only when it probes it. Without `ClientAliveInterval` in the Child's `sshd_config`, that can take as long as the operating system's TCP keepalive (two hours by default on macOS). Setting `ClientAliveInterval 15` and `ClientAliveCountMax 3` there makes it drop such a session within about a minute.

### Retryable 503 diagnostics

A relay-generated `503` includes a server-generated `x-opencodex-link-request-id`. Use it to correlate a failure with local evidence under the Child's OpenCodex configuration home: `link/diagnostics.jsonl` and one rotated backup, `link/diagnostics.jsonl.1`. Each file is capped at 256 KiB, with private permissions (directory 0700 and files 0600 on POSIX; private ACLs on Windows). Records contain only fixed event/outcome/state categories, generated correlation IDs, numeric timing/generation/attempt metadata and timestamps, never secrets, request bodies, headers, URLs, account identifiers or raw errors. Each event/outcome pair is limited to one record per second; the next record includes a count of suppressed events, so an absent record does not prove an absent failure. A backward wall-clock adjustment starts a new rate-limit window, including when the writer queue is full, and preserves the suppression count. An asynchronous writer keeps at most 56 pending records, counts overflow as suppression, and yields while Windows ACL work runs. Logging is best effort and cannot change whether a request is admitted. Graceful signal shutdown and standalone recycling wait up to one second for queued diagnostics before exiting; stalled storage, forced termination and power loss can still lose records.

`owner_lookup` records refused ownership checks; routine successful checks are silent. `owner_lookup.elapsedMs` measures the owner lookup itself. For `auth_timeout`, `relay_retry` and `relay_failure` report the actual transport-attempt duration in `elapsedMs` (normally about five seconds). A `relay_recovered` event with outcome `recovered` is emitted only after a retry receives an upstream response with `upstream.ok` (HTTP 2xx); it does not prove the streamed body completed. Rate limiting makes request-ID correlation sampled evidence, not a guaranteed trace of every failed request.

The Home writes the same kind of file under its own configuration home for the tunnels it runs. Each change of a Home-initiated tunnel's state is a `tunnel_transition` record with `previousState`, `state`, the cause as `outcome` (`auth`, `hostkey`, `forward`, `remote_forward_conflict`, `timeout`, `network`, `unknown`, `spawn_failed` or `listener_unavailable`; `connected`, `spawned` or `stopped` when nothing failed), the `attempt` count since the link was last connected, the link's `tunnelPort` and, when a retry is scheduled, `retryAfterMs`. A retry of a failed link that fails again is recorded too, so an outage leaves one record per attempt. The same rate limit applies, across all links.

Before sending data, OpenCodex allows one shared preflight retry for either an owner-lookup deadline or a specifically identified five-second authentication deadline. The retry obtains fresh owner proof where required and a fresh physical socket, then authenticates that socket before sending the link credential or body. It does not reuse cached owner approval, bypass security checks, restart SSH or OpenCodex, or replay a dispatched request body. The two-second owner-lookup and five-second authentication deadlines are unchanged for each attempt; other failures do not qualify for this preflight retry.

This can recover these transient deadline paths and helps diagnose future failures. It does not establish the historical cause of [#7297](https://github.com/lidge-jun/opencodex/issues/7297).

## Security

The Child uses the Home computer's providers and provider credentials through the link. The Home creates a separate link key for each Child; removing the link revokes that key. On the Child, the key stays inside OpenCodex: credentials that Codex or Claude Code send there are not forwarded to the Home, including Bearer, Azure `api-key`, Anthropic-compatible `x-api-key`, and Google `x-goog-api-key` forms. Any program on the Child that reaches `127.0.0.1:<port>` uses the Home without a key, the same local trust a standalone install gives. Web pages from other sites are refused. Compare the host fingerprint before confirmation so a wrong machine or changed host key is not accepted by mistake. Dashboard sessions issued from a Tailscale identity cannot manage machine links.

## CLI reference

```text
ocx link probe <alias> [--json]
ocx link add <alias> [--expect-fingerprint SHA256:…] [--json]
ocx link port [--json]
ocx link issue --alias <alias> --tunnel-port <port> [--json]
ocx link status [--json]
ocx link revoke --link-id <id> [--json]
ocx link reconnect --link-id <id> [--json]
```

## Related guides

- [Remote Hub Deployment](/guides/remote-hub/)
- [Remote Workspace](/guides/remote-workspace/)

### Relay authentication compatibility

Update both the Home and Child when upgrading to connection-bound relay authentication. Before sending a relayed request's link credential or body, the Child verifies the Home on the same connection it will use for that request. A closed connection is not silently replaced. A Home without this protocol causes a retryable authentication error; upgrade the Home and Child, and re-link when the stored link is no longer recognized. There is no insecure fallback switch. An unexpired pending API-key rotation remains valid until it expires or the rotation is committed or aborted.

Removing the final Home link drains pending authenticated relay requests before releasing its listener. Stopping the process still cancels active connections. This does not change which caller credentials are stripped or which routes can be relayed, and it does not replace SSH's host-key verification.

### Home and Child versions

On the Home, `ocx link status --json` reports the Home's own `local` version, relay authentication version and features, and gives every link a `peer` block. Nothing is read over SSH: the Home learns about a Child from the relay authentication check the Child sends before each relayed request. From 2.91.0 that check also carries the Child's version and feature list. The Home keeps what it learned in memory, so after a Home restart a link reads `unknown` until its Child relays a request again.

| Part of the link | First release |
|---|---|
| `relay-auth/2`, connection-bound relay authentication | 2.69.0 |
| `link-management-relay`, read-only Home management on the Child | 2.84.0 |
| `link-peer-report/1`, the Child reports its version and features | 2.91.0 |

`peer.compatibility` is one of:

- `compatible`: the relay authentication versions match, and the Home serves every feature the Child reports. A Child older than 2.91.0 reports no version; `peer.version` is then `null` and `peer.versionRange` gives the range its relay authentication implies, for example `{ "min": "2.69.0", "below": "2.91.0" }`.
- `degraded`: the Child reports a feature this Home does not serve. Upgrade the Home.
- `incompatible`: the Child asked for a relay authentication version this Home does not speak, so its relayed requests are refused. `peer.reasons` names the side to upgrade.
- `unknown`: the Child has not relayed a request since the Home started, or it sent a version or feature list the Home could not read, so its features cannot be checked.

The version a Child reports is its own claim, bound to its link key. OpenCodex uses it for display and never for admission. Older `ocx` installations keep receiving the previous status document; only a 2.91.0 or newer CLI asks for these fields.


### Standalone pairing authorization

The existing `ocx gui pair --origin <local-origin>` command works while OpenCodex runs as a background service. Run it under the account that owns the service's private OpenCodex home, then enter the returned one-use code in the local dashboard. No server terminal, additional password, Windows Hello or hardware key is required. The CLI and server must use the same current version and configuration home; restart an older server after updating. Mixed-version Hub invitations also require updating the CLI and server together. Pairing refuses a symlinked configuration home or intent directory; use the actual protected directory as `OPENCODEX_HOME`.

Internally, the CLI creates a short-lived authorization commitment and attempts to remove it after use or failure. Reading runtime information alone does not authorize pairing, and the verifier is not stored on disk. This is a private-home write-access boundary, not biometric or human-presence authentication: a program with full access to that user's files is still trusted. Existing Hub invitation authorization is unchanged. If a pairing request fails, run a fresh command after resolving the reported problem. This does not add Windows SSH Remote Link support.

If a process is interrupted during pairing, rerun the command to obtain a new authorization. Do not manually remove pairing state while the service or a pairing command is running.

On Windows, pairing fails closed if the intent folder or record is not private to the serving account, or its owner and permissions cannot be verified. Both entries must be owned by that account; Administrators ownership is accepted only when Administrators is the serving token's default owner and its administrator role is enabled. The permission list must be protected from inheritance and contain an ordinary Full Control allow entry for the serving account. Besides that, only plain allow entries for SYSTEM and the Administrators group are accepted, because SYSTEM and an elevated administrator can already take ownership of any file; a non-elevated administrator gains nothing from that entry. Child inheritance is allowed on the folder only. This is the list as Windows reports it: compatible duplicate entries for the same account count as one, and entries that grant nothing are ignored. The check leaves refused records in place and does not repair their permissions or change ownership. Restore a private configuration home, then run a fresh pairing command.

The check covers the intent folder and record. It does not protect against replacement of ancestor folders, deletion rights on a parent folder, privileged restore operations or access through handles opened before permissions became private. A request with a matching commitment can block the server during a verification subprocess bounded at five seconds, even if its folder later fails the permission check. Executable lookup and process launch setup precede that timeout. CLI cleanup may perform one more verification. The five-second subprocess budget leaves room within the command's ten-second request timeout, but slow verification can still refuse pairing.

## Add a Child from the terminal

On the Home, run `ocx link probe child-a --json` to inspect the offered SSH fingerprint, key type and OpenCodex version. Verify the fingerprint through a trusted source. Then run `ocx link add child-a --expect-fingerprint SHA256:… --json`. The command probes again and refuses a mismatch before storing trust or issuing a key. Without the fingerprint flag, it requires an interactive terminal and an explicit `yes` after showing the fingerprint. It never prints the link key.

Home-initiated connections now restart the Child after saving its connection, including capable older Child installations. The Child must already serve standalone OpenCodex on its configured port, expose bound restart support, and have curl installed. Update or disconnect a Child that fails this preflight. Desktop and system OpenCodex installations take precedence over generic PATH shims; broken candidates are skipped. Windows Children remain unsupported.

### Windows computers

`ocx link add` and the dashboard refuse a Windows computer during the probe or host confirmation, before any link key is issued or tunnel started. The refusal covers Windows OpenSSH with Git Bash, MSYS2 or Cygwin as its shell (`uname -s` reports MINGW, MSYS or CYGWIN) and with cmd or PowerShell as its shell. Connect a Windows computer in Hub mode instead: run `ocx hub invite` on a Hub and run the printed `ocx connect` command on the Windows computer.

A Windows Child linked by an older release keeps its link. Run `ocx link cleanup` on the Home to find such links; add `--link-id <id>` to check one, or `--json` for a machine-readable report. It asks each Home-initiated Child for its platform over the link's pinned SSH trust and changes nothing. For each Windows Child it prints the recovery order: run `ocx disconnect` and `ocx restart` on the Windows computer, then `ocx link revoke --link-id <id> --force --yes` on the Home, then connect it in Hub mode. A plain revoke fails on these Children because its remote disconnect runs a POSIX command that Windows refuses.

Restart waits for running turns and may take several minutes. Success requires the restarted Child to serve the client role and relay a fresh complete catalog to this Home. SSH setup has a bounded allowance derived from measured latency; relay verification starts after restart with its own 15-second window. Errors name the failing phase. If an error reports residual Child configuration, run `ocx disconnect` and `ocx restart` on that Child before retrying. Home cleanup alone does not restore Child configuration. A CLI timeout reports an uncertain outcome; inspect Home `ocx link status` and Child `ocx connect status` first.

On a Home-initiated Child, `ocx link status` reports role `child`, link identity and tunnel port from its saved connection even though its Home-side link store is empty. Locally unobserved tunnel state is `idle`. `ocx status` calls the peer a Remote Link Home. When Home runs in Hub mode, status reads its supported projection through the local Child relay. A standalone Home reports that it does not publish Hub state. Child-initiated tunnel identity comes from its valid sidecar; unreadable evidence does not claim a direction.
