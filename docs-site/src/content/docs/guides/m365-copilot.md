---
title: Microsoft 365 Copilot
description: Sign in to Microsoft 365 Copilot and use its maintained model aliases through OpenCodex.
---

Microsoft 365 Copilot is an experimental native provider, separate from GitHub Copilot. It connects directly to Microsoft's private ChatHub WebSocket service. It requires a work or school account with access to Microsoft 365 Copilot Chat; personal Microsoft accounts are not supported. Availability and quotas remain controlled by Microsoft.

## Sign in

In Providers, add **Microsoft 365 Copilot** and select its sign-in action. Alternatively, run:

```sh
ocx login m365-copilot
```

OpenCodex detects the default supported browser (Firefox, Chrome or Edge) and opens one isolated sign-in window. Complete Microsoft's sign-in and MFA there. Keep the login in that window: moving its URL to another browser prevents local callback capture. OpenCodex captures the code locally, closes the temporary window and stores the credential through its normal protected OAuth account store. No callback URL or password needs to be pasted into OpenCodex or a chat.

This window does not reuse your regular browser profile. Microsoft's existing M365 Chat Client registration rejects OpenCodex's ordinary localhost redirect with `AADSTS50011`; the captured native-client callback is used instead. The account retains cached access and refresh tokens, so later requests normally refresh silently. A local desktop and a supported installed browser are required for interactive sign-in. Headless code-display login is not supported.

## Models and requests

The provider publishes 34 maintained aliases after setup. They are preset selectors, not account-specific model discovery or proof of 34 distinct available models. Some aliases share Microsoft's selectors and may resolve differently across licenses or rollouts. The Live models switch is disabled for this static catalog. The default model is `claude-sonnet`.

Use the provider namespace when selecting a model:

```text
m365-copilot/claude-sonnet
m365-copilot/gpt-5.5
m365-copilot/gpt-6.1-sol
```

Text streams and client-executed tools travel through OpenCodex's existing request interfaces. Tool calls are prompt-emulated: the model emits a fenced call, OpenCodex translates it into the client's tool format, and the client executes it under its own permissions. Conversations are scoped to the Microsoft account, model, client session and tool set. Temporary chats keep their live conversation context without adding a persistent Copilot history entry.

The provider creates no Copilot Studio agents, installs no browser extension, and needs no standalone Copilot proxy or admin console. This initial transport is text-and-tools only; image generation and native image input are not advertised. It is not an official Microsoft integration, and Microsoft's private protocol can change.

## Identity and sources

The OAuth client ID is `c0ab8ce9-e9a0-42e7-b064-33d422df41f1`, Microsoft's **M365 Chat Client**, identified in [Microsoft's Entra documentation dictionary](https://github.com/MicrosoftDocs/entra-docs/blob/main/.docutune/dictionaries/known-guids.json). It is a public application identifier, not a secret or an app registered by the proxy author. Your local OpenCodex process receives the authorized tokens; using a Microsoft application ID does not itself establish the safety of third-party software.

Protocol and tool-framing code is adapted from [cramt/m365-copilot-proxy](https://github.com/cramt/m365-copilot-proxy/tree/65905e881d6597040966aff9b087aa9a908b358a), with its MIT notice retained. The service is operated by Microsoft; your organization's Microsoft agreement and [Microsoft 365 product terms](https://www.microsoft.com/licensing/terms/productoffering/Microsoft365/all) govern access. Verification on October 26, 2026 covered real Firefox sign-in, Chrome/Firefox callback capture, streamed text and a client tool-result round-trip with `claude-sonnet`. Other aliases have not been individually live-verified.
